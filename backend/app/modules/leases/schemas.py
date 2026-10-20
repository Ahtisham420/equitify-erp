import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.common.provenance import ObservationOut, ProvenanceIn

LeaseStatus = Literal["draft", "active", "expired", "terminated"]


class CitationIn(BaseModel):
    document_id: uuid.UUID | None = None
    page: int | None = Field(default=None, ge=1)
    clause_ref: str | None = Field(default=None, max_length=80)
    quoted_text: str | None = None


class CitationOut(CitationIn):
    model_config = ConfigDict(from_attributes=True)


class VerificationOut(BaseModel):
    verified: bool
    ai_extracted: bool
    confidence: float | None
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None


# --------------------------------------------------------------------------- lease

class LeaseBase(BaseModel):
    property_id: uuid.UUID
    space_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    tenant_organization_id: uuid.UUID | None = None
    tenant_name: str = Field(min_length=1, max_length=200)
    landlord_name: str | None = None
    premises_description: str | None = None
    status: LeaseStatus = "draft"
    lease_type: str = "nnn"
    execution_on: date | None = None
    commencement_on: date | None = None
    rent_commencement_on: date | None = None
    expiration_on: date | None = None
    rentable_sf: float | None = Field(default=None, ge=0)
    pro_rata_share: float | None = Field(default=None, ge=0, le=100)
    base_rent_annual: float | None = Field(default=None, ge=0)
    security_deposit: float | None = Field(default=None, ge=0)
    late_fee_grace_days: int | None = Field(default=None, ge=0, le=90)
    late_fee_pct: float | None = Field(default=None, ge=0, le=100)
    late_fee_flat: float | None = Field(default=None, ge=0)
    market_rent_psf: float | None = Field(default=None, ge=0)
    renewal_probability: float | None = Field(default=None, ge=0, le=1)
    downtime_months: int | None = Field(default=None, ge=0, le=60)
    releasing_cost_psf: float | None = Field(default=None, ge=0)
    citations: dict[str, CitationIn] = {}
    manager_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] = []


class LeaseCreate(LeaseBase):
    provenance: ProvenanceIn = ProvenanceIn()


class LeaseUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    space_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    tenant_organization_id: uuid.UUID | None = None
    tenant_name: str | None = Field(default=None, min_length=1, max_length=200)
    landlord_name: str | None = None
    premises_description: str | None = None
    status: LeaseStatus | None = None
    lease_type: str | None = None
    execution_on: date | None = None
    commencement_on: date | None = None
    rent_commencement_on: date | None = None
    expiration_on: date | None = None
    rentable_sf: float | None = Field(default=None, ge=0)
    pro_rata_share: float | None = Field(default=None, ge=0, le=100)
    base_rent_annual: float | None = Field(default=None, ge=0)
    security_deposit: float | None = Field(default=None, ge=0)
    late_fee_grace_days: int | None = Field(default=None, ge=0, le=90)
    late_fee_pct: float | None = Field(default=None, ge=0, le=100)
    late_fee_flat: float | None = Field(default=None, ge=0)
    market_rent_psf: float | None = Field(default=None, ge=0)
    renewal_probability: float | None = Field(default=None, ge=0, le=1)
    downtime_months: int | None = Field(default=None, ge=0, le=60)
    releasing_cost_psf: float | None = Field(default=None, ge=0)
    citations: dict[str, CitationIn] | None = None
    manager_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class LeaseListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    property_name: str | None = None
    space_id: uuid.UUID | None
    suite: str | None = None
    tenant_name: str
    status: str
    lease_type: str
    commencement_on: date | None
    expiration_on: date | None
    rentable_sf: float | None
    current_annual_rent: float | None = None
    rent_psf: float | None = None
    verified: bool
    ai_extracted: bool
    updated_at: datetime


