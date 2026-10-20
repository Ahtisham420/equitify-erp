import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from itertools import combinations
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, distinct, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import to_jsonable
from app.common.normalize import normalize_name
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.database import Base
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.contacts.models import (
    Affiliation,
    ContactEnrichment,
    ContactPoint,
    DuplicateReview,
    MergeRecord,
    Organization,
    Person,
)
from app.modules.contacts.schemas import (
    AffiliationIn,
    AffiliationOut,
    AffiliationUpdate,
    BulkIn,
    ComplianceState,
    ContactPointIn,
    ContactPointOut,
    ContactPointUpdate,
    ContextInteraction,
    ContextOpportunity,
    ContextOut,
    ContextProperty,
    ContextTask,
    DuplicateOut,
    EnrichmentIn,
    MergeIn,
    MergeOut,
    OrganizationCreate,
    OrganizationListItem,
    OrganizationOut,
    OrganizationUpdate,
    PersonCreate,
    PersonListItem,
    PersonOut,
    PersonUpdate,
    RelationshipMetrics,
)

FREE_EMAIL_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "msn.com",
    "live.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "protonmail.com", "mail.com",
}
WON_STAGES = {"closed", "closed_won", "won", "post_close", "owned"}
LOST_STAGES = {"dead", "lost", "closed_lost"}


# ---------------------------------------------------------------- normalization & masking

def norm_email(v: str | None) -> str:
    return (v or "").strip().lower()


def norm_phone(v: str | None) -> str:
    digits = re.sub(r"\D", "", v or "")
    return digits[-10:] if len(digits) >= 10 else digits


def norm_point(kind: str, value: str) -> str:
    return norm_email(value) if kind == "email" else norm_phone(value)


def email_domain(v: str | None) -> str | None:
    if not v or "@" not in v:
        return None
    return v.rsplit("@", 1)[1].strip().lower() or None


def norm_domain(v: str | None) -> str | None:
    if not v:
        return None
    s = re.sub(r"^[a-z]+://", "", v.strip().lower())
    s = s.split("/")[0].split("?")[0]
    s = re.sub(r"^www\.", "", s)
    return s or None


def mask_email(v: str | None) -> str | None:
    if not v:
        return v
    local, _, dom = v.partition("@")
    return f"{local[:1]}•••@{dom}" if dom else "•••"


def mask_phone(v: str | None) -> str | None:
    if not v:
        return v
    digits = re.sub(r"\D", "", v)
    return f"•••-•••-{digits[-4:]}" if len(digits) >= 4 else "•••"


def mask_point(kind: str, v: str) -> str:
    return (mask_email(v) if kind == "email" else mask_phone(v)) or ""


def can_sensitive(user: CurrentUser) -> bool:
    return user.can("contacts", "view_sensitive")


def person_name(first: str | None, last: str | None, full: str | None) -> str:
    if full and full.strip():
        return full.strip()
    return " ".join(p.strip() for p in [first or "", last or ""] if p and p.strip()) or "Unnamed"


# ---------------------------------------------------------------- shared lookups

async def get_person(db: AsyncSession, person_id: uuid.UUID) -> Person:
    p = await db.get(Person, person_id)
    if not p or p.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Person not found")
    return p


async def get_org(db: AsyncSession, org_id: uuid.UUID) -> Organization:
    o = await db.get(Organization, org_id)
    if not o or o.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found")
    return o


