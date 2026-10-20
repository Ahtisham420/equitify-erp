import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CredentialKind = Literal["license", "insurance_coi", "w9", "other"]
Decision = Literal["approved", "rejected"]


class DecisionIn(BaseModel):
    decision: Decision
    note: str | None = None


class ComplianceOut(BaseModel):
    compliant: bool
    reasons: list[str]


# ======================================================================= vendors

class VendorContact(BaseModel):
    name: str
    role: str | None = None
    email: str | None = None
    phone: str | None = None


class VendorRate(BaseModel):
    service: str
    unit: str | None = None  # hour | visit | sf | job
    rate: float | None = None
    notes: str | None = None


class VendorContract(BaseModel):
    title: str
    start_on: date | None = None
    end_on: date | None = None
    value: float | None = None
    document_id: uuid.UUID | None = None


class VendorIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    organization_id: uuid.UUID | None = None
    services: list[str] = []
    status: Literal["active", "pending", "inactive", "suspended"] = "active"
    primary_contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    contacts: list[VendorContact] = []
    rates: list[VendorRate] = []
    contracts: list[VendorContract] = []
    service_area: str | None = None
    requires_insurance: bool = True
    requires_license: bool = False
    notes: str | None = None
    tags: list[str] = []


class VendorUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    organization_id: uuid.UUID | None = None
    services: list[str] | None = None
    status: Literal["active", "pending", "inactive", "suspended"] | None = None
    primary_contact_name: str | None = None
    email: str | None = None
    phone: str | None = None
    address: str | None = None
    contacts: list[VendorContact] | None = None
    rates: list[VendorRate] | None = None
    contracts: list[VendorContract] | None = None
    service_area: str | None = None
    requires_insurance: bool | None = None
    requires_license: bool | None = None
    notes: str | None = None
    tags: list[str] | None = None


class VendorListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    organization_id: uuid.UUID | None
    services: list[str]
    status: str
    primary_contact_name: str | None
    email: str | None
    phone: str | None
    performance_rating: float | None
    tags: list[str]
    updated_at: datetime
    compliant: bool = True
    compliance_reasons: list[str] = []
    next_expiry_on: date | None = None
    spend_ytd: float = 0


class CredentialIn(BaseModel):
    kind: CredentialKind
    name: str = Field(min_length=1, max_length=200)
    number: str | None = None
    issuer: str | None = None
    coverage_amount: float | None = Field(default=None, ge=0)
    effective_on: date | None = None
    expires_on: date | None = None
    is_required: bool = True
    document_id: uuid.UUID | None = None
    verified: bool = False
    notes: str | None = None


class CredentialOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    vendor_id: uuid.UUID
    kind: str
    name: str
    number: str | None
    issuer: str | None
    coverage_amount: float | None
    effective_on: date | None
    expires_on: date | None
    is_required: bool
    status: str
    document_id: uuid.UUID | None
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None
    notes: str | None
    days_to_expiry: int | None = None
    updated_at: datetime


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    quality: int | None = Field(default=None, ge=1, le=5)
    timeliness: int | None = Field(default=None, ge=1, le=5)
    communication: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = None
    work_order_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None


