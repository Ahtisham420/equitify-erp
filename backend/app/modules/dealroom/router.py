import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from app.common.query import ListParams, Page, apply_search, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, Authed, CurrentUser, require
from app.modules.dealroom import service
from app.modules.dealroom.models import (
    ACCESS_ACTIONS,
    AD_CHECKLIST,
    AD_REVIEW_STATUSES,
    DELIVERY_METHODS,
    DISCLOSURE_STATUSES,
    DISCLOSURE_TYPES,
    FILE_CATEGORIES,
    FILE_ITEM_STATUSES,
    FINANCING_TYPES,
    INTEREST_LEVELS,
    LICENSE_STATUSES,
    LICENSE_TYPES,
    NDA_STATUSES,
    OFFER_STATUSES,
    ROOM_STATUSES,
    STOP_STATUSES,
    TOUR_STATUSES,
    AdReview,
    AgentLicense,
    DealRoom,
    DealRoomAccess,
    DealRoomFolder,
    Disclosure,
    Nda,
    OfferSubmission,
    Tour,
    TourFeedback,
    TourStop,
    TransactionFile,
    TransactionFileItem,
)
from app.modules.dealroom.schemas import (
    AccessIn,
    AccessOut,
    AccessUpdate,
    AcknowledgeIn,
    AdDecisionIn,
    AdReviewBase,
    AdReviewOut,
    AnalyticsOut,
    CompletenessOut,
    DeliverIn,
    DisclosureBase,
    DisclosureOut,
    DisclosureUpdate,
    FeedbackIn,
    FeedbackOut,
    FileItemIn,
    FileItemOut,
    FileItemUpdate,
    FileOut,
    FolderIn,
    FolderOut,
    FolderUpdate,
    LicenseBase,
    LicenseOut,
    LicenseUpdate,
    NdaBase,
    NdaOut,
    NdaUpdate,
    OfferIn,
    OfferOut,
    OfferReviewIn,
    OpenOut,
    OptimizeOut,
    PortalRoomOut,
    RoomCreate,
    RoomOut,
    RoomUpdate,
    ScanOut,
    StopIn,
    StopOut,
    StopUpdate,
    TourCreate,
    TourOut,
    TourUpdate,
    WaiveIn,
)

router = APIRouter(tags=["dealroom"])

VIEW = Depends(require("dealroom", "view"))
CREATE = Depends(require("dealroom", "create"))
EDIT = Depends(require("dealroom", "edit"))
APPROVE = Depends(require("dealroom", "approve"))
DELETE = Depends(require("dealroom", "delete"))


def page_of(schema, items, total, params: ListParams):
    return Page[schema](items=items, total=total, page=params.page, page_size=params.page_size)


def record_scope(stmt, model, user: CurrentUser):
    """Rows tied to a listing / brokerage deal are only visible with brokerage view permission."""
    if user.can("brokerage", "view"):
        return stmt
    conds = [getattr(model, c).is_(None) for c in ("listing_id", "brokerage_deal_id") if hasattr(model, c)]
    return stmt.where(*conds)


@router.get("/dealroom/meta")
async def meta(_: CurrentUser = VIEW):
    return {
        "tour_statuses": TOUR_STATUSES, "stop_statuses": STOP_STATUSES, "interest_levels": INTEREST_LEVELS,
        "nda_statuses": NDA_STATUSES, "room_statuses": ROOM_STATUSES, "access_actions": ACCESS_ACTIONS,
        "offer_statuses": OFFER_STATUSES, "financing_types": FINANCING_TYPES, "license_types": LICENSE_TYPES,
        "license_statuses": LICENSE_STATUSES, "disclosure_types": DISCLOSURE_TYPES,
        "disclosure_statuses": DISCLOSURE_STATUSES, "delivery_methods": DELIVERY_METHODS,
        "ad_review_statuses": AD_REVIEW_STATUSES, "ad_checklist": [{"key": k, "label": v} for k, v in AD_CHECKLIST],
        "file_item_statuses": FILE_ITEM_STATUSES, "file_categories": FILE_CATEGORIES,
    }


@router.get("/dealroom/compliance-summary")
async def compliance_summary(db: DB, _: CurrentUser = VIEW):
    today = service.today()
    lic = list(await db.scalars(select(AgentLicense).where(AgentLicense.deleted_at.is_(None))))
    discs = list(await db.scalars(select(Disclosure).where(Disclosure.deleted_at.is_(None))))
    open_discs = [d for d in discs if not service.disclosure_satisfied(d)]
    files = list(await db.scalars(select(TransactionFile).where(TransactionFile.deleted_at.is_(None),
                                                                TransactionFile.status != "approved")))
    incomplete = 0
    for f in files:
        _, blockers = await service.evaluate_file(db, f)
        incomplete += bool(blockers)
    return {
        "licenses_expiring": sum(1 for x in lic if service.license_alert_level(x) in ("warning", "critical")),
        "licenses_expired": sum(1 for x in lic if service.license_alert_level(x) == "expired"),
        "disclosures_open": len(open_discs),
        "disclosures_overdue": sum(1 for d in open_discs if d.due_on and d.due_on < today),
        "ad_reviews_pending": int(await db.scalar(select(func.count()).select_from(AdReview).where(
            AdReview.deleted_at.is_(None), AdReview.status == "pending")) or 0),
        "files_incomplete": incomplete,
    }


