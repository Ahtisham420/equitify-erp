"""Offers, LOIs & negotiation (spec module 15).

Every offer version is tied to an approved underwriting model. Sent / received versions are frozen: a counter
always creates a new version in the same chain (root_offer_id), so the full negotiation history is retained and
any two versions can be diffed. Deviations from the approved model route for named, timestamped approval.
Offers whose response clock runs out are expired by a scan (and on read) and always raise follow-up work.
"""
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.offers.models import TERM_FIELDS, Offer, OfferApproval, OfferSettings
from app.modules.offers.schemas import (
    ApprovalIn,
    CounterIn,
    DeltaOut,
    OfferCreate,
    OfferListItem,
    OfferOut,
    OfferSettingsIn,
    OfferTerms,
    RespondIn,
    SendIn,
    TermDelta,
    WinningPriceIn,
)

ENTITY = "offer"
NUMERIC_TERMS = {
    "price", "earnest_money", "earnest_money_hard_days", "feasibility_days", "closing_days", "extension_count",
    "extension_days", "extension_cost", "financing_days", "title_survey_days", "exclusivity_days",
}
COPY_FIELDS = [*TERM_FIELDS.keys(), "notes", "tags"]
DEFAULT_SETTINGS: dict[str, Any] = {
    "price_threshold": 10_000_000.0,
    "deviation_threshold_pct": 2.0,
    "second_approval_deviation_pct": 5.0,
    "approval_structures": ["assumption", "seller_financing", "joint_venture", "other"],
    "max_feasibility_days": 60,
    "max_earnest_money_pct": 5.0,
    "require_approval_always": False,
    "default_response_days": 3,
}
# Pipeline progression used to decide whether an accepted offer may advance the opportunity.
_PRE_OFFER_STAGES = ["sourced", "screening", "research", "underwriting", "contact", "negotiation"]


# ----------------------------------------------------------------------------- settings


async def get_settings(db: AsyncSession) -> OfferSettings:
    row = await db.get(OfferSettings, 1)
    return row or OfferSettings(id=1, **DEFAULT_SETTINGS)


async def save_settings(db: AsyncSession, data: OfferSettingsIn, actor: CurrentUser) -> OfferSettings:
    row = await db.get(OfferSettings, 1)
    values = data.model_dump()
    if row is None:
        row = OfferSettings(id=1, **DEFAULT_SETTINGS)
        db.add(row)
        changes = {k: {"from": DEFAULT_SETTINGS.get(k), "to": v} for k, v in values.items()
                   if DEFAULT_SETTINGS.get(k) != v}
    else:
        changes = audit.diff(row, values)
    for k, v in values.items():
        setattr(row, k, v)
    row.updated_by_id = actor.id
    row.updated_at = utcnow()
    if changes:
        await audit.record(db, actor=actor, action="offer.settings_updated", entity_type="offer_settings",
                           changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return row


# ----------------------------------------------------------------------------- lookups


async def get(db: AsyncSession, offer_id: uuid.UUID) -> Offer:
    o = await db.get(Offer, offer_id)
    if not o or o.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Offer not found")
    return o


async def _opportunity(db: AsyncSession, opportunity_id: uuid.UUID):
    from app.modules.pipeline.models import Opportunity

    opp = await db.get(Opportunity, opportunity_id)
    if not opp or opp.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Opportunity not found")
    return opp


async def _approved_model(db: AsyncSession, model_id: uuid.UUID):
    """Offers cannot exist independently of an approved underwriting model."""
    try:
        from app.modules.underwriting.service import get_approved
    except ImportError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "Underwriting module is unavailable: offers can only be created from an approved "
                            "underwriting model")
    return await get_approved(db, model_id)


def _model_price(model: Any) -> float | None:
    outputs = getattr(model, "outputs", None) or {}
    v = outputs.get("purchase_price") if isinstance(outputs, dict) else None
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


async def approved_models(db: AsyncSession, *, opportunity_id: uuid.UUID | None,
                          property_id: uuid.UUID | None) -> list[dict]:
    """Approved underwriting models an offer can be prepared from (read via the shared `uw_models` table)."""
    from app.core.database import Base

    t = Base.metadata.tables.get("uw_models")
    if t is None:
        return []
    stmt = select(t).where(t.c.status == "approved")
    if "deleted_at" in t.c:
        stmt = stmt.where(t.c.deleted_at.is_(None))
    conds = []
    if opportunity_id:
        conds.append(t.c.opportunity_id == opportunity_id)
    if property_id:
        conds.append(t.c.property_id == property_id)
    if conds:
        stmt = stmt.where(or_(*conds))
    stmt = stmt.order_by(t.c.approved_at.desc().nulls_last()).limit(100)
    out = []
    for r in (await db.execute(stmt)).mappings().all():
        outputs = r.get("outputs") or {}
        out.append({
            "id": r["id"], "name": r.get("name"), "version": r.get("version"), "property_id": r.get("property_id"),
            "opportunity_id": r.get("opportunity_id"), "approved_at": r.get("approved_at"),
            "purchase_price": outputs.get("purchase_price"), "going_in_cap": outputs.get("going_in_cap"),
            "irr": outputs.get("irr"),
        })
    return out


# ----------------------------------------------------------------------------- approval routing


def compute_deviation(price: float | None, model_price: float | None) -> float | None:
    if price is None or not model_price:
        return None
    return round((float(price) - float(model_price)) / float(model_price) * 100, 3)


