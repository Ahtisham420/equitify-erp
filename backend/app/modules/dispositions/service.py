import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.assets.calc import add_days, add_months, norm_key, pct, r2
from app.modules.auth.models import User
from app.modules.dispositions.models import (
    PROGRESSION,
    TERMINAL,
    Disposition,
    DispositionEvent,
    DispositionOffer,
    Exchange1031,
    ExchangeCandidate,
    Retrade,
)
from app.modules.dispositions.schemas import (
    CandidateIn,
    CompareIn,
    DispositionCreate,
    DispositionOut,
    DispositionUpdate,
    ExchangeIn,
    MoveIn,
    OfferIn,
    Requirement,
    RetradeDecisionIn,
    RetradeIn,
)
from app.modules.properties.models import Property

ENTITY = "disposition"
TAX_NOTE = ("Tax figures (gain, depreciation recapture, capital gains, boot, deferred gain and after-tax proceeds) are "
            "modeled estimates for comparison only and are subject to review by a qualified tax professional.")


def _due_dt(d: date) -> datetime:
    return datetime.combine(d, time(17, 0), tzinfo=timezone.utc)


def next_stage(stage: str) -> str | None:
    if stage not in PROGRESSION:
        return None
    i = PROGRESSION.index(stage)
    return PROGRESSION[i + 1] if i + 1 < len(PROGRESSION) else None


async def get(db: AsyncSession, disposition_id: uuid.UUID) -> Disposition:
    d = await db.get(Disposition, disposition_id)
    if not d or d.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Disposition not found")
    return d


async def _asset(db: AsyncSession, asset_id: uuid.UUID):
    from app.modules.assets.models import Asset

    a = await db.get(Asset, asset_id)
    if not a or a.deleted_at:
        raise HTTPException(404, "Asset not found")
    return a


async def _props(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, Property]:
    ids = {i for i in ids if i}
    return {p.id: p for p in await db.scalars(select(Property).where(Property.id.in_(ids)))} if ids else {}


async def _names(db: AsyncSession, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    return {u.id: u.full_name for u in await db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}


# --------------------------------------------------------------------------- list

@dataclass
class DispositionFilters:
    q: str | None = None
    stage: list[str] | None = None
    owner_id: list[uuid.UUID] | None = None
    is_1031: list[str] | None = None
    asset_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    active_only: bool | None = None


def build_query(f: DispositionFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Disposition).join(Property, Property.id == Disposition.property_id).where(Disposition.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Disposition.name, Disposition.buyer_name, Property.name, Property.address_line,
                                     Property.city])
    if "stage" not in skip:
        stmt = in_filter(stmt, Disposition.stage, f.stage)
    if "owner_id" not in skip:
        stmt = in_filter(stmt, Disposition.owner_id, f.owner_id)
    if "is_1031" not in skip and f.is_1031:
        stmt = stmt.where(Disposition.is_1031.in_([v in ("true", "1", "yes") for v in f.is_1031]))
    if f.asset_id:
        stmt = stmt.where(Disposition.asset_id == f.asset_id)
    if f.property_id:
        stmt = stmt.where(Disposition.property_id == f.property_id)
    if f.active_only:
        stmt = stmt.where(Disposition.stage.not_in(TERMINAL))
    return stmt


async def to_items(db: AsyncSession, rows: list[Disposition]) -> list[dict]:
    props = await _props(db, {d.property_id for d in rows})
    names = await _names(db, {d.owner_id for d in rows})
    ids = [d.id for d in rows]
    offers: dict[uuid.UUID, tuple[int, float | None]] = {}
    deadlines: dict[uuid.UUID, date | None] = {}
    if ids:
        for did, cnt, best in (await db.execute(
            select(DispositionOffer.disposition_id, func.count(), func.max(DispositionOffer.price))
            .where(DispositionOffer.disposition_id.in_(ids), DispositionOffer.deleted_at.is_(None),
                   DispositionOffer.status.not_in(["rejected", "withdrawn"]))
            .group_by(DispositionOffer.disposition_id)
        )).all():
            offers[did] = (int(cnt), float(best) if best is not None else None)
        today = date.today()
        for ex in await db.scalars(select(Exchange1031).where(Exchange1031.disposition_id.in_(ids),
                                                              Exchange1031.deleted_at.is_(None))):
            upcoming = [x for x in (ex.identification_deadline, ex.replacement_deadline) if x and x >= today]
            deadlines[ex.disposition_id] = min(upcoming) if upcoming and ex.status not in ("completed", "failed", "cancelled") else None
    now = utcnow()
    out = []
    for d in rows:
        p = props.get(d.property_id)
        cnt, best = offers.get(d.id, (0, None))
        out.append({
            "id": d.id, "name": d.name, "asset_id": d.asset_id, "property_id": d.property_id,
            "property_label": (p.name or p.address_line) if p else "—", "city": p.city if p else None,
            "state": p.state if p else None, "stage": d.stage, "stage_entered_at": d.stage_entered_at,
            "days_in_stage": max(0, (now - d.stage_entered_at).days) if d.stage_entered_at else 0,
            "owner_id": d.owner_id, "owner_name": names.get(d.owner_id), "is_1031": d.is_1031,
            "target_price": d.target_price, "best_offer": best, "offer_count": cnt, "contract_price": d.contract_price,
            "target_closing_on": d.target_closing_on, "next_exchange_deadline": deadlines.get(d.id),
            "updated_at": d.updated_at,
        })
    return out


async def to_out(db: AsyncSession, d: Disposition) -> DispositionOut:
    out = DispositionOut.model_validate(d)
    p = (await _props(db, {d.property_id})).get(d.property_id)
    if p:
        out.property_label, out.city, out.state = p.name or p.address_line, p.city, p.state
    out.owner_name = (await _names(db, {d.owner_id})).get(d.owner_id)
    from app.modules.assets.models import Asset

    a = await db.get(Asset, d.asset_id)
    out.asset_status = a.status if a else None
    return out


# --------------------------------------------------------------------------- create / update

async def _event(db: AsyncSession, d: Disposition, from_stage: str | None, to_stage: str, actor: Any,
                 reason: str | None = None, override: bool = False, unmet: list | None = None) -> None:
    db.add(DispositionEvent(disposition_id=d.id, from_stage=from_stage, to_stage=to_stage, actor_id=getattr(actor, "id", None),
                            actor_name=getattr(actor, "full_name", None), reason=reason, override=override,
                            unmet=unmet or []))


