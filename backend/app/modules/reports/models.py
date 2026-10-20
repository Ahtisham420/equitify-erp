import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

CADENCES = ["daily", "weekly", "monthly"]
FORMATS = ["csv"]
RUN_STATUSES = ["success", "failed"]


class MetricSnapshot(UUIDPk, Base):
    """Dated value of one KPI (historical metrics). Rows are immutable; one per kpi/day/dimension set."""

    __tablename__ = "metric_snapshots"
    __table_args__ = (UniqueConstraint("kpi_key", "as_of", "dims_key", name="uq_metric_snapshots_key_day_dims"),)

    kpi_key: Mapped[str] = mapped_column(String(80), index=True)
    as_of: Mapped[date] = mapped_column(Date, index=True)
    value: Mapped[float | None] = mapped_column(Float)
    dims: Mapped[dict] = mapped_column(JSONB, default=dict)
    dims_key: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class ReportSchedule(Entity, Base):
    """A dashboard delivered on a cadence; each recipient receives a file computed with their own permissions."""

    __tablename__ = "report_schedules"

    name: Mapped[str] = mapped_column(String(200))
    dashboard_key: Mapped[str] = mapped_column(String(60), index=True)
    # Query-string style filters: {"days": ["30"], "state": ["TX", "FL"], ...}
    filters: Mapped[dict] = mapped_column(JSONB, default=dict)
    cadence: Mapped[str] = mapped_column(String(10), default="weekly")
    recipient_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)
    format: Mapped[str] = mapped_column(String(10), default="csv")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class ReportRun(UUIDPk, Base):
    """One generated report file for one recipient. Immutable."""

    __tablename__ = "report_runs"

    schedule_id: Mapped[uuid.UUID | None] = fk("report_schedules")
    dashboard_key: Mapped[str] = mapped_column(String(60), index=True)
    recipient_id: Mapped[uuid.UUID | None] = fk("users")
    ran_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    status: Mapped[str] = mapped_column(String(10), default="success", index=True)
    filters: Mapped[dict] = mapped_column(JSONB, default=dict)
    filename: Mapped[str | None] = mapped_column(String(255))
    storage_key: Mapped[str | None] = mapped_column(String(400))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    withheld_rows: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    run_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
