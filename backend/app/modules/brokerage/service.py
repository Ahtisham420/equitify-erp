"""Brokerage CRM & listing management (spec module 25).

Workflow rules:
- Prospect stages prospect → pitched → engaged | lost. Pitched needs a pitch on record, engaged needs an active
  engagement agreement, lost needs a reason. BOV pitches must reference a comps valuation (verified comparables).
- Listing asking price and status are changed only through dedicated endpoints; every change appends a history row.
- Engagement / representation agreement expirations become critical dates (contracts engine).
- Brokerage deals carry the transaction workflow; agreement requirements can be overridden only with
  `brokerage:approve` and a reason. Commission release is gated by dealroom's transaction-file completeness check.
"""
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.brokerage.models import (
    ACTIVE_DEAL_STAGES,
    CADENCE_DAYS,
    DEAL_STAGES,
    LIVE_LISTING_STATUSES,
    ONBOARDING_TEMPLATE,
    PROSPECT_STAGES,
    RECRUIT_STAGES,
    STAGE_PROBABILITY,
    BrokerageDeal,
    BrokerageStatusEvent,
    EngagementAgreement,
    Inquiry,
    Listing,
    ListingPriceHistory,
    ListingProspect,
    MarketingItem,
    Proposal,
    ProspectPitch,
    Recruit,
    RepAgreement,
    RequirementMatch,
    RequirementProfile,
    SellerReport,
    Showing,
)
from app.modules.brokerage.schemas import (
    ConvertIn,
    DealBoardColumn,
    DealOut,
    EngagementOut,
    ListingCreate,
    ListingOut,
    PitchIn,
    PriceChangeIn,
    ProspectOut,
    RecruitOut,
    RepAgreementOut,
    StageMoveIn,
    StatusChangeIn,
    WorkspaceOut,
)

EMPTY = (None, "", [], {})


def today() -> date:
    return utcnow().date()


# ============================================================================ generic helpers


async def get_or_404(db: AsyncSession, model: Any, obj_id: uuid.UUID, label: str) -> Any:
    obj = await db.get(model, obj_id)
    if not obj or getattr(obj, "deleted_at", None):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    return obj


async def create_row(db: AsyncSession, model: Any, entity: str, values: dict, actor: CurrentUser,
                     summary: str | None = None) -> Any:
    obj = model(**values, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(obj)
    await db.flush()
    await audit.record(db, actor=actor, action=f"{entity}.created", entity_type=entity, entity_id=obj.id,
                       summary=summary, ip_address=actor.ip_address)
    return obj


async def patch_row(db: AsyncSession, obj: Any, entity: str, values: dict, actor: CurrentUser) -> dict:
    changes = audit.diff(obj, values)
    for k in changes:
        setattr(obj, k, values[k])
    if changes:
        obj.updated_by_id = actor.id
        await audit.record(db, actor=actor, action=f"{entity}.updated", entity_type=entity, entity_id=obj.id,
                           changes=changes, ip_address=actor.ip_address)
    return changes


async def archive_row(db: AsyncSession, obj: Any, entity: str, actor: CurrentUser) -> None:
    obj.deleted_at = utcnow()
    obj.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{entity}.archived", entity_type=entity, entity_id=obj.id,
                       ip_address=actor.ip_address)
    await db.commit()


async def status_event(db: AsyncSession, entity_type: str, entity_id: uuid.UUID, from_status: str | None,
                       to_status: str, actor: CurrentUser | None, reason: str | None = None) -> None:
    db.add(BrokerageStatusEvent(entity_type=entity_type, entity_id=entity_id, from_status=from_status,
                                to_status=to_status, reason=reason, actor_id=getattr(actor, "id", None),
                                actor_name=getattr(actor, "full_name", None)))


async def status_history(db: AsyncSession, entity_type: str, entity_id: uuid.UUID) -> list[BrokerageStatusEvent]:
    return list(await db.scalars(
        select(BrokerageStatusEvent).where(BrokerageStatusEvent.entity_type == entity_type,
                                           BrokerageStatusEvent.entity_id == entity_id)
        .order_by(BrokerageStatusEvent.at.desc())))


async def upsert_critical_date(db: AsyncSession, **kwargs: Any) -> uuid.UUID | None:
    """Shared critical-date engine (contracts module). Returns the critical date id, or None when unavailable."""
    try:
        from app.modules.contracts.service import upsert_critical_date as upsert
    except ImportError:
        return None
    cd = await upsert(db, **kwargs)
    return getattr(cd, "id", None)


async def link_document(db: AsyncSession, document_id: uuid.UUID | None, entity_type: str, entity_id: uuid.UUID,
                        actor: CurrentUser) -> None:
    if not document_id:
        return
    try:
        from app.modules.documents.service import link
    except ImportError:
        return
    await link(db, document_id, entity_type, entity_id, actor)


def require_override(problems: list[str], reason: str | None, actor: CurrentUser, what: str) -> bool:
    """True when an authorised override is used; raises when blocked."""
    if not problems:
        return False
    if not (reason and reason.strip()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            {"message": f"Requirements for {what} are not met: " + "; ".join(problems),
                             "unmet": problems})
    if not actor.can("brokerage", "approve"):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            {"message": "Overriding brokerage requirements needs brokerage approval permission",
                             "unmet": problems})
    return True


# ---------------------------------------------------------------------------- labels

LabelSpec = dict[str, tuple[str, str]]


async def _names(db: AsyncSession, kind: str, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    if kind == "user":
        return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())
    if kind == "property":
        from app.modules.properties.models import Property

        rows = (await db.execute(select(Property.id, Property.name, Property.address_line, Property.city)
                                 .where(Property.id.in_(ids)))).all()
        return {r.id: ", ".join(x for x in [r.name or r.address_line, r.city] if x) for r in rows}
    try:
        from app.modules.contacts.models import Organization, Person
    except ImportError:
        return {}
    if kind == "person":
        return dict((await db.execute(select(Person.id, Person.full_name).where(Person.id.in_(ids)))).all())
    if kind == "organization":
        return dict((await db.execute(select(Organization.id, Organization.name)
                                      .where(Organization.id.in_(ids)))).all())
    return {}


async def enrich(db: AsyncSession, items: list[BaseModel], spec: LabelSpec) -> list:
    """Resolve display labels for linked ids: spec = {id_attr: (kind, label_attr)}; first non-empty label wins."""
    wanted: dict[str, set] = defaultdict(set)
    for it in items:
        for attr, (kind, _) in spec.items():
            if (v := getattr(it, attr, None)):
                wanted[kind].add(v)
    names = {kind: await _names(db, kind, ids) for kind, ids in wanted.items()}
    for it in items:
        for attr, (kind, label) in spec.items():
            v = getattr(it, attr, None)
            if v and not getattr(it, label, None):
                setattr(it, label, names.get(kind, {}).get(v))
    return items


PARTY_SPEC: LabelSpec = {
    "property_id": ("property", "property_label"),
    "agent_id": ("user", "agent_name"),
}


def _days_until(d: date | None) -> int | None:
    return (d - today()).days if d else None


# ============================================================================ prospects


@dataclass
class ProspectFilters:
    q: str | None = None
    stage: list[str] | None = None
    market_status: list[str] | None = None
    agent_id: list[uuid.UUID] | None = None
    property_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    expiring_within_days: int | None = None
    mine: bool | None = None


