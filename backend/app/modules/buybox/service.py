"""Buy Box engine (spec module 8).

Fit is a gate, not a score: each property/buy-box pair resolves to Pass, Pass With Exception, Fail or
Insufficient Data. Every evaluation stores the criteria version, a timestamp and per-criterion details;
earlier evaluations are kept with `is_current = False`.
"""
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.query import apply_search, in_filter
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.buybox.models import BuyBox, BuyboxCriterion, BuyboxEvaluation, BuyboxVersion
from app.modules.buybox.schemas import (
    BuyBoxCreate,
    BuyBoxListItem,
    BuyBoxOut,
    BuyBoxUpdate,
    CriterionIn,
    CriterionOut,
    EvaluationOut,
)

ENTITY = "buy_box"
BATCH = 500
EMPTY = (None, "", [])

# ----------------------------------------------------------------------------- field catalogue

_NUM_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "is_set"]
OPS_BY_TYPE: dict[str, list[str]] = {
    "number": _NUM_OPS,
    "integer": _NUM_OPS,
    "date": ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_set"],
    "string": ["eq", "neq", "in", "not_in", "contains", "is_set"],
    "enum": ["eq", "neq", "in", "not_in", "is_set"],
    "tags": ["contains", "not_in", "is_set"],
}

OP_TEXT = {
    "eq": "=", "neq": "≠", "in": "one of", "not_in": "not one of", "gt": ">", "gte": "≥", "lt": "<",
    "lte": "≤", "between": "between", "contains": "contains", "is_set": "is set",
}


def _fields() -> dict[str, dict[str, Any]]:
    from app.modules.properties.models import PROPERTY_STATUSES, PROPERTY_TYPES

    s = lambda label: {"label": label, "type": "string"}  # noqa: E731
    n = lambda label, unit=None: {"label": label, "type": "number", "unit": unit}  # noqa: E731
    i = lambda label: {"label": label, "type": "integer"}  # noqa: E731
    return {
        "property_type": {"label": "Property type", "type": "enum", "options": PROPERTY_TYPES},
        "property_subtype": s("Subtype"),
        "status": {"label": "Property status", "type": "enum", "options": PROPERTY_STATUSES},
        "state": s("State"),
        "county": s("County"),
        "city": s("City"),
        "postal_code": s("Postal code"),
        "corridor": s("Corridor"),
        "building_area_sf": n("Building area", "SF"),
        "land_area_acres": n("Land area", "ac"),
        "year_built": i("Year built"),
        "year_renovated": i("Year renovated"),
        "parking_spaces": i("Parking spaces"),
        "construction_class": s("Construction class"),
        "asking_price": n("Asking price", "$"),
        "last_sale_price": n("Last sale price", "$"),
        "last_sale_date": {"label": "Last sale date", "type": "date"},
        "occupancy_pct": n("Occupancy", "%"),
        "wale_years": n("WALE", "yrs"),
        "noi": n("NOI", "$"),
        "cap_rate": {**n("Cap rate (NOI / asking)", "%"), "derived": ["noi", "asking_price"]},
        "price_per_sf": {**n("Asking price per SF", "$"), "derived": ["asking_price", "building_area_sf"]},
        "zoning": s("Zoning"),
        "future_land_use": s("Future land use"),
        "flood_zone": s("Flood zone"),
        "traffic_count": i("Traffic count (VPD)"),
        "tags": {"label": "Tags", "type": "tags"},
        "completeness_score": n("Data completeness", "%"),
    }


def field_meta() -> list[dict[str, Any]]:
    return [{"key": k, **v, "operators": OPS_BY_TYPE[v["type"]]} for k, v in _fields().items()]


def depends_on(field: str) -> list[str]:
    return list(_fields().get(field, {}).get("derived") or [field])


def field_value(p: Any, field: str) -> Any:
    if field == "cap_rate":
        noi, price = p.noi, p.asking_price
        return round(noi / price * 100, 4) if noi is not None and price else None
    if field == "price_per_sf":
        price, sf = p.asking_price, p.building_area_sf
        return round(price / sf, 2) if price is not None and sf else None
    return getattr(p, field, None)