def route(o: Offer, s: OfferSettings) -> tuple[int, list[str]]:
    """How many approvals this version needs and why (price / structure / deviation from the approved model)."""
    levels, reasons = 0, []

    def need(n: int, why: str) -> None:
        nonlocal levels
        levels = max(levels, n)
        reasons.append(why)

    if s.require_approval_always:
        need(1, "All offers require approval")
    if s.price_threshold is not None and o.price is not None and float(o.price) > float(s.price_threshold):
        need(1, f"Price exceeds approval threshold of ${float(s.price_threshold):,.0f}")
    if o.model_price is None:
        need(1, "Approved model has no purchase price to compare against")
    elif o.deviation_pct is not None:
        if o.deviation_pct > s.second_approval_deviation_pct:
            need(2, f"Price is {o.deviation_pct:.2f}% above the approved model "
                    f"(two approvals above {s.second_approval_deviation_pct:g}%)")
        elif o.deviation_pct > s.deviation_threshold_pct:
            need(1, f"Price is {o.deviation_pct:.2f}% above the approved model "
                    f"(threshold {s.deviation_threshold_pct:g}%)")
    if o.structure in (s.approval_structures or []):
        need(1, f"Non-standard structure: {o.structure.replace('_', ' ')}")
    if s.max_feasibility_days is not None and (o.feasibility_days or 0) > s.max_feasibility_days:
        need(1, f"Feasibility period {o.feasibility_days} days exceeds standard {s.max_feasibility_days}")
    if (s.max_earnest_money_pct is not None and o.earnest_money is not None and o.price
            and float(o.earnest_money) / float(o.price) * 100 > s.max_earnest_money_pct):
        need(1, f"Earnest money exceeds {s.max_earnest_money_pct:g}% of price")
    return levels, reasons


async def _apply_routing(db: AsyncSession, o: Offer) -> None:
    o.deviation_pct = compute_deviation(o.price, o.model_price)
    levels, reasons = route(o, await get_settings(db))
    o.approvals_required, o.approval_reasons, o.approval_required = levels, reasons, levels > 0


async def approvals_received(db: AsyncSession, o: Offer) -> int:
    return int(await db.scalar(select(func.count()).select_from(OfferApproval).where(
        OfferApproval.offer_id == o.id, OfferApproval.submission_no == o.submission_no,
        OfferApproval.decision == "approved")) or 0)


# ----------------------------------------------------------------------------- query


@dataclass
class OfferFilters:
    q: str | None = None
    status: list[str] | None = None
    origin: list[str] | None = None
    opportunity_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    uw_model_id: uuid.UUID | None = None
    owner_id: list[uuid.UUID] | None = None
    root_offer_id: uuid.UUID | None = None
    latest_only: bool = True
    due: str | None = None  # overdue | 24h | 72h
    min_price: float | None = None
    max_price: float | None = None


def _due_condition(due: str, now: datetime):
    awaiting = and_(Offer.status.in_(["sent", "countered"]), Offer.is_latest.is_(True),
                    Offer.response_due_at.is_not(None))
    if due == "overdue":
        return and_(awaiting, Offer.response_due_at < now)
    hours = 24 if due == "24h" else 72
    return and_(awaiting, Offer.response_due_at >= now, Offer.response_due_at < now + timedelta(hours=hours))


def build_query(f: OfferFilters, *, skip: set[str] = frozenset()) -> Select:
    from app.modules.pipeline.models import Opportunity
    from app.modules.properties.models import Property

    stmt = (select(Offer).join(Opportunity, Opportunity.id == Offer.opportunity_id)
            .outerjoin(Property, Property.id == Offer.property_id).where(Offer.deleted_at.is_(None)))
    stmt = apply_search(stmt, f.q, [Opportunity.title, Property.name, Property.address_line, Property.city,
                                     Offer.seller_name, Offer.buyer_entity, Offer.sent_to])
    if "status" not in skip:
        stmt = in_filter(stmt, Offer.status, f.status)
    if "origin" not in skip:
        stmt = in_filter(stmt, Offer.origin, f.origin)
    stmt = in_filter(stmt, Opportunity.owner_id, f.owner_id)
    if f.opportunity_id:
        stmt = stmt.where(Offer.opportunity_id == f.opportunity_id)
    if f.property_id:
        stmt = stmt.where(Offer.property_id == f.property_id)
    if f.uw_model_id:
        stmt = stmt.where(Offer.uw_model_id == f.uw_model_id)
    if f.root_offer_id:
        stmt = stmt.where(Offer.root_offer_id == f.root_offer_id)
    if f.latest_only and not f.root_offer_id:
        stmt = stmt.where(Offer.is_latest.is_(True))
    if f.due and "due" not in skip and f.due in ("overdue", "24h", "72h"):
        stmt = stmt.where(_due_condition(f.due, utcnow()))
    return range_filter(stmt, Offer.price, f.min_price, f.max_price)


async def due_counts(db: AsyncSession, f: OfferFilters) -> dict[str, int]:
    base = build_query(f, skip={"due"}).order_by(None)
    now = utcnow()
    out = {}
    for key in ("overdue", "24h", "72h"):
        out[key] = int(await db.scalar(
            select(func.count()).select_from(base.where(_due_condition(key, now)).subquery())) or 0)
    return out


async def user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())


def _clock(o: Offer, now: datetime) -> tuple[float | None, bool]:
    if not o.response_due_at or o.status not in ("sent", "countered") or not o.is_latest:
        return None, False
    hours = round((o.response_due_at - now).total_seconds() / 3600, 1)
    return hours, hours < 0


