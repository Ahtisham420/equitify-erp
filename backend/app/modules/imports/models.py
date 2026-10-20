import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Index, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base

ENTITY_TYPES = ["property", "person", "organization"]
JOB_STATUSES = ["uploaded", "mapped", "validated", "committed", "rolled_back", "failed"]
ROW_STATUSES = ["pending", "valid", "invalid", "duplicate", "created", "updated", "skipped"]
CADENCES = ["one_time", "daily", "weekly", "monthly", "quarterly", "annual", "ad_hoc"]


class DataSource(Entity, Base):
    """Source/license registry. External data cannot be committed without an active source."""

    __tablename__ = "data_sources"

    provider: Mapped[str] = mapped_column(String(200), index=True)
    description: Mapped[str | None] = mapped_column(Text)
    license_terms: Mapped[str | None] = mapped_column(Text)
    permitted_use: Mapped[str | None] = mapped_column(Text)
    redistribution_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    cadence: Mapped[str] = mapped_column(String(20), default="ad_hoc")
    cost: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cost_notes: Mapped[str | None] = mapped_column(String(200))
    contact_name: Mapped[str | None] = mapped_column(String(200))
    contact_email: Mapped[str | None] = mapped_column(String(255))
    contact_phone: Mapped[str | None] = mapped_column(String(40))
    renewal_date: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class ImportJob(Entity, Base):
    __tablename__ = "import_jobs"

    entity_type: Mapped[str] = mapped_column(String(20), index=True)
    data_source_id: Mapped[uuid.UUID | None] = fk("data_sources")
    filename: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="uploaded", index=True)
    headers: Mapped[list] = mapped_column(JSONB, default=list)
    column_mapping: Mapped[dict] = mapped_column(JSONB, default=dict)
    options: Mapped[dict] = mapped_column(JSONB, default=dict)
    counts: Mapped[dict] = mapped_column(JSONB, default=dict)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    committed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    rolled_back_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rolled_back_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class ImportRow(UUIDPk, Base):
    __tablename__ = "import_rows"
    __table_args__ = (Index("ix_import_rows_job_status", "job_id", "status"),)

    job_id: Mapped[uuid.UUID] = fk("import_jobs", nullable=False, ondelete="CASCADE")
    row_number: Mapped[int] = mapped_column(Integer)
    raw: Mapped[dict] = mapped_column(JSONB, default=dict)
    mapped: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    errors: Mapped[list] = mapped_column(JSONB, default=list)
    duplicate_of_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    previous_values: Mapped[dict | None] = mapped_column(JSONB)


class QualityThreshold(Entity, Base):
    """Admin override of the staleness threshold (days) for one property field."""

    __tablename__ = "data_quality_thresholds"

    field: Mapped[str] = mapped_column(String(80), unique=True)
    days: Mapped[int] = mapped_column(Integer)
