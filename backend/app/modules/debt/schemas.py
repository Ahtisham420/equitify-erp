import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

LoanStatus = Literal["active", "paid_off", "defeased", "refinanced", "default"]
RateType = Literal["fixed", "floating"]
Recourse = Literal["non_recourse", "partial", "full"]
Frequency = Literal["monthly", "quarterly", "semiannual", "annual"]
CovenantKind = Literal["dscr", "debt_yield", "ltv", "occupancy", "net_worth"]


class GuarantorIn(BaseModel):
    kind: Literal["person", "organization"] = "organization"
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    name: str | None = None
    guaranty_type: Literal["payment", "carveout", "completion", "environmental", "other"] = "carveout"
    limit_amount: float | None = Field(default=None, ge=0)


class StepDownIn(BaseModel):
    until: date
    pct: float = Field(ge=0, le=100)


class PrepaymentIn(BaseModel):
    type: Literal["none", "open", "lockout", "yield_maintenance", "defeasance", "step_down"] = "none"
    lockout_end: date | None = None
    open_from: date | None = None
    step_down: list[StepDownIn] = []
    ym_floor_pct: float | None = Field(default=None, ge=0, le=100)
    treasury_rate: float | None = Field(default=None, ge=0, le=100)
    defeasance_fee: float | None = Field(default=None, ge=0)
    notes: str | None = None


