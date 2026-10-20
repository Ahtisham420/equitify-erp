import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.modules.dispositions import service
from app.modules.dispositions.models import (
    CANDIDATE_STATUSES,
    EXCHANGE_STATUSES,
    EXCHANGE_TYPES,
    FINANCING_TYPES,
    IDENTIFICATION_RULES,
    OFFER_STATUSES,
    PROGRESSION,
    RETRADE_DECISIONS,
    RETRADE_OUTCOMES,
    RETRADE_REASONS,
    STAGES,
    Disposition,
    DispositionEvent,
    DispositionOffer,
    ExchangeCandidate,
    Exchange1031,
    Retrade,
)
from app.modules.dispositions.schemas import (
    CandidateIn,
    CompareIn,
    DispositionCreate,
    DispositionFacets,
    DispositionListItem,
    DispositionOut,
    DispositionUpdate,
    EventOut,
    ExchangeIn,
    GatesOut,
    MoveIn,
    OfferIn,
    OfferOut,
    RetradeDecisionIn,
    RetradeIn,
    RetradeOut,
    StageGate,
)
from app.modules.dispositions.service import DispositionFilters
from app.modules.properties.models import Property

router = APIRouter(prefix="/dispositions", tags=["dispositions"])

SORTS = {
    "name": Disposition.name, "stage": Disposition.stage, "stage_entered_at": Disposition.stage_entered_at,
    "target_price": Disposition.target_price, "contract_price": Disposition.contract_price,
    "target_closing_on": Disposition.target_closing_on, "property": Property.name, "updated_at": Disposition.updated_at,
}


def filters(
    q: str | None = Query(None, max_length=200),
    stage: list[str] | None = Query(None),
    owner_id: list[uuid.UUID] | None = Query(None),
    is_1031: list[str] | None = Query(None),
    asset_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None,
    active_only: bool | None = None,
) -> DispositionFilters:
    return DispositionFilters(**locals())