class LeaseOut(LeaseBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    escalation: dict = {}
    citations: dict[str, CitationOut] = {}  # type: ignore[assignment]
    verified: bool
    ai_extracted: bool
    confidence: float | None
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None
    property_name: str | None = None
    suite: str | None = None
    manager_name: str | None = None
    current_annual_rent: float | None = None
    unverified_items: int = 0
    provenance: dict[str, ObservationOut] = {}
    created_at: datetime
    updated_at: datetime


class LeaseFacets(BaseModel):
    status: dict[str, int]
    lease_type: dict[str, int]
    verified: dict[str, int]
    expiring: dict[str, int]


# --------------------------------------------------------------------------- rent schedule

class RentStepIn(CitationIn):
    start_on: date
    end_on: date
    annual_rent: float = Field(ge=0)
    rent_psf: float | None = None
    charge_type: str = "base_rent"
    amendment_id: uuid.UUID | None = None
    note: str | None = None


class RentStepOut(CitationOut):
    id: uuid.UUID
    lease_id: uuid.UUID
    amendment_id: uuid.UUID | None
    start_on: date
    end_on: date
    annual_rent: float
    monthly_rent: float
    rent_psf: float | None
    charge_type: str
    source: str
    note: str | None


class StepTableRow(BaseModel):
    start_on: date
    end_on: date | None = None
    annual_rent: float | None = Field(default=None, ge=0)
    rent_psf: float | None = Field(default=None, ge=0)


class EscalationIn(BaseModel):
    """Escalation mechanics stored on the lease and used to build rent steps."""

    method: Literal["flat", "fixed_pct", "fixed_amount", "cpi", "step_table"] = "fixed_pct"
    base_annual_rent: float | None = Field(default=None, ge=0)
    base_rent_psf: float | None = Field(default=None, ge=0)
    start_on: date | None = None
    end_on: date | None = None
    frequency_months: int = Field(default=12, ge=1, le=120)
    pct: float | None = Field(default=None, ge=-50, le=100)  # fixed_pct
    amount: float | None = None  # fixed_amount: annual $ increase per period
    cpi_assumed_pct: float | None = Field(default=None, ge=-20, le=50)
    cpi_floor_pct: float | None = Field(default=None, ge=-20, le=50)
    cpi_cap_pct: float | None = Field(default=None, ge=-20, le=50)
    free_rent_months: int = Field(default=0, ge=0, le=60)
    steps: list[StepTableRow] = []
    replace: bool = True


class OperativeField(BaseModel):
    original: Any = None
    operative: Any = None
    changed: bool = False
    amendment_id: uuid.UUID | None = None
    amendment_title: str | None = None
    effective_on: date | None = None
    verified: bool = True


class OperativeTerms(BaseModel):
    as_of: date
    fields: dict[str, OperativeField]
    rent_steps: list[RentStepOut]
    amendments_applied: list[uuid.UUID]
    pending_amendments: list[uuid.UUID]


class ScheduleRow(BaseModel):
    period_start: date
    period_end: date
    amount: float
    charge_type: str
    lease_id: uuid.UUID | None = None
    source_ref: dict = {}


# --------------------------------------------------------------------------- recoveries / options / clauses

class RecoveryIn(CitationIn):
    method: Literal["nnn", "modified_gross", "base_year", "expense_stop", "fixed_cam"] = "nnn"
    category: Literal["all", "cam", "tax", "insurance", "utilities"] = "all"
    pro_rata_share: float | None = Field(default=None, ge=0, le=100)
    base_year: int | None = None
    base_amount: float | None = Field(default=None, ge=0)
    expense_stop_psf: float | None = Field(default=None, ge=0)
    fixed_amount_annual: float | None = Field(default=None, ge=0)
    estimated_monthly: float | None = Field(default=None, ge=0)
    cap_type: Literal["none", "cumulative", "non_cumulative"] = "none"
    cap_pct: float | None = Field(default=None, ge=0, le=100)
    cap_base_amount: float | None = Field(default=None, ge=0)
    cap_base_year: int | None = None
    admin_fee_pct: float | None = Field(default=None, ge=0, le=100)
    gross_up_pct: float | None = Field(default=None, ge=0, le=100)
    exclusions: list[str] = []
    notes: str | None = None
    ai_extracted: bool = False
    confidence: float | None = Field(default=None, ge=0, le=1)


class RecoveryOut(RecoveryIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    lease_id: uuid.UUID
    verified: bool
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None


class OptionIn(CitationIn):
    option_type: Literal["renewal", "expansion", "termination", "purchase", "rofr", "rofo"]
    sequence: int = Field(default=1, ge=1)
    term_months: int | None = Field(default=None, ge=0)
    notice_start_on: date | None = None
    notice_end_on: date | None = None
    effective_on: date | None = None
    pricing_method: Literal["fixed_rent", "fixed_increase", "fmv", "pct_of_fmv", "fixed_price", "fee", "matching", "none"] = "none"
    pricing_params: dict = {}
    option_rent_psf: float | None = Field(default=None, ge=0)
    increase_pct: float | None = None
    fmv_pct: float | None = Field(default=None, ge=0, le=200)
    fee_amount: float | None = Field(default=None, ge=0)
    purchase_price: float | None = Field(default=None, ge=0)
    market_rent_psf: float | None = Field(default=None, ge=0)
    space_description: str | None = None
    conditions: str | None = None
    status: Literal["open", "exercised", "waived", "expired"] = "open"
    exercised_on: date | None = None
    ai_extracted: bool = False
    confidence: float | None = Field(default=None, ge=0, le=1)


class OptionEconomics(BaseModel):
    current_rent_psf: float | None = None
    option_rent_psf: float | None = None
    market_rent_psf: float | None = None
    delta_psf: float | None = None
    annual_delta: float | None = None
    term_value: float | None = None
    favors: Literal["tenant", "landlord", "neutral"] | None = None
    remaining_rent: float | None = None
    fee_amount: float | None = None
    purchase_price: float | None = None
    market_value: float | None = None
    note: str | None = None


class OptionOut(OptionIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    lease_id: uuid.UUID
    verified: bool
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None
    economics: OptionEconomics | None = None


class ClauseIn(CitationIn):
    category: str = Field(min_length=1, max_length=30)
    title: str = Field(min_length=1, max_length=200)
    summary: str | None = None
    terms: dict = {}
    obligated_party: Literal["landlord", "tenant", "guarantor"] | None = None
    due_on: date | None = None
    recurrence: Literal["once", "monthly", "quarterly", "annual"] | None = None
    response_days: int | None = Field(default=None, ge=0)
    amendment_id: uuid.UUID | None = None
    ai_extracted: bool = False
    confidence: float | None = Field(default=None, ge=0, le=1)


class ClauseOut(ClauseIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    lease_id: uuid.UUID
    verified: bool
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None
    updated_at: datetime


class AmendmentIn(BaseModel):
    kind: Literal["amendment", "assignment", "guaranty", "side_letter", "renewal", "commencement_letter", "other"] = "amendment"
    title: str = Field(min_length=1, max_length=200)
    executed_on: date | None = None
    effective_on: date
    document_id: uuid.UUID | None = None
    page: int | None = Field(default=None, ge=1)
    clause_ref: str | None = None
    overrides: dict[str, Any] = {}
    summary: str | None = None
    rent_steps: list[RentStepIn] = []


class AmendmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    lease_id: uuid.UUID
    kind: str
    sequence: int
    title: str
    executed_on: date | None
    effective_on: date
    document_id: uuid.UUID | None
    page: int | None
    clause_ref: str | None
    overrides: dict
    summary: str | None
    verified: bool
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None
    created_at: datetime


class GuarantyIn(CitationIn):
    guarantor_name: str = Field(min_length=1, max_length=200)
    guarantor_organization_id: uuid.UUID | None = None
    guarantor_person_id: uuid.UUID | None = None
    guaranty_type: Literal["full", "limited", "good_guy", "burn_down", "corporate", "personal"] = "full"
    cap_amount: float | None = Field(default=None, ge=0)
    effective_on: date | None = None
    expires_on: date | None = None
    burn_down: list[dict] = []
    financials_required: bool = False
    financials_due_on: date | None = None
    estoppel_days: int | None = Field(default=None, ge=0)
    status: Literal["active", "released", "expired"] = "active"
    notes: str | None = None
    ai_extracted: bool = False
    confidence: float | None = Field(default=None, ge=0, le=1)


class GuarantyOut(GuarantyIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    lease_id: uuid.UUID
    verified: bool
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None


class VerifyIn(BaseModel):
    verified: bool = True


# --------------------------------------------------------------------------- rent roll / rollover

class RentRollRow(BaseModel):
    id: str
    lease_id: uuid.UUID | None
    property_id: uuid.UUID
    property_name: str | None = None
    space_id: uuid.UUID | None
    suite: str | None
    tenant_name: str | None
    lease_type: str | None
    status: str
    sf: float | None
    annual_rent: float | None
    monthly_rent: float | None
    rent_psf: float | None
    commencement_on: date | None
    expiration_on: date | None
    remaining_years: float | None
    verified: bool | None


class RentRollTotals(BaseModel):
    leased_sf: float
    vacant_sf: float
    total_sf: float
    occupancy_pct: float | None
    annual_rent: float
    monthly_rent: float
    avg_rent_psf: float | None
    wale_years: float | None
    tenant_count: int


class RentRoll(BaseModel):
    property_id: uuid.UUID | None
    as_of: date
    rows: list[RentRollRow]
    totals: RentRollTotals


class RolloverYear(BaseModel):
    year: int
    lease_count: int
    sf: float
    rent_at_risk: float
    pct_of_rent: float
    renewal_probability: float | None
    expected_downtime_cost: float
    expected_releasing_cost: float
    lease_ids: list[uuid.UUID]


class Rollover(BaseModel):
    property_id: uuid.UUID | None
    as_of: date
    total_rent: float
    years: list[RolloverYear]


# --------------------------------------------------------------------------- reconciliation

class ReconRunIn(BaseModel):
    property_id: uuid.UUID
    year: int = Field(ge=1990, le=2100)
    budgeted: dict[str, float] = {}
    actual: dict[str, float] = {}
    total_sf: float | None = Field(default=None, gt=0)
    lease_ids: list[uuid.UUID] | None = None


class ReconciliationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    lease_id: uuid.UUID
    property_id: uuid.UUID
    tenant_name: str | None = None
    year: int
    budgeted_pool: dict
    actual_pool: dict
    share_pct: float | None
    budgeted_share: float
    actual_share: float
    cap_reduction: float
    estimates_billed: float
    true_up_amount: float
    details: list
    status: str
    finalized_at: datetime | None
    billed_charge_id: uuid.UUID | None
    updated_at: datetime


class ReconRunOut(BaseModel):
    created: int
    updated: int
    skipped_locked: int
    items: list[ReconciliationOut]


class SpaceOption(BaseModel):
    id: uuid.UUID
    suite: str
    area_sf: float | None
    occupancy_status: str
    tenant_name: str | None


class CriticalDatesOut(BaseModel):
    generated: int
    skipped_unverified: int
    available: bool


__all__ = ["ObservationOut"]