class LoanBase(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    loan_number: str | None = Field(default=None, max_length=80)
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    lender_organization_id: uuid.UUID | None = None
    lender_name: str | None = Field(default=None, max_length=200)
    loan_type: str = "senior"
    original_balance: float | None = Field(default=None, ge=0)
    current_balance: float | None = Field(default=None, ge=0)
    originated_on: date | None = None
    maturity_on: date | None = None
    extension_options: list[dict[str, Any]] = []
    rate_type: RateType = "fixed"
    rate: float | None = Field(default=None, ge=0, le=100)
    index_name: str | None = None
    spread: float | None = Field(default=None, ge=-100, le=100)
    rate_floor: float | None = Field(default=None, ge=0, le=100)
    amortization_months: int | None = Field(default=None, ge=0, le=600)
    io_months: int | None = Field(default=None, ge=0, le=600)
    recourse: Recourse = "non_recourse"
    recourse_notes: str | None = None
    guarantors: list[GuarantorIn] = []
    prepayment: PrepaymentIn = PrepaymentIn()
    cap_strike: float | None = Field(default=None, ge=0, le=100)
    cap_provider: str | None = None
    cap_expires_on: date | None = None
    swap_rate: float | None = Field(default=None, ge=0, le=100)
    swap_expires_on: date | None = None
    status: LoanStatus = "active"
    owner_id: uuid.UUID | None = None
    notes: str | None = None


class LoanCreate(LoanBase):
    pass


class LoanUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    loan_number: str | None = None
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    lender_organization_id: uuid.UUID | None = None
    lender_name: str | None = None
    loan_type: str | None = None
    original_balance: float | None = Field(default=None, ge=0)
    current_balance: float | None = Field(default=None, ge=0)
    originated_on: date | None = None
    maturity_on: date | None = None
    extension_options: list[dict[str, Any]] | None = None
    rate_type: RateType | None = None
    rate: float | None = Field(default=None, ge=0, le=100)
    index_name: str | None = None
    spread: float | None = Field(default=None, ge=-100, le=100)
    rate_floor: float | None = Field(default=None, ge=0, le=100)
    amortization_months: int | None = Field(default=None, ge=0, le=600)
    io_months: int | None = Field(default=None, ge=0, le=600)
    recourse: Recourse | None = None
    recourse_notes: str | None = None
    guarantors: list[GuarantorIn] | None = None
    prepayment: PrepaymentIn | None = None
    cap_strike: float | None = Field(default=None, ge=0, le=100)
    cap_provider: str | None = None
    cap_expires_on: date | None = None
    swap_rate: float | None = Field(default=None, ge=0, le=100)
    swap_expires_on: date | None = None
    status: LoanStatus | None = None
    owner_id: uuid.UUID | None = None
    notes: str | None = None
    # history context for material changes
    effective_on: date | None = None
    change_note: str | None = None


class LoanListItem(BaseModel):
    id: uuid.UUID
    name: str | None
    loan_number: str | None
    label: str
    property_id: uuid.UUID | None
    property_label: str | None
    asset_id: uuid.UUID | None
    lender_name: str | None
    loan_type: str
    current_balance: float | None
    rate: float | None
    rate_type: str
    maturity_on: date | None
    months_to_maturity: int | None
    in_refi_window: bool
    cap_expires_on: date | None
    status: str
    covenant_state: str
    updated_at: datetime


class CollateralOut(BaseModel):
    id: uuid.UUID
    property_id: uuid.UUID
    property_label: str | None
    allocated_amount: float | None
    release_price: float | None
    is_primary: bool


class LoanOut(LoanBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str = ""
    property_label: str | None = None
    lender_label: str | None = None
    owner_name: str | None = None
    covenant_state: str
    annual_debt_service: float | None = None
    months_to_maturity: int | None = None
    refi_window_opens_on: date | None = None
    in_refi_window: bool = False
    collateral: list[CollateralOut] = []
    reserve_balance: float = 0
    created_at: datetime
    updated_at: datetime


class LoanFacets(BaseModel):
    status: dict[str, int]
    rate_type: dict[str, int]
    loan_type: dict[str, int]
    covenant_state: dict[str, int]
    lender_name: dict[str, int]


class LoanEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    event_type: str
    at: datetime
    effective_on: date | None
    field: str | None
    from_value: Any
    to_value: Any
    note: str | None
    actor_name: str | None


class CollateralIn(BaseModel):
    property_id: uuid.UUID
    allocated_amount: float | None = Field(default=None, ge=0)
    release_price: float | None = Field(default=None, ge=0)


class CovenantIn(BaseModel):
    kind: CovenantKind
    label: str | None = None
    operator: Literal["min", "max"] | None = None
    threshold: float
    watch_threshold: float | None = None
    frequency: Frequency = "quarterly"
    next_test_on: date | None = None
    cure_period_days: int | None = Field(default=None, ge=0)
    is_active: bool = True
    notes: str | None = None


class CovenantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    loan_id: uuid.UUID
    loan_label: str | None = None
    property_id: uuid.UUID | None = None
    property_label: str | None = None
    kind: str
    label: str | None
    operator: str
    threshold: float
    watch_threshold: float | None
    effective_watch: float | None = None
    frequency: str
    next_test_on: date | None
    cure_period_days: int | None
    is_active: bool
    last_state: str | None
    last_projected_state: str | None
    last_value: float | None = None
    last_projected_value: float | None = None
    last_tested_on: date | None = None
    notes: str | None


class CovenantTestIn(BaseModel):
    test_date: date | None = None
    manual_value: float | None = None
    notes: str | None = None


class CovenantTestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    covenant_id: uuid.UUID
    loan_id: uuid.UUID
    test_date: date
    period_start: date | None
    period_end: date | None
    measured_value: float | None
    threshold: float
    state: str
    projected_value: float | None
    projected_state: str | None
    projected_on: date | None
    inputs: dict[str, Any]
    basis: str
    is_manual: bool
    notes: str | None
    created_at: datetime


class ReserveIn(BaseModel):
    reserve_type: str = "replacement"
    label: str | None = None
    required_amount: float | None = Field(default=None, ge=0)
    monthly_deposit: float | None = Field(default=None, ge=0)
    cap_amount: float | None = Field(default=None, ge=0)
    release_conditions: str | None = None
    notes: str | None = None


class ReserveOut(ReserveIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    loan_id: uuid.UUID
    balance: float
    funded_pct: float | None = None
    updated_at: datetime


class ReserveTxnIn(BaseModel):
    kind: Literal["deposit", "release", "adjustment"]
    amount: float
    occurred_on: date
    document_id: uuid.UUID | None = None
    memo: str | None = None


class ReserveTxnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    reserve_id: uuid.UUID
    loan_id: uuid.UUID
    kind: str
    amount: float
    occurred_on: date
    balance_after: float
    document_id: uuid.UUID | None
    memo: str | None
    created_at: datetime
    created_by_id: uuid.UUID | None


class ObligationIn(BaseModel):
    report_type: str = "operating_statement"
    label: str | None = None
    frequency: Frequency = "quarterly"
    days_after_period: int = Field(default=45, ge=0, le=365)
    next_due_on: date | None = None
    owner_id: uuid.UUID | None = None
    is_active: bool = True
    notes: str | None = None


class ObligationOut(ObligationIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    loan_id: uuid.UUID
    owner_name: str | None = None
    last_submitted_on: date | None
    critical_date_id: uuid.UUID | None
    task_id: uuid.UUID | None
    overdue: bool = False
    updated_at: datetime


class SubmitIn(BaseModel):
    submitted_on: date | None = None
    document_id: uuid.UUID | None = None
    note: str | None = None


class MarketTerms(BaseModel):
    rate: float = Field(6.5, ge=0, le=100)
    ltv: float = Field(60, ge=0, le=100)
    dscr: float = Field(1.25, ge=0)
    debt_yield: float = Field(9.0, ge=0, le=100)
    amort_years: float = Field(30, ge=0, le=50)
    cap_rate: float = Field(7.0, gt=0, le=100)
    treasury_rate: float = Field(4.25, ge=0, le=100)
    sale_cost_pct: float = Field(2.5, ge=0, le=100)
    refi_cost_pct: float = Field(1.0, ge=0, le=100)


class DebtSettingsIn(BaseModel):
    maturity_lead_months: list[int] = Field(default=[24, 12, 6, 3], min_length=1)
    refi_window_months: int = Field(18, ge=1, le=120)
    cap_lead_days: list[int] = Field(default=[90, 30], min_length=1)
    covenant_watch_buffer_pct: float = Field(10, ge=0, le=100)
    projection_quarters: int = Field(2, ge=1, le=8)
    market: MarketTerms = MarketTerms()
