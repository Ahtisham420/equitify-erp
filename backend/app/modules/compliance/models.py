import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk
from app.core.database import Base
from app.core.security import utcnow

CHANNELS = ["phone", "sms", "email"]
PHONE_TYPES = ["mobile", "landline", "voip", "unknown"]
DNC_STATUSES = ["clear", "listed", "unknown"]
CONSENT_STATES = ["unknown", "granted", "revoked"]
EVENT_TYPES = ["consent_granted", "consent_revoked", "opt_out", "suppressed", "suppression_lifted", "dnc_scrubbed"]
RESTRICTIONS = ["no_export", "no_outreach", "internal_only", "attribution_required"]


class ComplianceRecord(Entity, Base):
    """Current compliance state for one channel + contact value. History lives in consent_events."""

    __tablename__ = "compliance_records"
    __table_args__ = (UniqueConstraint("channel", "normalized_value", name="uq_compliance_records_channel_value"),)

    channel: Mapped[str] = mapped_column(String(10), index=True)
    value: Mapped[str] = mapped_column(String(320))
    normalized_value: Mapped[str] = mapped_column(String(320), index=True)
    # Soft link to people.id (contacts module); kept without FK so compliance never depends on CRM deletes.
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    phone_type: Mapped[str] = mapped_column(String(10), default="unknown")
    jurisdiction_state: Mapped[str | None] = mapped_column(String(10), index=True)
    jurisdiction_country: Mapped[str] = mapped_column(String(2), default="US")
    dnc_status: Mapped[str] = mapped_column(String(10), default="unknown", index=True)
    scrub_date: Mapped[date | None] = mapped_column(Date)
    scrub_source: Mapped[str | None] = mapped_column(String(120))
    scrub_expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    internal_suppression: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    suppression_reason: Mapped[str | None] = mapped_column(String(200))
    suppressed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    suppressed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consent_state: Mapped[str] = mapped_column(String(10), default="unknown", index=True)
    consent_source: Mapped[str | None] = mapped_column(String(200))
    consent_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    opted_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    opt_out_count: Mapped[int] = mapped_column(Integer, default=0)
    provider: Mapped[str | None] = mapped_column(String(120), index=True)
    notes: Mapped[str | None] = mapped_column(Text)


class ConsentEvent(UUIDPk, Base):
    """Immutable log of consent / opt-out / suppression changes. No update or delete path exists."""

    __tablename__ = "consent_events"

    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    record_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    channel: Mapped[str] = mapped_column(String(10))
    normalized_value: Mapped[str] = mapped_column(String(320), index=True)
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    event_type: Mapped[str] = mapped_column(String(30), index=True)
    source: Mapped[str | None] = mapped_column(String(200))
    evidence: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_name: Mapped[str | None] = mapped_column(String(200))
    details: Mapped[dict | None] = mapped_column(JSONB)


class OutboundMessage(UUIDPk, Base):
    """Immutable outbound content log, including attempts blocked at send time."""

    __tablename__ = "outbound_messages"

    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    channel: Mapped[str] = mapped_column(String(10), index=True)
    to_value: Mapped[str] = mapped_column(String(320))
    normalized_value: Mapped[str] = mapped_column(String(320), index=True)
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    subject: Mapped[str | None] = mapped_column(String(300))
    content: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    interaction_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    allowed: Mapped[bool] = mapped_column(Boolean, index=True)
    block_reasons: Mapped[list] = mapped_column(JSONB, default=list)


class ComplianceSettings(Entity, Base):
    """Singleton row: quiet hours, frequency caps and channel caps. Must be reviewed by counsel before campaigns."""

    __tablename__ = "compliance_settings"

    quiet_hours: Mapped[dict] = mapped_column(JSONB, default=dict)
    frequency_caps: Mapped[dict] = mapped_column(JSONB, default=dict)
    channel_caps: Mapped[dict] = mapped_column(JSONB, default=dict)
    scrub_validity_days: Mapped[int] = mapped_column(Integer, default=31)
    not_interested_suppression_days: Mapped[int] = mapped_column(Integer, default=180)
    counsel_reviewed_at: Mapped[date | None] = mapped_column(Date)
    counsel_reviewed_by: Mapped[str | None] = mapped_column(String(200))


class ProviderRestriction(Entity, Base):
    """Usage restrictions of enrichment-data providers, used for export warnings / blocks."""

    __tablename__ = "provider_restrictions"

    provider: Mapped[str] = mapped_column(String(120), unique=True)
    restriction: Mapped[str] = mapped_column(String(30), default="no_export")
    block_export: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
