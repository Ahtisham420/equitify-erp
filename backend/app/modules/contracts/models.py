import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

CONTRACT_STATUSES = ["draft", "executed", "closed", "terminated"]
CONTRACT_TYPES = ["purchase_sale", "amendment", "assignment", "option", "other"]
PARTY_ROLES = ["buyer", "seller", "escrow_agent", "title_company", "broker", "attorney", "lender", "other"]

CRITICAL_DATE_STATUSES = ["proposed", "confirmed", "completed", "waived", "missed"]
OPEN_DATE_STATUSES = ("proposed", "confirmed", "missed")
CRITICAL_DATE_SOURCES = ["manual", "rule", "ai"]
DATE_TYPES = [
    "effective", "deposit", "additional_deposit", "feasibility_expiry", "title_objection", "title_cure", "survey",
    "financing", "estoppel", "snda", "closing", "extension", "post_close", "lease_expiration", "lease_option",
    "loan_maturity", "rate_cap_expiry", "covenant_test", "offer_response", "other",
]

DD_STATUSES = ["not_started", "in_progress", "blocked", "complete", "waived"]
DD_DONE = ("complete", "waived")
SEVERITIES = ["low", "medium", "high", "critical"]
HIGH_SEVERITIES = ("high", "critical")
DD_SOURCES = ["template", "manual", "third_party_report", "title", "estoppel", "ai"]

REPORT_TYPES = ["survey", "phase_i", "phase_ii", "pca", "zoning", "appraisal", "title", "lease_audit"]
REPORT_STATUSES = ["not_ordered", "ordered", "in_progress", "delivered", "reviewed", "cancelled"]
REPORT_DONE = ("delivered", "reviewed", "cancelled")

EXCEPTION_KINDS = ["title_exception", "easement", "encroachment", "survey_matter", "lien", "restriction", "other"]
EXCEPTION_SOURCES = ["title_commitment", "survey", "other"]
EXCEPTION_STATUSES = ["open", "objected", "cure_pending", "cured", "accepted", "waived", "uncured"]
EXCEPTION_OPEN = ("open", "objected", "cure_pending", "uncured")

ESTOPPEL_KINDS = ["estoppel", "snda"]
ESTOPPEL_STATUSES = ["not_requested", "requested", "received", "approved", "waived"]

RISK_CATEGORIES = ["title", "survey", "environmental", "physical", "zoning", "tenancy", "financial", "legal", "other"]
RISK_STATUSES = ["open", "mitigating", "decided", "closed"]
RISK_DECISIONS = ["proceed", "mitigate", "renegotiate", "terminate", "accept"]

DECISION_KINDS = ["extend", "terminate", "proceed", "waive_contingency", "renegotiate", "other"]


class HolidayCalendar(Entity, Base):
    """Business-day calendar. The US federal calendar is seeded lazily from computed rules."""

    __tablename__ = "holiday_calendars"

    code: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text)
    # Python weekday numbers (Mon=0 … Sun=6) treated as non-business days.
    weekend_days: Mapped[list[int]] = mapped_column(ARRAY(Integer), default=lambda: [5, 6])
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    rule_set: Mapped[str | None] = mapped_column(String(40))  # 'us_federal' → holidays computed per year
    seeded_years: Mapped[list[int]] = mapped_column(ARRAY(Integer), default=list)


