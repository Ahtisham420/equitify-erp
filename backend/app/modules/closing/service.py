"""Closing & post-close handoff (spec 17).

A closing cannot complete until every blocking checklist item is satisfied and the current wire instructions
passed an independent callback (phone number sourced separately from the instructions). Completion writes an
immutable transaction snapshot, converts the opportunity into an owned Asset (retryable if the assets module is
unavailable), carries acquisition knowledge into an operations handoff package, turns open DD items into asset
tasks and schedules the 90-day post-close audit whose variances feed back to acquisitions.
"""
import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, case, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.database import Base
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.closing.models import (
    CHECKLIST_TEMPLATE,
    HANDOFF_SECTIONS,
    SATISFIED_STATUSES,
    Closing,
    ClosingChecklistItem,
    ClosingSnapshot,
    HandoffPackage,
    WireVerification,
)
from app.modules.closing.schemas import (
    AuditCompleteIn,
    AuditMetric,
    Blocker,
    CallbackIn,
    ChecklistItemIn,
    ChecklistItemOut,
    ChecklistItemUpdate,
    ClosingCreate,
    ClosingListItem,
    ClosingOut,
    ClosingUpdate,
    CompleteIn,
    HandoffUpdate,
    PostCloseAuditOut,
    SourcesUsesIn,
    WireIn,
    WireOut,
)

ENTITY = "closing"
CLOSED_DD_STATUSES = ["done", "completed", "complete", "closed", "resolved", "waived", "cleared", "cancelled",
                      "not_applicable", "n_a"]
DEBT_KINDS = ("senior_debt", "mezzanine", "seller_financing")


# ----------------------------------------------------------------------------- lookups


async def get(db: AsyncSession, closing_id: uuid.UUID) -> Closing:
    c = await db.get(Closing, closing_id)
    if not c or c.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Closing not found")
    return c


async def get_item(db: AsyncSession, item_id: uuid.UUID) -> ClosingChecklistItem:
    i = await db.get(ClosingChecklistItem, item_id)
    if not i or i.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Checklist item not found")
    return i


async def get_wire(db: AsyncSession, wire_id: uuid.UUID) -> WireVerification:
    w = await db.get(WireVerification, wire_id)
    if not w or w.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Wire instructions not found")
    return w


async def _opportunity(db: AsyncSession, opportunity_id: uuid.UUID):
    from app.modules.pipeline.models import Opportunity

    opp = await db.get(Opportunity, opportunity_id)
    if not opp or opp.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Opportunity not found")
    return opp


async def _accepted_offer(db: AsyncSession, opportunity_id: uuid.UUID):
    try:
        from app.modules.offers.models import Offer
    except ImportError:
        return None
    return await db.scalar(select(Offer).where(
        Offer.opportunity_id == opportunity_id, Offer.status == "accepted", Offer.deleted_at.is_(None)
    ).order_by(Offer.responded_at.desc().nulls_last()).limit(1))


def _table(name: str):
    return Base.metadata.tables.get(name)


async def _uw_model_row(db: AsyncSession, model_id: uuid.UUID | None) -> dict | None:
    """Approved underwriting (shared `uw_models` contract), read without depending on the module's classes."""
    t = _table("uw_models")
    if t is None or model_id is None:
        return None
    row = (await db.execute(select(t).where(t.c.id == model_id))).mappings().first()
    return dict(row) if row else None


def _require_open(c: Closing) -> None:
    if c.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Closing is {c.status}; the final transaction record cannot be changed")


def _check_actor(actor: CurrentUser | None) -> uuid.UUID | None:
    return getattr(actor, "id", None)


# ----------------------------------------------------------------------------- creation


async def ensure_closing(db: AsyncSession, opportunity_id: uuid.UUID, actor: CurrentUser | None, *,
                         scheduled_closing_on: date | None = None, coordinator_id: uuid.UUID | None = None,
                         manager_id: uuid.UUID | None = None) -> tuple[Closing, bool]:
    """Idempotent per opportunity. Seeds the checklist from the template. Does not commit."""
    existing = await db.scalar(select(Closing).where(Closing.opportunity_id == opportunity_id,
                                                     Closing.deleted_at.is_(None)))
    if existing:
        return existing, False
    opp = await _opportunity(db, opportunity_id)
    offer = await _accepted_offer(db, opportunity_id)
    price = float(offer.price) if offer else (opp.closed_price or opp.offer_price)
    actor_id = _check_actor(actor)
    c = Closing(
        opportunity_id=opp.id, property_id=opp.property_id, offer_id=offer.id if offer else None,
        uw_model_id=offer.uw_model_id if offer else None, status="open",
        coordinator_id=coordinator_id or opp.owner_id, manager_id=manager_id,
        scheduled_closing_on=scheduled_closing_on or opp.closing_date, purchase_price=price,
        sources=[], uses=([{"label": "Purchase price", "kind": "purchase_price", "amount": float(price),
                            "capitalized": True}] if price else []),
        total_sources=0.0, total_uses=float(price) if price else None, capital_structure={},
        created_by_id=actor_id, updated_by_id=actor_id,
    )
    db.add(c)
    await db.flush()
    for n, t in enumerate(CHECKLIST_TEMPLATE):
        db.add(ClosingChecklistItem(
            closing_id=c.id, template_key=t["key"], category=t["category"], title=t["title"],
            is_blocking=t["blocking"], status="open", owner_id=c.coordinator_id,
            due_on=c.scheduled_closing_on if t["blocking"] else None, sort_order=n,
            created_by_id=actor_id, updated_by_id=actor_id,
        ))
    await audit.record(db, actor=actor, action="closing.created", entity_type=ENTITY, entity_id=c.id,
                       summary=opp.title, changes={"opportunity_id": str(opp.id),
                                                   "offer_id": str(offer.id) if offer else None},
                       ip_address=getattr(actor, "ip_address", None))
    await db.flush()
    return c, True


