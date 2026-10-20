import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Stage = Literal[
    "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
    "under_contract", "due_diligence", "closing", "closed", "dead", "nurture",
]
Priority = Literal["low", "normal", "high", "urgent"]
DeadReason = Literal[
    "price_gap", "owner_not_selling", "failed_buybox", "title_or_survey", "financing", "competition", "timing",
    "other",
]


class OpportunityUpdate(BaseModel):
    """Editable fields. Stage changes go through POST /opportunities/{id}/move."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=255)
    owner_id: uuid.UUID | None = None
    primary_person_id: uuid.UUID | None = None
    primary_organization_id: uuid.UUID | None = None
    priority: Priority | None = None
    source: str | None = Field(default=None, max_length=80)
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None
    research_missing_fields: list[str] | None = None
    research_notes: str | None = None
    estimated_value: float | None = Field(default=None, ge=0)
    cap_rate: float | None = Field(default=None, ge=0, le=100)
    underwriting_notes: str | None = None
    price_expectation: float | None = Field(default=None, ge=0)
    offer_price: float | None = Field(default=None, ge=0)
    offer_sent_at: datetime | None = None
    response_due_at: datetime | None = None
    contract_executed_on: date | None = None
    dd_deadline: date | None = None
    closing_date: date | None = None
    closed_price: float | None = Field(default=None, ge=0)
    closed_on: date | None = None
    dead_reason: DeadReason | None = None
    dead_notes: str | None = None
    price_gap: float | None = None
    reactivation_rule: dict[str, Any] | None = None
    next_touch_on: date | None = None
    nurture_cadence_days: int | None = Field(default=None, ge=1, le=3650)
    notes: str | None = None
    tags: list[str] | None = None


class OpportunityCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    property_id: uuid.UUID
    owner_id: uuid.UUID | None = None
    primary_person_id: uuid.UUID | None = None
    primary_organization_id: uuid.UUID | None = None
    priority: Priority = "normal"
    source: str | None = Field(default=None, max_length=80)
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None
    price_expectation: float | None = Field(default=None, ge=0)
    estimated_value: float | None = Field(default=None, ge=0)
    notes: str | None = None
    tags: list[str] = []
    override_reason: str | None = Field(default=None, max_length=2000)


class MoveIn(BaseModel):
    to_stage: Stage
    fields: OpportunityUpdate = OpportunityUpdate()
    override_reason: str | None = Field(default=None, max_length=2000)


class OpportunityListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    property_id: uuid.UUID | None
    property_label: str | None = None
    property_city: str | None = None
    property_state: str | None = None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    stage: str
    stage_entered_at: datetime
    stage_age_days: float = 0
    stalled: bool = False
    priority: str
    source: str | None
    next_action: str | None
    next_action_at: datetime | None
    value: float | None = None
    price_expectation: float | None
    offer_price: float | None
    dead_reason: str | None
    next_touch_on: date | None
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class OpportunityOut(OpportunityListItem):
    primary_person_id: uuid.UUID | None
    primary_person_label: str | None = None
    primary_organization_id: uuid.UUID | None
    primary_organization_label: str | None = None
    research_missing_fields: list[str]
    research_notes: str | None
    estimated_value: float | None
    cap_rate: float | None
    underwriting_notes: str | None
    offer_sent_at: datetime | None
    response_due_at: datetime | None
    contract_executed_on: date | None
    dd_deadline: date | None
    closing_date: date | None
    closed_price: float | None
    closed_on: date | None
    closed_snapshot: dict | None
    dead_notes: str | None
    price_gap: float | None
    reactivation_rule: dict | None
    dead_at: datetime | None
    nurture_cadence_days: int | None
    notes: str | None
    created_by_id: uuid.UUID | None


class Requirement(BaseModel):
    key: str
    label: str
    met: bool
    blocking: bool = True
    detail: str | None = None
    fields: list[str] = []


class StageGates(BaseModel):
    stage: str
    ready: bool
    requirements: list[Requirement]


class GatesOut(BaseModel):
    current_stage: str
    next_stage: str | None
    can_override: bool
    stages: list[StageGates]


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    opportunity_id: uuid.UUID
    from_stage: str | None
    to_stage: str
    actor_id: uuid.UUID | None
    actor_name: str | None
    at: datetime
    override: bool
    reason: str | None
    unmet: list
    snapshot: dict


class OpportunityFacets(BaseModel):
    stage: dict[str, int]
    priority: dict[str, int]
    owner_id: dict[str, int]
    source: dict[str, int]
    dead_reason: dict[str, int]


class BoardColumn(BaseModel):
    stage: str
    count: int
    value: float
    stall_days: int
    items: list[OpportunityListItem]


class StageMetric(BaseModel):
    stage: str
    count: int
    value: float
    avg_age_days: float | None
    stalled: int
    stall_days: int


class VelocityMetric(BaseModel):
    stage: str
    avg_days: float | None
    samples: int


class ConversionMetric(BaseModel):
    stage: str
    next_stage: str
    entered: int
    converted: int
    rate: float | None


class MetricsOut(BaseModel):
    stages: list[StageMetric]
    velocity: list[VelocityMetric]
    conversion: list[ConversionMetric]
    stalled: list[OpportunityListItem]
    totals: dict[str, float]


class StageSettingsIn(BaseModel):
    stall_days: dict[str, int]