async def create(db: AsyncSession, data: DispositionCreate, actor: CurrentUser) -> Disposition:
    a = await _asset(db, data.asset_id)
    if a.status == "disposed":
        raise HTTPException(409, "This asset has already been disposed")
    open_d = await db.scalar(select(Disposition).where(Disposition.asset_id == a.id, Disposition.deleted_at.is_(None),
                                                      Disposition.stage.not_in(TERMINAL)))
    if open_d:
        raise HTTPException(409, {"message": "This asset already has an open disposition", "id": str(open_d.id)})
    p = await db.get(Property, a.property_id)
    d = Disposition(asset_id=a.id, property_id=a.property_id, name=data.name or f"Sale of {(p.name or p.address_line) if p else 'asset'}",
                    stage="candidate", stage_entered_at=utcnow(), owner_id=data.owner_id or a.manager_id or actor.id,
                    reason=data.reason, is_1031=data.is_1031, target_price=data.target_price, cost_lines=[],
                    tax_inputs={}, comparison={}, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(d)
    await db.flush()
    await _event(db, d, None, "candidate", actor, reason=data.reason)
    await audit.record(db, actor=actor, action="disposition.created", entity_type=ENTITY, entity_id=d.id, summary=d.name,
                       ip_address=actor.ip_address)
    await db.commit()
    return d


async def update(db: AsyncSession, d: Disposition, data: DispositionUpdate, actor: CurrentUser) -> Disposition:
    if d.stage == "closed":
        allowed = {"notes", "tax_inputs", "cost_lines"}
        if set(data.model_dump(exclude_unset=True)) - allowed:
            raise HTTPException(409, "A closed disposition is immutable except notes, costs and tax inputs")
    values = data.model_dump(exclude_unset=True)
    for k in ("cost_lines", "tax_inputs"):
        if k in values:
            values[k] = data.model_dump(mode="json", include={k})[k] or ([] if k == "cost_lines" else {})
    changes = audit.diff(d, values)
    if not changes:
        return d
    for k, v in values.items():
        setattr(d, k, v)
    d.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="disposition.updated", entity_type=ENTITY, entity_id=d.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return d


async def archive(db: AsyncSession, d: Disposition, actor: CurrentUser) -> None:
    if d.stage not in ("candidate", "withdrawn"):
        raise HTTPException(409, "Only candidate or withdrawn dispositions can be deleted; withdraw it first")
    d.deleted_at, d.updated_by_id = utcnow(), actor.id
    await audit.record(db, actor=actor, action="disposition.archived", entity_type=ENTITY, entity_id=d.id,
                       summary=d.name, ip_address=actor.ip_address)
    await db.commit()


# --------------------------------------------------------------------------- stage gates

async def check_gate(db: AsyncSession, d: Disposition, to_stage: str) -> list[Requirement]:
    reqs: list[Requirement] = []
    if to_stage == "withdrawn":
        return [Requirement(key="reason", label="Reason for withdrawal", met=False, blocking=True,
                            detail="Provide a reason when withdrawing")]
    if to_stage not in PROGRESSION:
        return reqs
    target = PROGRESSION.index(to_stage)
    accepted = await db.get(DispositionOffer, d.accepted_offer_id) if d.accepted_offer_id else None
    ex = await db.scalar(select(Exchange1031).where(Exchange1031.disposition_id == d.id, Exchange1031.deleted_at.is_(None)))
    if target >= PROGRESSION.index("pricing"):
        reqs.append(Requirement(key="comparison", label="Hold / sell / refinance comparison run", met=bool(d.comparison),
                                detail="Compare alternatives before pricing the asset"))
    if target >= PROGRESSION.index("marketing"):
        reqs.append(Requirement(key="target_price", label="Target or list price set", met=bool(d.target_price or d.list_price)))
    if target >= PROGRESSION.index("offers"):
        reqs.append(Requirement(key="marketing_launched_on", label="Marketing launch date recorded",
                                met=d.marketing_launched_on is not None))
    if target >= PROGRESSION.index("contract"):
        reqs.append(Requirement(key="accepted_offer", label="Accepted buyer offer", met=accepted is not None))
        reqs.append(Requirement(key="contract", label="Contract price and execution date",
                                met=bool(d.contract_price and d.contract_executed_on)))
    if target >= PROGRESSION.index("buyer_dd"):
        reqs.append(Requirement(key="dd_expires_on", label="Buyer due diligence expiration date",
                                met=d.dd_expires_on is not None))
    if target >= PROGRESSION.index("closing"):
        pending = await db.scalar(select(func.count()).select_from(Retrade).where(
            Retrade.disposition_id == d.id, Retrade.deleted_at.is_(None), Retrade.decision == "pending"))
        reqs.append(Requirement(key="retrades", label="No pending retrade requests", met=not pending,
                                detail=f"{pending} pending" if pending else None))
        reqs.append(Requirement(key="target_closing_on", label="Target closing date", met=d.target_closing_on is not None))
        if d.is_1031:
            reqs.append(Requirement(key="qi", label="Qualified intermediary engaged before closing",
                                    met=bool(ex and (ex.qi_organization_id or ex.qi_name)),
                                    detail="Sale proceeds must go to the QI, never to the seller"))
    if target >= PROGRESSION.index("closed"):
        reqs.append(Requirement(key="sale", label="Final sale price and closing date",
                                met=bool(d.sale_price and d.closed_on)))
        reqs.append(Requirement(key="proceeds", label="Proceeds reconciliation reviewed", met=True, blocking=False,
                                detail="Review the proceeds waterfall before closing"))
    return reqs


def unmet_of(reqs: list[Requirement]) -> list[Requirement]:
    return [r for r in reqs if r.blocking and not r.met]


async def move(db: AsyncSession, d: Disposition, body: MoveIn, actor: CurrentUser) -> Disposition:
    to = body.to_stage
    if d.stage == "closed":
        raise HTTPException(409, "A closed disposition cannot change stage")
    if to == d.stage:
        raise HTTPException(409, "Already in this stage")
    if to == "withdrawn":
        if not body.reason:
            raise HTTPException(422, "A reason is required to withdraw a disposition")
        unmet: list[Requirement] = []
    else:
        unmet = unmet_of(await check_gate(db, d, to))
        if unmet and not body.override:
            raise HTTPException(409, {"message": "Stage requirements are not met",
                                      "unmet": [r.model_dump() for r in unmet]})
        if unmet and not actor.can("dispositions", "approve"):
            raise HTTPException(403, "Overriding stage requirements requires approval permission")
        if body.override and unmet and not body.reason:
            raise HTTPException(422, "An override requires a reason")
    a = await _asset(db, d.asset_id)
    old = d.stage
    d.stage, d.stage_entered_at, d.updated_by_id = to, utcnow(), actor.id

    accepted = await db.get(DispositionOffer, d.accepted_offer_id) if d.accepted_offer_id else None
    if to == "withdrawn":
        d.withdrawn_reason = body.reason
        if a.status == "held_for_sale":
            a.status = "active"
        if accepted and accepted.outcome is None:
            accepted.outcome = "fell_through"
    elif to in ("marketing", "offers", "contract", "buyer_dd", "closing") and a.status == "active":
        if PROGRESSION.index(to) >= PROGRESSION.index("marketing"):
            a.status = "held_for_sale"
    if old in ("contract", "buyer_dd", "closing") and to in ("candidate", "pricing", "marketing", "offers") and accepted:
        accepted.outcome = "fell_through"
        accepted.status = "withdrawn"
        d.accepted_offer_id = None
    if to == "closed":
        await _close(db, d, a, accepted, actor)

    await _event(db, d, old, to, actor, reason=body.reason, override=bool(unmet),
                 unmet=[r.model_dump() for r in unmet])
    await audit.record(db, actor=actor, action="disposition.stage_changed", entity_type=ENTITY, entity_id=d.id,
                       changes={"stage": {"from": old, "to": to}, "override": bool(unmet)}, summary=body.reason,
                       ip_address=actor.ip_address)
    await events.emit(db, "disposition.stage_changed", disposition_id=d.id, asset_id=d.asset_id,
                      property_id=d.property_id, from_stage=old, to_stage=to, actor=actor)
    await db.commit()
    return d


async def _close(db: AsyncSession, d: Disposition, a: Any, accepted: DispositionOffer | None, actor: CurrentUser) -> None:
    a.status, a.disposed_on = "disposed", d.closed_on or date.today()
    p = await db.get(Property, d.property_id)
    if p:
        values = {"status": "sold", "last_sale_price": d.sale_price, "last_sale_date": d.closed_on}
        changes = await provenance.apply_material(
            db, p, entity_type="property", data=values, material_fields={"last_sale_price", "last_sale_date"},
            prov=provenance.ProvenanceIn(source="Disposition closing", observed_on=d.closed_on, confidence=1.0, verified=True),
            actor_id=actor.id)
        if changes:
            p.updated_by_id = actor.id
            await audit.record(db, actor=actor, action="property.updated", entity_type="property", entity_id=p.id,
                               changes=changes, summary="Sold — disposition closed")
            await events.emit(db, "property.updated", property_id=p.id, changed=set(changes), actor=actor)
    if accepted:
        accepted.outcome = "closed"
    for r in await db.scalars(select(Retrade).where(Retrade.disposition_id == d.id, Retrade.outcome == "pending")):
        r.outcome = "closed"
    ex = await db.scalar(select(Exchange1031).where(Exchange1031.disposition_id == d.id, Exchange1031.deleted_at.is_(None)))
    if ex and ex.exchange_type == "forward":
        ex.start_on = ex.start_on or d.closed_on
        ex.relinquished_sale_price = ex.relinquished_sale_price or d.sale_price
        ex.status = "open" if ex.status == "planned" else ex.status
        await schedule_exchange_dates(db, d, ex, actor)
    await events.emit(db, "disposition.closed", disposition_id=d.id, asset_id=d.asset_id, property_id=d.property_id,
                      actor=actor)


# --------------------------------------------------------------------------- offers / retrades

async def add_offer(db: AsyncSession, d: Disposition, data: OfferIn, actor: CurrentUser) -> DispositionOffer:
    o = DispositionOffer(disposition_id=d.id, **data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(o)
    await db.flush()
    await audit.record(db, actor=actor, action="disposition.offer_received", entity_type=ENTITY, entity_id=d.id,
                       summary=f"{o.buyer_name} {o.price:,.0f}", changes=data.model_dump(), ip_address=actor.ip_address)
    await db.commit()
    return o


async def update_offer(db: AsyncSession, o: DispositionOffer, data: OfferIn, actor: CurrentUser) -> DispositionOffer:
    values = data.model_dump()
    changes = audit.diff(o, values)
    for k, v in values.items():
        setattr(o, k, v)
    o.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="disposition.offer_updated", entity_type=ENTITY, entity_id=o.disposition_id,
                       summary=o.buyer_name, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return o


async def accept_offer(db: AsyncSession, d: Disposition, o: DispositionOffer, actor: CurrentUser) -> Disposition:
    if d.stage in TERMINAL:
        raise HTTPException(409, "Disposition is closed or withdrawn")
    if d.accepted_offer_id and d.accepted_offer_id != o.id:
        prev = await db.get(DispositionOffer, d.accepted_offer_id)
        if prev and prev.status == "accepted":
            prev.status, prev.outcome = "backup", None
    o.status, o.updated_by_id = "accepted", actor.id
    d.accepted_offer_id = o.id
    d.buyer_name, d.buyer_organization_id = o.buyer_name, o.buyer_organization_id
    d.contract_price = d.contract_price or o.price
    d.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="disposition.offer_accepted", entity_type=ENTITY, entity_id=d.id,
                       summary=f"{o.buyer_name} {o.price:,.0f}", ip_address=actor.ip_address)
    await db.commit()
    return d


async def add_retrade(db: AsyncSession, d: Disposition, data: RetradeIn, actor: CurrentUser) -> Retrade:
    offer = await db.get(DispositionOffer, data.offer_id or d.accepted_offer_id) if (data.offer_id or d.accepted_offer_id) else None
    buyer = data.buyer_name or (offer.buyer_name if offer else None) or d.buyer_name
    if not buyer:
        raise HTTPException(422, "Buyer is required for a retrade")
    r = Retrade(disposition_id=d.id, offer_id=offer.id if offer else None,
                buyer_organization_id=data.buyer_organization_id or (offer.buyer_organization_id if offer else d.buyer_organization_id),
                buyer_name=buyer, requested_on=data.requested_on, reason_category=data.reason_category, reason=data.reason,
                amount_requested=data.amount_requested, decision="pending", outcome="pending", notes=data.notes,
                created_by_id=actor.id, updated_by_id=actor.id)
    db.add(r)
    await db.flush()
    await audit.record(db, actor=actor, action="disposition.retrade_requested", entity_type=ENTITY, entity_id=d.id,
                       summary=f"{buyer}: {data.amount_requested:,.0f} ({data.reason_category})",
                       changes=data.model_dump(), ip_address=actor.ip_address)
    await db.commit()
    return r


async def decide_retrade(db: AsyncSession, r: Retrade, data: RetradeDecisionIn, actor: CurrentUser) -> Retrade:
    d = await get(db, r.disposition_id)
    values = data.model_dump(exclude_unset=True)
    changes = audit.diff(r, values)
    if not changes:
        return r
    was_applied = r.decision in ("accepted", "countered") and r.agreed_amount
    for k, v in values.items():
        setattr(r, k, v)
    if "decision" in changes and r.decision != "pending":
        r.decided_on, r.decided_by_id = date.today(), actor.id
        if r.decision == "accepted" and r.agreed_amount is None:
            r.agreed_amount = r.amount_requested
    if r.decision in ("accepted", "countered") and r.agreed_amount and not was_applied and d.contract_price:
        old_price = d.contract_price
        d.contract_price = round(float(d.contract_price) - float(r.agreed_amount), 2)
        changes["contract_price"] = {"from": old_price, "to": d.contract_price}
    r.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="disposition.retrade_decided", entity_type=ENTITY, entity_id=d.id,
                       summary=f"{r.buyer_name}: {r.decision}", changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return r


async def retrade_items(db: AsyncSession, rows: list[Retrade]) -> list[dict]:
    names = {d.id: d.name for d in await db.scalars(select(Disposition).where(Disposition.id.in_({r.disposition_id for r in rows})))} if rows else {}
    return [{**{k: getattr(r, k) for k in ("id", "disposition_id", "offer_id", "buyer_organization_id", "buyer_name",
                                           "requested_on", "reason_category", "reason", "amount_requested", "decision",
                                           "agreed_amount", "decided_on", "outcome", "notes", "created_at")},
             "disposition_name": names.get(r.disposition_id)} for r in rows]


async def buyer_performance(db: AsyncSession, q: str | None = None) -> list[dict]:
    """Counterparty intelligence: every buyer's offers, acceptances, closes, fall-throughs and retrades."""
    offers = list(await db.scalars(select(DispositionOffer).where(DispositionOffer.deleted_at.is_(None))))
    retrades = list(await db.scalars(select(Retrade).where(Retrade.deleted_at.is_(None))))
    stats: dict[str, dict] = {}

    def key_of(org_id, name) -> str:
        return str(org_id) if org_id else norm_key(name)

    def entry(org_id, name) -> dict:
        k = key_of(org_id, name)
        return stats.setdefault(k, {"key": k, "buyer_name": name, "buyer_organization_id": org_id, "offers": 0,
                                    "accepted": 0, "closed": 0, "fell_through": 0, "retrades": 0,
                                    "retrade_requested": 0.0, "retrade_agreed": 0.0, "accepted_price": 0.0,
                                    "avg_offer": 0.0, "_sum": 0.0, "last_activity": None, "disposition_ids": set()})

    for o in offers:
        e = entry(o.buyer_organization_id, o.buyer_name)
        e["offers"] += 1
        e["_sum"] += float(o.price)
        if o.status == "accepted" or o.outcome in ("closed", "fell_through"):
            e["accepted"] += 1
            e["accepted_price"] += float(o.price)
        if o.outcome == "closed":
            e["closed"] += 1
        if o.outcome == "fell_through":
            e["fell_through"] += 1
        e["last_activity"] = max(filter(None, [e["last_activity"], o.received_on]))
        e["disposition_ids"].add(o.disposition_id)
    for r in retrades:
        e = entry(r.buyer_organization_id, r.buyer_name)
        e["retrades"] += 1
        e["retrade_requested"] += float(r.amount_requested or 0)
        e["retrade_agreed"] += float(r.agreed_amount or 0) if r.decision in ("accepted", "countered") else 0
        e["last_activity"] = max(filter(None, [e["last_activity"], r.requested_on]))
        e["disposition_ids"].add(r.disposition_id)
    out = []
    for e in stats.values():
        if q and q.lower() not in (e["buyer_name"] or "").lower():
            continue
        e["avg_offer"] = r2(e["_sum"] / e["offers"]) if e["offers"] else None
        e["close_rate"] = pct(e["closed"], e["accepted"]) if e["accepted"] else None
        e["retrade_rate"] = pct(e["retrades"], e["accepted"]) if e["accepted"] else None
        e["retrade_pct_of_price"] = pct(e["retrade_agreed"], e["accepted_price"]) if e["accepted_price"] else None
        e["disposition_ids"] = [str(x) for x in e["disposition_ids"]]
        e.pop("_sum")
        out.append(e)
    return sorted(out, key=lambda x: (-x["offers"], x["buyer_name"] or ""))


# --------------------------------------------------------------------------- tax / economics

def tax_estimate(price: float, costs: float, tax_basis: float, accumulated_depreciation: float, t: dict) -> dict:
    adjusted = tax_basis - accumulated_depreciation
    realized = price - costs
    gain = realized - adjusted
    recapture = min(max(gain, 0.0), accumulated_depreciation)
    cap_gain = max(gain - recapture, 0.0)
    rec_tax = recapture * float(t.get("recapture_rate", 25)) / 100
    cg_tax = cap_gain * float(t.get("cap_gains_rate", 20)) / 100
    state_tax = max(gain, 0) * float(t.get("state_rate", 0)) / 100
    niit = max(gain, 0) * float(t.get("niit_rate", 3.8)) / 100
    return {"amount_realized": r2(realized), "tax_basis": r2(tax_basis), "accumulated_depreciation": r2(accumulated_depreciation),
            "adjusted_basis": r2(adjusted), "gain": r2(gain), "depreciation_recapture": r2(recapture),
            "capital_gain": r2(cap_gain), "recapture_tax": r2(rec_tax), "capital_gains_tax": r2(cg_tax),
            "state_tax": r2(state_tax), "niit": r2(niit), "total_tax": r2(rec_tax + cg_tax + state_tax + niit),
            "modeled_estimate": True}


async def _economics_context(db: AsyncSession, d: Disposition) -> dict:
    """Asset KPIs, active loans (allocated) and reserves for the disposition's asset."""
    from app.modules.assets import service as assets
    from app.modules.debt.models import Loan, LoanReserve

    a = await _asset(db, d.asset_id)
    props = await assets.load_props(db, [a])
    k = (await assets.compute_kpis(db, [a], props))[a.id]
    loan_rows = {l.id: l for l in await db.scalars(select(Loan).where(Loan.id.in_([x["id"] for x in k["loans"]])))} if k["loans"] else {}
    reserves: dict[uuid.UUID, float] = defaultdict(float)
    if loan_rows:
        for r in await db.scalars(select(LoanReserve).where(LoanReserve.loan_id.in_(loan_rows.keys()),
                                                            LoanReserve.deleted_at.is_(None))):
            reserves[r.loan_id] += float(r.balance or 0)
    return {"asset": a, "kpis": k, "loans": [(x, loan_rows[x["id"]]) for x in k["loans"] if x["id"] in loan_rows],
            "reserves": reserves}


async def compare(db: AsyncSession, d: Disposition, inp: CompareIn, actor: CurrentUser) -> dict:
    from app.modules.debt import calc
    from app.modules.debt.service import get_settings as debt_settings

    ctx = await _economics_context(db, d)
    a, k = ctx["asset"], ctx["kpis"]
    market = (await debt_settings(db))["market"]
    today = date.today()
    noi = inp.noi if inp.noi is not None else (k["noi_ttm"] or 0.0)
    value = inp.value if inp.value is not None else (k["value"] or (noi / (market["cap_rate"] / 100) if noi else 0.0))
    sale_cost_pct = inp.sale_cost_pct if inp.sale_cost_pct is not None else market["sale_cost_pct"]
    exit_cap = inp.exit_cap_rate or a.exit_cap_rate or (market["cap_rate"] + 0.25)
    tsy = inp.treasury_rate if inp.treasury_rate is not None else market["treasury_rate"]
    n = inp.hold_years
    capex_basis = float(k["capex_total"] or 0)
    tax_basis = inp.tax_basis if inp.tax_basis is not None else float(a.basis or 0) + capex_basis
    annual_depr = tax_basis * (1 - inp.land_pct / 100) / inp.depreciation_years
    years_held = max(0.0, (today - a.acquired_on).days / 365.25) if a.acquired_on else 0.0
    acc_depr = inp.accumulated_depreciation if inp.accumulated_depreciation is not None else annual_depr * years_held
    rates = inp.model_dump(include={"cap_gains_rate", "recapture_rate", "state_rate", "niit_rate"})
    lease_term = inp.remaining_lease_term_years if inp.remaining_lease_term_years is not None else k["wale"]

    loans = ctx["loans"]
    balance = sum(x["balance"] for x, _ in loans)
    current_ds = sum(x["annual_debt_service"] for x, _ in loans)
    prepay_now = sum(calc.prepayment_cost(l, today, tsy)["cost"] * x["share"] for x, l in loans)
    lockouts = [loan_id for loan_id, ok in ((l.id, calc.prepayment_cost(l, today, tsy)["allowed"]) for _, l in loans) if not ok]
    maturities = [l.maturity_on for _, l in loans if l.maturity_on]
    first_maturity = min(maturities) if maturities else None

    # Sell now
    costs_now = value * sale_cost_pct / 100
    pre_tax_now = value - costs_now - balance - prepay_now
    tax_now = tax_estimate(value, costs_now, tax_basis, acc_depr, rates)
    after_tax_now = pre_tax_now - tax_now["total_tax"]

    def exit_block(hold_balance: float, prepay_exit: float) -> dict:
        exit_noi = noi * (1 + inp.noi_growth_pct / 100) ** (n + 1)
        exit_value = exit_noi / (exit_cap / 100)
        exit_costs = exit_value * sale_cost_pct / 100
        t = tax_estimate(exit_value, exit_costs, tax_basis + inp.capex_planned, acc_depr + annual_depr * n, rates)
        pre = exit_value - exit_costs - hold_balance - prepay_exit
        return {"exit_noi": r2(exit_noi), "exit_value": r2(exit_value), "exit_costs": r2(exit_costs),
                "loan_balance_at_exit": r2(hold_balance), "prepayment_at_exit": r2(prepay_exit),
                "pre_tax_proceeds": r2(pre), "tax": t, "after_tax_proceeds": r2(pre - t["total_tax"])}

    def scenario_flows(ds: float, start_equity: float, exit_after_tax: float) -> tuple[list[dict], list[float]]:
        rows, flows = [], [-start_equity]
        for y in range(1, n + 1):
            y_noi = noi * (1 + inp.noi_growth_pct / 100) ** y
            capex = inp.capex_planned / n
            cf = y_noi - ds - capex
            rows.append({"year": y, "noi": r2(y_noi), "debt_service": r2(ds), "capex": r2(capex), "cash_flow": r2(cf)})
            flows.append(cf + (exit_after_tax if y == n else 0))
        return rows, flows

    exit_on = add_months(today, 12 * n)
    hold_bal = sum(calc.balance_after(l, 12 * n, today) * x["share"] for x, l in loans)
    hold_prepay = sum(calc.prepayment_cost(l, exit_on, tsy)["cost"] * x["share"] for x, l in loans
                      if not l.maturity_on or l.maturity_on > exit_on)
    hold_exit = exit_block(hold_bal, hold_prepay)
    hold_rows, hold_flows = scenario_flows(current_ds, after_tax_now, hold_exit["after_tax_proceeds"])

    # Refinance now then hold
    r_rate = inp.refi_rate if inp.refi_rate is not None else market["rate"]
    r_amort = inp.refi_amort_years if inp.refi_amort_years is not None else market["amort_years"]
    sizing = calc.size_loan(noi, value, r_rate, r_amort,
                            inp.refi_ltv if inp.refi_ltv is not None else market["ltv"],
                            inp.refi_dscr if inp.refi_dscr is not None else market["dscr"],
                            inp.refi_debt_yield if inp.refi_debt_yield is not None else market["debt_yield"])
    new_loan = sizing["max_loan"] or 0.0
    refi_costs = new_loan * (inp.refi_cost_pct if inp.refi_cost_pct is not None else market["refi_cost_pct"]) / 100
    cash_out = new_loan - balance - prepay_now - refi_costs
    new_ds = sizing.get("annual_debt_service") or 0.0
    new_loan_terms = {"current_balance": new_loan, "rate": r_rate, "amortization_months": int(r_amort * 12) if r_amort else None,
                      "io_months": 0, "originated_on": today}
    refi_exit = exit_block(calc.balance_after(new_loan_terms, 12 * n, today), 0.0)
    refi_rows, refi_flows = scenario_flows(new_ds, after_tax_now - cash_out, refi_exit["after_tax_proceeds"])

    risks = []
    if lease_term is not None and lease_term < n:
        risks.append(f"Remaining lease term ({lease_term:.1f} years) is shorter than the {n}-year hold; rollover risk not modeled.")
    if first_maturity and first_maturity < exit_on:
        risks.append(f"Existing debt matures {first_maturity.isoformat()}, before the hold horizon; hold case assumes "
                     "an extension or refinance on similar terms.")
    if lockouts:
        risks.append("Prepayment is currently locked out on at least one loan; a sale now would require assumption or defeasance.")
    if cash_out < 0:
        risks.append(f"Refinance at market terms leaves a shortfall of {abs(cash_out):,.0f} that equity must fund.")

    result = {
        "computed_at": utcnow(), "inputs": {
            **inp.model_dump(), "value": r2(value), "noi": r2(noi), "exit_cap_rate": exit_cap, "sale_cost_pct": sale_cost_pct,
            "tax_basis": r2(tax_basis), "accumulated_depreciation": r2(acc_depr),
            "accumulated_depreciation_estimated": inp.accumulated_depreciation is None,
            "remaining_lease_term_years": r2(lease_term), "debt_balance": r2(balance), "debt_maturity": first_maturity,
            "prepayment_cost_now": r2(prepay_now), "treasury_rate": tsy, "refi_rate": r_rate,
        },
        "sell": {"label": "Sell now", "gross_price": r2(value), "selling_costs": r2(costs_now), "debt_payoff": r2(balance),
                 "prepayment_cost": r2(prepay_now), "pre_tax_proceeds": r2(pre_tax_now), "tax": tax_now,
                 "after_tax_proceeds": r2(after_tax_now),
                 "after_tax_if_1031": r2(pre_tax_now) if d.is_1031 else None},
        "hold": {"label": f"Hold {n} years", "annual": hold_rows, "exit": hold_exit,
                 "npv": r2(calc.npv(inp.discount_rate, hold_flows) + after_tax_now),
                 "irr_vs_sale": calc.irr(hold_flows), "total_cash_flow": r2(sum(r["cash_flow"] for r in hold_rows))},
        "refinance": {"label": f"Refinance, hold {n} years", "sizing": sizing, "new_loan": r2(new_loan),
                      "refi_costs": r2(refi_costs), "cash_out": r2(cash_out), "new_debt_service": r2(new_ds),
                      "annual": refi_rows, "exit": refi_exit,
                      "npv": r2(calc.npv(inp.discount_rate, refi_flows) + after_tax_now),
                      "irr_vs_sale": calc.irr(refi_flows), "total_cash_flow": r2(sum(r["cash_flow"] for r in refi_rows))},
        "risks": risks,
        "tax_note": TAX_NOTE,
        "method_note": ("NPV is the present value at the discount rate of the scenario's after-tax equity cash flows, "
                        "including any cash-out today; IRR treats today's after-tax sale proceeds as the equity retained."),
    }
    d.comparison = audit.to_jsonable(result)
    d.comparison_at = utcnow()
    d.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="disposition.compared", entity_type=ENTITY, entity_id=d.id,
                       summary=f"Sell {after_tax_now:,.0f} after tax vs hold NPV {result['hold']['npv']:,.0f}",
                       changes={"inputs": result["inputs"]}, ip_address=actor.ip_address)
    await db.commit()
    return d.comparison