async def to_items(db: AsyncSession, rows: list[Offer]) -> list[OfferListItem]:
    from app.modules.pipeline.models import Opportunity
    from app.modules.properties.models import Property

    if not rows:
        return []
    opps = {r.id: r for r in (await db.execute(
        select(Opportunity.id, Opportunity.title, Opportunity.owner_id)
        .where(Opportunity.id.in_({o.opportunity_id for o in rows}))
    )).all()}
    props = {r.id: r for r in (await db.execute(
        select(Property.id, Property.name, Property.address_line)
        .where(Property.id.in_({o.property_id for o in rows if o.property_id}))
    )).all()}
    names = await user_names(db, {r.owner_id for r in opps.values()})
    now = utcnow()
    out = []
    for o in rows:
        item = OfferListItem.model_validate(o)
        opp = opps.get(o.opportunity_id)
        if opp:
            item.opportunity_title, item.owner_id = opp.title, opp.owner_id
            item.owner_name = names.get(opp.owner_id) if opp.owner_id else None
        p = props.get(o.property_id) if o.property_id else None
        if p:
            item.property_label = p.name or p.address_line
        item.hours_to_due, item.overdue = _clock(o, now)
        out.append(item)
    return out


async def to_out(db: AsyncSession, o: Offer, actor: CurrentUser) -> OfferOut:
    item = (await to_items(db, [o]))[0]
    out = OfferOut(**{**OfferOut.model_validate(o).model_dump(), **item.model_dump()})
    out.approvals_received = await approvals_received(db, o)
    out.has_loi = o.loi_payload is not None
    out.can_edit = o.status == "draft" and o.origin == "buyer" and actor.can("offers", "edit")
    already = await db.scalar(select(func.count()).select_from(OfferApproval).where(
        OfferApproval.offer_id == o.id, OfferApproval.submission_no == o.submission_no,
        OfferApproval.approver_id == actor.id))
    out.can_approve = (o.status == "pending_approval" and actor.can("offers", "approve")
                       and actor.can_approve("offer", float(o.price)) and not already)
    return out


# ----------------------------------------------------------------------------- helpers


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _label(o: Offer, opp_title: str | None = None) -> str:
    return f"{opp_title or 'Offer'} · v{o.version} · ${float(o.price):,.0f}"


def _terms(o: Offer) -> dict:
    return to_jsonable({k: getattr(o, k) for k in TERM_FIELDS})


def _require(o: Offer, statuses: list[str], action: str) -> None:
    if o.status not in statuses:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Cannot {action} an offer that is {o.status.replace('_', ' ')}")


async def _chain(db: AsyncSession, o: Offer) -> list[Offer]:
    return list(await db.scalars(select(Offer).where(
        Offer.root_offer_id == (o.root_offer_id or o.id), Offer.deleted_at.is_(None)).order_by(Offer.version)))


async def _upsert_date(db: AsyncSession, o: Offer, *, due: datetime, owner_id, actor, status_: str = "confirmed"):
    """Shared critical-date engine (contracts module). Optional: the offer clock works without it."""
    try:
        from app.modules.contracts.service import upsert_critical_date
    except ImportError:
        return None
    cd = await upsert_critical_date(
        db, related_type="offer", related_id=o.id, date_type="offer_response",
        label=f"Offer v{o.version} response due", due_on=due.date(), property_id=o.property_id,
        owner_id=owner_id, lead_days=1, is_blocking=False, source="rule", status=status_,
        key="offer_response", actor=actor,
    )
    # upsert never transitions an existing confirmed/missed date to completed: do it explicitly.
    if status_ == "completed" and actor is not None and getattr(cd, "status", None) in ("confirmed", "missed"):
        from app.modules.contracts.service import _complete

        await _complete(db, cd, f"Offer v{o.version} response recorded", actor)
    return getattr(cd, "id", None)


async def _set_opportunity_offer_fields(db: AsyncSession, opp, o: Offer, actor: CurrentUser | None, *,
                                        sent_at: datetime | None = None, due_at: datetime | None = None) -> dict:
    """Offer facts the pipeline gates rely on (offer price / sent / response due)."""
    if opp.stage in ("closed",):
        return {}
    values = {"offer_price": float(o.price), "offer_sent_at": sent_at or o.sent_at,
              "response_due_at": due_at or o.response_due_at}
    values = {k: v for k, v in values.items() if v is not None}
    changes = audit.diff(opp, values)
    if changes:
        for k, v in values.items():
            setattr(opp, k, v)
        opp.updated_by_id = getattr(actor, "id", None)
        await audit.record(db, actor=actor, action="opportunity.updated", entity_type="opportunity",
                           entity_id=opp.id, summary=f"Offer v{o.version} terms",
                           changes={**changes, "offer_id": str(o.id)},
                           ip_address=getattr(actor, "ip_address", None))
    return changes


# ----------------------------------------------------------------------------- mutations