async def create(db: AsyncSession, data: ClosingCreate, actor: CurrentUser) -> Closing:
    opp = await _opportunity(db, data.opportunity_id)
    if opp.stage in ("dead", "nurture"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Opportunity is {opp.stage}")
    c, created = await ensure_closing(db, opp.id, actor, scheduled_closing_on=data.scheduled_closing_on,
                                      coordinator_id=data.coordinator_id, manager_id=data.manager_id)
    if not created:
        raise HTTPException(status.HTTP_409_CONFLICT, {"message": "This opportunity already has a closing",
                                                       "closing_id": str(c.id)})
    await db.commit()
    return c


async def apply_template(db: AsyncSession, c: Closing, actor: CurrentUser) -> int:
    _require_open(c)
    have = set(await db.scalars(select(ClosingChecklistItem.template_key).where(
        ClosingChecklistItem.closing_id == c.id, ClosingChecklistItem.deleted_at.is_(None))))
    added = 0
    for n, t in enumerate(CHECKLIST_TEMPLATE):
        if t["key"] in have:
            continue
        db.add(ClosingChecklistItem(
            closing_id=c.id, template_key=t["key"], category=t["category"], title=t["title"],
            is_blocking=t["blocking"], status="open", owner_id=c.coordinator_id,
            due_on=c.scheduled_closing_on if t["blocking"] else None, sort_order=n,
            created_by_id=actor.id, updated_by_id=actor.id,
        ))
        added += 1
    if added:
        await audit.record(db, actor=actor, action="closing.template_applied", entity_type=ENTITY, entity_id=c.id,
                           summary=f"{added} checklist items added", ip_address=actor.ip_address)
    await db.commit()
    return added


async def update(db: AsyncSession, c: Closing, data: ClosingUpdate, actor: CurrentUser) -> Closing:
    values = data.model_dump(exclude_unset=True)
    if c.status != "open":
        # After completion only the narrative carry-forward fields may be annotated; economics are frozen.
        locked = set(values) - {"notes"}
        if locked:
            raise HTTPException(status.HTTP_409_CONFLICT, "Completed closings are frozen; only notes can change")
    changes = audit.diff(c, values)
    if not changes:
        return c
    for k, v in values.items():
        setattr(c, k, v)
    c.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="closing.updated", entity_type=ENTITY, entity_id=c.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return c


# ----------------------------------------------------------------------------- checklist


async def items(db: AsyncSession, c: Closing) -> list[ChecklistItemOut]:
    rows = list(await db.scalars(select(ClosingChecklistItem).where(
        ClosingChecklistItem.closing_id == c.id, ClosingChecklistItem.deleted_at.is_(None)
    ).order_by(ClosingChecklistItem.sort_order, ClosingChecklistItem.created_at)))
    names = await user_names(db, {i.owner_id for i in rows})
    today = date.today()
    out = []
    for i in rows:
        o = ChecklistItemOut.model_validate(i)
        o.owner_name = names.get(i.owner_id) if i.owner_id else None
        o.overdue = bool(i.due_on and i.due_on < today and i.status not in SATISFIED_STATUSES)
        out.append(o)
    return out


async def add_item(db: AsyncSession, c: Closing, data: ChecklistItemIn, actor: CurrentUser) -> ClosingChecklistItem:
    _require_open(c)
    n = await db.scalar(select(func.coalesce(func.max(ClosingChecklistItem.sort_order), 0))
                        .where(ClosingChecklistItem.closing_id == c.id))
    i = ClosingChecklistItem(**data.model_dump(), closing_id=c.id, status="open", sort_order=int(n or 0) + 1,
                             created_by_id=actor.id, updated_by_id=actor.id)
    db.add(i)
    await db.flush()
    await audit.record(db, actor=actor, action="closing.item_added", entity_type=ENTITY, entity_id=c.id,
                       summary=i.title, changes={"item_id": str(i.id), "is_blocking": i.is_blocking},
                       ip_address=actor.ip_address)
    await db.commit()
    return i


async def update_item(db: AsyncSession, i: ClosingChecklistItem, data: ChecklistItemUpdate,
                      actor: CurrentUser) -> ClosingChecklistItem:
    c = await get(db, i.closing_id)
    _require_open(c)
    values = data.model_dump(exclude_unset=True)
    if "title" in values and not values["title"]:
        values.pop("title")
    if "category" in values and values["category"] is None:
        values.pop("category")
    if "is_blocking" in values and values["is_blocking"] is None:
        values.pop("is_blocking")
    if "status" in values and values["status"] is None:
        values.pop("status")
    is_blocking = values.get("is_blocking", i.is_blocking)
    new_status = values.get("status", i.status)

    # Blocking control is enforced here, not in the UI.
    if i.is_blocking and values.get("is_blocking") is False and not actor.can("closing", "approve"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Removing the blocking flag requires closing approval")
    if new_status in ("waived", "not_applicable") and new_status != i.status:
        reason = values.get("waived_reason") or i.waived_reason
        if not (reason and reason.strip()):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "A reason is required to waive or mark an item not applicable")
        if is_blocking and not actor.can("closing", "approve"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Waiving a blocking item requires closing approval")

    changes = audit.diff(i, values)
    if not changes:
        return i
    for k, v in values.items():
        setattr(i, k, v)
    if "status" in changes:
        if new_status in SATISFIED_STATUSES:
            i.completed_at, i.completed_by_id = utcnow(), actor.id
        else:
            i.completed_at = i.completed_by_id = None
    i.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="closing.item_updated", entity_type=ENTITY, entity_id=c.id,
                       summary=i.title, changes={**changes, "item_id": str(i.id)}, ip_address=actor.ip_address)
    await db.commit()
    return i


async def delete_item(db: AsyncSession, i: ClosingChecklistItem, actor: CurrentUser) -> None:
    c = await get(db, i.closing_id)
    _require_open(c)
    if i.is_blocking and not actor.can("closing", "approve"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Removing a blocking item requires closing approval")
    i.deleted_at, i.updated_by_id = utcnow(), actor.id
    await audit.record(db, actor=actor, action="closing.item_removed", entity_type=ENTITY, entity_id=c.id,
                       summary=i.title, changes={"item_id": str(i.id), "is_blocking": i.is_blocking},
                       ip_address=actor.ip_address)
    await db.commit()


# ----------------------------------------------------------------------------- wire verification


def _norm_source(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _digits(s: str | None) -> str:
    return re.sub(r"\D", "", s or "")[-10:]


def mask(account: str) -> str:
    return "•" * max(0, min(len(account) - 4, 8)) + account[-4:]


def wire_out(w: WireVerification, actor: CurrentUser) -> WireOut:
    out = WireOut.model_validate(w)
    if not actor.can("closing", "view_sensitive"):
        out.account_number = mask(w.account_number)
    return out


async def current_wire(db: AsyncSession, closing_id: uuid.UUID) -> WireVerification | None:
    return await db.scalar(select(WireVerification).where(
        WireVerification.closing_id == closing_id, WireVerification.is_current.is_(True),
        WireVerification.deleted_at.is_(None)).order_by(WireVerification.created_at.desc()).limit(1))


async def add_wire(db: AsyncSession, c: Closing, data: WireIn, actor: CurrentUser) -> WireVerification:
    """New instructions always supersede the previous set and must be verified again from scratch."""
    _require_open(c)
    previous = await current_wire(db, c.id)
    if previous:
        previous.is_current = False
        if previous.result in ("pending", "passed"):
            previous.result = "superseded"
        previous.updated_by_id = actor.id
    received_at = data.received_at or utcnow()
    if received_at.tzinfo is None:
        received_at = received_at.replace(tzinfo=timezone.utc)
    w = WireVerification(**data.model_dump(exclude={"received_at"}), received_at=received_at, closing_id=c.id,
                         is_current=True, result="pending", created_by_id=actor.id, updated_by_id=actor.id)
    db.add(w)
    await db.flush()
    await audit.record(db, actor=actor, action="closing.wire_instructions_recorded", entity_type=ENTITY,
                       entity_id=c.id, summary=f"{data.bank_name} ····{data.account_number[-4:]}",
                       changes={"wire_id": str(w.id), "instruction_source": data.instruction_source,
                                "superseded": str(previous.id) if previous else None},
                       ip_address=actor.ip_address)
    if previous is not None:
        from app.modules.tasks.service import raise_alert

        await raise_alert(
            db, title="Wire instructions changed", severity="high", owner_id=c.coordinator_id,
            reason="New wire instructions replaced a previous set. Changed instructions are a common fraud "
                   "pattern: verify by independent callback before funding.",
            related_type="closing", related_id=c.id, related_label="Closing wire", rule_key="closing.wire_changed",
            idempotency_key=f"closing-wire-changed:{w.id}",
        )
    await db.commit()
    return w


async def record_callback(db: AsyncSession, w: WireVerification, data: CallbackIn, actor: CurrentUser) -> WireVerification:
    c = await get(db, w.closing_id)
    _require_open(c)
    if not w.is_current:
        raise HTTPException(status.HTTP_409_CONFLICT, "These instructions were superseded; verify the current set")
    if w.result != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Callback already recorded ({w.result}). Record new instructions to verify again.")
    src_a, src_b = _norm_source(data.callback_phone_source), _norm_source(w.instruction_source)
    if not src_a or src_a == src_b or src_a in src_b or src_b in src_a:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "The callback number must come from a source independent of the wire instructions")
    if w.instruction_contact_phone and _digits(data.callback_phone) == _digits(w.instruction_contact_phone):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "The callback number must not be the phone number provided with the wire instructions")
    verified_at = data.verified_at or utcnow()
    if verified_at.tzinfo is None:
        verified_at = verified_at.replace(tzinfo=timezone.utc)
    w.callback_phone, w.callback_phone_source = data.callback_phone, data.callback_phone_source
    w.callback_contact_name, w.result, w.result_notes = data.callback_contact_name, data.result, data.result_notes
    w.verified_by_id, w.verified_by_name, w.verified_at = actor.id, actor.full_name, verified_at
    w.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"closing.wire_callback_{data.result}", entity_type=ENTITY,
                       entity_id=c.id, summary=f"Callback to {data.callback_contact_name} ({data.callback_phone_source})",
                       changes={"wire_id": str(w.id), "result": data.result, "callback_phone_source":
                                data.callback_phone_source}, ip_address=actor.ip_address)
    if data.result == "failed":
        from app.modules.tasks.service import raise_alert

        await raise_alert(
            db, title="Wire verification failed — do not send funds", severity="critical",
            owner_id=c.coordinator_id,
            reason=data.result_notes or "Independent callback did not confirm the wire instructions",
            related_type="closing", related_id=c.id, related_label="Closing wire", rule_key="closing.wire_failed",
            idempotency_key=f"closing-wire-failed:{w.id}",
        )
    await db.commit()
    return w


