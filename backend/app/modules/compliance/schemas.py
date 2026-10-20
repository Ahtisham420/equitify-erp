import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Channel = Literal["phone", "sms", "email"]
PhoneType = Literal["mobile", "landline", "voip", "unknown"]
DncStatus = Literal["clear", "listed", "unknown"]
Restriction = Literal["no_export", "no_outreach", "internal_only", "attribution_required"]


class RecordUpsert(BaseModel):
    """Create or update the scrub / classification facts for a contact value."""

    channel: Channel
    value: str = Field(min_length=3, max_length=320)
    person_id: uuid.UUID | None = None
    phone_type: PhoneType | None = None
    jurisdiction_state: str | None = Field(default=None, max_length=10)
    jurisdiction_country: str | None = Field(default=None, max_length=2)
    dnc_status: DncStatus | None = None
    scrub_date: date | None = None
    scrub_source: str | None = Field(default=None, max_length=120)
    provider: str | None = Field(default=None, max_length=120)
    notes: str | None = None


class RecordUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    person_id: uuid.UUID | None = None
    phone_type: PhoneType | None = None
    jurisdiction_state: str | None = Field(default=None, max_length=10)
    jurisdiction_country: str | None = Field(default=None, max_length=2)
    dnc_status: DncStatus | None = None
    scrub_date: date | None = None
    scrub_source: str | None = Field(default=None, max_length=120)
    provider: str | None = Field(default=None, max_length=120)
    notes: str | None = None


class RecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    channel: str
    value: str
    normalized_value: str
    person_id: uuid.UUID | None
    phone_type: str
    jurisdiction_state: str | None
    jurisdiction_country: str
    dnc_status: str
    scrub_date: date | None
    scrub_source: str | None
    scrub_expires_on: date | None
    internal_suppression: bool
    suppression_reason: str | None
    suppressed_at: datetime | None
    suppressed_until: datetime | None
    consent_state: str
    consent_source: str | None
    consent_date: datetime | None
    opted_out_at: datetime | None
    opt_out_count: int
    provider: str | None
    notes: str | None
    updated_at: datetime


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    occurred_at: datetime
    record_id: uuid.UUID | None
    channel: str
    normalized_value: str
    person_id: uuid.UUID | None
    event_type: str
    source: str | None
    evidence: str | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    details: dict | None


class RecordDetail(RecordOut):
    events: list[EventOut] = []
    allowed: bool = False
    reasons: list[str] = []


class RecordFacets(BaseModel):
    channel: dict[str, int]
    dnc_status: dict[str, int]
    consent_state: dict[str, int]
    phone_type: dict[str, int]
    suppressed: dict[str, int]


class CheckIn(BaseModel):
    channel: Channel
    value: str = Field(min_length=3, max_length=320)
    at: datetime | None = None


class CheckOut(BaseModel):
    channel: str
    value: str
    normalized_value: str
    allowed: bool
    reasons: list[str]
    record: RecordOut | None = None


class OptOutIn(BaseModel):
    channel: Channel
    value: str = Field(min_length=3, max_length=320)
    person_id: uuid.UUID | None = None
    source: str = Field(min_length=2, max_length=200)
    evidence: str | None = Field(default=None, max_length=4000)


class ConsentIn(BaseModel):
    channel: Channel
    value: str = Field(min_length=3, max_length=320)
    person_id: uuid.UUID | None = None
    state: Literal["granted", "revoked"]
    source: str = Field(min_length=2, max_length=200)
    evidence: str | None = Field(default=None, max_length=4000)
    lift_suppression: bool = False


class SuppressIn(BaseModel):
    channel: Channel
    value: str = Field(min_length=3, max_length=320)
    person_id: uuid.UUID | None = None
    reason: str = Field(min_length=2, max_length=200)
    until: datetime | None = None


class OutboundOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sent_at: datetime
    channel: str
    to_value: str
    normalized_value: str
    person_id: uuid.UUID | None
    subject: str | None
    content: str | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    interaction_id: uuid.UUID | None
    allowed: bool
    block_reasons: list


class QuietHours(BaseModel):
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    end: str = Field(pattern=r"^\d{2}:\d{2}$")
    channels: list[Channel] = ["phone", "sms"]
    default_utc_offset: float = Field(ge=-12, le=14)


class Cap(BaseModel):
    count: int = Field(ge=0, le=1000)
    period_days: int = Field(ge=1, le=365)


class SettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    quiet_hours: dict
    frequency_caps: dict
    channel_caps: dict
    scrub_validity_days: int
    not_interested_suppression_days: int
    counsel_reviewed_at: date | None
    counsel_reviewed_by: str | None
    updated_at: datetime


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quiet_hours: QuietHours | None = None
    frequency_caps: dict[str, Cap] | None = None
    channel_caps: dict[Channel, Cap] | None = None
    scrub_validity_days: int | None = Field(default=None, ge=1, le=365)
    not_interested_suppression_days: int | None = Field(default=None, ge=0, le=3650)
    counsel_reviewed_at: date | None = None
    counsel_reviewed_by: str | None = None


class RestrictionIn(BaseModel):
    provider: str = Field(min_length=1, max_length=120)
    restriction: Restriction = "no_export"
    block_export: bool = False
    notes: str | None = None
    is_active: bool = True


class RestrictionOut(RestrictionIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    updated_at: datetime


class ExportCheckIn(BaseModel):
    providers: list[str] = []
    values: list[CheckIn] = []


class ExportCheckOut(BaseModel):
    blocked: bool
    warnings: list[str]