def prospect_query(f: ProspectFilters, actor: CurrentUser, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(ListingProspect).where(ListingProspect.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [ListingProspect.title, ListingProspect.competitor_broker, ListingProspect.source,
                                     ListingProspect.notes])
    if "stage" not in skip:
        stmt = in_filter(stmt, ListingProspect.stage, f.stage)
    if "market_status" not in skip:
        stmt = in_filter(stmt, ListingProspect.market_status, f.market_status)
    if "agent_id" not in skip:
        stmt = in_filter(stmt, ListingProspect.agent_id, f.agent_id)
    if f.mine:
        stmt = stmt.where(ListingProspect.agent_id == actor.id)
    if f.property_id:
        stmt = stmt.where(ListingProspect.property_id == f.property_id)
    if f.person_id:
        stmt = stmt.where(ListingProspect.owner_person_id == f.person_id)
    if f.organization_id:
        stmt = stmt.where(ListingProspect.owner_organization_id == f.organization_id)
    if f.expiring_within_days is not None:
        stmt = stmt.where(ListingProspect.competitor_expires_on.is_not(None),
                          ListingProspect.competitor_expires_on <= today() + timedelta(days=f.expiring_within_days))
    return stmt


async def prospect_outs(db: AsyncSession, rows: list[ListingProspect]) -> list[ProspectOut]:
    if not rows:
        return []
    stats = {pid: (int(n), last) for pid, n, last in (await db.execute(
        select(ProspectPitch.prospect_id, func.count(), func.max(ProspectPitch.pitched_on))
        .where(ProspectPitch.prospect_id.in_([r.id for r in rows]), ProspectPitch.deleted_at.is_(None))
        .group_by(ProspectPitch.prospect_id))).all()}
    outs = []
    for r in rows:
        o = ProspectOut.model_validate(r)
        o.pitch_count, o.last_pitched_on = stats.get(r.id, (0, None))
        o.days_to_competitor_expiry = _days_until(r.competitor_expires_on)
        outs.append(o)
    return await enrich(db, outs, {**PARTY_SPEC, "owner_person_id": ("person", "person_label"),
                                   "owner_organization_id": ("organization", "organization_label")})


async def _default_title(db: AsyncSession, property_id: uuid.UUID | None, person_id: uuid.UUID | None,
                         org_id: uuid.UUID | None) -> str:
    for kind, v in (("property", property_id), ("organization", org_id), ("person", person_id)):
        if v:
            label = (await _names(db, kind, {v})).get(v)
            if label:
                return label
    return "Listing prospect"


async def create_prospect(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> ListingProspect:
    values = data.model_dump()
    if not (values.get("property_id") or values.get("owner_person_id") or values.get("owner_organization_id")):
        raise HTTPException(422, "Link the prospect to a property or an owner (person or organization)")
    if not values.get("title"):
        values["title"] = await _default_title(db, values.get("property_id"), values.get("owner_person_id"),
                                               values.get("owner_organization_id"))
    values["agent_id"] = values.get("agent_id") or actor.id
    p = await create_row(db, ListingProspect, "listing_prospect", values, actor, summary=values["title"])
    await status_event(db, "listing_prospect", p.id, None, p.stage, actor)
    await db.commit()
    return p


async def update_prospect(db: AsyncSession, p: ListingProspect, data: BaseModel, actor: CurrentUser) -> ListingProspect:
    values = data.model_dump(exclude_unset=True)
    if "title" in values and not values["title"]:
        values.pop("title")
    if "tags" in values and values["tags"] is None:
        values["tags"] = []
    if "market_status" in values and values["market_status"] is None:
        values.pop("market_status")
    await patch_row(db, p, "listing_prospect", values, actor)
    await db.commit()
    return p


async def prospect_problems(db: AsyncSession, p: ListingProspect, to_stage: str, lost_reason: str | None) -> list[str]:
    problems = []
    if to_stage == "pitched":
        n = await db.scalar(select(func.count()).select_from(ProspectPitch).where(
            ProspectPitch.prospect_id == p.id, ProspectPitch.deleted_at.is_(None)))
        if not n:
            problems.append("Record a pitch or BOV first")
    if to_stage == "engaged":
        n = await db.scalar(select(func.count()).select_from(EngagementAgreement).where(
            EngagementAgreement.prospect_id == p.id, EngagementAgreement.deleted_at.is_(None),
            EngagementAgreement.status == "active"))
        if not n:
            problems.append("An active engagement agreement is required")
    if to_stage == "lost" and not (lost_reason or p.lost_reason):
        problems.append("A lost reason is required")
    return problems


async def move_prospect(db: AsyncSession, p: ListingProspect, body: StageMoveIn, actor: CurrentUser) -> ListingProspect:
    if body.to_stage not in PROSPECT_STAGES:
        raise HTTPException(422, f"Unknown stage '{body.to_stage}'")
    if body.to_stage == p.stage:
        return p
    problems = await prospect_problems(db, p, body.to_stage, body.lost_reason)
    hard = [x for x in problems if "lost reason" in x]
    if hard:
        raise HTTPException(422, {"message": hard[0], "unmet": hard})
    override = require_override(problems, body.reason, actor, body.to_stage)
    old = p.stage
    p.stage, p.stage_entered_at, p.updated_by_id = body.to_stage, utcnow(), actor.id
    if body.to_stage == "lost":
        p.lost_reason = body.lost_reason or p.lost_reason
    await status_event(db, "listing_prospect", p.id, old, p.stage, actor,
                       ("Override: " if override else "") + (body.reason or "") or None)
    await audit.record(db, actor=actor, action="listing_prospect.stage_changed", entity_type="listing_prospect",
                       entity_id=p.id, changes={"stage": {"from": old, "to": p.stage}},
                       summary=f"Override: {body.reason}" if override else None, ip_address=actor.ip_address)
    await db.commit()
    return p


async def _comps_valuation(db: AsyncSession, property_id: uuid.UUID | None, bov_id: uuid.UUID | None) -> dict | None:
    """Values for a BOV from the comps module: an explicit valuation, else the property's latest one."""
    try:
        from app.modules.comps.models import Valuation
    except ImportError:
        Valuation = None  # noqa: N806
    if bov_id:
        if Valuation is None:
            raise HTTPException(422, "Comps module is unavailable; a BOV cannot be linked yet")
        v = await db.get(Valuation, bov_id)
        if not v:
            raise HTTPException(404, "Valuation not found")
        return {"bov_id": v.id, "comp_set_id": v.comp_set_id, "value_low": v.value_low, "value_point": v.value_point,
                "value_high": v.value_high, "valuation_method": v.method, "valuation_as_of": v.as_of}
    if not property_id:
        return None
    try:
        from app.modules.comps.service import latest_value
    except ImportError:
        return None
    lv = await latest_value(db, property_id)
    if not lv:
        return None
    out = {"value_low": lv.get("value_low"), "value_point": lv.get("value_point"), "value_high": lv.get("value_high"),
           "valuation_method": lv.get("method"), "valuation_as_of": lv.get("as_of")}
    if Valuation is not None:
        row = (await db.execute(select(Valuation.id, Valuation.comp_set_id)
                                .where(Valuation.property_id == property_id)
                                .order_by(Valuation.as_of.desc()).limit(1))).first()
        if row:
            out["bov_id"], out["comp_set_id"] = row.id, row.comp_set_id
    return out


async def add_pitch(db: AsyncSession, p: ListingProspect, data: PitchIn, actor: CurrentUser) -> ProspectPitch:
    values = data.model_dump()
    values["pitched_on"] = values.get("pitched_on") or today()
    if data.kind == "bov":
        comps = await _comps_valuation(db, p.property_id, data.bov_id)
        if not comps or not comps.get("bov_id"):
            raise HTTPException(422, "A BOV must be built from a comps valuation of verified comparables. "
                                     "Create the comp set and valuation in Comps first.")
        if isinstance(comps.get("valuation_as_of"), datetime):
            comps["valuation_as_of"] = comps["valuation_as_of"].date()
        values.update(comps)
    pitch = await create_row(db, ProspectPitch, "prospect_pitch", {**values, "prospect_id": p.id}, actor,
                             summary=f"{data.kind.upper()} for {p.title}")
    await link_document(db, data.document_id, "listing_prospect", p.id, actor)
    if p.stage == "prospect":
        await status_event(db, "listing_prospect", p.id, p.stage, "pitched", actor, "Pitch recorded")
        p.stage, p.stage_entered_at, p.updated_by_id = "pitched", utcnow(), actor.id
    if values.get("value_point") and not p.estimated_value:
        p.estimated_value = values["value_point"]
    await db.commit()
    return pitch


async def update_pitch(db: AsyncSession, pitch: ProspectPitch, data: BaseModel, actor: CurrentUser) -> ProspectPitch:
    values = data.model_dump(exclude_unset=True)
    # Comps-derived values on a BOV are a snapshot of the valuation and are not hand-edited.
    if pitch.kind == "bov":
        for k in ("bov_id", "comp_set_id", "value_low", "value_point", "value_high", "kind"):
            values.pop(k, None)
    values = {k: v for k, v in values.items() if not (k in ("kind", "outcome", "pitched_on") and v is None)}
    await patch_row(db, pitch, "prospect_pitch", values, actor)
    await db.commit()
    return pitch


async def convert_prospect(db: AsyncSession, p: ListingProspect, body: ConvertIn, actor: CurrentUser) -> Listing:
    if not p.property_id:
        raise HTTPException(422, "Link the prospect to a property before converting it to a listing")
    if p.listing_id:
        raise HTTPException(409, "This prospect already has a listing")
    ea = None
    if body.engagement_agreement_id:
        ea = await get_or_404(db, EngagementAgreement, body.engagement_agreement_id, "Engagement agreement")
    else:
        ea = await db.scalar(select(EngagementAgreement).where(
            EngagementAgreement.prospect_id == p.id, EngagementAgreement.deleted_at.is_(None),
            EngagementAgreement.status == "active").order_by(EngagementAgreement.created_at.desc()).limit(1))
    if not ea or ea.status != "active":
        raise HTTPException(422, "An active engagement agreement is required to create the listing")
    data = ListingCreate(property_id=p.property_id, prospect_id=p.id, engagement_agreement_id=ea.id,
                         agent_id=p.agent_id or actor.id, seller_person_id=p.owner_person_id,
                         seller_organization_id=p.owner_organization_id, listing_type=body.listing_type,
                         asking_price=body.asking_price, asking_rent_psf=body.asking_rent_psf,
                         listed_on=body.listed_on, expires_on=body.expires_on or ea.expires_on)
    listing = await _create_listing(db, data, actor)
    ea.listing_id = listing.id
    if p.stage != "engaged":
        await status_event(db, "listing_prospect", p.id, p.stage, "engaged", actor, "Converted to listing")
        p.stage, p.stage_entered_at = "engaged", utcnow()
    p.listing_id, p.updated_by_id = listing.id, actor.id
    await audit.record(db, actor=actor, action="listing_prospect.converted", entity_type="listing_prospect",
                       entity_id=p.id, changes={"listing_id": {"from": None, "to": str(listing.id)}},
                       ip_address=actor.ip_address)
    await db.commit()
    return listing


# ============================================================================ agreements


def _agreement_problems(values: dict) -> list[str]:
    problems = []
    if values.get("status") == "active":
        if not values.get("signed_on"):
            problems.append("Signed date is required for an active agreement")
        if not values.get("expires_on"):
            problems.append("Expiration date is required for an active agreement")
        structure = values.get("commission_structure") or "percent"
        if structure == "percent" and values.get("commission_rate") is None:
            problems.append("Commission rate is required")
        if structure == "flat" and values.get("commission_flat") is None:
            problems.append("Flat commission amount is required")
        if structure == "tiered" and not values.get("commission_tiers"):
            problems.append("Commission tiers are required")
    if values.get("starts_on") and values.get("expires_on") and values["expires_on"] < values["starts_on"]:
        problems.append("Expiration must be after the start date")
    return problems


def _snapshot(obj: Any, fields: list[str]) -> dict:
    return {f: getattr(obj, f, None) for f in fields}


AGREEMENT_FIELDS = ["status", "signed_on", "starts_on", "expires_on", "commission_structure", "commission_rate",
                    "commission_flat", "commission_tiers"]


async def _agreement_critical_date(db: AsyncSession, a: Any, related_type: str, label: str,
                                   actor: CurrentUser) -> None:
    if not a.expires_on or a.status in ("terminated",):
        return
    cd_id = await upsert_critical_date(
        db, related_type=related_type, related_id=a.id, date_type="agreement_expiration", label=label,
        due_on=a.expires_on, property_id=getattr(a, "property_id", None), owner_id=a.agent_id, lead_days=30,
        is_blocking=False, source="rule", status="confirmed", key="agreement_expiration", actor=actor)
    if cd_id:
        a.critical_date_id = cd_id


async def save_engagement(db: AsyncSession, data: BaseModel, actor: CurrentUser,
                          ea: EngagementAgreement | None = None) -> EngagementAgreement:
    values = data.model_dump(exclude_unset=ea is not None)
    values = {k: v for k, v in values.items() if not (ea is not None and v is None and k in
                                                      ("status", "exclusivity", "commission_structure",
                                                       "commission_tiers"))}
    merged = {**(_snapshot(ea, AGREEMENT_FIELDS) if ea else {}), **values}
    if problems := _agreement_problems(merged):
        raise HTTPException(422, {"message": "; ".join(problems), "unmet": problems})
    if ea is None:
        if values.get("prospect_id"):
            pr = await get_or_404(db, ListingProspect, values["prospect_id"], "Prospect")
            values["property_id"] = values.get("property_id") or pr.property_id
            values["client_person_id"] = values.get("client_person_id") or pr.owner_person_id
            values["client_organization_id"] = values.get("client_organization_id") or pr.owner_organization_id
        values["agent_id"] = values.get("agent_id") or actor.id
        ea = await create_row(db, EngagementAgreement, "engagement_agreement", values, actor)
    else:
        await patch_row(db, ea, "engagement_agreement", values, actor)
    await _agreement_critical_date(db, ea, "engagement_agreement", "Listing engagement expires", actor)
    await link_document(db, ea.document_id, "engagement_agreement", ea.id, actor)
    await db.commit()
    return ea


async def save_rep_agreement(db: AsyncSession, data: BaseModel, actor: CurrentUser,
                             ra: RepAgreement | None = None) -> RepAgreement:
    values = data.model_dump(exclude_unset=ra is not None)
    values = {k: v for k, v in values.items() if not (ra is not None and v is None and k in
                                                      ("kind", "status", "exclusivity", "commission_structure"))}
    merged = {**(_snapshot(ra, AGREEMENT_FIELDS) if ra else {}), **values}
    if problems := _agreement_problems(merged):
        raise HTTPException(422, {"message": "; ".join(problems), "unmet": problems})
    if not (merged.get("client_person_id") or merged.get("client_organization_id")
            or (ra and (ra.client_person_id or ra.client_organization_id))):
        raise HTTPException(422, "A representation agreement needs a client (person or organization)")
    if ra is None:
        values["agent_id"] = values.get("agent_id") or actor.id
        ra = await create_row(db, RepAgreement, "rep_agreement", values, actor)
    else:
        await patch_row(db, ra, "rep_agreement", values, actor)
    await _agreement_critical_date(db, ra, "rep_agreement", f"{ra.kind.title()} representation agreement expires",
                                   actor)
    await link_document(db, ra.document_id, "rep_agreement", ra.id, actor)
    await db.commit()
    return ra


CLIENT_SPEC: LabelSpec = {**PARTY_SPEC, "client_person_id": ("person", "person_label"),
                          "client_organization_id": ("organization", "organization_label")}


async def engagement_outs(db: AsyncSession, rows: list[EngagementAgreement]) -> list[EngagementOut]:
    outs = []
    for r in rows:
        o = EngagementOut.model_validate(r)
        o.days_to_expiry = _days_until(r.expires_on)
        outs.append(o)
    return await enrich(db, outs, CLIENT_SPEC)


async def rep_outs(db: AsyncSession, rows: list[RepAgreement]) -> list[RepAgreementOut]:
    outs = []
    for r in rows:
        o = RepAgreementOut.model_validate(r)
        o.days_to_expiry = _days_until(r.expires_on)
        outs.append(o)
    return await enrich(db, outs, CLIENT_SPEC)


# ============================================================================ listings


@dataclass
class ListingFilters:
    q: str | None = None
    status: list[str] | None = None
    listing_type: list[str] | None = None
    agent_id: list[uuid.UUID] | None = None
    property_id: uuid.UUID | None = None
    mine: bool | None = None
    min_price: float | None = None
    max_price: float | None = None
    min_dom: int | None = None
    max_dom: int | None = None


def dom_expr() -> Any:
    return func.coalesce(Listing.closed_on, func.current_date()) - Listing.listed_on


def listing_query(f: ListingFilters, actor: CurrentUser, *, skip: set[str] = frozenset()) -> Select:
    from app.modules.properties.models import Property

    stmt = (select(Listing).join(Property, Property.id == Listing.property_id)
            .where(Listing.deleted_at.is_(None)))
    stmt = apply_search(stmt, f.q, [Listing.headline, Property.name, Property.address_line, Property.city,
                                     Property.county])
    if "status" not in skip:
        stmt = in_filter(stmt, Listing.status, f.status)
    if "listing_type" not in skip:
        stmt = in_filter(stmt, Listing.listing_type, f.listing_type)
    if "agent_id" not in skip:
        stmt = in_filter(stmt, Listing.agent_id, f.agent_id)
    if f.mine:
        stmt = stmt.where(Listing.agent_id == actor.id)
    if f.property_id:
        stmt = stmt.where(Listing.property_id == f.property_id)
    stmt = range_filter(stmt, Listing.asking_price, f.min_price, f.max_price)
    return range_filter(stmt, dom_expr(), f.min_dom, f.max_dom)


def days_on_market(listing: Listing) -> int | None:
    if not listing.listed_on:
        return None
    return ((listing.closed_on or today()) - listing.listed_on).days


async def listing_outs(db: AsyncSession, rows: list[Listing]) -> list[ListingOut]:
    from app.modules.properties.models import Property

    if not rows:
        return []
    ids = [r.id for r in rows]
    props = {r.id: r for r in (await db.execute(
        select(Property.id, Property.city, Property.state, Property.property_type)
        .where(Property.id.in_({r.property_id for r in rows})))).all()}

    async def counts(model: Any, col: Any) -> dict:
        stmt = select(col, func.count()).where(col.in_(ids)).group_by(col)
        if hasattr(model, "deleted_at"):
            stmt = stmt.where(model.deleted_at.is_(None))
        return dict((await db.execute(stmt)).all())

    prices = await counts(ListingPriceHistory, ListingPriceHistory.listing_id)
    inquiries = await counts(Inquiry, Inquiry.listing_id)
    showings = await counts(Showing, Showing.listing_id)
    outs = []
    for r in rows:
        o = ListingOut.model_validate(r)
        p = props.get(r.property_id)
        if p:
            o.property_city, o.property_state, o.property_type = p.city, p.state, p.property_type
        o.days_on_market = days_on_market(r)
        o.price_change_count = max(0, int(prices.get(r.id, 0)) - 1)
        o.inquiry_count, o.showing_count = int(inquiries.get(r.id, 0)), int(showings.get(r.id, 0))
        outs.append(o)
    return await enrich(db, outs, {**PARTY_SPEC, "seller_person_id": ("person", "person_label"),
                                   "seller_organization_id": ("organization", "organization_label")})


async def _sync_property(db: AsyncSession, listing: Listing, actor: CurrentUser) -> None:
    """Listing activity is a material fact on the shared property record (status, asking price)."""
    from app.common.provenance import ProvenanceIn, apply_material
    from app.modules.properties.models import MATERIAL_FIELDS, Property
    from app.modules.properties.service import completeness

    p = await db.get(Property, listing.property_id)
    if not p or p.deleted_at:
        return
    data: dict[str, Any] = {}
    live = listing.status in LIVE_LISTING_STATUSES
    if live and listing.listing_type == "sale" and listing.asking_price is not None:
        data["asking_price"] = listing.asking_price
    if live and p.status != "listed":
        data["status"] = "listed"
    elif listing.status == "sold" and listing.listing_type == "sale":
        data["status"] = "sold"
        if listing.closed_price is not None:
            data["last_sale_price"] = listing.closed_price
        if listing.closed_on:
            data["last_sale_date"] = listing.closed_on
    elif listing.status in ("withdrawn", "expired") and p.status == "listed":
        data["status"] = "tracked"
    if not data:
        return
    prov = ProvenanceIn(source="Brokerage listing", observed_on=today(), confidence=0.95, verified=True)
    changes = await apply_material(db, p, entity_type="property", data=data, material_fields=MATERIAL_FIELDS,
                                   prov=prov, actor_id=actor.id)
    if changes:
        p.completeness_score = completeness(p)
        p.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="property.updated", entity_type="property", entity_id=p.id,
                           changes=changes, summary="Synced from brokerage listing", ip_address=actor.ip_address)
        await events.emit(db, "property.updated", property_id=p.id, changed=set(changes), actor=actor)


async def _create_listing(db: AsyncSession, data: ListingCreate, actor: CurrentUser) -> Listing:
    from app.modules.properties.service import get as get_property

    await get_property(db, data.property_id)
    dup = await db.scalar(select(Listing.id).where(
        Listing.property_id == data.property_id, Listing.deleted_at.is_(None),
        Listing.listing_type == data.listing_type, Listing.status.in_(["draft", *LIVE_LISTING_STATUSES])))
    if dup:
        raise HTTPException(409, {"message": "This property already has an open listing of this type",
                                  "existing": [str(dup)]})
    values = data.model_dump()
    values["agent_id"] = values.get("agent_id") or actor.id
    if values["status"] in LIVE_LISTING_STATUSES and not values.get("listed_on"):
        values["listed_on"] = today()
    if values.get("reporting_cadence") in CADENCE_DAYS and not values.get("next_report_on"):
        values["next_report_on"] = (values.get("listed_on") or today()) + timedelta(
            days=CADENCE_DAYS[values["reporting_cadence"]])
    listing = await create_row(db, Listing, "listing", values, actor)
    await status_event(db, "listing", listing.id, None, listing.status, actor)
    if listing.asking_price is not None or listing.asking_rent_psf is not None:
        db.add(ListingPriceHistory(listing_id=listing.id, price=listing.asking_price,
                                   rent_psf=listing.asking_rent_psf, effective_on=listing.listed_on or today(),
                                   reason="Initial asking price", source="Listing created", actor_id=actor.id,
                                   actor_name=actor.full_name))
    if listing.engagement_agreement_id:
        ea = await db.get(EngagementAgreement, listing.engagement_agreement_id)
        if ea and not ea.listing_id:
            ea.listing_id = listing.id
    await _sync_property(db, listing, actor)
    return listing


async def create_listing(db: AsyncSession, data: ListingCreate, actor: CurrentUser) -> Listing:
    listing = await _create_listing(db, data, actor)
    await db.commit()
    return listing


async def update_listing(db: AsyncSession, listing: Listing, data: BaseModel, actor: CurrentUser) -> Listing:
    values = data.model_dump(exclude_unset=True)
    for k in ("listing_type", "reporting_cadence"):
        if k in values and values[k] is None:
            values.pop(k)
    for k in ("highlights", "tags"):
        if k in values and values[k] is None:
            values[k] = []
    await patch_row(db, listing, "listing", values, actor)
    await db.commit()
    return listing


async def change_price(db: AsyncSession, listing: Listing, body: PriceChangeIn, actor: CurrentUser) -> Listing:
    if body.asking_price is None and body.asking_rent_psf is None:
        raise HTTPException(422, "Provide a new asking price or rent")
    if body.asking_price == listing.asking_price and body.asking_rent_psf in (None, listing.asking_rent_psf):
        raise HTTPException(422, "The asking price is unchanged")
    prev = listing.asking_price
    db.add(ListingPriceHistory(listing_id=listing.id, price=body.asking_price if body.asking_price is not None else prev,
                               previous_price=prev,
                               rent_psf=body.asking_rent_psf if body.asking_rent_psf is not None
                               else listing.asking_rent_psf,
                               effective_on=body.effective_on or today(), reason=body.reason, source=body.source,
                               actor_id=actor.id, actor_name=actor.full_name))
    changes: dict = {}
    if body.asking_price is not None and body.asking_price != prev:
        changes["asking_price"] = {"from": prev, "to": body.asking_price}
        listing.asking_price = body.asking_price
    if body.asking_rent_psf is not None and body.asking_rent_psf != listing.asking_rent_psf:
        changes["asking_rent_psf"] = {"from": listing.asking_rent_psf, "to": body.asking_rent_psf}
        listing.asking_rent_psf = body.asking_rent_psf
    listing.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="listing.price_changed", entity_type="listing", entity_id=listing.id,
                       changes=changes, summary=body.reason, ip_address=actor.ip_address)
    await _sync_property(db, listing, actor)
    await events.emit(db, "listing.price_changed", listing_id=listing.id, property_id=listing.property_id,
                      price=listing.asking_price, previous_price=prev, actor=actor)
    await db.commit()
    return listing


