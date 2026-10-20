import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select

from app.common.query import ListParams, Page, apply_search, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, CurrentUser, require
from app.core.security import utcnow
from app.modules.brokerage import service
from app.modules.brokerage.models import (
    AGREEMENT_STATUSES,
    COMMISSION_STRUCTURES,
    DEAL_SIDES,
    DEAL_STAGES,
    EXCLUSIVITY,
    INQUIRY_SOURCES,
    INQUIRY_STATUSES,
    INTEREST_LEVELS,
    LISTING_STATUSES,
    LISTING_TYPES,
    LOST_REASONS,
    MARKET_STATUSES,
    MARKETING_KINDS,
    MARKETING_STATUSES,
    MATCH_STATUSES,
    ONBOARDING_TEMPLATE,
    PROPOSAL_KINDS,
    PROPOSAL_STATUSES,
    PROSPECT_STAGES,
    RECRUIT_STAGES,
    REPORT_CADENCES,
    REQUIREMENT_STATUSES,
    SHOWING_STATUSES,
    STAGE_PROBABILITY,
    SYNDICATION_CHANNELS,
    SYNDICATION_STATUSES,
    BrokerageDeal,
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
    ChecklistToggleIn,
    ConvertIn,
    DealBase,
    DealBoardColumn,
    DealFacets,
    DealOut,
    DealUpdate,
    DocOption,
    EngagementBase,
    EngagementOut,
    EngagementUpdate,
    InquiryBase,
    InquiryOut,
    InquiryUpdate,
    ListingCreate,
    ListingFacets,
    ListingOut,
    ListingUpdate,
    MarketingBase,
    MarketingOut,
    MarketingUpdate,
    MatchOut,
    MatchRunOut,
    MatchUpdate,
    PitchIn,
    PitchOut,
    PitchUpdate,
    PriceChangeIn,
    PriceHistoryOut,
    ProposalBase,
    ProposalOut,
    ProposalUpdate,
    ProspectBase,
    ProspectFacets,
    ProspectOut,
    ProspectUpdate,
    RecruitBase,
    RecruitOut,
    RecruitUpdate,
    RepAgreementBase,
    RepAgreementOut,
    RepAgreementUpdate,
    RequirementBase,
    RequirementOut,
    RequirementUpdate,
    SellerReportGenerateIn,
    SellerReportOut,
    SellerReportUpdate,
    ShowingBase,
    ShowingOut,
    ShowingUpdate,
    StageMoveIn,
    StatusChangeIn,
    StatusEventOut,
    WorkspaceOut,
)
from app.modules.brokerage.service import DealFilters, ListingFilters, ProspectFilters

router = APIRouter(tags=["brokerage"])

VIEW = Depends(require("brokerage", "view"))
CREATE = Depends(require("brokerage", "create"))
EDIT = Depends(require("brokerage", "edit"))
DELETE = Depends(require("brokerage", "delete"))


def page_of(schema, items, total, params: ListParams):
    return Page[schema](items=items, total=total, page=params.page, page_size=params.page_size)


# ============================================================================ meta / workspace / documents


@router.get("/brokerage/meta")
async def meta(_: CurrentUser = VIEW):
    return {
        "prospect_stages": PROSPECT_STAGES, "market_statuses": MARKET_STATUSES, "lost_reasons": LOST_REASONS,
        "exclusivity": EXCLUSIVITY, "commission_structures": COMMISSION_STRUCTURES,
        "agreement_statuses": AGREEMENT_STATUSES, "listing_types": LISTING_TYPES, "listing_statuses": LISTING_STATUSES,
        "report_cadences": REPORT_CADENCES, "marketing_kinds": MARKETING_KINDS,
        "marketing_statuses": MARKETING_STATUSES, "syndication_channels": SYNDICATION_CHANNELS,
        "syndication_statuses": SYNDICATION_STATUSES, "inquiry_sources": INQUIRY_SOURCES,
        "inquiry_statuses": INQUIRY_STATUSES, "showing_statuses": SHOWING_STATUSES,
        "interest_levels": INTEREST_LEVELS, "requirement_statuses": REQUIREMENT_STATUSES,
        "match_statuses": MATCH_STATUSES, "proposal_kinds": PROPOSAL_KINDS, "proposal_statuses": PROPOSAL_STATUSES,
        "deal_sides": DEAL_SIDES, "deal_stages": DEAL_STAGES, "stage_probability": STAGE_PROBABILITY,
        "recruit_stages": RECRUIT_STAGES, "onboarding_template": [{"key": k, "label": v} for k, v in ONBOARDING_TEMPLATE],
    }


@router.get("/brokerage/workspace", response_model=WorkspaceOut)
async def workspace(db: DB, agent_id: uuid.UUID | None = None, all_agents: bool = False, user: CurrentUser = VIEW):
    """The agent's personal pipeline; defaults to the signed-in agent."""
    return await service.workspace(db, None if all_agents else (agent_id or user.id))


@router.get("/brokerage/documents/options", response_model=Page[DocOption])
async def document_options(db: DB, q: str | None = Query(None, max_length=200), page_size: int = Query(15, le=50),
                           _: CurrentUser = VIEW):
    items = await service.document_options(db, q, page_size)
    return Page[DocOption](items=items, total=len(items), page=1, page_size=page_size)