async def proceeds(db: AsyncSession, d: Disposition) -> dict:
    from app.modules.assets import service as assets
    from app.modules.debt import calc
    from app.modules.debt.service import get_settings as debt_settings

    ctx = await _economics_context(db, d)
    a, k = ctx["asset"], ctx["kpis"]
    market = (await debt_settings(db))["market"]
    if d.sale_price:
        price, price_source = float(d.sale_price), "Final sale price"
    elif d.contract_price:
        price, price_source = float(d.contract_price), "Contract price (net of agreed retrades)"
    elif d.target_price:
        price, price_source = float(d.target_price), "Target price"
    else:
        price, price_source = float(k["value"] or 0), "Current value"
    close_on = d.closed_on or d.target_closing_on or date.today()
    tsy = float(market["treasury_rate"])

    cost_lines = [{"label": c.get("label"), "amount": float(c.get("amount") or 0)} for c in (d.cost_lines or [])]
    if d.commission_pct:
        cost_lines.insert(0, {"label": f"Brokerage commission ({d.commission_pct:g}%)", "amount": r2(price * d.commission_pct / 100)})
    costs = sum(c["amount"] for c in cost_lines)

    debt_lines, prepay_total, payoff_total, reserves_total = [], 0.0, 0.0, 0.0
    for x, l in ctx["loans"]:
        p = calc.prepayment_cost(l, close_on, tsy)
        share = x["share"]
        payoff_total += x["balance"]
        prepay_total += p["cost"] * share
        rel = ctx["reserves"].get(l.id, 0.0) * share
        reserves_total += rel
        debt_lines.append({"loan_id": l.id, "lender_name": x["lender_name"], "payoff": r2(x["balance"]),
                           "prepayment_cost": r2(p["cost"] * share), "prepayment_type": p["type"],
                           "prepayment_allowed": p["allowed"], "reserves_released": r2(rel), "href": f"/loans/{l.id}"})
    distributable = price - costs - payoff_total - prepay_total + reserves_total

    t_in = {**{"cap_gains_rate": 20, "recapture_rate": 25, "state_rate": 0, "niit_rate": 3.8}, **(d.tax_inputs or {})}
    basis = t_in.get("tax_basis")
    basis_source = "Tax inputs"
    if basis is None:
        basis, basis_source = float(a.basis or 0) + float(k["capex_total"] or 0), "Asset basis + capitalised capex"
    depr = t_in.get("accumulated_depreciation")
    tax = tax_estimate(price, costs, float(basis), float(depr or 0), t_in)
    ex = await db.scalar(select(Exchange1031).where(Exchange1031.disposition_id == d.id, Exchange1031.deleted_at.is_(None)))
    deferred = bool(d.is_1031 and ex and ex.status not in ("failed", "cancelled"))

    partners = None
    stakes = await assets.partner_stakes(db, {a.id})
    if stakes is not None:
        rows = stakes.get(a.id, [])
        partners = [{"partner_id": s["partner_id"], "name": s["name"], "ownership_pct": s["ownership_pct"],
                     "amount": r2(distributable * s["ownership_pct"] / 100), "href": f"/investors/{s['partner_id']}"}
                    for s in rows]
        allocated_pct = sum(s["ownership_pct"] for s in rows)
        if allocated_pct < 100:
            partners.append({"partner_id": None, "name": "Unallocated (no investor record)",
                             "ownership_pct": r2(100 - allocated_pct), "amount": r2(distributable * (100 - allocated_pct) / 100),
                             "href": None})

    recon = [
        {"label": f"Sale price · {price_source}", "amount": r2(price)},
        *[{"label": f"Less {c['label']}", "amount": r2(-c["amount"])} for c in cost_lines],
        *[{"label": f"Less loan payoff · {x['lender_name']}", "amount": r2(-x["payoff"]), "href": x["href"]} for x in debt_lines],
        *[{"label": f"Less prepayment cost · {x['lender_name']}", "amount": r2(-x["prepayment_cost"]), "href": x["href"]}
          for x in debt_lines if x["prepayment_cost"]],
        *[{"label": f"Plus lender reserves released · {x['lender_name']}", "amount": r2(x["reserves_released"]), "href": x["href"]}
          for x in debt_lines if x["reserves_released"]],
    ]
    recon_total = round(sum(x["amount"] for x in recon), 2)
    gain_recon = [
        {"label": "Sale price", "amount": r2(price)},
        {"label": "Less selling costs", "amount": r2(-costs)},
        {"label": "Amount realized", "amount": tax["amount_realized"], "subtotal": True},
        {"label": f"Less tax basis · {basis_source}", "amount": r2(-float(basis))},
        {"label": "Plus accumulated depreciation" + (" (not entered)" if depr is None else ""), "amount": r2(float(depr or 0))},
        {"label": "Gain on sale", "amount": tax["gain"], "subtotal": True},
    ]
    return {
        "price": r2(price), "price_source": price_source, "closing_on": close_on, "cost_lines": cost_lines,
        "selling_costs": r2(costs), "debt": debt_lines, "debt_payoff": r2(payoff_total), "prepayment_cost": r2(prepay_total),
        "reserves_released": r2(reserves_total), "distributable": r2(distributable),
        "reconciliation": recon, "reconciliation_total": recon_total,
        "reconciled": abs(recon_total - round(distributable, 2)) < 0.02,
        "gain_reconciliation": gain_recon, "tax": tax, "tax_deferred_1031": deferred,
        "after_tax_distributable": r2(distributable if deferred else distributable - (tax["total_tax"] or 0)),
        "partners": partners, "partners_unavailable": stakes is None,
        "partners_note": "Pro-rata by ownership percentage; the capital partner waterfall governs actual distributions.",
        "tax_note": TAX_NOTE,
        "drill": [{"label": "Asset", "href": f"/assets/{a.id}"}] + [{"label": f"Loan · {x['lender_name']}", "href": x["href"]} for x in debt_lines],
    }


