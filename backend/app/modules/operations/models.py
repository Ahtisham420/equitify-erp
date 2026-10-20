import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base
from app.core.security import utcnow

VENDOR_STATUSES = ["active", "pending", "inactive", "suspended"]
CREDENTIAL_KINDS = ["license", "insurance_coi", "w9", "other"]
CREDENTIAL_STATUSES = ["valid", "expiring", "expired", "pending", "rejected"]
PROJECT_STATUSES = ["draft", "pending_approval", "approved", "bidding", "awarded", "in_progress", "completed",
                    "closed", "cancelled"]
BID_STATUSES = ["submitted", "shortlisted", "awarded", "rejected", "withdrawn"]
DRAW_STATUSES = ["requested", "approved", "paid", "rejected"]
CHANGE_ORDER_STATUSES = ["pending", "approved", "rejected"]
COVERAGE_TYPES = ["property", "general_liability", "umbrella", "flood", "earthquake", "wind", "builders_risk",
                  "environmental", "terrorism", "workers_comp", "auto", "other"]
POLICY_STATUSES = ["active", "pending_renewal", "expired", "cancelled"]
CERTIFICATE_STATUSES = ["requested", "compliant", "deficient", "expired"]
CLAIM_STATUSES = ["reported", "open", "under_review", "approved", "denied", "paid", "closed"]
PROTEST_STATUSES = ["considering", "filed", "evidence_submitted", "hearing_scheduled", "settled", "won", "lost",
                    "withdrawn"]
PAYMENT_STATUSES = ["scheduled", "paid", "confirmed", "late"]
BUDGET_STATUSES = ["draft", "submitted", "approved", "superseded"]
BUDGET_CATEGORIES = ["income", "expense", "capex"]


# ======================================================================= vendors

class Vendor(Entity, Base):
    __tablename__ = "vendors"

    organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    name: Mapped[str] = mapped_column(String(200), index=True)
    services: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    primary_contact_name: Mapped[str | None] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(60))
    address: Mapped[str | None] = mapped_column(String(300))
    contacts: Mapped[list] = mapped_column(JSONB, default=list)  # [{name, role, email, phone}]
    rates: Mapped[list] = mapped_column(JSONB, default=list)  # [{service, unit, rate, notes}]
    contracts: Mapped[list] = mapped_column(JSONB, default=list)  # [{title, start_on, end_on, value, document_id}]
    service_area: Mapped[str | None] = mapped_column(String(200))
    requires_insurance: Mapped[bool] = mapped_column(Boolean, default=True)
    requires_license: Mapped[bool] = mapped_column(Boolean, default=False)
    performance_rating: Mapped[float | None] = mapped_column(Float)  # manual 1-5 review score
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class VendorCredential(Entity, Base):
    __tablename__ = "vendor_credentials"

    vendor_id: Mapped[uuid.UUID] = fk("vendors", nullable=False, ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(200))
    number: Mapped[str | None] = mapped_column(String(120))
    issuer: Mapped[str | None] = mapped_column(String(200))
    coverage_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    effective_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    is_required: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(20), default="valid", index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    verified_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class VendorReview(Entity, Base):
    """Performance review history; the vendor's rating is the mean of reviews."""

    __tablename__ = "vendor_reviews"

    vendor_id: Mapped[uuid.UUID] = fk("vendors", nullable=False, ondelete="CASCADE")
    rating: Mapped[int] = mapped_column(Integer)
    quality: Mapped[int | None] = mapped_column(Integer)
    timeliness: Mapped[int | None] = mapped_column(Integer)
    communication: Mapped[int | None] = mapped_column(Integer)
    comment: Mapped[str | None] = mapped_column(Text)
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


# ======================================================================= capital projects