async def create(db: AsyncSession, data: OfferCreate, actor: CurrentUser) -> Offer:
    opp = await _opportunity(db, data.opportunity_id)
    if opp.stage in ("closed", "dead"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Opportunity is {opp.stage}; offers cannot be created")
    model = await _approved_model(db, data.uw_model_id)
    model_opp = getattr(model, "opportunity_id", None)
    model_prop = getattr(model, "property_id", None)
    same_opp = model_opp is not None and model_opp == opp.id
    same_prop = model_prop is not None and model_prop == opp.property_id
    if not (same_opp or same_prop):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "The approved underwriting model belongs to a different opportunity / property")

    values = data.model_dump(exclude={"opportunity_id", "uw_model_id"}, exclude_none=True)
    values.setdefault("structure", "all_cash")
    values.setdefault("financing_contingency", False)
    values.setdefault("assignment_allowed", False)
    values.setdefault("tags", [])
    if values.get("expiration_at"):
        values["expiration_at"] = _aware(values["expiration_at"])
    now = utcnow()
    o = Offer(**values, opportunity_id=opp.id, property_id=opp.property_id or model_prop, uw_model_id=model.id,
              uw_model_version=getattr(model, "version", None), model_price=_model_price(model),
              model_outputs=to_jsonable(getattr(model, "outputs", None) or {}), version=1, origin="buyer",
              status="draft", is_latest=True, created_by_id=actor.id, updated_by_id=actor.id)
    o.id = uuid.uuid4()
    o.root_offer_id = o.id
    o.created_at = now
    await _apply_routing(db, o)
    db.add(o)
    await db.flush()
    await audit.record(db, actor=actor, action="offer.created", entity_type=ENTITY, entity_id=o.id,
                       summary=_label(o, opp.title),
                       changes={"uw_model_id": str(model.id), "terms": _terms(o), "deviation_pct": o.deviation_pct},
                       ip_address=actor.ip_address)
    await db.commit()
    return o


async def update(db: AsyncSession, o: Offer, data: OfferTerms, actor: CurrentUser) -> Offer:
    if o.origin != "buyer" or o.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Only draft versions can be edited. Create a counter version to change terms.")
    values = data.model_dump(exclude_unset=True)
    if "price" in values and values["price"] is None:
        values.pop("price")
    if "structure" in values and values["structure"] is None:
        values.pop("structure")
    for b in ("financing_contingency", "assignment_allowed"):
        if b in values and values[b] is None:
            values[b] = False
    if "tags" in values and values["tags"] is None:
        values["tags"] = []
    if values.get("expiration_at"):
        values["expiration_at"] = _aware(values["expiration_at"])
    changes = audit.diff(o, values)
    if not changes:
        return o
    for k, v in values.items():
        setattr(o, k, v)
    await _apply_routing(db, o)
    o.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="offer.updated", entity_type=ENTITY, entity_id=o.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return o


async def submit(db: AsyncSession, o: Offer, actor: CurrentUser) -> Offer:
    _require(o, ["draft"], "submit")
    if o.origin != "buyer":
        raise HTTPException(status.HTTP_409_CONFLICT, "Counterparty versions are not submitted for approval")
    # Re-validate the model is still approved at submission time.
    await _approved_model(db, o.uw_model_id)
    await _apply_routing(db, o)
    now = utcnow()
    o.submission_no += 1
    o.submitted_at, o.submitted_by_id, o.updated_by_id = now, actor.id, actor.id
    if o.approvals_required == 0:
        o.status, o.approved_at = "approved", now
        summary = "Submitted; within approval thresholds"
    else:
        o.status = "pending_approval"
        summary = f"Submitted for {o.approvals_required} approval(s): " + "; ".join(o.approval_reasons)
    await audit.record(db, actor=actor, action="offer.submitted", entity_type=ENTITY, entity_id=o.id,
                       summary=summary, changes={"status": {"from": "draft", "to": o.status},
                                                 "reasons": o.approval_reasons, "deviation_pct": o.deviation_pct},
                       ip_address=actor.ip_address)
    if o.status == "pending_approval":
        from app.modules.tasks.service import create_task

        opp = await _opportunity(db, o.opportunity_id)
        await create_task(
            db, title=f"Approve offer: {_label(o, opp.title)}", description="; ".join(o.approval_reasons),
            assignee_id=None, due_at=now + timedelta(days=1), task_type="approval", priority="high",
            related_type="offer", related_id=o.id, related_label=_label(o, opp.title), source="offers",
            idempotency_key=f"offer-approval:{o.id}:{o.submission_no}", actor_id=actor.id,
        )
    await db.commit()
    return o


async def decide(db: AsyncSession, o: Offer, data: ApprovalIn, actor: CurrentUser) -> Offer:
    _require(o, ["pending_approval"], "approve")
    if not actor.can_approve("offer", float(o.price)):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            f"Your offer approval limit does not cover ${float(o.price):,.0f}")
    dup = await db.scalar(select(func.count()).select_from(OfferApproval).where(
        OfferApproval.offer_id == o.id, OfferApproval.submission_no == o.submission_no,
        OfferApproval.approver_id == actor.id))
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, "You have already decided on this submission")
    if data.decision == "rejected" and not (data.note and data.note.strip()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A reason is required to reject an offer")
    now = utcnow()
    db.add(OfferApproval(offer_id=o.id, submission_no=o.submission_no, decision=data.decision,
                         approver_id=actor.id, approver_name=actor.full_name, decided_at=now, note=data.note,
                         price=o.price, deviation_pct=o.deviation_pct, reasons=list(o.approval_reasons or [])))
    await db.flush()
    before = o.status
    if data.decision == "rejected":
        o.status = "draft"
    elif await approvals_received(db, o) >= max(1, o.approvals_required):
        o.status, o.approved_at = "approved", now
    o.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"offer.approval_{data.decision}", entity_type=ENTITY,
                       entity_id=o.id, summary=data.note,
                       changes={"status": {"from": before, "to": o.status}, "submission_no": o.submission_no},
                       ip_address=actor.ip_address)
    await db.commit()
    return o


