import csv
import io
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from app.common import audit, provenance
from app.common.provenance import ObservationOut
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.ownership import service
from app.modules.ownership.models import (
    EVIDENCE_TYPES,
    FINANCING_TYPES,
    INTEREST_ROLES,
    LINK_RELATIONSHIPS,
    NOTE_CATEGORIES,
    EntityLink,
    OwnershipInterest,
)
from app.modules.ownership.schemas import (
    EndInterestIn,
    InterestFacets,
    InterestIn,
    InterestOut,
    InterestUpdate,
    LinkFacets,
    LinkIn,
    LinkOut,
    LinkReviewIn,
    LinkUpdate,
    NoteIn,
    NoteOut,
    OwnerProfile,
    PanelOut,
    SuggestOut,
    VerifyIn,
    WarmPath,
)
from app.modules.ownership.service import InterestFilters, LinkFilters

router = APIRouter(prefix="/ownership", tags=["ownership"])

OwnerKind = Literal["person", "organization"]


def interest_filters(
    q: str | None = Query(None, max_length=200),
    property_id: uuid.UUID | None = None,
    owner_kind: list[str] | None = Query(None),
    owner_id: uuid.UUID | None = None,
    role: list[str] | None = Query(None),
    verification: list[str] | None = Query(None),
    current: bool | None = None,
    state: list[str] | None = Query(None),
    mismatch: bool | None = None,
) -> InterestFilters:
    return InterestFilters(**locals())


def link_filters(
    status: list[str] | None = Query(None),
    relationship: list[str] | None = Query(None),
    suggested_by: str | None = None,
    node_id: uuid.UUID | None = None,
    min_confidence: float | None = Query(None, ge=0, le=1),
) -> LinkFilters:
    return LinkFilters(**locals())


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("ownership", "view"))):
    return {"roles": INTEREST_ROLES, "financing_types": FINANCING_TYPES, "relationships": LINK_RELATIONSHIPS,
            "control_relationships": sorted(service.CONTROL_RELATIONSHIPS), "evidence_types": EVIDENCE_TYPES,
            "note_categories": NOTE_CATEGORIES}


# ---------------------------------------------------------------- interests

@router.get("/interests", response_model=Page[InterestOut])
async def list_interests(db: DB, params: ListParams = Depends(), f: InterestFilters = Depends(interest_filters),
                         user: CurrentUser = Depends(require("ownership", "view"))):
    stmt = apply_sort(service.with_labels(service.build_interest_query(f)), params.sort, service.interest_sorts(),
                      OwnershipInterest.updated_at.desc())
    rows, total = await paginate(db, stmt, params, scalars=False)
    show = service.can_see_sensitive(user)
    return Page[InterestOut](items=[service.row_to_out(r, show) for r in rows], total=total, page=params.page,
                page_size=params.page_size)


@router.get("/interests/facets", response_model=InterestFacets)
async def interest_facets(db: DB, f: InterestFilters = Depends(interest_filters),
                          _: CurrentUser = Depends(require("ownership", "view"))):
    q = service.build_interest_query
    return InterestFacets(
        role=await facet_counts(db, q(f, skip={"role"}), OwnershipInterest.role),
        verification=await facet_counts(db, q(f, skip={"verification"}), OwnershipInterest.verification),
        owner_kind=await facet_counts(db, q(f, skip={"owner_kind"}), OwnershipInterest.owner_kind),
    )