# ============================================================================ tours

TOUR_SPEC = {"agent_id": ("user", "agent_name"), "client_person_id": ("person", "person_label"),
             "client_organization_id": ("organization", "organization_label")}


async def tour_outs(db: DB, rows: list[Tour]) -> list[TourOut]:
    if not rows:
        return []
    ids = [r.id for r in rows]
    stops = dict((await db.execute(select(TourStop.tour_id, func.count()).where(
        TourStop.tour_id.in_(ids), TourStop.deleted_at.is_(None)).group_by(TourStop.tour_id))).all())
    fbs = dict((await db.execute(select(TourFeedback.tour_id, func.count()).where(
        TourFeedback.tour_id.in_(ids), TourFeedback.deleted_at.is_(None)).group_by(TourFeedback.tour_id))).all())
    outs = []
    for r in rows:
        o = TourOut.model_validate(r)
        o.stop_count, o.feedback_count = int(stops.get(r.id, 0)), int(fbs.get(r.id, 0))
        outs.append(o)
    return await service.enrich(db, outs, TOUR_SPEC)


def tour_query(user: CurrentUser, q: str | None, status: list[str] | None, agent_id: list[uuid.UUID] | None,
               mine: bool | None, from_date: date | None, to_date: date | None,
               brokerage_deal_id: uuid.UUID | None, skip: set[str] = frozenset()):
    stmt = select(Tour).where(Tour.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [Tour.title, Tour.notes, Tour.start_label])
    if "status" not in skip:
        stmt = in_filter(stmt, Tour.status, status)
    if "agent_id" not in skip:
        stmt = in_filter(stmt, Tour.agent_id, agent_id)
    if mine:
        stmt = stmt.where(Tour.agent_id == user.id)
    if from_date:
        stmt = stmt.where(Tour.scheduled_on >= from_date)
    if to_date:
        stmt = stmt.where(Tour.scheduled_on <= to_date)
    if brokerage_deal_id:
        stmt = stmt.where(Tour.brokerage_deal_id == brokerage_deal_id)
    return stmt


class TourFilters(BaseModel):
    q: str | None = None
    status: list[str] | None = None
    agent_id: list[uuid.UUID] | None = None
    mine: bool | None = None
    from_date: date | None = None
    to_date: date | None = None
    brokerage_deal_id: uuid.UUID | None = None


def tour_filters(
    q: str | None = Query(None, max_length=200), status: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None), mine: bool | None = None, from_date: date | None = None,
    to_date: date | None = None, brokerage_deal_id: uuid.UUID | None = None,
) -> TourFilters:
    return TourFilters(q=q, status=status, agent_id=agent_id, mine=mine, from_date=from_date, to_date=to_date,
                       brokerage_deal_id=brokerage_deal_id)


