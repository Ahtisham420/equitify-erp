import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Category = Literal[
    "settlement_statement", "prorations", "insurance", "entity_standing", "lender_conditions", "tenant_notices",
    "vendors", "utilities", "other",
]
ItemStatus = Literal["open", "in_progress", "done", "waived", "not_applicable"]
SourceKind = Literal["equity", "senior_debt", "mezzanine", "seller_financing", "deposit_credit", "other"]
UseKind = Literal["purchase_price", "closing_costs", "acquisition_fee", "financing_costs", "reserves", "capex", "other"]


class ClosingCreate(BaseModel):
    opportunity_id: uuid.UUID
    scheduled_closing_on: date | None = None
    coordinator_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None


class ClosingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scheduled_closing_on: date | None = None
    coordinator_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    hold_thesis: str | None = None
    business_plan: str | None = None
    target_hold_years: float | None = Field(default=None, ge=0, le=100)
    notes: str | None = None


class SourceLine(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    kind: SourceKind = "other"
    amount: float = Field(ge=0)


class UseLine(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    kind: UseKind = "other"
    amount: float = Field(ge=0)
    capitalized: bool = True


class SourcesUsesIn(BaseModel):
    sources: list[SourceLine] = []
    uses: list[UseLine] = []


class ChecklistItemIn(BaseModel):
    category: Category = "other"
    title: str = Field(min_length=1, max_length=300)
    owner_id: uuid.UUID | None = None
    due_on: date | None = None
    is_blocking: bool = False
    document_id: uuid.UUID | None = None
    notes: str | None = None


class ChecklistItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Category | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    owner_id: uuid.UUID | None = None
    due_on: date | None = None
    status: ItemStatus | None = None
    is_blocking: bool | None = None
    document_id: uuid.UUID | None = None
    notes: str | None = None
    waived_reason: str | None = None


class ChecklistItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    closing_id: uuid.UUID
    template_key: str | None
    category: str
    title: str
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    due_on: date | None
    status: str
    is_blocking: bool
    document_id: uuid.UUID | None
    notes: str | None
    waived_reason: str | None
    completed_at: datetime | None
    completed_by_id: uuid.UUID | None
    sort_order: int
    overdue: bool = False
    updated_at: datetime


class WireIn(BaseModel):
    beneficiary_name: str = Field(min_length=1, max_length=200)
    bank_name: str = Field(min_length=1, max_length=200)
    routing_number: str = Field(min_length=9, max_length=20)
    account_number: str = Field(min_length=4, max_length=40)
    amount: float | None = Field(default=None, gt=0)
    instruction_source: str = Field(min_length=2, max_length=200)
    instruction_received_from: str | None = Field(default=None, max_length=200)
    instruction_contact_phone: str | None = Field(default=None, max_length=40)
    received_at: datetime | None = None


class CallbackIn(BaseModel):
    callback_phone: str = Field(min_length=7, max_length=40)
    callback_phone_source: str = Field(min_length=2, max_length=200)
    callback_contact_name: str = Field(min_length=1, max_length=200)
    result: Literal["passed", "failed"]
    result_notes: str | None = Field(default=None, max_length=4000)
    verified_at: datetime | None = None


class WireOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    closing_id: uuid.UUID
    is_current: bool
    beneficiary_name: str
    bank_name: str
    routing_number: str
    account_number: str
    amount: float | None
    instruction_source: str
    instruction_received_from: str | None
    instruction_contact_phone: str | None
    received_at: datetime
    callback_phone: str | None
    callback_phone_source: str | None
    callback_contact_name: str | None
    verified_by_id: uuid.UUID | None
    verified_by_name: str | None
    verified_at: datetime | None
    result: str
    result_notes: str | None
    created_at: datetime
    created_by_id: uuid.UUID | None


class Blocker(BaseModel):
    key: str
    label: str
    detail: str | None = None


class ClosingListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    opportunity_id: uuid.UUID
    opportunity_title: str | None = None
    property_id: uuid.UUID | None
    property_label: str | None = None
    status: str
    scheduled_closing_on: date | None
    closed_on: date | None
    purchase_price: float | None
    basis: float | None
    coordinator_id: uuid.UUID | None
    coordinator_name: str | None = None
    manager_id: uuid.UUID | None
    manager_name: str | None = None
    blocking_open: int = 0
    items_total: int = 0
    items_done: int = 0
    wire_status: str = "missing"
    asset_id: uuid.UUID | None
    asset_pending: bool
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ClosingOut(ClosingListItem):
    offer_id: uuid.UUID | None
    uw_model_id: uuid.UUID | None
    sources: list
    uses: list
    total_sources: float | None
    total_uses: float | None
    capital_structure: dict
    hold_thesis: str | None
    business_plan: str | None
    target_hold_years: float | None
    notes: str | None
    completed_by_id: uuid.UUID | None
    asset_error: str | None
    audit_task_id: uuid.UUID | None
    audit_due_on: date | None
    audit_result: dict | None
    audit_completed_at: datetime | None
    blockers: list[Blocker] = []
    can_complete: bool = False
    has_snapshot: bool = False
    created_by_id: uuid.UUID | None


class CompleteIn(BaseModel):
    closed_on: date
    note: str | None = Field(default=None, max_length=4000)


class SnapshotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    closing_id: uuid.UUID
    created_at: datetime
    created_by_id: uuid.UUID | None
    created_by_name: str | None
    sha256: str
    data: dict


class HandoffOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    closing_id: uuid.UUID
    asset_id: uuid.UUID | None
    property_id: uuid.UUID | None
    sections: dict
    open_dd_items: list
    carry_forward: dict
    generated_at: datetime
    recipient_id: uuid.UUID | None
    acknowledged_at: datetime | None
    acknowledged_by_id: uuid.UUID | None
    updated_at: datetime


class HandoffItem(BaseModel):
    label: str = Field(min_length=1, max_length=300)
    detail: str | None = None
    document_id: uuid.UUID | None = None
    status: Literal["pending", "delivered", "not_applicable"] = "pending"


class HandoffSectionIn(BaseModel):
    items: list[HandoffItem] = []
    notes: str | None = None


class HandoffUpdate(BaseModel):
    sections: dict[str, HandoffSectionIn] = {}
    recipient_id: uuid.UUID | None = None


class AuditMetric(BaseModel):
    key: str
    label: str
    assumed: float | None = None
    actual: float | None = None
    variance: float | None = None
    variance_pct: float | None = None
    unit: Literal["currency", "percent", "ratio"] = "currency"


class PostCloseAuditOut(BaseModel):
    closing_id: uuid.UUID
    asset_id: uuid.UUID | None
    closed_on: date | None
    due_on: date | None
    period_start: date | None
    period_end: date | None
    months_of_data: int = 0
    metrics: list[AuditMetric] = []
    notes: list[str] = []
    completed: dict | None = None


class AuditCompleteIn(BaseModel):
    findings: str = Field(min_length=1, max_length=8000)
    lessons_for_acquisitions: str | None = Field(default=None, max_length=8000)


class ClosingFacets(BaseModel):
    status: dict[str, int]
    wire_status: dict[str, int] = {}


class MetaOut(BaseModel):
    statuses: list[str]
    categories: list[str]
    item_statuses: list[str]
    source_kinds: list[str]
    use_kinds: list[str]
    template: list[dict[str, Any]]
    handoff_sections: dict[str, str]