class CapitalProject(Entity, Base):
    __tablename__ = "capital_projects"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(40), default="other")
    scope: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    manager_id: Mapped[uuid.UUID | None] = fk("users")
    original_budget: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    current_budget: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    contingency: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    budget_approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    budget_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    contractor_vendor_id: Mapped[uuid.UUID | None] = fk("vendors")
    awarded_bid_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    contract_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    start_on: Mapped[date | None] = mapped_column(Date)
    target_completion_on: Mapped[date | None] = mapped_column(Date, index=True)
    actual_completion_on: Mapped[date | None] = mapped_column(Date)
    milestones: Mapped[list] = mapped_column(JSONB, default=list)  # [{key, label, due_on, completed_on}]
    warranty_expires_on: Mapped[date | None] = mapped_column(Date)
    warranty_terms: Mapped[str | None] = mapped_column(Text)
    useful_life_years: Mapped[int | None] = mapped_column(Integer)
    recoverability: Mapped[dict | None] = mapped_column(JSONB)
    recoverability_analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class ProjectBudgetEntry(Entity, Base):
    """Append-only budget history: original, approved change orders and revisions."""

    __tablename__ = "project_budget_entries"

    project_id: Mapped[uuid.UUID] = fk("capital_projects", nullable=False, ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(20))  # original | change_order | revision
    amount_before: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    amount_after: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    delta: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    reason: Mapped[str | None] = mapped_column(Text)
    change_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProjectApproval(Entity, Base):
    __tablename__ = "project_approvals"

    project_id: Mapped[uuid.UUID] = fk("capital_projects", nullable=False, ondelete="CASCADE")
    stage: Mapped[str] = mapped_column(String(20))  # budget | award | change_order | draw | completion
    decision: Mapped[str] = mapped_column(String(10))  # approved | rejected
    amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    reference_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    note: Mapped[str | None] = mapped_column(Text)
    decided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProjectBid(Entity, Base):
    __tablename__ = "project_bids"

    project_id: Mapped[uuid.UUID] = fk("capital_projects", nullable=False, ondelete="CASCADE")
    vendor_id: Mapped[uuid.UUID] = fk("vendors", nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    submitted_on: Mapped[date | None] = mapped_column(Date)
    valid_until: Mapped[date | None] = mapped_column(Date)
    duration_days: Mapped[int | None] = mapped_column(Integer)
    scope_notes: Mapped[str | None] = mapped_column(Text)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(20), default="submitted", index=True)
    decision_note: Mapped[str | None] = mapped_column(Text)


class ProjectDraw(Entity, Base):
    __tablename__ = "project_draws"

    project_id: Mapped[uuid.UUID] = fk("capital_projects", nullable=False, ondelete="CASCADE")
    number: Mapped[int] = mapped_column(Integer)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    requested_on: Mapped[date] = mapped_column(Date)
    period_end_on: Mapped[date | None] = mapped_column(Date)
    percent_complete: Mapped[float | None] = mapped_column(Float)
    retainage: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    status: Mapped[str] = mapped_column(String(20), default="requested", index=True)
    lien_waiver_document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    lien_waiver_type: Mapped[str | None] = mapped_column(String(20))  # conditional | unconditional
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_on: Mapped[date | None] = mapped_column(Date)
    payment_reference: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)


class ChangeOrder(Entity, Base):
    __tablename__ = "change_orders"

    project_id: Mapped[uuid.UUID] = fk("capital_projects", nullable=False, ondelete="CASCADE")
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(String(40))  # owner_request | unforeseen | design | code | other
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    days_impact: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    decided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)


# ======================================================================= insurance

class InsurancePolicy(Entity, Base):
    __tablename__ = "insurance_policies"

    property_id: Mapped[uuid.UUID | None] = fk("properties")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    policy_number: Mapped[str] = mapped_column(String(120))
    coverage_type: Mapped[str] = mapped_column(String(30), index=True)
    carrier: Mapped[str] = mapped_column(String(200))
    broker: Mapped[str | None] = mapped_column(String(200))
    named_insured: Mapped[str | None] = mapped_column(String(200))
    limit_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    aggregate_limit: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    deductible: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    premium: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    effective_on: Mapped[date] = mapped_column(Date)
    expires_on: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    renewal_of_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class InsuranceCertificate(Entity, Base):
    __tablename__ = "insurance_certificates"

    holder_kind: Mapped[str] = mapped_column(String(10), index=True)  # tenant | vendor
    vendor_id: Mapped[uuid.UUID | None] = fk("vendors")
    tenant_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    tenant_name: Mapped[str | None] = mapped_column(String(200))
    lease_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    coverage_type: Mapped[str] = mapped_column(String(30), default="general_liability")
    carrier: Mapped[str | None] = mapped_column(String(200))
    policy_number: Mapped[str | None] = mapped_column(String(120))
    limit_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    required_limit: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    additional_insured: Mapped[bool] = mapped_column(Boolean, default=False)
    additional_insured_required: Mapped[bool] = mapped_column(Boolean, default=True)
    effective_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    received_on: Mapped[date | None] = mapped_column(Date)
    requested_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), default="requested", index=True)
    deficiencies: Mapped[list] = mapped_column(JSONB, default=list)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class InsuranceClaim(Entity, Base):
    __tablename__ = "insurance_claims"

    policy_id: Mapped[uuid.UUID | None] = fk("insurance_policies")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    claim_number: Mapped[str | None] = mapped_column(String(120))
    incident_on: Mapped[date] = mapped_column(Date)
    reported_on: Mapped[date | None] = mapped_column(Date)
    cause: Mapped[str | None] = mapped_column(String(60))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="reported", index=True)
    status_history: Mapped[list] = mapped_column(JSONB, default=list)
    claimed_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    reserve_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    paid_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    deductible_applied: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    adjuster_name: Mapped[str | None] = mapped_column(String(200))
    adjuster_contact: Mapped[str | None] = mapped_column(String(200))
    work_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    closed_on: Mapped[date | None] = mapped_column(Date)


