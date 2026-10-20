import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Buckets(BaseModel):
    current: float = 0
    d1_30: float = 0
    d31_60: float = 0
    d61_90: float = 0
    d90_plus: float = 0
    total: float = 0


# --------------------------------------------------------------------------- charges

class ChargeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    lease_id: uuid.UUID
    property_id: uuid.UUID
    tenant_name: str | None
    charge_type: str
    period_start: date | None
    period_end: date | None
    due_on: date
    amount: float
    amount_paid: float
    balance: float = 0
    days_past_due: int = 0
    status: str
    source: str
    source_ref: dict
    description: str | None
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    voided_at: datetime | None
    void_reason: str | None
    external_ref: str | None
    created_at: datetime
    updated_at: datetime


class ManualChargeIn(BaseModel):
    lease_id: uuid.UUID
    charge_type: str = Field(min_length=1, max_length=30)
    amount: float
    due_on: date
    period_start: date | None = None
    period_end: date | None = None
    description: str = Field(min_length=1, max_length=300)


class GenerateIn(BaseModel):
    period: str = Field(pattern=r"^\d{4}-\d{2}$")
    property_id: uuid.UUID | None = None
    lease_ids: list[uuid.UUID] | None = None


class GenerateOut(BaseModel):
    period: str
    created: int
    existing: int
    skipped_unverified: int
    leases: int
    amount: float


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class ChargeFacets(BaseModel):
    status: dict[str, int]
    charge_type: dict[str, int]
    source: dict[str, int]


# --------------------------------------------------------------------------- payments

class AllocationIn(BaseModel):
    charge_id: uuid.UUID
    amount: float = Field(gt=0)


class PaymentIn(BaseModel):
    lease_id: uuid.UUID
    received_on: date
    amount: float = Field(gt=0)
    method: Literal["ach", "check", "wire", "card", "cash", "other"] = "ach"
    reference: str | None = Field(default=None, max_length=120)
    notes: str | None = None
    auto_apply: bool = True
    allocations: list[AllocationIn] = []


class ApplyIn(BaseModel):
    allocations: list[AllocationIn] = []  # empty -> oldest-first auto-apply


class UnapplyIn(BaseModel):
    application_id: uuid.UUID
    reason: str = Field(min_length=3, max_length=300)


class ApplicationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    payment_id: uuid.UUID
    charge_id: uuid.UUID
    amount: float
    applied_on: date
    method: str
    reversed_at: datetime | None
    reversal_reason: str | None
    created_by_id: uuid.UUID | None


class PaymentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    lease_id: uuid.UUID
    property_id: uuid.UUID
    tenant_name: str | None
    received_on: date
    amount: float
    unapplied_amount: float
    method: str
    reference: str | None
    status: str
    reversed_at: datetime | None
    reversal_reason: str | None
    notes: str | None
    external_ref: str | None
    created_at: datetime
    applications: list[ApplicationOut] = []


# --------------------------------------------------------------------------- ledger / aging

class LedgerEntry(BaseModel):
    id: str
    on: date
    kind: Literal["charge", "payment", "reversal", "void"]
    description: str
    charge_type: str | None = None
    debit: float = 0
    credit: float = 0
    balance: float = 0
    status: str | None = None
    ref_id: uuid.UUID
    source: str | None = None
    source_ref: dict = {}


class TenantBalance(BaseModel):
    id: uuid.UUID
    lease_id: uuid.UUID
    tenant_name: str
    property_id: uuid.UUID
    property_name: str | None = None
    lease_status: str
    balance: float
    past_due: float
    unapplied: float
    buckets: Buckets
    collection_status: str = "current"
    step_key: str | None = None
    days_past_due: int = 0
    has_plan: bool = False


class LedgerOut(BaseModel):
    tenant: TenantBalance
    entries: list[LedgerEntry]
    open_charges: list[ChargeOut]
    late_fee_terms: dict


class DashboardRow(BaseModel):
    id: str
    label: str
    property_id: uuid.UUID | None = None
    lease_id: uuid.UUID | None = None
    buckets: Buckets
    unapplied: float = 0
    tenants: int = 0


class Dashboard(BaseModel):
    as_of: date
    totals: Buckets
    unapplied: float
    delinquent_tenants: int
    billed_this_month: float
    collected_this_month: float
    collection_rate: float | None
    by_property: list[DashboardRow]
    by_tenant: list[DashboardRow]


# --------------------------------------------------------------------------- delinquency

class LadderStep(BaseModel):
    key: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=160)
    days_past_due: int = Field(ge=0, le=3650)
    min_balance: float = Field(default=0, ge=0)
    create_task: bool = True
    task_priority: Literal["low", "normal", "high", "urgent"] = "normal"
    collection_status: Literal["delinquent", "legal"] = "delinquent"
    subject: str
    body: str


