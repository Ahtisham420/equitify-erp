import csv
import io
import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.common import audit
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.contacts import service
from app.modules.contacts.models import (
    ORG_TYPES,
    PHONE_TYPES,
    RESPONSIVENESS,
    ROLES,
    STRENGTHS,
    Organization,
    Person,
)
from app.modules.contacts.schemas import (
    AffiliationIn,
    AffiliationOut,
    AffiliationUpdate,
    BulkIn,
    ContactPointIn,
    ContactPointOut,
    ContactPointUpdate,
    ContextOut,
    DuplicateOut,
    EnrichmentIn,
    EnrichmentOut,
    MergeIn,
    MergeOut,
    OrganizationCreate,
    OrganizationFacets,
    OrganizationListItem,
    OrganizationOut,
    OrganizationUpdate,
    PeopleFacets,
    PersonCreate,
    PersonListItem,
    PersonOut,
    PersonUpdate,
    ScanOut,
)
from app.modules.contacts.service import OrgFilters, PeopleFilters

router = APIRouter(tags=["contacts"])

PEOPLE_SORTS = {
    "full_name": Person.full_name, "state": Person.state, "last_touch_at": Person.last_touch_at,
    "next_action_at": Person.next_action_at, "relationship_strength": Person.relationship_strength,
    "updated_at": Person.updated_at, "created_at": Person.created_at,
}
ORG_SORTS = {
    "name": Organization.name, "org_type": Organization.org_type, "state": Organization.state,
    "last_touch_at": Organization.last_touch_at, "next_action_at": Organization.next_action_at,
    "updated_at": Organization.updated_at, "created_at": Organization.created_at,
}


def people_filters(
    q: str | None = Query(None, max_length=200),
    state: list[str] | None = Query(None),
    relationship_strength: list[str] | None = Query(None),
    responsiveness: list[str] | None = Query(None),
    role: list[str] | None = Query(None),
    organization_id: uuid.UUID | None = None,
    owner_id: uuid.UUID | None = None,
    tag: list[str] | None = Query(None),
    has_next_action: bool | None = None,
    overdue: bool | None = None,
    touched_before: date | None = None,
    ids: list[uuid.UUID] | None = Query(None),
) -> PeopleFilters:
    return PeopleFilters(**locals())


def org_filters(
    q: str | None = Query(None, max_length=200),
    org_type: list[str] | None = Query(None),
    state: list[str] | None = Query(None),
    relationship_strength: list[str] | None = Query(None),
    owner_id: uuid.UUID | None = None,
    tag: list[str] | None = Query(None),
    has_next_action: bool | None = None,
    ids: list[uuid.UUID] | None = Query(None),
) -> OrgFilters:
    return OrgFilters(**locals())


@router.get("/contacts/meta")
async def meta(_: CurrentUser = Depends(require("contacts", "view"))):
    return {"roles": ROLES, "org_types": ORG_TYPES, "phone_types": PHONE_TYPES, "strengths": STRENGTHS,
            "responsiveness": RESPONSIVENESS, "mergeable": {k: sorted(v) for k, v in service.MERGEABLE.items()}}


# ---------------------------------------------------------------- duplicates & merges

@router.get("/contacts/duplicates", response_model=list[DuplicateOut])
async def duplicate_queue(
    db: DB, entity_type: Literal["person", "organization"] | None = None,
    status: Literal["open", "merged", "dismissed"] = "open",
    user: CurrentUser = Depends(require("contacts", "view")),
):
    return await service.duplicate_queue(db, entity_type, status, user)


@router.post("/contacts/duplicates/scan", response_model=ScanOut)
async def scan_duplicates(db: DB, entity_type: Literal["person", "organization"],
                          user: CurrentUser = Depends(require("contacts", "edit"))):
    scanned, new = await service.scan_duplicates(db, entity_type, user)
    return ScanOut(scanned=scanned, new_candidates=new)