@router.get("/tours", response_model=Page[TourOut])
async def list_tours(db: DB, params: ListParams = Depends(), f: TourFilters = Depends(tour_filters),
                     user: CurrentUser = VIEW):
    stmt = tour_query(user, **f.model_dump())
    stmt = apply_sort(stmt, params.sort, {"scheduled_on": Tour.scheduled_on, "title": Tour.title,
                                          "status": Tour.status, "total_distance_miles": Tour.total_distance_miles,
                                          "updated_at": Tour.updated_at}, Tour.scheduled_on.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(TourOut, await tour_outs(db, rows), total, params)


@router.get("/tours/facets")
async def tour_facets(db: DB, f: TourFilters = Depends(tour_filters), user: CurrentUser = VIEW):
    return {
        "status": await facet_counts(db, tour_query(user, **f.model_dump(), skip={"status"}), Tour.status),
        "agent_id": await facet_counts(db, tour_query(user, **f.model_dump(), skip={"agent_id"}), Tour.agent_id),
    }


@router.post("/tours", response_model=TourOut, status_code=201)
async def create_tour(body: TourCreate, db: DB, user: CurrentUser = CREATE):
    return (await tour_outs(db, [await service.create_tour(db, body, user)]))[0]


@router.get("/tours/{tour_id}", response_model=TourOut)
async def get_tour(tour_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    return (await tour_outs(db, [await service.get_or_404(db, Tour, tour_id, "Tour")]))[0]


@router.patch("/tours/{tour_id}", response_model=TourOut)
async def update_tour(tour_id: uuid.UUID, body: TourUpdate, db: DB, user: CurrentUser = EDIT):
    tour = await service.update_tour(db, await service.get_or_404(db, Tour, tour_id, "Tour"), body, user)
    return (await tour_outs(db, [tour]))[0]


@router.delete("/tours/{tour_id}", status_code=204)
async def archive_tour(tour_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, Tour, tour_id, "Tour"), "tour", user)


@router.get("/tours/{tour_id}/stops", response_model=list[StopOut])
async def list_stops(tour_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    await service.get_or_404(db, Tour, tour_id, "Tour")
    return await service.stop_outs(db, tour_id)


@router.post("/tours/{tour_id}/stops", response_model=list[StopOut], status_code=201)
async def add_stop(tour_id: uuid.UUID, body: StopIn, db: DB, user: CurrentUser = EDIT):
    tour = await service.get_or_404(db, Tour, tour_id, "Tour")
    await service.add_stop(db, tour, body, user)
    return await service.stop_outs(db, tour_id)


@router.post("/tours/{tour_id}/optimize", response_model=OptimizeOut)
async def optimize(tour_id: uuid.UUID, db: DB, user: CurrentUser = EDIT):
    tour = await service.get_or_404(db, Tour, tour_id, "Tour")
    unlocated = await service.optimize_route(db, tour, user)
    await db.commit()
    return OptimizeOut(total_distance_miles=tour.total_distance_miles or 0, unlocated=unlocated,
                       stops=await service.stop_outs(db, tour_id))


@router.patch("/tour-stops/{stop_id}", response_model=list[StopOut])
async def update_stop(stop_id: uuid.UUID, body: StopUpdate, db: DB, user: CurrentUser = EDIT):
    stop = await service.update_stop(db, await service.get_or_404(db, TourStop, stop_id, "Stop"), body, user)
    return await service.stop_outs(db, stop.tour_id)


@router.delete("/tour-stops/{stop_id}", status_code=204)
async def remove_stop(stop_id: uuid.UUID, db: DB, user: CurrentUser = EDIT):
    await service.remove_stop(db, await service.get_or_404(db, TourStop, stop_id, "Stop"), user)


FEEDBACK_SPEC = {"property_id": ("property", "property_label"), "person_id": ("person", "person_label")}


@router.get("/tours/{tour_id}/feedback", response_model=list[FeedbackOut])
async def list_feedback(tour_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    rows = list(await db.scalars(select(TourFeedback).where(TourFeedback.tour_id == tour_id,
                                                            TourFeedback.deleted_at.is_(None))
                                 .order_by(TourFeedback.created_at.desc())))
    return await service.enrich(db, [FeedbackOut.model_validate(r) for r in rows], FEEDBACK_SPEC)


@router.post("/tours/{tour_id}/feedback", response_model=FeedbackOut, status_code=201)
async def add_feedback(tour_id: uuid.UUID, body: FeedbackIn, db: DB, user: CurrentUser = EDIT):
    tour = await service.get_or_404(db, Tour, tour_id, "Tour")
    fb = await service.add_feedback(db, tour, body, user)
    return (await service.enrich(db, [FeedbackOut.model_validate(fb)], FEEDBACK_SPEC))[0]


# ============================================================================ NDAs


@router.get("/ndas", response_model=Page[NdaOut])
async def list_ndas(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None), person_id: uuid.UUID | None = None,
    organization_id: uuid.UUID | None = None, deal_room_id: uuid.UUID | None = None,
    listing_id: uuid.UUID | None = None, user: CurrentUser = VIEW,
):
    stmt = select(Nda).where(Nda.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [Nda.signer_name, Nda.signer_email, Nda.notes])
    stmt = in_filter(stmt, Nda.status, status)
    for col, v in ((Nda.person_id, person_id), (Nda.organization_id, organization_id),
                   (Nda.deal_room_id, deal_room_id), (Nda.listing_id, listing_id)):
        if v:
            stmt = stmt.where(col == v)
    stmt = record_scope(stmt, Nda, user)
    stmt = apply_sort(stmt, params.sort, {"status": Nda.status, "signed_at": Nda.signed_at,
                                          "expires_on": Nda.expires_on, "updated_at": Nda.updated_at},
                      Nda.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(NdaOut, await service.nda_outs(db, rows), total, params)


@router.post("/ndas", response_model=NdaOut, status_code=201)
async def create_nda(body: NdaBase, db: DB, user: CurrentUser = CREATE):
    return (await service.nda_outs(db, [await service.save_nda(db, body, user)]))[0]


@router.patch("/ndas/{nda_id}", response_model=NdaOut)
async def update_nda(nda_id: uuid.UUID, body: NdaUpdate, db: DB, user: CurrentUser = EDIT):
    n = await service.get_or_404(db, Nda, nda_id, "NDA")
    return (await service.nda_outs(db, [await service.save_nda(db, body, user, n)]))[0]


@router.delete("/ndas/{nda_id}", status_code=204)
async def archive_nda(nda_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, Nda, nda_id, "NDA"), "nda", user)


# ============================================================================ deal rooms (internal)


@router.get("/deal-rooms", response_model=Page[RoomOut])
async def list_rooms(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
    listing_id: uuid.UUID | None = None, brokerage_deal_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None, user: CurrentUser = VIEW,
):
    stmt = select(DealRoom).where(DealRoom.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [DealRoom.name, DealRoom.description])
    stmt = in_filter(stmt, DealRoom.status, status)
    for col, v in ((DealRoom.listing_id, listing_id), (DealRoom.brokerage_deal_id, brokerage_deal_id),
                   (DealRoom.property_id, property_id)):
        if v:
            stmt = stmt.where(col == v)
    stmt = record_scope(stmt, DealRoom, user)
    stmt = apply_sort(stmt, params.sort, {"name": DealRoom.name, "status": DealRoom.status,
                                          "updated_at": DealRoom.updated_at}, DealRoom.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(RoomOut, await service.room_outs(db, rows), total, params)


@router.post("/deal-rooms", response_model=RoomOut, status_code=201)
async def create_room(body: RoomCreate, db: DB, user: CurrentUser = CREATE):
    return (await service.room_outs(db, [await service.create_room(db, body, user)]))[0]


@router.get("/deal-rooms/{room_id}", response_model=RoomOut)
async def get_room(room_id: uuid.UUID, db: DB, user: CurrentUser = VIEW):
    return (await service.room_outs(db, [await service.internal_room(db, room_id, user)]))[0]


@router.patch("/deal-rooms/{room_id}", response_model=RoomOut)
async def update_room(room_id: uuid.UUID, body: RoomUpdate, db: DB, user: CurrentUser = EDIT):
    room = await service.update_room(db, await service.internal_room(db, room_id, user), body, user)
    return (await service.room_outs(db, [room]))[0]


@router.get("/deal-rooms/{room_id}/folders", response_model=list[FolderOut])
async def list_folders(room_id: uuid.UUID, db: DB, user: CurrentUser = VIEW):
    return await service.folder_outs(db, await service.internal_room(db, room_id, user))


@router.post("/deal-rooms/{room_id}/folders", response_model=FolderOut, status_code=201)
async def create_folder(room_id: uuid.UUID, body: FolderIn, db: DB, user: CurrentUser = EDIT):
    room = await service.internal_room(db, room_id, user)
    folder = await service.save_folder(db, room, body, user)
    return next(f for f in await service.folder_outs(db, room) if f.id == folder.id)


@router.patch("/deal-room-folders/{folder_id}", response_model=FolderOut)
async def update_folder(folder_id: uuid.UUID, body: FolderUpdate, db: DB, user: CurrentUser = EDIT):
    folder = await service.get_or_404(db, DealRoomFolder, folder_id, "Folder")
    room = await service.internal_room(db, folder.room_id, user)
    await service.save_folder(db, room, body, user, folder)
    return next(f for f in await service.folder_outs(db, room) if f.id == folder.id)


@router.delete("/deal-room-folders/{folder_id}", status_code=204)
async def archive_folder(folder_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    folder = await service.get_or_404(db, DealRoomFolder, folder_id, "Folder")
    await service.internal_room(db, folder.room_id, user)
    await service.archive_row(db, folder, "deal_room_folder", user)


@router.get("/deal-rooms/{room_id}/access", response_model=list[AccessOut])
async def list_access(room_id: uuid.UUID, db: DB, user: CurrentUser = VIEW):
    room = await service.internal_room(db, room_id, user)
    rows = list(await db.scalars(select(DealRoomAccess).where(DealRoomAccess.room_id == room.id,
                                                              DealRoomAccess.deleted_at.is_(None))
                                 .order_by(DealRoomAccess.created_at.desc())))
    return await service.access_outs(db, room, rows)


@router.post("/deal-rooms/{room_id}/access", response_model=AccessOut, status_code=201)
async def grant_access(room_id: uuid.UUID, body: AccessIn, db: DB, user: CurrentUser = EDIT):
    room = await service.internal_room(db, room_id, user)
    g = await service.grant_access(db, room, body, user)
    return (await service.access_outs(db, room, [g]))[0]


@router.patch("/deal-room-access/{access_id}", response_model=AccessOut)
async def update_access(access_id: uuid.UUID, body: AccessUpdate, db: DB, user: CurrentUser = EDIT):
    g = await service.get_or_404(db, DealRoomAccess, access_id, "Access grant")
    room = await service.internal_room(db, g.room_id, user)
    values = body.model_dump(exclude_unset=True)
    for k in ("can_download", "can_submit_offers"):
        if k in values and values[k] is None:
            values.pop(k)
    if "folder_ids" in values:
        values["folder_ids"] = values["folder_ids"] or []
    await service.patch_row(db, g, "deal_room_access", values, user)
    await db.commit()
    return (await service.access_outs(db, room, [g]))[0]


@router.post("/deal-room-access/{access_id}/revoke", response_model=AccessOut)
async def revoke_access(access_id: uuid.UUID, db: DB, user: CurrentUser = EDIT):
    g = await service.get_or_404(db, DealRoomAccess, access_id, "Access grant")
    room = await service.internal_room(db, g.room_id, user)
    return (await service.access_outs(db, room, [await service.revoke_access(db, g, user)]))[0]


@router.get("/deal-rooms/{room_id}/analytics", response_model=AnalyticsOut)
async def room_analytics(room_id: uuid.UUID, db: DB, user: CurrentUser = VIEW):
    return await service.analytics(db, await service.internal_room(db, room_id, user))


@router.post("/deal-rooms/{room_id}/documents/{document_id}/open", response_model=OpenOut)
async def open_document(room_id: uuid.UUID, document_id: uuid.UUID, db: DB,
                        action: str = Query("view", pattern="^(view|download)$"), user: CurrentUser = VIEW):
    room = await service.internal_room(db, room_id, user)
    url = await service.open_document(db, room, document_id, action, user, None)
    return OpenOut(document_id=document_id, url=url, action=action)


@router.post("/deal-rooms/{room_id}/offers", response_model=OfferOut, status_code=201)
async def submit_offer_internal(room_id: uuid.UUID, body: OfferIn, db: DB, user: CurrentUser = CREATE):
    """Internal users record an offer received outside the portal on behalf of the counterparty."""
    room = await service.internal_room(db, room_id, user)
    return (await offer_outs(db, [await service.submit_offer(db, room, body, user, None)]))[0]


# ============================================================================ counterparty portal (grant-based)


@router.get("/deal-room-portal", response_model=list[RoomOut])
async def portal_rooms(db: DB, user: Authed):
    grants = list(await db.scalars(select(DealRoomAccess).where(
        DealRoomAccess.user_id == user.id, DealRoomAccess.deleted_at.is_(None), DealRoomAccess.status == "active")))
    rooms = []
    for g in grants:
        room = await db.get(DealRoom, g.room_id)
        if room and not room.deleted_at and not await service._grant_problem(db, room, g):
            rooms.append(room)
    return await service.room_outs(db, list({r.id: r for r in rooms}.values()))


@router.get("/deal-room-portal/{room_id}", response_model=PortalRoomOut)
async def portal_room(room_id: uuid.UUID, db: DB, user: Authed):
    room = await service.get_or_404(db, DealRoom, room_id, "Deal room")
    grant = await service.portal_grant(db, room, user)
    await service.log_access(db, room, grant, user, "view_room", is_internal=False)
    folders = await service.folder_outs(db, room, grant)
    await db.commit()
    room_out = (await service.room_outs(db, [room]))[0]
    return PortalRoomOut(room=room_out, access_id=grant.id, can_download=grant.can_download,
                         can_submit_offers=grant.can_submit_offers and room.allow_offers, folders=folders)


@router.post("/deal-room-portal/{room_id}/documents/{document_id}/open", response_model=OpenOut)
async def portal_open(room_id: uuid.UUID, document_id: uuid.UUID, db: DB, user: Authed,
                      action: str = Query("view", pattern="^(view|download)$")):
    room = await service.get_or_404(db, DealRoom, room_id, "Deal room")
    grant = await service.portal_grant(db, room, user)
    url = await service.open_document(db, room, document_id, action, user, grant)
    return OpenOut(document_id=document_id, url=url, action=action)


@router.post("/deal-room-portal/{room_id}/offers", response_model=OfferOut, status_code=201)
async def portal_offer(room_id: uuid.UUID, body: OfferIn, db: DB, user: Authed):
    room = await service.get_or_404(db, DealRoom, room_id, "Deal room")
    grant = await service.portal_grant(db, room, user)
    offer = await service.submit_offer(db, room, body, user, grant)
    return OfferOut.model_validate(offer)


# ============================================================================ offers (review)

OFFER_SPEC = {"property_id": ("property", "property_label"), "submitter_person_id": ("person", "person_label"),
              "submitter_organization_id": ("organization", "organization_label"),
              "reviewed_by_id": ("user", "reviewer_name")}


async def offer_outs(db: DB, rows: list[OfferSubmission]) -> list[OfferOut]:
    return await service.enrich(db, [OfferOut.model_validate(r) for r in rows], OFFER_SPEC)


@router.get("/offer-submissions", response_model=Page[OfferOut])
async def list_offers(
    db: DB, params: ListParams = Depends(), room_id: uuid.UUID | None = None, listing_id: uuid.UUID | None = None,
    brokerage_deal_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
    status: list[str] | None = Query(None), user: CurrentUser = VIEW,
):
    stmt = select(OfferSubmission).where(OfferSubmission.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [OfferSubmission.submitter_name, OfferSubmission.buyer_entity,
                                         OfferSubmission.terms])
    for col, v in ((OfferSubmission.room_id, room_id), (OfferSubmission.listing_id, listing_id),
                   (OfferSubmission.brokerage_deal_id, brokerage_deal_id), (OfferSubmission.property_id, property_id)):
        if v:
            stmt = stmt.where(col == v)
    stmt = record_scope(in_filter(stmt, OfferSubmission.status, status), OfferSubmission, user)
    stmt = apply_sort(stmt, params.sort, {"price": OfferSubmission.price, "submitted_at": OfferSubmission.submitted_at,
                                          "status": OfferSubmission.status}, OfferSubmission.submitted_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(OfferOut, await offer_outs(db, rows), total, params)


@router.post("/offer-submissions/{offer_id}/review", response_model=OfferOut)
async def review_offer(offer_id: uuid.UUID, body: OfferReviewIn, db: DB, user: CurrentUser = EDIT):
    offer = await service.get_or_404(db, OfferSubmission, offer_id, "Offer")
    if offer.room_id:
        await service.internal_room(db, offer.room_id, user)
    offer = await service.review_offer(db, offer, body.status, body.review_notes, user)
    return (await offer_outs(db, [offer]))[0]


# ============================================================================ licenses


@router.get("/agent-licenses", response_model=Page[LicenseOut])
async def list_licenses(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
    state: list[str] | None = Query(None), user_id: uuid.UUID | None = None,
    expiring_within_days: int | None = Query(None, ge=0, le=3650), _: CurrentUser = VIEW,
):
    stmt = select(AgentLicense).where(AgentLicense.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [AgentLicense.holder_name, AgentLicense.license_number,
                                         AgentLicense.sponsoring_broker])
    stmt = in_filter(in_filter(stmt, AgentLicense.status, status), AgentLicense.state, state)
    if user_id:
        stmt = stmt.where(AgentLicense.user_id == user_id)
    if expiring_within_days is not None:
        stmt = stmt.where(AgentLicense.expires_on <= service.today() + timedelta(days=expiring_within_days))
    stmt = apply_sort(stmt, params.sort, {"expires_on": AgentLicense.expires_on, "holder_name": AgentLicense.holder_name,
                                          "state": AgentLicense.state, "status": AgentLicense.status},
                      AgentLicense.expires_on.asc().nulls_last())
    rows, total = await paginate(db, stmt, params)
    return page_of(LicenseOut, await service.license_outs(db, rows), total, params)


@router.post("/agent-licenses/scan", response_model=ScanOut)
async def scan(db: DB, user: CurrentUser = EDIT):
    """Expiration alerts for licenses and disclosure deadlines. Idempotent; safe to schedule."""
    return ScanOut(**await service.scan_compliance(db, user))


@router.post("/agent-licenses", response_model=LicenseOut, status_code=201)
async def create_license(body: LicenseBase, db: DB, user: CurrentUser = CREATE):
    return (await service.license_outs(db, [await service.save_license(db, body, user)]))[0]


@router.patch("/agent-licenses/{license_id}", response_model=LicenseOut)
async def update_license(license_id: uuid.UUID, body: LicenseUpdate, db: DB, user: CurrentUser = EDIT):
    lic = await service.get_or_404(db, AgentLicense, license_id, "License")
    return (await service.license_outs(db, [await service.save_license(db, body, user, lic)]))[0]


@router.delete("/agent-licenses/{license_id}", status_code=204)
async def archive_license(license_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, AgentLicense, license_id, "License"),
                              "agent_license", user)


# ============================================================================ disclosures

DISCLOSURE_SPEC = {"property_id": ("property", "property_label"), "owner_id": ("user", "agent_name"),
                   "recipient_person_id": ("person", "person_label"),
                   "recipient_organization_id": ("organization", "organization_label")}


async def disclosure_outs(db: DB, rows: list[Disclosure]) -> list[DisclosureOut]:
    outs = []
    for r in rows:
        o = DisclosureOut.model_validate(r)
        o.is_satisfied = service.disclosure_satisfied(r)
        o.is_overdue = bool(r.due_on and r.due_on < service.today() and not o.is_satisfied)
        outs.append(o)
    return await service.enrich(db, outs, DISCLOSURE_SPEC)


@router.get("/disclosures", response_model=Page[DisclosureOut])
async def list_disclosures(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
    disclosure_type: list[str] | None = Query(None), brokerage_deal_id: uuid.UUID | None = None,
    listing_id: uuid.UUID | None = None, overdue: bool | None = None, user: CurrentUser = VIEW,
):
    stmt = select(Disclosure).where(Disclosure.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [Disclosure.title, Disclosure.recipient_name])
    stmt = in_filter(in_filter(stmt, Disclosure.status, status), Disclosure.disclosure_type, disclosure_type)
    if brokerage_deal_id:
        stmt = stmt.where(Disclosure.brokerage_deal_id == brokerage_deal_id)
    if listing_id:
        stmt = stmt.where(Disclosure.listing_id == listing_id)
    if overdue:
        stmt = stmt.where(Disclosure.due_on < service.today(), Disclosure.status.notin_(["waived", "acknowledged"]))
    stmt = record_scope(stmt, Disclosure, user)
    stmt = apply_sort(stmt, params.sort, {"due_on": Disclosure.due_on, "status": Disclosure.status,
                                          "title": Disclosure.title}, Disclosure.due_on.asc().nulls_last())
    rows, total = await paginate(db, stmt, params)
    return page_of(DisclosureOut, await disclosure_outs(db, rows), total, params)


@router.post("/disclosures", response_model=DisclosureOut, status_code=201)
async def create_disclosure(body: DisclosureBase, db: DB, user: CurrentUser = CREATE):
    return (await disclosure_outs(db, [await service.create_disclosure(db, body, user)]))[0]


@router.patch("/disclosures/{disclosure_id}", response_model=DisclosureOut)
async def update_disclosure(disclosure_id: uuid.UUID, body: DisclosureUpdate, db: DB, user: CurrentUser = EDIT):
    d = await service.get_or_404(db, Disclosure, disclosure_id, "Disclosure")
    return (await disclosure_outs(db, [await service.update_disclosure(db, d, body, user)]))[0]


@router.post("/disclosures/{disclosure_id}/deliver", response_model=DisclosureOut)
async def deliver_disclosure(disclosure_id: uuid.UUID, body: DeliverIn, db: DB, user: CurrentUser = EDIT):
    d = await service.get_or_404(db, Disclosure, disclosure_id, "Disclosure")
    return (await disclosure_outs(db, [await service.deliver_disclosure(db, d, body, user)]))[0]


@router.post("/disclosures/{disclosure_id}/acknowledge", response_model=DisclosureOut)
async def acknowledge_disclosure(disclosure_id: uuid.UUID, body: AcknowledgeIn, db: DB, user: CurrentUser = EDIT):
    d = await service.get_or_404(db, Disclosure, disclosure_id, "Disclosure")
    return (await disclosure_outs(db, [await service.acknowledge_disclosure(db, d, body, user)]))[0]


@router.post("/disclosures/{disclosure_id}/waive", response_model=DisclosureOut)
async def waive_disclosure(disclosure_id: uuid.UUID, body: WaiveIn, db: DB, user: CurrentUser = APPROVE):
    d = await service.get_or_404(db, Disclosure, disclosure_id, "Disclosure")
    return (await disclosure_outs(db, [await service.waive_disclosure(db, d, body.reason, user)]))[0]


@router.delete("/disclosures/{disclosure_id}", status_code=204)
async def archive_disclosure(disclosure_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    d = await service.get_or_404(db, Disclosure, disclosure_id, "Disclosure")
    if d.status in ("delivered", "acknowledged"):
        raise HTTPException(409, "Delivered disclosures are retained as compliance evidence")
    await service.archive_row(db, d, "disclosure", user)


# ============================================================================ advertising review


async def ad_outs(db: DB, rows: list[AdReview]) -> list[AdReviewOut]:
    users = await service.names(db, "user", {r.submitted_by_id for r in rows} | {r.reviewer_id for r in rows})
    outs = []
    for r in rows:
        o = AdReviewOut.model_validate(r)
        o.submitted_by_name = users.get(r.submitted_by_id) if r.submitted_by_id else None
        o.reviewer_name = users.get(r.reviewer_id) if r.reviewer_id else None
        outs.append(o)
    return outs


@router.get("/ad-reviews", response_model=Page[AdReviewOut])
async def list_ad_reviews(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
    listing_id: uuid.UUID | None = None, marketing_item_id: uuid.UUID | None = None, user: CurrentUser = VIEW,
):
    stmt = select(AdReview).where(AdReview.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [AdReview.title, AdReview.channel, AdReview.content_summary])
    stmt = in_filter(stmt, AdReview.status, status)
    if listing_id:
        stmt = stmt.where(AdReview.listing_id == listing_id)
    if marketing_item_id:
        stmt = stmt.where(AdReview.marketing_item_id == marketing_item_id)
    stmt = record_scope(stmt, AdReview, user)
    stmt = apply_sort(stmt, params.sort, {"submitted_at": AdReview.submitted_at, "status": AdReview.status,
                                          "title": AdReview.title}, AdReview.submitted_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(AdReviewOut, await ad_outs(db, rows), total, params)


@router.post("/ad-reviews", response_model=AdReviewOut, status_code=201)
async def submit_ad_review(body: AdReviewBase, db: DB, user: CurrentUser = CREATE):
    return (await ad_outs(db, [await service.submit_ad_review(db, body, user)]))[0]


@router.post("/ad-reviews/{review_id}/decision", response_model=AdReviewOut)
async def decide_ad_review(review_id: uuid.UUID, body: AdDecisionIn, db: DB, user: CurrentUser = APPROVE):
    r = await service.get_or_404(db, AdReview, review_id, "Advertising review")
    return (await ad_outs(db, [await service.decide_ad_review(db, r, body, user)]))[0]


# ============================================================================ transaction files


class FileStartIn(BaseModel):
    brokerage_deal_id: uuid.UUID


@router.get("/transaction-files", response_model=Page[FileOut])
async def list_files(db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None),
                     mine: bool | None = None, user: CurrentUser = VIEW):
    from app.modules.brokerage.models import BrokerageDeal

    if not user.can("brokerage", "view"):
        raise HTTPException(403, "Brokerage access is required to view transaction files")
    stmt = (select(TransactionFile).join(BrokerageDeal, BrokerageDeal.id == TransactionFile.brokerage_deal_id)
            .where(TransactionFile.deleted_at.is_(None), BrokerageDeal.deleted_at.is_(None)))
    stmt = apply_search(stmt, params.q, [BrokerageDeal.title])
    stmt = in_filter(stmt, TransactionFile.status, status)
    if mine:
        stmt = stmt.where(BrokerageDeal.agent_id == user.id)
    stmt = apply_sort(stmt, params.sort, {"status": TransactionFile.status, "updated_at": TransactionFile.updated_at,
                                          "deal": BrokerageDeal.title}, TransactionFile.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(FileOut, [await service.file_out(db, f, with_items=False) for f in rows], total, params)


@router.post("/transaction-files", response_model=FileOut, status_code=201)
async def start_file(body: FileStartIn, db: DB, user: CurrentUser = CREATE):
    from app.modules.brokerage.models import BrokerageDeal

    if not user.can("brokerage", "view"):
        raise HTTPException(403, "Brokerage access is required")
    deal = await service.get_or_404(db, BrokerageDeal, body.brokerage_deal_id, "Deal")
    f = await service.ensure_transaction_file(db, deal, user)
    await db.commit()
    return await service.file_out(db, f)


@router.get("/transaction-files/check/{brokerage_deal_id}", response_model=CompletenessOut)
async def check_file(brokerage_deal_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    ok, blockers = await service.transaction_file_complete(db, brokerage_deal_id)
    return CompletenessOut(brokerage_deal_id=brokerage_deal_id, complete=ok, blockers=blockers)


@router.get("/transaction-files/by-deal/{brokerage_deal_id}", response_model=FileOut)
async def file_by_deal(brokerage_deal_id: uuid.UUID, db: DB, user: CurrentUser = VIEW):
    if not user.can("brokerage", "view"):
        raise HTTPException(403, "Brokerage access is required")
    f = await db.scalar(select(TransactionFile).where(TransactionFile.brokerage_deal_id == brokerage_deal_id,
                                                      TransactionFile.deleted_at.is_(None)))
    if not f:
        raise HTTPException(404, "No transaction file for this deal yet")
    return await service.file_out(db, f)


@router.get("/transaction-files/{file_id}", response_model=FileOut)
async def get_file(file_id: uuid.UUID, db: DB, user: CurrentUser = VIEW):
    if not user.can("brokerage", "view"):
        raise HTTPException(403, "Brokerage access is required")
    return await service.file_out(db, await service.get_or_404(db, TransactionFile, file_id, "Transaction file"))


@router.post("/transaction-files/{file_id}/items", response_model=FileOut, status_code=201)
async def add_file_item(file_id: uuid.UUID, body: FileItemIn, db: DB, user: CurrentUser = EDIT):
    f = await service.get_or_404(db, TransactionFile, file_id, "Transaction file")
    n = await db.scalar(select(func.count()).select_from(TransactionFileItem).where(TransactionFileItem.file_id == f.id))
    key = "custom_" + uuid.uuid4().hex[:8]
    await service.create_row(db, TransactionFileItem, "transaction_file_item", {
        **body.model_dump(), "file_id": f.id, "key": key, "sort_order": (int(n or 0) + 1) * 10, "status": "missing",
    }, user, summary=body.label)
    if f.status == "complete" and body.is_required:
        f.status = "open"
    await db.commit()
    return await service.file_out(db, f)


@router.patch("/transaction-file-items/{item_id}", response_model=FileItemOut)
async def update_file_item(item_id: uuid.UUID, body: FileItemUpdate, db: DB, user: CurrentUser = EDIT):
    item = await service.get_or_404(db, TransactionFileItem, item_id, "Checklist item")
    item = await service.update_file_item(db, item, body, user)
    f = await db.get(TransactionFile, item.file_id)
    out = await service.file_out(db, f)
    return next(i for i in out.items if i.id == item.id)


@router.post("/transaction-files/{file_id}/approve", response_model=FileOut)
async def approve_file(file_id: uuid.UUID, db: DB, user: CurrentUser = APPROVE):
    f = await service.get_or_404(db, TransactionFile, file_id, "Transaction file")
    return await service.file_out(db, await service.approve_file(db, f, user))