async def counter(db: AsyncSession, src: Offer, data: CounterIn, actor: CurrentUser) -> Offer:
    """New version from the latest one. Never edits the source beyond marking it countered."""
    if not src.is_latest:
        raise HTTPException(status.HTTP_409_CONFLICT, "Counters are created from the latest version only")
    if data.origin == "seller":
        if src.origin != "buyer" or src.status != "sent":
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "A counterparty counter can only be recorded against our sent version")
    else:
        if src.status in ("draft", "pending_approval", "approved"):
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "The latest version is still unsent; edit or withdraw it instead of countering")
        if src.status in ("accepted",):
            raise HTTPException(status.HTTP_409_CONFLICT, "This negotiation is already accepted")

    model_id = data.uw_model_id or src.uw_model_id
    model = await _approved_model(db, model_id)
    opp = await _opportunity(db, src.opportunity_id)
    now = utcnow()
    overrides = data.model_dump(exclude_unset=True,
                                exclude={"origin", "uw_model_id", "response_note", "responded_at"})
    values = {k: getattr(src, k) for k in COPY_FIELDS}
    values.update({k: v for k, v in overrides.items() if not (k in ("price", "structure") and v is None)})
    values["tags"] = values.get("tags") or []
    values["expiration_at"] = _aware(values.get("expiration_at"))
    for b in ("financing_contingency", "assignment_allowed"):
        values[b] = bool(values.get(b))
    responded_at = _aware(data.responded_at) or now

    new = Offer(**values, opportunity_id=src.opportunity_id, property_id=src.property_id, uw_model_id=model.id,
                uw_model_version=getattr(model, "version", None), model_price=_model_price(model),
                model_outputs=to_jsonable(getattr(model, "outputs", None) or {}),
                root_offer_id=src.root_offer_id or src.id, parent_offer_id=src.id, version=src.version + 1,
                is_latest=True, origin=data.origin, created_by_id=actor.id, updated_by_id=actor.id)
    await _apply_routing(db, new)
    if "expiration_at" not in overrides:
        new.expiration_at = None  # a previous version's expiration never carries into a new position
    if data.origin == "seller":
        # The counterparty's position is recorded verbatim and frozen; their expiration starts our clock.
        new.status = "countered"
        new.responded_at = responded_at
        new.response_due_at = new.expiration_at
        src.status, src.responded_at = "countered", responded_at
        src.response_note, src.response_recorded_by_id = data.response_note, actor.id
    else:
        new.status = "draft"
    src.is_latest = False
    src.updated_by_id = actor.id
    db.add(new)
    await db.flush()

    delta = [d.model_dump() for d in diff_terms(src, new)]
    await audit.record(db, actor=actor, action="offer.countered", entity_type=ENTITY, entity_id=new.id,
                       summary=f"v{src.version} → v{new.version} ({'counterparty' if data.origin == 'seller' else 'our'} counter)",
                       changes={"parent_offer_id": str(src.id), "delta": delta}, ip_address=actor.ip_address)
    if data.origin == "seller":
        await audit.record(db, actor=actor, action="offer.response_recorded", entity_type=ENTITY, entity_id=src.id,
                           summary="Countered", changes={"status": {"from": "sent", "to": "countered"}},
                           ip_address=actor.ip_address)
        await _upsert_date(db, src, due=src.response_due_at or now, owner_id=opp.owner_id, actor=actor,
                           status_="completed")
        if new.response_due_at:
            from app.modules.tasks.service import create_task

            await create_task(
                db, title=f"Respond to counter before it expires: {_label(new, opp.title)}",
                assignee_id=opp.owner_id, due_at=new.response_due_at, task_type="follow_up", priority="high",
                related_type="offer", related_id=new.id, related_label=_label(new, opp.title), source="offers",
                idempotency_key=f"offer-counter-follow-up:{new.id}", actor_id=actor.id,
            )
    await db.commit()
    return new


async def withdraw_or_delete_draft(db: AsyncSession, o: Offer, actor: CurrentUser) -> None:
    """Soft-delete an unsent first draft (no negotiation history exists yet)."""
    if o.status != "draft" or o.version != 1:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Only an unsent first draft can be deleted; withdraw the offer instead")
    o.deleted_at, o.updated_by_id = utcnow(), actor.id
    await audit.record(db, actor=actor, action="offer.deleted", entity_type=ENTITY, entity_id=o.id,
                       summary=f"v{o.version}", ip_address=actor.ip_address)
    await db.commit()


# ----------------------------------------------------------------------------- LOI


def _money(v: Any) -> str:
    return f"${float(v):,.0f}" if v is not None else "—"


def _days(v: Any, unit: str = "days") -> str:
    return f"{int(v)} {unit}" if v is not None else "—"