@router.get("/interests/export")
async def export_interests(db: DB, params: ListParams = Depends(), f: InterestFilters = Depends(interest_filters),
                           user: CurrentUser = Depends(require("ownership", "export"))):
    stmt = apply_sort(service.with_labels(service.build_interest_query(f)), params.sort, service.interest_sorts(),
                      OwnershipInterest.updated_at.desc()).limit(50_000)
    rows = (await db.execute(stmt)).all()
    cols = ["id", "property_id", "property", "property_state", "owner_kind", "owner_id", "owner", "owner_state", "role",
            "interest_pct", "effective_from", "effective_to", "acquired_price", "disposed_price", "financing_type",
            "source", "confidence", "verification", "evidence_types"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        o = service.row_to_out(r, False)
        # Export is an outbound payload: sensitive evidence is never included.
        w.writerow([o.id, o.property_id, o.property_label, o.property_state, o.owner_kind, o.owner_id, o.owner_label,
                    o.owner_state, o.role, o.interest_pct, o.effective_from, o.effective_to, o.acquired_price,
                    o.disposed_price, o.financing_type, o.source, o.confidence, o.verification,
                    "; ".join(e.get("type", "") for e in service.outbound_evidence(r[0].evidence))])
    await audit.record(db, actor=user, action="ownership_interest.exported", entity_type="ownership_interest",
                       summary=f"{len(rows)} rows", ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=ownership-interests.csv"})


@router.post("/interests", response_model=InterestOut, status_code=201)
async def create_interest(body: InterestIn, db: DB, user: CurrentUser = Depends(require("ownership", "create"))):
    oi = await service.create_interest(db, body, user)
    return await service.interest_full(db, oi.id, user)


@router.get("/interests/{interest_id}", response_model=InterestOut)
async def get_interest(interest_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("ownership", "view"))):
    return await service.interest_full(db, interest_id, user)


@router.patch("/interests/{interest_id}", response_model=InterestOut)
async def update_interest(interest_id: uuid.UUID, body: InterestUpdate, db: DB,
                          user: CurrentUser = Depends(require("ownership", "edit"))):
    await service.update_interest(db, await service.get_interest(db, interest_id), body, user)
    return await service.interest_full(db, interest_id, user)


@router.post("/interests/{interest_id}/end", response_model=InterestOut)
async def end_interest(interest_id: uuid.UUID, body: EndInterestIn, db: DB,
                       user: CurrentUser = Depends(require("ownership", "edit"))):
    await service.end_interest(db, await service.get_interest(db, interest_id), body, user)
    return await service.interest_full(db, interest_id, user)


@router.post("/interests/{interest_id}/verify", response_model=InterestOut)
async def verify_interest(interest_id: uuid.UUID, body: VerifyIn, db: DB,
                          user: CurrentUser = Depends(require("ownership", "approve"))):
    await service.verify_interest(db, await service.get_interest(db, interest_id), body.state, user)
    return await service.interest_full(db, interest_id, user)


@router.get("/interests/{interest_id}/history", response_model=list[ObservationOut])
async def interest_history(interest_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("ownership", "view"))):
    return await provenance.history(db, service.ENTITY, interest_id)


@router.get("/properties/{property_id}/panel", response_model=PanelOut)
async def property_panel(property_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("ownership", "view"))):
    return await service.property_panel(db, property_id, user)


# ---------------------------------------------------------------- entity links

@router.get("/links", response_model=Page[LinkOut])
async def list_links(db: DB, params: ListParams = Depends(), f: LinkFilters = Depends(link_filters),
                     user: CurrentUser = Depends(require("ownership", "view"))):
    sorts = {"confidence": EntityLink.confidence, "created_at": EntityLink.created_at,
             "relationship": EntityLink.relationship, "status": EntityLink.status}
    stmt = apply_sort(service.build_link_query(f), params.sort, sorts, EntityLink.confidence.desc())
    rows, total = await paginate(db, stmt, params)
    return Page[LinkOut](items=await service.links_out(db, rows, user), total=total, page=params.page, page_size=params.page_size)


@router.get("/links/facets", response_model=LinkFacets)
async def link_facets(db: DB, f: LinkFilters = Depends(link_filters), _: CurrentUser = Depends(require("ownership", "view"))):
    return LinkFacets(
        status=await facet_counts(db, service.build_link_query(f, skip={"status"}), EntityLink.status),
        relationship=await facet_counts(db, service.build_link_query(f, skip={"relationship"}), EntityLink.relationship),
    )


@router.get("/links/export")
async def export_links(db: DB, f: LinkFilters = Depends(link_filters),
                       user: CurrentUser = Depends(require("ownership", "export"))):
    rows = list(await db.scalars(service.build_link_query(f).order_by(EntityLink.created_at.desc()).limit(50_000)))
    info = await service.node_info(db, {n for l in rows for n in ((l.from_kind, l.from_id), (l.to_kind, l.to_id))})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "from_kind", "from_id", "from", "relationship", "to_kind", "to_id", "to", "status", "confidence",
                "evidence", "source", "reviewed_at"])
    for l in rows:
        ev = "; ".join(f"{e.get('type')}: {e.get('detail') or ''}".strip() for e in service.outbound_evidence(l.evidence))
        w.writerow([l.id, l.from_kind, l.from_id, info.get((l.from_kind, l.from_id), {}).get("label"), l.relationship,
                    l.to_kind, l.to_id, info.get((l.to_kind, l.to_id), {}).get("label"), l.status, l.confidence, ev,
                    l.source, l.reviewed_at])
    await audit.record(db, actor=user, action="entity_link.exported", entity_type="entity_link",
                       summary=f"{len(rows)} rows", ip_address=user.ip_address)
    await db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=entity-relationships.csv"})