@router.post("/contacts/duplicates/{review_id}/dismiss", response_model=DuplicateOut)
async def dismiss_duplicate(review_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "edit"))):
    return DuplicateOut.model_validate(await service.dismiss_duplicate(db, review_id, user))


@router.post("/contacts/merge", response_model=MergeOut)
async def merge(body: MergeIn, db: DB, user: CurrentUser = Depends(require("contacts", "edit"))):
    rec = await service.merge(db, body, user)
    return (await service.merge_history(db, rec.entity_type, rec.survivor_id))[0]


@router.get("/contacts/merges", response_model=list[MergeOut])
async def merges(db: DB, entity_type: Literal["person", "organization"] | None = None,
                 record_id: uuid.UUID | None = None, _: CurrentUser = Depends(require("contacts", "view"))):
    return await service.merge_history(db, entity_type, record_id)


@router.post("/contacts/merges/{merge_id}/unmerge", response_model=MergeOut)
async def unmerge(merge_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "edit"))):
    rec = await service.unmerge(db, merge_id, user)
    return next(m for m in await service.merge_history(db, rec.entity_type, rec.survivor_id) if m.id == rec.id)


# ---------------------------------------------------------------- contact points & affiliations

@router.patch("/contact-points/{cp_id}", response_model=ContactPointOut)
async def update_contact_point(cp_id: uuid.UUID, body: ContactPointUpdate, db: DB,
                               user: CurrentUser = Depends(require("contacts", "edit"))):
    if not service.can_sensitive(user):
        raise HTTPException(403, "Editing contact details requires contacts:view_sensitive")
    cp = await service.update_contact_point(db, await service.get_point(db, cp_id), body, user)
    return service.point_out(cp, True)


@router.delete("/contact-points/{cp_id}", status_code=204)
async def remove_contact_point(cp_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "edit"))):
    await service.remove_contact_point(db, await service.get_point(db, cp_id), user)


@router.post("/affiliations", response_model=AffiliationOut, status_code=201)
async def create_affiliation(body: AffiliationIn, db: DB, user: CurrentUser = Depends(require("contacts", "edit"))):
    a = await service.create_affiliation(db, body, user)
    return next(x for x in await service.affiliations_for(db, person_id=a.person_id) if x.id == a.id)


@router.patch("/affiliations/{aff_id}", response_model=AffiliationOut)
async def update_affiliation(aff_id: uuid.UUID, body: AffiliationUpdate, db: DB,
                             user: CurrentUser = Depends(require("contacts", "edit"))):
    a = await service.update_affiliation(db, aff_id, body, user)
    return next(x for x in await service.affiliations_for(db, person_id=a.person_id) if x.id == a.id)


# ---------------------------------------------------------------- people