# ----------------------------------------------------------------------------- sources & uses


def capital_structure(sources: list[dict], purchase_price: float | None) -> dict:
    by_kind: dict[str, float] = {}
    for s in sources:
        by_kind[s["kind"]] = by_kind.get(s["kind"], 0.0) + float(s["amount"])
    debt = sum(v for k, v in by_kind.items() if k in DEBT_KINDS)
    equity = by_kind.get("equity", 0.0)
    total = sum(by_kind.values())
    return {
        "equity": round(equity, 2), "debt": round(debt, 2), "total": round(total, 2), "by_kind": by_kind,
        "ltv_pct": round(debt / purchase_price * 100, 2) if purchase_price else None,
        "equity_pct": round(equity / total * 100, 2) if total else None,
    }


async def set_sources_uses(db: AsyncSession, c: Closing, data: SourcesUsesIn, actor: CurrentUser) -> Closing:
    _require_open(c)
    sources = [s.model_dump() for s in data.sources]
    uses = [u.model_dump() for u in data.uses]
    pp = sum(u["amount"] for u in uses if u["kind"] == "purchase_price")
    values = {
        "sources": sources, "uses": uses,
        "total_sources": round(sum(s["amount"] for s in sources), 2),
        "total_uses": round(sum(u["amount"] for u in uses), 2),
        "basis": round(sum(u["amount"] for u in uses if u["capitalized"]), 2),
        "purchase_price": pp if pp else c.purchase_price,
    }
    values["capital_structure"] = capital_structure(sources, values["purchase_price"])
    changes = audit.diff(c, values)
    if not changes:
        return c
    for k, v in values.items():
        setattr(c, k, v)
    c.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="closing.sources_uses_updated", entity_type=ENTITY, entity_id=c.id,
                       summary=f"Sources ${values['total_sources']:,.0f} / uses ${values['total_uses']:,.0f}",
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return c


