import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ContractStatus = Literal["draft", "executed", "closed", "terminated"]
ContractType = Literal["purchase_sale", "amendment", "assignment", "option", "other"]
DateStatus = Literal["proposed", "confirmed", "completed", "waived", "missed"]
DateSource = Literal["manual", "rule", "ai"]
Severity = Literal["low", "medium", "high", "critical"]
DDStatus = Literal["not_started", "in_progress", "blocked", "complete", "waived"]
ReportType = Literal["survey", "phase_i", "phase_ii", "pca", "zoning", "appraisal", "title", "lease_audit"]
ReportStatus = Literal["not_ordered", "ordered", "in_progress", "delivered", "reviewed", "cancelled"]
ExceptionKind = Literal["title_exception", "easement", "encroachment", "survey_matter", "lien", "restriction", "other"]
ExceptionSource = Literal["title_commitment", "survey", "other"]
ExceptionStatus = Literal["open", "objected", "cure_pending", "cured", "accepted", "waived", "uncured"]
EstoppelKind = Literal["estoppel", "snda"]
EstoppelStatus = Literal["not_requested", "requested", "received", "approved", "waived"]
RiskCategory = Literal["title", "survey", "environmental", "physical", "zoning", "tenancy", "financial", "legal", "other"]
RiskStatus = Literal["open", "mitigating", "decided", "closed"]
RiskDecision = Literal["proceed", "mitigate", "renegotiate", "terminate", "accept"]
DecisionKind = Literal["extend", "terminate", "proceed", "waive_contingency", "renegotiate", "other"]


# --------------------------------------------------------------------------- contracts

class Party(BaseModel):
    role: str = Field(max_length=40)
    name: str = Field(min_length=1, max_length=200)
    person_id: uuid.UUID | None = None
    organization_id: uuid.UUID | None = None
    notes: str | None = None


class ContractFields(BaseModel):
    contract_type: ContractType = "purchase_sale"
    document_id: uuid.UUID | None = None
    offer_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    effective_on: date | None = None
    executed_on: date | None = None
    purchase_price: float | None = Field(default=None, ge=0)
    earnest_money: float | None = Field(default=None, ge=0)
    additional_deposit: float | None = Field(default=None, ge=0)
    parties: list[Party] = []
    key_terms: dict[str, Any] = {}
    calendar_id: uuid.UUID | None = None
    attorney_person_id: uuid.UUID | None = None
    attorney_organization_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] = []


class ContractCreate(ContractFields):
    title: str | None = Field(default=None, max_length=255)


class ContractUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=255)
    contract_type: ContractType | None = None
    status: ContractStatus | None = None
    document_id: uuid.UUID | None = None
    offer_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    effective_on: date | None = None
    executed_on: date | None = None
    purchase_price: float | None = Field(default=None, ge=0)
    earnest_money: float | None = Field(default=None, ge=0)
    additional_deposit: float | None = Field(default=None, ge=0)
    parties: list[Party] | None = None
    key_terms: dict[str, Any] | None = None
    calendar_id: uuid.UUID | None = None
    attorney_person_id: uuid.UUID | None = None
    attorney_organization_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] | None = None


class ExecuteIn(BaseModel):
    effective_on: date | None = None
    executed_on: date | None = None


class ContractListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    contract_type: str
    status: str
    property_id: uuid.UUID | None
    property_label: str | None = None
    property_type: str | None = None
    opportunity_id: uuid.UUID | None
    opportunity_label: str | None = None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    effective_on: date | None
    purchase_price: float | None
    feasibility_on: date | None = None
    days_to_feasibility: int | None = None
    closing_on: date | None = None
    open_blockers: int = 0
    dd_total: int = 0
    dd_done: int = 0
    tags: list[str]
    updated_at: datetime


class ContractOut(ContractListItem):
    document_id: uuid.UUID | None
    offer_id: uuid.UUID | None
    executed_on: date | None
    executed_at: datetime | None
    earnest_money: float | None
    additional_deposit: float | None
    parties: list[dict]
    key_terms: dict
    calendar_id: uuid.UUID | None
    attorney_person_id: uuid.UUID | None
    attorney_organization_id: uuid.UUID | None
    terminated_at: datetime | None
    notes: str | None
    created_at: datetime
    created_by_id: uuid.UUID | None