async def labels(db: AsyncSession, kind: str, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    if kind == "person":
        rows = await db.execute(select(Person.id, Person.full_name).where(Person.id.in_(list(ids))))
    else:
        rows = await db.execute(select(Organization.id, Organization.name).where(Organization.id.in_(list(ids))))
    return {i: n for i, n in rows.all()}


def _alive(model: Any) -> list:
    col = getattr(model, "deleted_at", None)
    return [col.is_(None)] if col is not None else []


# ---------------------------------------------------------------- people: query

@dataclass
class PeopleFilters:
    q: str | None = None
    state: list[str] | None = None
    relationship_strength: list[str] | None = None
    responsiveness: list[str] | None = None
    role: list[str] | None = None
    organization_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    tag: list[str] | None = None
    has_next_action: bool | None = None
    overdue: bool | None = None
    touched_before: date | None = None
    ids: list[uuid.UUID] | None = None


def build_people_query(f: PeopleFilters, *, sensitive: bool, skip: set[str] = frozenset()) -> Select:
    stmt = select(Person).where(Person.deleted_at.is_(None))
    cols = [Person.full_name, Person.title, Person.city]
    if sensitive:
        cols += [Person.primary_email, Person.primary_phone]
    stmt = apply_search(stmt, f.q, cols)
    if "state" not in skip:
        stmt = in_filter(stmt, Person.state, f.state)
    if "relationship_strength" not in skip:
        stmt = in_filter(stmt, Person.relationship_strength, f.relationship_strength)
    if "responsiveness" not in skip:
        stmt = in_filter(stmt, Person.responsiveness, f.responsiveness)
    stmt = in_filter(stmt, Person.id, f.ids)
    if f.role and "role" not in skip:
        stmt = stmt.where(exists().where(
            Affiliation.person_id == Person.id, Affiliation.role.in_(f.role),
            Affiliation.is_current.is_(True), Affiliation.deleted_at.is_(None),
        ))
    if f.organization_id:
        stmt = stmt.where(exists().where(
            Affiliation.person_id == Person.id, Affiliation.organization_id == f.organization_id,
            Affiliation.deleted_at.is_(None),
        ))
    if f.owner_id:
        stmt = stmt.where(Person.owner_id == f.owner_id)
    if f.tag:
        stmt = stmt.where(Person.tags.overlap(f.tag))
    if f.has_next_action is True:
        stmt = stmt.where(Person.next_action_at.is_not(None))
    elif f.has_next_action is False:
        stmt = stmt.where(Person.next_action_at.is_(None))
    if f.overdue:
        stmt = stmt.where(Person.next_action_at < utcnow())
    if f.touched_before:
        stmt = stmt.where(or_(Person.last_touch_at.is_(None), func.date(Person.last_touch_at) < f.touched_before))
    return stmt


async def role_facets(db: AsyncSession, base: Select) -> dict[str, int]:
    ids = base.order_by(None).with_only_columns(Person.id).subquery()
    rows = await db.execute(
        select(Affiliation.role, func.count(distinct(Affiliation.person_id)))
        .where(Affiliation.person_id.in_(select(ids.c.id)), Affiliation.is_current.is_(True),
               Affiliation.deleted_at.is_(None))
        .group_by(Affiliation.role)
    )
    return {r: int(c) for r, c in rows.all()}


async def people_items(db: AsyncSession, rows: list[Person], user: CurrentUser) -> list[PersonListItem]:
    sensitive = can_sensitive(user)
    ids = [p.id for p in rows]
    aff: dict[uuid.UUID, tuple[list[str], str | None]] = {}
    if ids:
        res = await db.execute(
            select(Affiliation.person_id, Affiliation.role, Organization.name)
            .join(Organization, Organization.id == Affiliation.organization_id)
            .where(Affiliation.person_id.in_(ids), Affiliation.is_current.is_(True), Affiliation.deleted_at.is_(None))
            .order_by(Affiliation.created_at)
        )
        for pid, role, org in res.all():
            roles, first_org = aff.get(pid, ([], None))
            if role not in roles:
                roles.append(role)
            aff[pid] = (roles, first_org or org)
    out = []
    for p in rows:
        item = PersonListItem.model_validate(p)
        item.roles, item.organization_name = aff.get(p.id, ([], None))
        if not sensitive:
            item.primary_email = mask_email(item.primary_email)
            item.primary_phone = mask_phone(item.primary_phone)
            item.masked = True
        out.append(item)
    return out


# ---------------------------------------------------------------- contact points

def point_out(cp: ContactPoint, sensitive: bool) -> ContactPointOut:
    out = ContactPointOut.model_validate(cp)
    if not sensitive:
        out.value = mask_point(cp.kind, cp.value)
        out.masked = True
    return out


async def _points(db: AsyncSession, *, person_id: uuid.UUID | None = None, org_id: uuid.UUID | None = None) -> list[ContactPoint]:
    stmt = select(ContactPoint).where(ContactPoint.deleted_at.is_(None))
    stmt = stmt.where(ContactPoint.person_id == person_id) if person_id else stmt.where(ContactPoint.organization_id == org_id)
    return list(await db.scalars(stmt.order_by(ContactPoint.is_primary.desc(), ContactPoint.created_at)))


async def sync_primary(db: AsyncSession, *, person: Person | None = None, org: Organization | None = None) -> None:
    """Keep the denormalized primary email/phone columns in step with contact_points."""
    await db.flush()  # session runs with autoflush off
    pts =await _points(db, person_id=person.id if person else None, org_id=org.id if org else None)
    email = next((c.value for c in pts if c.kind == "email"), None)
    phone = next((c.value for c in pts if c.kind == "phone"), None)
    if person:
        person.primary_email, person.primary_phone = email, phone
    elif org and phone:
        org.phone = phone


async def _add_point(db: AsyncSession, data: ContactPointIn, actor: CurrentUser, *, person_id: uuid.UUID | None,
                     org_id: uuid.UUID | None) -> ContactPoint:
    normalized = norm_point(data.kind, data.value)
    if not normalized:
        raise HTTPException(422, f"Invalid {data.kind}")
    existing = await _points(db, person_id=person_id, org_id=org_id)
    if any(c.kind == data.kind and c.normalized_value == normalized for c in existing):
        raise HTTPException(409, f"This {data.kind} is already on the record")
    make_primary = data.is_primary or not any(c.kind == data.kind for c in existing)
    if make_primary:
        for c in existing:
            if c.kind == data.kind:
                c.is_primary = False
    cp = ContactPoint(
        person_id=person_id, organization_id=org_id, kind=data.kind, value=data.value.strip(),
        normalized_value=normalized, label=data.label,
        phone_type=(data.phone_type or "unknown") if data.kind == "phone" else None,
        is_primary=make_primary, source=data.source, observed_on=data.observed_on,
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(cp)
    await db.flush()
    return cp


async def add_contact_point(db: AsyncSession, kind: str, owner_id: uuid.UUID, data: ContactPointIn,
                            actor: CurrentUser) -> ContactPoint:
    if kind == "person":
        owner = await get_person(db, owner_id)
        cp = await _add_point(db, data, actor, person_id=owner.id, org_id=None)
        await sync_primary(db, person=owner)
    else:
        org = await get_org(db, owner_id)
        cp = await _add_point(db, data, actor, person_id=None, org_id=org.id)
        await sync_primary(db, org=org)
    await audit.record(db, actor=actor, action=f"{kind}.contact_point_added", entity_type=kind, entity_id=owner_id,
                       summary=f"{data.kind}: {mask_point(data.kind, data.value)}", ip_address=actor.ip_address)
    await db.commit()
    return cp


async def _point_owner(db: AsyncSession, cp: ContactPoint) -> tuple[str, Person | Organization]:
    if cp.person_id:
        return "person", await get_person(db, cp.person_id)
    return "organization", await get_org(db, cp.organization_id)  # type: ignore[arg-type]


async def get_point(db: AsyncSession, cp_id: uuid.UUID) -> ContactPoint:
    cp = await db.get(ContactPoint, cp_id)
    if not cp or cp.deleted_at:
        raise HTTPException(404, "Contact point not found")
    return cp


async def update_contact_point(db: AsyncSession, cp: ContactPoint, data: ContactPointUpdate,
                               actor: CurrentUser) -> ContactPoint:
    kind, owner = await _point_owner(db, cp)
    values = data.model_dump(exclude_unset=True)
    if "value" in values and values["value"]:
        values["value"] = values["value"].strip()
        cp.normalized_value = norm_point(cp.kind, values["value"])
    if values.get("is_primary"):
        for c in await _points(db, person_id=cp.person_id, org_id=cp.organization_id):
            if c.kind == cp.kind and c.id != cp.id:
                c.is_primary = False
    changes = audit.diff(cp, values)
    for k, v in values.items():
        setattr(cp, k, v)
    cp.updated_by_id = actor.id
    await db.flush()
    await sync_primary(db, person=owner if kind == "person" else None, org=owner if kind == "organization" else None)  # type: ignore[arg-type]
    if "value" in changes:  # never write raw contact values into the audit trail
        changes["value"] = {"from": mask_point(cp.kind, str(changes["value"]["from"])), "to": mask_point(cp.kind, cp.value)}
    await audit.record(db, actor=actor, action=f"{kind}.contact_point_updated", entity_type=kind, entity_id=owner.id,
                       changes=changes, summary=f"{cp.kind}: {mask_point(cp.kind, cp.value)}", ip_address=actor.ip_address)
    await db.commit()
    return cp


async def remove_contact_point(db: AsyncSession, cp: ContactPoint, actor: CurrentUser) -> None:
    kind, owner = await _point_owner(db, cp)
    cp.deleted_at = utcnow()
    cp.updated_by_id = actor.id
    if cp.is_primary:
        cp.is_primary = False
        nxt = next((c for c in await _points(db, person_id=cp.person_id, org_id=cp.organization_id)
                    if c.kind == cp.kind and c.id != cp.id), None)
        if nxt:
            nxt.is_primary = True
    await db.flush()
    await sync_primary(db, person=owner if kind == "person" else None, org=owner if kind == "organization" else None)  # type: ignore[arg-type]
    await audit.record(db, actor=actor, action=f"{kind}.contact_point_removed", entity_type=kind, entity_id=owner.id,
                       summary=f"{cp.kind}: {mask_point(cp.kind, cp.value)}", ip_address=actor.ip_address)
    await db.commit()


# ---------------------------------------------------------------- affiliations

async def affiliations_for(db: AsyncSession, *, person_id: uuid.UUID | None = None,
                           org_id: uuid.UUID | None = None) -> list[AffiliationOut]:
    stmt = (
        select(Affiliation, Person.full_name, Organization.name)
        .join(Person, Person.id == Affiliation.person_id)
        .join(Organization, Organization.id == Affiliation.organization_id)
        .where(Affiliation.deleted_at.is_(None), Person.deleted_at.is_(None), Organization.deleted_at.is_(None))
    )
    stmt = stmt.where(Affiliation.person_id == person_id) if person_id else stmt.where(Affiliation.organization_id == org_id)
    out = []
    for a, pname, oname in (await db.execute(stmt.order_by(Affiliation.is_current.desc(), Affiliation.created_at))).all():
        item = AffiliationOut.model_validate(a)
        item.person_name, item.organization_name = pname, oname
        out.append(item)
    return out


async def create_affiliation(db: AsyncSession, data: AffiliationIn, actor: CurrentUser) -> Affiliation:
    person = await get_person(db, data.person_id)
    org = await get_org(db, data.organization_id)
    dup = await db.scalar(select(Affiliation).where(
        Affiliation.person_id == person.id, Affiliation.organization_id == org.id, Affiliation.role == data.role,
        Affiliation.is_current.is_(True), Affiliation.deleted_at.is_(None),
    ))
    if dup:
        raise HTTPException(409, "This person already has a current affiliation with that role")
    a = Affiliation(**data.model_dump(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(a)
    await db.flush()
    summary = f"{person.full_name} · {a.role.replace('_', ' ')} · {org.name}"
    for kind, eid in (("person", person.id), ("organization", org.id)):
        await audit.record(db, actor=actor, action=f"{kind}.affiliation_added", entity_type=kind, entity_id=eid,
                           summary=summary, ip_address=actor.ip_address)
    await db.commit()
    return a


async def update_affiliation(db: AsyncSession, aff_id: uuid.UUID, data: AffiliationUpdate, actor: CurrentUser) -> Affiliation:
    a = await db.get(Affiliation, aff_id)
    if not a or a.deleted_at:
        raise HTTPException(404, "Affiliation not found")
    values = data.model_dump(exclude_unset=True)
    if values.get("is_current") is False and not values.get("ended_on") and not a.ended_on:
        values["ended_on"] = date.today()
    changes = audit.diff(a, values)
    for k, v in values.items():
        setattr(a, k, v)
    a.updated_by_id = actor.id
    if changes:
        for kind, eid in (("person", a.person_id), ("organization", a.organization_id)):
            await audit.record(db, actor=actor, action=f"{kind}.affiliation_updated", entity_type=kind, entity_id=eid,
                               changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return a


# ---------------------------------------------------------------- enrichment

async def enrichments(db: AsyncSession, kind: str, eid: uuid.UUID) -> list[ContactEnrichment]:
    col = ContactEnrichment.person_id if kind == "person" else ContactEnrichment.organization_id
    return list(await db.scalars(select(ContactEnrichment).where(col == eid, ContactEnrichment.deleted_at.is_(None))
                                 .order_by(ContactEnrichment.enriched_at.desc())))


async def add_enrichment(db: AsyncSession, kind: str, eid: uuid.UUID, data: EnrichmentIn, actor: CurrentUser) -> ContactEnrichment:
    if kind == "person":
        await get_person(db, eid)
    else:
        await get_org(db, eid)
    values = data.model_dump()
    values["enriched_at"] = values["enriched_at"] or utcnow()
    rec = ContactEnrichment(**values, person_id=eid if kind == "person" else None,
                            organization_id=eid if kind == "organization" else None,
                            created_by_id=actor.id, updated_by_id=actor.id)
    db.add(rec)
    await db.flush()
    await audit.record(db, actor=actor, action=f"{kind}.enriched", entity_type=kind, entity_id=eid,
                       summary=f"{data.provider}" + (f" · ${data.cost:,.2f}" if data.cost is not None else ""),
                       ip_address=actor.ip_address)
    await db.commit()
    return rec


# ---------------------------------------------------------------- compliance (inherited from outreach compliance)

async def compliance_for(db: AsyncSession, points: list[ContactPoint], sensitive: bool) -> list[ComplianceState]:
    try:
        from app.modules.compliance.service import check_send
    except ImportError:
        return []
    out = []
    for cp in points:
        allowed, reasons = await check_send(db, channel=cp.kind, value=cp.value)
        out.append(ComplianceState(channel=cp.kind, value=cp.value if sensitive else mask_point(cp.kind, cp.value),
                                   allowed=allowed, reasons=list(reasons)))
    return out


# ---------------------------------------------------------------- people: CRUD

async def person_out(db: AsyncSession, p: Person, user: CurrentUser) -> PersonOut:
    sensitive = can_sensitive(user)
    out = PersonOut.model_validate(p)
    points = await _points(db, person_id=p.id)
    out.contact_points = [point_out(c, sensitive) for c in points]
    out.affiliations = await affiliations_for(db, person_id=p.id)
    out.compliance = await compliance_for(db, points, sensitive)
    if not sensitive:
        out.primary_email = mask_email(out.primary_email)
        out.primary_phone = mask_phone(out.primary_phone)
        out.mailing_address = None
        out.postal_code = None
        out.masked = True
    return out


async def find_person_duplicates(db: AsyncSession, normalized: str, emails: list[str], phones: list[str],
                                 exclude: uuid.UUID | None = None) -> list[Person]:
    conds = []
    if normalized:
        conds.append(Person.normalized_name == normalized)
    keys = [norm_email(e) for e in emails if e] + [norm_phone(p) for p in phones if p]
    keys = [k for k in keys if k]
    if keys:
        conds.append(Person.id.in_(select(ContactPoint.person_id).where(
            ContactPoint.normalized_value.in_(keys), ContactPoint.deleted_at.is_(None))))
    if not conds:
        return []
    stmt = select(Person).where(Person.deleted_at.is_(None), or_(*conds))
    if exclude:
        stmt = stmt.where(Person.id != exclude)
    return list(await db.scalars(stmt.limit(5)))


async def _enqueue_pairs(db: AsyncSession, entity_type: str, new_id: uuid.UUID, others: list[uuid.UUID], reason: str) -> None:
    for other in others:
        a, b = sorted([new_id, other], key=str)
        exists_ = await db.scalar(select(DuplicateReview.id).where(
            DuplicateReview.entity_type == entity_type, DuplicateReview.a_id == a, DuplicateReview.b_id == b))
        if not exists_:
            db.add(DuplicateReview(entity_type=entity_type, a_id=a, b_id=b, reasons=[{"type": reason}], score=0.6))


async def create_person(db: AsyncSession, data: PersonCreate, actor: CurrentUser, *, force: bool = False) -> Person:
    full = person_name(data.first_name, data.last_name, data.full_name)
    normalized = normalize_name(full)
    dupes = await find_person_duplicates(db, normalized, data.emails, data.phones)
    if dupes and not force:
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "message": "A similar person already exists",
            "duplicates": [{"id": str(d.id), "label": d.full_name, "sublabel": d.title or d.city} for d in dupes],
        })
    values = data.model_dump(exclude={"emails", "phones", "full_name"})
    p = Person(**values, full_name=full, normalized_name=normalized, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(p)
    await db.flush()
    for i, e in enumerate(x for x in data.emails if x.strip()):
        await _add_point(db, ContactPointIn(kind="email", value=e, is_primary=i == 0, source=data.source), actor,
                         person_id=p.id, org_id=None)
    for i, ph in enumerate(x for x in data.phones if x.strip()):
        await _add_point(db, ContactPointIn(kind="phone", value=ph, is_primary=i == 0, source=data.source), actor,
                         person_id=p.id, org_id=None)
    await sync_primary(db, person=p)
    if dupes:  # created anyway: the pair goes to the review queue, never auto-merged
        await _enqueue_pairs(db, "person", p.id, [d.id for d in dupes], "created_despite_match")
    await audit.record(db, actor=actor, action="person.created", entity_type="person", entity_id=p.id,
                       summary=p.full_name, ip_address=actor.ip_address)
    await events.emit(db, "person.created", person_id=p.id, actor=actor)
    await db.commit()
    return p


SENSITIVE_PERSON_FIELDS = {"mailing_address", "postal_code"}


async def update_person(db: AsyncSession, p: Person, data: PersonUpdate, actor: CurrentUser) -> Person:
    values = data.model_dump(exclude_unset=True)
    if not can_sensitive(actor):
        for f in SENSITIVE_PERSON_FIELDS & values.keys():
            values.pop(f)
    if {"first_name", "last_name", "full_name"} & values.keys():
        values["full_name"] = person_name(values.get("first_name", p.first_name), values.get("last_name", p.last_name),
                                          values.get("full_name") if "full_name" in values else None)
        values["normalized_name"] = normalize_name(values["full_name"])
    changes = audit.diff(p, values)
    if not changes:
        return p
    for k, v in values.items():
        setattr(p, k, v)
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="person.updated", entity_type="person", entity_id=p.id,
                       changes={k: v for k, v in changes.items() if k not in SENSITIVE_PERSON_FIELDS | {"normalized_name"}}
                       | ({"mailing_address": "changed"} if SENSITIVE_PERSON_FIELDS & changes.keys() else {}),
                       ip_address=actor.ip_address)
    await events.emit(db, "person.updated", person_id=p.id, changed=set(changes), actor=actor)
    await db.commit()
    return p


async def archive_person(db: AsyncSession, p: Person, actor: CurrentUser) -> None:
    p.deleted_at = utcnow()
    p.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="person.archived", entity_type="person", entity_id=p.id,
                       summary=p.full_name, ip_address=actor.ip_address)
    await db.commit()


# ---------------------------------------------------------------- organizations: query & CRUD

@dataclass
class OrgFilters:
    q: str | None = None
    org_type: list[str] | None = None
    state: list[str] | None = None
    relationship_strength: list[str] | None = None
    owner_id: uuid.UUID | None = None
    tag: list[str] | None = None
    has_next_action: bool | None = None
    ids: list[uuid.UUID] | None = None


def build_org_query(f: OrgFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Organization).where(Organization.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Organization.name, Organization.legal_name, Organization.domain, Organization.city,
                                    Organization.registered_agent])
    if "org_type" not in skip:
        stmt = in_filter(stmt, Organization.org_type, f.org_type)
    if "state" not in skip:
        stmt = in_filter(stmt, Organization.state, f.state)
    if "relationship_strength" not in skip:
        stmt = in_filter(stmt, Organization.relationship_strength, f.relationship_strength)
    stmt = in_filter(stmt, Organization.id, f.ids)
    if f.owner_id:
        stmt = stmt.where(Organization.owner_id == f.owner_id)
    if f.tag:
        stmt = stmt.where(Organization.tags.overlap(f.tag))
    if f.has_next_action is True:
        stmt = stmt.where(Organization.next_action_at.is_not(None))
    elif f.has_next_action is False:
        stmt = stmt.where(Organization.next_action_at.is_(None))
    return stmt


async def org_items(db: AsyncSession, rows: list[Organization], user: CurrentUser) -> list[OrganizationListItem]:
    sensitive = can_sensitive(user)
    ids = [o.id for o in rows]
    counts: dict[uuid.UUID, int] = {}
    if ids:
        res = await db.execute(
            select(Affiliation.organization_id, func.count(distinct(Affiliation.person_id)))
            .where(Affiliation.organization_id.in_(ids), Affiliation.is_current.is_(True), Affiliation.deleted_at.is_(None))
            .group_by(Affiliation.organization_id)
        )
        counts = {i: int(c) for i, c in res.all()}
    out = []
    for o in rows:
        item = OrganizationListItem.model_validate(o)
        item.member_count = counts.get(o.id, 0)
        if not sensitive:
            item.phone = mask_phone(item.phone)
            item.masked = True
        out.append(item)
    return out


async def org_out(db: AsyncSession, o: Organization, user: CurrentUser) -> OrganizationOut:
    sensitive = can_sensitive(user)
    out = OrganizationOut.model_validate(o)
    out.contact_points = [point_out(c, sensitive) for c in await _points(db, org_id=o.id)]
    out.members = await affiliations_for(db, org_id=o.id)
    if not sensitive:
        out.phone = mask_phone(out.phone)
        out.mailing_address = None
        out.masked = True
    return out


def _org_values(values: dict) -> dict:
    if values.get("website") and not values.get("domain"):
        values["domain"] = norm_domain(values["website"])
    elif "domain" in values:
        values["domain"] = norm_domain(values["domain"])
    if "name" in values and values["name"]:
        values["normalized_name"] = normalize_name(values["name"])
    return values


async def find_org_duplicates(db: AsyncSession, normalized: str, domain: str | None,
                              exclude: uuid.UUID | None = None) -> list[Organization]:
    conds = [Organization.normalized_name == normalized] if normalized else []
    if domain and domain not in FREE_EMAIL_DOMAINS:
        conds.append(Organization.domain == domain)
    if not conds:
        return []
    stmt = select(Organization).where(Organization.deleted_at.is_(None), or_(*conds))
    if exclude:
        stmt = stmt.where(Organization.id != exclude)
    return list(await db.scalars(stmt.limit(5)))


async def create_org(db: AsyncSession, data: OrganizationCreate, actor: CurrentUser, *, force: bool = False) -> Organization:
    values = _org_values(data.model_dump())
    dupes = await find_org_duplicates(db, values["normalized_name"], values.get("domain"))
    if dupes and not force:
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "message": "A similar organization already exists",
            "duplicates": [{"id": str(d.id), "label": d.name, "sublabel": d.domain or d.city} for d in dupes],
        })
    o = Organization(**values, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(o)
    await db.flush()
    if data.phone:
        await _add_point(db, ContactPointIn(kind="phone", value=data.phone, is_primary=True, label="Main",
                                            source=data.source), actor, person_id=None, org_id=o.id)
    if dupes:
        await _enqueue_pairs(db, "organization", o.id, [d.id for d in dupes], "created_despite_match")
    await audit.record(db, actor=actor, action="organization.created", entity_type="organization", entity_id=o.id,
                       summary=o.name, ip_address=actor.ip_address)
    await events.emit(db, "organization.created", organization_id=o.id, actor=actor)
    await db.commit()
    return o


SENSITIVE_ORG_FIELDS = {"mailing_address", "phone", "postal_code"}


async def update_org(db: AsyncSession, o: Organization, data: OrganizationUpdate, actor: CurrentUser) -> Organization:
    values = data.model_dump(exclude_unset=True)
    if not can_sensitive(actor):
        for f in SENSITIVE_ORG_FIELDS & values.keys():
            values.pop(f)
    values = _org_values(values)
    changes = audit.diff(o, values)
    if not changes:
        return o
    for k, v in values.items():
        setattr(o, k, v)
    o.updated_by_id = actor.id
    safe = {k: v for k, v in changes.items() if k not in SENSITIVE_ORG_FIELDS | {"normalized_name"}}
    if SENSITIVE_ORG_FIELDS & changes.keys():
        safe["contact_details"] = "changed"
    await audit.record(db, actor=actor, action="organization.updated", entity_type="organization", entity_id=o.id,
                       changes=safe, ip_address=actor.ip_address)
    await events.emit(db, "organization.updated", organization_id=o.id, changed=set(changes), actor=actor)
    await db.commit()
    return o


async def archive_org(db: AsyncSession, o: Organization, actor: CurrentUser) -> None:
    o.deleted_at = utcnow()
    o.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="organization.archived", entity_type="organization", entity_id=o.id,
                       summary=o.name, ip_address=actor.ip_address)
    await db.commit()