@router.get("", response_model=Page[DispositionListItem])
async def list_dispositions(db: DB, params: ListParams = Depends(), f: DispositionFilters = Depends(filters),
                            _: CurrentUser = Depends(require("dispositions", "view"))):
    stmt = apply_sort(service.build_query(f), params.sort, SORTS, Disposition.updated_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[DispositionListItem](items=await service.to_items(db, items), total=total, page=params.page,
                                     page_size=params.page_size)


@router.get("/facets", response_model=DispositionFacets)
async def facets(db: DB, f: DispositionFilters = Depends(filters), _: CurrentUser = Depends(require("dispositions", "view"))):
    q = service.build_query
    flags = await facet_counts(db, q(f, skip={"is_1031"}), Disposition.is_1031)
    return DispositionFacets(
        stage=await facet_counts(db, q(f, skip={"stage"}), Disposition.stage),
        owner_id=await facet_counts(db, q(f, skip={"owner_id"}), Disposition.owner_id),
        is_1031={k.lower(): v for k, v in flags.items()},
    )


@router.get("/meta")
async def meta(_: CurrentUser = Depends(require("dispositions", "view"))):
    return {"stages": STAGES, "progression": PROGRESSION, "offer_statuses": OFFER_STATUSES,
            "financing_types": FINANCING_TYPES, "retrade_reasons": RETRADE_REASONS,
            "retrade_decisions": RETRADE_DECISIONS, "retrade_outcomes": RETRADE_OUTCOMES,
            "exchange_types": EXCHANGE_TYPES, "exchange_statuses": EXCHANGE_STATUSES,
            "identification_rules": IDENTIFICATION_RULES, "candidate_statuses": CANDIDATE_STATUSES,
            "tax_note": service.TAX_NOTE}


@router.get("/queue")
async def candidate_queue(db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    return await service.queue(db)


@router.get("/buyers")
async def buyers(db: DB, q: str | None = None, _: CurrentUser = Depends(require("dispositions", "view"))):
    return await service.buyer_performance(db, q)


@router.get("/retrades", response_model=list[RetradeOut])
async def all_retrades(db: DB, buyer: str | None = None, buyer_organization_id: uuid.UUID | None = None,
                       _: CurrentUser = Depends(require("dispositions", "view"))):
    stmt = select(Retrade).where(Retrade.deleted_at.is_(None))
    if buyer:
        stmt = stmt.where(Retrade.buyer_name.ilike(f"%{buyer}%"))
    if buyer_organization_id:
        stmt = stmt.where(Retrade.buyer_organization_id == buyer_organization_id)
    return await service.retrade_items(db, list(await db.scalars(stmt.order_by(Retrade.requested_on.desc()).limit(500))))


# ---------------------------------------------------------------- sub-resources by id

async def _offer(db, offer_id: uuid.UUID) -> DispositionOffer:
    o = await db.get(DispositionOffer, offer_id)
    if not o or o.deleted_at:
        raise HTTPException(404, "Offer not found")
    return o


@router.patch("/offers/{offer_id}", response_model=OfferOut)
async def update_offer(offer_id: uuid.UUID, body: OfferIn, db: DB, user: CurrentUser = Depends(require("dispositions", "edit"))):
    o = await _offer(db, offer_id)
    if o.status == "accepted" and body.status != "withdrawn":
        raise HTTPException(409, "The accepted offer can only be withdrawn; record price changes as a retrade")
    return await service.update_offer(db, o, body, user)


@router.post("/offers/{offer_id}/accept", response_model=DispositionOut)
async def accept_offer(offer_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("dispositions", "approve"))):
    o = await _offer(db, offer_id)
    d = await service.accept_offer(db, await service.get(db, o.disposition_id), o, user)
    return await service.to_out(db, d)


@router.patch("/retrades/{retrade_id}", response_model=RetradeOut)
async def decide_retrade(retrade_id: uuid.UUID, body: RetradeDecisionIn, db: DB,
                         user: CurrentUser = Depends(require("dispositions", "approve"))):
    r = await db.get(Retrade, retrade_id)
    if not r or r.deleted_at:
        raise HTTPException(404, "Retrade not found")
    r = await service.decide_retrade(db, r, body, user)
    return (await service.retrade_items(db, [r]))[0]


@router.patch("/exchange-candidates/{candidate_id}")
async def update_candidate(candidate_id: uuid.UUID, body: CandidateIn, db: DB,
                           user: CurrentUser = Depends(require("dispositions", "edit"))):
    c = await db.get(ExchangeCandidate, candidate_id)
    if not c or c.deleted_at:
        raise HTTPException(404, "Candidate not found")
    ex = await db.get(Exchange1031, c.exchange_id)
    await service.save_candidate(db, ex, body, user, c)
    return await service.exchange_out(db, ex)


# ---------------------------------------------------------------- disposition record

@router.post("", response_model=DispositionOut, status_code=201)
async def create_disposition(body: DispositionCreate, db: DB, user: CurrentUser = Depends(require("dispositions", "create"))):
    return await service.to_out(db, await service.create(db, body, user))


@router.get("/{disposition_id}", response_model=DispositionOut)
async def get_disposition(disposition_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    return await service.to_out(db, await service.get(db, disposition_id))


@router.patch("/{disposition_id}", response_model=DispositionOut)
async def update_disposition(disposition_id: uuid.UUID, body: DispositionUpdate, db: DB,
                             user: CurrentUser = Depends(require("dispositions", "edit"))):
    return await service.to_out(db, await service.update(db, await service.get(db, disposition_id), body, user))


@router.delete("/{disposition_id}", status_code=204)
async def delete_disposition(disposition_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("dispositions", "delete"))):
    await service.archive(db, await service.get(db, disposition_id), user)


@router.get("/{disposition_id}/gates", response_model=GatesOut)
async def gates(disposition_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("dispositions", "view"))):
    d = await service.get(db, disposition_id)
    stages = []
    if d.stage != "closed":
        for s in PROGRESSION:
            if s == d.stage:
                continue
            reqs = await service.check_gate(db, d, s)
            stages.append(StageGate(stage=s, ready=not service.unmet_of(reqs), requirements=reqs))
    return GatesOut(current_stage=d.stage, next_stage=service.next_stage(d.stage),
                    can_override=user.can("dispositions", "approve"), stages=stages)


