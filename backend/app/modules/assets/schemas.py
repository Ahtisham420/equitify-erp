import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.common.provenance import ProvenanceIn

AssetStatus = Literal["active", "held_for_sale", "disposed"]
FinCategory = Literal["income", "expense", "capex", "debt_service", "reserve", "distribution"]
MilestoneStatus = Literal["planned", "in_progress", "done", "missed", "cancelled"]
Dimension = Literal["tenant", "brand", "industry", "guarantor", "lender", "geography"]
GroupBy = Literal["property_type", "tenant", "geography", "corridor", "vintage", "lender", "capital_partner", "territory"]


class AssetBase(BaseModel):
    status: AssetStatus = "active"
    acquired_on: date | None = None
    basis: float | None = Field(default=None, ge=0)
    equity_invested: float | None = Field(default=None, ge=0)
    current_value: float | None = Field(default=None, ge=0)
    value_as_of: date | None = None
    hold_thesis: str | None = None
    business_plan: str | None = None
    target_hold_years: float | None = Field(default=None, ge=0, le=100)
    exit_cap_rate: float | None = Field(default=None, ge=0, le=100)
    target_exit_on: date | None = None
    exit_assumptions: dict[str, Any] = {}
    manager_id: uuid.UUID | None = None
    uw_model_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    notes: str | None = None


class AssetCreate(AssetBase):
    property_id: uuid.UUID
    provenance: ProvenanceIn = ProvenanceIn()


class AssetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: AssetStatus | None = None
    acquired_on: date | None = None
    basis: float | None = Field(default=None, ge=0)
    equity_invested: float | None = Field(default=None, ge=0)
    current_value: float | None = Field(default=None, ge=0)
    value_as_of: date | None = None
    hold_thesis: str | None = None
    business_plan: str | None = None
    target_hold_years: float | None = Field(default=None, ge=0, le=100)
    exit_cap_rate: float | None = Field(default=None, ge=0, le=100)
    target_exit_on: date | None = None
    exit_assumptions: dict[str, Any] | None = None
    manager_id: uuid.UUID | None = None
    uw_model_id: uuid.UUID | None = None
    notes: str | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class Metric(BaseModel):
    """A KPI value with the href(s) of the records it is computed from."""

    value: float | None = None
    label: str | None = None
    source: str | None = None
    drill: list[dict[str, str]] = []


class AssetListItem(BaseModel):
    id: uuid.UUID
    property_id: uuid.UUID
    property_label: str
    city: str | None
    state: str | None
    property_type: str | None
    status: str
    acquired_on: date | None
    basis: float | None
    current_value: float | None
    manager_id: uuid.UUID | None
    manager_name: str | None = None
    noi_ttm: float | None = None
    occupancy: float | None = None
    leverage: float | None = None
    coverage: float | None = None
    yield_on_cost: float | None = None
    open_watch: int = 0
    updated_at: datetime


class AssetOut(AssetBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    closing_id: uuid.UUID | None
    disposed_on: date | None
    created_at: datetime
    updated_at: datetime
    property_label: str = ""
    address_line: str | None = None
    city: str | None = None
    state: str | None = None
    county: str | None = None
    property_type: str | None = None
    corridor: str | None = None
    manager_name: str | None = None
    kpis: dict[str, Metric] = {}
    capital_structure: dict[str, Any] = {}
    benchmark: dict[str, Any] | None = None


class AssetFacets(BaseModel):
    status: dict[str, int]
    property_type: dict[str, int]
    state: dict[str, int]


class FinancialIn(BaseModel):
    period: date
    account: str = Field(min_length=1, max_length=120)
    category: FinCategory
    amount: float
    notes: str | None = None


class FinancialBulkIn(BaseModel):
    rows: list[FinancialIn] = Field(min_length=1, max_length=5000)
    source: Literal["manual", "import"] = "import"


class FinancialOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_id: uuid.UUID
    period: date
    account: str
    category: str
    amount: float
    source: str
    verified: bool
    verified_at: datetime | None
    is_current: bool
    notes: str | None
    created_at: datetime
    created_by_id: uuid.UUID | None


class VerifyPeriodsIn(BaseModel):
    period_from: date
    period_to: date


class MilestoneIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    owner_id: uuid.UUID | None = None
    due_on: date | None = None
    status: MilestoneStatus = "planned"


class MilestoneUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    owner_id: uuid.UUID | None = None
    due_on: date | None = None
    status: MilestoneStatus | None = None


class MilestoneOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_id: uuid.UUID
    title: str
    description: str | None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    due_on: date | None
    status: str
    completed_on: date | None
    task_id: uuid.UUID | None
    overdue: bool = False
    updated_at: datetime


class ExplainIn(BaseModel):
    period: date
    window: Literal["month", "ttm"] = "month"
    basis: Literal["budget", "underwriting"] = "budget"
    account: str = Field(min_length=1, max_length=120)
    actual: float | None = None
    benchmark: float | None = None
    explanation: str = Field(min_length=3)
    owner_id: uuid.UUID | None = None


class ExplanationText(BaseModel):
    explanation: str = Field(min_length=3)


class ReviewIn(BaseModel):
    decision: Literal["accepted", "rejected"]
    note: str | None = None


class VarianceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_id: uuid.UUID
    asset_label: str | None = None
    period: date
    window: str
    basis: str
    account: str
    actual: float | None
    benchmark: float | None
    variance: float | None
    variance_pct: float | None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    explanation: str | None
    status: str
    submitted_at: datetime | None
    reviewed_at: datetime | None
    review_note: str | None
    created_at: datetime


class LimitIn(BaseModel):
    dimension: Dimension
    key: str | None = None
    max_pct: float = Field(gt=0, le=100)
    severity: Literal["low", "medium", "high", "critical"] = "medium"
    is_active: bool = True
    notes: str | None = None


class LimitOut(LimitIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    updated_at: datetime


class TenantProfileIn(BaseModel):
    tenant_name: str = Field(min_length=1, max_length=200)
    organization_id: uuid.UUID | None = None
    brand: str | None = None
    industry: str | None = None
    credit_rating: str | None = None
    credit_watch: bool = False
    notes: str | None = None


class TenantProfileOut(TenantProfileIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    tenant_key: str
    updated_at: datetime


class WatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_id: uuid.UUID
    asset_label: str | None = None
    trigger: str
    severity: str
    status: str
    detail: str | None
    metric_value: float | None
    threshold: float | None
    source_href: str | None
    first_detected_at: datetime
    last_detected_at: datetime
    resolved_at: datetime | None
    resolution_note: str | None
    alert_id: uuid.UUID | None


class WatchResolveIn(BaseModel):
    status: Literal["resolved", "dismissed"] = "resolved"
    note: str = Field(min_length=3)


class SettingsIn(BaseModel):
    variance_pct: float = Field(ge=0, le=1000)
    variance_amount: float = Field(ge=0)
    watch_min_dscr: float = Field(ge=0)
    watch_min_occupancy: float = Field(ge=0, le=100)
    maturity_months: int = Field(ge=1, le=120)
    persistent_variance_months: int = Field(ge=2, le=24)
    maintenance_backlog: int = Field(ge=1)
    maintenance_overdue_days: int = Field(ge=1)
