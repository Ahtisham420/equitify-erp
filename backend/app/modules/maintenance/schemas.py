import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Source = Literal["tenant", "staff", "inspection", "preventive"]
Priority = Literal["low", "normal", "high", "urgent"]
Severity = Literal["low", "medium", "high", "critical"]
Responsibility = Literal["undetermined", "tenant", "landlord", "shared"]


# ---------------------------------------------------------------- work orders

class WorkOrderCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    source: Source = "staff"
    category: str = "general"
    priority: Priority = "normal"
    property_id: uuid.UUID
    asset_id: uuid.UUID | None = None
    space_id: uuid.UUID | None = None
    lease_id: uuid.UUID | None = None
    system: str | None = None
    location_detail: str | None = None
    requested_by_name: str | None = None
    requester_contact: str | None = None
    tenant_organization_id: uuid.UUID | None = None
    reported_at: datetime | None = None
    due_on: date | None = None
    estimate_amount: float | None = Field(default=None, ge=0)
    photo_document_ids: list[uuid.UUID] = []


class WorkOrderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    category: str | None = None
    priority: Priority | None = None
    asset_id: uuid.UUID | None = None
    space_id: uuid.UUID | None = None
    lease_id: uuid.UUID | None = None
    system: str | None = None
    location_detail: str | None = None
    requested_by_name: str | None = None
    requester_contact: str | None = None
    tenant_organization_id: uuid.UUID | None = None
    due_on: date | None = None
    photo_document_ids: list[uuid.UUID] | None = None


class AssignIn(BaseModel):
    assignee_type: Literal["vendor", "staff"]
    vendor_id: uuid.UUID | None = None
    assigned_user_id: uuid.UUID | None = None


class TransitionIn(BaseModel):
    status: Literal["open", "assigned", "in_progress", "completed", "verified", "cancelled"]
    note: str | None = None
    completion_notes: str | None = None
    actual_cost: float | None = Field(default=None, ge=0)
    evidence_document_ids: list[uuid.UUID] = []
    cancelled_reason: str | None = None


class CostIn(BaseModel):
    estimate_amount: float | None = Field(default=None, ge=0)
    actual_cost: float | None = Field(default=None, ge=0)
    note: str | None = None


