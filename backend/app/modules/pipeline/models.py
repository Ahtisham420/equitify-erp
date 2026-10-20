import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

STAGES = [
    "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
    "under_contract", "due_diligence", "closing", "closed", "dead", "nurture",
]
# Ordered progression used for board columns, velocity and conversion.
ACTIVE_STAGES = STAGES[:10]
TERMINAL_STAGES = ["closed", "dead", "nurture"]
DEAD_REASONS = [
    "price_gap", "owner_not_selling", "failed_buybox", "title_or_survey", "financing", "competition", "timing",
    "other",
]
REACTIVATION_TYPES = ["time", "debt", "price", "ownership", "lease", "market", "development", "relationship", "manual"]
PRIORITIES = ["low", "normal", "high", "urgent"]
DEFAULT_STALL_DAYS = 14


class Opportunity(Entity, Base):
    """A pursuit of one property, moved through explicit stage gates (spec module 11)."""

    __tablename__ = "opportunities"

    title: Mapped[str] = mapped_column(String(255))
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    stage: Mapped[str] = mapped_column(String(30), index=True, default="sourced")
    stage_entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    # Contacts live in another module; plain UUID columns keep this table independent of its load order.
    primary_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    primary_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    priority: Mapped[str] = mapped_column(String(10), default="normal", index=True)
    source: Mapped[str | None] = mapped_column(String(80), index=True)
    next_action: Mapped[str | None] = mapped_column(String(300))
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    # Research
    research_missing_fields: Mapped[list] = mapped_column(JSONB, default=list)
    research_notes: Mapped[str | None] = mapped_column(Text)
    # Underwriting summary (full underwriting is a later release)
    estimated_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cap_rate: Mapped[float | None] = mapped_column(Float)
    underwriting_notes: Mapped[str | None] = mapped_column(Text)
    # Negotiation / offer
    price_expectation: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    offer_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    offer_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    response_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Contract / DD / closing
    contract_executed_on: Mapped[date | None] = mapped_column(Date)
    dd_deadline: Mapped[date | None] = mapped_column(Date)
    closing_date: Mapped[date | None] = mapped_column(Date)
    closed_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    closed_on: Mapped[date | None] = mapped_column(Date)
    closed_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    # Dead / nurture
    dead_reason: Mapped[str | None] = mapped_column(String(40), index=True)
    dead_notes: Mapped[str | None] = mapped_column(Text)
    price_gap: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    reactivation_rule: Mapped[dict | None] = mapped_column(JSONB)
    dead_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_touch_on: Mapped[date | None] = mapped_column(Date, index=True)
    nurture_cadence_days: Mapped[int | None] = mapped_column(Integer)

    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class OpportunityEvent(UUIDPk, Base):
    """Immutable stage history: every movement, including overrides and the reason given."""

    __tablename__ = "opportunity_events"

    opportunity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("opportunities.id", ondelete="CASCADE"), index=True
    )
    from_stage: Mapped[str | None] = mapped_column(String(30))
    to_stage: Mapped[str] = mapped_column(String(30), index=True)
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    override: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str | None] = mapped_column(Text)
    unmet: Mapped[list] = mapped_column(JSONB, default=list)
    snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)


class PipelineStageSetting(Base):
    """Per-stage stall threshold (days). Missing rows fall back to DEFAULT_STALL_DAYS."""

    __tablename__ = "pipeline_stage_settings"

    stage: Mapped[str] = mapped_column(String(30), primary_key=True)
    stall_days: Mapped[int] = mapped_column(Integer, default=DEFAULT_STALL_DAYS)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    updated_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
