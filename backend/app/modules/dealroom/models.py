"""Tours, deal rooms & brokerage compliance (spec module 26)."""
import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

TOUR_STATUSES = ["planned", "confirmed", "completed", "cancelled"]
STOP_STATUSES = ["planned", "visited", "skipped"]
INTEREST_LEVELS = ["none", "low", "medium", "high"]
NDA_STATUSES = ["not_sent", "sent", "signed", "declined", "expired"]
ROOM_STATUSES = ["draft", "open", "closed", "archived"]
ACCESS_STATUSES = ["active", "revoked", "expired"]
ACCESS_ACTIONS = ["view_room", "view_folder", "view", "download", "denied", "submit_offer"]
OFFER_STATUSES = ["submitted", "under_review", "shortlisted", "countered", "accepted", "rejected", "withdrawn"]
FINANCING_TYPES = ["cash", "conventional", "sba", "seller_financing", "assumption", "other"]
LICENSE_TYPES = ["salesperson", "broker", "broker_associate", "managing_broker", "firm"]
LICENSE_STATUSES = ["active", "pending_renewal", "expired", "suspended", "inactive"]
DISCLOSURE_TYPES = ["agency", "dual_agency", "intermediary", "seller_property_condition", "lead_paint",
                    "environmental", "material_defect", "affiliated_business", "other"]
# Types that need a signed acknowledgement from the recipient, not just delivery.
ACK_REQUIRED_TYPES = {"dual_agency", "intermediary"}
DISCLOSURE_STATUSES = ["required", "delivered", "acknowledged", "waived"]
DELIVERY_METHODS = ["email", "in_person", "portal", "mail", "e_sign"]
AD_REVIEW_STATUSES = ["pending", "approved", "rejected", "changes_requested"]
AD_CHECKLIST = [
    ("broker_identified", "Brokerage name and license shown as required"),
    ("accurate_facts", "Property facts and price match the listing record"),
    ("fair_housing", "Fair housing / non-discrimination language reviewed"),
    ("seller_consent", "Seller consent to advertise on file"),
    ("no_misleading_claims", "No misleading or unverifiable claims"),
]
FILE_ITEM_STATUSES = ["missing", "provided", "approved", "waived", "rejected"]
FILE_CATEGORIES = ["agreement", "disclosure", "contract", "compliance", "closing", "financial", "other"]


class Tour(Entity, Base):
    __tablename__ = "tours"

    title: Mapped[str] = mapped_column(String(255))
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    client_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    client_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    brokerage_deal_id: Mapped[uuid.UUID | None] = fk("brokerage_deals")
    requirement_id: Mapped[uuid.UUID | None] = fk("requirement_profiles")
    scheduled_on: Mapped[date] = mapped_column(Date, index=True)
    start_time: Mapped[str | None] = mapped_column(String(5))  # HH:MM local
    status: Mapped[str] = mapped_column(String(20), default="planned", index=True)
    start_label: Mapped[str | None] = mapped_column(String(255))
    start_lat: Mapped[float | None] = mapped_column(Float)
    start_lng: Mapped[float | None] = mapped_column(Float)
    total_distance_miles: Mapped[float | None] = mapped_column(Float)
    optimized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # [{kind: user|person|organization|external, id, name, email, role}]
    participants: Mapped[list] = mapped_column(JSONB, default=list)
    notes: Mapped[str | None] = mapped_column(Text)


class TourStop(Entity, Base):
    __tablename__ = "tour_stops"

    tour_id: Mapped[uuid.UUID] = fk("tours", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False)
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    arrive_time: Mapped[str | None] = mapped_column(String(5))
    duration_minutes: Mapped[int] = mapped_column(Integer, default=30)
    distance_from_prev_miles: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default="planned")
    access_notes: Mapped[str | None] = mapped_column(Text)


