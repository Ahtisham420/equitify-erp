"""Brokerage CRM & listing management (spec module 25).

Brokerage shares master data (properties, people, organizations, comps) with acquisitions but keeps its
own workflow tables and permission key (`brokerage`). Cross-module ids are plain UUID columns.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

PROSPECT_STAGES = ["prospect", "pitched", "engaged", "lost"]
MARKET_STATUSES = ["not_listed", "competitor_listed", "expiring", "expired", "withdrawn", "off_market"]
LOST_REASONS = ["chose_competitor", "not_selling", "price_expectation", "fee", "timing", "relationship", "other"]
PITCH_KINDS = ["pitch", "bov"]
PITCH_OUTCOMES = ["pending", "won", "lost", "no_decision"]

EXCLUSIVITY = ["exclusive_right", "exclusive_agency", "open", "non_exclusive"]
COMMISSION_STRUCTURES = ["percent", "flat", "tiered"]
AGREEMENT_STATUSES = ["draft", "active", "expired", "terminated"]

LISTING_TYPES = ["sale", "lease"]
LISTING_STATUSES = ["draft", "coming_soon", "active", "under_contract", "sold", "leased", "withdrawn", "expired"]
LIVE_LISTING_STATUSES = ["coming_soon", "active", "under_contract"]
REPORT_CADENCES = ["none", "weekly", "biweekly", "monthly"]
CADENCE_DAYS = {"weekly": 7, "biweekly": 14, "monthly": 30}

MARKETING_KINDS = ["offering_memorandum", "flyer", "brochure", "email_campaign", "signage", "photography", "video",
                   "website", "other"]
MARKETING_STATUSES = ["draft", "in_review", "approved", "published", "retired"]
SYNDICATION_CHANNELS = ["loopnet", "costar", "crexi", "company_website", "mls", "email", "social", "other"]
SYNDICATION_STATUSES = ["not_syndicated", "pending", "live", "paused", "removed", "error"]

INQUIRY_SOURCES = ["website", "loopnet", "costar", "crexi", "sign_call", "email_campaign", "referral", "cold_call",
                   "broker", "other"]
INQUIRY_STATUSES = ["new", "contacted", "qualified", "nda_sent", "toured", "offer", "dead"]
SHOWING_STATUSES = ["scheduled", "completed", "cancelled", "no_show"]
INTEREST_LEVELS = ["none", "low", "medium", "high"]

REP_KINDS = ["buyer", "tenant"]
REQUIREMENT_STATUSES = ["active", "paused", "fulfilled", "closed"]
MATCH_STATUSES = ["suggested", "sent", "interested", "toured", "rejected", "offer"]

PROPOSAL_KINDS = ["listing_proposal", "purchase_proposal", "lease_proposal", "buyer_proposal", "tenant_proposal"]
PROPOSAL_STATUSES = ["draft", "sent", "countered", "accepted", "rejected", "withdrawn", "superseded"]

DEAL_SIDES = ["listing", "buyer", "tenant", "landlord", "dual"]
DEAL_STAGES = ["lead", "engaged", "marketing", "touring", "negotiation", "under_contract", "closing", "closed", "lost"]
ACTIVE_DEAL_STAGES = DEAL_STAGES[:7]
# Default win probability per stage; agents can override on the deal.
STAGE_PROBABILITY = {"lead": 10, "engaged": 25, "marketing": 35, "touring": 40, "negotiation": 55,
                     "under_contract": 80, "closing": 90, "closed": 100, "lost": 0}

RECRUIT_STAGES = ["lead", "contacted", "interviewing", "offer", "hired", "onboarding", "active", "declined", "lost"]
ONBOARDING_TEMPLATE = [
    ("license_verified", "License verified with state"),
    ("agreement_signed", "Independent contractor / employment agreement signed"),
    ("w9", "W-9 / tax documents collected"),
    ("eo_insurance", "E&O insurance confirmed"),
    ("system_access", "System account created"),
    ("compliance_training", "Brokerage compliance training completed"),
    ("mls_access", "MLS / listing platform access"),
    ("marketing_profile", "Marketing bio and photo"),
]


class ListingProspect(Entity, Base):
    """An owner relationship being pursued for a listing (prospect → pitched → engaged | lost)."""

    __tablename__ = "listing_prospects"

    title: Mapped[str] = mapped_column(String(255))
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    owner_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    owner_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    stage: Mapped[str] = mapped_column(String(20), default="prospect", index=True)
    stage_entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    source: Mapped[str | None] = mapped_column(String(80), index=True)
    # Expiring / competitor listing tracking
    market_status: Mapped[str] = mapped_column(String(30), default="not_listed", index=True)
    competitor_broker: Mapped[str | None] = mapped_column(String(200))
    competitor_list_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    competitor_listed_on: Mapped[date | None] = mapped_column(Date)
    competitor_expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    estimated_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    next_action: Mapped[str | None] = mapped_column(String(300))
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    lost_reason: Mapped[str | None] = mapped_column(String(40))
    listing_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class ProspectPitch(Entity, Base):
    """Pitch history. A BOV pitch references a comps valuation (`bov_id`) built from verified comparables."""

    __tablename__ = "prospect_pitches"

    prospect_id: Mapped[uuid.UUID] = fk("listing_prospects", nullable=False, ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(10), default="pitch")
    pitched_on: Mapped[date] = mapped_column(Date)
    bov_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    comp_set_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    value_low: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_point: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_high: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    valuation_method: Mapped[str | None] = mapped_column(String(40))
    valuation_as_of: Mapped[date | None] = mapped_column(Date)
    recommended_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    proposed_commission_rate: Mapped[float | None] = mapped_column(Float)
    outcome: Mapped[str] = mapped_column(String(20), default="pending")
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class BrokerageStatusEvent(UUIDPk, Base):
    """Immutable stage/status history for prospects, listings, deals and recruits."""

    __tablename__ = "brokerage_status_history"

    entity_type: Mapped[str] = mapped_column(String(30), index=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    from_status: Mapped[str | None] = mapped_column(String(30))
    to_status: Mapped[str] = mapped_column(String(30))
    reason: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class EngagementAgreement(Entity, Base):
    """Listing engagement: term, exclusivity, commission and expiration (expiration → critical date)."""

    __tablename__ = "engagement_agreements"

    prospect_id: Mapped[uuid.UUID | None] = fk("listing_prospects")
    listing_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    client_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    client_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    exclusivity: Mapped[str] = mapped_column(String(30), default="exclusive_right")
    starts_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    term_months: Mapped[int | None] = mapped_column(Integer)
    commission_structure: Mapped[str] = mapped_column(String(20), default="percent")
    commission_rate: Mapped[float | None] = mapped_column(Float)
    commission_flat: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    commission_tiers: Mapped[list] = mapped_column(JSONB, default=list)
    cobroker_rate: Mapped[float | None] = mapped_column(Float)
    tail_days: Mapped[int | None] = mapped_column(Integer)
    signed_on: Mapped[date | None] = mapped_column(Date)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class Listing(Entity, Base):
    __tablename__ = "listings"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False)
    prospect_id: Mapped[uuid.UUID | None] = fk("listing_prospects")
    engagement_agreement_id: Mapped[uuid.UUID | None] = fk("engagement_agreements")
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    seller_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    seller_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    listing_type: Mapped[str] = mapped_column(String(10), default="sale", index=True)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    status_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    asking_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    asking_rent_psf: Mapped[float | None] = mapped_column(Numeric(10, 2, asdecimal=False))
    cap_rate: Mapped[float | None] = mapped_column(Float)
    listed_on: Mapped[date | None] = mapped_column(Date, index=True)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    closed_on: Mapped[date | None] = mapped_column(Date)
    closed_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    headline: Mapped[str | None] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    highlights: Mapped[list[str]] = mapped_column(ARRAY(String(300)), default=list)
    reporting_cadence: Mapped[str] = mapped_column(String(10), default="biweekly")
    next_report_on: Mapped[date | None] = mapped_column(Date, index=True)
    deal_room_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class ListingPriceHistory(UUIDPk, Base):
    """Asking-price history. Rows are appended, never overwritten."""

    __tablename__ = "listing_price_history"

    listing_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("listings.id", ondelete="CASCADE"),
                                                  index=True)
    price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    previous_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    rent_psf: Mapped[float | None] = mapped_column(Numeric(10, 2, asdecimal=False))
    effective_on: Mapped[date] = mapped_column(Date)
    reason: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(120), default="Manual entry")
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class MarketingItem(Entity, Base):
    """Marketing material and its syndication status per channel."""

    __tablename__ = "marketing_items"

    listing_id: Mapped[uuid.UUID] = fk("listings", nullable=False, ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(30), default="flyer")
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    channels: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    syndication_status: Mapped[str] = mapped_column(String(20), default="not_syndicated", index=True)
    syndicated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    external_url: Mapped[str | None] = mapped_column(String(500))
    document_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)
    notes: Mapped[str | None] = mapped_column(Text)


class Inquiry(Entity, Base):
    __tablename__ = "inquiries"

    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    contact_name: Mapped[str | None] = mapped_column(String(200))
    contact_email: Mapped[str | None] = mapped_column(String(255))
    contact_phone: Mapped[str | None] = mapped_column(String(40))
    source: Mapped[str] = mapped_column(String(30), default="other", index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    status: Mapped[str] = mapped_column(String(20), default="new", index=True)
    message: Mapped[str | None] = mapped_column(Text)
    assigned_to_id: Mapped[uuid.UUID | None] = fk("users")
    follow_up_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    follow_up_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class Showing(Entity, Base):
    __tablename__ = "showings"

    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    inquiry_id: Mapped[uuid.UUID | None] = fk("inquiries")
    tour_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    contact_name: Mapped[str | None] = mapped_column(String(200))
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    shown_by_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="scheduled", index=True)
    interest_level: Mapped[str | None] = mapped_column(String(10))
    feedback: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class SellerReport(Entity, Base):
    """Generated seller activity report; the summary is a frozen snapshot at generation time."""

    __tablename__ = "seller_reports"

    listing_id: Mapped[uuid.UUID] = fk("listings", nullable=False, ondelete="CASCADE")
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    summary: Mapped[dict] = mapped_column(JSONB, default=dict)
    commentary: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(10), default="draft", index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_to: Mapped[str | None] = mapped_column(String(300))


class RepAgreement(Entity, Base):
    """Buyer / tenant representation agreement."""

    __tablename__ = "rep_agreements"

    kind: Mapped[str] = mapped_column(String(10), default="buyer", index=True)
    client_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    client_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    exclusivity: Mapped[str] = mapped_column(String(30), default="exclusive_right")
    starts_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    territory: Mapped[str | None] = mapped_column(String(200))
    commission_structure: Mapped[str] = mapped_column(String(20), default="percent")
    commission_rate: Mapped[float | None] = mapped_column(Float)
    commission_flat: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    signed_on: Mapped[date | None] = mapped_column(Date)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class RequirementProfile(Entity, Base):
    __tablename__ = "requirement_profiles"

    name: Mapped[str] = mapped_column(String(200))
    rep_agreement_id: Mapped[uuid.UUID | None] = fk("rep_agreements")
    client_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    client_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    side: Mapped[str] = mapped_column(String(10), default="buyer")
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    property_types: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    min_size_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    max_size_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    min_acres: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    max_acres: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    min_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    max_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    states: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    cities: Mapped[list[str]] = mapped_column(ARRAY(String(120)), default=list)
    counties: Mapped[list[str]] = mapped_column(ARRAY(String(120)), default=list)
    territory_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    near_lat: Mapped[float | None] = mapped_column(Float)
    near_lng: Mapped[float | None] = mapped_column(Float)
    radius_miles: Mapped[float | None] = mapped_column(Float)
    features: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    last_matched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class RequirementMatch(Entity, Base):
    __tablename__ = "requirement_matches"
    __table_args__ = (UniqueConstraint("requirement_id", "property_id", name="uq_requirement_match"),)

    requirement_id: Mapped[uuid.UUID] = fk("requirement_profiles", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False)
    listing_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(20), default="suggested", index=True)
    matched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    criteria_met: Mapped[list] = mapped_column(JSONB, default=list)
    notes: Mapped[str | None] = mapped_column(Text)


class Proposal(Entity, Base):
    """Proposal history: revisions create a new version and supersede the previous one."""

    __tablename__ = "proposals"

    kind: Mapped[str] = mapped_column(String(30), default="listing_proposal", index=True)
    title: Mapped[str] = mapped_column(String(255))
    version: Mapped[int] = mapped_column(Integer, default=1)
    parent_proposal_id: Mapped[uuid.UUID | None] = fk("proposals")
    brokerage_deal_id: Mapped[uuid.UUID | None] = fk("brokerage_deals")
    prospect_id: Mapped[uuid.UUID | None] = fk("listing_prospects")
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    requirement_id: Mapped[uuid.UUID | None] = fk("requirement_profiles")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    recipient_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    recipient_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    rent_psf: Mapped[float | None] = mapped_column(Numeric(10, 2, asdecimal=False))
    term_months: Mapped[int | None] = mapped_column(Integer)
    commission_rate: Mapped[float | None] = mapped_column(Float)
    terms: Mapped[str | None] = mapped_column(Text)
    sent_on: Mapped[date | None] = mapped_column(Date)
    response_due_on: Mapped[date | None] = mapped_column(Date)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class BrokerageDeal(Entity, Base):
    """Brokerage transaction workflow and the agent's personal pipeline."""

    __tablename__ = "brokerage_deals"

    title: Mapped[str] = mapped_column(String(255))
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    side: Mapped[str] = mapped_column(String(10), default="listing", index=True)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    rep_agreement_id: Mapped[uuid.UUID | None] = fk("rep_agreements")
    requirement_id: Mapped[uuid.UUID | None] = fk("requirement_profiles")
    client_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    client_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    counterparty_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    counterparty_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    is_dual_rep: Mapped[bool] = mapped_column(Boolean, default=False)
    stage: Mapped[str] = mapped_column(String(20), default="lead", index=True)
    stage_entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expected_close_on: Mapped[date | None] = mapped_column(Date, index=True)
    probability: Mapped[float | None] = mapped_column(Float)
    deal_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    commission_rate: Mapped[float | None] = mapped_column(Float)
    gross_commission_estimate: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    closed_on: Mapped[date | None] = mapped_column(Date)
    closed_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    lost_reason: Mapped[str | None] = mapped_column(String(200))
    next_action: Mapped[str | None] = mapped_column(String(300))
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class Recruit(Entity, Base):
    """Agent recruiting pipeline with an onboarding checklist once hired."""

    __tablename__ = "recruits"

    full_name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(40))
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    current_brokerage: Mapped[str | None] = mapped_column(String(200))
    specialty: Mapped[str | None] = mapped_column(String(120))
    years_experience: Mapped[float | None] = mapped_column(Float)
    annual_production: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    license_number: Mapped[str | None] = mapped_column(String(60))
    license_state: Mapped[str | None] = mapped_column(String(40))
    source: Mapped[str | None] = mapped_column(String(80))
    stage: Mapped[str] = mapped_column(String(20), default="lead", index=True)
    stage_entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    recruiter_id: Mapped[uuid.UUID | None] = fk("users")
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    start_on: Mapped[date | None] = mapped_column(Date)
    user_id: Mapped[uuid.UUID | None] = fk("users")
    onboarding: Mapped[list] = mapped_column(JSONB, default=list)
    notes: Mapped[str | None] = mapped_column(Text)
