import copy
import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model

ProspectStage = Literal["prospect", "pitched", "engaged", "lost"]
MarketStatus = Literal["not_listed", "competitor_listed", "expiring", "expired", "withdrawn", "off_market"]
Exclusivity = Literal["exclusive_right", "exclusive_agency", "open", "non_exclusive"]
CommissionStructure = Literal["percent", "flat", "tiered"]
AgreementStatus = Literal["draft", "active", "expired", "terminated"]
ListingType = Literal["sale", "lease"]
ListingStatus = Literal["draft", "coming_soon", "active", "under_contract", "sold", "leased", "withdrawn", "expired"]
Cadence = Literal["none", "weekly", "biweekly", "monthly"]
DealSide = Literal["listing", "buyer", "tenant", "landlord", "dual"]
DealStage = Literal["lead", "engaged", "marketing", "touring", "negotiation", "under_contract", "closing", "closed",
                    "lost"]
RecruitStage = Literal["lead", "contacted", "interviewing", "offer", "hired", "onboarding", "active", "declined", "lost"]


def partial(model: type[BaseModel], name: str) -> type[BaseModel]:
    """Same fields as `model`, all optional (PATCH bodies). Unknown keys are rejected."""
    fields: dict[str, Any] = {}
    for key, f in model.model_fields.items():
        fi = copy.copy(f)
        fi.default, fi.default_factory = None, None
        fi.metadata = list(f.metadata)
        if isinstance(getattr(fi, "_attributes_set", None), dict):
            attrs = {k: v for k, v in fi._attributes_set.items() if k != "default_factory"}
            attrs["default"] = None
            fi._attributes_set = attrs
        fields[key] = (f.annotation | None, fi)  # type: ignore[operator]
    return create_model(name, __config__=ConfigDict(extra="forbid"), **fields)


class Labels(BaseModel):
    """Display labels resolved server-side for linked master records."""

    property_label: str | None = None
    agent_name: str | None = None
    person_label: str | None = None
    organization_label: str | None = None


class StageMoveIn(BaseModel):
    to_stage: str = Field(min_length=1, max_length=30)
    reason: str | None = Field(default=None, max_length=2000)
    lost_reason: str | None = Field(default=None, max_length=200)


class StatusEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    from_status: str | None
    to_status: str
    reason: str | None
    actor_name: str | None
    at: datetime


# ------------------------------------------------------------------ prospects & pitches