@router.get("/people", response_model=Page[PersonListItem])
async def list_people(db: DB, params: ListParams = Depends(), f: PeopleFilters = Depends(people_filters),
                      user: CurrentUser = Depends(require("contacts", "view"))):
    stmt = apply_sort(service.build_people_query(f, sensitive=service.can_sensitive(user)), params.sort, PEOPLE_SORTS,
                      Person.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[PersonListItem](items=await service.people_items(db, rows, user), total=total, page=params.page,
                page_size=params.page_size)


@router.get("/people/facets", response_model=PeopleFacets)
async def people_facets(db: DB, f: PeopleFilters = Depends(people_filters),
                        user: CurrentUser = Depends(require("contacts", "view"))):
    s = service.can_sensitive(user)
    q = service.build_people_query
    return PeopleFacets(
        state=await facet_counts(db, q(f, sensitive=s, skip={"state"}), Person.state),
        relationship_strength=await facet_counts(db, q(f, sensitive=s, skip={"relationship_strength"}),
                                                 Person.relationship_strength),
        responsiveness=await facet_counts(db, q(f, sensitive=s, skip={"responsiveness"}), Person.responsiveness),
        role=await service.role_facets(db, q(f, sensitive=s, skip={"role"})),
    )


@router.get("/people/export")
async def export_people(db: DB, params: ListParams = Depends(), f: PeopleFilters = Depends(people_filters),
                        user: CurrentUser = Depends(require("contacts", "export"))):
    sensitive = service.can_sensitive(user)
    stmt = apply_sort(service.build_people_query(f, sensitive=sensitive), params.sort, PEOPLE_SORTS,
                      Person.updated_at.desc()).limit(50_000)
    rows = list(await db.scalars(stmt))
    cols = ["id", "full_name", "title", "primary_email", "primary_phone", "mailing_address", "city", "state",
            "postal_code", "relationship_strength", "responsiveness", "last_touch_at", "next_action_at"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        vals = {c: getattr(r, c) for c in cols}
        if not sensitive:
            vals["primary_email"] = service.mask_email(r.primary_email)
            vals["primary_phone"] = service.mask_phone(r.primary_phone)
            vals["mailing_address"] = vals["postal_code"] = None
        w.writerow([vals[c] for c in cols])
    await audit.record(db, actor=user, action="person.exported", entity_type="person", summary=f"{len(rows)} rows",
                       changes={"sensitive_included": sensitive}, ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=people.csv"})


@router.post("/people", response_model=PersonOut, status_code=201)
async def create_person(body: PersonCreate, db: DB, force: bool = False,
                        user: CurrentUser = Depends(require("contacts", "create"))):
    return await service.person_out(db, await service.create_person(db, body, user, force=force), user)


@router.post("/people/bulk")
async def bulk_people(body: BulkIn, db: DB, user: CurrentUser = Depends(require("contacts", "edit"))):
    return {"updated": await service.bulk_update(db, "person", body, user)}


@router.get("/people/{person_id}", response_model=PersonOut)
async def get_person(person_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "view"))):
    return await service.person_out(db, await service.get_person(db, person_id), user)


@router.patch("/people/{person_id}", response_model=PersonOut)
async def update_person(person_id: uuid.UUID, body: PersonUpdate, db: DB,
                        user: CurrentUser = Depends(require("contacts", "edit"))):
    p = await service.update_person(db, await service.get_person(db, person_id), body, user)
    return await service.person_out(db, p, user)


@router.delete("/people/{person_id}", status_code=204)
async def archive_person(person_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "delete"))):
    await service.archive_person(db, await service.get_person(db, person_id), user)


@router.post("/people/{person_id}/contact-points", response_model=ContactPointOut, status_code=201)
async def add_person_point(person_id: uuid.UUID, body: ContactPointIn, db: DB,
                           user: CurrentUser = Depends(require("contacts", "edit"))):
    cp = await service.add_contact_point(db, "person", person_id, body, user)
    return service.point_out(cp, service.can_sensitive(user))


@router.get("/people/{person_id}/enrichments", response_model=list[EnrichmentOut])
async def person_enrichments(person_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("contacts", "view"))):
    return await service.enrichments(db, "person", person_id)


@router.post("/people/{person_id}/enrichments", response_model=EnrichmentOut, status_code=201)
async def add_person_enrichment(person_id: uuid.UUID, body: EnrichmentIn, db: DB,
                                user: CurrentUser = Depends(require("contacts", "edit"))):
    return await service.add_enrichment(db, "person", person_id, body, user)


@router.get("/people/{person_id}/context", response_model=ContextOut)
async def person_context(person_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("contacts", "view"))):
    await service.get_person(db, person_id)
    return await service.context(db, "person", person_id)


# ---------------------------------------------------------------- organizations

