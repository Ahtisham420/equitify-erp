import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.offers import service
from app.modules.offers.models import ORIGINS, OFFER_STATUSES, OUTCOMES, STRUCTURES, TERM_FIELDS, Offer, OfferApproval
from app.modules.offers.schemas import (
    ApprovalIn,
    ApprovalOut,
    ApprovedModelOut,
    CounterIn,
    DeltaOut,
    ExpireScanOut,
    OfferCreate,
    OfferFacets,
    OfferListItem,
    OfferOut,
    OfferSettingsIn,
    OfferSettingsOut,
    OfferTerms,
    RespondIn,
    SendIn,
    WinningPriceIn,
)
from app.modules.offers.service import OfferFilters

router = APIRouter(prefix="/offers", tags=["offers"])

SORTS = {
    "price": Offer.price, "status": Offer.status, "version": Offer.version, "sent_at": Offer.sent_at,
    "response_due_at": Offer.response_due_at, "deviation_pct": Offer.deviation_pct,
    "created_at": Offer.created_at, "updated_at": Offer.updated_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    origin: list[str] | None = Query(None),
    opportunity_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    uw_model_id: uuid.UUID | None = None,
    owner_id: list[uuid.UUID] | None = Query(None),
    root_offer_id: uuid.UUID | None = None,
    latest_only: bool = True,
    due: str | None = Query(None, pattern="^(overdue|24h|72h)$"),
    min_price: float | None = None,
    max_price: float | None = None,
) -> OfferFilters:
    return OfferFilters(**locals())


@router.get("", response_model=Page[OfferListItem])
async def list_offers(
    db: DB, params: ListParams = Depends(), f: OfferFilters = Depends(filters),
    user: CurrentUser = Depends(require("offers", "view")),
):
    await service.expire_due(db, actor=None)  # expired offers surface immediately, never silently linger
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Offer.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[OfferListItem](items=await service.to_items(db, items), total=total, page=params.page,
                               page_size=params.page_size)


@router.get("/facets", response_model=OfferFacets)
async def facets(db: DB, f: OfferFilters = Depends(filters), _: CurrentUser = Depends(require("offers", "view"))):
    return OfferFacets(
        status=await facet_counts(db, service.build_query(f, skip={"status"}), Offer.status),
        origin=await facet_counts(db, service.build_query(f, skip={"origin"}), Offer.origin),
        due=await service.due_counts(db, f),
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("offers", "view"))):
    return {"statuses": OFFER_STATUSES, "origins": ORIGINS, "structures": STRUCTURES, "outcomes": OUTCOMES,
            "terms": [{"key": k, "label": v} for k, v in TERM_FIELDS.items()]}


@router.get("/settings", response_model=OfferSettingsOut)
async def get_settings(db: DB, _: CurrentUser = Depends(require("offers", "view"))):
    return await service.get_settings(db)


@router.put("/settings", response_model=OfferSettingsOut)
async def put_settings(body: OfferSettingsIn, db: DB, user: CurrentUser = Depends(require("offers", "approve"))):
    return await service.save_settings(db, body, user)


@router.get("/approved-models", response_model=list[ApprovedModelOut])
async def approved_models(
    db: DB, opportunity_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
    _: CurrentUser = Depends(require("offers", "view")),
):
    if opportunity_id and not property_id:
        from app.modules.pipeline.models import Opportunity

        opp = await db.get(Opportunity, opportunity_id)
        property_id = opp.property_id if opp else None
    return await service.approved_models(db, opportunity_id=opportunity_id, property_id=property_id)


@router.post("/expire-scan", response_model=ExpireScanOut)
async def expire_scan(db: DB, user: CurrentUser = Depends(require("offers", "edit"))):
    """Periodic job (also run on read): expire offers whose response clock has run out."""
    ids = await service.expire_due(db, actor=user)
    return ExpireScanOut(expired=len(ids), offer_ids=ids)


