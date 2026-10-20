import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

TASK_STATUSES = ["open", "in_progress", "done", "cancelled"]
TASK_PRIORITIES = ["low", "normal", "high", "urgent"]
TASK_TYPES = ["follow_up", "call", "research", "review", "approval", "due_diligence", "general"]
ALERT_SEVERITIES = ["low", "medium", "high", "critical"]
ALERT_STATUSES = ["open", "acknowledged", "resolved"]
# How an alert was worked: actioned = real work done; the others count as noise for fatigue monitoring.
ALERT_RESOLUTIONS = ["actioned", "not_actionable", "duplicate", "false_positive"]
SUBSCRIPTION_CHANNELS = ["in_app", "email", "digest"]


class Task(Entity, Base):
    """Owned unit of work. Automation-created tasks carry an idempotency key so re-runs never duplicate."""

    __tablename__ = "tasks"

    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    task_type: Mapped[str] = mapped_column(String(30), default="general", index=True)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    priority: Mapped[str] = mapped_column(String(10), default="normal", index=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    assignee_id: Mapped[uuid.UUID | None] = fk("users")
    # Polymorphic link back to the originating record (property, opportunity, person, ...).
    related_type: Mapped[str | None] = mapped_column(String(40), index=True)
    related_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    related_label: Mapped[str | None] = mapped_column(String(300))
    source: Mapped[str] = mapped_column(String(80), default="manual")
    depends_on: Mapped[list] = mapped_column(JSONB, default=list)
    idempotency_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    resolution_note: Mapped[str | None] = mapped_column(Text)
    escalation_level: Mapped[int] = mapped_column(Integer, default=0)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Alert(Entity, Base):
    """Every alert has a reason, an owner and a resolution state."""

    __tablename__ = "alerts"

    title: Mapped[str] = mapped_column(String(300))
    reason: Mapped[str] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(String(10), default="medium", index=True)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    related_type: Mapped[str | None] = mapped_column(String(40), index=True)
    related_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    related_label: Mapped[str | None] = mapped_column(String(300))
    rule_key: Mapped[str | None] = mapped_column(String(80), index=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    idempotency_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    resolution_note: Mapped[str | None] = mapped_column(Text)
    acknowledged_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    resolution_kind: Mapped[str | None] = mapped_column(String(20), index=True)
    escalation_level: Mapped[int] = mapped_column(Integer, default=0)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AutomationRule(Entity, Base):
    """Registry of event-driven automations. Each one is individually configurable and disableable."""

    __tablename__ = "automation_rules"

    key: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text)
    event: Mapped[str | None] = mapped_column(String(80))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    thresholds: Mapped[dict] = mapped_column(JSONB, default=dict)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)


class AlertSubscription(Entity, Base):
    """A user's standing interest in alerts matching territory / property type / tenant / owner / saved view."""

    __tablename__ = "alert_subscriptions"

    subscriber_id: Mapped[uuid.UUID] = fk("users", nullable=False, ondelete="CASCADE")
    name: Mapped[str] = mapped_column(String(160))
    territory_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    property_types: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    tenant: Mapped[str | None] = mapped_column(String(200))
    owner_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    saved_view_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    rule_keys: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    min_severity: Mapped[str] = mapped_column(String(10), default="low")
    channel: Mapped[str] = mapped_column(String(10), default="in_app")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