class TourFeedback(Entity, Base):
    __tablename__ = "tour_feedback"

    tour_id: Mapped[uuid.UUID] = fk("tours", nullable=False, ondelete="CASCADE")
    stop_id: Mapped[uuid.UUID | None] = fk("tour_stops")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    listing_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    rating: Mapped[int | None] = mapped_column(Integer)
    interest_level: Mapped[str | None] = mapped_column(String(10))
    feedback: Mapped[str | None] = mapped_column(Text)
    objections: Mapped[str | None] = mapped_column(Text)
    next_action: Mapped[str | None] = mapped_column(String(300))
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    follow_up_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    showing_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Nda(Entity, Base):
    """Confidentiality agreement status per counterparty."""

    __tablename__ = "ndas"

    counterparty_kind: Mapped[str] = mapped_column(String(15), default="person")
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    deal_room_id: Mapped[uuid.UUID | None] = fk("deal_rooms")
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    brokerage_deal_id: Mapped[uuid.UUID | None] = fk("brokerage_deals")
    status: Mapped[str] = mapped_column(String(15), default="not_sent", index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_on: Mapped[date | None] = mapped_column(Date)
    signer_name: Mapped[str | None] = mapped_column(String(200))
    signer_email: Mapped[str | None] = mapped_column(String(255))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class DealRoom(Entity, Base):
    __tablename__ = "deal_rooms"

    name: Mapped[str] = mapped_column(String(255))
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    brokerage_deal_id: Mapped[uuid.UUID | None] = fk("brokerage_deals")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(15), default="draft", index=True)
    requires_nda: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_offers: Mapped[bool] = mapped_column(Boolean, default=True)
    offer_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    description: Mapped[str | None] = mapped_column(Text)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DealRoomFolder(Entity, Base):
    __tablename__ = "deal_room_folders"

    room_id: Mapped[uuid.UUID] = fk("deal_rooms", nullable=False, ondelete="CASCADE")
    name: Mapped[str] = mapped_column(String(200))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_restricted: Mapped[bool] = mapped_column(Boolean, default=False)
    document_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)


class DealRoomAccess(Entity, Base):
    """Counterparty access grant. Empty folder_ids = every non-restricted folder."""

    __tablename__ = "deal_room_access"

    room_id: Mapped[uuid.UUID] = fk("deal_rooms", nullable=False, ondelete="CASCADE")
    grantee_kind: Mapped[str] = mapped_column(String(15), default="person")
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    user_id: Mapped[uuid.UUID | None] = fk("users")
    email: Mapped[str | None] = mapped_column(String(255))
    folder_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)
    can_download: Mapped[bool] = mapped_column(Boolean, default=False)
    can_submit_offers: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(10), default="active", index=True)
    nda_id: Mapped[uuid.UUID | None] = fk("ndas")
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    last_accessed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DealRoomAccessLog(UUIDPk, Base):
    """Every view/download (and denial) in a deal room. Append-only."""

    __tablename__ = "deal_room_access_log"

    room_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("deal_rooms.id", ondelete="CASCADE"),
                                               index=True)
    access_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    folder_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    action: Mapped[str] = mapped_column(String(20), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_name: Mapped[str | None] = mapped_column(String(200))
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False)
    detail: Mapped[str | None] = mapped_column(Text)
    ip_address: Mapped[str | None] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class OfferSubmission(Entity, Base):
    """Structured offer submitted through a deal room; internal users review it."""

    __tablename__ = "offer_submissions"

    room_id: Mapped[uuid.UUID | None] = fk("deal_rooms")
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    brokerage_deal_id: Mapped[uuid.UUID | None] = fk("brokerage_deals")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    access_id: Mapped[uuid.UUID | None] = fk("deal_room_access")
    submitter_user_id: Mapped[uuid.UUID | None] = fk("users")
    submitter_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    submitter_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    submitter_name: Mapped[str | None] = mapped_column(String(200))
    submitter_email: Mapped[str | None] = mapped_column(String(255))
    buyer_entity: Mapped[str | None] = mapped_column(String(255))
    version: Mapped[int] = mapped_column(Integer, default=1)
    parent_submission_id: Mapped[uuid.UUID | None] = fk("offer_submissions")
    price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    earnest_money: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    due_diligence_days: Mapped[int | None] = mapped_column(Integer)
    closing_days: Mapped[int | None] = mapped_column(Integer)
    financing_type: Mapped[str | None] = mapped_column(String(30))
    contingencies: Mapped[list[str]] = mapped_column(ARRAY(String(120)), default=list)
    terms: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(20), default="submitted", index=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    reviewed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_notes: Mapped[str | None] = mapped_column(Text)