def _coerce(v: Any, ftype: str) -> Any:
    if v is None:
        return None
    if ftype in ("number", "integer"):
        return float(v)
    if ftype == "date":
        return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])
    return str(v).strip().lower()


def _check(op: str, actual: Any, value: Any, ftype: str) -> bool:
    if op == "is_set":
        return (actual not in EMPTY) == bool(value)
    if ftype == "tags":
        have = {str(t).strip().lower() for t in (actual or [])}
        wanted = {str(x).strip().lower() for x in (value if isinstance(value, list) else [value])}
        return bool(have & wanted) if op == "contains" else not (have & wanted)
    a = _coerce(actual, ftype)
    if op in ("in", "not_in"):
        inside = a in {_coerce(x, ftype) for x in value}
        return inside if op == "in" else not inside
    if op == "between":
        lo, hi = sorted([_coerce(value[0], ftype), _coerce(value[1], ftype)])
        return lo <= a <= hi
    if op == "contains":
        return str(_coerce(value, "string")) in str(a)
    b = _coerce(value, ftype)
    return {
        "eq": a == b, "neq": a != b, "gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b,
    }[op]


def validate_criterion(c: CriterionIn) -> None:
    meta = _fields().get(c.field)
    if not meta:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown field '{c.field}'")
    if c.operator not in OPS_BY_TYPE[meta["type"]]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Operator '{c.operator}' is not available for {meta['label']}",
        )
    if c.operator == "is_set" or meta["type"] == "tags":
        return
    try:
        for v in c.value if isinstance(c.value, list) else [c.value]:
            _coerce(v, meta["type"])
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Invalid value for {meta['label']}")


def _show(v: Any) -> str:
    if v in EMPTY:
        return "empty"
    if isinstance(v, list):
        return ", ".join(_show(x) for x in v)
    if isinstance(v, float):
        return f"{v:,.2f}".rstrip("0").rstrip(".")
    return str(v)


# ----------------------------------------------------------------------------- engine


@dataclass
class EngineResult:
    result: str
    missing_fields: list[str]
    details: list[dict]
    preferred_misses: list[dict]


def run_engine(p: Any, criteria: list[BuyboxCriterion]) -> EngineResult:
    fields = _fields()
    details: list[dict] = []
    for c in sorted(criteria, key=lambda c: c.position):
        meta = fields.get(c.field, {"label": c.field, "type": "string"})
        label = meta["label"]
        actual = field_value(p, c.field)
        missing_deps: list[str] = []
        if c.operator != "is_set" and actual in EMPTY:
            outcome = "missing"
            missing_deps = [d for d in depends_on(c.field) if getattr(p, d, None) in EMPTY] or [c.field]
            explanation = f"{label} is missing" + (
                f" (needs {', '.join(missing_deps)})" if meta.get("derived") else ""
            )
        else:
            try:
                hit = _check(c.operator, actual, c.value, meta["type"])
            except (TypeError, ValueError, KeyError):
                hit = None
            expected = f"{OP_TEXT.get(c.operator, c.operator)} {_show(c.value)}" if c.operator != "is_set" else (
                "is set" if c.value else "is empty")
            if hit is None:
                outcome, explanation = "fail", f"{label}: criterion value could not be compared"
            elif c.requirement == "disqualifying":
                outcome = "fail" if hit else "pass"
                explanation = (f"Disqualified: {label} {expected} (actual {_show(actual)})" if hit
                               else f"{label} {_show(actual)} — not {expected}")
            else:
                outcome = "pass" if hit else "fail"
                explanation = f"{label} {_show(actual)} — expected {expected}"
        details.append({
            "criterion_id": str(c.id),
            "field": c.field,
            "label": label,
            "operator": c.operator,
            "value": to_jsonable(c.value),
            "requirement": c.requirement,
            "actual": to_jsonable(actual),
            "outcome": outcome,
            "missing_fields": missing_deps,
            "explanation": explanation,
        })

    gating = [d for d in details if d["requirement"] != "preferred"]
    missing = sorted({f for d in gating if d["outcome"] == "missing" for f in d["missing_fields"]})
    if any(d["outcome"] == "fail" for d in gating):
        result = "fail"
    elif missing:
        result = "insufficient_data"
    else:
        result = "pass"
    preferred = [d for d in details if d["requirement"] == "preferred" and d["outcome"] != "pass"]
    return EngineResult(result, missing, details, preferred)