async def bulk_update(db: AsyncSession, kind: str, data: BulkIn, actor: CurrentUser) -> int:
    model = Person if kind == "person" else Organization
    rows = list(await db.scalars(select(model).where(model.id.in_(data.ids), model.deleted_at.is_(None))))
    for r in rows:
        changes: dict = {}
        if data.owner_id and r.owner_id != data.owner_id:
            changes["owner_id"] = {"from": r.owner_id, "to": data.owner_id}
            r.owner_id = data.owner_id
        if data.relationship_strength and r.relationship_strength != data.relationship_strength:
            changes["relationship_strength"] = {"from": r.relationship_strength, "to": data.relationship_strength}
            r.relationship_strength = data.relationship_strength
        if data.add_tags or data.remove_tags:
            tags = [t for t in (r.tags or []) if t not in data.remove_tags]
            tags += [t for t in data.add_tags if t not in tags]
            if tags != r.tags:
                changes["tags"] = {"from": r.tags, "to": tags}
                r.tags = tags
        if changes:
            r.updated_by_id = actor.id
            await audit.record(db, actor=actor, action=f"{kind}.bulk_updated", entity_type=kind, entity_id=r.id,
                               changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return len(rows)


# ---------------------------------------------------------------- portfolio & deal context

async def _linked_org_ids(db: AsyncSession, person_id: uuid.UUID) -> dict[uuid.UUID, str]:
    rows = await db.execute(
        select(Organization.id, Organization.name).join(Affiliation, Affiliation.organization_id == Organization.id)
        .where(Affiliation.person_id == person_id, Affiliation.is_current.is_(True), Affiliation.deleted_at.is_(None),
               Organization.deleted_at.is_(None))
    )
    return {i: n for i, n in rows.all()}


async def relationship_metrics(db: AsyncSession, kind: str, eid: uuid.UUID) -> RelationshipMetrics:
    """Last touch, responsiveness, close rate and deal-flow source attribution for a counterparty."""
    model = Person if kind == "person" else Organization
    rec = await db.get(model, eid)
    m = RelationshipMetrics(
        last_touch_at=rec.last_touch_at if rec else None, next_action_at=rec.next_action_at if rec else None,
        interactions=0, meaningful_interactions=0, outbound=0, inbound=0, response_rate=None,
        opportunities=0, won=0, lost=0, close_rate=None, source_attribution={},
    )
    try:
        from app.modules.outreach.models import Interaction
    except ImportError:
        Interaction = None  # noqa: N806
    if Interaction is not None:
        col = Interaction.person_id if kind == "person" else Interaction.organization_id
        rows = await db.execute(
            select(Interaction.direction, Interaction.is_meaningful, func.count(), func.max(Interaction.occurred_at))
            .where(col == eid, *_alive(Interaction)).group_by(Interaction.direction, Interaction.is_meaningful)
        )
        for direction, meaningful, count, last in rows.all():
            m.interactions += count
            if meaningful:
                m.meaningful_interactions += count
            if direction == "outbound":
                m.outbound += count
            elif direction == "inbound":
                m.inbound += count
            if last and (m.last_touch_at is None or last > m.last_touch_at):
                m.last_touch_at = last
        if m.outbound:
            m.response_rate = round(min(1.0, m.inbound / m.outbound), 3)
    try:
        from app.modules.pipeline.models import Opportunity
    except ImportError:
        Opportunity = None  # noqa: N806
    if Opportunity is not None:
        col = Opportunity.primary_person_id if kind == "person" else Opportunity.primary_organization_id
        rows = await db.execute(select(Opportunity.stage, Opportunity.source).where(col == eid, *_alive(Opportunity)))
        for stage, source in rows.all():
            m.opportunities += 1
            if stage in WON_STAGES:
                m.won += 1
            elif stage in LOST_STAGES:
                m.lost += 1
            key = source or "unknown"
            m.source_attribution[key] = m.source_attribution.get(key, 0) + 1
        if m.won + m.lost:
            m.close_rate = round(m.won / (m.won + m.lost), 3)
    return m


async def context(db: AsyncSession, kind: str, eid: uuid.UUID) -> ContextOut:
    from app.modules.ownership.models import OwnershipInterest
    from app.modules.properties.models import Property

    via: dict[uuid.UUID, str] = await _linked_org_ids(db, eid) if kind == "person" else {}
    if kind == "person":
        owner_cond = OwnershipInterest.owner_person_id == eid
        if via:
            owner_cond = or_(owner_cond, OwnershipInterest.owner_organization_id.in_(list(via)))
    else:
        owner_cond = OwnershipInterest.owner_organization_id == eid
    today = date.today()
    props = []
    rows = await db.execute(
        select(OwnershipInterest, Property).join(Property, Property.id == OwnershipInterest.property_id)
        .where(owner_cond, OwnershipInterest.deleted_at.is_(None), Property.deleted_at.is_(None))
        .order_by(OwnershipInterest.effective_to.is_(None).desc(), OwnershipInterest.effective_from.desc().nulls_last())
    )
    for oi, prop in rows.all():
        via_id = oi.owner_organization_id if kind == "person" and oi.owner_organization_id else None
        props.append(ContextProperty(
            interest_id=oi.id, property_id=prop.id, property_label=prop.name or prop.address_line, city=prop.city,
            state=prop.state, property_type=prop.property_type, role=oi.role, interest_pct=oi.interest_pct,
            effective_from=oi.effective_from, effective_to=oi.effective_to,
            is_current=oi.effective_to is None or oi.effective_to > today,
            via_organization_id=via_id, via_organization_name=via.get(via_id) if via_id else None,
        ))

    opps: list[ContextOpportunity] = []
    try:
        from app.modules.pipeline.models import Opportunity
    except ImportError:
        Opportunity = None  # noqa: N806
    if Opportunity is not None:
        if kind == "person":
            cond = Opportunity.primary_person_id == eid
            if via:
                cond = or_(cond, Opportunity.primary_organization_id.in_(list(via)))
        else:
            cond = Opportunity.primary_organization_id == eid
        for o in await db.scalars(select(Opportunity).where(cond, *_alive(Opportunity)).limit(200)):
            opps.append(ContextOpportunity(id=o.id, title=o.title, stage=o.stage, property_id=o.property_id,
                                           next_action_at=o.next_action_at, source=o.source))

    inters: list[ContextInteraction] = []
    try:
        from app.modules.outreach.models import Interaction
    except ImportError:
        Interaction = None  # noqa: N806
    if Interaction is not None:
        col = Interaction.person_id if kind == "person" else Interaction.organization_id
        for i in await db.scalars(select(Interaction).where(col == eid, *_alive(Interaction))
                                  .order_by(Interaction.occurred_at.desc()).limit(50)):
            inters.append(ContextInteraction(
                id=i.id, channel=i.channel, direction=i.direction, occurred_at=i.occurred_at, summary=i.summary,
                disposition=i.disposition, property_id=i.property_id, opportunity_id=i.opportunity_id,
                next_action_at=i.next_action_at, loop_closed=i.loop_closed,
            ))

    from app.modules.tasks.models import Task
    tasks = [
        ContextTask(id=t.id, title=t.title, status=t.status, priority=t.priority, due_at=t.due_at, assignee_id=t.assignee_id)
        for t in await db.scalars(
            select(Task).where(Task.related_type == kind, Task.related_id == eid, Task.deleted_at.is_(None))
            .order_by(Task.status.in_(["done", "cancelled"]), Task.due_at.asc().nulls_last()).limit(50)
        )
    ]
    return ContextOut(properties=props, opportunities=opps, interactions=inters, tasks=tasks,
                      metrics=await relationship_metrics(db, kind, eid))


# ---------------------------------------------------------------- duplicate review

_WEIGHTS = {"name": 0.5, "email": 0.45, "phone": 0.35, "domain": 0.4, "created_despite_match": 0.6}


def _score(reasons: list[dict]) -> float:
    miss = 1.0
    for t in {r["type"] for r in reasons}:
        miss *= 1 - _WEIGHTS.get(t, 0.2)
    return round(1 - miss, 3)


def _pairs(groups: list[tuple[str, str, list[uuid.UUID]]], acc: dict) -> None:
    for rtype, value, ids in groups:
        uniq = sorted(set(i for i in ids if i), key=str)
        if len(uniq) < 2 or len(uniq) > 25:  # very large groups are shared infrastructure, not duplicates
            continue
        for a, b in combinations(uniq, 2):
            acc.setdefault((a, b), []).append({"type": rtype, "value": value})


async def backfill_normalized(db: AsyncSession) -> None:
    """Records created outside this module (e.g. imports) may lack the normalized name key."""
    for p in await db.scalars(select(Person).where(Person.deleted_at.is_(None), Person.normalized_name == "")):
        p.normalized_name = normalize_name(p.full_name)
    for o in await db.scalars(select(Organization).where(Organization.deleted_at.is_(None), Organization.normalized_name == "")):
        o.normalized_name = normalize_name(o.name)
    await db.flush()


async def scan_duplicates(db: AsyncSession, entity_type: str, actor: CurrentUser) -> tuple[int, int]:
    await backfill_normalized(db)
    acc: dict[tuple[uuid.UUID, uuid.UUID], list[dict]] = {}
    if entity_type == "person":
        scanned = await db.scalar(select(func.count()).select_from(Person).where(Person.deleted_at.is_(None))) or 0
        rows = await db.execute(
            select(Person.normalized_name, func.array_agg(Person.id))
            .where(Person.deleted_at.is_(None), Person.normalized_name != "")
            .group_by(Person.normalized_name).having(func.count() > 1)
        )
        _pairs([("name", n, ids) for n, ids in rows.all()], acc)
        rows = await db.execute(
            select(ContactPoint.kind, ContactPoint.normalized_value, func.array_agg(distinct(ContactPoint.person_id)))
            .join(Person, Person.id == ContactPoint.person_id)
            .where(ContactPoint.deleted_at.is_(None), Person.deleted_at.is_(None))
            .group_by(ContactPoint.kind, ContactPoint.normalized_value)
            .having(func.count(distinct(ContactPoint.person_id)) > 1)
        )
        _pairs([(k, v, ids) for k, v, ids in rows.all()], acc)
    else:
        scanned = await db.scalar(select(func.count()).select_from(Organization).where(Organization.deleted_at.is_(None))) or 0
        rows = await db.execute(
            select(Organization.normalized_name, func.array_agg(Organization.id))
            .where(Organization.deleted_at.is_(None), Organization.normalized_name != "")
            .group_by(Organization.normalized_name).having(func.count() > 1)
        )
        _pairs([("name", n, ids) for n, ids in rows.all()], acc)
        rows = await db.execute(
            select(Organization.domain, func.array_agg(Organization.id))
            .where(Organization.deleted_at.is_(None), Organization.domain.is_not(None),
                   Organization.domain.not_in(list(FREE_EMAIL_DOMAINS)))
            .group_by(Organization.domain).having(func.count() > 1)
        )
        _pairs([("domain", d, ids) for d, ids in rows.all()], acc)
        rows = await db.execute(
            select(ContactPoint.kind, ContactPoint.normalized_value,
                   func.array_agg(distinct(ContactPoint.organization_id)))
            .join(Organization, Organization.id == ContactPoint.organization_id)
            .where(ContactPoint.deleted_at.is_(None), Organization.deleted_at.is_(None))
            .group_by(ContactPoint.kind, ContactPoint.normalized_value)
            .having(func.count(distinct(ContactPoint.organization_id)) > 1)
        )
        _pairs([(k, v, ids) for k, v, ids in rows.all()], acc)

    existing = {
        (a, b): r for r, a, b in (await db.execute(
            select(DuplicateReview, DuplicateReview.a_id, DuplicateReview.b_id)
            .where(DuplicateReview.entity_type == entity_type)
        )).all()
    }
    new = 0
    for (a, b), reasons in acc.items():
        r = existing.get((a, b))
        if r is None:
            db.add(DuplicateReview(entity_type=entity_type, a_id=a, b_id=b, reasons=reasons, score=_score(reasons),
                                   created_by_id=actor.id))
            new += 1
        elif r.status == "open":
            r.reasons, r.score = reasons, _score(reasons)
    await audit.record(db, actor=actor, action="duplicates.scanned", entity_type=entity_type,
                       summary=f"{new} new candidate pairs", ip_address=actor.ip_address)
    await db.commit()
    return int(scanned), new


async def duplicate_queue(db: AsyncSession, entity_type: str | None, status_: str, user: CurrentUser) -> list[DuplicateOut]:
    stmt = select(DuplicateReview).where(DuplicateReview.deleted_at.is_(None), DuplicateReview.status == status_)
    if entity_type:
        stmt = stmt.where(DuplicateReview.entity_type == entity_type)
    rows = list(await db.scalars(stmt.order_by(DuplicateReview.score.desc(), DuplicateReview.created_at.desc()).limit(300)))
    names = {
        "person": await labels(db, "person", {i for r in rows if r.entity_type == "person" for i in (r.a_id, r.b_id)}),
        "organization": await labels(db, "organization",
                                     {i for r in rows if r.entity_type == "organization" for i in (r.a_id, r.b_id)}),
    }
    alive_ids = set()
    for kind, model in (("person", Person), ("organization", Organization)):
        ids = set(names[kind])
        if ids:
            alive_ids |= set(await db.scalars(select(model.id).where(model.id.in_(list(ids)), model.deleted_at.is_(None))))
    sensitive = can_sensitive(user)
    out = []
    for r in rows:
        if status_ == "open" and not (r.a_id in alive_ids and r.b_id in alive_ids):
            continue
        item = DuplicateOut.model_validate(r)
        item.a_label, item.b_label = names[r.entity_type].get(r.a_id), names[r.entity_type].get(r.b_id)
        if not sensitive:
            item.reasons = [
                {**x, "value": mask_point(x["type"], str(x.get("value", "")))} if x.get("type") in ("email", "phone") else x
                for x in r.reasons
            ]
        out.append(item)
    return out


async def dismiss_duplicate(db: AsyncSession, review_id: uuid.UUID, actor: CurrentUser) -> DuplicateReview:
    r = await db.get(DuplicateReview, review_id)
    if not r:
        raise HTTPException(404, "Review item not found")
    r.status, r.reviewed_by_id, r.reviewed_at = "dismissed", actor.id, utcnow()
    await audit.record(db, actor=actor, action="duplicates.dismissed", entity_type=r.entity_type, entity_id=r.a_id,
                       summary=f"Not a duplicate of {r.b_id}", ip_address=actor.ip_address)
    await db.commit()
    return r


# ---------------------------------------------------------------- reversible merge

# (table, fk column, optional (kind column, kind value)) for every row that can point at a person/organization.
PERSON_REFS = [
    ("contact_points", "person_id", None), ("affiliations", "person_id", None),
    ("contact_enrichments", "person_id", None), ("ownership_interests", "owner_person_id", None),
    ("opportunities", "primary_person_id", None), ("interactions", "person_id", None),
    ("entity_links", "from_id", ("from_kind", "person")), ("entity_links", "to_id", ("to_kind", "person")),
    ("owner_notes", "owner_id", ("owner_kind", "person")),
]
ORG_REFS = [
    ("contact_points", "organization_id", None), ("affiliations", "organization_id", None),
    ("contact_enrichments", "organization_id", None), ("ownership_interests", "owner_organization_id", None),
    ("opportunities", "primary_organization_id", None), ("interactions", "organization_id", None),
    ("spaces", "tenant_organization_id", None),
    ("entity_links", "from_id", ("from_kind", "organization")), ("entity_links", "to_id", ("to_kind", "organization")),
    ("owner_notes", "owner_id", ("owner_kind", "organization")),
]
MERGEABLE = {
    "person": {"first_name", "last_name", "full_name", "title", "mailing_address", "city", "state", "postal_code",
               "contact_preferences", "owner_id", "responsiveness", "relationship_strength", "preferences", "notes",
               "tags", "next_action", "next_action_at", "last_touch_at"},
    "organization": {"name", "legal_name", "org_type", "website", "domain", "phone", "mailing_address", "city", "state",
                     "postal_code", "state_of_formation", "registered_agent", "owner_id", "responsiveness",
                     "relationship_strength", "preferences", "notes", "tags", "next_action", "next_action_at",
                     "last_touch_at"},
}


def _snapshot(obj: Any) -> dict:
    return {c.key: to_jsonable(getattr(obj, c.key)) for c in obj.__table__.columns}


async def _repoint(db: AsyncSession, refs: list, old: uuid.UUID, new: uuid.UUID) -> list[dict]:
    moved: list[dict] = []
    for table_name, column, kind in refs:
        t = Base.metadata.tables.get(table_name)
        if t is None or column not in t.c or (kind and kind[0] not in t.c):
            continue
        conds = [t.c[column] == old]
        if kind:
            conds.append(t.c[kind[0]] == kind[1])
        ids = list(await db.scalars(select(t.c.id).where(and_(*conds))))
        if not ids:
            continue
        await db.execute(update(t).where(t.c.id.in_(ids)).values({column: new}))
        moved += [{"table": table_name, "column": column, "row_id": str(i)} for i in ids]
    return moved


async def merge(db: AsyncSession, data: MergeIn, actor: CurrentUser) -> MergeRecord:
    if data.survivor_id == data.merged_id:
        raise HTTPException(400, "Choose two different records")
    kind = data.entity_type
    getter = get_person if kind == "person" else get_org
    survivor = await getter(db, data.survivor_id)
    merged = await getter(db, data.merged_id)
    take = [f for f in data.take_from_merged if f in MERGEABLE[kind]]

    snapshot = _snapshot(merged)
    survivor_before = {f: to_jsonable(getattr(survivor, f)) for f in take}
    for f in take:
        setattr(survivor, f, getattr(merged, f))
    if kind == "person" and {"first_name", "last_name", "full_name"} & set(take):
        survivor.full_name = person_name(survivor.first_name, survivor.last_name, survivor.full_name)
        survivor.normalized_name = normalize_name(survivor.full_name)
    if kind == "organization" and "name" in take:
        survivor.normalized_name = normalize_name(survivor.name)
    survivor.updated_by_id = actor.id

    repointed = await _repoint(db, PERSON_REFS if kind == "person" else ORG_REFS, merged.id, survivor.id)
    merged.merged_into_id = survivor.id
    merged.deleted_at = utcnow()
    merged.updated_by_id = actor.id
    await db.flush()
    if kind == "person":
        await sync_primary(db, person=survivor)  # type: ignore[arg-type]
    else:
        await sync_primary(db, org=survivor)  # type: ignore[arg-type]

    rec = MergeRecord(entity_type=kind, survivor_id=survivor.id, merged_id=merged.id, snapshot=snapshot,
                      survivor_before=survivor_before, repointed=repointed, review_id=data.review_id,
                      reason=data.reason, merged_at=utcnow(), created_by_id=actor.id, updated_by_id=actor.id)
    db.add(rec)
    if data.review_id:
        review = await db.get(DuplicateReview, data.review_id)
        if review:
            review.status, review.reviewed_by_id, review.reviewed_at = "merged", actor.id, utcnow()
    await db.flush()
    label = lambda o: o.full_name if kind == "person" else o.name  # noqa: E731
    await audit.record(db, actor=actor, action=f"{kind}.merged", entity_type=kind, entity_id=survivor.id,
                       summary=f"Merged {label(merged)} into this record ({len(repointed)} linked rows moved)",
                       changes={"merge_id": rec.id, "fields_taken": take}, ip_address=actor.ip_address)
    await audit.record(db, actor=actor, action=f"{kind}.merged_away", entity_type=kind, entity_id=merged.id,
                       summary=f"Merged into {label(survivor)}", changes={"merge_id": rec.id}, ip_address=actor.ip_address)
    await events.emit(db, "contact.merged", entity_type=kind, survivor_id=survivor.id, merged_id=merged.id, actor=actor)
    await db.commit()
    return rec


async def unmerge(db: AsyncSession, merge_id: uuid.UUID, actor: CurrentUser) -> MergeRecord:
    rec = await db.get(MergeRecord, merge_id)
    if not rec:
        raise HTTPException(404, "Merge record not found")
    if rec.status != "merged":
        raise HTTPException(409, "This merge has already been reversed")
    kind = rec.entity_type
    model = Person if kind == "person" else Organization
    merged = await db.get(model, rec.merged_id)
    survivor = await db.get(model, rec.survivor_id)
    if not merged or not survivor:
        raise HTTPException(409, "Records involved in this merge no longer exist")
    if survivor.deleted_at:
        raise HTTPException(409, "The surviving record was later merged or archived; reverse that first")

    for row in rec.repointed:
        t = Base.metadata.tables.get(row["table"])
        if t is None:
            continue
        col = t.c[row["column"]]
        await db.execute(update(t).where(t.c.id == uuid.UUID(row["row_id"]), col == survivor.id)
                         .values({row["column"]: merged.id}))
    snap_fields = {c.key: c for c in model.__table__.columns}
    for f, v in (rec.survivor_before or {}).items():
        col = snap_fields.get(f)
        if col is None:
            continue
        setattr(survivor, f, _from_json(col, v))
    if kind == "person":
        survivor.normalized_name = normalize_name(survivor.full_name)
    else:
        survivor.normalized_name = normalize_name(survivor.name)
    merged.deleted_at = None
    merged.merged_into_id = None
    merged.updated_by_id = survivor.updated_by_id = actor.id
    await db.flush()
    if kind == "person":
        await sync_primary(db, person=survivor)  # type: ignore[arg-type]
        await sync_primary(db, person=merged)  # type: ignore[arg-type]
    else:
        await sync_primary(db, org=survivor)  # type: ignore[arg-type]
        await sync_primary(db, org=merged)  # type: ignore[arg-type]

    rec.status, rec.reversed_at, rec.reversed_by_id = "reversed", utcnow(), actor.id
    if rec.review_id:
        review = await db.get(DuplicateReview, rec.review_id)
        if review:
            review.status = "open"
    for eid, summary in ((survivor.id, "Merge reversed"), (merged.id, "Restored from merge")):
        await audit.record(db, actor=actor, action=f"{kind}.unmerged", entity_type=kind, entity_id=eid,
                           summary=summary, changes={"merge_id": rec.id}, ip_address=actor.ip_address)
    await events.emit(db, "contact.unmerged", entity_type=kind, survivor_id=survivor.id, merged_id=merged.id, actor=actor)
    await db.commit()
    return rec


def _from_json(col: Any, value: Any) -> Any:
    """Turn a JSON snapshot value back into the column's Python type."""
    if value is None:
        return None
    try:
        py = col.type.python_type
    except NotImplementedError:
        return value
    if py is uuid.UUID:
        return uuid.UUID(value)
    if py is datetime:
        return datetime.fromisoformat(value)
    if py is date:
        return date.fromisoformat(value)
    return value


async def merge_history(db: AsyncSession, entity_type: str | None, record_id: uuid.UUID | None) -> list[MergeOut]:
    stmt = select(MergeRecord)
    if entity_type:
        stmt = stmt.where(MergeRecord.entity_type == entity_type)
    if record_id:
        stmt = stmt.where(or_(MergeRecord.survivor_id == record_id, MergeRecord.merged_id == record_id))
    rows = list(await db.scalars(stmt.order_by(MergeRecord.merged_at.desc()).limit(200)))
    out = []
    for kind in ("person", "organization"):
        names = await labels(db, kind, {i for r in rows if r.entity_type == kind for i in (r.survivor_id, r.merged_id)})
        for r in rows:
            if r.entity_type != kind:
                continue
            item = MergeOut.model_validate(r)
            item.survivor_label = names.get(r.survivor_id)
            item.merged_label = names.get(r.merged_id) or (r.snapshot or {}).get("full_name") or (r.snapshot or {}).get("name")
            item.repointed_count = len(r.repointed or [])
            out.append(item)
    out.sort(key=lambda m: m.merged_at, reverse=True)
    return out
