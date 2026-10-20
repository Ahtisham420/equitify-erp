import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

LEASE_STATUSES = ["draft", "active", "expired", "terminated"]
LEASE_TYPES = ["nnn", "absolute_nnn", "modified_gross", "gross", "ground", "percentage"]
ESCALATION_METHODS = ["flat", "fixed_pct", "fixed_amount", "cpi", "step_table"]
RECOVERY_METHODS = ["nnn", "modified_gross", "base_year", "expense_stop", "fixed_cam"]
RECOVERY_CATEGORIES = ["all", "cam", "tax", "insurance", "utilities"]
CAP_TYPES = ["none", "cumulative", "non_cumulative"]
OPTION_TYPES = ["renewal", "expansion", "termination", "purchase", "rofr", "rofo"]
OPTION_STATUSES = ["open", "exercised", "waived", "expired"]
PRICING_METHODS = ["fixed_rent", "fixed_increase", "fmv", "pct_of_fmv", "fixed_price", "fee", "matching", "none"]
CLAUSE_CATEGORIES = [
    "use", "exclusive", "cotenancy", "kickout", "assignment", "subletting", "maintenance", "replacement",
    "insurance", "holdover", "default", "remedies", "estoppel", "certificate", "reporting", "landlord_obligation",
    "radius", "relocation", "sna", "other",
]
# Clause categories that carry a deliverable date and feed the critical-date engine once verified.
OBLIGATION_CATEGORIES = {"estoppel", "certificate", "reporting", "landlord_obligation", "insurance"}
AMENDMENT_KINDS = ["amendment", "assignment", "guaranty", "side_letter", "renewal", "commencement_letter", "other"]
GUARANTY_TYPES = ["full", "limited", "good_guy", "burn_down", "corporate", "personal"]
RECON_STATUSES = ["draft", "final", "billed"]

# Abstracted lease terms whose changes are historical facts (source, date, confidence, verification).
MATERIAL_FIELDS = {
    "tenant_name", "tenant_organization_id", "space_id", "lease_type", "commencement_on", "expiration_on",
    "rentable_sf", "base_rent_annual", "pro_rata_share", "security_deposit", "status",
    "late_fee_grace_days", "late_fee_pct", "late_fee_flat",
}
# Terms an amendment / assignment / side letter may override as of its effective date.
OVERRIDABLE_FIELDS = {
    "tenant_name", "tenant_organization_id", "space_id", "lease_type", "commencement_on", "expiration_on",
    "rentable_sf", "base_rent_annual", "pro_rata_share", "security_deposit", "landlord_name", "premises_description",
    "late_fee_grace_days", "late_fee_pct", "late_fee_flat", "status",
}


class Citation:
    """Clause-level source citation: the document, page and clause a term was abstracted from."""

    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    page: Mapped[int | None] = mapped_column(Integer)
    clause_ref: Mapped[str | None] = mapped_column(String(80))
    quoted_text: Mapped[str | None] = mapped_column(Text)


class Verifiable:
    """AI-extracted terms stay unverified until a named human verifies them."""

    verified: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    ai_extracted: Mapped[bool] = mapped_column(Boolean, default=False)
    confidence: Mapped[float | None] = mapped_column(Float)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @declared_attr
    def verified_by_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class Lease(Verifiable, Entity, Base):
    __tablename__ = "leases"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    space_id: Mapped[uuid.UUID | None] = fk("spaces")
    # Plain references: assets and documents are owned by other modules.
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    tenant_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    tenant_name: Mapped[str] = mapped_column(String(200), index=True)
    landlord_name: Mapped[str | None] = mapped_column(String(200))
    premises_description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    lease_type: Mapped[str] = mapped_column(String(30), default="nnn", index=True)
    execution_on: Mapped[date | None] = mapped_column(Date)
    commencement_on: Mapped[date | None] = mapped_column(Date, index=True)
    rent_commencement_on: Mapped[date | None] = mapped_column(Date)
    expiration_on: Mapped[date | None] = mapped_column(Date, index=True)
    rentable_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    pro_rata_share: Mapped[float | None] = mapped_column(Float)  # percent 0-100
    base_rent_annual: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    security_deposit: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    # Stored escalation parameters used by the rent-step generator.
    escalation: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Late-fee terms (null -> receivables defaults).
    late_fee_grace_days: Mapped[int | None] = mapped_column(Integer)
    late_fee_pct: Mapped[float | None] = mapped_column(Float)
    late_fee_flat: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    # Rollover / valuation assumptions.
    market_rent_psf: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    renewal_probability: Mapped[float | None] = mapped_column(Float)  # 0-1
    downtime_months: Mapped[int | None] = mapped_column(Integer)
    releasing_cost_psf: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    # Field-level citations {field: {document_id, page, clause_ref, quoted_text}}.
    citations: Mapped[dict] = mapped_column(JSONB, default=dict)
    manager_id: Mapped[uuid.UUID | None] = fk("users")
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class RentStep(Citation, Entity, Base):
    __tablename__ = "rent_steps"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    amendment_id: Mapped[uuid.UUID | None] = fk("lease_amendments")
    start_on: Mapped[date] = mapped_column(Date, index=True)
    end_on: Mapped[date] = mapped_column(Date)
    annual_rent: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    monthly_rent: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    rent_psf: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    charge_type: Mapped[str] = mapped_column(String(30), default="base_rent")
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual | generated | amendment
    note: Mapped[str | None] = mapped_column(String(300))


