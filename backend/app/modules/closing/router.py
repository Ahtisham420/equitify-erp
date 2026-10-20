import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.closing import service
from app.modules.closing.models import (
    CHECKLIST_CATEGORIES,
    CHECKLIST_TEMPLATE,
    CLOSING_STATUSES,
    HANDOFF_SECTIONS,
    ITEM_STATUSES,
    SOURCE_KINDS,
    USE_KINDS,
    Closing,
    ClosingSnapshot,
    HandoffPackage,
    WireVerification,
)
from app.modules.closing.schemas import (
    AuditCompleteIn,
    CallbackIn,
    ChecklistItemIn,
    ChecklistItemOut,
    ChecklistItemUpdate,
    ClosingCreate,
    ClosingFacets,
    ClosingListItem,
    ClosingOut,
    ClosingUpdate,
    CompleteIn,
    HandoffOut,
    HandoffUpdate,
    MetaOut,
    PostCloseAuditOut,
    SnapshotOut,
    SourcesUsesIn,
    WireIn,
    WireOut,
)
from app.modules.closing.service import ClosingFilters

router = APIRouter(prefix="/closings", tags=["closing"])

SORTS = {
    "scheduled_closing_on": Closing.scheduled_closing_on, "closed_on": Closing.closed_on, "status": Closing.status,
    "purchase_price": Closing.purchase_price, "basis": Closing.basis, "created_at": Closing.created_at,
    "updated_at": Closing.updated_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    coordinator_id: list[uuid.UUID] | None = Query(None),
    manager_id: list[uuid.UUID] | None = Query(None),
    opportunity_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    asset_pending: bool | None = None,
    scheduled_from: date | None = None,
    scheduled_to: date | None = None,
) -> ClosingFilters:
    return ClosingFilters(**locals())


@router.get("", response_model=Page[ClosingListItem])
async def list_closings(db: DB, params: ListParams = Depends(), f: ClosingFilters = Depends(filters),
                        _: CurrentUser = Depends(require("closing", "view"))):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Closing.scheduled_closing_on.asc().nulls_last())
    items, total = await paginate(db, stmt, params)
    return Page[ClosingListItem](items=await service.to_items(db, items), total=total, page=params.page,
                                 page_size=params.page_size)


@router.get("/facets", response_model=ClosingFacets)
async def facets(db: DB, f: ClosingFilters = Depends(filters), _: CurrentUser = Depends(require("closing", "view"))):
    return ClosingFacets(status=await facet_counts(db, service.build_query(f, skip={"status"}), Closing.status))


@router.get("/meta", response_model=MetaOut)
async def meta(_: CurrentUser = Depends(require("closing", "view"))):
    return MetaOut(statuses=CLOSING_STATUSES, categories=CHECKLIST_CATEGORIES, item_statuses=ITEM_STATUSES,
                   source_kinds=SOURCE_KINDS, use_kinds=USE_KINDS, template=CHECKLIST_TEMPLATE,
                   handoff_sections=HANDOFF_SECTIONS)


@router.patch("/checklist/{item_id}", response_model=ChecklistItemOut)
async def update_item(item_id: uuid.UUID, body: ChecklistItemUpdate, db: DB,
                      user: CurrentUser = Depends(require("closing", "edit"))):
    i = await service.update_item(db, await service.get_item(db, item_id), body, user)
    return next(x for x in await service.items(db, await service.get(db, i.closing_id)) if x.id == i.id)


@router.delete("/checklist/{item_id}", status_code=204)
async def delete_item(item_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("closing", "edit"))):
    await service.delete_item(db, await service.get_item(db, item_id), user)


@router.post("/wires/{wire_id}/callback", response_model=WireOut)
async def record_callback(wire_id: uuid.UUID, body: CallbackIn, db: DB,
                          user: CurrentUser = Depends(require("closing", "edit"))):
    w = await service.record_callback(db, await service.get_wire(db, wire_id), body, user)
    return service.wire_out(w, user)


@router.post("", response_model=ClosingOut, status_code=201)
async def create_closing(body: ClosingCreate, db: DB, user: CurrentUser = Depends(require("closing", "create"))):
    return await service.to_out(db, await service.create(db, body, user))


@router.get("/{closing_id}", response_model=ClosingOut)
async def get_closing(closing_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("closing", "view"))):
    return await service.to_out(db, await service.get(db, closing_id))


@router.patch("/{closing_id}", response_model=ClosingOut)
async def update_closing(closing_id: uuid.UUID, body: ClosingUpdate, db: DB,
                         user: CurrentUser = Depends(require("closing", "edit"))):
    return await service.to_out(db, await service.update(db, await service.get(db, closing_id), body, user))


@router.get("/{closing_id}/checklist", response_model=list[ChecklistItemOut])
async def checklist(closing_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("closing", "view"))):
    return await service.items(db, await service.get(db, closing_id))


