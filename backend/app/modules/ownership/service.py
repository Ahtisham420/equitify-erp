import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from itertools import combinations
from statistics import mean, median
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit, provenance
from app.common.normalize import normalize_address, normalize_name
from app.common.provenance import ProvenanceIn
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.ownership.models import CONTROL_RELATIONSHIPS, EntityLink, OwnerNote, OwnershipInterest
from app.modules.ownership.schemas import (
    ControlRelationship,
    EndInterestIn,
    InterestIn,
    InterestOut,
    InterestUpdate,
    LinkIn,
    LinkOut,
    LinkReviewIn,
    LinkUpdate,
    NoteIn,
    NoteOut,
    OwnerProfile,
    PanelOut,
    PanelOwner,
    PathStep,
    PortfolioItem,
    WarmPath,
)

ENTITY = "ownership_interest"
MATERIAL = {"interest_pct", "role", "effective_from", "effective_to", "acquired_price", "disposed_price"}
Node = tuple[str, uuid.UUID]

FREE_EMAIL_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "msn.com",
    "live.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "protonmail.com", "mail.com",
}
EVIDENCE_WEIGHTS = {
    "shared_mailing_address": 0.35, "shared_phone": 0.45, "shared_email_domain": 0.4, "registered_agent": 0.3,
}
MAX_GROUP = 15  # larger groups are shared infrastructure (agent services, office towers), not relationships


def _models():
    from app.modules.contacts.models import Affiliation, ContactPoint, Organization, Person
    from app.modules.properties.models import Property

    return Person, Organization, Affiliation, ContactPoint, Property


# ---------------------------------------------------------------- small helpers

def is_current(oi: OwnershipInterest, today: date | None = None) -> bool:
    return oi.effective_to is None or oi.effective_to > (today or date.today())


def hold_years(start: date | None, end: date | None = None) -> float | None:
    if not start:
        return None
    return round(max(0, ((end or date.today()) - start).days) / 365.25, 1)


def owner_id_of(oi: OwnershipInterest) -> uuid.UUID | None:
    return oi.owner_person_id or oi.owner_organization_id


def _norm_state(s: str | None) -> str:
    return (s or "").strip().upper()


def state_mismatch(owner_state: str | None, property_state: str | None) -> bool:
    return bool(owner_state and property_state and _norm_state(owner_state) != _norm_state(property_state))


def visible_evidence(items: list | None, show_sensitive: bool) -> tuple[list[dict], int]:
    items = items or []
    if show_sensitive:
        return list(items), 0
    shown = [e for e in items if not e.get("sensitive")]
    return shown, len(items) - len(shown)


def outbound_evidence(items: list | None) -> list[dict]:
    """Evidence safe to leave the system: sensitive entries are dropped entirely."""
    return [{k: v for k, v in e.items() if k != "sensitive"} for e in (items or []) if not e.get("sensitive")]


def signature(a: Node, b: Node) -> str:
    x, y = sorted([f"{a[0]}:{a[1]}", f"{b[0]}:{b[1]}"])
    return f"{x}|{y}"


def can_see_sensitive(user: CurrentUser) -> bool:
    return user.can("ownership", "view_sensitive")


async def node_info(db: AsyncSession, nodes: set[Node]) -> dict[Node, dict[str, Any]]:
    """Label + location for people, organizations and properties."""
    Person, Organization, _, _, Property = _models()
    out: dict[Node, dict[str, Any]] = {}
    by_kind: dict[str, set[uuid.UUID]] = defaultdict(set)
    for k, i in nodes:
        by_kind[k].add(i)
    if by_kind.get("person"):
        for p in await db.scalars(select(Person).where(Person.id.in_(list(by_kind["person"])))):
            out[("person", p.id)] = {"label": p.full_name, "subtitle": p.title, "city": p.city, "state": p.state,
                                     "mailing_address": p.mailing_address, "deleted": p.deleted_at is not None,
                                     "relationship_strength": p.relationship_strength, "last_touch_at": p.last_touch_at,
                                     "preferences": p.preferences or {}}
    if by_kind.get("organization"):
        for o in await db.scalars(select(Organization).where(Organization.id.in_(list(by_kind["organization"])))):
            out[("organization", o.id)] = {"label": o.name, "subtitle": o.legal_name or o.org_type, "city": o.city,
                                           "state": o.state, "mailing_address": o.mailing_address,
                                           "deleted": o.deleted_at is not None,
                                           "relationship_strength": o.relationship_strength,
                                           "last_touch_at": o.last_touch_at, "preferences": o.preferences or {}}
    if by_kind.get("property"):
        for p in await db.scalars(select(Property).where(Property.id.in_(list(by_kind["property"])))):
            out[("property", p.id)] = {"label": p.name or p.address_line, "subtitle": p.address_line, "city": p.city,
                                       "state": p.state, "property_type": p.property_type,
                                       "deleted": p.deleted_at is not None}
    return out