async def change_status(db: AsyncSession, listing: Listing, body: StatusChangeIn, actor: CurrentUser) -> Listing:
    if body.status == listing.status:
        return listing
    if body.status in ("sold", "leased"):
        closed_on = body.closed_on or listing.closed_on
        if not closed_on:
            raise HTTPException(422, "Closed date is required")
        listing.closed_on = closed_on
        if body.status == "sold":
            if body.closed_price is None and listing.closed_price is None:
                raise HTTPException(422, "Sale price is required")
        if body.closed_price is not None:
            listing.closed_price = body.closed_price
    if body.status in ("withdrawn", "expired") and not (body.reason and body.reason.strip()):
        raise HTTPException(422, "A reason is required when withdrawing or expiring a listing")
    if body.status in LIVE_LISTING_STATUSES and not listing.listed_on:
        listing.listed_on = today()
        if listing.reporting_cadence in CADENCE_DAYS and not listing.next_report_on:
            listing.next_report_on = today() + timedelta(days=CADENCE_DAYS[listing.reporting_cadence])
    old = listing.status
    listing.status, listing.status_changed_at, listing.updated_by_id = body.status, utcnow(), actor.id
    await status_event(db, "listing", listing.id, old, body.status, actor, body.reason)
    await audit.record(db, actor=actor, action="listing.status_changed", entity_type="listing", entity_id=listing.id,
                       changes={"status": {"from": old, "to": body.status}}, summary=body.reason,
                       ip_address=actor.ip_address)
    await _sync_property(db, listing, actor)
    await events.emit(db, "listing.status_changed", listing_id=listing.id, property_id=listing.property_id,
                      from_status=old, to_status=body.status, actor=actor)
    await db.commit()
    return listing