def _signature(version: int, r: EngineResult) -> str:
    raw = json.dumps({"v": version, "r": r.result, "d": r.details}, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _property_label(p: Any) -> str:
    return p.name or p.address_line


def _gating_fails(details: list[dict]) -> set[str]:
    return {d["criterion_id"] for d in details if d["requirement"] != "preferred" and d["outcome"] == "fail"}


async def _evaluate(
    db: AsyncSession,
    p: Any,
    box: BuyBox,
    criteria: list[BuyboxCriterion],
    prev: BuyboxEvaluation | None,
    *,
    trigger: str,
    actor_id: uuid.UUID | None,
    skip_unchanged: bool,
) -> tuple[BuyboxEvaluation, bool]:
    r = run_engine(p, criteria)
    sig = _signature(box.version, r)
    if prev and skip_unchanged and prev.signature == sig:
        return prev, False

    ev = BuyboxEvaluation(
        property_id=p.id, buy_box_id=box.id, buy_box_version=box.version, result=r.result, raw_result=r.result,
        missing_fields=r.missing_fields, details=r.details, preferred_misses=r.preferred_misses, signature=sig,
        evaluated_at=utcnow(), is_current=True, trigger=trigger, exception_status="none",
        created_by_id=actor_id, updated_by_id=actor_id,
    )
    # An approved/pending exception survives re-evaluation only for the same version and no new failures.
    if (r.result == "fail" and prev and prev.exception_status in ("requested", "approved")
            and prev.buy_box_version == box.version and _gating_fails(r.details) <= _gating_fails(prev.details)):
        for f in ("exception_status", "exception_requested_by_id", "exception_requested_at",
                  "exception_request_reason", "exception_approver_id", "exception_decided_at",
                  "exception_decision_reason"):
            setattr(ev, f, getattr(prev, f))
        if prev.exception_status == "approved":
            ev.result = "pass_with_exception"
    if prev:
        prev.is_current = False
    db.add(ev)

    if r.result == "insufficient_data":
        from app.modules.tasks.service import create_task

        label = _property_label(p)
        await create_task(
            db,
            title=f"Research missing data for {label}: {', '.join(r.missing_fields)}",
            description=(f"Buy box “{box.name}” (v{box.version}) cannot evaluate this property. "
                         f"Fields preventing evaluation: {', '.join(r.missing_fields)}."),
            assignee_id=box.owner_id,
            task_type="research",
            related_type="property",
            related_id=p.id,
            related_label=label,
            source="buybox",
            idempotency_key=f"buybox-research:{p.id}:{box.id}:{box.version}",
            actor_id=actor_id,
        )
    return ev, True


async def load_criteria(db: AsyncSession, box_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[BuyboxCriterion]]:
    out: dict[uuid.UUID, list[BuyboxCriterion]] = {b: [] for b in box_ids}
    if not box_ids:
        return out
    rows = await db.scalars(
        select(BuyboxCriterion)
        .where(BuyboxCriterion.buy_box_id.in_(box_ids), BuyboxCriterion.deleted_at.is_(None))
        .order_by(BuyboxCriterion.position)
    )
    for c in rows:
        out[c.buy_box_id].append(c)
    return out


async def active_boxes(db: AsyncSession) -> list[BuyBox]:
    today = date.today()
    return list(await db.scalars(select(BuyBox).where(
        BuyBox.deleted_at.is_(None), BuyBox.is_active.is_(True),
        or_(BuyBox.active_from.is_(None), BuyBox.active_from <= today),
        or_(BuyBox.active_to.is_(None), BuyBox.active_to >= today),
    )))


def referenced_fields(criteria: list[BuyboxCriterion]) -> set[str]:
    return {f for c in criteria for f in [c.field, *depends_on(c.field)]}


async def evaluate_property(
    db: AsyncSession,
    property_id: uuid.UUID,
    *,
    trigger: str,
    actor_id: uuid.UUID | None = None,
    changed: set[str] | None = None,
    skip_unchanged: bool = True,
) -> list[BuyboxEvaluation]:
    """Evaluate one property against every applicable buy box. Does not commit (safe inside handlers)."""
    from app.modules.properties.models import Property

    p = await db.get(Property, property_id)
    if not p or p.deleted_at:
        return []
    boxes = await active_boxes(db)
    crit = await load_criteria(db, [b.id for b in boxes])
    prevs = {e.buy_box_id: e for e in await db.scalars(select(BuyboxEvaluation).where(
        BuyboxEvaluation.property_id == p.id, BuyboxEvaluation.is_current.is_(True)))}
    out = []
    for box in boxes:
        if changed is not None and box.id in prevs:
            refs = referenced_fields(crit[box.id])
            # completeness_score is recomputed on every property change, so any change can affect it.
            if not (refs & changed or ("completeness_score" in refs and changed)):
                continue
        ev, _ = await _evaluate(db, p, box, crit[box.id], prevs.get(box.id), trigger=trigger,
                                actor_id=actor_id, skip_unchanged=skip_unchanged)
        out.append(ev)
    await db.flush()  # session uses autoflush=False; callers may query these rows in the same transaction
    return out


async def evaluate_all(db: AsyncSession, box: BuyBox, actor: CurrentUser) -> dict:
    """Re-run one buy box across every live property in keyset-paginated batches."""
    from app.modules.properties.models import Property

    crit = (await load_criteria(db, [box.id]))[box.id]
    counts: dict[str, int] = {}
    evaluated = changed = 0
    last_id: uuid.UUID | None = None
    while True:
        stmt = select(Property).where(Property.deleted_at.is_(None)).order_by(Property.id).limit(BATCH)
        if last_id is not None:
            stmt = stmt.where(Property.id > last_id)
        props = list(await db.scalars(stmt))
        if not props:
            break
        prevs = {e.property_id: e for e in await db.scalars(select(BuyboxEvaluation).where(
            BuyboxEvaluation.buy_box_id == box.id, BuyboxEvaluation.is_current.is_(True),
            BuyboxEvaluation.property_id.in_([p.id for p in props])))}
        for p in props:
            ev, did = await _evaluate(db, p, box, crit, prevs.get(p.id), trigger="evaluate_all",
                                      actor_id=actor.id, skip_unchanged=True)
            evaluated += 1
            changed += int(did)
            counts[ev.result] = counts.get(ev.result, 0) + 1
        await db.commit()
        last_id = props[-1].id

    await audit.record(db, actor=actor, action="buy_box.evaluated_all", entity_type=ENTITY, entity_id=box.id,
                       summary=f"{evaluated} properties evaluated against v{box.version}",
                       changes={"by_result": counts}, ip_address=actor.ip_address)
    await db.commit()
    return {"evaluated": evaluated, "changed": changed, "unchanged": evaluated - changed, "by_result": counts}


# ----------------------------------------------------------------------------- buy box CRUD


@dataclass
class BuyBoxFilters:
    q: str | None = None
    strategy: list[str] | None = None
    is_active: bool | None = None
    owner_id: uuid.UUID | None = None
    result: list[str] | None = None


def build_query(f: BuyBoxFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(BuyBox).where(BuyBox.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [BuyBox.name, BuyBox.strategy, BuyBox.description])
    if "strategy" not in skip:
        stmt = in_filter(stmt, BuyBox.strategy, f.strategy)
    if "is_active" not in skip and f.is_active is not None:
        stmt = stmt.where(BuyBox.is_active.is_(f.is_active))
    if f.owner_id:
        stmt = stmt.where(BuyBox.owner_id == f.owner_id)
    if f.result and "result" not in skip:
        stmt = stmt.where(BuyBox.id.in_(select(BuyboxEvaluation.buy_box_id).where(
            BuyboxEvaluation.is_current.is_(True), BuyboxEvaluation.result.in_(f.result))))
    return stmt


async def user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())


async def result_counts(db: AsyncSession, box_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, int]]:
    out: dict[uuid.UUID, dict[str, int]] = {b: {} for b in box_ids}
    if not box_ids:
        return out
    rows = await db.execute(
        select(BuyboxEvaluation.buy_box_id, BuyboxEvaluation.result, func.count())
        .where(BuyboxEvaluation.buy_box_id.in_(box_ids), BuyboxEvaluation.is_current.is_(True))
        .group_by(BuyboxEvaluation.buy_box_id, BuyboxEvaluation.result)
    )
    for b, r, c in rows.all():
        out[b][r] = int(c)
    return out


