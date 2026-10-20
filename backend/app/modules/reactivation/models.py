import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

TRIGGER_STATUSES = ["armed", "fired", "cancelled"]
ITEM_STATUSES = ["pending", "snoozed", "reactivated", "dismissed"]
# Backstop revisit interval by dead reason ("time triggers by dead reason").
REVISIT_DAYS_BY_REASON = {
    "price_gap": 180, "owner_not_selling": 365, "failed_buybox": 365, "title_or_survey": 180, "financing": 120,
    "competition": 270, "timing": 180, "other": 365,
}


class ReactivationTrigger(Entity, Base):
    """A watch armed when an opportunity is marked dead; fires when its condition is met."""

    __tablename__ = "reactivation_triggers"

    opportunity_id: Mapped[uuid.UUID] = fk("opportunities", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    trigger_type: Mapped[str] = mapped_column(String(20), index=True)
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    origin: Mapped[str] = mapped_column(String(20), default="rule")  # rule | dead_reason_backstop | rearm | manual
    status: Mapped[str] = mapped_column(String(20), default="armed", index=True)
    armed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    fire_on: Mapped[date | None] = mapped_column(Date, index=True)
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    check_count: Mapped[int] = mapped_column(Integer, default=0)
    baseline: Mapped[dict] = mapped_column(JSONB, default=dict)
    dead_reason: Mapped[str | None] = mapped_column(String(40))
    cancelled_reason: Mapped[str | None] = mapped_column(Text)


class ReactivationItem(Entity, Base):
    """Queue entry: a dead opportunity returning with its original context and what changed."""

    __tablename__ = "reactivation_items"

    opportunity_id: Mapped[uuid.UUID] = fk("opportunities", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    trigger_id: Mapped[uuid.UUID | None] = fk("reactivation_triggers")
    trigger_type: Mapped[str] = mapped_column(String(20), index=True)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    fired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    what_changed: Mapped[str] = mapped_column(Text)
    changes: Mapped[list] = mapped_column(JSONB, default=list)
    original_context: Mapped[dict] = mapped_column(JSONB, default=dict)
    score_before: Mapped[float | None] = mapped_column(Float)
    score_after: Mapped[float | None] = mapped_column(Float)
    snoozed_until: Mapped[date | None] = mapped_column(Date, index=True)
    decided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    reactivated_to_stage: Mapped[str | None] = mapped_column(String(30))
    converted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