async def build_loi(db: AsyncSession, o: Offer) -> dict:
    """Structured letter-of-intent payload generated from the version's approved terms."""
    from app.modules.properties.models import Property

    opp = await _opportunity(db, o.opportunity_id)
    p = await db.get(Property, o.property_id) if o.property_id else None
    approvals = list(await db.scalars(select(OfferApproval).where(
        OfferApproval.offer_id == o.id, OfferApproval.submission_no == o.submission_no,
        OfferApproval.decision == "approved").order_by(OfferApproval.decided_at)))
    ext = "None"
    if o.extension_count:
        ext = (f"{o.extension_count} extension(s) of {_days(o.extension_days)} each"
               + (f", at {_money(o.extension_cost)} per extension" if o.extension_cost else ""))
    em = _money(o.earnest_money)
    if o.earnest_money_hard_days is not None:
        em += f", becoming non-refundable {_days(o.earnest_money_hard_days)} after the effective date"
    fin = (f"Buyer's obligation is contingent on obtaining financing within {_days(o.financing_days)}."
           if o.financing_contingency else "No financing contingency.")
    paragraphs = [
        {"key": "property", "heading": "Property",
         "text": ", ".join(x for x in [p.name if p else None, p.address_line if p else None,
                                        p.city if p else None, p.state if p else None] if x) or opp.title},
        {"key": "price", "heading": "Purchase price", "text": _money(o.price)},
        {"key": "structure", "heading": "Structure", "text": (o.structure or "").replace("_", " ").capitalize()},
        {"key": "earnest_money", "heading": "Earnest money", "text": em},
        {"key": "feasibility", "heading": "Feasibility period", "text": _days(o.feasibility_days)},
        {"key": "closing", "heading": "Closing", "text": f"{_days(o.closing_days)} after the end of the feasibility period"
         if o.closing_days is not None else "—"},
        {"key": "extensions", "heading": "Extensions", "text": ext},
        {"key": "financing", "heading": "Financing", "text": fin},
        {"key": "title_survey", "heading": "Title and survey",
         "text": " ".join(x for x in [f"Review period of {_days(o.title_survey_days)}."
                                      if o.title_survey_days is not None else None, o.title_survey_terms] if x) or "—"},
        {"key": "assignment", "heading": "Assignment",
         "text": ("Buyer may assign to an affiliate." if o.assignment_allowed else "Not assignable without consent.")
         + (f" {o.assignment_terms}" if o.assignment_terms else "")},
        {"key": "access", "heading": "Access", "text": o.access_terms or "—"},
        {"key": "exclusivity", "heading": "Exclusivity",
         "text": f"Seller will not market the property or negotiate with others for {_days(o.exclusivity_days)}."
         if o.exclusivity_days else "—"},
        {"key": "expiration", "heading": "Expiration",
         "text": f"This letter expires at {o.expiration_at.strftime('%B %d, %Y %I:%M %p UTC')}."
         if o.expiration_at else "—"},
    ]
    if o.other_terms:
        paragraphs.append({"key": "other", "heading": "Other terms", "text": o.other_terms})
    paragraphs.append({"key": "non_binding", "heading": "Non-binding",
                       "text": "This letter is a non-binding expression of intent. Except for exclusivity and "
                               "confidentiality, no party is bound until a definitive purchase agreement is executed."})
    return to_jsonable({
        "offer_id": o.id, "root_offer_id": o.root_offer_id, "version": o.version, "status": o.status,
        "generated_at": utcnow(), "opportunity_title": opp.title,
        "buyer_entity": o.buyer_entity, "seller_name": o.seller_name,
        "property": {"id": p.id, "name": p.name, "address_line": p.address_line, "city": p.city,
                     "state": p.state, "postal_code": p.postal_code} if p else None,
        "terms": _terms(o), "paragraphs": paragraphs,
        "underwriting": {"uw_model_id": o.uw_model_id, "version": o.uw_model_version,
                         "model_price": o.model_price, "deviation_pct": o.deviation_pct},
        "approvals": [{"approver_name": a.approver_name, "decided_at": a.decided_at} for a in approvals],
    })


async def loi(db: AsyncSession, o: Offer) -> dict:
    if o.loi_payload:
        return o.loi_payload
    if o.origin != "buyer" or o.status in ("draft", "pending_approval"):
        raise HTTPException(status.HTTP_409_CONFLICT, "An LOI is generated only from approved terms")
    return await build_loi(db, o)


# ----------------------------------------------------------------------------- send / respond / expire


async def send(db: AsyncSession, o: Offer, data: SendIn, actor: CurrentUser) -> Offer:
    _require(o, ["approved"], "send")
    opp = await _opportunity(db, o.opportunity_id)
    s = await get_settings(db)
    now = utcnow()
    due = _aware(data.response_due_at) or o.expiration_at or now + timedelta(days=s.default_response_days)
    if due <= now:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Response due time must be in the future")
    o.status, o.sent_at, o.sent_by_id, o.updated_by_id = "sent", now, actor.id, actor.id
    o.sent_to, o.sent_via, o.response_due_at = data.sent_to, data.sent_via, due
    o.loi_payload = await build_loi(db, o)  # frozen exactly as sent

    o.critical_date_id = await _upsert_date(db, o, due=due, owner_id=opp.owner_id, actor=actor)
    from app.modules.tasks.service import create_task

    follow_at = max(now, due - timedelta(hours=24))
    task = await create_task(
        db, title=f"Follow up on offer response: {_label(o, opp.title)}",
        description=f"Response due {due.isoformat()}" + (f" from {data.sent_to}" if data.sent_to else ""),
        assignee_id=opp.owner_id or actor.id, due_at=follow_at, task_type="follow_up", priority="normal",
        related_type="offer", related_id=o.id, related_label=_label(o, opp.title), source="offers",
        idempotency_key=f"offer-follow-up:{o.id}", actor_id=actor.id,
    )
    o.follow_up_task_id = task.id
    await _set_opportunity_offer_fields(db, opp, o, actor)
    await audit.record(db, actor=actor, action="offer.sent", entity_type=ENTITY, entity_id=o.id,
                       summary=f"Sent to {data.sent_to or 'counterparty'}" + (f" via {data.sent_via}" if data.sent_via else ""),
                       changes={"status": {"from": "approved", "to": "sent"}, "response_due_at": due,
                                "note": data.note}, ip_address=actor.ip_address)
    await events.emit(db, "offer.sent", offer_id=o.id, opportunity_id=o.opportunity_id, property_id=o.property_id,
                      response_due_at=due, actor=actor)
    await db.commit()
    return o