# ----------------------------------------------------------------------------- readiness


async def blockers(db: AsyncSession, c: Closing) -> list[Blocker]:
    out: list[Blocker] = []
    if c.status != "open":
        return [Blocker(key="status", label=f"Closing is {c.status}")]
    open_blocking = list(await db.scalars(select(ClosingChecklistItem).where(
        ClosingChecklistItem.closing_id == c.id, ClosingChecklistItem.deleted_at.is_(None),
        ClosingChecklistItem.is_blocking.is_(True), ClosingChecklistItem.status.notin_(SATISFIED_STATUSES),
    ).order_by(ClosingChecklistItem.sort_order)))
    for i in open_blocking:
        out.append(Blocker(key=f"item:{i.id}", label=i.title, detail=i.category.replace("_", " ")))
    w = await current_wire(db, c.id)
    if w is None:
        out.append(Blocker(key="wire", label="Wire instructions not recorded"))
    elif w.result != "passed":
        out.append(Blocker(key="wire", label="Wire callback verification not passed", detail=w.result))
    if not c.purchase_price:
        out.append(Blocker(key="price", label="Purchase price not set"))
    if not c.uses or not c.sources:
        out.append(Blocker(key="sources_uses", label="Final sources and uses not entered"))
    elif abs(float(c.total_sources or 0) - float(c.total_uses or 0)) > 0.5:
        out.append(Blocker(key="sources_uses", label="Sources and uses do not balance",
                           detail=f"${float(c.total_sources or 0):,.0f} vs ${float(c.total_uses or 0):,.0f}"))
    return out


# ----------------------------------------------------------------------------- list / out


@dataclass
class ClosingFilters:
    q: str | None = None
    status: list[str] | None = None
    coordinator_id: list[uuid.UUID] | None = None
    manager_id: list[uuid.UUID] | None = None
    opportunity_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    asset_pending: bool | None = None
    scheduled_from: date | None = None
    scheduled_to: date | None = None


def build_query(f: ClosingFilters, *, skip: set[str] = frozenset()) -> Select:
    from app.modules.pipeline.models import Opportunity
    from app.modules.properties.models import Property

    stmt = (select(Closing).join(Opportunity, Opportunity.id == Closing.opportunity_id)
            .outerjoin(Property, Property.id == Closing.property_id).where(Closing.deleted_at.is_(None)))
    stmt = apply_search(stmt, f.q, [Opportunity.title, Property.name, Property.address_line, Property.city])
    if "status" not in skip:
        stmt = in_filter(stmt, Closing.status, f.status)
    stmt = in_filter(stmt, Closing.coordinator_id, f.coordinator_id)
    stmt = in_filter(stmt, Closing.manager_id, f.manager_id)
    if f.opportunity_id:
        stmt = stmt.where(Closing.opportunity_id == f.opportunity_id)
    if f.property_id:
        stmt = stmt.where(Closing.property_id == f.property_id)
    if f.asset_pending is not None:
        stmt = stmt.where(Closing.asset_pending.is_(f.asset_pending))
    if f.scheduled_from:
        stmt = stmt.where(Closing.scheduled_closing_on >= f.scheduled_from)
    if f.scheduled_to:
        stmt = stmt.where(Closing.scheduled_closing_on <= f.scheduled_to)
    return stmt


async def user_names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())


async def to_items(db: AsyncSession, rows: list[Closing]) -> list[ClosingListItem]:
    from app.modules.pipeline.models import Opportunity
    from app.modules.properties.models import Property

    if not rows:
        return []
    ids = [c.id for c in rows]
    opps = dict((await db.execute(select(Opportunity.id, Opportunity.title)
                                  .where(Opportunity.id.in_({c.opportunity_id for c in rows})))).all())
    props = {r.id: r for r in (await db.execute(
        select(Property.id, Property.name, Property.address_line)
        .where(Property.id.in_({c.property_id for c in rows if c.property_id})))).all()}
    I = ClosingChecklistItem
    counts = {r.closing_id: r for r in (await db.execute(
        select(I.closing_id, func.count().label("total"),
               func.sum(case((I.status.in_(SATISFIED_STATUSES), 1), else_=0)).label("done"),
               func.sum(case((and_(I.is_blocking.is_(True), I.status.notin_(SATISFIED_STATUSES)), 1),
                             else_=0)).label("blocking_open"))
        .where(I.closing_id.in_(ids), I.deleted_at.is_(None)).group_by(I.closing_id))).all()}
    wires = dict((await db.execute(
        select(WireVerification.closing_id, WireVerification.result)
        .where(WireVerification.closing_id.in_(ids), WireVerification.is_current.is_(True),
               WireVerification.deleted_at.is_(None)))).all())
    names = await user_names(db, {c.coordinator_id for c in rows} | {c.manager_id for c in rows})
    out = []
    for c in rows:
        item = ClosingListItem.model_validate(c)
        item.opportunity_title = opps.get(c.opportunity_id)
        p = props.get(c.property_id) if c.property_id else None
        item.property_label = (p.name or p.address_line) if p else None
        item.coordinator_name = names.get(c.coordinator_id) if c.coordinator_id else None
        item.manager_name = names.get(c.manager_id) if c.manager_id else None
        k = counts.get(c.id)
        if k:
            item.items_total, item.items_done, item.blocking_open = int(k.total), int(k.done or 0), int(k.blocking_open or 0)
        item.wire_status = wires.get(c.id, "missing")
        out.append(item)
    return out