@router.post("", response_model=OfferOut, status_code=201)
async def create_offer(body: OfferCreate, db: DB, user: CurrentUser = Depends(require("offers", "create"))):
    return await service.to_out(db, await service.create(db, body, user), user)


@router.get("/{offer_id}", response_model=OfferOut)
async def get_offer(offer_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("offers", "view"))):
    await service.expire_due(db, actor=None)
    o = await service.get(db, offer_id)
    await db.refresh(o)
    return await service.to_out(db, o, user)


@router.patch("/{offer_id}", response_model=OfferOut)
async def update_offer(offer_id: uuid.UUID, body: OfferTerms, db: DB,
                       user: CurrentUser = Depends(require("offers", "edit"))):
    o = await service.update(db, await service.get(db, offer_id), body, user)
    return await service.to_out(db, o, user)


@router.delete("/{offer_id}", status_code=204)
async def delete_offer(offer_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("offers", "delete"))):
    await service.withdraw_or_delete_draft(db, await service.get(db, offer_id), user)


@router.post("/{offer_id}/submit", response_model=OfferOut)
async def submit(offer_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("offers", "edit"))):
    o = await service.submit(db, await service.get(db, offer_id), user)
    return await service.to_out(db, o, user)


@router.post("/{offer_id}/approve", response_model=OfferOut)
async def approve(offer_id: uuid.UUID, body: ApprovalIn, db: DB,
                  user: CurrentUser = Depends(require("offers", "approve"))):
    o = await service.decide(db, await service.get(db, offer_id), body, user)
    return await service.to_out(db, o, user)


@router.get("/{offer_id}/approvals", response_model=list[ApprovalOut])
async def approvals(offer_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("offers", "view"))):
    await service.get(db, offer_id)
    return list(await db.scalars(select(OfferApproval).where(OfferApproval.offer_id == offer_id)
                                 .order_by(OfferApproval.decided_at.desc())))


@router.get("/{offer_id}/versions", response_model=list[OfferListItem])
async def versions(offer_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("offers", "view"))):
    o = await service.get(db, offer_id)
    return await service.to_items(db, await service.chain(db, o))


@router.get("/{offer_id}/delta", response_model=DeltaOut)
async def delta(offer_id: uuid.UUID, db: DB, against: uuid.UUID | None = None,
                _: CurrentUser = Depends(require("offers", "view"))):
    return await service.delta(db, await service.get(db, offer_id), against)


@router.post("/{offer_id}/counter", response_model=OfferOut, status_code=201)
async def counter(offer_id: uuid.UUID, body: CounterIn, db: DB,
                  user: CurrentUser = Depends(require("offers", "edit"))):
    o = await service.counter(db, await service.get(db, offer_id), body, user)
    return await service.to_out(db, o, user)


@router.get("/{offer_id}/loi")
async def loi(offer_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("offers", "view"))):
    return await service.loi(db, await service.get(db, offer_id))


@router.post("/{offer_id}/send", response_model=OfferOut)
async def send(offer_id: uuid.UUID, body: SendIn, db: DB, user: CurrentUser = Depends(require("offers", "edit"))):
    o = await service.send(db, await service.get(db, offer_id), body, user)
    return await service.to_out(db, o, user)


@router.post("/{offer_id}/respond", response_model=OfferOut)
async def respond(offer_id: uuid.UUID, body: RespondIn, db: DB,
                  user: CurrentUser = Depends(require("offers", "edit"))):
    o = await service.respond(db, await service.get(db, offer_id), body, user)
    return await service.to_out(db, o, user)


@router.post("/{offer_id}/winning-price", response_model=OfferOut)
async def winning_price(offer_id: uuid.UUID, body: WinningPriceIn, db: DB,
                        user: CurrentUser = Depends(require("offers", "edit"))):
    o = await service.record_winning_price(db, await service.get(db, offer_id), body, user)
    return await service.to_out(db, o, user)