async def _expire(db: AsyncSession, o: Offer, actor: CurrentUser | None, now: datetime) -> None:
    from app.modules.tasks.service import create_task, raise_alert

    opp = await _opportunity(db, o.opportunity_id)
    before = o.status
    o.status, o.expired_at, o.updated_by_id = "expired", now, getattr(actor, "id", None)
    label = _label(o, opp.title)
    task = await create_task(
        db, title=f"Offer expired without response — decide next step: {label}",
        description="The response clock ran out. Re-engage, counter, withdraw, or record the outcome "
                    "(and the winning price if discoverable).",
        assignee_id=opp.owner_id or o.sent_by_id, due_at=now + timedelta(days=1), task_type="follow_up",
        priority="urgent", related_type="offer", related_id=o.id, related_label=label, source="offers",
        idempotency_key=f"offer-expired:{o.id}", actor_id=getattr(actor, "id", None),
    )
    o.escalation_task_id = task.id
    await raise_alert(
        db, title=f"Offer expired: {label}", reason="Response due time passed without a recorded response",
        severity="high", owner_id=opp.owner_id or o.sent_by_id, related_type="offer", related_id=o.id,
        related_label=label, rule_key="offers.expired", idempotency_key=f"offer-expired-alert:{o.id}",
    )
    if o.response_due_at:
        await _upsert_date(db, o, due=o.response_due_at, owner_id=opp.owner_id, actor=actor, status_="missed")
    await audit.record(db, actor=actor, action="offer.expired", entity_type=ENTITY, entity_id=o.id,
                       summary=label, changes={"status": {"from": before, "to": "expired"}},
                       ip_address=getattr(actor, "ip_address", None))
    await events.emit(db, "offer.expired", offer_id=o.id, opportunity_id=o.opportunity_id,
                      property_id=o.property_id, actor=actor)


async def expire_due(db: AsyncSession, actor: CurrentUser | None = None) -> list[uuid.UUID]:
    """Expire every awaiting version whose response clock has run out. Commits only when something expired."""
    now = utcnow()
    rows = list(await db.scalars(select(Offer).where(
        Offer.deleted_at.is_(None), Offer.is_latest.is_(True), Offer.status.in_(["sent", "countered"]),
        Offer.response_due_at.is_not(None), Offer.response_due_at < now,
    ).with_for_update(skip_locked=True)))
    for o in rows:
        await _expire(db, o, actor, now)
    if rows:
        await db.commit()
    return [o.id for o in rows]


async def _advance_opportunity(db: AsyncSession, o: Offer, actor: CurrentUser) -> None:
    """Accepted offer moves the opportunity toward under contract — only through the pipeline's gated move."""
    from app.modules.pipeline import service as pipeline
    from app.modules.pipeline.schemas import MoveIn
    from app.modules.tasks.service import create_task

    opp = await _opportunity(db, o.opportunity_id)
    # A counterparty counter we accepted has no "sent" time of its own: the chain's response time stands in.
    await _set_opportunity_offer_fields(db, opp, o, actor, sent_at=o.sent_at or o.responded_at,
                                        due_at=o.response_due_at or o.responded_at)
    targets: list[str] = []
    if opp.stage in _PRE_OFFER_STAGES:
        targets.append("offer")
    if opp.stage in (*_PRE_OFFER_STAGES, "offer"):
        targets.append("under_contract")
    if not targets:
        await db.commit()
        return
    for target in targets:
        if target == "under_contract":
            unmet = pipeline.unmet_of(await pipeline.check_gate(db, opp, "under_contract"))
            if unmet:
                await create_task(
                    db, title=f"Execute contract to move to under contract: {opp.title}",
                    description="Offer accepted. Record the contract executed date to pass the under-contract gate.",
                    assignee_id=opp.owner_id or actor.id, due_at=utcnow() + timedelta(days=3),
                    task_type="follow_up", priority="high", related_type="opportunity", related_id=opp.id,
                    related_label=opp.title, source="offers",
                    idempotency_key=f"offer-accepted-contract:{o.id}", actor_id=actor.id,
                )
                await db.commit()
                return
        try:
            opp = await pipeline.move(db, opp, MoveIn(to_stage=target), actor)  # commits
        except HTTPException as e:
            await audit.record(db, actor=actor, action="offer.pipeline_move_blocked", entity_type=ENTITY,
                               entity_id=o.id, summary=f"Could not move opportunity to {target}",
                               changes={"detail": to_jsonable(e.detail)}, ip_address=actor.ip_address)
            await db.commit()
            return


