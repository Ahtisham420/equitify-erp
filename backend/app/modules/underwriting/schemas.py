import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Template = Literal["stnl", "multi_tenant_retail", "gas_convenience", "medical", "ground_lease", "land"]


class ModelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    template: Template
    property_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    comp_set_id: uuid.UUID | None = None
    analysis_start: date | None = None
    seed_tenants: Literal["auto", "spaces", "leases", "none"] = "auto"


class ModelUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    opportunity_id: uuid.UUID | None = None


class AssumptionsIn(BaseModel):
    assumptions: dict[str, Any]
    change_note: str | None = Field(default=None, max_length=2000)


class ScenarioIn(BaseModel):
    key: str | None = Field(default=None, max_length=60)
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["base", "downside", "upside", "named"] = "named"
    overrides: dict[str, Any] = {}


class ScenariosIn(BaseModel):
    scenarios: list[ScenarioIn] = Field(max_length=20)
    change_note: str | None = None


class NewVersionIn(BaseModel):
    change_note: str | None = Field(default=None, max_length=2000)


class DecisionIn(BaseModel):
    note: str | None = Field(default=None, max_length=4000)
    acknowledge_unsourced: bool = False


class SimulationRange(BaseModel):
    path: str = Field(min_length=1, max_length=200)
    label: str | None = None
    min: float
    max: float
    mode: float | None = None


class SimulateIn(BaseModel):
    iterations: int = Field(500, ge=10, le=2000)
    seed: int = 1
    ranges: list[SimulationRange] = Field(min_length=1, max_length=12)
    target_irr: float | None = None
    scenario_key: str | None = None


class ModelListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    root_id: uuid.UUID | None
    name: str
    template: str
    version: int
    status: str
    is_locked: bool
    is_latest: bool
    property_id: uuid.UUID | None
    opportunity_id: uuid.UUID | None
    property_label: str | None = None
    purchase_price: float | None = None
    irr: float | None = None
    going_in_cap: float | None = None
    equity_multiple: float | None = None
    unsourced_count: int = 0
    approved_at: datetime | None
    updated_at: datetime
    created_at: datetime


class ModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    root_id: uuid.UUID | None
    parent_id: uuid.UUID | None
    name: str
    template: str
    version: int
    status: str
    is_locked: bool
    is_latest: bool
    change_note: str | None
    property_id: uuid.UUID | None
    opportunity_id: uuid.UUID | None
    comp_set_id: uuid.UUID | None
    property_label: str | None = None
    opportunity_label: str | None = None
    assumptions: dict[str, Any]
    scenarios: list[dict[str, Any]]
    outputs: dict[str, Any]
    annual: list[dict[str, Any]]
    warnings: list[str]
    unsourced: list[dict[str, Any]]
    simulation: dict[str, Any] | None
    calculated_at: datetime | None
    submitted_by_id: uuid.UUID | None
    submitted_by_name: str | None = None
    submitted_at: datetime | None
    approved_by_id: uuid.UUID | None
    approved_by_name: str | None = None
    approved_at: datetime | None
    rejected_by_id: uuid.UUID | None
    rejected_at: datetime | None
    decision_note: str | None
    created_by_id: uuid.UUID | None
    created_by_name: str | None = None
    created_at: datetime
    updated_at: datetime
    can_approve_amount: bool = False


class VersionItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    version: int
    status: str
    is_locked: bool
    is_latest: bool
    change_note: str | None
    created_by_name: str | None = None
    created_at: datetime
    approved_at: datetime | None
    purchase_price: float | None = None
    irr: float | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    model_id: uuid.UUID
    action: str
    actor_name: str | None
    at: datetime
    note: str | None
    details: dict[str, Any]


class ModelFacets(BaseModel):
    status: dict[str, int]
    template: dict[str, int]


class DiffOut(BaseModel):
    base_id: uuid.UUID
    other_id: uuid.UUID
    base_version: int
    other_version: int
    assumptions: list[dict[str, Any]]
    outputs: list[dict[str, Any]]