async def to_items(db: AsyncSession, boxes: list[BuyBox]) -> list[BuyBoxListItem]:
    ids = [b.id for b in boxes]
    names = await user_names(db, {b.owner_id for b in boxes})
    counts = await result_counts(db, ids)
    crit_counts = dict((await db.execute(
        select(BuyboxCriterion.buy_box_id, func.count())
        .where(BuyboxCriterion.buy_box_id.in_(ids), BuyboxCriterion.deleted_at.is_(None))
        .group_by(BuyboxCriterion.buy_box_id)
    )).all()) if ids else {}
    items = []
    for b in boxes:
        item = BuyBoxListItem.model_validate(b)
        item.owner_name = names.get(b.owner_id) if b.owner_id else None
        item.result_counts = counts.get(b.id, {})
        item.criteria_count = int(crit_counts.get(b.id, 0))
        items.append(item)
    return items


async def to_out(db: AsyncSession, box: BuyBox) -> BuyBoxOut:
    item = (await to_items(db, [box]))[0]
    crit = (await load_criteria(db, [box.id]))[box.id]
    return BuyBoxOut(
        **item.model_dump(), description=box.description, created_at=box.created_at,
        criteria=[CriterionOut.model_validate(c) for c in crit],
    )


async def get(db: AsyncSession, box_id: uuid.UUID) -> BuyBox:
    box = await db.get(BuyBox, box_id)
    if not box or box.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Buy box not found")
    return box


