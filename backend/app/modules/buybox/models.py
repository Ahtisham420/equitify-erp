import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

OPERATORS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "contains", "is_set"]
REQUIREMENTS = ["mandatory", "preferred", "disqualifying"]
RESULTS = ["pass", "pass_with_exception", "fail", "insufficient_data"]
EXCEPTION_STATES = ["none", "requested", "approved", "rejected"]
STRATEGY_SUGGESTIONS = [
    "stnl", "multi_tenant_retail", "core", "core_plus", "value_add", "opportunistic", "development", "land",
    "ground_lease", "other",
]


class BuyBox(Entity, Base):
    """A named investment strategy gate. Criteria edits bump `version`; every version is snapshotted."""

    __tablename__ = "buy_boxes"

    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text)
    strategy: Mapped[str] = mapped_column(String(60), index=True, default="other")
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    active_from: Mapped[date | None] = mapped_column(Date)
    active_to: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)


class BuyboxCriterion(Entity, Base):
    """One rule of the current version. Prior versions live in `buybox_versions.criteria`."""

    __tablename__ = "buybox_criteria"

    buy_box_id: Mapped[uuid.UUID] = fk("buy_boxes", nullable=False, ondelete="CASCADE")
    field: Mapped[str] = mapped_column(String(60))
    operator: Mapped[str] = mapped_column(String(20))
    value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    requirement: Mapped[str] = mapped_column(String(20), default="mandatory")
    note: Mapped[str | None] = mapped_column(String(300))
    position: Mapped[int] = mapped_column(Integer, default=0)


class BuyboxVersion(UUIDPk, Base):
    """Immutable snapshot of a buy box's criteria at a given version."""

    __tablename__ = "buybox_versions"
    __table_args__ = (UniqueConstraint("buy_box_id", "version", name="uq_buybox_versions_box_version"),)

    buy_box_id: Mapped[uuid.UUID] = fk("buy_boxes", nullable=False, ondelete="CASCADE")
    version: Mapped[int] = mapped_column(Integer)
    criteria: Mapped[list] = mapped_column(JSONB, default=list)
    change_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class BuyboxEvaluation(Entity, Base):
    """One evaluation of one property against one buy box version. Older rows are kept (is_current=False)."""

    __tablename__ = "buybox_evaluations"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    buy_box_id: Mapped[uuid.UUID] = fk("buy_boxes", nullable=False, ondelete="CASCADE")
    buy_box_version: Mapped[int] = mapped_column(Integer)
    result: Mapped[str] = mapped_column(String(30), index=True)
    raw_result: Mapped[str] = mapped_column(String(30))  # engine result before any approved exception
    missing_fields: Mapped[list] = mapped_column(JSONB, default=list)
    details: Mapped[list] = mapped_column(JSONB, default=list)
    preferred_misses: Mapped[list] = mapped_column(JSONB, default=list)
    signature: Mapped[str] = mapped_column(String(64))
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    trigger: Mapped[str] = mapped_column(String(30), default="manual")

    exception_status: Mapped[str] = mapped_column(String(20), default="none", index=True)
    exception_requested_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    exception_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exception_request_reason: Mapped[str | None] = mapped_column(Text)
    exception_approver_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    exception_decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exception_decision_reason: Mapped[str | None] = mapped_column(Text)
