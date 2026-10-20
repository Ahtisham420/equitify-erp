import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.common.provenance import ProvenanceIn

PartnerType = Literal["individual", "family_office", "fund", "institution", "trust", "sponsor", "other"]
PartnerStatus = Literal["prospect", "active", "inactive"]
Position = Literal["lp", "gp"]
DayCount = Literal["act_365", "act_360", "30_360"]
Compounding = Literal["simple", "annual"]
TierType = Literal["return_of_capital", "preferred_return", "catch_up", "split"]
HurdleType = Literal["none", "irr", "equity_multiple"]
EventType = Literal["call", "distribution", "liquidation"]
PackageType = Literal["property_performance", "portfolio", "valuation", "distributions", "capital_accounts"]
Frequency = Literal["monthly", "quarterly", "annual"]


# --------------------------------------------------------------------------- partners

class PartnerBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: PartnerType = "individual"
    status: PartnerStatus = "active"
    organization_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=40)
    reporting_requirements: str | None = None
    reporting_prefs: dict[str, Any] = {}
    communication_prefs: dict[str, Any] = {}
    portal_user_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] = []


class PartnerCreate(PartnerBase):
    pass


class PartnerUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    type: PartnerType | None = None
    status: PartnerStatus | None = None
    organization_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None
    email: str | None = None
    phone: str | None = None
    reporting_requirements: str | None = None
    reporting_prefs: dict[str, Any] | None = None
    communication_prefs: dict[str, Any] | None = None
    portal_user_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] | None = None


class PartnerListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: str
    status: str
    email: str | None
    organization_id: uuid.UUID | None
    person_id: uuid.UUID | None
    portal_user_id: uuid.UUID | None
    owner_id: uuid.UUID | None
    tags: list[str]
    updated_at: datetime
    commitment: float = 0
    funded: float = 0
    unfunded: float = 0
    investment_count: int = 0
    in_default: bool = False


