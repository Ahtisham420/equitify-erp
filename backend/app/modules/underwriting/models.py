import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

UW_STATUSES = ["draft", "submitted", "approved", "rejected", "superseded"]


class UwModel(Entity, Base):
    """One version of an underwriting model (spec module 12).

    Versions of the same model share `root_id`. Approved versions are locked; any edit to a non-draft version
    creates a new draft version, so prior versions are never destroyed.
    """

    __tablename__ = "uw_models"

    root_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    comp_set_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    template: Mapped[str] = mapped_column(String(40), index=True)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False)
    change_note: Mapped[str | None] = mapped_column(Text)

    assumptions: Mapped[dict] = mapped_column(JSONB, default=dict)
    scenarios: Mapped[list] = mapped_column(JSONB, default=list)  # [{key, name, kind, overrides, outputs}]
    outputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    annual: Mapped[list] = mapped_column(JSONB, default=list)
    warnings: Mapped[list] = mapped_column(JSONB, default=list)
    unsourced: Mapped[list] = mapped_column(JSONB, default=list)
    simulation: Mapped[dict | None] = mapped_column(JSONB)
    calculated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    submitted_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejected_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)


class UwModelEvent(UUIDPk, Base):
    """Immutable approval / version history for underwriting models."""

    __tablename__ = "uw_model_events"

    model_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("uw_models.id", ondelete="CASCADE"), index=True)
    root_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    action: Mapped[str] = mapped_column(String(30))  # created|versioned|submitted|approved|rejected|superseded
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    note: Mapped[str | None] = mapped_column(Text)
    details: Mapped[dict] = mapped_column(JSONB, default=dict)