class ContractFacets(BaseModel):
    status: dict[str, int]
    contract_type: dict[str, int]
    owner_id: dict[str, int]


class Blocker(BaseModel):
    kind: str  # critical_date | dd_item | risk | estoppel | title_exception | third_party_report
    id: uuid.UUID
    label: str
    severity: str = "high"
    detail: str | None = None


class ContractStatusOut(BaseModel):
    contract_id: uuid.UUID
    status: str
    effective_on: date | None
    feasibility_on: date | None
    feasibility_status: str | None
    days_to_feasibility: int | None
    closing_on: date | None
    days_to_closing: int | None
    blockers: list[Blocker]
    counts: dict[str, int]


# --------------------------------------------------------------------------- critical dates

class CriticalDateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    related_type: str
    related_id: uuid.UUID
    related_label: str | None
    key: str
    property_id: uuid.UUID | None
    property_label: str | None = None
    date_type: str
    label: str
    due_on: date
    original_due_on: date | None
    proposed_due_on: date | None
    rule: dict | None
    business_days: bool
    calendar_id: uuid.UUID | None
    status: str
    source: str
    citation: dict | None
    confirmed_by_id: uuid.UUID | None
    confirmed_by_name: str | None = None
    confirmed_at: datetime | None
    confirm_note: str | None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    lead_days: int
    is_blocking: bool
    completed_at: datetime | None
    completed_by_id: uuid.UUID | None
    resolution_note: str | None
    escalation_level: int
    notes: str | None
    days_until: int | None = None
    updated_at: datetime


class CriticalDateCreate(BaseModel):
    related_type: str = Field(min_length=1, max_length=40)
    related_id: uuid.UUID
    related_label: str | None = Field(default=None, max_length=300)
    property_id: uuid.UUID | None = None
    date_type: str = Field(default="other", max_length=40)
    label: str = Field(min_length=1, max_length=300)
    due_on: date
    owner_id: uuid.UUID | None = None
    lead_days: int = Field(default=14, ge=0, le=365)
    is_blocking: bool = False
    notes: str | None = None
    key: str | None = Field(default=None, max_length=80)


class CriticalDateUpdate(BaseModel):
    """Due date changes go through /reschedule so the reason is kept."""

    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, min_length=1, max_length=300)
    date_type: str | None = Field(default=None, max_length=40)
    owner_id: uuid.UUID | None = None
    lead_days: int | None = Field(default=None, ge=0, le=365)
    is_blocking: bool | None = None
    notes: str | None = None


class ConfirmIn(BaseModel):
    note: str | None = Field(default=None, max_length=2000)
    due_on: date | None = None  # corrected value read from the source document