# --------------------------------------------------------------------------- 1031 exchange

def exchange_deadlines(ex: Exchange1031) -> tuple[date | None, date | None]:
    if not ex.start_on:
        return None, None
    ident = add_days(ex.start_on, 45)
    repl = add_days(ex.start_on, 180)
    if ex.tax_return_due_on and ex.tax_return_due_on < repl:
        repl = ex.tax_return_due_on
    return ident, repl


async def schedule_exchange_dates(db: AsyncSession, d: Disposition, ex: Exchange1031, actor: Any) -> None:
    """Exchange deadlines are BLOCKING critical dates (fallback: tasks + alerts). Does not commit."""
    from app.modules.tasks.service import create_task, raise_alert

    ident, repl = exchange_deadlines(ex)
    ex.identification_deadline, ex.replacement_deadline = ident, repl
    if not ident:
        return
    for key, due, label, attr in (
        ("1031_identification", ident, "1031 identification deadline (45 days)", "id_critical_date_id"),
        ("1031_replacement", repl, "1031 replacement property deadline (180 days)", "replacement_critical_date_id"),
    ):
        full = f"{label} · {d.name}"
        try:
            from app.modules.contracts.service import upsert_critical_date

            cd = await upsert_critical_date(db, related_type="exchange_1031", related_id=ex.id, date_type=key, label=full,
                                            due_on=due, property_id=d.property_id, owner_id=d.owner_id, lead_days=15,
                                            is_blocking=True, source="rule", status="confirmed", key=key, actor=actor,
                                            related_label=d.name)
            setattr(ex, attr, cd.id)
        except ImportError:
            await raise_alert(db, title=full, reason=f"Statutory exchange deadline {due.isoformat()} cannot be extended.",
                              severity="critical", owner_id=d.owner_id, related_type="disposition", related_id=d.id,
                              related_label=d.name, rule_key="dispositions.1031_deadline", due_at=_due_dt(due),
                              idempotency_key=f"1031:{ex.id}:{key}:{due.isoformat()}")
        await create_task(db, title=full, assignee_id=d.owner_id, due_at=_due_dt(add_days(due, -7)), task_type="due_diligence",
                          priority="urgent", description=f"Hard deadline {due.isoformat()}.", related_type="disposition",
                          related_id=d.id, related_label=d.name, source="dispositions.1031",
                          idempotency_key=f"1031:{ex.id}:{key}:{due.isoformat()}", actor_id=getattr(actor, "id", None))


