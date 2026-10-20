import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

# Spec 36 integration catalog (+ AI, the assistive provider behind documents/search/outreach intelligence).
INTEGRATION_CATEGORIES: dict[str, str] = {
    "email_calendar": "Email & calendar",
    "telephony": "Telephony",
    "messaging": "Messaging",
    "meetings": "Meetings",
    "parcel_ownership": "Parcel & ownership",
    "recorded_documents": "Recorded documents & liens",
    "tax_court_entity": "Tax, court & entity",
    "traffic_demographics": "Traffic, demographics & permits",
    "tenant_brand": "Tenant & brand",
    "market_comps": "Market comps",
    "accounting": "Accounting",
    "banking": "Banking",
    "payments": "Payments",
    "esignature": "E-signature",
    "title_escrow": "Title & escrow",
    "lender_exchange": "Lender exchange",
    "storage": "Storage",
    "spreadsheets": "Spreadsheets",
    "task_calendar": "Task & calendar",
    "ai": "AI",
}
INTEGRATION_STATUSES = ["not_configured", "manual", "active", "error", "disabled"]
DELIVERY_STATUSES = ["pending", "sending", "delivered", "failed", "dead"]
JOB_STATUSES = ["running", "succeeded", "failed"]
SUGGESTION_KINDS = ["summary", "commitment", "next_action"]
SUGGESTION_STATUSES = ["pending", "accepted", "rejected", "superseded"]


class IntegrationProvider(Entity, Base):
    """A configured provider for one integration category. Core logic talks to it only via platform/providers.py."""

    __tablename__ = "integration_providers"
    __table_args__ = (UniqueConstraint("category", "provider", name="uq_integration_providers_category_provider"),)

    category: Mapped[str] = mapped_column(String(40), index=True)
    provider: Mapped[str] = mapped_column(String(80))
    label: Mapped[str | None] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(20), default="not_configured", index=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Fernet token of a JSON object. Never returned in plaintext.
    credentials_encrypted: Mapped[str | None] = mapped_column(Text)
    credential_keys: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    credentials_version: Mapped[int] = mapped_column(Integer, default=0)
    credentials_rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    usage_restrictions: Mapped[str | None] = mapped_column(Text)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class FeatureFlag(Entity, Base):
    """Deployment control. Money/date/permission-sensitive changes ship behind a sensitive flag."""

    __tablename__ = "feature_flags"

    key: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    rollout_roles: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    rollout_user_ids: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)


class WebhookSubscription(Entity, Base):
    __tablename__ = "webhook_subscriptions"

    name: Mapped[str] = mapped_column(String(160))
    url: Mapped[str] = mapped_column(String(1000))
    events: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    secret_encrypted: Mapped[str] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_delivery_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)


class WebhookDelivery(UUIDPk, Base):
    """Outbox row written inside the event transaction; network I/O happens later in the delivery worker."""

    __tablename__ = "webhook_deliveries"

    subscription_id: Mapped[uuid.UUID] = fk("webhook_subscriptions", nullable=False, ondelete="CASCADE")
    event: Mapped[str] = mapped_column(String(80), index=True)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status_code: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[str | None] = mapped_column(Text)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class JobRun(UUIDPk, Base):
    """Observable background job runs (spec 35/36: idempotent, retryable, observable jobs)."""

    __tablename__ = "job_runs"

    job_key: Mapped[str] = mapped_column(String(80), index=True)
    status: Mapped[str] = mapped_column(String(20), default="running", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    counts: Mapped[dict] = mapped_column(JSONB, default=dict)
    triggered_by_id: Mapped[uuid.UUID | None] = fk("users")


class RetentionPolicy(Entity, Base):
    __tablename__ = "retention_policies"

    entity_type: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    retain_days: Mapped[int] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(20), default="review")  # review | archive
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class LegalHold(Entity, Base):
    """While a hold is open (released_at is null) the record must not be purged or destroyed."""

    __tablename__ = "legal_holds"

    entity_type: Mapped[str] = mapped_column(String(60), index=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)  # null = whole entity type
    reason: Mapped[str] = mapped_column(Text)
    matter: Mapped[str | None] = mapped_column(String(200))
    placed_by_id: Mapped[uuid.UUID | None] = fk("users")
    placed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    released_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    release_reason: Mapped[str | None] = mapped_column(Text)


class BackupRecord(Entity, Base):
    """Manual log of backups and restoration tests against RPO/RTO targets."""

    __tablename__ = "backup_records"

    kind: Mapped[str] = mapped_column(String(20), index=True)  # backup | restore_test
    environment: Mapped[str] = mapped_column(String(20), default="production")
    performed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    reference: Mapped[str | None] = mapped_column(String(300))
    encrypted: Mapped[bool] = mapped_column(Boolean, default=True)
    point_in_time: Mapped[bool] = mapped_column(Boolean, default=False)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    rpo_target_minutes: Mapped[int | None] = mapped_column(Integer)
    rto_target_minutes: Mapped[int | None] = mapped_column(Integer)
    achieved_rpo_minutes: Mapped[float | None] = mapped_column(Float)
    achieved_rto_minutes: Mapped[float | None] = mapped_column(Float)
    result: Mapped[str] = mapped_column(String(20), default="success")  # success | partial | failed
    notes: Mapped[str | None] = mapped_column(Text)
    performed_by_id: Mapped[uuid.UUID | None] = fk("users")


class AISuggestion(Entity, Base):
    """AI output awaiting human confirmation. Nothing is applied unless a named user accepts it."""

    __tablename__ = "ai_suggestions"

    source_type: Mapped[str] = mapped_column(String(40), index=True)  # interaction
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    content: Mapped[str] = mapped_column(Text)
    details: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    provider: Mapped[str | None] = mapped_column(String(60))
    model: Mapped[str | None] = mapped_column(String(120))
    decided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    task_id: Mapped[uuid.UUID | None] = fk("tasks", index=False)
