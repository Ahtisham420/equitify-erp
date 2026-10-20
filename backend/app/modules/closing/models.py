import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

CLOSING_STATUSES = ["open", "completed", "cancelled"]
CHECKLIST_CATEGORIES = [
    "settlement_statement", "prorations", "insurance", "entity_standing", "lender_conditions", "tenant_notices",
    "vendors", "utilities", "other",
]
ITEM_STATUSES = ["open", "in_progress", "done", "waived", "not_applicable"]
SATISFIED_STATUSES = ["done", "waived", "not_applicable"]
WIRE_RESULTS = ["pending", "passed", "failed", "superseded"]
SOURCE_KINDS = ["equity", "senior_debt", "mezzanine", "seller_financing", "deposit_credit", "other"]
USE_KINDS = ["purchase_price", "closing_costs", "acquisition_fee", "financing_costs", "reserves", "capex", "other"]

# Default checklist (spec 17): category, title, blocking.
CHECKLIST_TEMPLATE: list[dict] = [
    {"key": "ss_review", "category": "settlement_statement", "title": "Review settlement statement draft", "blocking": True},
    {"key": "ss_approve", "category": "settlement_statement", "title": "Approve and sign final settlement statement", "blocking": True},
    {"key": "pr_rent", "category": "prorations", "title": "Verify rent, CAM and reimbursement prorations", "blocking": True},
    {"key": "pr_tax", "category": "prorations", "title": "Verify property tax prorations", "blocking": True},
    {"key": "pr_deposits", "category": "prorations", "title": "Confirm tenant security deposit credits", "blocking": True},
    {"key": "ins_bind", "category": "insurance", "title": "Bind property and liability insurance effective at closing", "blocking": True},
    {"key": "ins_cert", "category": "insurance", "title": "Deliver insurance certificates to lender", "blocking": False},
    {"key": "ent_good_standing", "category": "entity_standing", "title": "Certificate of good standing for buyer entity", "blocking": True},
    {"key": "ent_authority", "category": "entity_standing", "title": "Authority resolutions and incumbency certificate", "blocking": True},
    {"key": "lend_conditions", "category": "lender_conditions", "title": "Satisfy lender closing conditions", "blocking": True},
    {"key": "lend_docs", "category": "lender_conditions", "title": "Loan documents executed and funding authorized", "blocking": True},
    {"key": "ten_letters", "category": "tenant_notices", "title": "Prepare tenant notice / rent direction letters", "blocking": False},
    {"key": "ten_send", "category": "tenant_notices", "title": "Send tenant notices after closing", "blocking": False},
    {"key": "ven_contracts", "category": "vendors", "title": "Decide assumption or termination of service contracts", "blocking": False},
    {"key": "ven_notices", "category": "vendors", "title": "Notify vendors of ownership change", "blocking": False},
    {"key": "util_transfer", "category": "utilities", "title": "Transfer utility accounts to new owner", "blocking": False},
]

HANDOFF_SECTIONS: dict[str, str] = {
    "rent_roll": "Rent roll",
    "leases": "Leases",
    "service_contracts": "Service contracts",
    "warranties": "Warranties",
    "keys_access": "Keys & access",
    "utilities": "Utilities",
    "tax_insurance": "Tax & insurance",
    "open_dd_items": "Open DD items",
}


class Closing(Entity, Base):
    """One closing per opportunity (spec 17)."""

    __tablename__ = "closings"

    opportunity_id: Mapped[uuid.UUID] = fk("opportunities", nullable=False, ondelete="RESTRICT")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    # Other Release-3/4 modules: plain UUIDs keep this table independent of their load order.
    offer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    uw_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    coordinator_id: Mapped[uuid.UUID | None] = fk("users")
    manager_id: Mapped[uuid.UUID | None] = fk("users")  # responsible asset manager after closing
    scheduled_closing_on: Mapped[date | None] = mapped_column(Date, index=True)

    purchase_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    sources: Mapped[list] = mapped_column(JSONB, default=list)  # [{label, kind, amount}]
    uses: Mapped[list] = mapped_column(JSONB, default=list)  # [{label, kind, amount, capitalized}]
    total_sources: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    total_uses: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    basis: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    capital_structure: Mapped[dict] = mapped_column(JSONB, default=dict)

    hold_thesis: Mapped[str | None] = mapped_column(Text)
    business_plan: Mapped[str | None] = mapped_column(Text)
    target_hold_years: Mapped[float | None] = mapped_column(Float)
    notes: Mapped[str | None] = mapped_column(Text)

    closed_on: Mapped[date | None] = mapped_column(Date)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    asset_pending: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    asset_error: Mapped[str | None] = mapped_column(Text)

    audit_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    audit_due_on: Mapped[date | None] = mapped_column(Date)
    audit_result: Mapped[dict | None] = mapped_column(JSONB)
    audit_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audit_completed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class ClosingChecklistItem(Entity, Base):
    __tablename__ = "closing_checklist_items"

    closing_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("closings.id", ondelete="CASCADE"), index=True
    )
    template_key: Mapped[str | None] = mapped_column(String(40))
    category: Mapped[str] = mapped_column(String(30), index=True, default="other")
    title: Mapped[str] = mapped_column(String(300))
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    due_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    is_blocking: Mapped[bool] = mapped_column(Boolean, default=False)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)
    waived_reason: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class WireVerification(Entity, Base):
    """Wire instructions plus an independent callback. Rows are never edited: new instructions supersede."""

    __tablename__ = "wire_verifications"

    closing_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("closings.id", ondelete="CASCADE"), index=True
    )
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    # Instructions as received
    beneficiary_name: Mapped[str] = mapped_column(String(200))
    bank_name: Mapped[str] = mapped_column(String(200))
    routing_number: Mapped[str] = mapped_column(String(20))
    account_number: Mapped[str] = mapped_column(String(40))
    amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    instruction_source: Mapped[str] = mapped_column(String(200))  # how / from where the instructions arrived
    instruction_received_from: Mapped[str | None] = mapped_column(String(200))
    instruction_contact_phone: Mapped[str | None] = mapped_column(String(40))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # Independent callback
    callback_phone: Mapped[str | None] = mapped_column(String(40))
    callback_phone_source: Mapped[str | None] = mapped_column(String(200))
    callback_contact_name: Mapped[str | None] = mapped_column(String(200))
    verified_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    verified_by_name: Mapped[str | None] = mapped_column(String(200))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    result_notes: Mapped[str | None] = mapped_column(Text)


class ClosingSnapshot(UUIDPk, Base):
    """Immutable final transaction state. There is intentionally no update or delete path."""

    __tablename__ = "closing_snapshots"

    closing_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("closings.id", ondelete="RESTRICT"), unique=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    created_by_name: Mapped[str | None] = mapped_column(String(200))
    sha256: Mapped[str] = mapped_column(String(64))
    data: Mapped[dict] = mapped_column(JSONB)


class HandoffPackage(Entity, Base):
    """Operations handoff: what the operating team receives instead of re-entering acquisition knowledge."""

    __tablename__ = "handoff_packages"

    closing_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("closings.id", ondelete="CASCADE"), unique=True, index=True
    )
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    # {section_key: {"items": [{label, detail, document_id, status}], "notes": str}}
    sections: Mapped[dict] = mapped_column(JSONB, default=dict)
    open_dd_items: Mapped[list] = mapped_column(JSONB, default=list)
    carry_forward: Mapped[dict] = mapped_column(JSONB, default=dict)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    recipient_id: Mapped[uuid.UUID | None] = fk("users")
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