async def to_out(db: AsyncSession, c: Closing) -> ClosingOut:
    item = (await to_items(db, [c]))[0]
    out = ClosingOut(**{**ClosingOut.model_validate(c).model_dump(), **item.model_dump()})
    out.blockers = await blockers(db, c)
    out.can_complete = c.status == "open" and not out.blockers
    out.has_snapshot = bool(await db.scalar(select(func.count()).select_from(ClosingSnapshot)
                                            .where(ClosingSnapshot.closing_id == c.id)))
    return out


# ----------------------------------------------------------------------------- completion


def _row(obj: Any, exclude: set[str] = frozenset()) -> dict:
    return to_jsonable({col.key: getattr(obj, col.key) for col in obj.__table__.columns if col.key not in exclude})


async def _build_snapshot(db: AsyncSession, c: Closing, opp: Any, actor: CurrentUser) -> dict:
    from app.modules.properties.models import Property

    snap: dict[str, Any] = {"opportunity": _row(opp, {"closed_snapshot"})}
    if c.property_id and (p := await db.get(Property, c.property_id)):
        snap["property"] = _row(p, {"location"})
    uw = await _uw_model_row(db, c.uw_model_id)
    snap["underwriting"] = to_jsonable({k: uw.get(k) for k in (
        "id", "name", "version", "template", "status", "approved_by_id", "approved_at", "assumptions", "outputs",
    )}) if uw else None
    snap["offer"] = None
    if c.offer_id:
        try:
            from app.modules.offers.models import Offer, OfferApproval

            o = await db.get(Offer, c.offer_id)
            if o:
                snap["offer"] = _row(o, {"loi_payload", "model_outputs"})
                snap["offer"]["approvals"] = [_row(a) for a in await db.scalars(
                    select(OfferApproval).where(OfferApproval.offer_id == o.id).order_by(OfferApproval.decided_at))]
        except ImportError:
            pass
    snap["closing"] = to_jsonable({k: getattr(c, k) for k in (
        "id", "purchase_price", "sources", "uses", "total_sources", "total_uses", "basis", "capital_structure",
        "closed_on", "scheduled_closing_on", "hold_thesis", "business_plan", "target_hold_years", "manager_id",
        "coordinator_id", "uw_model_id", "offer_id",
    )})
    snap["checklist"] = [to_jsonable({k: getattr(i, k) for k in (
        "id", "category", "title", "status", "is_blocking", "owner_id", "due_on", "document_id", "waived_reason",
        "completed_at", "completed_by_id",
    )}) for i in await db.scalars(select(ClosingChecklistItem).where(
        ClosingChecklistItem.closing_id == c.id, ClosingChecklistItem.deleted_at.is_(None)))]
    w = await current_wire(db, c.id)
    snap["wire"] = to_jsonable({
        "beneficiary_name": w.beneficiary_name, "bank_name": w.bank_name, "account_last4": w.account_number[-4:],
        "amount": w.amount, "instruction_source": w.instruction_source, "callback_phone_source": w.callback_phone_source,
        "callback_contact_name": w.callback_contact_name, "verified_by_name": w.verified_by_name,
        "verified_at": w.verified_at, "result": w.result,
    }) if w else None
    snap["completed_by"] = {"id": str(actor.id), "name": actor.full_name}
    snap["completed_at"] = to_jsonable(c.completed_at)
    return snap


async def _create_asset(db: AsyncSession, c: Closing, actor: CurrentUser) -> None:
    """Opportunity → Asset. If the assets module is missing or fails, keep asset_pending for a later retry."""
    try:
        from app.modules.assets.service import create_asset_from_closing
    except ImportError:
        c.asset_pending, c.asset_error = True, "Assets module unavailable"
        return
    try:
        async with db.begin_nested():
            asset = await create_asset_from_closing(
                db, property_id=c.property_id, opportunity_id=c.opportunity_id, closing_id=c.id,
                acquired_on=c.closed_on, basis=c.basis, uw_model_id=c.uw_model_id, manager_id=c.manager_id,
                hold_thesis=c.hold_thesis, actor=actor,
            )
            for attr in ("business_plan", "target_hold_years"):
                if getattr(c, attr) is not None and hasattr(asset, attr) and getattr(asset, attr) in (None, ""):
                    setattr(asset, attr, getattr(c, attr))
            asset_id = asset.id
    except Exception as e:  # noqa: BLE001 — the closing must still complete; conversion is retried
        await db.refresh(c)
        c.asset_pending, c.asset_error = True, f"{type(e).__name__}: {e}"[:2000]
        return
    c.asset_id, c.asset_pending, c.asset_error = asset_id, False, None


async def _open_dd_items(db: AsyncSession, c: Closing) -> list[dict]:
    """Open diligence items from the contracts module's `dd_items` table (read generically; optional)."""
    t = _table("dd_items")
    if t is None:
        return []
    conds = []
    if "opportunity_id" in t.c:
        conds.append(t.c.opportunity_id == c.opportunity_id)
    if "property_id" in t.c and c.property_id:
        conds.append(t.c.property_id == c.property_id)
    ct = _table("contracts")
    if "contract_id" in t.c and ct is not None:
        sub = []
        if "opportunity_id" in ct.c:
            sub.append(ct.c.opportunity_id == c.opportunity_id)
        if "property_id" in ct.c and c.property_id:
            sub.append(ct.c.property_id == c.property_id)
        if sub:
            conds.append(t.c.contract_id.in_(select(ct.c.id).where(or_(*sub))))
    if not conds:
        return []
    stmt = select(t).where(or_(*conds))
    if "deleted_at" in t.c:
        stmt = stmt.where(t.c.deleted_at.is_(None))
    if "status" in t.c:
        stmt = stmt.where(t.c.status.notin_(CLOSED_DD_STATUSES))
    out = []
    for r in (await db.execute(stmt.limit(500))).mappings().all():
        title = next((r.get(k) for k in ("title", "name", "label", "description") if r.get(k)), "DD item")
        due = next((r.get(k) for k in ("due_on", "due_date", "due_at") if r.get(k)), None)
        out.append(to_jsonable({
            "id": r["id"], "title": title, "status": r.get("status"), "severity": r.get("severity"),
            "due_on": due, "owner_id": r.get("owner_id"), "findings": r.get("findings"),
            "category": r.get("category"),
        }))
    return out