class NoteIn(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class RequiredNoteIn(BaseModel):
    note: str = Field(min_length=1, max_length=2000)


class RescheduleIn(BaseModel):
    due_on: date
    reason: str = Field(min_length=1, max_length=2000)


class BulkDatesIn(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    action: Literal["confirm", "complete"]
    note: str | None = Field(default=None, max_length=2000)


class CriticalDateEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    critical_date_id: uuid.UUID
    kind: str
    from_status: str | None
    to_status: str | None
    from_due_on: date | None
    to_due_on: date | None
    reason: str | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    at: datetime
    data: dict


class CriticalDateFacets(BaseModel):
    status: dict[str, int]
    related_type: dict[str, int]
    date_type: dict[str, int]
    owner_id: dict[str, int]


class CriticalDateSummary(BaseModel):
    overdue: int
    next_7: int
    next_30: int
    next_90: int
    proposed: int
    blocking_open: int
    missed: int


# --------------------------------------------------------------------------- calendars

class HolidayCalendarOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    description: str | None
    weekend_days: list[int]
    is_default: bool
    rule_set: str | None
    seeded_years: list[int]


class HolidayCalendarCreate(BaseModel):
    code: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=160)
    description: str | None = None
    weekend_days: list[int] = [5, 6]
    copy_from_id: uuid.UUID | None = None


class HolidayOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    calendar_id: uuid.UUID
    holiday_on: date
    name: str
    source: str


class HolidayIn(BaseModel):
    holiday_on: date
    name: str = Field(min_length=1, max_length=160)


class BusinessDaysOut(BaseModel):
    start: date
    days: int
    business_days: bool
    result: date
    calendar_id: uuid.UUID


# --------------------------------------------------------------------------- DD

class DDTemplateItem(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    category: str = Field(default="general", max_length=60)
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    severity: Severity | None = None
    due_days: int | None = Field(default=None, ge=0, le=730)
    depends_on: list[str] = []
    report_type: ReportType | None = None


class DDTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    property_types: list[str]
    is_generic: bool
    is_active: bool
    version: int
    items: list[dict]
    updated_at: datetime


class DDTemplateCreate(BaseModel):
    code: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=160)
    property_types: list[str] = []
    items: list[DDTemplateItem] = []


class DDTemplateUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    property_types: list[str] | None = None
    is_active: bool | None = None
    items: list[DDTemplateItem] | None = None


class ApplyTemplateIn(BaseModel):
    template_id: uuid.UUID | None = None


class DDItemCreate(BaseModel):
    category: str = Field(default="general", max_length=60)
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    owner_id: uuid.UUID | None = None
    status: DDStatus = "not_started"
    due_on: date | None = None
    depends_on: list[uuid.UUID] = []
    source: str = Field(default="manual", max_length=30)
    findings: str | None = None
    severity: Severity | None = None
    cost_impact: float | None = None
    resolution: str | None = None


class DDItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str | None = Field(default=None, max_length=60)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    owner_id: uuid.UUID | None = None
    status: DDStatus | None = None
    due_on: date | None = None
    depends_on: list[uuid.UUID] | None = None
    source: str | None = Field(default=None, max_length=30)
    findings: str | None = None
    severity: Severity | None = None
    cost_impact: float | None = None
    resolution: str | None = None


class DependencyRef(BaseModel):
    id: uuid.UUID
    title: str
    status: str


class DDItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    template_id: uuid.UUID | None
    key: str | None
    category: str
    title: str
    description: str | None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    status: str
    due_on: date | None
    depends_on: list
    blocked_by: list[DependencyRef] = []
    source: str
    findings: str | None
    severity: str | None
    cost_impact: float | None
    resolution: str | None
    escalation_level: int
    escalated_at: datetime | None
    escalation_note: str | None
    report_id: uuid.UUID | None
    completed_at: datetime | None
    sort_order: int
    is_overdue: bool = False
    updated_at: datetime


class EscalateIn(BaseModel):
    note: str = Field(min_length=1, max_length=2000)


# --------------------------------------------------------------------------- third-party reports

class ReportFields(BaseModel):
    vendor_organization_id: uuid.UUID | None = None
    vendor_name: str | None = Field(default=None, max_length=200)
    status: ReportStatus = "not_ordered"
    ordered_on: date | None = None
    expected_on: date | None = None
    delivered_on: date | None = None
    cost: float | None = Field(default=None, ge=0)
    findings: str | None = None
    severity: Severity | None = None
    document_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    notes: str | None = None


class ReportCreate(ReportFields):
    report_type: ReportType


class ReportUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report_type: ReportType | None = None
    vendor_organization_id: uuid.UUID | None = None
    vendor_name: str | None = Field(default=None, max_length=200)
    status: ReportStatus | None = None
    ordered_on: date | None = None
    expected_on: date | None = None
    delivered_on: date | None = None
    cost: float | None = Field(default=None, ge=0)
    findings: str | None = None
    severity: Severity | None = None
    document_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    notes: str | None = None


class ReportOut(ReportFields):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    report_type: str
    status: str
    severity: str | None
    vendor_label: str | None = None
    owner_name: str | None = None
    is_late: bool = False
    updated_at: datetime


# --------------------------------------------------------------------------- title & survey

class TitleExceptionFields(BaseModel):
    kind: ExceptionKind = "title_exception"
    source: ExceptionSource = "title_commitment"
    schedule_ref: str | None = Field(default=None, max_length=80)
    recording_ref: str | None = Field(default=None, max_length=160)
    severity: Severity | None = None
    status: ExceptionStatus = "open"
    objection_sent_on: date | None = None
    cure_due_on: date | None = None
    cure_response: str | None = None
    resolved_on: date | None = None
    attorney_person_id: uuid.UUID | None = None
    attorney_organization_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


class TitleExceptionCreate(TitleExceptionFields):
    description: str = Field(min_length=1)


class TitleExceptionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ExceptionKind | None = None
    source: ExceptionSource | None = None
    schedule_ref: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, min_length=1)
    recording_ref: str | None = Field(default=None, max_length=160)
    severity: Severity | None = None
    status: ExceptionStatus | None = None
    objection_sent_on: date | None = None
    cure_due_on: date | None = None
    cure_response: str | None = None
    resolved_on: date | None = None
    attorney_person_id: uuid.UUID | None = None
    attorney_organization_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


