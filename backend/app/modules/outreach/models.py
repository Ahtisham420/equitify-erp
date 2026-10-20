import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base
from app.core.security import utcnow

CHANNELS = ["call", "email", "sms", "meeting", "tour", "letter", "note"]
DIRECTIONS = ["outbound", "inbound", "internal"]
DISPOSITIONS = [
    "connected", "voicemail", "no_answer", "wrong_number", "gatekeeper", "not_interested", "callback",
    "information_requested", "offer_requested",
]
MEANINGFUL_DISPOSITIONS = {"connected", "callback", "information_requested", "offer_requested"}
MEANINGFUL_CHANNELS = {"meeting", "tour"}
# Any of these ends an automated sequence for the person (a human conversation has happened or must not continue).
EXIT_DISPOSITIONS = {"connected", "callback", "information_requested", "offer_requested", "not_interested",
                     "wrong_number"}
# Outreach channel -> compliance channel for send-time checks.
COMPLIANCE_CHANNEL = {"call": "phone", "sms": "sms", "email": "email"}
SEQUENCE_STATUSES = ["active", "paused", "archived"]
ENROLLMENT_STATUSES = ["active", "paused", "completed", "exited"]


class Interaction(Entity, Base):
    """A relationship touchpoint. Meaningful ones must carry a next action or an explicit loop closure."""

    __tablename__ = "interactions"

    channel: Mapped[str] = mapped_column(String(10), index=True)
    direction: Mapped[str] = mapped_column(String(10), default="outbound", index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    person_id: Mapped[uuid.UUID | None] = fk("people")
    organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    opportunity_id: Mapped[uuid.UUID | None] = fk("opportunities")
    contact_point_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    contact_value: Mapped[str | None] = mapped_column(String(320))
    disposition: Mapped[str | None] = mapped_column(String(30), index=True)
    subject: Mapped[str | None] = mapped_column(String(300))
    summary: Mapped[str | None] = mapped_column(Text)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    is_meaningful: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    next_action: Mapped[str | None] = mapped_column(String(300))
    next_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    follow_up_task_id: Mapped[uuid.UUID | None] = fk("tasks")
    loop_closed: Mapped[bool] = mapped_column(Boolean, default=False)
    closed_reason: Mapped[str | None] = mapped_column(Text)
    logged_by_id: Mapped[uuid.UUID | None] = fk("users")
    sequence_enrollment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    compliance_reasons: Mapped[list] = mapped_column(JSONB, default=list)


class Sequence(Entity, Base):
    """Structured multi-step, multi-channel outreach plan. Steps: [{channel, delay_days, template}]."""

    __tablename__ = "sequences"

    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(10), default="active", index=True)
    steps: Mapped[list] = mapped_column(JSONB, default=list)
    enrollment_cap: Mapped[int | None] = mapped_column(Integer)
    exit_dispositions: Mapped[list[str]] = mapped_column(ARRAY(String(30)), default=list)
    owner_id: Mapped[uuid.UUID | None] = fk("users")


class SequenceEnrollment(Entity, Base):
    __tablename__ = "sequence_enrollments"

    sequence_id: Mapped[uuid.UUID] = fk("sequences", nullable=False, ondelete="CASCADE")
    person_id: Mapped[uuid.UUID] = fk("people", nullable=False, ondelete="CASCADE")
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(10), default="active", index=True)
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    next_step_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    enrolled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    exited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exit_reason: Mapped[str | None] = mapped_column(String(200))
    last_step_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