class Holiday(UUIDPk, Base):
    __tablename__ = "holidays"
    __table_args__ = (UniqueConstraint("calendar_id", "holiday_on", name="uq_holidays_calendar_on"),)

    calendar_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("holiday_calendars.id", ondelete="CASCADE"), index=True
    )
    holiday_on: Mapped[date] = mapped_column(Date, index=True)
    name: Mapped[str] = mapped_column(String(160))
    source: Mapped[str] = mapped_column(String(20), default="rule")  # rule | manual
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class Contract(Entity, Base):
    """An agreement (PSA etc.) with its parties and key terms; the hub of dates and diligence (spec 16)."""

    __tablename__ = "contracts"

    title: Mapped[str] = mapped_column(String(255))
    contract_type: Mapped[str] = mapped_column(String(30), default="purchase_sale", index=True)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    # Documents and offers modules own these tables; plain UUIDs keep this module independent of load order.
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    offer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    opportunity_id: Mapped[uuid.UUID | None] = fk("opportunities")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    owner_id: Mapped[uuid.UUID | None] = fk("users")

    effective_on: Mapped[date | None] = mapped_column(Date, index=True)
    executed_on: Mapped[date | None] = mapped_column(Date)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    executed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    purchase_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    earnest_money: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    additional_deposit: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))

    # [{role, name, person_id, organization_id, notes}]
    parties: Mapped[list] = mapped_column(JSONB, default=list)
    # Day counts and options that drive the date engine (see service.TERM_KEYS) plus free-form terms.
    key_terms: Mapped[dict] = mapped_column(JSONB, default=dict)
    calendar_id: Mapped[uuid.UUID | None] = fk("holiday_calendars")
    attorney_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    attorney_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    terminated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class CriticalDate(Entity, Base):
    """Shared accountable deadline for any record (contract, lease, loan, offer, disposition, …)."""

    __tablename__ = "critical_dates"
    __table_args__ = (UniqueConstraint("related_type", "related_id", "key", name="uq_critical_dates_related_key"),)

    related_type: Mapped[str] = mapped_column(String(40), index=True)
    related_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    related_label: Mapped[str | None] = mapped_column(String(300))
    key: Mapped[str] = mapped_column(String(80))
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    date_type: Mapped[str] = mapped_column(String(40), index=True)
    label: Mapped[str] = mapped_column(String(300))
    due_on: Mapped[date] = mapped_column(Date, index=True)
    original_due_on: Mapped[date | None] = mapped_column(Date)
    # A newer computed/AI value that differs from a human-confirmed date; never applied automatically.
    proposed_due_on: Mapped[date | None] = mapped_column(Date)
    rule: Mapped[dict | None] = mapped_column(JSONB)
    business_days: Mapped[bool] = mapped_column(Boolean, default=False)
    calendar_id: Mapped[uuid.UUID | None] = fk("holiday_calendars")
    status: Mapped[str] = mapped_column(String(20), default="proposed", index=True)
    source: Mapped[str] = mapped_column(String(20), default="rule", index=True)
    citation: Mapped[dict | None] = mapped_column(JSONB)  # {document_id, page, clause, text, confidence}
    confirmed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirm_note: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    lead_days: Mapped[int] = mapped_column(Integer, default=14)
    is_blocking: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    resolution_note: Mapped[str | None] = mapped_column(Text)
    escalation_level: Mapped[int] = mapped_column(Integer, default=0)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)


class CriticalDateEvent(UUIDPk, Base):
    """Immutable history of every status change and reschedule of a critical date."""

    __tablename__ = "critical_date_events"

    critical_date_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("critical_dates.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(30))
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str | None] = mapped_column(String(20))
    from_due_on: Mapped[date | None] = mapped_column(Date)
    to_due_on: Mapped[date | None] = mapped_column(Date)
    reason: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    data: Mapped[dict] = mapped_column(JSONB, default=dict)