async def _leases(db: AsyncSession, property_id: uuid.UUID | None) -> list[dict]:
    t = _table("leases")
    if t is None or property_id is None or "property_id" not in t.c:
        return []
    stmt = select(t).where(t.c.property_id == property_id)
    if "deleted_at" in t.c:
        stmt = stmt.where(t.c.deleted_at.is_(None))
    return [dict(r) for r in (await db.execute(stmt.limit(1000))).mappings().all()]


def _item(label: str, detail: str | None = None, document_id: Any = None, st: str = "pending") -> dict:
    return to_jsonable({"label": label, "detail": detail, "document_id": document_id, "status": st})


async def _build_handoff(db: AsyncSession, c: Closing, actor: CurrentUser) -> HandoffPackage:
    existing = await db.scalar(select(HandoffPackage).where(HandoffPackage.closing_id == c.id))
    if existing:
        return existing
    checklist = list(await db.scalars(select(ClosingChecklistItem).where(
        ClosingChecklistItem.closing_id == c.id, ClosingChecklistItem.deleted_at.is_(None))))

    def from_checklist(*cats: str) -> list[dict]:
        return [_item(i.title, f"Closing item: {i.status.replace('_', ' ')}", i.document_id,
                      "delivered" if i.status == "done" else ("not_applicable" if i.status == "not_applicable" else "pending"))
                for i in checklist if i.category in cats]

    leases = await _leases(db, c.property_id)
    lease_items = [_item(
        str(l.get("tenant_name") or "Lease"),
        " · ".join(x for x in [str(l.get("status") or ""),
                               f"expires {l.get('expiration_on')}" if l.get("expiration_on") else "",
                               f"{float(l['rentable_sf']):,.0f} SF" if l.get("rentable_sf") else ""] if x),
        l.get("document_id")) for l in leases]
    dd = await _open_dd_items(db, c)
    sections = {
        "rent_roll": {"items": [_item("Rent roll as of closing date",
                                      f"{len(leases)} lease(s) on file" if leases else "No leases on file")],
                      "notes": None},
        "leases": {"items": lease_items or [_item("Executed leases, amendments and guaranties")], "notes": None},
        "service_contracts": {"items": from_checklist("vendors") or [_item("Assumed service contracts")],
                              "notes": None},
        "warranties": {"items": [_item("Roof, HVAC and equipment warranties")], "notes": None},
        "keys_access": {"items": [_item("Keys, access cards and codes"), _item("Alarm and security credentials")],
                        "notes": None},
        "utilities": {"items": from_checklist("utilities") or [_item("Utility accounts transferred")], "notes": None},
        "tax_insurance": {"items": from_checklist("insurance") + [_item("Property tax accounts and current bills")],
                          "notes": None},
        "open_dd_items": {"items": [_item(d["title"], d.get("findings") or d.get("status")) for d in dd],
                          "notes": None},
    }
    pkg = HandoffPackage(
        closing_id=c.id, asset_id=c.asset_id, property_id=c.property_id, sections=sections, open_dd_items=dd,
        carry_forward=to_jsonable({
            "capital_structure": c.capital_structure, "hold_thesis": c.hold_thesis, "business_plan": c.business_plan,
            "target_hold_years": c.target_hold_years, "uw_model_id": c.uw_model_id, "manager_id": c.manager_id,
            "purchase_price": c.purchase_price, "basis": c.basis, "closed_on": c.closed_on, "offer_id": c.offer_id,
            "opportunity_id": c.opportunity_id,
        }),
        generated_at=utcnow(), recipient_id=c.manager_id, created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(pkg)
    await db.flush()
    return pkg


def _due_dt(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime.combine(value, time(17, 0), tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            d = datetime.fromisoformat(value)
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            return fallback
    return fallback


async def _dd_tasks(db: AsyncSession, c: Closing, pkg: HandoffPackage, actor: CurrentUser) -> int:
    """Open DD items survive into operations as tasks linked to the asset."""
    if not c.asset_id:
        return 0
    from app.modules.tasks.service import create_task

    now = utcnow()
    for d in pkg.open_dd_items or []:
        sev = str(d.get("severity") or "").lower()
        owner = d.get("owner_id")
        await create_task(
            db, title=f"Open DD item from acquisition: {d.get('title')}",
            description=d.get("findings") or "Carried forward from acquisition due diligence at closing.",
            assignee_id=uuid.UUID(owner) if owner else (c.manager_id or c.coordinator_id),
            due_at=_due_dt(d.get("due_on"), now + timedelta(days=14)), task_type="due_diligence",
            priority="high" if sev in ("high", "critical", "4", "5") else "normal",
            related_type="asset", related_id=c.asset_id, related_label=d.get("title"), source="closing",
            idempotency_key=f"closing-dd:{c.id}:{d.get('id')}", actor_id=actor.id,
        )
    return len(pkg.open_dd_items or [])


async def _close_opportunity(db: AsyncSession, c: Closing, opp: Any, actor: CurrentUser) -> None:
    """Moves the opportunity to closed through the pipeline's gated move (which commits)."""
    if opp.stage in ("closed", "dead", "nurture"):
        await db.commit()
        return
    from app.modules.pipeline import service as pipeline
    from app.modules.pipeline.schemas import MoveIn, OpportunityUpdate

    try:
        await pipeline.move(db, opp, MoveIn(to_stage="closed", fields=OpportunityUpdate(
            closed_price=c.purchase_price, closed_on=c.closed_on, closing_date=c.closed_on)), actor)
    except HTTPException as e:
        await audit.record(db, actor=actor, action="closing.pipeline_move_blocked", entity_type=ENTITY,
                           entity_id=c.id, summary="Could not move opportunity to closed",
                           changes={"detail": to_jsonable(e.detail)}, ip_address=actor.ip_address)
        await db.commit()


async def complete(db: AsyncSession, c: Closing, data: CompleteIn, actor: CurrentUser) -> Closing:
    _require_open(c)
    found = await blockers(db, c)
    if found:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {
            "message": "Closing cannot complete: " + "; ".join(b.label for b in found),
            "blockers": [b.model_dump() for b in found],
        })
    opp = await _opportunity(db, c.opportunity_id)
    now = utcnow()
    c.status, c.closed_on, c.completed_at, c.completed_by_id, c.updated_by_id = (
        "completed", data.closed_on, now, actor.id, actor.id)
    c.capital_structure = capital_structure(c.sources or [], c.purchase_price)

    snap = await _build_snapshot(db, c, opp, actor)
    digest = hashlib.sha256(json.dumps(snap, sort_keys=True, default=str).encode()).hexdigest()
    db.add(ClosingSnapshot(closing_id=c.id, created_at=now, created_by_id=actor.id, created_by_name=actor.full_name,
                           sha256=digest, data=snap))
    await db.flush()

    await _create_asset(db, c, actor)
    pkg = await _build_handoff(db, c, actor)
    await _dd_tasks(db, c, pkg, actor)

    from app.modules.tasks.service import create_task

    label = opp.title
    task = await create_task(
        db, title=f"90-day post-close audit: {label}",
        description="Compare actual operations with the acquisition underwriting and report variances back to "
                    "acquisitions.",
        assignee_id=c.manager_id or c.coordinator_id or actor.id,
        due_at=datetime.combine(data.closed_on + timedelta(days=90), time(17, 0), tzinfo=timezone.utc),
        task_type="review", priority="normal", related_type="closing", related_id=c.id, related_label=label,
        source="closing", idempotency_key=f"closing-audit:{c.id}", actor_id=actor.id,
    )
    c.audit_task_id, c.audit_due_on = task.id, data.closed_on + timedelta(days=90)

    await audit.record(db, actor=actor, action="closing.completed", entity_type=ENTITY, entity_id=c.id,
                       summary=label + (" (asset conversion pending)" if c.asset_pending else ""),
                       changes={"closed_on": data.closed_on, "basis": c.basis, "asset_id": c.asset_id,
                                "snapshot_sha256": digest, "note": data.note}, ip_address=actor.ip_address)
    await events.emit(db, "closing.completed", closing_id=c.id, opportunity_id=c.opportunity_id,
                      property_id=c.property_id, asset_id=c.asset_id, actor=actor)
    await _close_opportunity(db, c, opp, actor)  # commits
    return c


async def retry_asset(db: AsyncSession, c: Closing, actor: CurrentUser) -> Closing:
    if c.status != "completed" or not c.asset_pending:
        raise HTTPException(status.HTTP_409_CONFLICT, "Asset conversion is not pending for this closing")
    await _create_asset(db, c, actor)
    if c.asset_id:
        pkg = await _build_handoff(db, c, actor)
        pkg.asset_id = c.asset_id
        await _dd_tasks(db, c, pkg, actor)
    await audit.record(db, actor=actor, action="closing.asset_conversion_retried", entity_type=ENTITY, entity_id=c.id,
                       summary="Asset created" if c.asset_id else "Still pending",
                       changes={"asset_id": c.asset_id, "error": c.asset_error}, ip_address=actor.ip_address)
    await db.commit()
    return c


# ----------------------------------------------------------------------------- handoff


async def update_handoff(db: AsyncSession, pkg: HandoffPackage, data: HandoffUpdate, actor: CurrentUser) -> HandoffPackage:
    if pkg.acknowledged_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "The handoff package was acknowledged by operations")
    sections = dict(pkg.sections or {})
    for key, sec in data.sections.items():
        if key not in HANDOFF_SECTIONS:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown handoff section '{key}'")
        sections[key] = to_jsonable(sec.model_dump())
    values: dict[str, Any] = {"sections": sections}
    if "recipient_id" in data.model_fields_set:
        values["recipient_id"] = data.recipient_id
    changes = audit.diff(pkg, values)
    if not changes:
        return pkg
    for k, v in values.items():
        setattr(pkg, k, v)
    pkg.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="closing.handoff_updated", entity_type=ENTITY, entity_id=pkg.closing_id,
                       changes={"sections": list(data.sections)}, ip_address=actor.ip_address)
    await db.commit()
    return pkg


