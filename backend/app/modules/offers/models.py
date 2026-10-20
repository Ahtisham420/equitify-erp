import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

OFFER_STATUSES = [
    "draft", "pending_approval", "approved", "sent", "countered", "accepted", "rejected", "expired", "withdrawn",
]
OPEN_STATUSES = ["draft", "pending_approval", "approved", "sent", "countered"]
FINAL_STATUSES = ["accepted", "rejected", "expired", "withdrawn"]
ORIGINS = ["buyer", "seller"]  # buyer = our version; seller = counterparty counter recorded verbatim
STRUCTURES = ["all_cash", "conventional_financing", "assumption", "seller_financing", "joint_venture", "other"]
OUTCOMES = ["accepted", "countered", "rejected", "expired", "withdrawn"]

# Typed negotiable terms: copied between versions and compared in the term delta.
TERM_FIELDS: dict[str, str] = {
    "price": "Price",
    "structure": "Structure",
    "earnest_money": "Earnest money",
    "earnest_money_hard_days": "Earnest money goes hard (days)",
    "feasibility_days": "Feasibility period (days)",
    "closing_days": "Closing period (days)",
    "extension_count": "Extensions",
    "extension_days": "Days per extension",
    "extension_cost": "Cost per extension",
    "financing_contingency": "Financing contingency",
    "financing_days": "Financing period (days)",
    "title_survey_days": "Title / survey review (days)",
    "title_survey_terms": "Title / survey terms",
    "assignment_allowed": "Assignment permitted",
    "assignment_terms": "Assignment terms",
    "access_terms": "Access / inspection rights",
    "exclusivity_days": "Exclusivity (days)",
    "expiration_at": "Offer expiration",
    "buyer_entity": "Buyer entity",
    "seller_name": "Seller",
    "other_terms": "Other terms",
}


class Offer(Entity, Base):
    """One version of an offer. Sent / received versions are frozen; every counter is a new row (spec 15)."""

    __tablename__ = "offers"

    opportunity_id: Mapped[uuid.UUID] = fk("opportunities", nullable=False, ondelete="RESTRICT")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    # Underwriting lives in another module: plain UUID keeps this table independent of its load order.
    uw_model_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    uw_model_version: Mapped[int | None] = mapped_column(Integer)
    model_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    model_outputs: Mapped[dict] = mapped_column(JSONB, default=dict)

    # Version chain
    root_offer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    parent_offer_id: Mapped[uuid.UUID | None] = fk("offers")
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    origin: Mapped[str] = mapped_column(String(10), default="buyer", index=True)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)

    # Terms
    price: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    structure: Mapped[str] = mapped_column(String(30), default="all_cash")
    earnest_money: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    earnest_money_hard_days: Mapped[int | None] = mapped_column(Integer)
    feasibility_days: Mapped[int | None] = mapped_column(Integer)
    closing_days: Mapped[int | None] = mapped_column(Integer)
    extension_count: Mapped[int | None] = mapped_column(Integer)
    extension_days: Mapped[int | None] = mapped_column(Integer)
    extension_cost: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    financing_contingency: Mapped[bool] = mapped_column(Boolean, default=False)
    financing_days: Mapped[int | None] = mapped_column(Integer)
    title_survey_days: Mapped[int | None] = mapped_column(Integer)
    title_survey_terms: Mapped[str | None] = mapped_column(Text)
    assignment_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    assignment_terms: Mapped[str | None] = mapped_column(Text)
    access_terms: Mapped[str | None] = mapped_column(Text)
    exclusivity_days: Mapped[int | None] = mapped_column(Integer)
    expiration_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    buyer_entity: Mapped[str | None] = mapped_column(String(200))
    seller_name: Mapped[str | None] = mapped_column(String(200))
    other_terms: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)

    # Approval routing
    deviation_pct: Mapped[float | None] = mapped_column(Float)
    approval_required: Mapped[bool] = mapped_column(Boolean, default=False)
    approvals_required: Mapped[int] = mapped_column(Integer, default=0)
    approval_reasons: Mapped[list] = mapped_column(JSONB, default=list)
    submission_no: Mapped[int] = mapped_column(Integer, default=0)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Delivery and response clock
    loi_payload: Mapped[dict | None] = mapped_column(JSONB)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    sent_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    sent_to: Mapped[str | None] = mapped_column(String(300))
    sent_via: Mapped[str | None] = mapped_column(String(60))
    response_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    follow_up_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    escalation_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # Outcome
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    response_recorded_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    response_note: Mapped[str | None] = mapped_column(Text)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    winning_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    winning_buyer: Mapped[str | None] = mapped_column(String(200))
    winning_price_source: Mapped[str | None] = mapped_column(String(200))
    winning_price_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    winning_price_recorded_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)

    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class OfferApproval(UUIDPk, Base):
    """Immutable, named and timestamped approval decision for one submission of one offer version."""

    __tablename__ = "offer_approvals"

    offer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("offers.id", ondelete="CASCADE"), index=True
    )
    submission_no: Mapped[int] = mapped_column(Integer, default=1)
    decision: Mapped[str] = mapped_column(String(20))  # approved | rejected
    approver_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approver_name: Mapped[str | None] = mapped_column(String(200))
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    note: Mapped[str | None] = mapped_column(Text)
    price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    deviation_pct: Mapped[float | None] = mapped_column(Float)
    reasons: Mapped[list] = mapped_column(JSONB, default=list)


class OfferSettings(Base):
    """Singleton (id = 1) approval routing thresholds."""

    __tablename__ = "offer_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    # Any price above this needs approval.
    price_threshold: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False), default=10_000_000)
    # Price above the approved model's purchase price by more than this % needs approval.
    deviation_threshold_pct: Mapped[float] = mapped_column(Float, default=2.0)
    # ... and by more than this % needs two approvals.
    second_approval_deviation_pct: Mapped[float] = mapped_column(Float, default=5.0)
    # Structures that always route for approval.
    approval_structures: Mapped[list] = mapped_column(
        JSONB, default=lambda: ["assumption", "seller_financing", "joint_venture", "other"]
    )
    # Terms outside these bounds route for approval (deviation from house standard).
    max_feasibility_days: Mapped[int | None] = mapped_column(Integer, default=60)
    max_earnest_money_pct: Mapped[float | None] = mapped_column(Float, default=5.0)
    require_approval_always: Mapped[bool] = mapped_column(Boolean, default=False)
    default_response_days: Mapped[int] = mapped_column(Integer, default=3)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    updated_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