async def ensure_owner(db: AsyncSession, kind: str, owner_id: uuid.UUID) -> None:
    info = await node_info(db, {(kind, owner_id)})
    if (kind, owner_id) not in info or info[(kind, owner_id)]["deleted"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{kind.title()} not found")


# ---------------------------------------------------------------- interests

@dataclass
class InterestFilters:
    q: str | None = None
    property_id: uuid.UUID | None = None
    owner_kind: list[str] | None = None
    owner_id: uuid.UUID | None = None
    role: list[str] | None = None
    verification: list[str] | None = None
    current: bool | None = None
    state: list[str] | None = None
    mismatch: bool | None = None


def _owner_state_expr():
    Person, Organization, *_ = _models()
    return func.coalesce(Person.state, Organization.state)


def build_interest_query(f: InterestFilters, *, skip: set[str] = frozenset()) -> Select:
    Person, Organization, _, _, Property = _models()
    owner_state = _owner_state_expr()
    stmt = (
        select(OwnershipInterest)
        .join(Property, Property.id == OwnershipInterest.property_id)
        .outerjoin(Person, Person.id == OwnershipInterest.owner_person_id)
        .outerjoin(Organization, Organization.id == OwnershipInterest.owner_organization_id)
        .where(OwnershipInterest.deleted_at.is_(None), Property.deleted_at.is_(None))
    )
    stmt = apply_search(stmt, f.q, [Person.full_name, Organization.name, Organization.legal_name, Property.name,
                                    Property.address_line, Property.city])
    if f.property_id:
        stmt = stmt.where(OwnershipInterest.property_id == f.property_id)
    if f.owner_id:
        stmt = stmt.where(or_(OwnershipInterest.owner_person_id == f.owner_id,
                              OwnershipInterest.owner_organization_id == f.owner_id))
    if "owner_kind" not in skip:
        stmt = in_filter(stmt, OwnershipInterest.owner_kind, f.owner_kind)
    if "role" not in skip:
        stmt = in_filter(stmt, OwnershipInterest.role, f.role)
    if "verification" not in skip:
        stmt = in_filter(stmt, OwnershipInterest.verification, f.verification)
    stmt = in_filter(stmt, Property.state, f.state)
    current = or_(OwnershipInterest.effective_to.is_(None), OwnershipInterest.effective_to > date.today())
    if f.current is True:
        stmt = stmt.where(current)
    elif f.current is False:
        stmt = stmt.where(not_(current))
    if f.mismatch:
        stmt = stmt.where(owner_state.is_not(None), Property.state.is_not(None),
                          func.upper(func.trim(owner_state)) != func.upper(func.trim(Property.state)))
    return stmt


def interest_sorts() -> dict[str, Any]:
    Person, Organization, _, _, Property = _models()
    return {
        "effective_from": OwnershipInterest.effective_from, "effective_to": OwnershipInterest.effective_to,
        "interest_pct": OwnershipInterest.interest_pct, "acquired_price": OwnershipInterest.acquired_price,
        "confidence": OwnershipInterest.confidence, "role": OwnershipInterest.role,
        "owner": func.coalesce(Person.full_name, Organization.name), "property": Property.address_line,
        "updated_at": OwnershipInterest.updated_at,
    }


def with_labels(stmt: Select) -> Select:
    Person, Organization, _, _, Property = _models()
    return stmt.add_columns(
        Property.name, Property.address_line, Property.city, Property.state,
        func.coalesce(Person.full_name, Organization.name), _owner_state_expr(),
    )


def interest_out(oi: OwnershipInterest, *, show_sensitive: bool, owner_label: str | None = None,
                 owner_state: str | None = None, prop_label: str | None = None, prop_city: str | None = None,
                 prop_state: str | None = None) -> InterestOut:
    out = InterestOut.model_validate(oi)
    out.evidence, out.hidden_evidence = visible_evidence(oi.evidence, show_sensitive)
    out.owner_id = owner_id_of(oi)
    out.owner_label, out.owner_state = owner_label, owner_state
    out.property_label, out.property_city, out.property_state = prop_label, prop_city, prop_state
    out.is_current = is_current(oi)
    out.hold_years = hold_years(oi.effective_from, None if out.is_current else oi.effective_to)
    out.mismatch = state_mismatch(owner_state, prop_state)
    return out


def row_to_out(row: Any, show_sensitive: bool) -> InterestOut:
    oi, pname, paddr, pcity, pstate, olabel, ostate = row
    return interest_out(oi, show_sensitive=show_sensitive, owner_label=olabel, owner_state=ostate,
                        prop_label=pname or paddr, prop_city=pcity, prop_state=pstate)


async def get_interest(db: AsyncSession, interest_id: uuid.UUID) -> OwnershipInterest:
    oi = await db.get(OwnershipInterest, interest_id)
    if not oi or oi.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ownership interest not found")
    return oi


async def interest_full(db: AsyncSession, interest_id: uuid.UUID, user: CurrentUser) -> InterestOut:
    row = (await db.execute(with_labels(build_interest_query(InterestFilters()))
                            .where(OwnershipInterest.id == interest_id))).first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ownership interest not found")
    return row_to_out(row, can_see_sensitive(user))


def _prov(source: str | None, observed_on: date | None, confidence: float | None, verified: bool = False) -> ProvenanceIn:
    return ProvenanceIn(source=source or "Manual entry", observed_on=observed_on,
                        confidence=confidence if confidence is not None else 0.8, verified=verified)


async def _audit_interest(db: AsyncSession, actor: CurrentUser, oi: OwnershipInterest, verb: str,
                          summary: str | None = None, changes: dict | None = None) -> None:
    await audit.record(db, actor=actor, action=f"ownership_interest.{verb}", entity_type=ENTITY, entity_id=oi.id,
                       summary=summary, changes=changes, ip_address=actor.ip_address)
    await audit.record(db, actor=actor, action=f"property.ownership_{verb}", entity_type="property",
                       entity_id=oi.property_id, summary=summary, changes=changes, ip_address=actor.ip_address)


async def create_interest(db: AsyncSession, data: InterestIn, actor: CurrentUser) -> OwnershipInterest:
    _, _, _, _, Property = _models()
    prop = await db.get(Property, data.property_id)
    if not prop or prop.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    await ensure_owner(db, data.owner_kind, data.owner_id)
    if data.effective_from and data.effective_to and data.effective_to < data.effective_from:
        raise HTTPException(422, "Effective to must be on or after effective from")
    verified = data.verified
    oi = OwnershipInterest(
        property_id=data.property_id, owner_kind=data.owner_kind,
        owner_person_id=data.owner_id if data.owner_kind == "person" else None,
        owner_organization_id=data.owner_id if data.owner_kind == "organization" else None,
        interest_pct=data.interest_pct, role=data.role, effective_from=data.effective_from,
        effective_to=data.effective_to, acquired_price=data.acquired_price, financing_type=data.financing_type,
        deed_reference=data.deed_reference, evidence=[e.model_dump(mode="json") for e in data.evidence],
        source=data.source, observed_on=data.observed_on or date.today(), confidence=data.confidence,
        verification="verified" if verified else "unverified", verified_by_id=actor.id if verified else None,
        verified_at=utcnow() if verified else None, notes=data.notes, created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(oi)
    await db.flush()
    prov = _prov(data.source, data.observed_on, data.confidence, verified)
    for field in MATERIAL:
        value = getattr(oi, field)
        if value is not None:
            await provenance.observe(db, entity_type=ENTITY, entity_id=oi.id, field=field, value=value, prov=prov,
                                     actor_id=actor.id)
    info = await node_info(db, {(data.owner_kind, data.owner_id)})
    await _audit_interest(db, actor, oi, "added", summary=f"{info[(data.owner_kind, data.owner_id)]['label']} · "
                                                          f"{oi.role.replace('_', ' ')}")
    await events.emit(db, "ownership.changed", property_id=oi.property_id, interest_id=oi.id, actor=actor)
    await db.commit()
    return oi


async def update_interest(db: AsyncSession, oi: OwnershipInterest, data: InterestUpdate, actor: CurrentUser) -> OwnershipInterest:
    values = data.model_dump(exclude_unset=True, exclude={"evidence", "source", "observed_on", "confidence"})
    if data.evidence is not None:
        new = [e.model_dump(mode="json") for e in data.evidence]
        if not can_see_sensitive(actor):  # keep sensitive evidence the user could not see
            new += [e for e in (oi.evidence or []) if e.get("sensitive")]
        values["evidence"] = new
    if values.get("effective_from") and oi.effective_to and oi.effective_to < values["effective_from"]:
        raise HTTPException(422, "Effective from must be before the end date")
    prov = _prov(data.source or oi.source, data.observed_on, data.confidence if data.confidence is not None else oi.confidence)
    changes = await provenance.apply_material(db, oi, entity_type=ENTITY, data=values, material_fields=MATERIAL,
                                              prov=prov, actor_id=actor.id)
    for f in ("source", "observed_on", "confidence"):
        v = getattr(data, f)
        if f in data.model_fields_set and v is not None and getattr(oi, f) != v:
            changes[f] = {"from": audit.to_jsonable(getattr(oi, f)), "to": audit.to_jsonable(v)}
            setattr(oi, f, v)
    if not changes:
        return oi
    if MATERIAL & changes.keys() and oi.verification == "verified":
        oi.verification, oi.verified_by_id, oi.verified_at = "unverified", None, None
    oi.updated_by_id = actor.id
    if "evidence" in changes:
        changes["evidence"] = "updated"
    await _audit_interest(db, actor, oi, "updated", changes=changes)
    await events.emit(db, "ownership.changed", property_id=oi.property_id, interest_id=oi.id, actor=actor)
    await db.commit()
    return oi


async def end_interest(db: AsyncSession, oi: OwnershipInterest, data: EndInterestIn, actor: CurrentUser) -> OwnershipInterest:
    if oi.effective_to and oi.effective_to <= date.today():
        raise HTTPException(409, "This interest has already ended")
    if oi.effective_from and data.effective_to < oi.effective_from:
        raise HTTPException(422, "End date is before the interest began")
    values: dict[str, Any] = {"effective_to": data.effective_to}
    if data.disposed_price is not None:
        values["disposed_price"] = data.disposed_price
    changes = await provenance.apply_material(db, oi, entity_type=ENTITY, data=values, material_fields=MATERIAL,
                                              prov=_prov(data.source, data.effective_to, 0.9), actor_id=actor.id)
    oi.end_reason = data.reason
    oi.updated_by_id = actor.id
    await _audit_interest(db, actor, oi, "ended", summary=data.reason, changes=changes)
    await events.emit(db, "ownership.changed", property_id=oi.property_id, interest_id=oi.id, actor=actor)
    await db.commit()
    return oi


async def verify_interest(db: AsyncSession, oi: OwnershipInterest, state: str, actor: CurrentUser) -> OwnershipInterest:
    before = oi.verification
    oi.verification = state
    oi.verified_by_id = actor.id if state != "unverified" else None
    oi.verified_at = utcnow() if state != "unverified" else None
    oi.updated_by_id = actor.id
    await _audit_interest(db, actor, oi, state if state != "unverified" else "unverified",
                          changes={"verification": {"from": before, "to": state}})
    await db.commit()
    return oi


# ---------------------------------------------------------------- property ownership panel

async def _controllers(db: AsyncSession, owners: set[Node]) -> dict[Node, list[EntityLink]]:
    if not owners:
        return {}
    ids = [i for _, i in owners]
    rows = await db.scalars(select(EntityLink).where(
        EntityLink.deleted_at.is_(None), EntityLink.to_id.in_(ids), EntityLink.status != "rejected",
        EntityLink.relationship.in_(sorted(CONTROL_RELATIONSHIPS)),
        or_(EntityLink.effective_to.is_(None), EntityLink.effective_to > date.today()),
    ))
    out: dict[Node, list[EntityLink]] = defaultdict(list)
    for link in rows:
        if (link.to_kind, link.to_id) in owners:
            out[(link.to_kind, link.to_id)].append(link)
    return out


async def property_panel(db: AsyncSession, property_id: uuid.UUID, user: CurrentUser) -> PanelOut:
    _, _, _, _, Property = _models()
    prop = await db.get(Property, property_id)
    if not prop or prop.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Property not found")
    show = can_see_sensitive(user)
    contact_sensitive = user.can("contacts", "view_sensitive")
    rows = (await db.execute(
        with_labels(build_interest_query(InterestFilters(property_id=property_id)))
        .order_by(OwnershipInterest.effective_from.desc().nulls_last(), OwnershipInterest.created_at.desc())
    )).all()
    history = [row_to_out(r, show) for r in rows]
    current = [h for h in history if h.is_current and h.verification != "rejected"]
    owner_nodes: set[Node] = {(h.owner_kind, h.owner_id) for h in current if h.owner_id}
    info = await node_info(db, owner_nodes)
    controllers = await _controllers(db, owner_nodes)
    ctrl_labels = await node_info(db, {(l.from_kind, l.from_id) for ls in controllers.values() for l in ls})

    owners = []
    confirmed_conf: list[float] = []
    pending = 0
    for h in current:
        node = (h.owner_kind, h.owner_id)
        i = info.get(node, {})  # type: ignore[arg-type]
        ctrls = []
        for link in controllers.get(node, []):  # type: ignore[arg-type]
            if link.status == "confirmed":
                confirmed_conf.append(link.confidence)
            else:
                pending += 1
            ctrls.append(ControlRelationship(
                link_id=link.id, controller_kind=link.from_kind, controller_id=link.from_id,
                controller_label=ctrl_labels.get((link.from_kind, link.from_id), {}).get("label"),
                relationship=link.relationship, confidence=link.confidence, status=link.status,
            ))
        owners.append(PanelOwner(
            interest=h, mailing_address=i.get("mailing_address") if contact_sensitive else None,
            mailing_city=i.get("city"), mailing_state=i.get("state"), controllers=ctrls,
        ))
    starts = [h.effective_from for h in current if h.effective_from]
    latest = max(current, key=lambda h: h.effective_from or date.min, default=None)
    return PanelOut(
        property_id=prop.id, property_state=prop.state, current_owners=owners, history=history,
        hold_years=hold_years(min(starts)) if starts else None,
        acquired_on=latest.effective_from if latest else None, acquired_price=latest.acquired_price if latest else None,
        mismatch=any(h.mismatch for h in current), controlling_confidence=max(confirmed_conf) if confirmed_conf else None,
        pending_suggestions=pending, masked=not contact_sensitive,
    )


# ---------------------------------------------------------------- entity links

@dataclass
class LinkFilters:
    status: list[str] | None = None
    relationship: list[str] | None = None
    suggested_by: str | None = None
    node_id: uuid.UUID | None = None
    min_confidence: float | None = None


def build_link_query(f: LinkFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(EntityLink).where(EntityLink.deleted_at.is_(None))
    if "status" not in skip:
        stmt = in_filter(stmt, EntityLink.status, f.status)
    if "relationship" not in skip:
        stmt = in_filter(stmt, EntityLink.relationship, f.relationship)
    if f.suggested_by:
        stmt = stmt.where(EntityLink.suggested_by == f.suggested_by)
    if f.node_id:
        stmt = stmt.where(or_(EntityLink.from_id == f.node_id, EntityLink.to_id == f.node_id))
    if f.min_confidence is not None:
        stmt = stmt.where(EntityLink.confidence >= f.min_confidence)
    return stmt


async def links_out(db: AsyncSession, links: list[EntityLink], user: CurrentUser) -> list[LinkOut]:
    show = can_see_sensitive(user)
    info = await node_info(db, {n for link in links for n in ((link.from_kind, link.from_id), (link.to_kind, link.to_id))})
    out = []
    for link in links:
        item = LinkOut.model_validate(link)
        item.evidence, item.hidden_evidence = visible_evidence(link.evidence, show)
        item.from_label = info.get((link.from_kind, link.from_id), {}).get("label")
        item.to_label = info.get((link.to_kind, link.to_id), {}).get("label")
        out.append(item)
    return out


async def get_link(db: AsyncSession, link_id: uuid.UUID) -> EntityLink:
    link = await db.get(EntityLink, link_id)
    if not link or link.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Relationship not found")
    return link


async def _audit_link(db: AsyncSession, actor: CurrentUser, link: EntityLink, verb: str, changes: dict | None = None,
                      summary: str | None = None) -> None:
    await audit.record(db, actor=actor, action=f"entity_link.{verb}", entity_type="entity_link", entity_id=link.id,
                       changes=changes, summary=summary, ip_address=actor.ip_address)
    for kind, eid in ((link.from_kind, link.from_id), (link.to_kind, link.to_id)):
        await audit.record(db, actor=actor, action=f"{kind}.relationship_{verb}", entity_type=kind, entity_id=eid,
                           changes=changes, summary=summary or link.relationship, ip_address=actor.ip_address)


async def create_link(db: AsyncSession, data: LinkIn, actor: CurrentUser) -> EntityLink:
    a, b = (data.from_kind, data.from_id), (data.to_kind, data.to_id)
    if a == b:
        raise HTTPException(422, "A record cannot be linked to itself")
    if data.from_kind == "person" and data.to_kind == "person" and data.relationship not in ("family", "advisor"):
        raise HTTPException(422, "Person-to-person links are limited to family or advisor relationships")
    await ensure_owner(db, *a)
    await ensure_owner(db, *b)
    sig = signature(a, b)
    dup = await db.scalar(select(EntityLink).where(
        EntityLink.signature == sig, EntityLink.relationship == data.relationship, EntityLink.deleted_at.is_(None),
        EntityLink.status != "rejected",
    ))
    if dup:
        raise HTTPException(409, "This relationship already exists")
    link = EntityLink(
        from_kind=data.from_kind, from_id=data.from_id, to_kind=data.to_kind, to_id=data.to_id,
        relationship=data.relationship, confidence=data.confidence,
        evidence=[e.model_dump(mode="json") for e in data.evidence], source=data.source, suggested_by="user",
        signature=sig, status="confirmed" if data.confirmed else "suggested",
        reviewed_by_id=actor.id if data.confirmed else None, reviewed_at=utcnow() if data.confirmed else None,
        effective_from=data.effective_from, notes=data.notes, created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(link)
    await db.flush()
    await _audit_link(db, actor, link, "added")
    await db.commit()
    return link


async def update_link(db: AsyncSession, link: EntityLink, data: LinkUpdate, actor: CurrentUser) -> EntityLink:
    values = data.model_dump(exclude_unset=True, exclude={"evidence"})
    if data.evidence is not None:
        new = [e.model_dump(mode="json") for e in data.evidence]
        if not can_see_sensitive(actor):
            new += [e for e in (link.evidence or []) if e.get("sensitive")]
        values["evidence"] = new
    changes = audit.diff(link, values)
    if not changes:
        return link
    for k, v in values.items():
        setattr(link, k, v)
    link.updated_by_id = actor.id
    if "evidence" in changes:
        changes["evidence"] = "updated"
    await _audit_link(db, actor, link, "updated", changes=changes)
    await db.commit()
    return link


async def review_link(db: AsyncSession, link: EntityLink, decision: str, data: LinkReviewIn, actor: CurrentUser) -> EntityLink:
    if link.status != "suggested":
        raise HTTPException(409, f"This relationship is already {link.status}")
    changes: dict[str, Any] = {"status": {"from": link.status, "to": decision}}
    if decision == "confirmed":
        if data.reverse:
            link.from_kind, link.from_id, link.to_kind, link.to_id = link.to_kind, link.to_id, link.from_kind, link.from_id
            changes["direction"] = "reversed"
        if data.relationship and data.relationship != link.relationship:
            changes["relationship"] = {"from": link.relationship, "to": data.relationship}
            link.relationship = data.relationship
    link.status = decision
    link.reviewed_by_id, link.reviewed_at, link.review_note = actor.id, utcnow(), data.note
    link.updated_by_id = actor.id
    await _audit_link(db, actor, link, decision, changes=changes, summary=data.note)
    await events.emit(db, f"entity_link.{decision}", link_id=link.id, actor=actor)
    await db.commit()
    return link


# ---------------------------------------------------------------- suggestion engine

def _combine(evidence: list[dict]) -> float:
    miss = 1.0
    for t in {e["type"] for e in evidence}:
        miss *= 1 - EVIDENCE_WEIGHTS.get(t, 0.25)
    return round(1 - miss, 3)


async def suggest_links(db: AsyncSession, actor: CurrentUser) -> tuple[int, int]:
    """Propose relationships from shared mailing address / phone / email domain / registered agent.

    Suggestions land as status 'suggested' for human review; nothing is merged or confirmed automatically.
    """
    from app.modules.contacts.service import backfill_normalized, email_domain, norm_domain, norm_phone

    Person, Organization, Affiliation, ContactPoint, _ = _models()
    await backfill_normalized(db)
    groups: dict[tuple[str, str], set[Node]] = defaultdict(set)
    agent_people: dict[str, set[Node]] = defaultdict(set)

    for pid, name, addr, city, st, postal, phone, email in (await db.execute(
        select(Person.id, Person.normalized_name, Person.mailing_address, Person.city, Person.state, Person.postal_code,
               Person.primary_phone, Person.primary_email).where(Person.deleted_at.is_(None))
    )).all():
        node = ("person", pid)
        if addr:
            groups[("shared_mailing_address", normalize_address(addr, city, st, postal))].add(node)
        if phone and norm_phone(phone):
            groups[("shared_phone", norm_phone(phone))].add(node)
        d = email_domain(email)
        if d and d not in FREE_EMAIL_DOMAINS:
            groups[("shared_email_domain", d)].add(node)
        if name:
            agent_people[name].add(node)

    for oid, addr, city, st, postal, phone, domain, website, agent in (await db.execute(
        select(Organization.id, Organization.mailing_address, Organization.city, Organization.state,
               Organization.postal_code, Organization.phone, Organization.domain, Organization.website,
               Organization.registered_agent).where(Organization.deleted_at.is_(None))
    )).all():
        node = ("organization", oid)
        if addr:
            groups[("shared_mailing_address", normalize_address(addr, city, st, postal))].add(node)
        if phone and norm_phone(phone):
            groups[("shared_phone", norm_phone(phone))].add(node)
        d = norm_domain(domain or website)
        if d and d not in FREE_EMAIL_DOMAINS:
            groups[("shared_email_domain", d)].add(node)
        if agent and normalize_name(agent):
            key = normalize_name(agent)
            groups[("registered_agent", key)].add(node)
            groups[("registered_agent", key)] |= agent_people.get(key, set())

    for kind, value, pid, oid in (await db.execute(
        select(ContactPoint.kind, ContactPoint.normalized_value, ContactPoint.person_id, ContactPoint.organization_id)
        .where(ContactPoint.deleted_at.is_(None))
    )).all():
        if not pid and not oid:
            continue
        node = ("person", pid) if pid else ("organization", oid)
        if kind == "phone" and value:
            groups[("shared_phone", value)].add(node)
        elif kind == "email":
            d = email_domain(value)
            if d and d not in FREE_EMAIL_DOMAINS:
                groups[("shared_email_domain", d)].add(node)

    today = date.today().isoformat()
    pairs: dict[tuple[Node, Node], list[dict]] = defaultdict(list)
    for (etype, value), nodes in groups.items():
        if len(nodes) < 2 or len(nodes) > MAX_GROUP:
            continue
        for a, b in combinations(sorted(nodes, key=lambda n: (n[0], str(n[1]))), 2):
            if a[0] == "person" and b[0] == "person":
                continue  # person↔person ties (family) are never inferred automatically
            pairs[(a, b)].append({"type": etype, "detail": value, "source": "Suggestion engine",
                                  "observed_on": today, "sensitive": False})
    if not pairs:
        return 0, 0

    affiliated = {
        (("organization", o), ("person", p)) for p, o in (await db.execute(
            select(Affiliation.person_id, Affiliation.organization_id).where(Affiliation.deleted_at.is_(None))
        )).all()
    }
    existing: dict[str, list[EntityLink]] = defaultdict(list)
    for link in await db.scalars(select(EntityLink).where(EntityLink.deleted_at.is_(None))):
        existing[link.signature].append(link)

    created = updated = 0
    for (a, b), evidence in pairs.items():
        if (a, b) in affiliated or (b, a) in affiliated:
            continue
        sig = signature(a, b)
        prior = existing.get(sig, [])
        if any(link.status in ("confirmed", "rejected") for link in prior):
            continue
        person = a if a[0] == "person" else b if b[0] == "person" else None
        is_agent = person is not None and any(e["type"] == "registered_agent" for e in evidence)
        relationship = "registered_agent" if is_agent else "affiliate"
        frm, to = (person, b if person == a else a) if person else (a, b)
        conf = 0.6 if is_agent else _combine(evidence)
        open_link = next((link for link in prior if link.status == "suggested"), None)
        if open_link:
            if open_link.suggested_by == "engine":
                open_link.evidence, open_link.confidence = evidence, conf
                updated += 1
            continue
        db.add(EntityLink(
            from_kind=frm[0], from_id=frm[1], to_kind=to[0], to_id=to[1], relationship=relationship,
            confidence=conf, status="suggested", evidence=evidence, source="Suggestion engine", suggested_by="engine",
            signature=sig, created_by_id=actor.id, updated_by_id=actor.id,
        ))
        created += 1
    await audit.record(db, actor=actor, action="entity_link.suggestions_run", entity_type="entity_link",
                       summary=f"{created} new, {updated} refreshed", ip_address=actor.ip_address)
    await db.commit()
    return created, updated


# ---------------------------------------------------------------- owner notes

async def notes_for(db: AsyncSession, kind: str, owner_id: uuid.UUID, user: CurrentUser) -> tuple[list[OwnerNote], int]:
    rows = list(await db.scalars(select(OwnerNote).where(
        OwnerNote.owner_kind == kind, OwnerNote.owner_id == owner_id, OwnerNote.deleted_at.is_(None),
    ).order_by(OwnerNote.created_at.desc())))
    if can_see_sensitive(user):
        return rows, 0
    shown = [n for n in rows if not n.sensitive]
    return shown, len(rows) - len(shown)


async def add_note(db: AsyncSession, kind: str, owner_id: uuid.UUID, data: NoteIn, actor: CurrentUser) -> OwnerNote:
    await ensure_owner(db, kind, owner_id)
    note = OwnerNote(owner_kind=kind, owner_id=owner_id, **data.model_dump(), created_by_id=actor.id,
                     updated_by_id=actor.id)
    db.add(note)
    await db.flush()
    # The audit trail never carries the text of a sensitive note.
    await audit.record(db, actor=actor, action=f"{kind}.owner_note_added", entity_type=kind, entity_id=owner_id,
                       summary=f"{data.category.replace('_', ' ')} note" + (" (sensitive)" if data.sensitive else ""),
                       ip_address=actor.ip_address)
    await db.commit()
    return note


async def remove_note(db: AsyncSession, note_id: uuid.UUID, actor: CurrentUser) -> None:
    note = await db.get(OwnerNote, note_id)
    if not note or note.deleted_at:
        raise HTTPException(404, "Note not found")
    if note.sensitive and not can_see_sensitive(actor):
        raise HTTPException(403, "Missing permission ownership:view_sensitive")
    note.deleted_at = utcnow()
    note.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{note.owner_kind}.owner_note_removed", entity_type=note.owner_kind,
                       entity_id=note.owner_id, summary=f"{note.category.replace('_', ' ')} note",
                       ip_address=actor.ip_address)
    await db.commit()


# ---------------------------------------------------------------- owner portfolio / profile

async def _portfolio(db: AsyncSession, owners: list[Node]) -> list[tuple[Node, PortfolioItem]]:
    _, _, _, _, Property = _models()
    if not owners:
        return []
    pids = [i for k, i in owners if k == "person"]
    oids = [i for k, i in owners if k == "organization"]
    rows = (await db.execute(
        select(OwnershipInterest, Property).join(Property, Property.id == OwnershipInterest.property_id)
        .where(OwnershipInterest.deleted_at.is_(None), Property.deleted_at.is_(None),
               OwnershipInterest.verification != "rejected",
               or_(OwnershipInterest.owner_person_id.in_(pids), OwnershipInterest.owner_organization_id.in_(oids)))
        .order_by(OwnershipInterest.effective_from.desc().nulls_last())
    )).all()
    out = []
    for oi, prop in rows:
        cur = is_current(oi)
        out.append(((oi.owner_kind, owner_id_of(oi)), PortfolioItem(  # type: ignore[arg-type]
            interest_id=oi.id, property_id=prop.id, property_label=prop.name or prop.address_line, city=prop.city,
            state=prop.state, property_type=prop.property_type, role=oi.role, interest_pct=oi.interest_pct,
            effective_from=oi.effective_from, effective_to=oi.effective_to, acquired_price=oi.acquired_price,
            disposed_price=oi.disposed_price, financing_type=oi.financing_type,
            hold_years=hold_years(oi.effective_from, None if cur else oi.effective_to), is_current=cur,
            verification=oi.verification,
        )))
    return out


async def owner_profile(db: AsyncSession, kind: str, owner_id: uuid.UUID, user: CurrentUser) -> OwnerProfile:
    from app.modules.contacts.service import context as contact_context

    node: Node = (kind, owner_id)
    info = (await node_info(db, {node})).get(node)
    if not info or info["deleted"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{kind.title()} not found")

    own = [item for _, item in await _portfolio(db, [node])]
    current = [i for i in own if i.is_current]
    prior = [i for i in own if not i.is_current]

    link_rows = list(await db.scalars(select(EntityLink).where(
        EntityLink.deleted_at.is_(None), EntityLink.status != "rejected",
        or_(EntityLink.from_id == owner_id, EntityLink.to_id == owner_id),
    ).order_by(EntityLink.status, EntityLink.confidence.desc())))
    controlled_nodes = [(l.to_kind, l.to_id) for l in link_rows
                        if l.status == "confirmed" and l.from_id == owner_id and l.relationship in CONTROL_RELATIONSHIPS
                        and (l.effective_to is None or l.effective_to > date.today())]
    controlled_info = await node_info(db, set(controlled_nodes))
    controlled = []
    for via, item in await _portfolio(db, controlled_nodes):
        if item.is_current:
            item.via_kind, item.via_id = via[0], via[1]
            item.via_label = controlled_info.get(via, {}).get("label")
            controlled.append(item)

    completed = [i.hold_years for i in prior if i.hold_years is not None]
    running = [i.hold_years for i in current if i.hold_years is not None]
    financing: dict[str, int] = defaultdict(int)
    for i in own:
        financing[i.financing_type or "unknown"] += 1
    acquired = [i.acquired_price for i in own if i.acquired_price is not None]

    notes, hidden = await notes_for(db, kind, owner_id, user)
    ctx = await contact_context(db, kind, owner_id)
    contact_sensitive = user.can("contacts", "view_sensitive")
    return OwnerProfile(
        kind=kind, id=owner_id, label=info["label"], subtitle=info.get("subtitle"), city=info.get("city"),
        state=info.get("state"), mailing_address=info.get("mailing_address") if contact_sensitive else None,
        masked=not contact_sensitive, relationship_strength=info.get("relationship_strength"),
        preferences=info.get("preferences") or {}, current=current, prior=prior, controlled=controlled,
        typical_hold_years=round(median(completed), 1) if completed else None,
        average_current_hold_years=round(mean(running), 1) if running else None,
        total_acquired_value=sum(acquired) if acquired else None, financing_patterns=dict(financing),
        links=await links_out(db, link_rows, user), notes=[NoteOut.model_validate(n) for n in notes], hidden_notes=hidden,
        performance=ctx.metrics.model_dump(), opportunities=[o.model_dump() for o in ctx.opportunities],
        recent_interactions=[i.model_dump() for i in ctx.interactions[:10]],
    )


async def outbound_context(db: AsyncSession, kind: str, owner_id: uuid.UUID) -> dict[str, Any]:
    """Merge fields for outbound messaging. Sensitive notes/evidence are never included."""
    node: Node = (kind, owner_id)
    info = (await node_info(db, {node})).get(node)
    if not info or info["deleted"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{kind.title()} not found")
    items = [i for _, i in await _portfolio(db, [node]) if i.is_current]
    notes = await db.scalars(select(OwnerNote).where(
        OwnerNote.owner_kind == kind, OwnerNote.owner_id == owner_id, OwnerNote.deleted_at.is_(None),
        OwnerNote.sensitive.is_(False), OwnerNote.category.in_(["preference", "hold_strategy", "financing"]),
    ))
    return {
        "owner_name": info["label"],
        "properties": [{"property_id": str(i.property_id), "label": i.property_label, "city": i.city, "state": i.state,
                        "owned_since": i.effective_from.isoformat() if i.effective_from else None,
                        "hold_years": i.hold_years} for i in items],
        "notes": [{"category": n.category, "body": n.body} for n in notes],
    }


# ---------------------------------------------------------------- warm introduction paths

async def _neighbors(db: AsyncSession, frontier: set[Node]) -> dict[Node, list[tuple[Node, str]]]:
    _, _, Affiliation, _, _ = _models()
    out: dict[Node, list[tuple[Node, str]]] = defaultdict(list)
    today = date.today()
    pids = [i for k, i in frontier if k == "person"]
    oids = [i for k, i in frontier if k == "organization"]
    prop_ids = [i for k, i in frontier if k == "property"]

    if pids or oids:
        ids = pids + oids
        for link in await db.scalars(select(EntityLink).where(
            EntityLink.deleted_at.is_(None), EntityLink.status == "confirmed",
            or_(EntityLink.effective_to.is_(None), EntityLink.effective_to > today),
            or_(EntityLink.from_id.in_(ids), EntityLink.to_id.in_(ids)),
        )):
            a, b = (link.from_kind, link.from_id), (link.to_kind, link.to_id)
            rel = link.relationship.replace("_", " ")
            if a in frontier:
                out[a].append((b, rel))
            if b in frontier:
                out[b].append((a, rel))
        for aff in await db.scalars(select(Affiliation).where(
            Affiliation.deleted_at.is_(None),
            or_(Affiliation.person_id.in_(pids), Affiliation.organization_id.in_(oids)),
        )):
            p, o = ("person", aff.person_id), ("organization", aff.organization_id)
            rel = aff.role.replace("_", " ") + ("" if aff.is_current else " (former)")
            if p in frontier:
                out[p].append((o, rel))
            if o in frontier:
                out[o].append((p, rel))
    conds = []
    if pids:
        conds.append(OwnershipInterest.owner_person_id.in_(pids))
    if oids:
        conds.append(OwnershipInterest.owner_organization_id.in_(oids))
    if prop_ids:
        conds.append(OwnershipInterest.property_id.in_(prop_ids))
    if conds:
        for oi in await db.scalars(select(OwnershipInterest).where(
            OwnershipInterest.deleted_at.is_(None), OwnershipInterest.verification != "rejected", or_(*conds),
        )):
            owner: Node = (oi.owner_kind, owner_id_of(oi))  # type: ignore[assignment]
            prop: Node = ("property", oi.property_id)
            rel = "owner" if is_current(oi, today) else "former owner"
            if owner in frontier:
                out[owner].append((prop, rel))
            if prop in frontier:
                out[prop].append((owner, rel))
    return out


def _warm_reason(info: dict[str, Any]) -> str | None:
    if info.get("relationship_strength") in ("moderate", "strong"):
        return f"{info['relationship_strength'].title()} relationship"
    if info.get("last_touch_at"):
        return f"Last touched {info['last_touch_at'].date().isoformat()}"
    return None


async def warm_paths(db: AsyncSession, target: Node, start: Node | None = None, max_depth: int = 3,
                     limit: int = 5) -> list[WarmPath]:
    """BFS outward from the target over confirmed links, affiliations and shared ownership."""
    if start == target:
        return []
    parent: dict[Node, tuple[Node, str] | None] = {target: None}
    frontier = {target}
    found: list[tuple[Node, str | None]] = []
    for _ in range(max_depth):
        nbrs = await _neighbors(db, frontier)
        nxt: set[Node] = set()
        for node in frontier:
            for nb, rel in nbrs.get(node, []):
                if nb[1] is None or nb in parent:
                    continue
                parent[nb] = (node, rel)
                nxt.add(nb)
        if not nxt:
            break
        if start is not None:
            if start in nxt:
                found.append((start, None))
                break
        else:
            info = await node_info(db, {n for n in nxt if n[0] != "property"})
            warm = [(n, _warm_reason(i)) for n, i in info.items() if not i["deleted"] and _warm_reason(i)]
            warm.sort(key=lambda w: (0 if "Strong" in (w[1] or "") else 1, w[1] or ""))
            found += warm[: limit - len(found)]
            if len(found) >= limit:
                break
        frontier = nxt

    chains: list[tuple[list[tuple[Node, str | None]], str | None]] = []
    for node, reason in found:
        chain: list[tuple[Node, str | None]] = []
        cur: Node = node
        while True:
            step = parent[cur]
            if step is None:
                chain.append((cur, None))
                break
            chain.append((cur, step[1]))
            cur = step[0]
        chains.append((chain, reason))
    labels = await node_info(db, {n for chain, _ in chains for n, _ in chain})
    return [
        WarmPath(
            steps=[PathStep(kind=n[0], id=n[1], label=labels.get(n, {}).get("label") or "Unknown", relation_to_next=rel)
                   for n, rel in chain],
            length=len(chain) - 1, start_reason=reason,
        )
        for chain, reason in chains
    ]
