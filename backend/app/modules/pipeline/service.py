"""Acquisition pipeline (spec module 11).

Every stage has explicit entry requirements, declared once in STAGE_GATES. Moving with unmet
requirements is an audited override that needs `pipeline:approve` and a reason. Dead opportunities are
retained (never deleted) with a structured reason and a reactivation rule.
"""
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.pipeline.models import (
    ACTIVE_STAGES,
    DEAD_REASONS,
    DEFAULT_STALL_DAYS,
    REACTIVATION_TYPES,
    STAGES,
    Opportunity,
    OpportunityEvent,
    PipelineStageSetting,
)
from app.modules.pipeline.schemas import (
    BoardColumn,
    ConversionMetric,
    MetricsOut,
    MoveIn,
    OpportunityCreate,
    OpportunityListItem,
    OpportunityOut,
    OpportunityUpdate,
    Requirement,
    StageMetric,
    VelocityMetric,
)

ENTITY = "opportunity"
EMPTY = (None, "", [], {})

# Reactivation trigger catalogue (spec module 30). `required` keys must all be present, `any_of` needs one.
REACTIVATION_SPEC: dict[str, dict[str, Any]] = {
    "time": {
        "label": "Revisit after time",
        "params": [{"key": "after_days", "label": "After days", "type": "number"},
                   {"key": "on_date", "label": "On date", "type": "date"}],
        "required": [], "any_of": ["after_days", "on_date"],
    },
    "debt": {
        "label": "Debt event",
        "params": [{"key": "event", "label": "Debt event", "type": "select",
                    "options": ["maturity", "rate_reset", "lockout_end", "defeasance_window", "lien_or_default"]},
                   {"key": "date", "label": "Expected date", "type": "date"}],
        "required": ["event"], "any_of": [],
    },
    "price": {
        "label": "Price or listing change",
        "params": [{"key": "target_price", "label": "Target price", "type": "number"},
                   {"key": "drop_pct", "label": "Price drop %", "type": "number"},
                   {"key": "on_listing", "label": "When listed for sale", "type": "boolean"}],
        "required": [], "any_of": ["target_price", "drop_pct", "on_listing"],
    },
    "ownership": {
        "label": "Ownership or entity change",
        "params": [{"key": "event", "label": "Change", "type": "select",
                    "options": ["any_change", "sale", "entity_change", "estate_or_succession"]}],
        "required": ["event"], "any_of": [],
    },
    "lease": {
        "label": "Lease or tenant event",
        "params": [{"key": "event", "label": "Lease event", "type": "select",
                    "options": ["expiration", "renewal", "vacancy", "tenant_change"]},
                   {"key": "date", "label": "Expected date", "type": "date"}],
        "required": ["event"], "any_of": [],
    },
    "market": {
        "label": "Market / rate / comp move",
        "params": [{"key": "metric", "label": "Metric", "type": "select",
                    "options": ["cap_rate", "interest_rate", "comp_price_psf"]},
                   {"key": "direction", "label": "Direction", "type": "select", "options": ["above", "below"]},
                   {"key": "threshold", "label": "Threshold", "type": "number"}],
        "required": ["metric", "direction", "threshold"], "any_of": [],
    },
    "development": {
        "label": "Development / infrastructure",
        "params": [{"key": "description", "label": "What to watch", "type": "text"}],
        "required": ["description"], "any_of": [],
    },
    "relationship": {
        "label": "Relationship / warm path",
        "params": [{"key": "description", "label": "Relationship to watch", "type": "text"}],
        "required": ["description"], "any_of": [],
    },
    "manual": {
        "label": "Manual field / threshold",
        "params": [{"key": "description", "label": "Condition", "type": "text"},
                   {"key": "review_on", "label": "Review on", "type": "date"}],
        "required": ["description"], "any_of": [],
    },
}