class LateFeeDefaults(BaseModel):
    grace_days: int = Field(default=5, ge=0, le=90)
    pct: float | None = Field(default=5.0, ge=0, le=100)
    flat: float | None = Field(default=None, ge=0)
    charge_types: list[str] = ["base_rent", "recovery", "cam", "tax", "insurance", "fixed_cam"]


class SettingsOut(BaseModel):
    late_fee_defaults: LateFeeDefaults
    ladder: list[LadderStep]
    alert_days: int = 90


class SettingsIn(BaseModel):
    late_fee_defaults: LateFeeDefaults | None = None
    ladder: list[LadderStep] | None = None
    alert_days: int | None = Field(default=None, ge=1, le=3650)


class EvaluateIn(BaseModel):
    as_of: date | None = None
    property_id: uuid.UUID | None = None


class EvaluateOut(BaseModel):
    evaluated: int
    escalated: int
    resolved: int
    notices: int
    breached_plans: int
    late_fees: int = 0


class NoticeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    lease_id: uuid.UUID
    property_id: uuid.UUID
    tenant_name: str | None = None
    step_key: str
    step_index: int
    label: str
    balance: float
    days_past_due: int
    subject: str
    body: str
    status: str
    delivery_method: str | None
    sent_at: datetime | None
    sent_by_id: uuid.UUID | None
    task_id: uuid.UUID | None
    created_at: datetime


class NoticeCreate(BaseModel):
    lease_id: uuid.UUID
    step_key: str


class NoticeSendIn(BaseModel):
    delivery_method: Literal["email", "mail", "certified_mail", "hand", "portal"] = "email"


class CollectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    lease_id: uuid.UUID
    tenant_name: str | None = None
    property_name: str | None = None
    status: str
    step_index: int
    step_key: str | None
    step_label: str | None = None
    past_due_balance: float
    days_past_due: int
    oldest_due_on: date | None
    on_hold: bool
    last_evaluated_at: datetime | None


# --------------------------------------------------------------------------- payment plans

class PlanIn(BaseModel):
    lease_id: uuid.UUID
    total_amount: float | None = Field(default=None, gt=0)
    start_on: date
    installment_count: int = Field(ge=1, le=60)
    frequency_months: int = Field(default=1, ge=1, le=12)
    grace_days: int = Field(default=5, ge=0, le=60)
    notes: str | None = None


class InstallmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sequence: int
    due_on: date
    amount: float
    paid_amount: float
    status: str


class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    lease_id: uuid.UUID
    property_id: uuid.UUID
    tenant_name: str | None = None
    total_amount: float
    start_on: date
    installment_count: int
    frequency_months: int
    grace_days: int
    status: str
    paid_amount: float
    breached_at: datetime | None
    notes: str | None
    created_at: datetime
    installments: list[InstallmentOut] = []


# --------------------------------------------------------------------------- reconciliation billing

class ReconBillIn(BaseModel):
    reconciliation_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    due_on: date


class ReconBillOut(BaseModel):
    billed: int
    skipped: int
    amount: float


# --------------------------------------------------------------------------- sync

class ExportIn(BaseModel):
    system: str = Field(min_length=1, max_length=80)
    period_from: date
    period_to: date
    property_id: uuid.UUID | None = None


class ExternalEntry(BaseModel):
    external_id: str = Field(min_length=1, max_length=120)
    kind: Literal["charge", "payment"]
    local_id: uuid.UUID | None = None
    lease_id: uuid.UUID | None = None
    amount: float | None = None
    entry_date: date | None = None
    status: str | None = None
    reference: str | None = None


class ImportIn(BaseModel):
    system: str = Field(min_length=1, max_length=80)
    external_batch_id: str | None = None
    entries: list[ExternalEntry] = Field(min_length=1, max_length=5000)


class BatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    direction: str
    system: str
    status: str
    period_from: date | None
    period_to: date | None
    property_id: uuid.UUID | None
    entry_count: int
    matched_count: int
    conflict_count: int
    external_batch_id: str | None
    summary: str | None
    created_at: datetime


class BatchDetail(BatchOut):
    payload: list = []


class ConflictOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    batch_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID | None
    external_id: str | None
    field: str
    local_value: Any
    external_value: Any
    status: str
    resolved_by_id: uuid.UUID | None
    resolved_at: datetime | None
    resolution_note: str | None
    created_at: datetime


class ResolveIn(BaseModel):
    resolution: Literal["accept_external", "keep_local", "dismissed"]
    note: str | None = Field(default=None, max_length=300)