@router.get("/organizations", response_model=Page[OrganizationListItem])
async def list_orgs(db: DB, params: ListParams = Depends(), f: OrgFilters = Depends(org_filters),
                    user: CurrentUser = Depends(require("contacts", "view"))):
    stmt = apply_sort(service.build_org_query(f), params.sort, ORG_SORTS, Organization.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[OrganizationListItem](items=await service.org_items(db, rows, user), total=total, page=params.page,
                page_size=params.page_size)


@router.get("/organizations/facets", response_model=OrganizationFacets)
async def org_facets(db: DB, f: OrgFilters = Depends(org_filters), _: CurrentUser = Depends(require("contacts", "view"))):
    q = service.build_org_query
    return OrganizationFacets(
        org_type=await facet_counts(db, q(f, skip={"org_type"}), Organization.org_type),
        state=await facet_counts(db, q(f, skip={"state"}), Organization.state),
        relationship_strength=await facet_counts(db, q(f, skip={"relationship_strength"}),
                                                 Organization.relationship_strength),
    )


@router.get("/organizations/export")
async def export_orgs(db: DB, params: ListParams = Depends(), f: OrgFilters = Depends(org_filters),
                      user: CurrentUser = Depends(require("contacts", "export"))):
    sensitive = service.can_sensitive(user)
    stmt = apply_sort(service.build_org_query(f), params.sort, ORG_SORTS, Organization.updated_at.desc()).limit(50_000)
    rows = list(await db.scalars(stmt))
    cols = ["id", "name", "legal_name", "org_type", "website", "domain", "phone", "mailing_address", "city", "state",
            "postal_code", "state_of_formation", "registered_agent", "relationship_strength", "last_touch_at"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        vals = {c: getattr(r, c) for c in cols}
        if not sensitive:
            vals["phone"] = service.mask_phone(r.phone)
            vals["mailing_address"] = vals["postal_code"] = None
        w.writerow([vals[c] for c in cols])
    await audit.record(db, actor=user, action="organization.exported", entity_type="organization",
                       summary=f"{len(rows)} rows", changes={"sensitive_included": sensitive}, ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=organizations.csv"})


@router.post("/organizations", response_model=OrganizationOut, status_code=201)
async def create_org(body: OrganizationCreate, db: DB, force: bool = False,
                     user: CurrentUser = Depends(require("contacts", "create"))):
    return await service.org_out(db, await service.create_org(db, body, user, force=force), user)


@router.post("/organizations/bulk")
async def bulk_orgs(body: BulkIn, db: DB, user: CurrentUser = Depends(require("contacts", "edit"))):
    return {"updated": await service.bulk_update(db, "organization", body, user)}


@router.get("/organizations/{org_id}", response_model=OrganizationOut)
async def get_org(org_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "view"))):
    return await service.org_out(db, await service.get_org(db, org_id), user)


@router.patch("/organizations/{org_id}", response_model=OrganizationOut)
async def update_org(org_id: uuid.UUID, body: OrganizationUpdate, db: DB,
                     user: CurrentUser = Depends(require("contacts", "edit"))):
    o = await service.update_org(db, await service.get_org(db, org_id), body, user)
    return await service.org_out(db, o, user)


@router.delete("/organizations/{org_id}", status_code=204)
async def archive_org(org_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("contacts", "delete"))):
    await service.archive_org(db, await service.get_org(db, org_id), user)


@router.post("/organizations/{org_id}/contact-points", response_model=ContactPointOut, status_code=201)
async def add_org_point(org_id: uuid.UUID, body: ContactPointIn, db: DB,
                        user: CurrentUser = Depends(require("contacts", "edit"))):
    cp = await service.add_contact_point(db, "organization", org_id, body, user)
    return service.point_out(cp, service.can_sensitive(user))


@router.get("/organizations/{org_id}/enrichments", response_model=list[EnrichmentOut])
async def org_enrichments(org_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("contacts", "view"))):
    return await service.enrichments(db, "organization", org_id)


@router.post("/organizations/{org_id}/enrichments", response_model=EnrichmentOut, status_code=201)
async def add_org_enrichment(org_id: uuid.UUID, body: EnrichmentIn, db: DB,
                             user: CurrentUser = Depends(require("contacts", "edit"))):
    return await service.add_enrichment(db, "organization", org_id, body, user)


@router.get("/organizations/{org_id}/context", response_model=ContextOut)
async def org_context(org_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("contacts", "view"))):
    await service.get_org(db, org_id)
    return await service.context(db, "organization", org_id)