def rule_problems(rule: Any) -> list[str]:
    if not isinstance(rule, dict) or not rule.get("type"):
        return ["Choose a reactivation trigger type"]
    spec = REACTIVATION_SPEC.get(rule["type"])
    if rule["type"] not in REACTIVATION_TYPES or not spec:
        return [f"Unknown reactivation type '{rule['type']}'"]
    params = rule.get("params") or {}
    if not isinstance(params, dict):
        return ["Reactivation parameters must be an object"]
    labels = {p["key"]: p["label"] for p in spec["params"]}
    problems = [f"{labels.get(k, k)} is required" for k in spec["required"] if params.get(k) in EMPTY]
    if spec["any_of"] and all(params.get(k) in EMPTY or params.get(k) is False for k in spec["any_of"]):
        problems.append("Provide one of: " + ", ".join(labels.get(k, k).lower() for k in spec["any_of"]))
    return problems


# ----------------------------------------------------------------------------- stage gates


def _req(key: str, label: str, met: bool, *, fields: list[str] | None = None, detail: str | None = None,
         blocking: bool = True) -> Requirement:
    return Requirement(key=key, label=label, met=bool(met), fields=fields or [], detail=detail, blocking=blocking)


def _set(o: Opportunity, field: str) -> bool:
    return getattr(o, field, None) not in EMPTY