# ======================================================================= property tax

class TaxAssessment(Entity, Base):
    __tablename__ = "tax_assessments"
    __table_args__ = (UniqueConstraint("property_id", "parcel_id", "tax_year", name="uq_tax_assessments_year"),)

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    parcel_id: Mapped[uuid.UUID | None] = fk("parcels")
    tax_year: Mapped[int] = mapped_column(Integer, index=True)
    jurisdiction: Mapped[str | None] = mapped_column(String(160))
    account_number: Mapped[str | None] = mapped_column(String(120))
    assessed_land: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    assessed_improvements: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    assessed_total: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    market_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    taxable_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    tax_rate: Mapped[float | None] = mapped_column(Float)  # % of taxable value
    estimated_tax: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    notice_received_on: Mapped[date | None] = mapped_column(Date)
    protest_deadline_on: Mapped[date | None] = mapped_column(Date)
    source: Mapped[str | None] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class TaxProtest(Entity, Base):
    __tablename__ = "tax_protests"

    assessment_id: Mapped[uuid.UUID] = fk("tax_assessments", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    tax_year: Mapped[int] = mapped_column(Integer, index=True)
    status: Mapped[str] = mapped_column(String(20), default="considering", index=True)
    deadline_on: Mapped[date | None] = mapped_column(Date, index=True)
    filed_on: Mapped[date | None] = mapped_column(Date)
    consultant_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    consultant_name: Mapped[str | None] = mapped_column(String(200))
    consultant_fee_pct: Mapped[float | None] = mapped_column(Float)  # contingency % of savings
    consultant_fee_flat: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    owner_opinion_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    evidence_document_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)), default=list)
    evidence_notes: Mapped[str | None] = mapped_column(Text)
    hearing_on: Mapped[date | None] = mapped_column(Date)
    hearing_result: Mapped[str | None] = mapped_column(String(20))  # reduced | no_change | increased | settled | withdrawn
    final_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_reduction: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    tax_savings: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    consultant_fee: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    net_savings: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    resolved_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class TaxPayment(Entity, Base):
    __tablename__ = "tax_payments"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    assessment_id: Mapped[uuid.UUID | None] = fk("tax_assessments")
    tax_year: Mapped[int] = mapped_column(Integer, index=True)
    installment: Mapped[str | None] = mapped_column(String(40))
    amount_due: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    due_on: Mapped[date] = mapped_column(Date, index=True)
    amount_paid: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    paid_on: Mapped[date | None] = mapped_column(Date)
    method: Mapped[str | None] = mapped_column(String(40))
    confirmation_number: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), default="scheduled", index=True)
    confirmed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


# ======================================================================= budgets

class Budget(Entity, Base):
    __tablename__ = "budgets"

    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    fiscal_year: Mapped[int] = mapped_column(Integer, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    kind: Mapped[str] = mapped_column(String(20), default="original")  # original | reforecast
    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    parent_budget_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approval_note: Mapped[str | None] = mapped_column(Text)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class BudgetLine(Entity, Base):
    __tablename__ = "budget_lines"
    __table_args__ = (UniqueConstraint("budget_id", "account", "month", name="uq_budget_lines_cell"),)

    budget_id: Mapped[uuid.UUID] = fk("budgets", nullable=False, ondelete="CASCADE")
    account: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(20), default="expense")
    month: Mapped[int] = mapped_column(Integer)  # 1-12
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    reforecast_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    prior_actual: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    notes: Mapped[str | None] = mapped_column(Text)