def _snapshot(rows: list[BuyboxCriterion]) -> list[dict]:
    return [
        {"id": str(c.id), "field": c.field, "operator": c.operator, "value": to_jsonable(c.value),
         "requirement": c.requirement, "note": c.note, "position": c.position}
        for c in rows
    ]


def _rows(box: BuyBox, items: list[CriterionIn], actor: CurrentUser) -> list[BuyboxCriterion]:
    rows = []
    for pos, c in enumerate(items):
        validate_criterion(c)
        rows.append(BuyboxCriterion(
            id=uuid.uuid4(), buy_box_id=box.id, field=c.field, operator=c.operator, value=c.value,
            requirement=c.requirement, note=c.note, position=pos, created_by_id=actor.id, updated_by_id=actor.id,
        ))
    return rows


async def create(db: AsyncSession, data: BuyBoxCreate, actor: CurrentUser) -> BuyBox:
    box = BuyBox(**data.model_dump(exclude={"criteria"}), version=1, created_by_id=actor.id, updated_by_id=actor.id)
    if box.owner_id is None:
        box.owner_id = actor.id
    db.add(box)
    await db.flush()
    rows = _rows(box, data.criteria, actor)
    db.add_all(rows)
    db.add(BuyboxVersion(buy_box_id=box.id, version=1, criteria=_snapshot(rows), change_note="Created",
                         created_by_id=actor.id))
    await audit.record(db, actor=actor, action="buy_box.created", entity_type=ENTITY, entity_id=box.id,
                       summary=box.name, changes={"criteria": _snapshot(rows)}, ip_address=actor.ip_address)
    await db.commit()
    return box