class ApprovalIn(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str | None = None


class ResponsibilityIn(BaseModel):
    """Empty body = determine from lease obligations; otherwise a manual determination with a reason."""

    responsibility: Responsibility | None = None
    tenant_share_pct: float | None = Field(default=None, ge=0, le=100)
    reason: str | None = None


class SatisfactionIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = None


class EvidenceIn(BaseModel):
    document_ids: list[uuid.UUID] = Field(min_length=1)


class BulkWorkOrderIn(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    priority: Priority | None = None
    assigned_user_id: uuid.UUID | None = None


class WorkOrderListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    number: int
    title: str
    source: str
    category: str
    priority: str
    status: str
    property_id: uuid.UUID
    property_name: str | None = None
    asset_id: uuid.UUID | None
    space_id: uuid.UUID | None
    system: str | None
    location_detail: str | None
    assignee_type: str | None
    vendor_id: uuid.UUID | None
    vendor_name: str | None = None
    assigned_user_id: uuid.UUID | None
    assignee_name: str | None = None
    estimate_amount: float | None
    actual_cost: float | None
    approval_status: str
    tenant_responsibility: str
    due_on: date | None
    satisfaction_rating: int | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    verified_at: datetime | None


class WorkOrderOut(WorkOrderListItem):
    description: str | None
    lease_id: uuid.UUID | None
    requested_by_name: str | None
    requester_contact: str | None
    tenant_organization_id: uuid.UUID | None
    reported_at: datetime | None
    photo_document_ids: list[uuid.UUID]
    status_history: list
    assigned_at: datetime | None
    started_at: datetime | None
    approval_threshold: float | None
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    approval_note: str | None
    completed_by_id: uuid.UUID | None
    completion_notes: str | None
    evidence_document_ids: list[uuid.UUID]
    verified_by_id: uuid.UUID | None
    cancelled_reason: str | None
    satisfaction_comment: str | None
    tenant_share_pct: float | None
    responsibility_reason: str | None
    responsibility_basis: list
    responsibility_method: str | None
    responsibility_determined_at: datetime | None
    chargeback_status: str
    chargeback_amount: float | None
    chargeback_charge_id: uuid.UUID | None
    pm_schedule_id: uuid.UUID | None
    inspection_id: uuid.UUID | None
    finding_id: uuid.UUID | None
    created_by_id: uuid.UUID | None
    # Derived
    evidence_count: int = 0
    vendor_compliance: dict | None = None
    allowed_transitions: list[str] = []


class WorkOrderFacets(BaseModel):
    status: dict[str, int]
    priority: dict[str, int]
    category: dict[str, int]
    source: dict[str, int]
    approval_status: dict[str, int]


class SettingsIn(BaseModel):
    approval_threshold: float = Field(ge=0)
    finding_auto_wo_severity: Severity = "high"
    pm_default_lead_days: int = Field(default=14, ge=0, le=180)


class SettingsOut(SettingsIn):
    model_config = ConfigDict(from_attributes=True)


class ServiceHistoryOut(BaseModel):
    work_orders: list[WorkOrderListItem]
    pm_schedules: list["PMScheduleOut"]
    total_cost: float
    completed_count: int
    open_count: int


# ---------------------------------------------------------------- preventive maintenance

class PMScheduleIn(BaseModel):
    property_id: uuid.UUID
    asset_id: uuid.UUID | None = None
    system: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    category: str = "general"
    priority: Priority = "normal"
    frequency: Literal["weekly", "monthly", "quarterly", "semiannual", "annual", "custom"] = "quarterly"
    interval_days: int | None = Field(default=None, ge=1, le=3650)
    lead_days: int = Field(default=14, ge=0, le=180)
    last_service_on: date | None = None
    next_service_on: date
    default_vendor_id: uuid.UUID | None = None
    default_assignee_id: uuid.UUID | None = None
    estimate_amount: float | None = Field(default=None, ge=0)
    is_active: bool = True


class PMScheduleOut(PMScheduleIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_name: str | None = None
    vendor_name: str | None = None
    last_generated_on: date | None
    last_work_order_id: uuid.UUID | None
    is_due: bool = False
    updated_at: datetime


class PMScanOut(BaseModel):
    scanned: int
    generated: int
    work_order_ids: list[uuid.UUID]


# ---------------------------------------------------------------- inspections

class TemplateItem(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=200)
    guidance: str | None = None
    category: str | None = None


class TemplateSection(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=160)
    items: list[TemplateItem] = []


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    property_type: str | None = None
    description: str | None = None
    sections: list[TemplateSection] = []
    is_active: bool = True


class TemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    property_type: str | None
    description: str | None
    sections: list
    version: int
    is_active: bool
    item_count: int = 0
    updated_at: datetime


class InspectionCreate(BaseModel):
    template_id: uuid.UUID
    property_id: uuid.UUID
    asset_id: uuid.UUID | None = None
    inspector_id: uuid.UUID | None = None
    scheduled_on: date | None = None


class InspectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inspector_id: uuid.UUID | None = None
    scheduled_on: date | None = None
    summary: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)


class ResponseIn(BaseModel):
    item_key: str
    result: Literal["pass", "fail", "na"] | None = None
    note: str | None = None


class ResponsesIn(BaseModel):
    responses: list[ResponseIn] = Field(min_length=1)


class InspectionStatusIn(BaseModel):
    status: Literal["in_progress", "completed", "cancelled"]
    summary: str | None = None


class FindingIn(BaseModel):
    item_key: str | None = None
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    category: str = "general"
    severity: Severity = "medium"
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    location_accuracy_m: float | None = Field(default=None, ge=0)
    captured_at: datetime | None = None
    photo_document_ids: list[uuid.UUID] = []


class FindingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    category: str | None = None
    severity: Severity | None = None
    status: Literal["open", "resolved", "deferred"] | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    location_accuracy_m: float | None = None
    photo_document_ids: list[uuid.UUID] | None = None


class FindingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    inspection_id: uuid.UUID
    property_id: uuid.UUID
    item_key: str | None
    item_label: str | None
    section_title: str | None
    title: str
    description: str | None
    category: str
    severity: str
    status: str
    latitude: float | None
    longitude: float | None
    location_accuracy_m: float | None
    captured_at: datetime | None
    photo_document_ids: list[uuid.UUID]
    work_order_id: uuid.UUID | None
    created_at: datetime


class FindingCreated(BaseModel):
    finding: FindingOut
    work_order_id: uuid.UUID | None = None
    auto_created: bool = False


class InspectionListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    template_id: uuid.UUID | None
    template_name: str | None
    property_id: uuid.UUID
    property_name: str | None = None
    property_type: str | None = None
    asset_id: uuid.UUID | None
    inspector_id: uuid.UUID | None
    inspector_name: str | None = None
    status: str
    scheduled_on: date | None
    completed_at: datetime | None
    score: float | None
    finding_count: int = 0
    open_finding_count: int = 0
    updated_at: datetime


class InspectionOut(InspectionListItem):
    template_version: int | None
    sections: list
    responses: dict
    started_at: datetime | None
    latitude: float | None
    longitude: float | None
    summary: str | None
    findings: list[FindingOut] = []
    progress: dict = {}
    created_at: datetime


class InspectionFacets(BaseModel):
    status: dict[str, int]


ServiceHistoryOut.model_rebuild()