@router.post("/links/suggest", response_model=SuggestOut)
async def suggest_links(db: DB, user: CurrentUser = Depends(require("ownership", "edit"))):
    created, updated = await service.suggest_links(db, user)
    return SuggestOut(created=created, updated=updated)


@router.post("/links", response_model=LinkOut, status_code=201)
async def create_link(body: LinkIn, db: DB, user: CurrentUser = Depends(require("ownership", "create"))):
    return (await service.links_out(db, [await service.create_link(db, body, user)], user))[0]


@router.patch("/links/{link_id}", response_model=LinkOut)
async def update_link(link_id: uuid.UUID, body: LinkUpdate, db: DB,
                      user: CurrentUser = Depends(require("ownership", "edit"))):
    link = await service.update_link(db, await service.get_link(db, link_id), body, user)
    return (await service.links_out(db, [link], user))[0]


@router.post("/links/{link_id}/confirm", response_model=LinkOut)
async def confirm_link(link_id: uuid.UUID, body: LinkReviewIn, db: DB,
                       user: CurrentUser = Depends(require("ownership", "edit"))):
    link = await service.review_link(db, await service.get_link(db, link_id), "confirmed", body, user)
    return (await service.links_out(db, [link], user))[0]


@router.post("/links/{link_id}/reject", response_model=LinkOut)
async def reject_link(link_id: uuid.UUID, body: LinkReviewIn, db: DB,
                      user: CurrentUser = Depends(require("ownership", "edit"))):
    link = await service.review_link(db, await service.get_link(db, link_id), "rejected", body, user)
    return (await service.links_out(db, [link], user))[0]


# ---------------------------------------------------------------- owners

@router.get("/owners/{kind}/{owner_id}", response_model=OwnerProfile)
async def owner_profile(kind: OwnerKind, owner_id: uuid.UUID, db: DB,
                        user: CurrentUser = Depends(require("ownership", "view"))):
    return await service.owner_profile(db, kind, owner_id, user)


@router.get("/owners/{kind}/{owner_id}/notes", response_model=list[NoteOut])
async def owner_notes(kind: OwnerKind, owner_id: uuid.UUID, db: DB,
                      user: CurrentUser = Depends(require("ownership", "view"))):
    notes, _ = await service.notes_for(db, kind, owner_id, user)
    return notes


@router.post("/owners/{kind}/{owner_id}/notes", response_model=NoteOut, status_code=201)
async def add_owner_note(kind: OwnerKind, owner_id: uuid.UUID, body: NoteIn, db: DB,
                         user: CurrentUser = Depends(require("ownership", "edit"))):
    return await service.add_note(db, kind, owner_id, body, user)


@router.delete("/notes/{note_id}", status_code=204)
async def remove_owner_note(note_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("ownership", "edit"))):
    await service.remove_note(db, note_id, user)


@router.get("/owners/{kind}/{owner_id}/outbound-context")
async def outbound_context(kind: OwnerKind, owner_id: uuid.UUID, db: DB,
                           _: CurrentUser = Depends(require("ownership", "view"))):
    return await service.outbound_context(db, kind, owner_id)


@router.get("/paths", response_model=list[WarmPath])
async def warm_paths(
    db: DB,
    target_kind: Literal["person", "organization", "property"],
    target_id: uuid.UUID,
    from_kind: Literal["person", "organization"] | None = None,
    from_id: uuid.UUID | None = None,
    max_depth: int = Query(3, ge=1, le=4),
    limit: int = Query(5, ge=1, le=20),
    _: CurrentUser = Depends(require("ownership", "view")),
):
    start = (from_kind, from_id) if from_kind and from_id else None
    return await service.warm_paths(db, (target_kind, target_id), start, max_depth, limit)