async def update(db: AsyncSession, box: BuyBox, data: BuyBoxUpdate, actor: CurrentUser) -> BuyBox:
    values = data.model_dump(exclude_unset=True)
    if "name" in values and not values["name"]:
        values.pop("name")
    changes = audit.diff(box, values)
    if not changes:
        return box
    for k, v in values.items():
        setattr(box, k, v)
    if box.active_from and box.active_to and box.active_to < box.active_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "active_to must be on or after active_from")
    box.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="buy_box.updated", entity_type=ENTITY, entity_id=box.id,
                       summary=box.name, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return box


async def replace_criteria(
    db: AsyncSession, box: BuyBox, items: list[CriterionIn], actor: CurrentUser, note: str | None = None
) -> BuyBox:
    """Every criteria change creates a new version; the previous criteria remain in buybox_versions."""
    current = (await load_criteria(db, [box.id]))[box.id]
    rows = _rows(box, items, actor)
    before, after = _snapshot(current), _snapshot(rows)
    strip = lambda snap: [{k: v for k, v in c.items() if k != "id"} for c in snap]  # noqa: E731
    if strip(before) == strip(after):
        return box
    now = utcnow()
    for c in current:
        c.deleted_at = now
        c.updated_by_id = actor.id
    db.add_all(rows)
    old_version = box.version
    box.version = old_version + 1
    box.updated_by_id = actor.id
    db.add(BuyboxVersion(buy_box_id=box.id, version=box.version, criteria=after, change_note=note,
                         created_by_id=actor.id))
    await audit.record(db, actor=actor, action="buy_box.criteria_changed", entity_type=ENTITY, entity_id=box.id,
                       summary=f"v{old_version} → v{box.version}" + (f": {note}" if note else ""),
                       changes={"version": {"from": old_version, "to": box.version},
                                "criteria": {"from": strip(before), "to": strip(after)}},
                       ip_address=actor.ip_address)
    await db.commit()
    return box


async def current_inputs(db: AsyncSession, box: BuyBox) -> tuple[list[CriterionIn], list[BuyboxCriterion]]:
    crit = (await load_criteria(db, [box.id]))[box.id]
    return [CriterionIn(field=c.field, operator=c.operator, value=c.value, requirement=c.requirement, note=c.note)
            for c in crit], crit


async def archive(db: AsyncSession, box: BuyBox, actor: CurrentUser) -> None:
    box.deleted_at = utcnow()
    box.is_active = False
    box.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="buy_box.archived", entity_type=ENTITY, entity_id=box.id,
                       summary=box.name, ip_address=actor.ip_address)
    await db.commit()


# ----------------------------------------------------------------------------- evaluations


async def eval_outs(db: AsyncSession, evals: list[BuyboxEvaluation]) -> list[EvaluationOut]:
    from app.modules.properties.models import Property

    if not evals:
        return []
    props = {r.id: r for r in (await db.execute(
        select(Property.id, Property.name, Property.address_line, Property.city, Property.state)
        .where(Property.id.in_({e.property_id for e in evals}))
    )).all()}
    boxes = dict((await db.execute(
        select(BuyBox.id, BuyBox.name).where(BuyBox.id.in_({e.buy_box_id for e in evals}))
    )).all())
    names = await user_names(db, {e.exception_requested_by_id for e in evals} | {e.exception_approver_id for e in evals})
    out = []
    for e in evals:
        o = EvaluationOut.model_validate(e)
        p = props.get(e.property_id)
        if p:
            o.property_label, o.property_city, o.property_state = p.name or p.address_line, p.city, p.state
        o.buy_box_name = boxes.get(e.buy_box_id)
        o.exception_requested_by_name = names.get(e.exception_requested_by_id) if e.exception_requested_by_id else None
        o.exception_approver_name = names.get(e.exception_approver_id) if e.exception_approver_id else None
        out.append(o)
    return out


def evaluations_query(
    box_id: uuid.UUID, *, result: list[str] | None, exception_status: list[str] | None, current_only: bool,
    q: str | None,
) -> Select:
    from app.modules.properties.models import Property

    stmt = (select(BuyboxEvaluation).join(Property, Property.id == BuyboxEvaluation.property_id)
            .where(BuyboxEvaluation.buy_box_id == box_id, Property.deleted_at.is_(None)))
    if current_only:
        stmt = stmt.where(BuyboxEvaluation.is_current.is_(True))
    stmt = in_filter(stmt, BuyboxEvaluation.result, result)
    stmt = in_filter(stmt, BuyboxEvaluation.exception_status, exception_status)
    return apply_search(stmt, q, [Property.name, Property.address_line, Property.city, Property.county])