class LeaseRecovery(Citation, Verifiable, Entity, Base):
    __tablename__ = "lease_recoveries"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    method: Mapped[str] = mapped_column(String(30), default="nnn")
    category: Mapped[str] = mapped_column(String(20), default="all")
    pro_rata_share: Mapped[float | None] = mapped_column(Float)  # percent; null -> lease share or SF ratio
    base_year: Mapped[int | None] = mapped_column(Integer)
    base_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))  # base-year / stop pool total
    expense_stop_psf: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    fixed_amount_annual: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    estimated_monthly: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cap_type: Mapped[str] = mapped_column(String(20), default="none")
    cap_pct: Mapped[float | None] = mapped_column(Float)
    cap_base_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cap_base_year: Mapped[int | None] = mapped_column(Integer)
    admin_fee_pct: Mapped[float | None] = mapped_column(Float)
    gross_up_pct: Mapped[float | None] = mapped_column(Float)
    exclusions: Mapped[list[str]] = mapped_column(ARRAY(String(80)), default=list)
    notes: Mapped[str | None] = mapped_column(Text)


class LeaseOption(Citation, Verifiable, Entity, Base):
    __tablename__ = "lease_options"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    option_type: Mapped[str] = mapped_column(String(20), index=True)
    sequence: Mapped[int] = mapped_column(Integer, default=1)
    term_months: Mapped[int | None] = mapped_column(Integer)
    notice_start_on: Mapped[date | None] = mapped_column(Date)
    notice_end_on: Mapped[date | None] = mapped_column(Date, index=True)
    effective_on: Mapped[date | None] = mapped_column(Date)
    pricing_method: Mapped[str] = mapped_column(String(20), default="none")
    pricing_params: Mapped[dict] = mapped_column(JSONB, default=dict)
    option_rent_psf: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    increase_pct: Mapped[float | None] = mapped_column(Float)
    fmv_pct: Mapped[float | None] = mapped_column(Float)
    fee_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    purchase_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    market_rent_psf: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    space_description: Mapped[str | None] = mapped_column(String(300))
    conditions: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    exercised_on: Mapped[date | None] = mapped_column(Date)


class LeaseClause(Citation, Verifiable, Entity, Base):
    """Structured clause (use, exclusive, cotenancy, assignment, maintenance, holdover...) with its citation."""

    __tablename__ = "lease_clauses"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    amendment_id: Mapped[uuid.UUID | None] = fk("lease_amendments")
    category: Mapped[str] = mapped_column(String(30), index=True)
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str | None] = mapped_column(Text)
    terms: Mapped[dict] = mapped_column(JSONB, default=dict)
    obligated_party: Mapped[str | None] = mapped_column(String(20))  # landlord | tenant | guarantor
    due_on: Mapped[date | None] = mapped_column(Date)
    recurrence: Mapped[str | None] = mapped_column(String(20))  # once | monthly | quarterly | annual
    response_days: Mapped[int | None] = mapped_column(Integer)


class LeaseAmendment(Entity, Base):
    """Amendment / assignment / guaranty / side-letter chain. Overrides apply from effective_on; nothing is deleted."""

    __tablename__ = "lease_amendments"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(30), default="amendment")
    sequence: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(200))
    executed_on: Mapped[date | None] = mapped_column(Date)
    effective_on: Mapped[date] = mapped_column(Date, index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    page: Mapped[int | None] = mapped_column(Integer)
    clause_ref: Mapped[str | None] = mapped_column(String(80))
    overrides: Mapped[dict] = mapped_column(JSONB, default=dict)
    summary: Mapped[str | None] = mapped_column(Text)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verified_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Guaranty(Citation, Verifiable, Entity, Base):
    __tablename__ = "guaranties"

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    guarantor_name: Mapped[str] = mapped_column(String(200))
    guarantor_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    guarantor_person_id: Mapped[uuid.UUID | None] = fk("people")
    guaranty_type: Mapped[str] = mapped_column(String(20), default="full")
    cap_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    effective_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date)
    burn_down: Mapped[list] = mapped_column(JSONB, default=list)  # [{on, cap_amount}]
    financials_required: Mapped[bool] = mapped_column(Boolean, default=False)
    financials_due_on: Mapped[date | None] = mapped_column(Date)
    estoppel_days: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="active")
    notes: Mapped[str | None] = mapped_column(Text)


class RecoveryReconciliation(Entity, Base):
    """Annual recovery reconciliation for one lease: recoverable pool -> tenant share (caps applied) -> true-up."""

    __tablename__ = "recovery_reconciliations"
    __table_args__ = (UniqueConstraint("lease_id", "year", name="uq_recon_lease_year"),)

    lease_id: Mapped[uuid.UUID] = fk("leases", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    year: Mapped[int] = mapped_column(Integer, index=True)
    budgeted_pool: Mapped[dict] = mapped_column(JSONB, default=dict)
    actual_pool: Mapped[dict] = mapped_column(JSONB, default=dict)
    share_pct: Mapped[float | None] = mapped_column(Float)
    budgeted_share: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    actual_share: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    cap_reduction: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    estimates_billed: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    true_up_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    details: Mapped[list] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    finalized_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    billed_charge_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