class ProspectBase(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    property_id: uuid.UUID | None = None
    owner_person_id: uuid.UUID | None = None
    owner_organization_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    source: str | None = Field(default=None, max_length=80)
    market_status: MarketStatus = "not_listed"
    competitor_broker: str | None = Field(default=None, max_length=200)
    competitor_list_price: float | None = Field(default=None, ge=0)
    competitor_listed_on: date | None = None
    competitor_expires_on: date | None = None
    estimated_value: float | None = Field(default=None, ge=0)
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None
    notes: str | None = None
    tags: list[str] = []


ProspectUpdate = partial(ProspectBase, "ProspectUpdate")


class ProspectOut(ProspectBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    title: str
    stage: str
    stage_entered_at: datetime
    lost_reason: str | None
    listing_id: uuid.UUID | None
    pitch_count: int = 0
    last_pitched_on: date | None = None
    days_to_competitor_expiry: int | None = None
    created_at: datetime
    updated_at: datetime


class ProspectFacets(BaseModel):
    stage: dict[str, int]
    market_status: dict[str, int]
    agent_id: dict[str, int]


class PitchIn(BaseModel):
    kind: Literal["pitch", "bov"] = "pitch"
    pitched_on: date | None = None
    bov_id: uuid.UUID | None = None
    comp_set_id: uuid.UUID | None = None
    value_low: float | None = Field(default=None, ge=0)
    value_point: float | None = Field(default=None, ge=0)
    value_high: float | None = Field(default=None, ge=0)
    recommended_price: float | None = Field(default=None, ge=0)
    proposed_commission_rate: float | None = Field(default=None, ge=0, le=100)
    outcome: Literal["pending", "won", "lost", "no_decision"] = "pending"
    document_id: uuid.UUID | None = None
    notes: str | None = None


PitchUpdate = partial(PitchIn, "PitchUpdate")


class PitchOut(PitchIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    prospect_id: uuid.UUID
    pitched_on: date
    valuation_method: str | None
    valuation_as_of: date | None
    created_at: datetime
    created_by_id: uuid.UUID | None


class ConvertIn(BaseModel):
    """Convert an engaged prospect to a listing (creates the listing and links the engagement)."""

    listing_type: ListingType = "sale"
    asking_price: float | None = Field(default=None, ge=0)
    asking_rent_psf: float | None = Field(default=None, ge=0)
    listed_on: date | None = None
    expires_on: date | None = None
    engagement_agreement_id: uuid.UUID | None = None


# ------------------------------------------------------------------ agreements

class EngagementBase(BaseModel):
    prospect_id: uuid.UUID | None = None
    listing_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    client_person_id: uuid.UUID | None = None
    client_organization_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    status: AgreementStatus = "draft"
    exclusivity: Exclusivity = "exclusive_right"
    starts_on: date | None = None
    expires_on: date | None = None
    term_months: int | None = Field(default=None, ge=1, le=600)
    commission_structure: CommissionStructure = "percent"
    commission_rate: float | None = Field(default=None, ge=0, le=100)
    commission_flat: float | None = Field(default=None, ge=0)
    commission_tiers: list[dict[str, Any]] = []
    cobroker_rate: float | None = Field(default=None, ge=0, le=100)
    tail_days: int | None = Field(default=None, ge=0, le=3650)
    signed_on: date | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


EngagementUpdate = partial(EngagementBase, "EngagementUpdate")


class EngagementOut(EngagementBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    critical_date_id: uuid.UUID | None
    days_to_expiry: int | None = None
    created_at: datetime
    updated_at: datetime


class RepAgreementBase(BaseModel):
    kind: Literal["buyer", "tenant"] = "buyer"
    client_person_id: uuid.UUID | None = None
    client_organization_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    status: AgreementStatus = "draft"
    exclusivity: Exclusivity = "exclusive_right"
    starts_on: date | None = None
    expires_on: date | None = None
    territory: str | None = Field(default=None, max_length=200)
    commission_structure: CommissionStructure = "percent"
    commission_rate: float | None = Field(default=None, ge=0, le=100)
    commission_flat: float | None = Field(default=None, ge=0)
    signed_on: date | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


RepAgreementUpdate = partial(RepAgreementBase, "RepAgreementUpdate")


class RepAgreementOut(RepAgreementBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    critical_date_id: uuid.UUID | None
    days_to_expiry: int | None = None
    created_at: datetime
    updated_at: datetime


# ------------------------------------------------------------------ listings

class ListingBase(BaseModel):
    property_id: uuid.UUID
    prospect_id: uuid.UUID | None = None
    engagement_agreement_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    seller_person_id: uuid.UUID | None = None
    seller_organization_id: uuid.UUID | None = None
    listing_type: ListingType = "sale"
    cap_rate: float | None = Field(default=None, ge=0, le=100)
    listed_on: date | None = None
    expires_on: date | None = None
    headline: str | None = Field(default=None, max_length=300)
    description: str | None = None
    highlights: list[str] = []
    reporting_cadence: Cadence = "biweekly"
    next_report_on: date | None = None
    notes: str | None = None
    tags: list[str] = []


class ListingCreate(ListingBase):
    status: ListingStatus = "draft"
    asking_price: float | None = Field(default=None, ge=0)
    asking_rent_psf: float | None = Field(default=None, ge=0)


class _ListingEditable(BaseModel):
    agent_id: uuid.UUID | None = None
    engagement_agreement_id: uuid.UUID | None = None
    seller_person_id: uuid.UUID | None = None
    seller_organization_id: uuid.UUID | None = None
    listing_type: ListingType = "sale"
    cap_rate: float | None = Field(default=None, ge=0, le=100)
    listed_on: date | None = None
    expires_on: date | None = None
    closed_on: date | None = None
    closed_price: float | None = Field(default=None, ge=0)
    headline: str | None = Field(default=None, max_length=300)
    description: str | None = None
    highlights: list[str] = []
    reporting_cadence: Cadence = "biweekly"
    next_report_on: date | None = None
    deal_room_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] = []


# Price and status are changed only through their dedicated endpoints so history is always written.
ListingUpdate = partial(_ListingEditable, "ListingUpdate")


class ListingOut(ListingBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    status: str
    status_changed_at: datetime
    asking_price: float | None
    asking_rent_psf: float | None
    closed_on: date | None
    closed_price: float | None
    deal_room_id: uuid.UUID | None
    property_city: str | None = None
    property_state: str | None = None
    property_type: str | None = None
    days_on_market: int | None = None
    price_change_count: int = 0
    inquiry_count: int = 0
    showing_count: int = 0
    created_at: datetime
    updated_at: datetime


class ListingFacets(BaseModel):
    status: dict[str, int]
    listing_type: dict[str, int]
    agent_id: dict[str, int]


class PriceChangeIn(BaseModel):
    asking_price: float | None = Field(default=None, ge=0)
    asking_rent_psf: float | None = Field(default=None, ge=0)
    effective_on: date | None = None
    reason: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="Manual entry", max_length=120)


class PriceHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    listing_id: uuid.UUID
    price: float | None
    previous_price: float | None
    rent_psf: float | None
    effective_on: date
    reason: str | None
    source: str
    actor_name: str | None
    at: datetime


class StatusChangeIn(BaseModel):
    status: ListingStatus
    reason: str | None = Field(default=None, max_length=2000)
    closed_on: date | None = None
    closed_price: float | None = Field(default=None, ge=0)


class MarketingBase(BaseModel):
    kind: Literal["offering_memorandum", "flyer", "brochure", "email_campaign", "signage", "photography", "video",
                  "website", "other"] = "flyer"
    title: str = Field(min_length=1, max_length=255)
    status: Literal["draft", "in_review", "approved", "published", "retired"] = "draft"
    channels: list[str] = []
    syndication_status: Literal["not_syndicated", "pending", "live", "paused", "removed", "error"] = "not_syndicated"
    external_url: str | None = Field(default=None, max_length=500)
    document_ids: list[uuid.UUID] = []
    notes: str | None = None


MarketingUpdate = partial(MarketingBase, "MarketingUpdate")


class MarketingOut(MarketingBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    listing_id: uuid.UUID
    syndicated_at: datetime | None
    ad_review_status: str | None = None
    created_at: datetime
    updated_at: datetime


class InquiryBase(BaseModel):
    listing_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    contact_name: str | None = Field(default=None, max_length=200)
    contact_email: str | None = Field(default=None, max_length=255)
    contact_phone: str | None = Field(default=None, max_length=40)
    source: str = Field(default="other", max_length=30)
    received_at: datetime | None = None
    status: Literal["new", "contacted", "qualified", "nda_sent", "toured", "offer", "dead"] = "new"
    message: str | None = None
    assigned_to_id: uuid.UUID | None = None
    follow_up_at: datetime | None = None
    notes: str | None = None


InquiryUpdate = partial(InquiryBase, "InquiryUpdate")


class InquiryOut(InquiryBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    received_at: datetime
    follow_up_task_id: uuid.UUID | None
    assigned_name: str | None = None
    created_at: datetime


class ShowingBase(BaseModel):
    listing_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    inquiry_id: uuid.UUID | None = None
    tour_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    contact_name: str | None = Field(default=None, max_length=200)
    scheduled_at: datetime
    shown_by_id: uuid.UUID | None = None
    status: Literal["scheduled", "completed", "cancelled", "no_show"] = "scheduled"
    interest_level: Literal["none", "low", "medium", "high"] | None = None
    feedback: str | None = None
    notes: str | None = None


ShowingUpdate = partial(ShowingBase, "ShowingUpdate")


class ShowingOut(ShowingBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    shown_by_name: str | None = None
    created_at: datetime


class SellerReportGenerateIn(BaseModel):
    period_start: date | None = None
    period_end: date | None = None
    commentary: str | None = None


class SellerReportUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commentary: str | None = None
    status: Literal["draft", "sent"] | None = None
    sent_to: str | None = Field(default=None, max_length=300)


class SellerReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    listing_id: uuid.UUID
    period_start: date
    period_end: date
    generated_at: datetime
    summary: dict
    commentary: str | None
    status: str
    sent_at: datetime | None
    sent_to: str | None


# ------------------------------------------------------------------ requirements, proposals

class RequirementBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    rep_agreement_id: uuid.UUID | None = None
    client_person_id: uuid.UUID | None = None
    client_organization_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    side: Literal["buyer", "tenant"] = "buyer"
    status: Literal["active", "paused", "fulfilled", "closed"] = "active"
    property_types: list[str] = []
    min_size_sf: float | None = Field(default=None, ge=0)
    max_size_sf: float | None = Field(default=None, ge=0)
    min_acres: float | None = Field(default=None, ge=0)
    max_acres: float | None = Field(default=None, ge=0)
    min_price: float | None = Field(default=None, ge=0)
    max_price: float | None = Field(default=None, ge=0)
    states: list[str] = []
    cities: list[str] = []
    counties: list[str] = []
    territory_id: uuid.UUID | None = None
    near_lat: float | None = Field(default=None, ge=-90, le=90)
    near_lng: float | None = Field(default=None, ge=-180, le=180)
    radius_miles: float | None = Field(default=None, gt=0, le=200)
    features: list[str] = []
    notes: str | None = None


RequirementUpdate = partial(RequirementBase, "RequirementUpdate")


class RequirementOut(RequirementBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    last_matched_at: datetime | None
    match_count: int = 0
    created_at: datetime
    updated_at: datetime


class MatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    requirement_id: uuid.UUID
    property_id: uuid.UUID
    listing_id: uuid.UUID | None
    status: str
    matched_at: datetime
    criteria_met: list
    notes: str | None
    property_label: str | None = None
    property_city: str | None = None
    property_state: str | None = None
    property_type: str | None = None
    building_area_sf: float | None = None
    asking_price: float | None = None


class MatchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["suggested", "sent", "interested", "toured", "rejected", "offer"] | None = None
    notes: str | None = None


class MatchRunOut(BaseModel):
    added: int
    total: int
    criteria: dict


class ProposalBase(BaseModel):
    kind: Literal["listing_proposal", "purchase_proposal", "lease_proposal", "buyer_proposal",
                  "tenant_proposal"] = "listing_proposal"
    title: str = Field(min_length=1, max_length=255)
    brokerage_deal_id: uuid.UUID | None = None
    prospect_id: uuid.UUID | None = None
    listing_id: uuid.UUID | None = None
    requirement_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    recipient_person_id: uuid.UUID | None = None
    recipient_organization_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None
    status: Literal["draft", "sent", "countered", "accepted", "rejected", "withdrawn", "superseded"] = "draft"
    price: float | None = Field(default=None, ge=0)
    rent_psf: float | None = Field(default=None, ge=0)
    term_months: int | None = Field(default=None, ge=1, le=600)
    commission_rate: float | None = Field(default=None, ge=0, le=100)
    terms: str | None = None
    sent_on: date | None = None
    response_due_on: date | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


ProposalUpdate = partial(ProposalBase, "ProposalUpdate")


class ProposalOut(ProposalBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    version: int
    parent_proposal_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


# ------------------------------------------------------------------ deals

class DealBase(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    agent_id: uuid.UUID | None = None
    side: DealSide = "listing"
    property_id: uuid.UUID | None = None
    listing_id: uuid.UUID | None = None
    rep_agreement_id: uuid.UUID | None = None
    requirement_id: uuid.UUID | None = None
    client_person_id: uuid.UUID | None = None
    client_organization_id: uuid.UUID | None = None
    counterparty_person_id: uuid.UUID | None = None
    counterparty_organization_id: uuid.UUID | None = None
    is_dual_rep: bool = False
    expected_close_on: date | None = None
    probability: float | None = Field(default=None, ge=0, le=100)
    deal_value: float | None = Field(default=None, ge=0)
    commission_rate: float | None = Field(default=None, ge=0, le=100)
    gross_commission_estimate: float | None = Field(default=None, ge=0)
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None
    notes: str | None = None
    tags: list[str] = []


class _DealEditable(DealBase):
    closed_on: date | None = None
    closed_price: float | None = Field(default=None, ge=0)


DealUpdate = partial(_DealEditable, "DealUpdate")


class DealOut(DealBase, Labels):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    title: str
    stage: str
    stage_entered_at: datetime
    closed_on: date | None
    closed_price: float | None
    lost_reason: str | None
    effective_probability: float = 0
    weighted_commission: float | None = None
    file_complete: bool | None = None
    created_at: datetime
    updated_at: datetime


class DealFacets(BaseModel):
    stage: dict[str, int]
    side: dict[str, int]
    agent_id: dict[str, int]


class DealBoardColumn(BaseModel):
    stage: str
    count: int
    gross_commission: float
    weighted_commission: float
    items: list[DealOut]


# ------------------------------------------------------------------ recruits

class RecruitBase(BaseModel):
    full_name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=40)
    person_id: uuid.UUID | None = None
    current_brokerage: str | None = Field(default=None, max_length=200)
    specialty: str | None = Field(default=None, max_length=120)
    years_experience: float | None = Field(default=None, ge=0, le=80)
    annual_production: float | None = Field(default=None, ge=0)
    license_number: str | None = Field(default=None, max_length=60)
    license_state: str | None = Field(default=None, max_length=40)
    source: str | None = Field(default=None, max_length=80)
    recruiter_id: uuid.UUID | None = None
    next_action_at: datetime | None = None
    start_on: date | None = None
    user_id: uuid.UUID | None = None
    notes: str | None = None


RecruitUpdate = partial(RecruitBase, "RecruitUpdate")


class RecruitOut(RecruitBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    stage: str
    stage_entered_at: datetime
    onboarding: list
    onboarding_pct: float = 0
    recruiter_name: str | None = None
    created_at: datetime
    updated_at: datetime


class ChecklistToggleIn(BaseModel):
    done: bool
    note: str | None = Field(default=None, max_length=500)


# ------------------------------------------------------------------ workspace

class WorkspaceOut(BaseModel):
    agent_id: uuid.UUID | None
    prospects_by_stage: dict[str, int]
    listings_by_status: dict[str, int]
    deals_by_stage: dict[str, int]
    pipeline_gross: float
    pipeline_weighted: float
    expected_close_90d: float
    expiring_agreements: int
    open_inquiries: int
    upcoming_showings: int
    overdue_actions: int


class DocOption(BaseModel):
    id: uuid.UUID
    title: str
    filename: str | None = None
    doc_class: str | None = None
