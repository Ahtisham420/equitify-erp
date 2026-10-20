import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Stage = Literal["candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed", "withdrawn"]


class CostLine(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    amount: float = Field(ge=0)


class TaxInputs(BaseModel):
    tax_basis: float | None = Field(default=None, ge=0)
    accumulated_depreciation: float | None = Field(default=None, ge=0)
    cap_gains_rate: float = Field(20, ge=0, le=100)
    recapture_rate: float = Field(25, ge=0, le=100)
    state_rate: float = Field(0, ge=0, le=100)
    niit_rate: float = Field(3.8, ge=0, le=100)


class DispositionCreate(BaseModel):
    asset_id: uuid.UUID
    name: str | None = Field(default=None, max_length=200)
    owner_id: uuid.UUID | None = None
    reason: str | None = None
    is_1031: bool = False
    target_price: float | None = Field(default=None, ge=0)


class DispositionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    owner_id: uuid.UUID | None = None
    reason: str | None = None
    is_1031: bool | None = None
    target_price: float | None = Field(default=None, ge=0)
    list_price: float | None = Field(default=None, ge=0)
    pricing_notes: str | None = None
    broker_organization_id: uuid.UUID | None = None
    broker_name: str | None = None
    commission_pct: float | None = Field(default=None, ge=0, le=100)
    marketing_launched_on: date | None = None
    offers_due_on: date | None = None
    buyer_organization_id: uuid.UUID | None = None
    buyer_name: str | None = None
    contract_price: float | None = Field(default=None, ge=0)
    contract_executed_on: date | None = None
    dd_expires_on: date | None = None
    target_closing_on: date | None = None
    closed_on: date | None = None
    sale_price: float | None = Field(default=None, ge=0)
    cost_lines: list[CostLine] | None = None
    tax_inputs: TaxInputs | None = None
    notes: str | None = None


class DispositionListItem(BaseModel):
    id: uuid.UUID
    name: str
    asset_id: uuid.UUID
    property_id: uuid.UUID
    property_label: str
    city: str | None
    state: str | None
    stage: str
    stage_entered_at: datetime
    days_in_stage: int
    owner_id: uuid.UUID | None
    owner_name: str | None
    is_1031: bool
    target_price: float | None
    best_offer: float | None
    offer_count: int
    contract_price: float | None
    target_closing_on: date | None
    next_exchange_deadline: date | None
    updated_at: datetime


class DispositionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    asset_id: uuid.UUID
    property_id: uuid.UUID
    name: str
    stage: str
    stage_entered_at: datetime
    owner_id: uuid.UUID | None
    reason: str | None
    is_1031: bool
    target_price: float | None
    list_price: float | None
    pricing_notes: str | None
    broker_organization_id: uuid.UUID | None
    broker_name: str | None
    commission_pct: float | None
    marketing_launched_on: date | None
    offers_due_on: date | None
    accepted_offer_id: uuid.UUID | None
    buyer_organization_id: uuid.UUID | None
    buyer_name: str | None
    contract_price: float | None
    contract_executed_on: date | None
    dd_expires_on: date | None
    target_closing_on: date | None
    closed_on: date | None
    sale_price: float | None
    cost_lines: list[dict[str, Any]]
    tax_inputs: dict[str, Any]
    comparison: dict[str, Any]
    comparison_at: datetime | None
    withdrawn_reason: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime
    property_label: str = ""
    city: str | None = None
    state: str | None = None
    owner_name: str | None = None
    asset_status: str | None = None


class DispositionFacets(BaseModel):
    stage: dict[str, int]
    owner_id: dict[str, int]
    is_1031: dict[str, int]


class Requirement(BaseModel):
    key: str
    label: str
    met: bool
    blocking: bool = True
    detail: str | None = None


class StageGate(BaseModel):
    stage: str
    ready: bool
    requirements: list[Requirement]


class GatesOut(BaseModel):
    current_stage: str
    next_stage: str | None
    can_override: bool
    stages: list[StageGate]


class MoveIn(BaseModel):
    to_stage: Stage
    reason: str | None = None
    override: bool = False


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    from_stage: str | None
    to_stage: str
    at: datetime
    actor_name: str | None
    reason: str | None
    override: bool
    unmet: list[Any]


class CompareIn(BaseModel):
    value: float | None = Field(default=None, ge=0)
    noi: float | None = None
    noi_growth_pct: float = Field(2.0, ge=-50, le=50)
    hold_years: int = Field(5, ge=1, le=30)
    exit_cap_rate: float | None = Field(default=None, gt=0, le=100)
    discount_rate: float = Field(8.0, ge=0, le=100)
    sale_cost_pct: float | None = Field(default=None, ge=0, le=100)
    capex_planned: float = Field(0, ge=0)
    remaining_lease_term_years: float | None = Field(default=None, ge=0)
    tax_basis: float | None = Field(default=None, ge=0)
    accumulated_depreciation: float | None = Field(default=None, ge=0)
    land_pct: float = Field(20, ge=0, le=100)
    depreciation_years: float = Field(39, gt=0, le=100)
    cap_gains_rate: float = Field(20, ge=0, le=100)
    recapture_rate: float = Field(25, ge=0, le=100)
    state_rate: float = Field(0, ge=0, le=100)
    niit_rate: float = Field(3.8, ge=0, le=100)
    refi_rate: float | None = Field(default=None, ge=0, le=100)
    refi_ltv: float | None = Field(default=None, ge=0, le=100)
    refi_dscr: float | None = Field(default=None, ge=0)
    refi_debt_yield: float | None = Field(default=None, ge=0, le=100)
    refi_amort_years: float | None = Field(default=None, ge=0, le=50)
    refi_cost_pct: float | None = Field(default=None, ge=0, le=100)
    treasury_rate: float | None = Field(default=None, ge=0, le=100)


class OfferIn(BaseModel):
    buyer_name: str = Field(min_length=1, max_length=200)
    buyer_organization_id: uuid.UUID | None = None
    buyer_person_id: uuid.UUID | None = None
    broker_name: str | None = None
    price: float = Field(gt=0)
    earnest_money: float | None = Field(default=None, ge=0)
    dd_days: int | None = Field(default=None, ge=0, le=365)
    closing_days: int | None = Field(default=None, ge=0, le=730)
    financing_type: Literal["cash", "new_loan", "assumption", "seller_financing"] = "cash"
    contingencies: str | None = None
    received_on: date
    expires_on: date | None = None
    status: Literal["received", "countered", "best_and_final", "backup", "rejected", "withdrawn"] = "received"
    notes: str | None = None


class OfferOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    disposition_id: uuid.UUID
    buyer_name: str
    buyer_organization_id: uuid.UUID | None
    buyer_person_id: uuid.UUID | None
    broker_name: str | None
    price: float
    earnest_money: float | None
    dd_days: int | None
    closing_days: int | None
    financing_type: str
    contingencies: str | None
    received_on: date
    expires_on: date | None
    status: str
    outcome: str | None
    notes: str | None
    created_at: datetime


class RetradeIn(BaseModel):
    offer_id: uuid.UUID | None = None
    buyer_name: str | None = None
    buyer_organization_id: uuid.UUID | None = None
    requested_on: date
    reason_category: Literal["inspection", "environmental", "title_survey", "financing", "appraisal", "tenant", "market", "other"] = "other"
    reason: str = Field(min_length=3)
    amount_requested: float = Field(ge=0)
    notes: str | None = None


class RetradeDecisionIn(BaseModel):
    decision: Literal["pending", "accepted", "countered", "rejected"] | None = None
    agreed_amount: float | None = Field(default=None, ge=0)
    outcome: Literal["pending", "closed", "buyer_walked", "seller_terminated"] | None = None
    notes: str | None = None


class RetradeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    disposition_id: uuid.UUID
    disposition_name: str | None = None
    offer_id: uuid.UUID | None
    buyer_organization_id: uuid.UUID | None
    buyer_name: str
    requested_on: date
    reason_category: str
    reason: str
    amount_requested: float
    decision: str
    agreed_amount: float | None
    decided_on: date | None
    outcome: str
    notes: str | None
    created_at: datetime


class ExchangeIn(BaseModel):
    exchange_type: Literal["forward", "reverse", "improvement"] = "forward"
    status: Literal["planned", "open", "identified", "completed", "failed", "cancelled"] | None = None
    qi_organization_id: uuid.UUID | None = None
    qi_name: str | None = None
    eat_organization_id: uuid.UUID | None = None
    parked_property_id: uuid.UUID | None = None
    start_on: date | None = None
    tax_return_due_on: date | None = None
    identification_rule: Literal["three_property", "two_hundred_percent", "ninety_five_percent"] = "three_property"
    relinquished_sale_price: float | None = Field(default=None, ge=0)
    relinquished_costs: float | None = Field(default=None, ge=0)
    relinquished_debt_paid: float | None = Field(default=None, ge=0)
    relinquished_adjusted_basis: float | None = Field(default=None, ge=0)
    cash_received: float | None = Field(default=None, ge=0)
    additional_cash_invested: float | None = Field(default=None, ge=0)
    improvement_budget: float | None = Field(default=None, ge=0)
    improvement_notes: str | None = None
    notes: str | None = None


class CandidateIn(BaseModel):
    property_id: uuid.UUID | None = None
    description: str | None = Field(default=None, max_length=300)
    is_backup: bool = False
    rank: int = Field(1, ge=1, le=50)
    status: Literal["candidate", "identified", "under_contract", "acquired", "dropped"] = "candidate"
    expected_price: float | None = Field(default=None, ge=0)
    expected_debt: float | None = Field(default=None, ge=0)
    acquired_on: date | None = None
    acquired_price: float | None = Field(default=None, ge=0)
    acquired_debt: float | None = Field(default=None, ge=0)
    notes: str | None = None
