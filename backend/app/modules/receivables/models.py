import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

CHARGE_TYPES = [
    "base_rent", "recovery", "cam", "tax", "insurance", "utilities", "fixed_cam", "late_fee", "recovery_true_up",
    "percentage_rent", "parking", "repair", "other",
]
CHARGE_STATUSES = ["pending_approval", "open", "partial", "paid", "credit", "void"]
CHARGE_SOURCES = ["schedule", "manual", "late_fee", "reconciliation"]
PAYMENT_METHODS = ["ach", "check", "wire", "card", "cash", "other"]
PAYMENT_STATUSES = ["received", "reversed"]
NOTICE_STATUSES = ["draft", "sent", "cancelled"]
PLAN_STATUSES = ["active", "completed", "breached", "cancelled"]
COLLECTION_STATUSES = ["current", "delinquent", "payment_plan", "legal", "resolved"]
AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"]


class Charge(Entity, Base):
    """Every charge traces to lease terms (schedule / late fee / reconciliation) or an approved manual entry."""

    __tablename__ = "charges"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    tenant_name: Mapped[str | None] = mapped_column(String(200))
    charge_type: Mapped[str] = mapped_column(String(30), index=True)
    period_start: Mapped[date | None] = mapped_column(Date, index=True)
    period_end: Mapped[date | None] = mapped_column(Date)
    due_on: Mapped[date] = mapped_column(Date, index=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    amount_paid: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    source: Mapped[str] = mapped_column(String(20), index=True)
    source_ref: Mapped[dict] = mapped_column(JSONB, default=dict)
    description: Mapped[str | None] = mapped_column(String(300))
    idempotency_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    voided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    void_reason: Mapped[str | None] = mapped_column(String(300))
    external_ref: Mapped[str | None] = mapped_column(String(120), index=True)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Payment(Entity, Base):
    """Payments are never edited or deleted: corrections are reversals with a reason."""

    __tablename__ = "payments"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    tenant_name: Mapped[str | None] = mapped_column(String(200))
    received_on: Mapped[date] = mapped_column(Date, index=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    unapplied_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    method: Mapped[str] = mapped_column(String(20), default="ach")
    reference: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), default="received", index=True)
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reversal_reason: Mapped[str | None] = mapped_column(String(300))
    notes: Mapped[str | None] = mapped_column(Text)
    external_ref: Mapped[str | None] = mapped_column(String(120), index=True)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PaymentApplication(Entity, Base):
    __tablename__ = "payment_applications"

    payment_id: Mapped[uuid.UUID] = fk("payments", nullable=False, ondelete="CASCADE")
    charge_id: Mapped[uuid.UUID] = fk("charges", nullable=False, ondelete="CASCADE")
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    applied_on: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String(10), default="auto")  # auto | manual
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reversal_reason: Mapped[str | None] = mapped_column(String(300))


class CollectionStatus(Entity, Base):
    """Per-lease position on the delinquency escalation ladder."""

    __tablename__ = "collection_statuses"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    status: Mapped[str] = mapped_column(String(20), default="current", index=True)
    step_index: Mapped[int] = mapped_column(Integer, default=0)
    step_key: Mapped[str | None] = mapped_column(String(40))
    past_due_balance: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    days_past_due: Mapped[int] = mapped_column(Integer, default=0)
    oldest_due_on: Mapped[date | None] = mapped_column(Date)
    on_hold: Mapped[bool] = mapped_column(Boolean, default=False)
    last_evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (UniqueConstraint("lease_id", name="uq_collection_lease"),)


class DelinquencyNotice(Entity, Base):
    __tablename__ = "delinquency_notices"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    step_key: Mapped[str] = mapped_column(String(40), index=True)
    step_index: Mapped[int] = mapped_column(Integer, default=0)
    label: Mapped[str] = mapped_column(String(160))
    balance: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    days_past_due: Mapped[int] = mapped_column(Integer, default=0)
    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    delivery_method: Mapped[str | None] = mapped_column(String(20))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    idempotency_key: Mapped[str | None] = mapped_column(String(200), unique=True)


class PaymentPlan(Entity, Base):
    __tablename__ = "payment_plans"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    total_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    start_on: Mapped[date] = mapped_column(Date)
    installment_count: Mapped[int] = mapped_column(Integer)
    frequency_months: Mapped[int] = mapped_column(Integer, default=1)
    grace_days: Mapped[int] = mapped_column(Integer, default=5)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    paid_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    breached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    notes: Mapped[str | None] = mapped_column(Text)


class PaymentPlanInstallment(Entity, Base):
    __tablename__ = "payment_plan_installments"

    plan_id: Mapped[uuid.UUID] = fk("payment_plans", nullable=False, ondelete="CASCADE")
    sequence: Mapped[int] = mapped_column(Integer)
    due_on: Mapped[date] = mapped_column(Date)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    paid_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    status: Mapped[str] = mapped_column(String(20), default="scheduled")  # scheduled | partial | paid | missed


class ReceivablesSetting(Entity, Base):
    """Configurable late-fee defaults, escalation ladder and aging automation thresholds."""

    __tablename__ = "receivables_settings"

    key: Mapped[str] = mapped_column(String(60), unique=True)
    value: Mapped[Any] = mapped_column(JSONB)


class SyncBatch(Entity, Base):
    """Accounting / banking synchronisation batch (export or import)."""

    __tablename__ = "sync_batches"

    direction: Mapped[str] = mapped_column(String(10), index=True)  # export | import
    system: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(30), default="completed", index=True)
    period_from: Mapped[date | None] = mapped_column(Date)
    period_to: Mapped[date | None] = mapped_column(Date)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    entry_count: Mapped[int] = mapped_column(Integer, default=0)
    matched_count: Mapped[int] = mapped_column(Integer, default=0)
    conflict_count: Mapped[int] = mapped_column(Integer, default=0)
    external_batch_id: Mapped[str | None] = mapped_column(String(120))
    payload: Mapped[list] = mapped_column(JSONB, default=list)
    summary: Mapped[str | None] = mapped_column(Text)


class SyncConflict(Entity, Base):
    """External data that disagrees with ours. Never applied automatically; a human resolves it."""

    __tablename__ = "sync_conflicts"

    batch_id: Mapped[uuid.UUID] = fk("sync_batches", nullable=False, ondelete="CASCADE")
    entity_type: Mapped[str] = mapped_column(String(20))  # charge | payment
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    external_id: Mapped[str | None] = mapped_column(String(120))
    field: Mapped[str] = mapped_column(String(40))
    local_value: Mapped[Any] = mapped_column(JSONB)
    external_value: Mapped[Any] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    resolved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolution_note: Mapped[str | None] = mapped_column(String(300))