async def save_marketing(db: AsyncSession, listing: Listing, data: BaseModel, actor: CurrentUser,
                         item: MarketingItem | None = None) -> MarketingItem:
    values = data.model_dump(exclude_unset=item is not None)
    values = {k: v for k, v in values.items()
              if not (v is None and k in ("kind", "title", "status", "syndication_status"))}
    for k in ("channels", "document_ids"):
        if k in values and values[k] is None:
            values[k] = []
    publishing = values.get("status") == "published" or values.get("syndication_status") == "live"
    if publishing and item is not None:
        approved = await _ad_review_approved(db, item.id)
        if approved is False:
            raise HTTPException(422, "Advertising review approval is required before publishing or syndicating")
    elif publishing and item is None:
        raise HTTPException(422, "Create the item and get advertising approval before publishing")
    if values.get("syndication_status") == "live" and (item is None or item.syndication_status != "live"):
        values["syndicated_at"] = utcnow()
    if item is None:
        item = await create_row(db, MarketingItem, "marketing_item", {**values, "listing_id": listing.id}, actor,
                                summary=values.get("title"))
    else:
        await patch_row(db, item, "marketing_item", values, actor)
    for doc_id in item.document_ids or []:
        await link_document(db, doc_id, "listing", listing.id, actor)
    await db.commit()
    return item