class ReviewOut(ReviewIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    created_by_id: uuid.UUID | None


class VendorOut(VendorListItem):
    address: str | None
    contacts: list
    rates: list
    contracts: list
    service_area: str | None
    requires_insurance: bool
    requires_license: bool
    notes: str | None
    created_at: datetime
    credentials: list[CredentialOut] = []
    reviews: list[ReviewOut] = []
    performance: dict = {}
    spend: dict = {}
    bids: list[dict] = []
    work_orders: list[dict] = []
    certificates: list[dict] = []


class VendorFacets(BaseModel):
    status: dict[str, int]
    services: dict[str, int]


# ======================================================================= capital projects

class Milestone(BaseModel):
    key: str
    label: str
    due_on: date | None = None
    completed_on: date | None = None


class ProjectIn(BaseModel):
    property_id: uuid.UUID
    asset_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    category: str = "other"
    scope: str | None = None
    manager_id: uuid.UUID | None = None
    original_budget: float = Field(ge=0)
    contingency: float | None = Field(default=None, ge=0)
    start_on: date | None = None
    target_completion_on: date | None = None
    milestones: list[Milestone] = []
    useful_life_years: int | None = Field(default=None, ge=1, le=100)
    notes: str | None = None


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    category: str | None = None
    scope: str | None = None
    manager_id: uuid.UUID | None = None
    contingency: float | None = Field(default=None, ge=0)
    start_on: date | None = None
    target_completion_on: date | None = None
    milestones: list[Milestone] | None = None
    warranty_expires_on: date | None = None
    warranty_terms: str | None = None
    useful_life_years: int | None = Field(default=None, ge=1, le=100)
    notes: str | None = None


class BudgetRevisionIn(BaseModel):
    new_budget: float = Field(ge=0)
    reason: str = Field(min_length=3)


class ProjectStatusIn(BaseModel):
    status: Literal["pending_approval", "bidding", "in_progress", "completed", "closed", "cancelled", "draft"]
    note: str | None = None
    actual_completion_on: date | None = None
    warranty_expires_on: date | None = None
    warranty_terms: str | None = None


class ProjectListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    property_name: str | None = None
    asset_id: uuid.UUID | None
    name: str
    category: str
    status: str
    manager_id: uuid.UUID | None
    manager_name: str | None = None
    original_budget: float
    current_budget: float
    contract_amount: float | None
    contractor_vendor_id: uuid.UUID | None
    contractor_name: str | None = None
    start_on: date | None
    target_completion_on: date | None
    actual_completion_on: date | None
    committed: float = 0
    spent: float = 0
    pending_change_orders: int = 0
    updated_at: datetime


class BidIn(BaseModel):
    vendor_id: uuid.UUID
    amount: float = Field(gt=0)
    submitted_on: date | None = None
    valid_until: date | None = None
    duration_days: int | None = Field(default=None, ge=0)
    scope_notes: str | None = None
    document_id: uuid.UUID | None = None


class BidOut(BidIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    status: str
    decision_note: str | None
    vendor_name: str | None = None
    vendor_compliant: bool | None = None
    vendor_compliance_reasons: list[str] = []
    created_at: datetime


class BidStatusIn(BaseModel):
    status: Literal["shortlisted", "rejected", "withdrawn", "submitted"]
    note: str | None = None


class AwardIn(BaseModel):
    note: str | None = None


class DrawIn(BaseModel):
    amount: float = Field(gt=0)
    requested_on: date
    period_end_on: date | None = None
    percent_complete: float | None = Field(default=None, ge=0, le=100)
    retainage: float | None = Field(default=None, ge=0)
    lien_waiver_document_id: uuid.UUID | None = None
    lien_waiver_type: Literal["conditional", "unconditional"] | None = None
    notes: str | None = None


class DrawUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lien_waiver_document_id: uuid.UUID | None = None
    lien_waiver_type: Literal["conditional", "unconditional"] | None = None
    notes: str | None = None


class DrawPayIn(BaseModel):
    paid_on: date
    payment_reference: str | None = None


class DrawOut(DrawIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    number: int
    status: str
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    paid_on: date | None
    payment_reference: str | None
    created_at: datetime
    lien_waiver_on_file: bool = False


class ChangeOrderIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    reason: str | None = None
    amount: float
    days_impact: int | None = None
    document_id: uuid.UUID | None = None


class ChangeOrderOut(ChangeOrderIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    number: int
    status: str
    decided_by_id: uuid.UUID | None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime
    created_by_id: uuid.UUID | None


class BudgetEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    amount_before: float
    amount_after: float
    delta: float
    reason: str | None
    change_order_id: uuid.UUID | None
    recorded_at: datetime
    created_by_id: uuid.UUID | None


class ApprovalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    stage: str
    decision: str
    amount: float | None
    reference_id: uuid.UUID | None
    note: str | None
    decided_by_id: uuid.UUID | None
    decided_by_name: str | None = None
    decided_at: datetime


class ProjectOut(ProjectListItem):
    scope: str | None
    contingency: float | None
    budget_approved_by_id: uuid.UUID | None
    budget_approved_at: datetime | None
    awarded_bid_id: uuid.UUID | None
    milestones: list
    warranty_expires_on: date | None
    warranty_terms: str | None
    useful_life_years: int | None
    recoverability: dict | None
    recoverability_analyzed_at: datetime | None
    notes: str | None
    created_at: datetime
    paid: float = 0
    remaining: float = 0
    approved_change_orders: float = 0
    bids: list[BidOut] = []
    draws: list[DrawOut] = []
    change_orders: list[ChangeOrderOut] = []
    budget_history: list[BudgetEntryOut] = []
    approvals: list[ApprovalOut] = []


class ProjectFacets(BaseModel):
    status: dict[str, int]
    category: dict[str, int]


# ======================================================================= insurance

class PolicyIn(BaseModel):
    property_id: uuid.UUID | None = None
    asset_id: uuid.UUID | None = None
    policy_number: str = Field(min_length=1, max_length=120)
    coverage_type: str = "property"
    carrier: str = Field(min_length=1, max_length=200)
    broker: str | None = None
    named_insured: str | None = None
    limit_amount: float | None = Field(default=None, ge=0)
    aggregate_limit: float | None = Field(default=None, ge=0)
    deductible: float | None = Field(default=None, ge=0)
    premium: float | None = Field(default=None, ge=0)
    effective_on: date
    expires_on: date
    status: Literal["active", "pending_renewal", "expired", "cancelled"] = "active"
    document_id: uuid.UUID | None = None
    renewal_of_id: uuid.UUID | None = None
    notes: str | None = None


class PolicyOut(PolicyIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_name: str | None = None
    days_to_expiry: int | None = None
    open_claims: int = 0
    updated_at: datetime


class CertificateIn(BaseModel):
    holder_kind: Literal["tenant", "vendor"]
    vendor_id: uuid.UUID | None = None
    tenant_organization_id: uuid.UUID | None = None
    tenant_name: str | None = None
    lease_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    coverage_type: str = "general_liability"
    carrier: str | None = None
    policy_number: str | None = None
    limit_amount: float | None = Field(default=None, ge=0)
    required_limit: float | None = Field(default=None, ge=0)
    additional_insured: bool = False
    additional_insured_required: bool = True
    effective_on: date | None = None
    expires_on: date | None = None
    received_on: date | None = None
    requested_on: date | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


class CertificateOut(CertificateIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    deficiencies: list
    holder_name: str | None = None
    property_name: str | None = None
    days_to_expiry: int | None = None
    updated_at: datetime


class ClaimIn(BaseModel):
    policy_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    claim_number: str | None = None
    incident_on: date
    reported_on: date | None = None
    cause: str | None = None
    description: str | None = None
    claimed_amount: float | None = Field(default=None, ge=0)
    reserve_amount: float | None = Field(default=None, ge=0)
    paid_amount: float | None = Field(default=None, ge=0)
    deductible_applied: float | None = Field(default=None, ge=0)
    adjuster_name: str | None = None
    adjuster_contact: str | None = None
    work_order_id: uuid.UUID | None = None


class ClaimStatusIn(BaseModel):
    status: Literal["reported", "open", "under_review", "approved", "denied", "paid", "closed"]
    note: str | None = None
    paid_amount: float | None = Field(default=None, ge=0)


class ClaimOut(ClaimIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    status_history: list
    closed_on: date | None
    property_name: str | None = None
    policy_label: str | None = None
    updated_at: datetime


# ======================================================================= property tax

class AssessmentIn(BaseModel):
    property_id: uuid.UUID
    parcel_id: uuid.UUID | None = None
    tax_year: int = Field(ge=1900, le=2200)
    jurisdiction: str | None = None
    account_number: str | None = None
    assessed_land: float | None = Field(default=None, ge=0)
    assessed_improvements: float | None = Field(default=None, ge=0)
    assessed_total: float = Field(ge=0)
    market_value: float | None = Field(default=None, ge=0)
    taxable_value: float | None = Field(default=None, ge=0)
    tax_rate: float | None = Field(default=None, ge=0, le=100)
    estimated_tax: float | None = Field(default=None, ge=0)
    notice_received_on: date | None = None
    protest_deadline_on: date | None = None
    source: str | None = None
    observed_on: date | None = None
    notes: str | None = None


class AssessmentOut(AssessmentIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_name: str | None = None
    prior_assessed_total: float | None = None
    change_pct: float | None = None
    protest_id: uuid.UUID | None = None
    protest_status: str | None = None
    updated_at: datetime


class ProtestIn(BaseModel):
    assessment_id: uuid.UUID
    status: Literal["considering", "filed", "evidence_submitted", "hearing_scheduled", "settled", "won", "lost",
                    "withdrawn"] = "considering"
    deadline_on: date | None = None
    filed_on: date | None = None
    consultant_organization_id: uuid.UUID | None = None
    consultant_name: str | None = None
    consultant_fee_pct: float | None = Field(default=None, ge=0, le=100)
    consultant_fee_flat: float | None = Field(default=None, ge=0)
    owner_opinion_value: float | None = Field(default=None, ge=0)
    evidence_document_ids: list[uuid.UUID] = []
    evidence_notes: str | None = None
    hearing_on: date | None = None
    notes: str | None = None


class ProtestUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["considering", "filed", "evidence_submitted", "hearing_scheduled", "settled", "won", "lost",
                    "withdrawn"] | None = None
    deadline_on: date | None = None
    filed_on: date | None = None
    consultant_organization_id: uuid.UUID | None = None
    consultant_name: str | None = None
    consultant_fee_pct: float | None = Field(default=None, ge=0, le=100)
    consultant_fee_flat: float | None = Field(default=None, ge=0)
    owner_opinion_value: float | None = Field(default=None, ge=0)
    evidence_document_ids: list[uuid.UUID] | None = None
    evidence_notes: str | None = None
    hearing_on: date | None = None
    notes: str | None = None


class HearingResultIn(BaseModel):
    hearing_result: Literal["reduced", "no_change", "increased", "settled", "withdrawn"]
    final_value: float | None = Field(default=None, ge=0)
    resolved_on: date | None = None
    note: str | None = None


class ProtestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    assessment_id: uuid.UUID
    property_id: uuid.UUID
    property_name: str | None = None
    tax_year: int
    status: str
    deadline_on: date | None
    filed_on: date | None
    consultant_organization_id: uuid.UUID | None
    consultant_name: str | None
    consultant_fee_pct: float | None
    consultant_fee_flat: float | None
    owner_opinion_value: float | None
    evidence_document_ids: list[uuid.UUID]
    evidence_notes: str | None
    hearing_on: date | None
    hearing_result: str | None
    final_value: float | None
    value_reduction: float | None
    tax_savings: float | None
    consultant_fee: float | None
    net_savings: float | None
    resolved_on: date | None
    notes: str | None
    assessed_total: float | None = None
    days_to_deadline: int | None = None
    updated_at: datetime


class PaymentIn(BaseModel):
    property_id: uuid.UUID
    assessment_id: uuid.UUID | None = None
    tax_year: int = Field(ge=1900, le=2200)
    installment: str | None = None
    amount_due: float = Field(ge=0)
    due_on: date
    document_id: uuid.UUID | None = None
    notes: str | None = None


class PaymentConfirmIn(BaseModel):
    amount_paid: float = Field(ge=0)
    paid_on: date
    method: str | None = None
    confirmation_number: str = Field(min_length=1, max_length=120)
    document_id: uuid.UUID | None = None


class PaymentOut(PaymentIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    amount_paid: float | None
    paid_on: date | None
    method: str | None
    confirmation_number: str | None
    status: str
    confirmed_by_id: uuid.UUID | None
    confirmed_at: datetime | None
    property_name: str | None = None
    updated_at: datetime


class TaxSummaryOut(BaseModel):
    protests: int
    resolved: int
    total_value_reduction: float
    total_tax_savings: float
    total_consultant_fees: float
    total_net_savings: float
    success_rate: float | None


# ======================================================================= budgets

class BudgetIn(BaseModel):
    property_id: uuid.UUID
    fiscal_year: int = Field(ge=1900, le=2200)
    name: str | None = None
    notes: str | None = None
    load_prior_actuals: bool = True


class BudgetListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    property_name: str | None = None
    asset_id: uuid.UUID | None
    fiscal_year: int
    version: int
    kind: str
    name: str
    status: str
    parent_budget_id: uuid.UUID | None
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    total_income: float = 0
    total_expense: float = 0
    total_capex: float = 0
    noi: float = 0
    updated_at: datetime


class GridRow(BaseModel):
    account: str
    category: str
    budget: list[float]
    reforecast: list[float | None]
    prior_actual: list[float | None]
    actual: list[float | None]
    budget_total: float
    reforecast_total: float | None
    prior_actual_total: float | None
    actual_total: float | None
    variance: float | None  # actual - (reforecast or budget) over months with actuals
    variance_pct: float | None


class BudgetOut(BudgetListItem):
    notes: str | None
    approval_note: str | None
    submitted_at: datetime | None
    superseded_at: datetime | None
    created_at: datetime
    rows: list[GridRow] = []
    versions: list[BudgetListItem] = []
    actuals_available: bool = False


class LineCell(BaseModel):
    account: str = Field(min_length=1, max_length=120)
    category: Literal["income", "expense", "capex"] = "expense"
    month: int = Field(ge=1, le=12)
    amount: float | None = None
    reforecast_amount: float | None = None


class LinesIn(BaseModel):
    cells: list[LineCell] = Field(default=[], max_length=5000)
    remove_accounts: list[str] = []


class NewVersionIn(BaseModel):
    kind: Literal["original", "reforecast"] = "reforecast"
    name: str | None = None


class ScanOut(BaseModel):
    credentials_expiring: int
    credentials_expired: int
    policies_expiring: int
    certificates_lapsed: int
    protest_deadlines: int
    payments_due: int
    alerts_raised: int
