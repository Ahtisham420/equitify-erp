import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

WO_SOURCES = ["tenant", "staff", "inspection", "preventive"]
WO_CATEGORIES = [
    "hvac", "plumbing", "electrical", "roof", "structural", "parking_lot", "landscaping", "life_safety",
    "janitorial", "pest_control", "doors_locks", "signage", "elevator", "general", "other",
]
WO_PRIORITIES = ["low", "normal", "high", "urgent"]
# Ordered workflow; `cancelled` is a terminal side exit.
WO_STATUSES = ["open", "assigned", "in_progress", "completed", "verified", "cancelled"]
WO_TRANSITIONS: dict[str, set[str]] = {
    "open": {"assigned", "cancelled"},
    "assigned": {"in_progress", "open", "cancelled"},
    "in_progress": {"completed", "assigned", "cancelled"},
    "completed": {"verified", "in_progress"},
    "verified": set(),
    "cancelled": {"open"},
}
APPROVAL_STATES = ["not_required", "pending", "approved", "rejected"]
RESPONSIBILITY = ["undetermined", "tenant", "landlord", "shared"]
CHARGEBACK_STATES = ["none", "created", "pending_manual"]

PM_FREQUENCIES = {"weekly": 7, "monthly": 30, "quarterly": 91, "semiannual": 182, "annual": 365}
INSPECTION_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"]
ITEM_RESULTS = ["pass", "fail", "na"]
SEVERITIES = ["low", "medium", "high", "critical"]
FINDING_STATUSES = ["open", "work_order_created", "resolved", "deferred"]


class WorkOrder(Entity, Base):
    __tablename__ = "work_orders"

    number: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(20), default="staff", index=True)
    category: Mapped[str] = mapped_column(String(30), default="general", index=True)
    priority: Mapped[str] = mapped_column(String(10), default="normal", index=True)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    status_history: Mapped[list] = mapped_column(JSONB, default=list)

    # Location: property / asset / space / free-text detail. assets + leases are owned by other modules → plain UUIDs.
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    space_id: Mapped[uuid.UUID | None] = fk("spaces")
    lease_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    system: Mapped[str | None] = mapped_column(String(120))
    location_detail: Mapped[str | None] = mapped_column(String(200))

    requested_by_name: Mapped[str | None] = mapped_column(String(200))
    requester_contact: Mapped[str | None] = mapped_column(String(200))
    tenant_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_on: Mapped[date | None] = mapped_column(Date, index=True)
    photo_document_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)

    # Assignment
    assignee_type: Mapped[str | None] = mapped_column(String(10))  # vendor | staff
    vendor_id: Mapped[uuid.UUID | None] = fk("vendors")
    assigned_user_id: Mapped[uuid.UUID | None] = fk("users")
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Cost & approval
    estimate_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    approval_status: Mapped[str] = mapped_column(String(20), default="not_required", index=True)
    approval_threshold: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approval_note: Mapped[str | None] = mapped_column(Text)
    actual_cost: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))

    # Completion & verification
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    completion_notes: Mapped[str | None] = mapped_column(Text)
    evidence_document_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verified_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    cancelled_reason: Mapped[str | None] = mapped_column(Text)
    satisfaction_rating: Mapped[int | None] = mapped_column(Integer)
    satisfaction_comment: Mapped[str | None] = mapped_column(Text)

    # Tenant responsibility (from lease obligations)
    tenant_responsibility: Mapped[str] = mapped_column(String(20), default="undetermined", index=True)
    tenant_share_pct: Mapped[float | None] = mapped_column(Float)
    responsibility_reason: Mapped[str | None] = mapped_column(Text)
    responsibility_basis: Mapped[list] = mapped_column(JSONB, default=list)
    responsibility_method: Mapped[str | None] = mapped_column(String(20))  # lease_rules | manual
    responsibility_determined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    responsibility_determined_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    chargeback_status: Mapped[str] = mapped_column(String(20), default="none")
    chargeback_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    chargeback_charge_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # Origin links
    pm_schedule_id: Mapped[uuid.UUID | None] = fk("pm_schedules")
    inspection_id: Mapped[uuid.UUID | None] = fk("inspections")
    finding_id: Mapped[uuid.UUID | None] = fk("inspection_findings")
    idempotency_key: Mapped[str | None] = mapped_column(String(200), unique=True)


class MaintenanceSettings(Entity, Base):
    """Single-row configuration for maintenance automations and approval thresholds."""

    __tablename__ = "maintenance_settings"

    approval_threshold: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=5000)
    finding_auto_wo_severity: Mapped[str] = mapped_column(String(10), default="high")
    pm_default_lead_days: Mapped[int] = mapped_column(Integer, default=14)


class PMSchedule(Entity, Base):
    __tablename__ = "pm_schedules"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    system: Mapped[str] = mapped_column(String(120))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(30), default="general")
    priority: Mapped[str] = mapped_column(String(10), default="normal")
    frequency: Mapped[str] = mapped_column(String(20), default="quarterly")
    interval_days: Mapped[int | None] = mapped_column(Integer)  # for frequency=custom
    lead_days: Mapped[int] = mapped_column(Integer, default=14)
    last_service_on: Mapped[date | None] = mapped_column(Date)
    next_service_on: Mapped[date] = mapped_column(Date, index=True)
    default_vendor_id: Mapped[uuid.UUID | None] = fk("vendors")
    default_assignee_id: Mapped[uuid.UUID | None] = fk("users")
    estimate_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_generated_on: Mapped[date | None] = mapped_column(Date)
    last_work_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class InspectionTemplate(Entity, Base):
    """sections: [{key, title, items: [{key, label, guidance?}]}]"""

    __tablename__ = "inspection_templates"

    name: Mapped[str] = mapped_column(String(160))
    property_type: Mapped[str | None] = mapped_column(String(40), index=True)  # None = any type
    description: Mapped[str | None] = mapped_column(Text)
    sections: Mapped[list] = mapped_column(JSONB, default=list)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class Inspection(Entity, Base):
    __tablename__ = "inspections"

    template_id: Mapped[uuid.UUID | None] = fk("inspection_templates")
    template_name: Mapped[str | None] = mapped_column(String(160))
    template_version: Mapped[int | None] = mapped_column(Integer)
    sections: Mapped[list] = mapped_column(JSONB, default=list)  # snapshot of the template at creation
    responses: Mapped[dict] = mapped_column(JSONB, default=dict)  # {item_key: {result, note, answered_at}}
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    inspector_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="scheduled", index=True)
    scheduled_on: Mapped[date | None] = mapped_column(Date, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    summary: Mapped[str | None] = mapped_column(Text)
    score: Mapped[float | None] = mapped_column(Float)  # pass rate % over answered pass/fail items


class InspectionFinding(Entity, Base):
    __tablename__ = "inspection_findings"

    inspection_id: Mapped[uuid.UUID] = fk("inspections", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    item_key: Mapped[str | None] = mapped_column(String(80))
    item_label: Mapped[str | None] = mapped_column(String(200))
    section_title: Mapped[str | None] = mapped_column(String(160))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(30), default="general")
    severity: Mapped[str] = mapped_column(String(10), default="medium", index=True)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    location_accuracy_m: Mapped[float | None] = mapped_column(Float)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    photo_document_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)
    # Plain UUID (work_orders already references inspection_findings; avoids an FK cycle).
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
