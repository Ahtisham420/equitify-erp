import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TriggerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    opportunity_id: uuid.UUID
    opportunity_title: str | None = None
    property_id: uuid.UUID | None
    property_label: str | None = None
    trigger_type: str
    params: dict
    origin: str
    status: str
    armed_at: datetime
    fire_on: date | None
    fired_at: datetime | None
    last_checked_at: datetime | None
    check_count: int
    baseline: dict
    dead_reason: str | None
    cancelled_reason: str | None
    description: str | None = None


class TriggerUpdate(BaseModel):
    params: dict[str, Any]


class CancelIn(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class ArmIn(BaseModel):
    trigger_type: str | None = None
    params: dict[str, Any] | None = None


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    opportunity_id: uuid.UUID
    opportunity_title: str | None = None
    opportunity_stage: str | None = None
    property_id: uuid.UUID | None
    property_label: str | None = None
    trigger_id: uuid.UUID | None
    trigger_type: str
    trigger_description: str | None = None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    status: str
    effective_status: str = "pending"
    fired_at: datetime
    what_changed: str
    changes: list
    original_context: dict
    score_before: float | None
    score_after: float | None
    snoozed_until: date | None
    decided_by_id: uuid.UUID | None
    decided_at: datetime | None
    decision_reason: str | None
    reactivated_to_stage: str | None
    converted: bool
    converted_at: datetime | None
    task_id: uuid.UUID | None
    created_at: datetime


class ItemFacets(BaseModel):
    status: dict[str, int]
    trigger_type: dict[str, int]
    owner_id: dict[str, int]


class ReactivateIn(BaseModel):
    to_stage: str
    override_reason: str | None = Field(default=None, max_length=2000)
    note: str | None = Field(default=None, max_length=2000)
    fields: dict[str, Any] = {}


class SnoozeIn(BaseModel):
    until: date
    reason: str | None = Field(default=None, max_length=2000)


class DismissIn(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)
    rearm: bool = True


class ScanOut(BaseModel):
    checked: int
    fired: int
    woken: int
    items: list[uuid.UUID]


class TriggerPerformance(BaseModel):
    trigger_type: str
    label: str
    armed: int
    fired: int
    pending: int
    snoozed: int
    reactivated: int
    converted: int
    dismissed: int
    noise_rate: float | None
    reactivation_rate: float | None
    conversion_rate: float | None
    avg_days_dead_to_fire: float | None


class AnalyticsOut(BaseModel):
    totals: dict[str, int]
    by_type: list[TriggerPerformance]
    top_dismiss_reasons: list[dict]