class TitleExceptionOut(TitleExceptionFields):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    kind: str
    source: str
    status: str
    severity: str | None
    description: str
    attorney_label: str | None = None
    updated_at: datetime


# --------------------------------------------------------------------------- estoppels / SNDA

class EstoppelFields(BaseModel):
    kind: EstoppelKind = "estoppel"
    lease_id: uuid.UUID | None = None
    status: EstoppelStatus = "not_requested"
    requested_on: date | None = None
    due_on: date | None = None
    received_on: date | None = None
    expected_monthly_rent: float | None = None
    expected_expiration_on: date | None = None
    expected_security_deposit: float | None = None
    reported_monthly_rent: float | None = None
    reported_expiration_on: date | None = None
    reported_security_deposit: float | None = None
    reported_landlord_default: bool | None = None
    reported_notes: str | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


class EstoppelCreate(EstoppelFields):
    tenant_name: str = Field(min_length=1, max_length=200)


class EstoppelUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: EstoppelKind | None = None
    tenant_name: str | None = Field(default=None, min_length=1, max_length=200)
    lease_id: uuid.UUID | None = None
    status: EstoppelStatus | None = None
    requested_on: date | None = None
    due_on: date | None = None
    received_on: date | None = None
    expected_monthly_rent: float | None = None
    expected_expiration_on: date | None = None
    expected_security_deposit: float | None = None
    reported_monthly_rent: float | None = None
    reported_expiration_on: date | None = None
    reported_security_deposit: float | None = None
    reported_landlord_default: bool | None = None
    reported_notes: str | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None


class EstoppelOut(EstoppelFields):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    tenant_name: str
    kind: str
    status: str
    discrepancies: list
    has_discrepancy: bool
    discrepancy_resolution: str | None
    discrepancy_resolved_at: datetime | None
    updated_at: datetime


# --------------------------------------------------------------------------- risks & decisions

class RiskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    category: RiskCategory = "other"
    severity: Severity = "medium"
    source_type: str | None = Field(default=None, max_length=40)
    source_id: uuid.UUID | None = None
    owner_id: uuid.UUID | None = None
    cost_impact: float | None = None
    mitigation: str | None = None
    decision_required: bool | None = None  # defaults to True for high/critical
    decision_due_on: date | None = None


class RiskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    category: RiskCategory | None = None
    severity: Severity | None = None
    status: RiskStatus | None = None
    owner_id: uuid.UUID | None = None
    cost_impact: float | None = None
    mitigation: str | None = None
    decision_required: bool | None = None
    decision_due_on: date | None = None


class RiskDecideIn(BaseModel):
    decision: RiskDecision
    reason: str = Field(min_length=1, max_length=4000)


class RiskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    title: str
    description: str | None
    category: str
    severity: str
    status: str
    source_type: str | None
    source_id: uuid.UUID | None
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    cost_impact: float | None
    mitigation: str | None
    decision_required: bool
    decision_due_on: date | None
    decision: str | None
    decision_reason: str | None
    decided_by_id: uuid.UUID | None
    decided_by_name: str | None = None
    decided_at: datetime | None
    needs_decision: bool = False
    updated_at: datetime


class DecisionCreate(BaseModel):
    kind: DecisionKind
    reasoning: str = Field(min_length=1, max_length=8000)
    critical_date_id: uuid.UUID | None = None
    new_due_on: date | None = None
    effective_on: date | None = None


class DecisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    kind: str
    reasoning: str
    critical_date_id: uuid.UUID | None
    previous_due_on: date | None
    new_due_on: date | None
    effective_on: date | None
    decided_by_id: uuid.UUID | None
    decided_by_name: str | None
    decided_at: datetime
    data: dict


class ActivityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    occurred_at: datetime
    actor_id: uuid.UUID | None
    actor_name: str | None
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    summary: str | None
    changes: dict | None
    ip_address: str | None


class ProposeOut(BaseModel):
    proposed: list[CriticalDateOut]
    skipped: list[str]
    message: str | None = None