class DDTemplate(Entity, Base):
    __tablename__ = "dd_templates"

    code: Mapped[str] = mapped_column(String(60), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    property_types: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    is_generic: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    # [{key, category, title, description, severity, due_days, depends_on:[key], report_type}]
    items: Mapped[list] = mapped_column(JSONB, default=list)


class DDItem(Entity, Base):
    __tablename__ = "dd_items"

    contract_id: Mapped[uuid.UUID] = fk("contracts", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    template_id: Mapped[uuid.UUID | None] = fk("dd_templates")
    key: Mapped[str | None] = mapped_column(String(80))
    category: Mapped[str] = mapped_column(String(60), default="general", index=True)
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="not_started", index=True)
    due_on: Mapped[date | None] = mapped_column(Date, index=True)
    depends_on: Mapped[list] = mapped_column(JSONB, default=list)  # [dd_item_id]
    source: Mapped[str] = mapped_column(String(30), default="manual")
    findings: Mapped[str | None] = mapped_column(Text)
    severity: Mapped[str | None] = mapped_column(String(10), index=True)
    cost_impact: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    resolution: Mapped[str | None] = mapped_column(Text)
    escalation_level: Mapped[int] = mapped_column(Integer, default=0)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    escalation_note: Mapped[str | None] = mapped_column(Text)
    report_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class ThirdPartyReport(Entity, Base):
    __tablename__ = "third_party_reports"

    contract_id: Mapped[uuid.UUID] = fk("contracts", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    report_type: Mapped[str] = mapped_column(String(30), index=True)
    vendor_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    vendor_name: Mapped[str | None] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="not_ordered", index=True)
    ordered_on: Mapped[date | None] = mapped_column(Date)
    expected_on: Mapped[date | None] = mapped_column(Date, index=True)
    delivered_on: Mapped[date | None] = mapped_column(Date)
    cost: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    findings: Mapped[str | None] = mapped_column(Text)
    severity: Mapped[str | None] = mapped_column(String(10))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    notes: Mapped[str | None] = mapped_column(Text)


class TitleException(Entity, Base):
    """Title commitment / survey matter with objection and cure tracking."""

    __tablename__ = "title_exceptions"

    contract_id: Mapped[uuid.UUID] = fk("contracts", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    kind: Mapped[str] = mapped_column(String(30), default="title_exception", index=True)
    source: Mapped[str] = mapped_column(String(30), default="title_commitment")
    schedule_ref: Mapped[str | None] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text)
    recording_ref: Mapped[str | None] = mapped_column(String(160))
    severity: Mapped[str | None] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    objection_sent_on: Mapped[date | None] = mapped_column(Date)
    cure_due_on: Mapped[date | None] = mapped_column(Date)
    cure_response: Mapped[str | None] = mapped_column(Text)
    resolved_on: Mapped[date | None] = mapped_column(Date)
    attorney_person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    attorney_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class Estoppel(Entity, Base):
    """Estoppel / SNDA per tenant. Expected (lease / rent roll) and tenant-reported values are both kept."""

    __tablename__ = "estoppels"

    contract_id: Mapped[uuid.UUID] = fk("contracts", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    kind: Mapped[str] = mapped_column(String(10), default="estoppel", index=True)
    tenant_name: Mapped[str] = mapped_column(String(200))
    lease_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    status: Mapped[str] = mapped_column(String(20), default="not_requested", index=True)
    requested_on: Mapped[date | None] = mapped_column(Date)
    due_on: Mapped[date | None] = mapped_column(Date)
    received_on: Mapped[date | None] = mapped_column(Date)
    expected_monthly_rent: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    expected_expiration_on: Mapped[date | None] = mapped_column(Date)
    expected_security_deposit: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    reported_monthly_rent: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    reported_expiration_on: Mapped[date | None] = mapped_column(Date)
    reported_security_deposit: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    reported_landlord_default: Mapped[bool | None] = mapped_column(Boolean)
    reported_notes: Mapped[str | None] = mapped_column(Text)
    discrepancies: Mapped[list] = mapped_column(JSONB, default=list)
    has_discrepancy: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    discrepancy_resolution: Mapped[str | None] = mapped_column(Text)
    discrepancy_resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    discrepancy_resolved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class RiskItem(Entity, Base):
    """Risk register entry. High-severity risks need a recorded decision before the feasibility deadline."""

    __tablename__ = "risk_items"

    contract_id: Mapped[uuid.UUID] = fk("contracts", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(30), default="other", index=True)
    severity: Mapped[str] = mapped_column(String(10), default="medium", index=True)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    source_type: Mapped[str | None] = mapped_column(String(40))  # dd_item | third_party_report | title_exception | estoppel
    source_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    cost_impact: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    mitigation: Mapped[str | None] = mapped_column(Text)
    decision_required: Mapped[bool] = mapped_column(Boolean, default=True)
    decision_due_on: Mapped[date | None] = mapped_column(Date)
    decision: Mapped[str | None] = mapped_column(String(20))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    decided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ContractDecision(UUIDPk, Base):
    """Immutable extension / termination / go-hard decisions with the reasoning given."""

    __tablename__ = "contract_decisions"

    contract_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contracts.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(30))
    reasoning: Mapped[str] = mapped_column(Text)
    critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    previous_due_on: Mapped[date | None] = mapped_column(Date)
    new_due_on: Mapped[date | None] = mapped_column(Date)
    effective_on: Mapped[date | None] = mapped_column(Date)
    decided_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    decided_by_name: Mapped[str | None] = mapped_column(String(200))
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    data: Mapped[dict] = mapped_column(JSONB, default=dict)