@router.get("/brokerage/documents/options/{document_id}", response_model=DocOption)
async def document_option(document_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    return await service.document_option(db, document_id)


@router.post("/brokerage/seller-reports/run-due")
async def run_due_reports(db: DB, user: CurrentUser = EDIT):
    return {"generated": await service.run_due_reports(db, user)}


@router.get("/brokerage/history/{entity_type}/{entity_id}", response_model=list[StatusEventOut])
async def status_history(entity_type: str, entity_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    if entity_type not in ("listing_prospect", "listing", "brokerage_deal", "recruit"):
        raise HTTPException(404, "Unknown history type")
    return await service.status_history(db, entity_type, entity_id)


# ============================================================================ prospects


def prospect_filters(
    q: str | None = Query(None, max_length=200),
    stage: list[str] | None = Query(None),
    market_status: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None),
    property_id: uuid.UUID | None = None,
    person_id: uuid.UUID | None = None,
    organization_id: uuid.UUID | None = None,
    expiring_within_days: int | None = Query(None, ge=0, le=3650),
    mine: bool | None = None,
) -> ProspectFilters:
    return ProspectFilters(**locals())


PROSPECT_SORTS = {"title": ListingProspect.title, "stage": ListingProspect.stage,
                  "competitor_expires_on": ListingProspect.competitor_expires_on,
                  "next_action_at": ListingProspect.next_action_at, "estimated_value": ListingProspect.estimated_value,
                  "updated_at": ListingProspect.updated_at, "created_at": ListingProspect.created_at}


@router.get("/listing-prospects", response_model=Page[ProspectOut])
async def list_prospects(db: DB, params: ListParams = Depends(), f: ProspectFilters = Depends(prospect_filters),
                         user: CurrentUser = VIEW):
    stmt = apply_sort(service.prospect_query(f, user), params.sort, PROSPECT_SORTS, ListingProspect.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(ProspectOut, await service.prospect_outs(db, rows), total, params)


@router.get("/listing-prospects/facets", response_model=ProspectFacets)
async def prospect_facets(db: DB, f: ProspectFilters = Depends(prospect_filters), user: CurrentUser = VIEW):
    q = service.prospect_query
    return ProspectFacets(
        stage=await facet_counts(db, q(f, user, skip={"stage"}), ListingProspect.stage),
        market_status=await facet_counts(db, q(f, user, skip={"market_status"}), ListingProspect.market_status),
        agent_id=await facet_counts(db, q(f, user, skip={"agent_id"}), ListingProspect.agent_id),
    )


@router.post("/listing-prospects", response_model=ProspectOut, status_code=201)
async def create_prospect(body: ProspectBase, db: DB, user: CurrentUser = CREATE):
    p = await service.create_prospect(db, body, user)
    return (await service.prospect_outs(db, [p]))[0]


@router.get("/listing-prospects/{prospect_id}", response_model=ProspectOut)
async def get_prospect(prospect_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    p = await service.get_or_404(db, ListingProspect, prospect_id, "Prospect")
    return (await service.prospect_outs(db, [p]))[0]


@router.patch("/listing-prospects/{prospect_id}", response_model=ProspectOut)
async def update_prospect(prospect_id: uuid.UUID, body: ProspectUpdate, db: DB, user: CurrentUser = EDIT):
    p = await service.get_or_404(db, ListingProspect, prospect_id, "Prospect")
    p = await service.update_prospect(db, p, body, user)
    return (await service.prospect_outs(db, [p]))[0]


@router.delete("/listing-prospects/{prospect_id}", status_code=204)
async def archive_prospect(prospect_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, ListingProspect, prospect_id, "Prospect"),
                              "listing_prospect", user)


@router.post("/listing-prospects/{prospect_id}/move", response_model=ProspectOut)
async def move_prospect(prospect_id: uuid.UUID, body: StageMoveIn, db: DB, user: CurrentUser = EDIT):
    p = await service.move_prospect(db, await service.get_or_404(db, ListingProspect, prospect_id, "Prospect"),
                                    body, user)
    return (await service.prospect_outs(db, [p]))[0]


@router.get("/listing-prospects/{prospect_id}/pitches", response_model=list[PitchOut])
async def list_pitches(prospect_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    return list(await db.scalars(select(ProspectPitch).where(
        ProspectPitch.prospect_id == prospect_id, ProspectPitch.deleted_at.is_(None))
        .order_by(ProspectPitch.pitched_on.desc(), ProspectPitch.created_at.desc())))


@router.post("/listing-prospects/{prospect_id}/pitches", response_model=PitchOut, status_code=201)
async def add_pitch(prospect_id: uuid.UUID, body: PitchIn, db: DB, user: CurrentUser = EDIT):
    p = await service.get_or_404(db, ListingProspect, prospect_id, "Prospect")
    return await service.add_pitch(db, p, body, user)


@router.patch("/prospect-pitches/{pitch_id}", response_model=PitchOut)
async def update_pitch(pitch_id: uuid.UUID, body: PitchUpdate, db: DB, user: CurrentUser = EDIT):
    pitch = await service.get_or_404(db, ProspectPitch, pitch_id, "Pitch")
    return await service.update_pitch(db, pitch, body, user)


@router.post("/listing-prospects/{prospect_id}/convert", response_model=ListingOut, status_code=201)
async def convert_prospect(prospect_id: uuid.UUID, body: ConvertIn, db: DB, user: CurrentUser = CREATE):
    p = await service.get_or_404(db, ListingProspect, prospect_id, "Prospect")
    listing = await service.convert_prospect(db, p, body, user)
    return (await service.listing_outs(db, [listing]))[0]


# ============================================================================ engagement / representation agreements


@router.get("/engagement-agreements", response_model=Page[EngagementOut])
async def list_engagements(
    db: DB, params: ListParams = Depends(), prospect_id: uuid.UUID | None = None, listing_id: uuid.UUID | None = None,
    property_id: uuid.UUID | None = None, status: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None), mine: bool | None = None,
    expiring_within_days: int | None = Query(None, ge=0, le=3650), user: CurrentUser = VIEW,
):
    stmt = select(EngagementAgreement).where(EngagementAgreement.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [EngagementAgreement.notes])
    for col, v in ((EngagementAgreement.prospect_id, prospect_id), (EngagementAgreement.listing_id, listing_id),
                   (EngagementAgreement.property_id, property_id)):
        if v:
            stmt = stmt.where(col == v)
    stmt = in_filter(in_filter(stmt, EngagementAgreement.status, status), EngagementAgreement.agent_id, agent_id)
    if mine:
        stmt = stmt.where(EngagementAgreement.agent_id == user.id)
    if expiring_within_days is not None:
        stmt = stmt.where(EngagementAgreement.expires_on <= service.today() + timedelta(days=expiring_within_days))
    stmt = apply_sort(stmt, params.sort, {"expires_on": EngagementAgreement.expires_on,
                                          "status": EngagementAgreement.status,
                                          "updated_at": EngagementAgreement.updated_at},
                      EngagementAgreement.expires_on.asc().nulls_last())
    rows, total = await paginate(db, stmt, params)
    return page_of(EngagementOut, await service.engagement_outs(db, rows), total, params)


@router.post("/engagement-agreements", response_model=EngagementOut, status_code=201)
async def create_engagement(body: EngagementBase, db: DB, user: CurrentUser = CREATE):
    return (await service.engagement_outs(db, [await service.save_engagement(db, body, user)]))[0]


@router.get("/engagement-agreements/{agreement_id}", response_model=EngagementOut)
async def get_engagement(agreement_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    ea = await service.get_or_404(db, EngagementAgreement, agreement_id, "Engagement agreement")
    return (await service.engagement_outs(db, [ea]))[0]


@router.patch("/engagement-agreements/{agreement_id}", response_model=EngagementOut)
async def update_engagement(agreement_id: uuid.UUID, body: EngagementUpdate, db: DB, user: CurrentUser = EDIT):
    ea = await service.get_or_404(db, EngagementAgreement, agreement_id, "Engagement agreement")
    return (await service.engagement_outs(db, [await service.save_engagement(db, body, user, ea)]))[0]


@router.delete("/engagement-agreements/{agreement_id}", status_code=204)
async def archive_engagement(agreement_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    ea = await service.get_or_404(db, EngagementAgreement, agreement_id, "Engagement agreement")
    await service.archive_row(db, ea, "engagement_agreement", user)


@router.get("/rep-agreements", response_model=Page[RepAgreementOut])
async def list_rep_agreements(
    db: DB, params: ListParams = Depends(), kind: list[str] | None = Query(None), status: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None), person_id: uuid.UUID | None = None,
    organization_id: uuid.UUID | None = None, mine: bool | None = None, user: CurrentUser = VIEW,
):
    stmt = select(RepAgreement).where(RepAgreement.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [RepAgreement.territory, RepAgreement.notes])
    stmt = in_filter(in_filter(in_filter(stmt, RepAgreement.kind, kind), RepAgreement.status, status),
                     RepAgreement.agent_id, agent_id)
    if person_id:
        stmt = stmt.where(RepAgreement.client_person_id == person_id)
    if organization_id:
        stmt = stmt.where(RepAgreement.client_organization_id == organization_id)
    if mine:
        stmt = stmt.where(RepAgreement.agent_id == user.id)
    stmt = apply_sort(stmt, params.sort, {"expires_on": RepAgreement.expires_on, "status": RepAgreement.status,
                                          "kind": RepAgreement.kind, "updated_at": RepAgreement.updated_at},
                      RepAgreement.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(RepAgreementOut, await service.rep_outs(db, rows), total, params)


@router.post("/rep-agreements", response_model=RepAgreementOut, status_code=201)
async def create_rep_agreement(body: RepAgreementBase, db: DB, user: CurrentUser = CREATE):
    return (await service.rep_outs(db, [await service.save_rep_agreement(db, body, user)]))[0]


@router.get("/rep-agreements/{agreement_id}", response_model=RepAgreementOut)
async def get_rep_agreement(agreement_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    ra = await service.get_or_404(db, RepAgreement, agreement_id, "Representation agreement")
    return (await service.rep_outs(db, [ra]))[0]


@router.patch("/rep-agreements/{agreement_id}", response_model=RepAgreementOut)
async def update_rep_agreement(agreement_id: uuid.UUID, body: RepAgreementUpdate, db: DB, user: CurrentUser = EDIT):
    ra = await service.get_or_404(db, RepAgreement, agreement_id, "Representation agreement")
    return (await service.rep_outs(db, [await service.save_rep_agreement(db, body, user, ra)]))[0]


@router.delete("/rep-agreements/{agreement_id}", status_code=204)
async def archive_rep_agreement(agreement_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    ra = await service.get_or_404(db, RepAgreement, agreement_id, "Representation agreement")
    await service.archive_row(db, ra, "rep_agreement", user)


# ============================================================================ listings


def listing_filters(
    q: str | None = Query(None, max_length=200),
    status: list[str] | None = Query(None),
    listing_type: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None),
    property_id: uuid.UUID | None = None,
    mine: bool | None = None,
    min_price: float | None = None,
    max_price: float | None = None,
    min_dom: int | None = None,
    max_dom: int | None = None,
) -> ListingFilters:
    return ListingFilters(**locals())


LISTING_SORTS = {"asking_price": Listing.asking_price, "listed_on": Listing.listed_on, "status": Listing.status,
                 "expires_on": Listing.expires_on, "days_on_market": service.dom_expr(),
                 "updated_at": Listing.updated_at, "created_at": Listing.created_at}


@router.get("/listings", response_model=Page[ListingOut])
async def list_listings(db: DB, params: ListParams = Depends(), f: ListingFilters = Depends(listing_filters),
                        user: CurrentUser = VIEW):
    stmt = apply_sort(service.listing_query(f, user), params.sort, LISTING_SORTS, Listing.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(ListingOut, await service.listing_outs(db, rows), total, params)


@router.get("/listings/facets", response_model=ListingFacets)
async def listing_facets(db: DB, f: ListingFilters = Depends(listing_filters), user: CurrentUser = VIEW):
    q = service.listing_query
    return ListingFacets(
        status=await facet_counts(db, q(f, user, skip={"status"}), Listing.status),
        listing_type=await facet_counts(db, q(f, user, skip={"listing_type"}), Listing.listing_type),
        agent_id=await facet_counts(db, q(f, user, skip={"agent_id"}), Listing.agent_id),
    )


@router.post("/listings", response_model=ListingOut, status_code=201)
async def create_listing(body: ListingCreate, db: DB, user: CurrentUser = CREATE):
    listing = await service.create_listing(db, body, user)
    return (await service.listing_outs(db, [listing]))[0]


@router.get("/listings/{listing_id}", response_model=ListingOut)
async def get_listing(listing_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    listing = await service.get_or_404(db, Listing, listing_id, "Listing")
    return (await service.listing_outs(db, [listing]))[0]


@router.patch("/listings/{listing_id}", response_model=ListingOut)
async def update_listing(listing_id: uuid.UUID, body: ListingUpdate, db: DB, user: CurrentUser = EDIT):
    listing = await service.update_listing(db, await service.get_or_404(db, Listing, listing_id, "Listing"), body, user)
    return (await service.listing_outs(db, [listing]))[0]


@router.delete("/listings/{listing_id}", status_code=204)
async def archive_listing(listing_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    listing = await service.get_or_404(db, Listing, listing_id, "Listing")
    if listing.status in ("active", "under_contract", "sold", "leased"):
        raise HTTPException(409, "Listings that went to market are retained with their history")
    await service.archive_row(db, listing, "listing", user)


@router.post("/listings/{listing_id}/price", response_model=ListingOut)
async def change_price(listing_id: uuid.UUID, body: PriceChangeIn, db: DB, user: CurrentUser = EDIT):
    listing = await service.change_price(db, await service.get_or_404(db, Listing, listing_id, "Listing"), body, user)
    return (await service.listing_outs(db, [listing]))[0]


@router.post("/listings/{listing_id}/status", response_model=ListingOut)
async def change_status(listing_id: uuid.UUID, body: StatusChangeIn, db: DB, user: CurrentUser = EDIT):
    listing = await service.change_status(db, await service.get_or_404(db, Listing, listing_id, "Listing"), body, user)
    return (await service.listing_outs(db, [listing]))[0]


@router.get("/listings/{listing_id}/price-history", response_model=list[PriceHistoryOut])
async def price_history(listing_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    return list(await db.scalars(select(ListingPriceHistory).where(ListingPriceHistory.listing_id == listing_id)
                                 .order_by(ListingPriceHistory.at.desc())))


@router.get("/listings/{listing_id}/status-history", response_model=list[StatusEventOut])
async def listing_status_history(listing_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    return await service.status_history(db, "listing", listing_id)


@router.get("/listings/{listing_id}/marketing", response_model=list[MarketingOut])
async def list_marketing(listing_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    rows = list(await db.scalars(select(MarketingItem).where(
        MarketingItem.listing_id == listing_id, MarketingItem.deleted_at.is_(None))
        .order_by(MarketingItem.created_at.desc())))
    reviews = await service.ad_review_statuses(db, [r.id for r in rows])
    outs = []
    for r in rows:
        o = MarketingOut.model_validate(r)
        o.ad_review_status = reviews.get(r.id)
        outs.append(o)
    return outs


@router.post("/listings/{listing_id}/marketing", response_model=MarketingOut, status_code=201)
async def create_marketing(listing_id: uuid.UUID, body: MarketingBase, db: DB, user: CurrentUser = CREATE):
    listing = await service.get_or_404(db, Listing, listing_id, "Listing")
    return await service.save_marketing(db, listing, body, user)


@router.patch("/marketing-items/{item_id}", response_model=MarketingOut)
async def update_marketing(item_id: uuid.UUID, body: MarketingUpdate, db: DB, user: CurrentUser = EDIT):
    item = await service.get_or_404(db, MarketingItem, item_id, "Marketing item")
    listing = await service.get_or_404(db, Listing, item.listing_id, "Listing")
    item = await service.save_marketing(db, listing, body, user, item)
    out = MarketingOut.model_validate(item)
    out.ad_review_status = (await service.ad_review_statuses(db, [item.id])).get(item.id)
    return out


@router.delete("/marketing-items/{item_id}", status_code=204)
async def archive_marketing(item_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, MarketingItem, item_id, "Marketing item"),
                              "marketing_item", user)


@router.get("/listings/{listing_id}/seller-reports", response_model=list[SellerReportOut])
async def list_seller_reports(listing_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    return list(await db.scalars(select(SellerReport).where(
        SellerReport.listing_id == listing_id, SellerReport.deleted_at.is_(None))
        .order_by(SellerReport.period_end.desc())))


@router.post("/listings/{listing_id}/seller-reports", response_model=SellerReportOut, status_code=201)
async def generate_seller_report(listing_id: uuid.UUID, body: SellerReportGenerateIn, db: DB,
                                 user: CurrentUser = CREATE):
    listing = await service.get_or_404(db, Listing, listing_id, "Listing")
    return await service.generate_seller_report(db, listing, user, period_start=body.period_start,
                                                period_end=body.period_end, commentary=body.commentary)


@router.patch("/seller-reports/{report_id}", response_model=SellerReportOut)
async def update_seller_report(report_id: uuid.UUID, body: SellerReportUpdate, db: DB, user: CurrentUser = EDIT):
    r = await service.get_or_404(db, SellerReport, report_id, "Seller report")
    return await service.update_seller_report(db, r, body, user)


# ============================================================================ inquiries & showings


INQUIRY_SPEC = {**service.PARTY_SPEC, "person_id": ("person", "person_label"),
                "organization_id": ("organization", "organization_label"), "assigned_to_id": ("user", "assigned_name")}


@router.get("/inquiries", response_model=Page[InquiryOut])
async def list_inquiries(
    db: DB, params: ListParams = Depends(), listing_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
    status: list[str] | None = Query(None), source: list[str] | None = Query(None),
    assigned_to_id: list[uuid.UUID] | None = Query(None), mine: bool | None = None, user: CurrentUser = VIEW,
):
    stmt = select(Inquiry).where(Inquiry.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [Inquiry.contact_name, Inquiry.contact_email, Inquiry.message])
    if listing_id:
        stmt = stmt.where(Inquiry.listing_id == listing_id)
    if property_id:
        stmt = stmt.where(Inquiry.property_id == property_id)
    stmt = in_filter(in_filter(in_filter(stmt, Inquiry.status, status), Inquiry.source, source),
                     Inquiry.assigned_to_id, assigned_to_id)
    if mine:
        stmt = stmt.where(Inquiry.assigned_to_id == user.id)
    stmt = apply_sort(stmt, params.sort, {"received_at": Inquiry.received_at, "status": Inquiry.status,
                                          "source": Inquiry.source}, Inquiry.received_at.desc())
    rows, total = await paginate(db, stmt, params)
    outs = await service.enrich(db, [InquiryOut.model_validate(r) for r in rows], INQUIRY_SPEC)
    return page_of(InquiryOut, outs, total, params)


@router.post("/inquiries", response_model=InquiryOut, status_code=201)
async def create_inquiry(body: InquiryBase, db: DB, user: CurrentUser = CREATE):
    inq = await service.create_inquiry(db, body, user)
    return (await service.enrich(db, [InquiryOut.model_validate(inq)], INQUIRY_SPEC))[0]


@router.patch("/inquiries/{inquiry_id}", response_model=InquiryOut)
async def update_inquiry(inquiry_id: uuid.UUID, body: InquiryUpdate, db: DB, user: CurrentUser = EDIT):
    inq = await service.get_or_404(db, Inquiry, inquiry_id, "Inquiry")
    values = {k: v for k, v in body.model_dump(exclude_unset=True).items()
              if not (v is None and k in ("status", "source", "received_at"))}
    await service.patch_row(db, inq, "inquiry", values, user)
    await db.commit()
    return (await service.enrich(db, [InquiryOut.model_validate(inq)], INQUIRY_SPEC))[0]


@router.delete("/inquiries/{inquiry_id}", status_code=204)
async def archive_inquiry(inquiry_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, Inquiry, inquiry_id, "Inquiry"), "inquiry", user)


SHOWING_SPEC = {**service.PARTY_SPEC, "person_id": ("person", "person_label"),
                "organization_id": ("organization", "organization_label"), "shown_by_id": ("user", "shown_by_name")}


@router.get("/showings", response_model=Page[ShowingOut])
async def list_showings(
    db: DB, params: ListParams = Depends(), listing_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
    tour_id: uuid.UUID | None = None, status: list[str] | None = Query(None), upcoming: bool | None = None,
    mine: bool | None = None, user: CurrentUser = VIEW,
):
    stmt = select(Showing).where(Showing.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [Showing.contact_name, Showing.feedback, Showing.notes])
    for col, v in ((Showing.listing_id, listing_id), (Showing.property_id, property_id), (Showing.tour_id, tour_id)):
        if v:
            stmt = stmt.where(col == v)
    stmt = in_filter(stmt, Showing.status, status)
    if upcoming:
        stmt = stmt.where(Showing.scheduled_at >= utcnow())
    if mine:
        stmt = stmt.where(Showing.shown_by_id == user.id)
    stmt = apply_sort(stmt, params.sort, {"scheduled_at": Showing.scheduled_at, "status": Showing.status},
                      Showing.scheduled_at.desc())
    rows, total = await paginate(db, stmt, params)
    outs = await service.enrich(db, [ShowingOut.model_validate(r) for r in rows], SHOWING_SPEC)
    return page_of(ShowingOut, outs, total, params)


@router.post("/showings", response_model=ShowingOut, status_code=201)
async def create_showing(body: ShowingBase, db: DB, user: CurrentUser = CREATE):
    s = await service.save_showing(db, body, user)
    return (await service.enrich(db, [ShowingOut.model_validate(s)], SHOWING_SPEC))[0]


@router.patch("/showings/{showing_id}", response_model=ShowingOut)
async def update_showing(showing_id: uuid.UUID, body: ShowingUpdate, db: DB, user: CurrentUser = EDIT):
    s = await service.save_showing(db, body, user, await service.get_or_404(db, Showing, showing_id, "Showing"))
    return (await service.enrich(db, [ShowingOut.model_validate(s)], SHOWING_SPEC))[0]


@router.delete("/showings/{showing_id}", status_code=204)
async def archive_showing(showing_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, Showing, showing_id, "Showing"), "showing", user)


# ============================================================================ requirements & matches


async def requirement_outs(db: DB, rows: list[RequirementProfile]) -> list[RequirementOut]:
    counts = dict((await db.execute(select(RequirementMatch.requirement_id, func.count()).where(
        RequirementMatch.requirement_id.in_([r.id for r in rows]), RequirementMatch.deleted_at.is_(None),
        RequirementMatch.status != "rejected").group_by(RequirementMatch.requirement_id))).all()) if rows else {}
    outs = []
    for r in rows:
        o = RequirementOut.model_validate(r)
        o.match_count = int(counts.get(r.id, 0))
        outs.append(o)
    return await service.enrich(db, outs, service.CLIENT_SPEC)


def _clean_lists(values: dict, keys: tuple[str, ...]) -> dict:
    for k in keys:
        if k in values and values[k] is None:
            values[k] = []
    return values


REQ_LISTS = ("property_types", "states", "cities", "counties", "features")


@router.get("/requirements", response_model=Page[RequirementOut])
async def list_requirements(
    db: DB, params: ListParams = Depends(), status: list[str] | None = Query(None), side: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None), rep_agreement_id: uuid.UUID | None = None,
    mine: bool | None = None, user: CurrentUser = VIEW,
):
    stmt = select(RequirementProfile).where(RequirementProfile.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [RequirementProfile.name, RequirementProfile.notes])
    stmt = in_filter(in_filter(in_filter(stmt, RequirementProfile.status, status), RequirementProfile.side, side),
                     RequirementProfile.agent_id, agent_id)
    if rep_agreement_id:
        stmt = stmt.where(RequirementProfile.rep_agreement_id == rep_agreement_id)
    if mine:
        stmt = stmt.where(RequirementProfile.agent_id == user.id)
    stmt = apply_sort(stmt, params.sort, {"name": RequirementProfile.name, "status": RequirementProfile.status,
                                          "updated_at": RequirementProfile.updated_at},
                      RequirementProfile.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(RequirementOut, await requirement_outs(db, rows), total, params)


@router.post("/requirements", response_model=RequirementOut, status_code=201)
async def create_requirement(body: RequirementBase, db: DB, user: CurrentUser = CREATE):
    values = body.model_dump()
    values["agent_id"] = values.get("agent_id") or user.id
    if values.get("rep_agreement_id") and not (values.get("client_person_id") or values.get("client_organization_id")):
        ra = await service.get_or_404(db, RepAgreement, values["rep_agreement_id"], "Representation agreement")
        values["client_person_id"], values["client_organization_id"] = ra.client_person_id, ra.client_organization_id
    r = await service.create_row(db, RequirementProfile, "requirement", values, user, summary=values["name"])
    await db.commit()
    return (await requirement_outs(db, [r]))[0]


@router.get("/requirements/{requirement_id}", response_model=RequirementOut)
async def get_requirement(requirement_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    r = await service.get_or_404(db, RequirementProfile, requirement_id, "Requirement")
    return (await requirement_outs(db, [r]))[0]


@router.patch("/requirements/{requirement_id}", response_model=RequirementOut)
async def update_requirement(requirement_id: uuid.UUID, body: RequirementUpdate, db: DB, user: CurrentUser = EDIT):
    r = await service.get_or_404(db, RequirementProfile, requirement_id, "Requirement")
    values = _clean_lists(body.model_dump(exclude_unset=True), REQ_LISTS)
    values = {k: v for k, v in values.items() if not (v is None and k in ("name", "side", "status"))}
    await service.patch_row(db, r, "requirement", values, user)
    await db.commit()
    return (await requirement_outs(db, [r]))[0]


@router.delete("/requirements/{requirement_id}", status_code=204)
async def archive_requirement(requirement_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    r = await service.get_or_404(db, RequirementProfile, requirement_id, "Requirement")
    await service.archive_row(db, r, "requirement", user)


@router.post("/requirements/{requirement_id}/match", response_model=MatchRunOut)
async def run_match(requirement_id: uuid.UUID, db: DB, user: CurrentUser = EDIT):
    r = await service.get_or_404(db, RequirementProfile, requirement_id, "Requirement")
    added, total, criteria = await service.run_match(db, r, user)
    return MatchRunOut(added=added, total=total, criteria=criteria)


@router.get("/requirements/{requirement_id}/matches", response_model=list[MatchOut])
async def list_matches(requirement_id: uuid.UUID, db: DB, status: list[str] | None = Query(None),
                       _: CurrentUser = VIEW):
    from app.modules.properties.models import Property

    stmt = (select(RequirementMatch, Property).join(Property, Property.id == RequirementMatch.property_id)
            .where(RequirementMatch.requirement_id == requirement_id, RequirementMatch.deleted_at.is_(None)))
    stmt = in_filter(stmt, RequirementMatch.status, status)
    outs = []
    for m, p in (await db.execute(stmt.order_by(RequirementMatch.matched_at.desc()).limit(500))).all():
        o = MatchOut.model_validate(m)
        o.property_label, o.property_city, o.property_state = p.name or p.address_line, p.city, p.state
        o.property_type, o.building_area_sf, o.asking_price = p.property_type, p.building_area_sf, p.asking_price
        outs.append(o)
    return outs


@router.patch("/requirement-matches/{match_id}", response_model=MatchOut)
async def update_match(match_id: uuid.UUID, body: MatchUpdate, db: DB, user: CurrentUser = EDIT):
    m = await service.get_or_404(db, RequirementMatch, match_id, "Match")
    values = {k: v for k, v in body.model_dump(exclude_unset=True).items() if not (k == "status" and v is None)}
    await service.patch_row(db, m, "requirement_match", values, user)
    await db.commit()
    return MatchOut.model_validate(m)


# ============================================================================ proposals


PROPOSAL_SPEC = {**service.PARTY_SPEC, "recipient_person_id": ("person", "person_label"),
                 "recipient_organization_id": ("organization", "organization_label")}


@router.get("/proposals", response_model=Page[ProposalOut])
async def list_proposals(
    db: DB, params: ListParams = Depends(), kind: list[str] | None = Query(None), status: list[str] | None = Query(None),
    brokerage_deal_id: uuid.UUID | None = None, listing_id: uuid.UUID | None = None,
    prospect_id: uuid.UUID | None = None, requirement_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
    include_superseded: bool = True, mine: bool | None = None, user: CurrentUser = VIEW,
):
    stmt = select(Proposal).where(Proposal.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [Proposal.title, Proposal.terms])
    stmt = in_filter(in_filter(stmt, Proposal.kind, kind), Proposal.status, status)
    for col, v in ((Proposal.brokerage_deal_id, brokerage_deal_id), (Proposal.listing_id, listing_id),
                   (Proposal.prospect_id, prospect_id), (Proposal.requirement_id, requirement_id),
                   (Proposal.property_id, property_id)):
        if v:
            stmt = stmt.where(col == v)
    if not include_superseded:
        stmt = stmt.where(Proposal.status != "superseded")
    if mine:
        stmt = stmt.where(Proposal.agent_id == user.id)
    stmt = apply_sort(stmt, params.sort, {"title": Proposal.title, "status": Proposal.status,
                                          "sent_on": Proposal.sent_on, "updated_at": Proposal.updated_at},
                      Proposal.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    outs = await service.enrich(db, [ProposalOut.model_validate(r) for r in rows], PROPOSAL_SPEC)
    return page_of(ProposalOut, outs, total, params)


@router.post("/proposals", response_model=ProposalOut, status_code=201)
async def create_proposal(body: ProposalBase, db: DB, user: CurrentUser = CREATE):
    values = body.model_dump()
    values["agent_id"] = values.get("agent_id") or user.id
    p = await service.create_row(db, Proposal, "proposal", values, user, summary=values["title"])
    await service.link_document(db, p.document_id, "proposal", p.id, user)
    await db.commit()
    return (await service.enrich(db, [ProposalOut.model_validate(p)], PROPOSAL_SPEC))[0]


@router.get("/proposals/{proposal_id}", response_model=ProposalOut)
async def get_proposal(proposal_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    p = await service.get_or_404(db, Proposal, proposal_id, "Proposal")
    return (await service.enrich(db, [ProposalOut.model_validate(p)], PROPOSAL_SPEC))[0]


@router.patch("/proposals/{proposal_id}", response_model=ProposalOut)
async def update_proposal(proposal_id: uuid.UUID, body: ProposalUpdate, db: DB, user: CurrentUser = EDIT):
    p = await service.get_or_404(db, Proposal, proposal_id, "Proposal")
    if p.status == "superseded":
        raise HTTPException(409, "Superseded versions are retained as history and cannot be edited")
    values = {k: v for k, v in body.model_dump(exclude_unset=True).items()
              if not (v is None and k in ("kind", "title", "status"))}
    if values.get("status") == "superseded":
        raise HTTPException(422, "Use revise to supersede a proposal")
    if values.get("status") == "sent" and not (values.get("sent_on") or p.sent_on):
        values["sent_on"] = date.today()
    await service.patch_row(db, p, "proposal", values, user)
    await db.commit()
    return (await service.enrich(db, [ProposalOut.model_validate(p)], PROPOSAL_SPEC))[0]


@router.post("/proposals/{proposal_id}/revise", response_model=ProposalOut, status_code=201)
async def revise_proposal(proposal_id: uuid.UUID, body: ProposalUpdate, db: DB, user: CurrentUser = EDIT):
    parent = await service.get_or_404(db, Proposal, proposal_id, "Proposal")
    child = await service.revise_proposal(db, parent, body, user)
    return (await service.enrich(db, [ProposalOut.model_validate(child)], PROPOSAL_SPEC))[0]


@router.delete("/proposals/{proposal_id}", status_code=204)
async def archive_proposal(proposal_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, Proposal, proposal_id, "Proposal"), "proposal", user)


# ============================================================================ brokerage deals


def deal_filters(
    q: str | None = Query(None, max_length=200),
    stage: list[str] | None = Query(None),
    side: list[str] | None = Query(None),
    agent_id: list[uuid.UUID] | None = Query(None),
    property_id: uuid.UUID | None = None,
    listing_id: uuid.UUID | None = None,
    mine: bool | None = None,
    closing_before: date | None = None,
) -> DealFilters:
    return DealFilters(**locals())


DEAL_SORTS = {"title": BrokerageDeal.title, "stage": BrokerageDeal.stage, "side": BrokerageDeal.side,
              "expected_close_on": BrokerageDeal.expected_close_on, "probability": BrokerageDeal.probability,
              "deal_value": BrokerageDeal.deal_value,
              "gross_commission_estimate": BrokerageDeal.gross_commission_estimate,
              "updated_at": BrokerageDeal.updated_at}


@router.get("/brokerage-deals", response_model=Page[DealOut])
async def list_deals(db: DB, params: ListParams = Depends(), f: DealFilters = Depends(deal_filters),
                     user: CurrentUser = VIEW):
    stmt = apply_sort(service.deal_query(f, user), params.sort, DEAL_SORTS,
                      BrokerageDeal.expected_close_on.asc().nulls_last())
    rows, total = await paginate(db, stmt, params)
    return page_of(DealOut, await service.deal_outs(db, rows), total, params)


@router.get("/brokerage-deals/facets", response_model=DealFacets)
async def deal_facets(db: DB, f: DealFilters = Depends(deal_filters), user: CurrentUser = VIEW):
    q = service.deal_query
    return DealFacets(
        stage=await facet_counts(db, q(f, user, skip={"stage"}), BrokerageDeal.stage),
        side=await facet_counts(db, q(f, user, skip={"side"}), BrokerageDeal.side),
        agent_id=await facet_counts(db, q(f, user, skip={"agent_id"}), BrokerageDeal.agent_id),
    )


@router.get("/brokerage-deals/board", response_model=list[DealBoardColumn])
async def deal_board(db: DB, f: DealFilters = Depends(deal_filters), per_stage: int = Query(50, ge=1, le=200),
                     user: CurrentUser = VIEW):
    return await service.deal_board(db, f, user, per_stage)


@router.post("/brokerage-deals", response_model=DealOut, status_code=201)
async def create_deal(body: DealBase, db: DB, user: CurrentUser = CREATE):
    return (await service.deal_outs(db, [await service.create_deal(db, body, user)]))[0]


@router.get("/brokerage-deals/{deal_id}", response_model=DealOut)
async def get_deal(deal_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    d = await service.get_or_404(db, BrokerageDeal, deal_id, "Deal")
    return (await service.deal_outs(db, [d], with_file=True))[0]


@router.patch("/brokerage-deals/{deal_id}", response_model=DealOut)
async def update_deal(deal_id: uuid.UUID, body: DealUpdate, db: DB, user: CurrentUser = EDIT):
    d = await service.update_deal(db, await service.get_or_404(db, BrokerageDeal, deal_id, "Deal"), body, user)
    return (await service.deal_outs(db, [d], with_file=True))[0]


@router.post("/brokerage-deals/{deal_id}/move", response_model=DealOut)
async def move_deal(deal_id: uuid.UUID, body: StageMoveIn, db: DB, user: CurrentUser = EDIT):
    d = await service.move_deal(db, await service.get_or_404(db, BrokerageDeal, deal_id, "Deal"), body, user)
    return (await service.deal_outs(db, [d], with_file=True))[0]


@router.delete("/brokerage-deals/{deal_id}", status_code=204)
async def archive_deal(deal_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    d = await service.get_or_404(db, BrokerageDeal, deal_id, "Deal")
    if d.stage in ("under_contract", "closing", "closed"):
        raise HTTPException(409, "Deals under contract or closed are retained with their transaction file")
    await service.archive_row(db, d, "brokerage_deal", user)


# ============================================================================ recruits


@router.get("/recruits", response_model=Page[RecruitOut])
async def list_recruits(db: DB, params: ListParams = Depends(), stage: list[str] | None = Query(None),
                        recruiter_id: list[uuid.UUID] | None = Query(None), _: CurrentUser = VIEW):
    stmt = select(Recruit).where(Recruit.deleted_at.is_(None))
    stmt = apply_search(stmt, params.q, [Recruit.full_name, Recruit.email, Recruit.current_brokerage,
                                         Recruit.specialty])
    stmt = in_filter(in_filter(stmt, Recruit.stage, stage), Recruit.recruiter_id, recruiter_id)
    stmt = apply_sort(stmt, params.sort, {"full_name": Recruit.full_name, "stage": Recruit.stage,
                                          "annual_production": Recruit.annual_production,
                                          "next_action_at": Recruit.next_action_at,
                                          "updated_at": Recruit.updated_at}, Recruit.updated_at.desc())
    rows, total = await paginate(db, stmt, params)
    return page_of(RecruitOut, await service.recruit_outs(db, rows), total, params)


@router.post("/recruits", response_model=RecruitOut, status_code=201)
async def create_recruit(body: RecruitBase, db: DB, user: CurrentUser = CREATE):
    return (await service.recruit_outs(db, [await service.create_recruit(db, body, user)]))[0]


@router.get("/recruits/{recruit_id}", response_model=RecruitOut)
async def get_recruit(recruit_id: uuid.UUID, db: DB, _: CurrentUser = VIEW):
    return (await service.recruit_outs(db, [await service.get_or_404(db, Recruit, recruit_id, "Recruit")]))[0]


@router.patch("/recruits/{recruit_id}", response_model=RecruitOut)
async def update_recruit(recruit_id: uuid.UUID, body: RecruitUpdate, db: DB, user: CurrentUser = EDIT):
    r = await service.get_or_404(db, Recruit, recruit_id, "Recruit")
    values = {k: v for k, v in body.model_dump(exclude_unset=True).items() if not (k == "full_name" and not v)}
    await service.patch_row(db, r, "recruit", values, user)
    await db.commit()
    return (await service.recruit_outs(db, [r]))[0]


@router.post("/recruits/{recruit_id}/move", response_model=RecruitOut)
async def move_recruit(recruit_id: uuid.UUID, body: StageMoveIn, db: DB, user: CurrentUser = EDIT):
    r = await service.move_recruit(db, await service.get_or_404(db, Recruit, recruit_id, "Recruit"), body, user)
    return (await service.recruit_outs(db, [r]))[0]


@router.post("/recruits/{recruit_id}/checklist/{key}", response_model=RecruitOut)
async def toggle_checklist(recruit_id: uuid.UUID, key: str, body: ChecklistToggleIn, db: DB,
                           user: CurrentUser = EDIT):
    r = await service.get_or_404(db, Recruit, recruit_id, "Recruit")
    r = await service.toggle_checklist(db, r, key, body.done, body.note, user)
    return (await service.recruit_outs(db, [r]))[0]


@router.delete("/recruits/{recruit_id}", status_code=204)
async def archive_recruit(recruit_id: uuid.UUID, db: DB, user: CurrentUser = DELETE):
    await service.archive_row(db, await service.get_or_404(db, Recruit, recruit_id, "Recruit"), "recruit", user)