@router.post("/{disposition_id}/move", response_model=DispositionOut)
async def move(disposition_id: uuid.UUID, body: MoveIn, db: DB, user: CurrentUser = Depends(require("dispositions", "edit"))):
    return await service.to_out(db, await service.move(db, await service.get(db, disposition_id), body, user))


@router.get("/{disposition_id}/events", response_model=list[EventOut])
async def stage_history(disposition_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    await service.get(db, disposition_id)
    return list(await db.scalars(select(DispositionEvent).where(DispositionEvent.disposition_id == disposition_id)
                                 .order_by(DispositionEvent.at.desc())))


@router.get("/{disposition_id}/compare")
async def get_comparison(disposition_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    d = await service.get(db, disposition_id)
    return d.comparison or None


@router.post("/{disposition_id}/compare")
async def run_comparison(disposition_id: uuid.UUID, body: CompareIn, db: DB,
                         user: CurrentUser = Depends(require("dispositions", "edit"))):
    return await service.compare(db, await service.get(db, disposition_id), body, user)


@router.get("/{disposition_id}/proceeds")
async def proceeds(disposition_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    return await service.proceeds(db, await service.get(db, disposition_id))


@router.get("/{disposition_id}/offers", response_model=list[OfferOut])
async def list_offers(disposition_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    return list(await db.scalars(select(DispositionOffer).where(DispositionOffer.disposition_id == disposition_id,
                                                                DispositionOffer.deleted_at.is_(None))
                                 .order_by(DispositionOffer.received_on.desc(), DispositionOffer.price.desc())))


@router.post("/{disposition_id}/offers", response_model=OfferOut, status_code=201)
async def add_offer(disposition_id: uuid.UUID, body: OfferIn, db: DB, user: CurrentUser = Depends(require("dispositions", "edit"))):
    d = await service.get(db, disposition_id)
    if d.stage in ("closed", "withdrawn"):
        raise HTTPException(409, "Disposition is closed or withdrawn")
    return await service.add_offer(db, d, body, user)


@router.get("/{disposition_id}/retrades", response_model=list[RetradeOut])
async def list_retrades(disposition_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    rows = list(await db.scalars(select(Retrade).where(Retrade.disposition_id == disposition_id, Retrade.deleted_at.is_(None))
                                 .order_by(Retrade.requested_on.desc())))
    return await service.retrade_items(db, rows)


@router.post("/{disposition_id}/retrades", response_model=RetradeOut, status_code=201)
async def add_retrade(disposition_id: uuid.UUID, body: RetradeIn, db: DB,
                      user: CurrentUser = Depends(require("dispositions", "edit"))):
    r = await service.add_retrade(db, await service.get(db, disposition_id), body, user)
    return (await service.retrade_items(db, [r]))[0]


@router.get("/{disposition_id}/exchange")
async def get_exchange(disposition_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("dispositions", "view"))):
    ex = await service.get_exchange(db, await service.get(db, disposition_id))
    return await service.exchange_out(db, ex) if ex else None


@router.put("/{disposition_id}/exchange")
async def put_exchange(disposition_id: uuid.UUID, body: ExchangeIn, db: DB,
                       user: CurrentUser = Depends(require("dispositions", "edit"))):
    ex = await service.upsert_exchange(db, await service.get(db, disposition_id), body, user)
    return await service.exchange_out(db, ex)


@router.post("/{disposition_id}/exchange/candidates", status_code=201)
async def add_candidate(disposition_id: uuid.UUID, body: CandidateIn, db: DB,
                        user: CurrentUser = Depends(require("dispositions", "edit"))):
    ex = await service.get_exchange(db, await service.get(db, disposition_id))
    if not ex:
        raise HTTPException(409, "Set up the 1031 exchange first")
    await service.save_candidate(db, ex, body, user)
    return await service.exchange_out(db, ex)
