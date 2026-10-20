import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Channel = Literal["call", "email", "sms", "meeting", "tour", "letter", "note"]
Direction = Literal["outbound", "inbound", "internal"]
Disposition = Literal[
    "connected", "voicemail", "no_answer", "wrong_number", "gatekeeper", "not_interested", "callback",
    "information_requested", "offer_requested",
]


class InteractionCreate(BaseModel):
    channel: Channel
    direction: Direction = "outbound"
    occurred_at: datetime | None = None
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    contact_point_id: uuid.UUID | None = None
    contact_value: str | None = Field(default=None, max_length=320)
    disposition: Disposition | None = None
    subject: str | None = Field(default=None, max_length=300)
    summary: str | None = Field(default=None, max_length=20000)
    duration_seconds: int | None = Field(default=None, ge=0)
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None
    loop_closed: bool = False
    closed_reason: str | None = Field(default=None, max_length=4000)
    sequence_enrollment_id: uuid.UUID | None = None
    # Queue flow: completes this task as part of logging (skipped while it has open dependencies).
    complete_task_id: uuid.UUID | None = None


class InteractionUpdate(BaseModel):
    """Interactions are history; only narrative and follow-up fields may change afterwards."""

    model_config = ConfigDict(extra="forbid")

    subject: str | None = Field(default=None, max_length=300)
    summary: str | None = Field(default=None, max_length=20000)
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None
    loop_closed: bool | None = None
    closed_reason: str | None = Field(default=None, max_length=4000)


class InteractionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    channel: str
    direction: str
    occurred_at: datetime
    person_id: uuid.UUID | None
    person_name: str | None = None
    organization_id: uuid.UUID | None
    organization_name: str | None = None
    property_id: uuid.UUID | None
    property_label: str | None = None
    opportunity_id: uuid.UUID | None
    opportunity_title: str | None = None
    contact_value: str | None
    disposition: str | None
    subject: str | None
    summary: str | None
    duration_seconds: int | None
    is_meaningful: bool
    next_action: str | None
    next_action_at: datetime | None
    follow_up_task_id: uuid.UUID | None
    loop_closed: bool
    closed_reason: str | None
    logged_by_id: uuid.UUID | None
    logged_by_name: str | None = None
    sequence_enrollment_id: uuid.UUID | None
    created_at: datetime


class InteractionFacets(BaseModel):
    channel: dict[str, int]
    direction: dict[str, int]
    disposition: dict[str, int]


class SequenceStep(BaseModel):
    channel: Literal["call", "email", "sms", "letter"]
    delay_days: int = Field(ge=0, le=365)
    template: str | None = Field(default=None, max_length=10000)


class SequenceIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = None
    status: Literal["active", "paused", "archived"] = "active"
    steps: list[SequenceStep] = Field(default=[], max_length=30)
    enrollment_cap: int | None = Field(default=None, ge=1, le=100000)
    exit_dispositions: list[Disposition] = []


class SequenceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    status: str
    steps: list[dict]
    enrollment_cap: int | None
    exit_dispositions: list[str]
    owner_id: uuid.UUID | None
    active_enrollments: int = 0
    total_enrollments: int = 0
    created_at: datetime
    updated_at: datetime


class EnrollIn(BaseModel):
    person_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    owner_id: uuid.UUID | None = None


class EnrollResult(BaseModel):
    enrolled: int
    skipped: list[dict]


class EnrollmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sequence_id: uuid.UUID
    sequence_name: str | None = None
    person_id: uuid.UUID
    person_name: str | None = None
    owner_id: uuid.UUID | None
    status: str
    current_step: int
    total_steps: int = 0
    next_step_at: datetime | None
    next_step_channel: str | None = None
    enrolled_at: datetime
    exited_at: datetime | None
    exit_reason: str | None
    last_step_at: datetime | None


class ExitIn(BaseModel):
    reason: str = Field(min_length=2, max_length=200)


class QueueItem(BaseModel):
    key: str
    kind: Literal["task", "follow_up", "sequence_step", "stalled_deal", "person_due", "relationship"]
    title: str
    subtitle: str | None = None
    score: float
    reasons: list[str]
    due_at: datetime | None = None
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    enrollment_id: uuid.UUID | None = None


class QueueOut(BaseModel):
    items: list[QueueItem]
    cap: int
    total_candidates: int
    done_today: int


class ContactStatus(BaseModel):
    kind: str
    label: str | None
    value: str
    channels: list[dict]


class ContextOut(BaseModel):
    person: dict | None
    organizations: list[dict]
    properties: list[dict]
    opportunities: list[dict]
    interactions: list[InteractionOut]
    open_tasks: list[dict]
    enrollments: list[EnrollmentOut]
    contacts: list[ContactStatus]
    suppression_reasons: list[str]
    talking_points: list[str]


class TeamActivityRow(BaseModel):
    user_id: uuid.UUID
    user_name: str
    total: int
    meaningful: int
    by_channel: dict[str, int]
    by_disposition: dict[str, int]
    overdue_follow_ups: int
    stale_records: int
    untouched_records: int


class TeamActivityOut(BaseModel):
    date_from: datetime
    date_to: datetime
    rows: list[TeamActivityRow]
    overdue: list[dict]