async def get_exchange(db: AsyncSession, d: Disposition) -> Exchange1031 | None:
    return await db.scalar(select(Exchange1031).where(Exchange1031.disposition_id == d.id, Exchange1031.deleted_at.is_(None)))


async def upsert_exchange(db: AsyncSession, d: Disposition, data: ExchangeIn, actor: CurrentUser) -> Exchange1031:
    ex = await get_exchange(db, d)
    values = data.model_dump(exclude_unset=True)
    if ex is None:
        ex = Exchange1031(disposition_id=d.id, status="planned", created_by_id=actor.id)
        db.add(ex)
        await db.flush()
        changes = values
        action = "disposition.exchange_created"
    else:
        changes = audit.diff(ex, values)
        action = "disposition.exchange_updated"
    for k, v in values.items():
        if k == "status" and v is None:
            continue
        setattr(ex, k, v)
    if ex.start_on is None and d.closed_on and ex.exchange_type == "forward":
        ex.start_on = d.closed_on
    if ex.start_on and ex.status == "planned":
        ex.status = "open"
    ex.updated_by_id = actor.id
    if not d.is_1031:
        d.is_1031 = True
    await schedule_exchange_dates(db, d, ex, actor)
    await audit.record(db, actor=actor, action=action, entity_type=ENTITY, entity_id=d.id, changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return ex


def _identified(cands: list[ExchangeCandidate]) -> list[ExchangeCandidate]:
    return [c for c in cands if c.status in ("identified", "under_contract", "acquired") and not c.deleted_at]


def exchange_analysis(ex: Exchange1031, cands: list[ExchangeCandidate]) -> dict:
    today = date.today()
    sale = float(ex.relinquished_sale_price or 0)
    costs = float(ex.relinquished_costs or 0)
    debt_paid = float(ex.relinquished_debt_paid or 0)
    basis = float(ex.relinquished_adjusted_basis or 0)
    cash_received = float(ex.cash_received or 0)
    added = float(ex.additional_cash_invested or 0)
    acquired = [c for c in cands if c.status == "acquired"]
    identified = _identified(cands)
    planned = acquired or [c for c in identified if not c.is_backup]
    repl_price = sum(float((c.acquired_price if c.status == "acquired" else c.expected_price) or 0) for c in planned)
    repl_debt = sum(float((c.acquired_debt if c.status == "acquired" else c.expected_debt) or 0) for c in planned)

    net_equity = sale - costs - debt_paid
    equity_reinvested = repl_price - repl_debt
    cash_boot = max(0.0, net_equity - equity_reinvested + added) if planned else max(0.0, net_equity)
    cash_boot = max(cash_boot, cash_received)
    mortgage_boot = max(0.0, debt_paid - repl_debt - added)
    total_boot = cash_boot + mortgage_boot
    realized = sale - costs - basis
    recognized = max(0.0, min(realized, total_boot))
    deferred = max(0.0, realized - recognized)
    replacement_basis = repl_price - deferred if repl_price else None

    warnings = []
    if ex.identification_rule == "three_property" and len(identified) > 3:
        warnings.append(f"{len(identified)} properties identified; the three-property rule allows at most 3 "
                        "(backups count toward the limit).")
    if ex.identification_rule == "two_hundred_percent":
        fmv = sum(float(c.expected_price or 0) for c in identified)
        if sale and fmv > 2 * sale:
            warnings.append(f"Identified value {fmv:,.0f} exceeds 200% of the relinquished price ({2 * sale:,.0f}).")
    if ex.identification_rule == "ninety_five_percent":
        fmv = sum(float(c.expected_price or 0) for c in identified)
        got = sum(float(c.acquired_price or 0) for c in acquired)
        if fmv and got < 0.95 * fmv:
            warnings.append("The 95% rule requires acquiring at least 95% of the identified value.")
    if sale and repl_price and repl_price < sale - costs:
        warnings.append("Replacement value is below the relinquished net sale price; boot is likely.")
    if repl_debt < debt_paid and added < debt_paid - repl_debt:
        warnings.append("Replacement debt is lower than debt paid off and not offset by added cash; mortgage boot results.")

    def countdown(dd: date | None) -> int | None:
        return (dd - today).days if dd else None

    return {
        "identification_deadline": ex.identification_deadline, "replacement_deadline": ex.replacement_deadline,
        "days_to_identification": countdown(ex.identification_deadline),
        "days_to_replacement": countdown(ex.replacement_deadline),
        "identification_open": bool(ex.identification_deadline and today <= ex.identification_deadline),
        "identified_count": len(identified), "backup_count": sum(1 for c in identified if c.is_backup),
        "replacement_price": r2(repl_price), "replacement_debt": r2(repl_debt),
        "net_equity_relinquished": r2(net_equity), "equity_reinvested": r2(equity_reinvested),
        "cash_boot": r2(cash_boot), "mortgage_boot": r2(mortgage_boot), "total_boot": r2(total_boot),
        "realized_gain": r2(realized), "recognized_gain": r2(recognized), "deferred_gain": r2(deferred),
        "replacement_basis": r2(replacement_basis), "warnings": warnings,
        "basis_note": "Replacement basis = replacement cost less deferred gain (carryover basis).",
        "tax_note": TAX_NOTE,
    }


async def exchange_out(db: AsyncSession, ex: Exchange1031) -> dict:
    cands = list(await db.scalars(select(ExchangeCandidate).where(ExchangeCandidate.exchange_id == ex.id,
                                                                  ExchangeCandidate.deleted_at.is_(None))
                                  .order_by(ExchangeCandidate.is_backup, ExchangeCandidate.rank)))
    props = await _props(db, {c.property_id for c in cands} | {ex.parked_property_id})
    cols = ("id", "disposition_id", "exchange_type", "status", "qi_organization_id", "qi_name", "eat_organization_id",
            "parked_property_id", "start_on", "identification_deadline", "replacement_deadline", "tax_return_due_on",
            "identification_rule", "relinquished_sale_price", "relinquished_costs", "relinquished_debt_paid",
            "relinquished_adjusted_basis", "cash_received", "additional_cash_invested", "improvement_budget",
            "improvement_notes", "id_critical_date_id", "replacement_critical_date_id", "notes", "updated_at")
    ccols = ("id", "property_id", "description", "is_backup", "rank", "status", "identified_on", "expected_price",
             "expected_debt", "acquired_on", "acquired_price", "acquired_debt", "notes")
    pp = props.get(ex.parked_property_id) if ex.parked_property_id else None
    return {
        **{c: getattr(ex, c) for c in cols},
        "parked_property_label": (pp.name or pp.address_line) if pp else None,
        "candidates": [{**{c: getattr(x, c) for c in ccols},
                        "property_label": ((props[x.property_id].name or props[x.property_id].address_line)
                                           if x.property_id in props else None)} for x in cands],
        "analysis": exchange_analysis(ex, cands),
    }


async def save_candidate(db: AsyncSession, ex: Exchange1031, data: CandidateIn, actor: CurrentUser,
                         cand: ExchangeCandidate | None = None) -> ExchangeCandidate:
    values = data.model_dump()
    if not values.get("property_id") and not values.get("description"):
        raise HTTPException(422, "Link a property or describe the replacement property")
    becoming_identified = values["status"] in ("identified", "under_contract", "acquired") and (
        cand is None or cand.status == "candidate")
    if becoming_identified and values["status"] == "identified":
        if ex.identification_deadline and date.today() > ex.identification_deadline:
            raise HTTPException(409, "The 45-day identification period has ended; no new identifications are allowed")
        if ex.identification_rule == "three_property":
            others = [c for c in await db.scalars(select(ExchangeCandidate).where(
                ExchangeCandidate.exchange_id == ex.id, ExchangeCandidate.deleted_at.is_(None)))
                if (cand is None or c.id != cand.id)]
            if len(_identified(others)) >= 3:
                raise HTTPException(409, "The three-property rule allows at most three identified properties, including backups")
    if cand is None:
        cand = ExchangeCandidate(exchange_id=ex.id, created_by_id=actor.id)
        db.add(cand)
        changes = values
    else:
        changes = audit.diff(cand, values)
    for k, v in values.items():
        setattr(cand, k, v)
    if becoming_identified and not cand.identified_on:
        cand.identified_on = date.today()
    cand.updated_by_id = actor.id
    if cand.status == "acquired" and ex.status in ("open", "identified"):
        ex.status = "identified"
    elif cand.status == "identified" and ex.status == "open":
        ex.status = "identified"
    await db.flush()
    await audit.record(db, actor=actor, action="disposition.exchange_candidate_saved", entity_type=ENTITY,
                       entity_id=ex.disposition_id, summary=cand.description or str(cand.property_id), changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return cand


# --------------------------------------------------------------------------- candidate queue

async def queue(db: AsyncSession) -> dict:
    from app.modules.assets import service as assets
    from app.modules.assets.models import Asset, WatchlistEntry

    rows = list(await db.scalars(select(Disposition).where(Disposition.deleted_at.is_(None), Disposition.stage == "candidate")
                                 .order_by(Disposition.created_at)))
    candidates = await to_items(db, rows)
    busy = set(await db.scalars(select(Disposition.asset_id).where(Disposition.deleted_at.is_(None),
                                                                  Disposition.stage.not_in(TERMINAL))))
    pool = [a for a in await db.scalars(select(Asset).where(Asset.deleted_at.is_(None),
                                                            Asset.status.in_(["active", "held_for_sale"])))
            if a.id not in busy]
    props = await assets.load_props(db, pool)
    loans = await assets.active_loans(db, pool)
    watch = await assets.open_watch_counts(db, {a.id for a in pool})
    today = date.today()
    suggestions = []
    for a in pool:
        reasons = []
        if a.status == "held_for_sale":
            reasons.append("Marked held for sale")
        if a.acquired_on and a.target_hold_years:
            target = add_months(a.acquired_on, int(round(a.target_hold_years * 12)))
            if target <= add_months(today, 6):
                reasons.append(f"Target hold period reached {target.isoformat()}")
        if a.target_exit_on and a.target_exit_on <= add_months(today, 6):
            reasons.append(f"Target exit {a.target_exit_on.isoformat()}")
        mats = [l["maturity_on"] for l in loans.get(a.id, []) if l["maturity_on"] and l["maturity_on"] <= add_months(today, 12)]
        if mats:
            reasons.append(f"Debt matures {min(mats).isoformat()}")
        if watch.get(a.id):
            reasons.append(f"{watch[a.id]} open watchlist item(s)")
        if reasons:
            p = props.get(a.property_id)
            suggestions.append({"asset_id": a.id, "property_id": a.property_id,
                                "property_label": (p.name or p.address_line) if p else "—",
                                "city": p.city if p else None, "state": p.state if p else None,
                                "reasons": reasons, "href": f"/assets/{a.id}"})
    return {"candidates": candidates, "suggestions": suggestions}