async def _ad_review_approved(db: AsyncSession, marketing_item_id: uuid.UUID) -> bool | None:
    """None when the compliance module is unavailable (no gate), else whether an approved review exists."""
    try:
        from app.modules.dealroom.models import AdReview
    except ImportError:
        return None
    n = await db.scalar(select(func.count()).select_from(AdReview).where(
        AdReview.marketing_item_id == marketing_item_id, AdReview.status == "approved",
        AdReview.deleted_at.is_(None)))
    return bool(n)


async def ad_review_statuses(db: AsyncSession, item_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not item_ids:
        return {}
    try:
        from app.modules.dealroom.models import AdReview
    except ImportError:
        return {}
    out: dict[uuid.UUID, str] = {}
    for mid, st in (await db.execute(
            select(AdReview.marketing_item_id, AdReview.status)
            .where(AdReview.marketing_item_id.in_(item_ids), AdReview.deleted_at.is_(None))
            .order_by(AdReview.created_at.asc()))).all():
        out[mid] = st  # latest wins
    return out


# ---------------------------------------------------------------------------- inquiries & showings


async def create_inquiry(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> Inquiry:
    from app.modules.tasks.service import create_task

    values = data.model_dump()
    values["received_at"] = values.get("received_at") or utcnow()
    listing = None
    if values.get("listing_id"):
        listing = await get_or_404(db, Listing, values["listing_id"], "Listing")
        values["property_id"] = values.get("property_id") or listing.property_id
    if not (values.get("listing_id") or values.get("property_id")):
        raise HTTPException(422, "Link the inquiry to a listing or property")
    if not (values.get("person_id") or values.get("organization_id") or values.get("contact_name")):
        raise HTTPException(422, "Identify the prospect (person, organization or name)")
    values["assigned_to_id"] = values.get("assigned_to_id") or (listing.agent_id if listing else None) or actor.id
    inq = await create_row(db, Inquiry, "inquiry", values, actor, summary=values.get("contact_name"))
    who = values.get("contact_name")
    for kind, key in (("person", "person_id"), ("organization", "organization_id")):
        if not who and values.get(key):
            who = (await _names(db, kind, {values[key]})).get(values[key])
    due = values.get("follow_up_at") or utcnow() + timedelta(days=1)
    related_type, related_id = ("listing", listing.id) if listing else ("property", values["property_id"])
    label = (await _names(db, "property", {values["property_id"]})).get(values["property_id"])
    task = await create_task(
        db, title=f"Follow up inquiry from {who or 'prospect'}", assignee_id=inq.assigned_to_id, due_at=due,
        task_type="follow_up", description=values.get("message"), related_type=related_type, related_id=related_id,
        related_label=label, source="brokerage.inquiry", idempotency_key=f"brokerage:inquiry:{inq.id}",
        actor_id=actor.id)
    inq.follow_up_task_id, inq.follow_up_at = task.id, due
    await db.commit()
    return inq


async def save_showing(db: AsyncSession, data: BaseModel, actor: CurrentUser, s: Showing | None = None) -> Showing:
    values = data.model_dump(exclude_unset=s is not None)
    values = {k: v for k, v in values.items() if not (s is not None and v is None and k in ("status", "scheduled_at"))}
    if s is None:
        if values.get("listing_id"):
            listing = await get_or_404(db, Listing, values["listing_id"], "Listing")
            values["property_id"] = values.get("property_id") or listing.property_id
            values["shown_by_id"] = values.get("shown_by_id") or listing.agent_id
        if not (values.get("listing_id") or values.get("property_id")):
            raise HTTPException(422, "Link the showing to a listing or property")
        values["shown_by_id"] = values.get("shown_by_id") or actor.id
        s = await create_row(db, Showing, "showing", values, actor, summary=values.get("contact_name"))
        if s.inquiry_id:
            inq = await db.get(Inquiry, s.inquiry_id)
            if inq and inq.status in ("new", "contacted", "qualified", "nda_sent"):
                inq.status = "toured"
    else:
        await patch_row(db, s, "showing", values, actor)
    await db.commit()
    return s


async def record_showing_from_tour(db: AsyncSession, *, listing_id: uuid.UUID | None, property_id: uuid.UUID,
                                   tour_id: uuid.UUID, scheduled_at: datetime, person_id: uuid.UUID | None,
                                   organization_id: uuid.UUID | None, interest_level: str | None,
                                   feedback: str | None, actor: CurrentUser) -> Showing:
    """Used by dealroom when tour feedback is captured. Does not commit."""
    s = await db.scalar(select(Showing).where(Showing.tour_id == tour_id, Showing.property_id == property_id,
                                              Showing.deleted_at.is_(None)))
    if s is None:
        s = Showing(listing_id=listing_id, property_id=property_id, tour_id=tour_id, scheduled_at=scheduled_at,
                    person_id=person_id, organization_id=organization_id, shown_by_id=actor.id, status="completed",
                    created_by_id=actor.id, updated_by_id=actor.id)
        db.add(s)
        await db.flush()
    s.status, s.interest_level, s.feedback = "completed", interest_level, feedback
    await audit.record(db, actor=actor, action="showing.recorded", entity_type="showing", entity_id=s.id,
                       summary="From tour feedback", ip_address=actor.ip_address)
    return s


# ---------------------------------------------------------------------------- seller reports


async def _offer_summary(db: AsyncSession, listing_id: uuid.UUID, start: datetime, end: datetime) -> dict:
    try:
        from app.modules.dealroom.models import OfferSubmission
    except ImportError:
        return {"count": 0, "available": False}
    rows = (await db.execute(select(OfferSubmission.price, OfferSubmission.status).where(
        OfferSubmission.listing_id == listing_id, OfferSubmission.deleted_at.is_(None),
        OfferSubmission.submitted_at >= start, OfferSubmission.submitted_at < end))).all()
    prices = [float(r.price) for r in rows if r.price is not None]
    by_status: dict[str, int] = defaultdict(int)
    for r in rows:
        by_status[r.status] += 1
    return {"count": len(rows), "high": max(prices) if prices else None, "low": min(prices) if prices else None,
            "by_status": dict(by_status), "available": True}


async def generate_seller_report(db: AsyncSession, listing: Listing, actor: CurrentUser, *,
                                 period_start: date | None = None, period_end: date | None = None,
                                 commentary: str | None = None, commit: bool = True) -> SellerReport:
    end = period_end or today()
    if period_start is None:
        last = await db.scalar(select(func.max(SellerReport.period_end)).where(
            SellerReport.listing_id == listing.id, SellerReport.deleted_at.is_(None)))
        period_start = (last + timedelta(days=1)) if last else (listing.listed_on or end - timedelta(days=14))
    if period_start > end:
        raise HTTPException(422, "Report period start must be on or before its end")
    start_dt = datetime.combine(period_start, datetime.min.time(), tzinfo=utcnow().tzinfo)
    end_dt = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=utcnow().tzinfo)

    inq = (await db.execute(select(Inquiry.source, Inquiry.status).where(
        Inquiry.listing_id == listing.id, Inquiry.deleted_at.is_(None),
        Inquiry.received_at >= start_dt, Inquiry.received_at < end_dt))).all()
    shows = (await db.execute(select(Showing.status, Showing.interest_level, Showing.feedback).where(
        Showing.listing_id == listing.id, Showing.deleted_at.is_(None),
        Showing.scheduled_at >= start_dt, Showing.scheduled_at < end_dt))).all()
    prices = list(await db.scalars(select(ListingPriceHistory).where(
        ListingPriceHistory.listing_id == listing.id, ListingPriceHistory.at >= start_dt,
        ListingPriceHistory.at < end_dt).order_by(ListingPriceHistory.at)))
    live_channels = sorted({c for chans in await db.scalars(select(MarketingItem.channels).where(
        MarketingItem.listing_id == listing.id, MarketingItem.deleted_at.is_(None),
        MarketingItem.syndication_status == "live")) for c in (chans or [])})

    def tally(values: list) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        for v in values:
            if v:
                out[v] += 1
        return dict(out)

    summary = {
        "inquiries": {"count": len(inq), "by_source": tally([r.source for r in inq]),
                      "by_status": tally([r.status for r in inq])},
        "showings": {"count": len(shows), "completed": sum(1 for r in shows if r.status == "completed"),
                     "by_interest": tally([r.interest_level for r in shows]),
                     "feedback": [r.feedback for r in shows if r.feedback][:20]},
        "offers": await _offer_summary(db, listing.id, start_dt, end_dt),
        "price_changes": [{"effective_on": p.effective_on.isoformat(), "price": p.price,
                           "previous_price": p.previous_price, "reason": p.reason} for p in prices],
        "syndication_channels": live_channels,
        "asking_price": listing.asking_price,
        "status": listing.status,
        "days_on_market": days_on_market(listing),
    }
    report = await create_row(db, SellerReport, "seller_report", {
        "listing_id": listing.id, "period_start": period_start, "period_end": end, "summary": summary,
        "commentary": commentary, "generated_at": utcnow()}, actor, summary=f"{period_start} – {end}")
    if listing.reporting_cadence in CADENCE_DAYS:
        listing.next_report_on = end + timedelta(days=CADENCE_DAYS[listing.reporting_cadence])
    if commit:
        await db.commit()
    return report


async def run_due_reports(db: AsyncSession, actor: CurrentUser) -> int:
    """Generate reports for live listings whose cadence is due and task the agent to review and send them."""
    from app.modules.tasks.service import create_task

    due = list(await db.scalars(select(Listing).where(
        Listing.deleted_at.is_(None), Listing.status.in_(LIVE_LISTING_STATUSES),
        Listing.reporting_cadence.in_(list(CADENCE_DAYS)), Listing.next_report_on <= today())))
    for listing in due:
        report = await generate_seller_report(db, listing, actor, commit=False)
        label = (await _names(db, "property", {listing.property_id})).get(listing.property_id)
        await create_task(db, title=f"Review and send seller report: {label or 'listing'}",
                          assignee_id=listing.agent_id, due_at=utcnow() + timedelta(days=1), task_type="review",
                          related_type="listing", related_id=listing.id, related_label=label,
                          source="brokerage.seller_report", idempotency_key=f"brokerage:seller_report:{report.id}",
                          actor_id=actor.id)
    await db.commit()
    return len(due)


async def update_seller_report(db: AsyncSession, r: SellerReport, data: BaseModel, actor: CurrentUser) -> SellerReport:
    values = {k: v for k, v in data.model_dump(exclude_unset=True).items() if not (k == "status" and v is None)}
    if values.get("status") == "sent" and r.status != "sent":
        values["sent_at"] = utcnow()
    await patch_row(db, r, "seller_report", values, actor)
    await db.commit()
    return r


# ============================================================================ requirements & matching


async def run_match(db: AsyncSession, req: RequirementProfile, actor: CurrentUser) -> tuple[int, int, dict]:
    from app.modules.properties.models import Property
    from app.modules.properties.service import PropertyFilters, build_query

    f = PropertyFilters(
        property_type=req.property_types or None, state=req.states or None,
        min_area=req.min_size_sf, max_area=req.max_size_sf, min_acres=req.min_acres, max_acres=req.max_acres,
        min_price=req.min_price, max_price=req.max_price, near_lat=req.near_lat, near_lng=req.near_lng,
        radius_miles=req.radius_miles,
    )
    stmt = build_query(f)
    if req.cities:
        stmt = stmt.where(func.lower(Property.city).in_([c.lower() for c in req.cities]))
    if req.counties:
        stmt = stmt.where(func.lower(Property.county).in_([c.lower() for c in req.counties]))
    if req.territory_id:
        try:
            from app.modules.territories.models import TerritoryMember

            stmt = stmt.where(Property.id.in_(select(TerritoryMember.property_id)
                                              .where(TerritoryMember.territory_id == req.territory_id)))
        except ImportError:
            pass
    stmt = stmt.where(Property.status.notin_(["rejected"]))
    props = list(await db.scalars(stmt.order_by(Property.updated_at.desc()).limit(500)))
    existing = set(await db.scalars(select(RequirementMatch.property_id).where(
        RequirementMatch.requirement_id == req.id)))
    live = dict((await db.execute(select(Listing.property_id, Listing.id).where(
        Listing.property_id.in_([p.id for p in props]), Listing.deleted_at.is_(None),
        Listing.status.in_(LIVE_LISTING_STATUSES)))).all()) if props else {}
    criteria = {k: v for k, v in {
        "property_types": req.property_types, "states": req.states, "cities": req.cities, "counties": req.counties,
        "size_sf": [req.min_size_sf, req.max_size_sf], "acres": [req.min_acres, req.max_acres],
        "price": [req.min_price, req.max_price], "territory_id": str(req.territory_id) if req.territory_id else None,
        "radius_miles": req.radius_miles, "features": req.features,
    }.items() if v not in EMPTY and v != [None, None]}
    wanted = {x.lower() for x in req.features or []}
    added = 0
    for p in props:
        if p.id in existing:
            continue
        met = [k for k in criteria if k != "features"]
        met += [f"feature:{t}" for t in (p.tags or []) if t.lower() in wanted]
        db.add(RequirementMatch(requirement_id=req.id, property_id=p.id, listing_id=live.get(p.id),
                                status="suggested", criteria_met=met, created_by_id=actor.id,
                                updated_by_id=actor.id))
        added += 1
    req.last_matched_at = utcnow()
    await audit.record(db, actor=actor, action="requirement.matched", entity_type="requirement", entity_id=req.id,
                       summary=f"{added} new matches of {len(props)}", ip_address=actor.ip_address)
    await db.commit()
    return added, len(props), criteria


# ============================================================================ proposals


async def revise_proposal(db: AsyncSession, parent: Proposal, data: BaseModel, actor: CurrentUser) -> Proposal:
    if parent.status in ("superseded", "withdrawn"):
        raise HTTPException(409, "This proposal version can no longer be revised")
    base = {c: getattr(parent, c) for c in (
        "kind", "title", "brokerage_deal_id", "prospect_id", "listing_id", "requirement_id", "property_id",
        "recipient_person_id", "recipient_organization_id", "agent_id", "price", "rent_psf", "term_months",
        "commission_rate", "terms", "response_due_on", "document_id", "notes")}
    overrides = {k: v for k, v in data.model_dump(exclude_unset=True).items() if k in base}
    child = await create_row(db, Proposal, "proposal", {
        **base, **overrides, "version": parent.version + 1, "parent_proposal_id": parent.id, "status": "draft",
    }, actor, summary=f"Revision v{parent.version + 1}")
    old = parent.status
    parent.status, parent.updated_by_id = "superseded", actor.id
    await audit.record(db, actor=actor, action="proposal.superseded", entity_type="proposal", entity_id=parent.id,
                       changes={"status": {"from": old, "to": "superseded"}}, ip_address=actor.ip_address)
    await db.commit()
    return child


# ============================================================================ deals


@dataclass
class DealFilters:
    q: str | None = None
    stage: list[str] | None = None
    side: list[str] | None = None
    agent_id: list[uuid.UUID] | None = None
    property_id: uuid.UUID | None = None
    listing_id: uuid.UUID | None = None
    mine: bool | None = None
    closing_before: date | None = None


def deal_query(f: DealFilters, actor: CurrentUser, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(BrokerageDeal).where(BrokerageDeal.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [BrokerageDeal.title, BrokerageDeal.next_action, BrokerageDeal.notes])
    if "stage" not in skip:
        stmt = in_filter(stmt, BrokerageDeal.stage, f.stage)
    if "side" not in skip:
        stmt = in_filter(stmt, BrokerageDeal.side, f.side)
    if "agent_id" not in skip:
        stmt = in_filter(stmt, BrokerageDeal.agent_id, f.agent_id)
    if f.mine:
        stmt = stmt.where(BrokerageDeal.agent_id == actor.id)
    if f.property_id:
        stmt = stmt.where(BrokerageDeal.property_id == f.property_id)
    if f.listing_id:
        stmt = stmt.where(BrokerageDeal.listing_id == f.listing_id)
    if f.closing_before:
        stmt = stmt.where(BrokerageDeal.expected_close_on <= f.closing_before)
    return stmt


def effective_probability(d: BrokerageDeal) -> float:
    return float(d.probability) if d.probability is not None else float(STAGE_PROBABILITY.get(d.stage, 0))


def gross_commission(d: Any) -> float | None:
    if d.gross_commission_estimate is not None:
        return float(d.gross_commission_estimate)
    if d.deal_value is not None and d.commission_rate is not None:
        return round(float(d.deal_value) * float(d.commission_rate) / 100, 2)
    return None


async def deal_outs(db: AsyncSession, rows: list[BrokerageDeal], *, with_file: bool = False) -> list[DealOut]:
    outs = []
    for d in rows:
        o = DealOut.model_validate(d)
        o.effective_probability = effective_probability(d)
        g = gross_commission(d)
        o.gross_commission_estimate = g
        o.weighted_commission = round(g * o.effective_probability / 100, 2) if g is not None else None
        if with_file:
            try:
                from app.modules.dealroom.service import transaction_file_complete

                o.file_complete = (await transaction_file_complete(db, d.id))[0]
            except ImportError:
                o.file_complete = None
        outs.append(o)
    return await enrich(db, outs, CLIENT_SPEC)


async def create_deal(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> BrokerageDeal:
    values = data.model_dump()
    if values.get("listing_id") and not values.get("property_id"):
        listing = await get_or_404(db, Listing, values["listing_id"], "Listing")
        values["property_id"] = listing.property_id
    if not values.get("title"):
        values["title"] = await _default_title(db, values.get("property_id"), values.get("client_person_id"),
                                               values.get("client_organization_id"))
    if values.get("side") == "dual":
        values["is_dual_rep"] = True
    values["agent_id"] = values.get("agent_id") or actor.id
    if values.get("gross_commission_estimate") is None and values.get("deal_value") is not None \
            and values.get("commission_rate") is not None:
        values["gross_commission_estimate"] = round(values["deal_value"] * values["commission_rate"] / 100, 2)
    d = await create_row(db, BrokerageDeal, "brokerage_deal", values, actor, summary=values["title"])
    await status_event(db, "brokerage_deal", d.id, None, d.stage, actor)
    await db.commit()
    return d


async def update_deal(db: AsyncSession, d: BrokerageDeal, data: BaseModel, actor: CurrentUser) -> BrokerageDeal:
    values = data.model_dump(exclude_unset=True)
    for k in ("title", "side", "is_dual_rep"):
        if k in values and values[k] is None:
            values.pop(k)
    if "tags" in values and values["tags"] is None:
        values["tags"] = []
    if values.get("side") == "dual":
        values["is_dual_rep"] = True
    if ({"deal_value", "commission_rate"} & values.keys()) and "gross_commission_estimate" not in values:
        dv = values.get("deal_value", d.deal_value)
        cr = values.get("commission_rate", d.commission_rate)
        if dv is not None and cr is not None:
            values["gross_commission_estimate"] = round(float(dv) * float(cr) / 100, 2)
    await patch_row(db, d, "brokerage_deal", values, actor)
    await db.commit()
    return d


async def deal_problems(db: AsyncSession, d: BrokerageDeal, to_stage: str) -> tuple[list[str], list[str]]:
    """(hard, overridable) requirements for entering `to_stage`."""
    hard: list[str] = []
    soft: list[str] = []
    if to_stage == "lost":
        return hard, soft
    order = DEAL_STAGES.index(to_stage)
    if order >= DEAL_STAGES.index("engaged"):
        sides_need_rep = d.side in ("buyer", "tenant", "dual")
        sides_need_listing = d.side in ("listing", "landlord", "dual")
        if sides_need_rep:
            ok = False
            if d.rep_agreement_id:
                ra = await db.get(RepAgreement, d.rep_agreement_id)
                ok = bool(ra and not ra.deleted_at and ra.status == "active")
            if not ok:
                soft.append("Active buyer/tenant representation agreement")
        if sides_need_listing:
            ok = False
            if d.listing_id:
                listing = await db.get(Listing, d.listing_id)
                if listing and listing.engagement_agreement_id:
                    ea = await db.get(EngagementAgreement, listing.engagement_agreement_id)
                    ok = bool(ea and not ea.deleted_at and ea.status in ("active", "expired"))
            if not ok:
                soft.append("Listing with an active engagement agreement")
    if order >= DEAL_STAGES.index("under_contract") and d.deal_value is None:
        hard.append("Deal value is required from under contract onward")
    if to_stage == "closed":
        if not d.closed_on:
            hard.append("Closed date is required")
        if d.closed_price is None:
            hard.append("Closed price is required")
    return hard, soft


async def move_deal(db: AsyncSession, d: BrokerageDeal, body: StageMoveIn, actor: CurrentUser) -> BrokerageDeal:
    if body.to_stage not in DEAL_STAGES:
        raise HTTPException(422, f"Unknown stage '{body.to_stage}'")
    if body.to_stage == d.stage:
        return d
    if body.to_stage == "lost" and not (body.lost_reason or d.lost_reason):
        raise HTTPException(422, "A lost reason is required")
    hard, soft = await deal_problems(db, d, body.to_stage)
    if hard:
        raise HTTPException(422, {"message": "; ".join(hard), "unmet": hard})
    override = require_override(soft, body.reason, actor, body.to_stage.replace("_", " "))
    old = d.stage
    d.stage, d.stage_entered_at, d.updated_by_id = body.to_stage, utcnow(), actor.id
    if body.to_stage == "lost":
        d.lost_reason = body.lost_reason or d.lost_reason
    await status_event(db, "brokerage_deal", d.id, old, d.stage, actor,
                       ("Override: " if override else "") + (body.reason or "") or None)
    await audit.record(db, actor=actor, action="brokerage_deal.stage_changed", entity_type="brokerage_deal",
                       entity_id=d.id, changes={"stage": {"from": old, "to": d.stage}},
                       summary=f"Override: {body.reason}" if override else body.reason, ip_address=actor.ip_address)
    if d.stage in ("under_contract", "closing", "closed"):
        try:
            from app.modules.dealroom.service import ensure_transaction_file

            await ensure_transaction_file(db, d, actor)
        except ImportError:
            pass
    await events.emit(db, "brokerage_deal.stage_changed", brokerage_deal_id=d.id, from_stage=old, to_stage=d.stage,
                      actor=actor)
    if d.stage == "closed":
        await events.emit(db, "brokerage_deal.closed", brokerage_deal_id=d.id, actor=actor)
    await db.commit()
    return d


async def deal_board(db: AsyncSession, f: DealFilters, actor: CurrentUser, per_stage: int) -> list[DealBoardColumn]:
    base = deal_query(f, actor, skip={"stage"})
    cols = []
    for s in ACTIVE_DEAL_STAGES:
        rows = list(await db.scalars(base.where(BrokerageDeal.stage == s)
                                     .order_by(BrokerageDeal.expected_close_on.asc().nulls_last())))
        outs = await deal_outs(db, rows)
        cols.append(DealBoardColumn(stage=s, count=len(outs),
                                    gross_commission=sum(o.gross_commission_estimate or 0 for o in outs),
                                    weighted_commission=sum(o.weighted_commission or 0 for o in outs),
                                    items=outs[:per_stage]))
    return cols


async def workspace(db: AsyncSession, agent_id: uuid.UUID | None) -> WorkspaceOut:
    def scoped(model: Any, col: Any) -> list:
        conds = [model.deleted_at.is_(None)]
        if agent_id:
            conds.append(col == agent_id)
        return conds

    async def grouped(model: Any, col: Any, key: Any) -> dict[str, int]:
        return {str(k): int(v) for k, v in (await db.execute(
            select(key, func.count()).where(*scoped(model, col)).group_by(key))).all()}

    prospects = await grouped(ListingProspect, ListingProspect.agent_id, ListingProspect.stage)
    listings = await grouped(Listing, Listing.agent_id, Listing.status)
    deals = list(await db.scalars(select(BrokerageDeal).where(*scoped(BrokerageDeal, BrokerageDeal.agent_id))))
    by_stage: dict[str, int] = defaultdict(int)
    gross = weighted = expected90 = 0.0
    horizon = today() + timedelta(days=90)
    for d in deals:
        by_stage[d.stage] += 1
        if d.stage in ACTIVE_DEAL_STAGES:
            g = gross_commission(d) or 0
            gross += g
            weighted += g * effective_probability(d) / 100
            if d.expected_close_on and d.expected_close_on <= horizon:
                expected90 += g * effective_probability(d) / 100
    soon = today() + timedelta(days=30)
    expiring = 0
    for model in (EngagementAgreement, RepAgreement):
        expiring += int(await db.scalar(select(func.count()).select_from(model).where(
            *scoped(model, model.agent_id), model.status == "active", model.expires_on.is_not(None),
            model.expires_on <= soon)) or 0)
    inq_conds = [Inquiry.deleted_at.is_(None), Inquiry.status.in_(["new", "contacted"])]
    show_conds = [Showing.deleted_at.is_(None), Showing.status == "scheduled", Showing.scheduled_at >= utcnow()]
    if agent_id:
        inq_conds.append(Inquiry.assigned_to_id == agent_id)
        show_conds.append(Showing.shown_by_id == agent_id)
    overdue = sum(1 for d in deals if d.next_action_at and d.next_action_at < utcnow() and d.stage in
                  ACTIVE_DEAL_STAGES)
    return WorkspaceOut(
        agent_id=agent_id, prospects_by_stage=prospects, listings_by_status=listings, deals_by_stage=dict(by_stage),
        pipeline_gross=round(gross, 2), pipeline_weighted=round(weighted, 2), expected_close_90d=round(expected90, 2),
        expiring_agreements=expiring,
        open_inquiries=int(await db.scalar(select(func.count()).select_from(Inquiry).where(*inq_conds)) or 0),
        upcoming_showings=int(await db.scalar(select(func.count()).select_from(Showing).where(*show_conds)) or 0),
        overdue_actions=overdue,
    )


# ============================================================================ recruits


def onboarding_pct(items: list) -> float:
    if not items:
        return 0.0
    return round(100 * sum(1 for i in items if i.get("done")) / len(items), 1)


async def recruit_outs(db: AsyncSession, rows: list[Recruit]) -> list[RecruitOut]:
    names = await _names(db, "user", {r.recruiter_id for r in rows if r.recruiter_id})
    outs = []
    for r in rows:
        o = RecruitOut.model_validate(r)
        o.onboarding_pct = onboarding_pct(r.onboarding or [])
        o.recruiter_name = names.get(r.recruiter_id) if r.recruiter_id else None
        outs.append(o)
    return outs


def _checklist() -> list[dict]:
    return [{"key": k, "label": label, "done": False, "done_at": None, "done_by": None, "note": None}
            for k, label in ONBOARDING_TEMPLATE]


async def create_recruit(db: AsyncSession, data: BaseModel, actor: CurrentUser) -> Recruit:
    values = data.model_dump()
    values["recruiter_id"] = values.get("recruiter_id") or actor.id
    r = await create_row(db, Recruit, "recruit", values, actor, summary=values["full_name"])
    await status_event(db, "recruit", r.id, None, r.stage, actor)
    await db.commit()
    return r


async def move_recruit(db: AsyncSession, r: Recruit, body: StageMoveIn, actor: CurrentUser) -> Recruit:
    if body.to_stage not in RECRUIT_STAGES:
        raise HTTPException(422, f"Unknown stage '{body.to_stage}'")
    if body.to_stage == r.stage:
        return r
    problems = []
    if body.to_stage == "active":
        open_items = [i["label"] for i in (r.onboarding or []) if not i.get("done")]
        if not r.onboarding:
            problems.append("Onboarding checklist has not been started")
        elif open_items:
            problems.append("Onboarding incomplete: " + ", ".join(open_items))
    override = require_override(problems, body.reason, actor, "activation")
    old = r.stage
    r.stage, r.stage_entered_at, r.updated_by_id = body.to_stage, utcnow(), actor.id
    if body.to_stage in ("hired", "onboarding", "active") and not r.onboarding:
        r.onboarding = _checklist()
    await status_event(db, "recruit", r.id, old, r.stage, actor,
                       ("Override: " if override else "") + (body.reason or "") or None)
    await audit.record(db, actor=actor, action="recruit.stage_changed", entity_type="recruit", entity_id=r.id,
                       changes={"stage": {"from": old, "to": r.stage}}, ip_address=actor.ip_address)
    await db.commit()
    return r


async def toggle_checklist(db: AsyncSession, r: Recruit, key: str, done: bool, note: str | None,
                           actor: CurrentUser) -> Recruit:
    items = [dict(i) for i in (r.onboarding or _checklist())]
    match = next((i for i in items if i["key"] == key), None)
    if not match:
        raise HTTPException(404, "Checklist item not found")
    match.update(done=done, done_at=utcnow().isoformat() if done else None,
                 done_by=actor.full_name if done else None, note=note if note is not None else match.get("note"))
    r.onboarding, r.updated_by_id = items, actor.id
    await audit.record(db, actor=actor, action="recruit.onboarding_updated", entity_type="recruit", entity_id=r.id,
                       changes={key: {"from": not done, "to": done}}, ip_address=actor.ip_address)
    await db.commit()
    return r


# ============================================================================ documents (shared picker)


async def document_options(db: AsyncSession, q: str | None, limit: int = 15) -> list[dict]:
    try:
        from app.modules.documents.models import Document
    except ImportError:
        return []
    stmt = select(Document)
    if hasattr(Document, "deleted_at"):
        stmt = stmt.where(Document.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [Document.title, Document.filename])
    rows = list(await db.scalars(stmt.order_by(Document.created_at.desc()).limit(limit)))
    return [{"id": d.id, "title": d.title or d.filename, "filename": d.filename, "doc_class": d.doc_class}
            for d in rows]


async def document_option(db: AsyncSession, document_id: uuid.UUID) -> dict:
    try:
        from app.modules.documents.models import Document
    except ImportError:
        raise HTTPException(404, "Documents module unavailable")
    d = await db.get(Document, document_id)
    if not d:
        raise HTTPException(404, "Document not found")
    return {"id": d.id, "title": d.title or d.filename, "filename": d.filename, "doc_class": d.doc_class}


async def document_titles(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, dict]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    try:
        from app.modules.documents.models import Document
    except ImportError:
        return {}
    rows = await db.scalars(select(Document).where(Document.id.in_(ids)))
    return {d.id: {"id": d.id, "title": d.title or d.filename, "filename": d.filename, "doc_class": d.doc_class,
                   "mime_type": getattr(d, "mime_type", None)} for d in rows}


# ============================================================================ reassignment


async def reassign_user(db: AsyncSession, user_id: uuid.UUID, to_id: uuid.UUID) -> None:
    for model, col in ((ListingProspect, "agent_id"), (Listing, "agent_id"), (EngagementAgreement, "agent_id"),
                       (RepAgreement, "agent_id"), (RequirementProfile, "agent_id"), (Proposal, "agent_id"),
                       (BrokerageDeal, "agent_id"), (Recruit, "recruiter_id"), (Inquiry, "assigned_to_id")):
        column = getattr(model, col)
        await db.execute(update(model).where(column == user_id, model.deleted_at.is_(None)).values({col: to_id}))