class AgentLicense(Entity, Base):
    __tablename__ = "agent_licenses"

    user_id: Mapped[uuid.UUID | None] = fk("users")
    holder_name: Mapped[str] = mapped_column(String(200))
    license_type: Mapped[str] = mapped_column(String(20), default="salesperson")
    license_number: Mapped[str] = mapped_column(String(60), index=True)
    state: Mapped[str] = mapped_column(String(40), index=True)
    issued_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    ce_hours_required: Mapped[float | None] = mapped_column(Float)
    ce_hours_completed: Mapped[float | None] = mapped_column(Float)
    sponsoring_broker: Mapped[str | None] = mapped_column(String(200))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_alerted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class Disclosure(Entity, Base):
    """Required disclosure with delivery evidence; dual-agency / intermediary also need acknowledgement."""

    __tablename__ = "disclosures"

    brokerage_deal_id: Mapped[uuid.UUID | None] = fk("brokerage_deals")
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    disclosure_type: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(255))
    recipient_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    recipient_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    recipient_name: Mapped[str | None] = mapped_column(String(200))
    due_on: Mapped[date | None] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(15), default="required", index=True)
    is_blocking: Mapped[bool] = mapped_column(Boolean, default=True)
    requires_acknowledgement: Mapped[bool] = mapped_column(Boolean, default=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivery_method: Mapped[str | None] = mapped_column(String(15))
    evidence_document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    evidence_note: Mapped[str | None] = mapped_column(Text)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_by_name: Mapped[str | None] = mapped_column(String(200))
    acknowledgement_document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    waived_reason: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class AdReview(Entity, Base):
    __tablename__ = "ad_reviews"

    title: Mapped[str] = mapped_column(String(255))
    listing_id: Mapped[uuid.UUID | None] = fk("listings")
    marketing_item_id: Mapped[uuid.UUID | None] = fk("marketing_items")
    brokerage_deal_id: Mapped[uuid.UUID | None] = fk("brokerage_deals")
    channel: Mapped[str | None] = mapped_column(String(40))
    content_summary: Mapped[str | None] = mapped_column(Text)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    submitted_by_id: Mapped[uuid.UUID | None] = fk("users")
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    checklist: Mapped[list] = mapped_column(JSONB, default=list)
    reviewer_id: Mapped[uuid.UUID | None] = fk("users")
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_notes: Mapped[str | None] = mapped_column(Text)


class TransactionFile(Entity, Base):
    __tablename__ = "transaction_files"
    __table_args__ = (UniqueConstraint("brokerage_deal_id", name="uq_transaction_file_deal"),)

    brokerage_deal_id: Mapped[uuid.UUID] = fk("brokerage_deals", nullable=False)
    template_key: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(15), default="open", index=True)  # open | complete | approved
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class TransactionFileItem(Entity, Base):
    __tablename__ = "transaction_file_items"

    file_id: Mapped[uuid.UUID] = fk("transaction_files", nullable=False, ondelete="CASCADE")
    key: Mapped[str] = mapped_column(String(60))
    label: Mapped[str] = mapped_column(String(255))
    category: Mapped[str] = mapped_column(String(20), default="other")
    is_required: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(15), default="missing", index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    evidence_note: Mapped[str | None] = mapped_column(Text)
    linked_type: Mapped[str | None] = mapped_column(String(40))
    linked_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    reviewed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    waived_reason: Mapped[str | None] = mapped_column(Text)