async def respond(db: AsyncSession, o: Offer, data: RespondIn, actor: CurrentUser) -> Offer:
    if data.outcome == "countered":
        if not data.counter_terms:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Counter terms are required")
        body = CounterIn(**data.counter_terms.model_dump(exclude_unset=True), origin="seller",
                         response_note=data.note, responded_at=data.responded_at)
        return await counter(db, o, body, actor)

    if not o.is_latest:
        raise HTTPException(status.HTTP_409_CONFLICT, "Outcomes are recorded on the latest version")
    now = utcnow()
    before = o.status
    opp = await _opportunity(db, o.opportunity_id)

    if data.outcome == "accepted":
        if o.origin == "buyer":
            _require(o, ["sent"], "accept")
        else:
            # Accepting the counterparty's counter commits us to their terms: needs a named approval.
            _require(o, ["countered"], "accept")
            if not actor.can("offers", "approve") or not actor.can_approve("offer", float(o.price)):
                raise HTTPException(status.HTTP_403_FORBIDDEN,
                                    "Accepting a counter requires offer approval permission within your limit")
            o.submission_no += 1
            db.add(OfferApproval(offer_id=o.id, submission_no=o.submission_no, decision="approved",
                                 approver_id=actor.id, approver_name=actor.full_name, decided_at=now,
                                 note=data.note or "Accepted counterparty counter", price=o.price,
                                 deviation_pct=o.deviation_pct, reasons=list(o.approval_reasons or [])))
            o.approved_at = now
    elif data.outcome == "rejected":
        _require(o, ["sent", "countered"], "reject")
    elif data.outcome == "withdrawn":
        _require(o, ["draft", "pending_approval", "approved", "sent", "countered"], "withdraw")
    elif data.outcome == "expired":
        _require(o, ["sent", "countered"], "expire")
        await _expire(db, o, actor, now)
        await _record_winning(o, data, actor, now)
        await db.commit()
        return o

    o.status = data.outcome
    o.responded_at = _aware(data.responded_at) or now
    o.response_note, o.response_recorded_by_id, o.updated_by_id = data.note, actor.id, actor.id
    await _record_winning(o, data, actor, now)
    if o.response_due_at and before in ("sent", "countered"):
        await _upsert_date(db, o, due=o.response_due_at, owner_id=opp.owner_id, actor=actor, status_="completed")
    await audit.record(db, actor=actor, action=f"offer.{data.outcome}", entity_type=ENTITY, entity_id=o.id,
                       summary=data.note or _label(o, opp.title),
                       changes={"status": {"from": before, "to": o.status},
                                **({"winning_price": o.winning_price} if o.winning_price else {})},
                       ip_address=actor.ip_address)
    if data.outcome == "accepted":
        await events.emit(db, "offer.accepted", offer_id=o.id, opportunity_id=o.opportunity_id,
                          property_id=o.property_id, uw_model_id=o.uw_model_id, price=float(o.price), actor=actor)
        await _advance_opportunity(db, o, actor)  # commits
        return o
    await db.commit()
    return o


async def _record_winning(o: Offer, data: RespondIn, actor: CurrentUser, now: datetime) -> None:
    if data.winning_price is None:
        return
    if data.outcome not in ("rejected", "expired", "withdrawn"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Winning price applies only to lost offers")
    o.winning_price, o.winning_buyer = data.winning_price, data.winning_buyer
    o.winning_price_source = data.winning_price_source or "Recorded with outcome"
    o.winning_price_recorded_at, o.winning_price_recorded_by_id = now, actor.id


async def record_winning_price(db: AsyncSession, o: Offer, data: WinningPriceIn, actor: CurrentUser) -> Offer:
    if o.status not in ("rejected", "expired", "withdrawn"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Winning price can only be captured on a lost offer")
    changes = audit.diff(o, {"winning_price": data.winning_price, "winning_buyer": data.winning_buyer,
                             "winning_price_source": data.winning_price_source})
    o.winning_price, o.winning_buyer, o.winning_price_source = (data.winning_price, data.winning_buyer,
                                                                data.winning_price_source)
    o.winning_price_recorded_at, o.winning_price_recorded_by_id, o.updated_by_id = utcnow(), actor.id, actor.id
    await audit.record(db, actor=actor, action="offer.winning_price_recorded", entity_type=ENTITY, entity_id=o.id,
                       changes=changes, summary=f"${data.winning_price:,.0f} ({data.winning_price_source})",
                       ip_address=actor.ip_address)
    await db.commit()
    return o


# ----------------------------------------------------------------------------- delta


def diff_terms(a: Offer, b: Offer) -> list[TermDelta]:
    out = []
    for field, label in TERM_FIELDS.items():
        x, y = getattr(a, field), getattr(b, field)
        if x == y:
            continue
        d = TermDelta(field=field, label=label, from_value=to_jsonable(x), to_value=to_jsonable(y))
        if field in NUMERIC_TERMS and x is not None and y is not None:
            d.change = round(float(y) - float(x), 2)
            d.change_pct = round((float(y) - float(x)) / float(x) * 100, 2) if float(x) else None
        out.append(d)
    return out


async def delta(db: AsyncSession, o: Offer, against_id: uuid.UUID | None) -> DeltaOut:
    if against_id is None:
        if not o.parent_offer_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "This is the first version; choose a version to compare")
        against_id = o.parent_offer_id
    other = await get(db, against_id)
    if (other.root_offer_id or other.id) != (o.root_offer_id or o.id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Versions belong to different negotiations")
    a, b = (other, o) if other.version <= o.version else (o, other)
    changes = diff_terms(a, b)
    changed = {c.field for c in changes}
    return DeltaOut(from_offer_id=a.id, from_version=a.version, to_offer_id=b.id, to_version=b.version,
                    changes=changes, unchanged=[f for f in TERM_FIELDS if f not in changed])


async def chain(db: AsyncSession, o: Offer) -> list[Offer]:
    return await _chain(db, o)


# ----------------------------------------------------------------------------- handlers support


async def reassign_user(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None) -> None:
    if reassign_to_id:
        await db.execute(update(Offer).where(Offer.sent_by_id == user_id, Offer.status.in_(["sent", "countered"]))
                         .values(sent_by_id=reassign_to_id))