async def acknowledge_handoff(db: AsyncSession, pkg: HandoffPackage, actor: CurrentUser) -> HandoffPackage:
    if pkg.acknowledged_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already acknowledged")
    pkg.acknowledged_at, pkg.acknowledged_by_id, pkg.updated_by_id = utcnow(), actor.id, actor.id
    await audit.record(db, actor=actor, action="closing.handoff_acknowledged", entity_type=ENTITY,
                       entity_id=pkg.closing_id, ip_address=actor.ip_address)
    await db.commit()
    return pkg


# ----------------------------------------------------------------------------- 90-day audit


def _variance(key: str, label: str, assumed: Any, actual: float | None, unit: str = "currency") -> AuditMetric:
    a = float(assumed) if isinstance(assumed, (int, float)) else None
    m = AuditMetric(key=key, label=label, assumed=a, actual=round(actual, 4) if actual is not None else None,
                    unit=unit)  # type: ignore[arg-type]
    if a is not None and actual is not None:
        m.variance = round(actual - a, 4)
        m.variance_pct = round((actual - a) / abs(a) * 100, 2) if a else None
    return m


async def post_close_audit(db: AsyncSession, c: Closing) -> PostCloseAuditOut:
    out = PostCloseAuditOut(closing_id=c.id, asset_id=c.asset_id, closed_on=c.closed_on, due_on=c.audit_due_on,
                            period_start=None, period_end=None, completed=c.audit_result)
    if c.status != "completed" or not c.closed_on:
        out.notes.append("Available after the closing is completed")
        return out
    uw = await _uw_model_row(db, c.uw_model_id)
    outputs: dict = (uw or {}).get("outputs") or {}
    if not outputs:
        out.notes.append("Approved underwriting outputs are unavailable")

    totals: dict[str, float] = {}
    months = 0
    t = _table("asset_financials")
    if not c.asset_id:
        out.notes.append("Asset not yet created; no operating actuals")
    elif t is None:
        out.notes.append("Asset financials are unavailable")
    else:
        start = c.closed_on.replace(day=1)
        rows = (await db.execute(
            select(t.c.category, func.sum(t.c.amount), func.count(func.distinct(t.c.period)), func.min(t.c.period),
                   func.max(t.c.period))
            .where(t.c.asset_id == c.asset_id, t.c.period >= start, t.c.is_current.is_(True),
                   t.c.deleted_at.is_(None)).group_by(t.c.category))).all()
        firsts, lasts = [], []
        for cat, amt, n, first, last in rows:
            totals[str(cat)] = float(amt or 0)
            months = max(months, int(n or 0))
            firsts.append(first)
            lasts.append(last)
        out.period_start = min(firsts) if firsts else None
        out.period_end = max(lasts) if lasts else None
        if not rows:
            out.notes.append("No operating actuals posted since closing")
    out.months_of_data = months

    annual = 12 / months if months else None
    income = totals.get("income")
    expense = abs(totals.get("expense", 0.0))
    debt_service = abs(totals.get("debt_service", 0.0))
    noi = (income - expense) * annual if (annual and income is not None) else None
    ds = debt_service * annual if annual and debt_service else None
    price = float(c.purchase_price) if c.purchase_price else None
    equity = float((c.capital_structure or {}).get("equity") or 0) or None

    def scaled(assumed: Any, fraction: float | None) -> float | None:
        # Underwriting may store rates as fractions (0.065) or percents (6.5): compare in the same scale.
        if fraction is None:
            return None
        return fraction * 100 if isinstance(assumed, (int, float)) and assumed > 1 else fraction

    out.metrics = [
        _variance("purchase_price", "Purchase price", outputs.get("purchase_price"), price),
        _variance("noi", "NOI (annualized)", outputs.get("noi_year1"), noi),
        _variance("going_in_cap", "Yield on purchase price", outputs.get("going_in_cap"),
                  scaled(outputs.get("going_in_cap"), noi / price if noi is not None and price else None), "percent"),
        _variance("dscr", "DSCR", outputs.get("dscr"), noi / ds if noi is not None and ds else None, "ratio"),
        _variance("cash_on_cash", "Cash-on-cash", outputs.get("cash_on_cash"),
                  scaled(outputs.get("cash_on_cash"), (noi - (ds or 0)) / equity if noi is not None and equity else None),
                  "percent"),
    ]
    if "capex" in totals:
        out.metrics.append(_variance("capex", "Capex to date", None, abs(totals["capex"])))
    return out


