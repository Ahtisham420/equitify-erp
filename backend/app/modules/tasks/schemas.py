import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TaskStatus = Literal["open", "in_progress", "done", "cancelled"]
TaskPriority = Literal["low", "normal", "high", "urgent"]
TaskType = Literal["follow_up", "call", "research", "review", "approval", "due_diligence", "general"]
Severity = Literal["low", "medium", "high", "critical"]
ResolutionKind = Literal["actioned", "not_actionable", "duplicate", "false_positive"]
Channel = Literal["in_app", "email", "digest"]


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    task_type: TaskType = "general"
    priority: TaskPriority = "normal"
    due_at: datetime | None = None
    assignee_id: uuid.UUID | None = None
    related_type: str | None = Field(default=None, max_length=40)
    related_id: uuid.UUID | None = None
    related_label: str | None = Field(default=None, max_length=300)
    depends_on: list[uuid.UUID] = []


class TaskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    task_type: TaskType | None = None
    priority: TaskPriority | None = None
    status: Literal["open", "in_progress"] | None = None
    due_at: datetime | None = None
    assignee_id: uuid.UUID | None = None
    related_type: str | None = None
    related_id: uuid.UUID | None = None
    related_label: str | None = None
    depends_on: list[uuid.UUID] | None = None


class TaskRef(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    status: str
    due_at: datetime | None


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    description: str | None
    task_type: str
    status: str
    priority: str
    due_at: datetime | None
    assignee_id: uuid.UUID | None
    assignee_name: str | None = None
    related_type: str | None
    related_id: uuid.UUID | None
    related_label: str | None
    source: str
    depends_on: list[str]
    dependencies: list[TaskRef] = []
    blocked: bool = False
    completed_at: datetime | None
    completed_by_id: uuid.UUID | None
    resolution_note: str | None
    escalation_level: int = 0
    created_at: datetime
    updated_at: datetime
    created_by_id: uuid.UUID | None


class TaskFacets(BaseModel):
    status: dict[str, int]
    priority: dict[str, int]
    task_type: dict[str, int]


class ResolutionIn(BaseModel):
    note: str | None = Field(default=None, max_length=4000)


class CancelIn(BaseModel):
    note: str = Field(min_length=3, max_length=4000)


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    reason: str
    severity: str
    status: str
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    related_type: str | None
    related_id: uuid.UUID | None
    related_label: str | None
    rule_key: str | None
    due_at: datetime | None
    acknowledged_at: datetime | None
    resolved_at: datetime | None
    resolved_by_id: uuid.UUID | None
    resolution_note: str | None
    resolution_kind: str | None
    escalation_level: int = 0
    created_at: datetime


class AlertFacets(BaseModel):
    status: dict[str, int]
    severity: dict[str, int]
    rule_key: dict[str, int]


class AlertResolveIn(BaseModel):
    note: str = Field(min_length=3, max_length=4000)
    kind: ResolutionKind = "actioned"


class AlertAckIn(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class AlertSummary(BaseModel):
    open: int
    critical: int


class NoiseRow(BaseModel):
    rule_key: str
    total: int
    open: int
    actioned: int
    dismissed: int
    dismiss_rate: float
    avg_hours_to_resolve: float | None


class RuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    name: str
    description: str | None
    event: str | None
    enabled: bool
    thresholds: dict
    last_run_at: datetime | None
    run_count: int
    error_count: int
    last_error: str | None
    updated_at: datetime


class RuleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None
    thresholds: dict | None = None


class EscalationResult(BaseModel):
    dry_run: bool
    skipped: bool = False
    tasks_escalated: int = 0
    alerts_escalated: int = 0
    managers_notified: int = 0
    items: list[dict] = []


class SubscriptionIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    subscriber_id: uuid.UUID | None = None
    territory_id: uuid.UUID | None = None
    property_types: list[str] = []
    tenant: str | None = Field(default=None, max_length=200)
    owner_id: uuid.UUID | None = None
    saved_view_id: uuid.UUID | None = None
    rule_keys: list[str] = []
    min_severity: Severity = "low"
    channel: Channel = "in_app"
    is_active: bool = True


class SubscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    subscriber_id: uuid.UUID
    subscriber_name: str | None = None
    territory_id: uuid.UUID | None
    property_types: list[str]
    tenant: str | None
    owner_id: uuid.UUID | None
    saved_view_id: uuid.UUID | None
    rule_keys: list[str]
    min_severity: str
    channel: str
    is_active: bool
    created_at: datetime


class DigestOut(BaseModel):
    generated_at: datetime
    due_today: list[TaskOut]
    overdue: list[TaskOut]
    new_alerts: list[AlertOut]
    subscribed_alerts: list[AlertOut]