class PartnerOut(PartnerBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime
    organization_name: str | None = None
    person_name: str | None = None
    portal_user_name: str | None = None
    owner_name: str | None = None
    commitment: float = 0
    funded: float = 0
    unfunded: float = 0
    in_default: bool = False


class PartnerFacets(BaseModel):
    type: dict[str, int]
    status: dict[str, int]


# --------------------------------------------------------------------------- investments

class InvestmentBase(BaseModel):
    asset_id: uuid.UUID
    property_id: uuid.UUID | None = None
    waterfall_id: uuid.UUID | None = None
    commitment: float = Field(ge=0)
    ownership_pct: float = Field(ge=0, le=100)
    pref_rate: float = Field(default=0, ge=0, le=100)
    pref_compounding: Compounding = "simple"
    day_count: DayCount = "act_365"
    waterfall_position: Position = "lp"
    status: Literal["active", "exited"] = "active"
    invested_on: date | None = None
    notes: str | None = None


class InvestmentCreate(InvestmentBase):
    partner_id: uuid.UUID
    provenance: ProvenanceIn = ProvenanceIn(source="Subscription documents", verified=True, confidence=1)


class InvestmentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    property_id: uuid.UUID | None = None
    waterfall_id: uuid.UUID | None = None
    commitment: float | None = Field(default=None, ge=0)
    ownership_pct: float | None = Field(default=None, ge=0, le=100)
    pref_rate: float | None = Field(default=None, ge=0, le=100)
    pref_compounding: Compounding | None = None
    day_count: DayCount | None = None
    waterfall_position: Position | None = None
    status: Literal["active", "exited"] | None = None
    invested_on: date | None = None
    notes: str | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class InvestmentOut(InvestmentBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    partner_id: uuid.UUID
    partner_name: str | None = None
    asset_label: str | None = None
    waterfall_name: str | None = None
    funded: float
    unfunded: float = 0
    updated_at: datetime


# --------------------------------------------------------------------------- waterfalls

class TierIn(BaseModel):
    position: int = Field(ge=1)
    name: str | None = Field(default=None, max_length=120)
    tier_type: TierType
    hurdle_type: HurdleType = "none"
    hurdle_value: float | None = Field(default=None, ge=0)
    lp_share: float = Field(default=1.0, ge=0, le=1)
    gp_share: float = Field(default=0.0, ge=0, le=1)
    catch_up_rate: float = Field(default=1.0, ge=0, le=1)
    catch_up_target: float = Field(default=0.2, ge=0, le=1)


class TierOut(TierIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class WaterfallIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    asset_id: uuid.UUID | None = None
    description: str | None = None
    is_active: bool = True
    tiers: list[TierIn] = Field(min_length=1, max_length=12)


class WaterfallOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    asset_id: uuid.UUID | None
    asset_label: str | None = None
    description: str | None
    version: int
    is_active: bool
    tiers: list[TierOut] = []
    updated_at: datetime


# --------------------------------------------------------------------------- capital events

class EventInputs(BaseModel):
    """Liquidation inputs and call default provisions."""

    gross_proceeds: float | None = Field(default=None, ge=0)
    debt_payoff: float | None = Field(default=None, ge=0)
    closing_costs: float | None = Field(default=None, ge=0)
    reserves: float | None = Field(default=None, ge=0)
    default_rate: float | None = Field(default=None, ge=0, le=100)  # annual % late interest
    grace_days: int | None = Field(default=None, ge=0, le=365)
    penalty_pct: float | None = Field(default=None, ge=0, le=100)
    purpose: str | None = None
    wire_instructions: str | None = None


class EventPreviewIn(BaseModel):
    event_type: EventType
    asset_id: uuid.UUID
    amount: float | None = Field(default=None, ge=0)
    event_date: date
    due_on: date | None = None
    waterfall_id: uuid.UUID | None = None
    inputs: EventInputs = EventInputs()


class EventCreate(EventPreviewIn):
    name: str | None = Field(default=None, max_length=200)
    notes: str | None = None


class EventUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    amount: float | None = Field(default=None, ge=0)
    event_date: date | None = None
    due_on: date | None = None
    waterfall_id: uuid.UUID | None = None
    inputs: EventInputs | None = None
    notes: str | None = None


class DecisionIn(BaseModel):
    note: str | None = None


class ReverseIn(BaseModel):
    reason: str = Field(min_length=3)


class PreviewOut(BaseModel):
    event_type: str
    amount: float
    calc: dict


class EventListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    event_type: str
    name: str
    asset_id: uuid.UUID
    asset_label: str | None = None
    event_date: date
    due_on: date | None
    amount: float
    status: str
    version: int
    approved_version: int | None
    updated_at: datetime


class EventOut(EventListItem):
    property_id: uuid.UUID | None
    waterfall_id: uuid.UUID | None
    waterfall_version: int | None
    inputs: dict
    calc: dict
    notes: str | None
    submitted_by_id: uuid.UUID | None
    submitted_at: datetime | None
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    decision_note: str | None
    posted_by_id: uuid.UUID | None
    posted_at: datetime | None
    reversed_at: datetime | None
    reversal_reason: str | None
    created_by_id: uuid.UUID | None
    actor_names: dict[str, str] = {}
    can_approve: bool = False


class EventVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    amount: float
    inputs: dict
    calc: dict
    created_at: datetime
    created_by_id: uuid.UUID | None


class EventFacets(BaseModel):
    event_type: dict[str, int]
    status: dict[str, int]


class AllocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    event_id: uuid.UUID
    partner_id: uuid.UUID
    investment_id: uuid.UUID
    event_type: str
    amount: float
    tiers: list
    status: str
    due_on: date | None
    funded_amount: float
    funded_on: date | None
    late_interest: float
    penalty_flag: bool
    default_flag: bool
    notice_text: str | None
    paid_on: date | None
    payment_reference: str | None
    partner_name: str | None = None
    event_name: str | None = None
    event_date: date | None = None
    asset_label: str | None = None
    days_late: int = 0
    accrued_late_interest: float = 0


class FundIn(BaseModel):
    amount: float = Field(gt=0)
    funded_on: date
    reference: str | None = Field(default=None, max_length=120)


class DefaultIn(BaseModel):
    default_flag: bool = True
    penalty_flag: bool | None = None
    note: str | None = None


class EntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    partner_id: uuid.UUID
    investment_id: uuid.UUID
    asset_id: uuid.UUID
    event_id: uuid.UUID | None
    allocation_id: uuid.UUID | None
    entry_type: str
    component: str | None
    amount: float
    effective_on: date
    memo: str | None
    reverses_entry_id: uuid.UUID | None
    created_at: datetime
    created_by_id: uuid.UUID | None
    reversed: bool = False


class IncomeAllocationIn(BaseModel):
    amount: float  # positive income, negative loss
    effective_on: date
    memo: str | None = Field(default=None, max_length=500)


class AccountSummary(BaseModel):
    investment_id: uuid.UUID
    partner_id: uuid.UUID
    asset_id: uuid.UUID
    asset_label: str | None = None
    position: str
    ownership_pct: float
    commitment: float
    contributions: float
    distributions: float
    return_of_capital: float
    preferred_paid: float
    profit_distributions: float
    income_allocated: float
    loss_allocated: float
    unreturned_capital: float
    accrued_pref: float
    pref_accrued_total: float
    unfunded: float
    ending_balance: float


class StatementOut(BaseModel):
    partner_id: uuid.UUID
    as_of: date
    accounts: list[AccountSummary]
    totals: dict[str, float]
    entries: list[EntryOut]


# --------------------------------------------------------------------------- reports

class PackageCreate(BaseModel):
    partner_id: uuid.UUID | None = None  # None → every active partner (optionally limited to asset_id)
    asset_id: uuid.UUID | None = None
    period_start: date
    period_end: date
    package_types: list[PackageType] = Field(min_length=1)
    title: str | None = Field(default=None, max_length=200)


class PackageListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    partner_id: uuid.UUID
    partner_name: str | None = None
    asset_id: uuid.UUID | None
    schedule_id: uuid.UUID | None
    title: str
    package_types: list[str]
    period_start: date
    period_end: date
    status: str
    generated_at: datetime
    issued_at: datetime | None


class PackageOut(PackageListItem):
    snapshot: dict
    excluded: list


class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    partner_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    package_types: list[PackageType] = Field(min_length=1)
    frequency: Frequency = "quarterly"
    next_run_on: date
    is_active: bool = True
    auto_issue: bool = False


class ScheduleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    package_types: list[PackageType] | None = None
    frequency: Frequency | None = None
    next_run_on: date | None = None
    is_active: bool | None = None
    auto_issue: bool | None = None


class ScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    partner_id: uuid.UUID | None
    partner_name: str | None = None
    asset_id: uuid.UUID | None
    package_types: list[str]
    frequency: str
    next_run_on: date
    is_active: bool
    auto_issue: bool
    last_run_at: datetime | None


class AssetOption(BaseModel):
    id: uuid.UUID
    label: str
    property_id: uuid.UUID | None = None
    status: str | None = None


class PortalOut(BaseModel):
    partners: list[PartnerOut]
    investments: list[InvestmentOut]
    capital_accounts: list[AccountSummary]
    totals: dict[str, float]
    distributions: list[AllocationOut]
    capital_calls: list[AllocationOut]
    documents: list[dict]
    reports: list[PackageListItem]