async def complete_audit(db: AsyncSession, c: Closing, data: AuditCompleteIn, actor: CurrentUser) -> Closing:
    if c.status != "completed":
        raise HTTPException(status.HTTP_409_CONFLICT, "The post-close audit runs after closing")
    if c.audit_completed_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "The post-close audit is already recorded")
    result = await post_close_audit(db, c)
    opp = await _opportunity(db, c.opportunity_id)
    now = utcnow()
    c.audit_result = to_jsonable({
        "metrics": [m.model_dump() for m in result.metrics], "months_of_data": result.months_of_data,
        "period_start": result.period_start, "period_end": result.period_end, "notes": result.notes,
        "findings": data.findings, "lessons_for_acquisitions": data.lessons_for_acquisitions,
        "completed_by": actor.full_name, "completed_at": now,
    })
    c.audit_completed_at, c.audit_completed_by_id, c.updated_by_id = now, actor.id, actor.id
    from app.modules.tasks.service import create_task

    # Variance feedback returns to acquisitions (the opportunity owner who underwrote the deal).
    await create_task(
        db, title=f"Review 90-day variance feedback: {opp.title}",
        description=data.lessons_for_acquisitions or data.findings, assignee_id=opp.owner_id,
        due_at=now + timedelta(days=7), task_type="review", priority="normal", related_type="closing",
        related_id=c.id, related_label=opp.title, source="closing",
        idempotency_key=f"closing-audit-feedback:{c.id}", actor_id=actor.id,
    )
    await audit.record(db, actor=actor, action="closing.post_close_audit_completed", entity_type=ENTITY,
                       entity_id=c.id, summary=data.findings[:300], changes={"metrics": c.audit_result["metrics"]},
                       ip_address=actor.ip_address)
    await events.emit(db, "closing.audit_completed", closing_id=c.id, opportunity_id=c.opportunity_id,
                      uw_model_id=c.uw_model_id, asset_id=c.asset_id, variances=c.audit_result["metrics"], actor=actor)
    from app.modules.tasks.models import Task

    task = await db.get(Task, c.audit_task_id) if c.audit_task_id else None
    if task and task.status in ("open", "in_progress"):
        from app.modules.tasks.service import complete as complete_task

        try:
            await complete_task(db, task, "Post-close audit recorded", actor)  # commits
            return c
        except HTTPException:
            pass
    await db.commit()
    return c


# ----------------------------------------------------------------------------- handlers support


async def reassign_user(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None) -> None:
    if not reassign_to_id:
        return
    for col in (Closing.coordinator_id, Closing.manager_id):
        await db.execute(update(Closing).where(col == user_id, Closing.status == "open", Closing.deleted_at.is_(None))
                         .values({col.key: reassign_to_id}))
    open_closings = select(Closing.id).where(Closing.status == "open")
    await db.execute(update(ClosingChecklistItem).where(
        ClosingChecklistItem.owner_id == user_id, ClosingChecklistItem.status.notin_(SATISFIED_STATUSES),
        ClosingChecklistItem.closing_id.in_(open_closings)).values(owner_id=reassign_to_id))