@router.post("/{closing_id}/checklist", response_model=ChecklistItemOut, status_code=201)
async def add_item(closing_id: uuid.UUID, body: ChecklistItemIn, db: DB,
                   user: CurrentUser = Depends(require("closing", "edit"))):
    c = await service.get(db, closing_id)
    i = await service.add_item(db, c, body, user)
    return next(x for x in await service.items(db, c) if x.id == i.id)


@router.post("/{closing_id}/checklist/apply-template")
async def apply_template(closing_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("closing", "edit"))):
    return {"added": await service.apply_template(db, await service.get(db, closing_id), user)}


@router.get("/{closing_id}/wires", response_model=list[WireOut])
async def wires(closing_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("closing", "view"))):
    await service.get(db, closing_id)
    rows = await db.scalars(select(WireVerification).where(
        WireVerification.closing_id == closing_id, WireVerification.deleted_at.is_(None))
        .order_by(WireVerification.created_at.desc()))
    return [service.wire_out(w, user) for w in rows]


@router.post("/{closing_id}/wires", response_model=WireOut, status_code=201)
async def add_wire(closing_id: uuid.UUID, body: WireIn, db: DB, user: CurrentUser = Depends(require("closing", "edit"))):
    w = await service.add_wire(db, await service.get(db, closing_id), body, user)
    return service.wire_out(w, user)


@router.put("/{closing_id}/sources-uses", response_model=ClosingOut)
async def sources_uses(closing_id: uuid.UUID, body: SourcesUsesIn, db: DB,
                       user: CurrentUser = Depends(require("closing", "edit"))):
    c = await service.set_sources_uses(db, await service.get(db, closing_id), body, user)
    return await service.to_out(db, c)


@router.post("/{closing_id}/complete", response_model=ClosingOut)
async def complete(closing_id: uuid.UUID, body: CompleteIn, db: DB,
                   user: CurrentUser = Depends(require("closing", "approve"))):
    c = await service.complete(db, await service.get(db, closing_id), body, user)
    return await service.to_out(db, c)


@router.post("/{closing_id}/retry-asset", response_model=ClosingOut)
async def retry_asset(closing_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("closing", "edit"))):
    c = await service.retry_asset(db, await service.get(db, closing_id), user)
    return await service.to_out(db, c)


@router.get("/{closing_id}/snapshot", response_model=SnapshotOut)
async def snapshot(closing_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("closing", "view"))):
    await service.get(db, closing_id)
    snap = await db.scalar(select(ClosingSnapshot).where(ClosingSnapshot.closing_id == closing_id))
    if not snap:
        raise HTTPException(404, "No snapshot yet: it is written when the closing completes")
    return snap


async def _package(db, closing_id: uuid.UUID) -> HandoffPackage:
    await service.get(db, closing_id)
    pkg = await db.scalar(select(HandoffPackage).where(HandoffPackage.closing_id == closing_id,
                                                       HandoffPackage.deleted_at.is_(None)))
    if not pkg:
        raise HTTPException(404, "The handoff package is generated when the closing completes")
    return pkg


@router.get("/{closing_id}/handoff", response_model=HandoffOut)
async def handoff(closing_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("closing", "view"))):
    return await _package(db, closing_id)


@router.patch("/{closing_id}/handoff", response_model=HandoffOut)
async def update_handoff(closing_id: uuid.UUID, body: HandoffUpdate, db: DB,
                         user: CurrentUser = Depends(require("closing", "edit"))):
    return await service.update_handoff(db, await _package(db, closing_id), body, user)


@router.post("/{closing_id}/handoff/acknowledge", response_model=HandoffOut)
async def acknowledge_handoff(closing_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("closing", "view"))):
    # Operations (asset managers) acknowledge receipt; they may hold assets rights without closing edit.
    if not (user.can("closing", "edit") or user.can("assets", "edit")):
        raise HTTPException(403, "Missing permission closing:edit or assets:edit")
    return await service.acknowledge_handoff(db, await _package(db, closing_id), user)


@router.get("/{closing_id}/post-close-audit", response_model=PostCloseAuditOut)
async def post_close_audit(closing_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("closing", "view"))):
    return await service.post_close_audit(db, await service.get(db, closing_id))


@router.post("/{closing_id}/post-close-audit/complete", response_model=ClosingOut)
async def complete_audit(closing_id: uuid.UUID, body: AuditCompleteIn, db: DB,
                         user: CurrentUser = Depends(require("closing", "view"))):
    if not (user.can("closing", "edit") or user.can("assets", "edit")):
        raise HTTPException(403, "Missing permission closing:edit or assets:edit")
    c = await service.complete_audit(db, await service.get(db, closing_id), body, user)
    return await service.to_out(db, c)