async def get_evaluation(db: AsyncSession, eval_id: uuid.UUID) -> BuyboxEvaluation:
    ev = await db.get(BuyboxEvaluation, eval_id)
    if not ev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Evaluation not found")
    return ev


async def request_exception(db: AsyncSession, ev: BuyboxEvaluation, reason: str, actor: CurrentUser) -> BuyboxEvaluation:
    from app.modules.properties.models import Property
    from app.modules.tasks.service import create_task

    if not ev.is_current:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only the current evaluation can receive an exception")
    if ev.raw_result != "fail":
        raise HTTPException(status.HTTP_409_CONFLICT, "Exceptions apply only to failed evaluations")
    if ev.exception_status in ("requested", "approved"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"An exception is already {ev.exception_status}")
    box = await get(db, ev.buy_box_id)
    p = await db.get(Property, ev.property_id)
    label = _property_label(p) if p else str(ev.property_id)
    ev.exception_status = "requested"
    ev.exception_requested_by_id = actor.id
    ev.exception_requested_at = utcnow()
    ev.exception_request_reason = reason
    ev.exception_approver_id = ev.exception_decided_at = ev.exception_decision_reason = None
    ev.updated_by_id = actor.id
    await create_task(
        db,
        title=f"Approve buy box exception: {label} ({box.name})",
        description=f"Requested by {actor.full_name}: {reason}",
        assignee_id=box.owner_id,
        task_type="approval",
        priority="high",
        related_type="property",
        related_id=ev.property_id,
        related_label=label,
        source="buybox",
        idempotency_key=f"buybox-exception:{ev.id}:{ev.exception_requested_at.isoformat()}",
        actor_id=actor.id,
    )
    await audit.record(db, actor=actor, action="buybox.exception_requested", entity_type="property",
                       entity_id=ev.property_id, summary=f"{box.name} v{ev.buy_box_version}: {reason}",
                       changes={"evaluation_id": str(ev.id)}, ip_address=actor.ip_address)
    await db.commit()
    return ev


async def decide_exception(
    db: AsyncSession, ev: BuyboxEvaluation, approve: bool, reason: str, actor: CurrentUser
) -> BuyboxEvaluation:
    from app.modules.tasks.models import Task

    if ev.exception_status != "requested":
        raise HTTPException(status.HTTP_409_CONFLICT, "There is no pending exception request")
    if not ev.is_current:
        raise HTTPException(status.HTTP_409_CONFLICT, "This evaluation has been superseded")
    box = await get(db, ev.buy_box_id)
    ev.exception_status = "approved" if approve else "rejected"
    ev.exception_approver_id = actor.id
    ev.exception_decided_at = utcnow()
    ev.exception_decision_reason = reason
    ev.result = "pass_with_exception" if approve else ev.raw_result
    ev.updated_by_id = actor.id

    if ev.exception_requested_at:
        task = await db.scalar(select(Task).where(
            Task.idempotency_key == f"buybox-exception:{ev.id}:{ev.exception_requested_at.isoformat()}"))
        if task and task.status not in ("done", "cancelled"):
            task.status = "done"
            task.completed_at = utcnow()
            task.completed_by_id = actor.id
            task.resolution_note = f"{'Approved' if approve else 'Rejected'}: {reason}"

    verb = "approved" if approve else "rejected"
    await audit.record(db, actor=actor, action=f"buybox.exception_{verb}", entity_type="property",
                       entity_id=ev.property_id, summary=f"{box.name} v{ev.buy_box_version}: {reason}",
                       changes={"evaluation_id": str(ev.id), "result": {"from": ev.raw_result, "to": ev.result}},
                       ip_address=actor.ip_address)
    await db.commit()
    return ev