async def _gate_sourced(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    reqs = [_req("property", "Linked to a property", o.property_id is not None, fields=["property_id"])]
    met, detail = False, "Property not yet evaluated against any active buy box"
    if o.property_id:
        try:
            from app.modules.buybox.models import BuyboxEvaluation

            results = list(await db.scalars(select(BuyboxEvaluation.result).where(
                BuyboxEvaluation.property_id == o.property_id, BuyboxEvaluation.is_current.is_(True))))
            if results:
                met = True
                detail = ", ".join(sorted({r.replace("_", " ") for r in results}))
        except ImportError:
            detail = "Buy box module unavailable"
    reqs.append(_req("buybox", "Current buy box evaluation", met, detail=detail))
    if o.property_id:
        from app.modules.properties.models import Property
        from app.modules.properties.service import missing_fields

        p = await db.get(Property, o.property_id)
        if p:
            missing = missing_fields(p)
            reqs.append(_req(
                "completeness", "Property data completeness checked", not missing, blocking=False,
                detail=f"{round(p.completeness_score)}% complete" + (f"; missing {', '.join(missing)}" if missing else ""),
            ))
    return reqs


async def _gate_screening(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [_req("owner_contact", "Owner or contact identified",
                 bool(o.primary_person_id or o.primary_organization_id),
                 fields=["primary_person_id", "primary_organization_id"])]


async def _gate_research(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    named = list(o.research_missing_fields or [])
    detail = ", ".join(named) or None
    if not named and o.stage != "research":
        # Moving into research fills these from the property's Insufficient Data evaluations.
        named = await _default_research_fields(db, o)
        detail = f"From buy box evaluation: {', '.join(named)}" if named else None
    return [_req("missing_fields", "Named missing fields to resolve", bool(named),
                 fields=["research_missing_fields"], detail=detail)]


async def _gate_underwriting(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [
        _req("estimated_value", "Estimated value", _set(o, "estimated_value"), fields=["estimated_value"]),
        _req("cap_rate", "Cap rate", _set(o, "cap_rate"), fields=["cap_rate"]),
        _req("underwriting_notes", "Underwriting summary notes", _set(o, "underwriting_notes"),
             fields=["underwriting_notes"]),
    ]


async def _gate_contact(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    try:
        from app.modules.outreach.models import Interaction
    except ImportError:
        return [_req("interaction", "Logged outreach attempt with a disposition", False,
                     detail="Outreach module unavailable")]
    n = await db.scalar(select(func.count()).select_from(Interaction).where(
        Interaction.opportunity_id == o.id, Interaction.disposition.is_not(None)))
    return [_req("interaction", "Logged outreach attempt with a disposition", bool(n),
                 detail=f"{n} logged interaction{'s' if n != 1 else ''} with disposition" if n else
                 "Log a call, email or meeting on this opportunity first")]


async def _gate_negotiation(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [
        _req("price_expectation", "Owner price expectation", _set(o, "price_expectation"),
             fields=["price_expectation"]),
        _req("next_action", "Dated next action", _set(o, "next_action") and _set(o, "next_action_at"),
             fields=["next_action", "next_action_at"]),
    ]


async def _gate_offer(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [
        _req("offer_price", "Offer price", _set(o, "offer_price"), fields=["offer_price"]),
        _req("offer_sent_at", "Offer sent date", _set(o, "offer_sent_at"), fields=["offer_sent_at"]),
        _req("response_due_at", "Response due date", _set(o, "response_due_at"), fields=["response_due_at"]),
    ]


async def _gate_under_contract(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [_req("contract_executed_on", "Contract executed date", _set(o, "contract_executed_on"),
                 fields=["contract_executed_on"])]


async def _gate_due_diligence(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [_req("dd_deadline", "Due diligence deadline", _set(o, "dd_deadline"), fields=["dd_deadline"])]


async def _gate_closing(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [_req("closing_date", "Closing date scheduled", _set(o, "closing_date"), fields=["closing_date"])]


async def _gate_closed(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [
        _req("closed_price", "Closed price", _set(o, "closed_price"), fields=["closed_price"]),
        _req("closed_on", "Closed on date", _set(o, "closed_on"), fields=["closed_on"]),
    ]


async def _gate_dead(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    reqs = [_req("dead_reason", "Structured dead reason", o.dead_reason in DEAD_REASONS, fields=["dead_reason"])]
    if o.dead_reason == "price_gap":
        reqs.append(_req("price_gap", "Price gap amount", _set(o, "price_gap"), fields=["price_gap"]))
    problems = rule_problems(o.reactivation_rule)
    reqs.append(_req("reactivation_rule", "Reactivation rule", not problems, fields=["reactivation_rule"],
                     detail="; ".join(problems) or None))
    return reqs


async def _gate_nurture(db: AsyncSession, o: Opportunity) -> list[Requirement]:
    return [_req("next_touch_on", "Next touch date", _set(o, "next_touch_on"), fields=["next_touch_on"])]


GateCheck = Callable[[AsyncSession, Opportunity], Awaitable[list[Requirement]]]
STAGE_GATES: dict[str, GateCheck] = {
    "sourced": _gate_sourced,
    "screening": _gate_screening,
    "research": _gate_research,
    "underwriting": _gate_underwriting,
    "contact": _gate_contact,
    "negotiation": _gate_negotiation,
    "offer": _gate_offer,
    "under_contract": _gate_under_contract,
    "due_diligence": _gate_due_diligence,
    "closing": _gate_closing,
    "closed": _gate_closed,
    "dead": _gate_dead,
    "nurture": _gate_nurture,
}


async def check_gate(db: AsyncSession, o: Opportunity, stage: str) -> list[Requirement]:
    return await STAGE_GATES[stage](db, o)


def unmet_of(reqs: list[Requirement]) -> list[Requirement]:
    return [r for r in reqs if r.blocking and not r.met]


def next_stage(stage: str) -> str | None:
    if stage in ACTIVE_STAGES:
        i = ACTIVE_STAGES.index(stage)
        return ACTIVE_STAGES[i + 1] if i + 1 < len(ACTIVE_STAGES) else "closed"
    return None


def _enforce(unmet: list[Requirement], override_reason: str | None, actor: CurrentUser, stage: str) -> bool:
    """Returns True when this is an (authorised) override; raises when blocked."""
    if not unmet:
        return False
    detail = {"unmet": [r.model_dump() for r in unmet]}
    if not (override_reason and override_reason.strip()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {
            "message": f"Requirements for {stage.replace('_', ' ')} are not met: "
                       + ", ".join(r.label.lower() for r in unmet), **detail})
    if not actor.can("pipeline", "approve"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {
            "message": "Overriding stage requirements requires pipeline approval permission", **detail})
    return True


# ----------------------------------------------------------------------------- helpers


def value_of(o: Any) -> float | None:
    for f in ("closed_price", "offer_price", "price_expectation", "estimated_value"):
        v = getattr(o, f, None)
        if v is not None:
            return float(v)
    return None


def value_expr(t: Any = None) -> Any:
    c = t.c if t is not None else Opportunity
    return func.coalesce(c.closed_price, c.offer_price, c.price_expectation, c.estimated_value)


def _snapshot(o: Opportunity) -> dict:
    fields = [
        "title", "property_id", "owner_id", "stage", "priority", "primary_person_id", "primary_organization_id",
        "next_action", "next_action_at", "price_expectation", "estimated_value", "cap_rate", "offer_price",
        "offer_sent_at", "response_due_at", "contract_executed_on", "dd_deadline", "closing_date", "closed_price",
        "closed_on", "dead_reason", "price_gap", "reactivation_rule", "next_touch_on", "research_missing_fields",
    ]
    return to_jsonable({f: getattr(o, f) for f in fields})


async def get_thresholds(db: AsyncSession) -> dict[str, int]:
    rows = {r.stage: r.stall_days for r in await db.scalars(select(PipelineStageSetting))}
    return {s: rows.get(s, DEFAULT_STALL_DAYS) for s in STAGES}


def stalled_condition(thresholds: dict[str, int]) -> Any:
    now = utcnow()
    return or_(*[
        and_(Opportunity.stage == s,
             Opportunity.stage_entered_at < now - timedelta(days=thresholds.get(s, DEFAULT_STALL_DAYS)))
        for s in ACTIVE_STAGES
    ])


async def user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())


async def to_items(db: AsyncSession, rows: list[Opportunity], thresholds: dict[str, int]) -> list[OpportunityListItem]:
    from app.modules.properties.models import Property

    if not rows:
        return []
    props = {r.id: r for r in (await db.execute(
        select(Property.id, Property.name, Property.address_line, Property.city, Property.state)
        .where(Property.id.in_({o.property_id for o in rows if o.property_id}))
    )).all()}
    names = await user_names(db, {o.owner_id for o in rows})
    now = utcnow()
    out = []
    for o in rows:
        item = OpportunityListItem.model_validate(o)
        p = props.get(o.property_id) if o.property_id else None
        if p:
            item.property_label, item.property_city, item.property_state = p.name or p.address_line, p.city, p.state
        item.owner_name = names.get(o.owner_id) if o.owner_id else None
        item.stage_age_days = round((now - o.stage_entered_at).total_seconds() / 86400, 1)
        item.stalled = o.stage in ACTIVE_STAGES and item.stage_age_days > thresholds.get(o.stage, DEFAULT_STALL_DAYS)
        item.value = value_of(o)
        out.append(item)
    return out


async def to_out(db: AsyncSession, o: Opportunity) -> OpportunityOut:
    item = (await to_items(db, [o], await get_thresholds(db)))[0]
    out = OpportunityOut(**{**OpportunityOut.model_validate(o).model_dump(), **item.model_dump()})
    try:
        from app.modules.contacts.models import Organization, Person

        if o.primary_person_id:
            out.primary_person_label = await db.scalar(select(Person.full_name).where(Person.id == o.primary_person_id))
        if o.primary_organization_id:
            out.primary_organization_label = await db.scalar(
                select(Organization.name).where(Organization.id == o.primary_organization_id))
    except ImportError:
        pass
    return out


async def get(db: AsyncSession, opportunity_id: uuid.UUID) -> Opportunity:
    o = await db.get(Opportunity, opportunity_id)
    if not o or o.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Opportunity not found")
    return o


# ----------------------------------------------------------------------------- queries


@dataclass
class OpportunityFilters:
    q: str | None = None
    stage: list[str] | None = None
    owner_id: list[uuid.UUID] | None = None
    priority: list[str] | None = None
    source: list[str] | None = None
    dead_reason: list[str] | None = None
    property_id: uuid.UUID | None = None
    stalled: bool | None = None
    overdue: bool | None = None
    min_value: float | None = None
    max_value: float | None = None


def build_query(f: OpportunityFilters, thresholds: dict[str, int], *, skip: set[str] = frozenset()) -> Select:
    from app.modules.properties.models import Property

    stmt = (select(Opportunity).outerjoin(Property, Property.id == Opportunity.property_id)
            .where(Opportunity.deleted_at.is_(None)))
    stmt = apply_search(stmt, f.q, [Opportunity.title, Opportunity.source, Opportunity.next_action, Property.name,
                                     Property.address_line, Property.city, Property.county])
    for key, col in (("stage", Opportunity.stage), ("owner_id", Opportunity.owner_id),
                     ("priority", Opportunity.priority), ("source", Opportunity.source),
                     ("dead_reason", Opportunity.dead_reason)):
        if key not in skip:
            stmt = in_filter(stmt, col, getattr(f, key))
    if f.property_id:
        stmt = stmt.where(Opportunity.property_id == f.property_id)
    if f.stalled:
        stmt = stmt.where(stalled_condition(thresholds))
    if f.overdue:
        stmt = stmt.where(Opportunity.next_action_at < utcnow(),
                          Opportunity.stage.notin_(["closed", "dead"]))
    return range_filter(stmt, value_expr(), f.min_value, f.max_value)


async def board(db: AsyncSession, f: OpportunityFilters, thresholds: dict[str, int], stages: list[str],
                per_stage: int) -> list[BoardColumn]:
    base = build_query(f, thresholds, skip={"stage"})
    sub = base.order_by(None).subquery()
    agg = {s: (int(c), float(v or 0)) for s, c, v in (await db.execute(
        select(sub.c.stage, func.count(), func.sum(value_expr(sub))).group_by(sub.c.stage)
    )).all()}
    cols = []
    for s in stages:
        rows = list(await db.scalars(base.where(Opportunity.stage == s).order_by(
            Opportunity.next_action_at.asc().nulls_last(), Opportunity.stage_entered_at.asc()).limit(per_stage)))
        count, value = agg.get(s, (0, 0.0))
        cols.append(BoardColumn(stage=s, count=count, value=value, stall_days=thresholds.get(s, DEFAULT_STALL_DAYS),
                                items=await to_items(db, rows, thresholds)))
    return cols


async def metrics(db: AsyncSession, thresholds: dict[str, int], owner_id: list[uuid.UUID] | None) -> MetricsOut:
    live = [Opportunity.deleted_at.is_(None)]
    if owner_id:
        live.append(Opportunity.owner_id.in_(owner_id))

    per_stage = {s: (int(c), float(v or 0), float(a) if a is not None else None) for s, c, v, a in (await db.execute(
        select(Opportunity.stage, func.count(), func.sum(value_expr()),
               func.avg(func.extract("epoch", func.now() - Opportunity.stage_entered_at) / 86400))
        .where(*live).group_by(Opportunity.stage)
    )).all()}
    stalled_counts = dict((await db.execute(
        select(Opportunity.stage, func.count()).where(*live, stalled_condition(thresholds)).group_by(Opportunity.stage)
    )).all())
    stages = [
        StageMetric(stage=s, count=per_stage.get(s, (0,))[0], value=per_stage.get(s, (0, 0.0))[1],
                    avg_age_days=round(per_stage[s][2], 1) if s in per_stage and per_stage[s][2] is not None else None,
                    stalled=int(stalled_counts.get(s, 0)), stall_days=thresholds.get(s, DEFAULT_STALL_DAYS))
        for s in STAGES
    ]

    # Velocity: time spent in each stage = gap between entering it and the next movement.
    prev_at = func.lag(OpportunityEvent.at).over(partition_by=OpportunityEvent.opportunity_id,
                                                 order_by=OpportunityEvent.at)
    ev = (select(OpportunityEvent.from_stage, OpportunityEvent.at, prev_at.label("prev_at"))
          .join(Opportunity, Opportunity.id == OpportunityEvent.opportunity_id).where(*live).subquery())
    vel = {s: (float(a) if a is not None else None, int(n)) for s, a, n in (await db.execute(
        select(ev.c.from_stage, func.avg(func.extract("epoch", ev.c.at - ev.c.prev_at) / 86400), func.count())
        .where(ev.c.prev_at.is_not(None), ev.c.from_stage.is_not(None)).group_by(ev.c.from_stage)
    )).all()}
    velocity = [VelocityMetric(stage=s, avg_days=round(vel[s][0], 1) if s in vel and vel[s][0] is not None else None,
                               samples=vel.get(s, (None, 0))[1]) for s in ACTIVE_STAGES]

    reached: dict[uuid.UUID, set[str]] = {}
    for oid, st in (await db.execute(
        select(OpportunityEvent.opportunity_id, OpportunityEvent.to_stage)
        .join(Opportunity, Opportunity.id == OpportunityEvent.opportunity_id).where(*live).distinct()
    )).all():
        reached.setdefault(oid, set()).add(st)
    progression = [*ACTIVE_STAGES, "closed"]
    conversion = []
    for i, s in enumerate(progression[:-1]):
        later = set(progression[i + 1:])
        entered = [r for r in reached.values() if s in r]
        converted = sum(1 for r in entered if r & later)
        conversion.append(ConversionMetric(stage=s, next_stage=progression[i + 1], entered=len(entered),
                                           converted=converted,
                                           rate=round(converted / len(entered), 4) if entered else None))

    stalled_rows = list(await db.scalars(select(Opportunity).where(*live, stalled_condition(thresholds))
                                         .order_by(Opportunity.stage_entered_at.asc()).limit(50)))
    active = [m for m in stages if m.stage in ACTIVE_STAGES]
    by = {m.stage: m for m in stages}
    totals = {
        "active_count": sum(m.count for m in active), "active_value": sum(m.value for m in active),
        "stalled_count": sum(m.stalled for m in active), "closed_count": by["closed"].count,
        "closed_value": by["closed"].value, "dead_count": by["dead"].count, "nurture_count": by["nurture"].count,
    }
    return MetricsOut(stages=stages, velocity=velocity, conversion=conversion,
                      stalled=await to_items(db, stalled_rows, thresholds), totals=totals)


async def save_thresholds(db: AsyncSession, values: dict[str, int], actor: CurrentUser) -> dict[str, int]:
    before = await get_thresholds(db)
    for stage, days in values.items():
        if stage not in ACTIVE_STAGES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown or non-active stage '{stage}'")
        if not 1 <= int(days) <= 365:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Stall threshold must be 1–365 days")
        row = await db.get(PipelineStageSetting, stage)
        if row:
            row.stall_days, row.updated_by_id = int(days), actor.id
        else:
            db.add(PipelineStageSetting(stage=stage, stall_days=int(days), updated_by_id=actor.id))
    changes = {s: {"from": before[s], "to": int(d)} for s, d in values.items() if before[s] != int(d)}
    if changes:
        await audit.record(db, actor=actor, action="pipeline.stall_thresholds_updated", entity_type="pipeline",
                           changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return await get_thresholds(db)


# ----------------------------------------------------------------------------- mutations


async def _default_research_fields(db: AsyncSession, o: Opportunity) -> list[str]:
    if not o.property_id:
        return []
    fields: set[str] = set()
    try:
        from app.modules.buybox.models import BuyboxEvaluation

        for mf in await db.scalars(select(BuyboxEvaluation.missing_fields).where(
                BuyboxEvaluation.property_id == o.property_id, BuyboxEvaluation.is_current.is_(True),
                BuyboxEvaluation.result == "insufficient_data")):
            fields.update(mf or [])
    except ImportError:
        pass
    return sorted(fields)


async def _convert_property(db: AsyncSession, o: Opportunity, actor: CurrentUser) -> None:
    """Closed opportunity -> property becomes an owned asset."""
    from app.modules.properties.models import Property

    if not o.property_id:
        return
    p = await db.get(Property, o.property_id)
    if not p or p.status == "owned":
        return
    old = p.status
    p.status = "owned"
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="property.converted_to_asset", entity_type="property", entity_id=p.id,
                       summary=f"Closed via opportunity “{o.title}”",
                       changes={"status": {"from": old, "to": "owned"}, "opportunity_id": str(o.id)},
                       ip_address=actor.ip_address)
    await events.emit(db, "property.updated", property_id=p.id, changed={"status"}, actor=actor)


async def _closed_snapshot(db: AsyncSession, o: Opportunity, actor: CurrentUser) -> dict:
    from app.modules.properties.models import Property

    snap = {"opportunity": _snapshot(o), "closed_by": actor.full_name, "closed_recorded_at": utcnow()}
    if o.property_id and (p := await db.get(Property, o.property_id)):
        snap["property"] = {k: getattr(p, k) for k in (
            "id", "name", "address_line", "city", "state", "county", "property_type", "building_area_sf",
            "land_area_acres", "asking_price", "noi", "occupancy_pct")}
    return to_jsonable(snap)


async def _follow_up_if_needed(db: AsyncSession, o: Opportunity, stage: str, actor: CurrentUser) -> None:
    if stage not in ("contact", "negotiation") or o.next_action_at:
        return
    from app.modules.tasks.service import create_task

    now = utcnow()
    await create_task(
        db,
        title=f"Set a dated next action: {o.title}",
        description=f"Opportunity entered {stage.replace('_', ' ')} without a scheduled next action.",
        assignee_id=o.owner_id,
        due_at=now + timedelta(days=1),
        task_type="follow_up",
        priority="high",
        related_type="opportunity",
        related_id=o.id,
        related_label=o.title,
        source="pipeline",
        idempotency_key=f"pipeline-next-action:{o.id}:{stage}:{int(now.timestamp())}",
        actor_id=actor.id,
    )


async def create(db: AsyncSession, data: OpportunityCreate, actor: CurrentUser, *, force: bool = False) -> Opportunity:
    from app.modules.properties.models import Property

    p = await db.get(Property, data.property_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    existing = list(await db.scalars(select(Opportunity).where(
        Opportunity.property_id == p.id, Opportunity.deleted_at.is_(None), Opportunity.stage != "closed")))
    if existing and not force:
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "message": "This property already has an opportunity. Reactivate or continue it instead.",
            "existing": [{"id": str(o.id), "title": o.title, "stage": o.stage} for o in existing],
        })

    # Sourced requires a current buy box evaluation: run one now if the property has none yet.
    try:
        from app.modules.buybox.models import BuyboxEvaluation
        from app.modules.buybox.service import evaluate_property

        has_eval = await db.scalar(select(func.count()).select_from(BuyboxEvaluation).where(
            BuyboxEvaluation.property_id == p.id, BuyboxEvaluation.is_current.is_(True)))
        if not has_eval:
            await evaluate_property(db, p.id, trigger="opportunity_created", actor_id=actor.id)
    except ImportError:
        pass

    now = utcnow()
    values = data.model_dump(exclude={"override_reason", "title"})
    o = Opportunity(**values, title=(data.title or "").strip() or (p.name or p.address_line),
                    stage="sourced", stage_entered_at=now, created_by_id=actor.id, updated_by_id=actor.id)
    o.owner_id = o.owner_id or actor.id
    db.add(o)
    await db.flush()

    unmet = unmet_of(await check_gate(db, o, "sourced"))
    override = _enforce(unmet, data.override_reason, actor, "sourced")
    db.add(OpportunityEvent(opportunity_id=o.id, from_stage=None, to_stage="sourced", actor_id=actor.id,
                            actor_name=actor.full_name, at=now, override=override,
                            reason=data.override_reason if override else None,
                            unmet=[r.model_dump() for r in unmet], snapshot=_snapshot(o)))
    await audit.record(db, actor=actor, action="opportunity.created", entity_type=ENTITY, entity_id=o.id,
                       summary=o.title + (" (gate override)" if override else ""),
                       changes={"override_reason": data.override_reason} if override else None,
                       ip_address=actor.ip_address)
    await events.emit(db, "opportunity.created", opportunity_id=o.id, actor=actor)
    await db.commit()
    return o


async def update(db: AsyncSession, o: Opportunity, data: OpportunityUpdate, actor: CurrentUser) -> Opportunity:
    if o.stage == "closed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Closed opportunities are an immutable transaction record")
    values = data.model_dump(exclude_unset=True)
    if "title" in values and not values["title"]:
        values.pop("title")
    changes = audit.diff(o, values)
    if not changes:
        return o
    before = {r.key for r in await check_gate(db, o, o.stage) if r.blocking and r.met}
    for k, v in values.items():
        setattr(o, k, v)
    broken = [r for r in await check_gate(db, o, o.stage) if r.blocking and not r.met and r.key in before]
    if broken:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {
            "message": "This change would remove data required for the current stage: "
                       + ", ".join(r.label.lower() for r in broken),
            "unmet": [r.model_dump() for r in broken],
        })
    o.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="opportunity.updated", entity_type=ENTITY, entity_id=o.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return o


async def move(db: AsyncSession, o: Opportunity, data: MoveIn, actor: CurrentUser) -> Opportunity:
    to, frm = data.to_stage, o.stage
    if frm == "closed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Closed opportunities cannot change stage")
    if to == frm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Opportunity is already in {to.replace('_', ' ')}")

    values = data.fields.model_dump(exclude_unset=True)
    if "title" in values and not values["title"]:
        values.pop("title")
    field_changes = audit.diff(o, values)
    for k, v in values.items():
        setattr(o, k, v)
    if to == "research" and not o.research_missing_fields:
        o.research_missing_fields = await _default_research_fields(db, o)

    unmet = unmet_of(await check_gate(db, o, to))
    override = _enforce(unmet, data.override_reason, actor, to)

    now = utcnow()
    o.stage, o.stage_entered_at, o.updated_by_id = to, now, actor.id
    if to == "dead":
        o.dead_at = now
    if to == "closed":
        o.closed_snapshot = await _closed_snapshot(db, o, actor)
    reason = data.override_reason.strip() if override and data.override_reason else None
    if not reason and to == "dead":
        reason = (o.dead_reason or "").replace("_", " ") + (f": {o.dead_notes}" if o.dead_notes else "")
    db.add(OpportunityEvent(opportunity_id=o.id, from_stage=frm, to_stage=to, actor_id=actor.id,
                            actor_name=actor.full_name, at=now, override=override, reason=reason,
                            unmet=[r.model_dump() for r in unmet], snapshot=_snapshot(o)))
    changes: dict[str, Any] = {"stage": {"from": frm, "to": to}, **field_changes}
    if override:
        changes["override"] = {"reason": reason, "unmet": [r.label for r in unmet]}
    await audit.record(db, actor=actor, action="opportunity.stage_changed", entity_type=ENTITY, entity_id=o.id,
                       summary=f"{frm.replace('_', ' ')} → {to.replace('_', ' ')}" + (" (override)" if override else ""),
                       changes=changes, ip_address=actor.ip_address)

    if to == "closed":
        await _convert_property(db, o, actor)
    await _follow_up_if_needed(db, o, to, actor)
    await events.emit(db, "opportunity.stage_changed", opportunity_id=o.id, from_stage=frm, to_stage=to, actor=actor)
    if to == "dead":
        await events.emit(db, "opportunity.dead", opportunity_id=o.id, actor=actor)
    await db.commit()
    return o


async def archive(db: AsyncSession, o: Opportunity, actor: CurrentUser) -> None:
    if o.stage == "dead":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Dead opportunities are retained for reactivation and cannot be deleted")
    if o.stage == "closed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Closed opportunities are an immutable transaction record")
    o.deleted_at = utcnow()
    o.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="opportunity.deleted", entity_type=ENTITY, entity_id=o.id,
                       summary=o.title, ip_address=actor.ip_address)
    await db.commit()
