import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

LOAN_STATUSES = ["active", "paid_off", "defeased", "refinanced", "default"]
LOAN_TYPES = ["senior", "mezzanine", "bridge", "construction", "cmbs", "agency", "bank", "life_company",
              "seller_financing", "other"]
RATE_TYPES = ["fixed", "floating"]
RECOURSE_TYPES = ["non_recourse", "partial", "full"]
PREPAYMENT_TYPES = ["none", "open", "lockout", "yield_maintenance", "defeasance", "step_down"]
COVENANT_KINDS = ["dscr", "debt_yield", "ltv", "occupancy", "net_worth"]
FREQUENCIES = ["monthly", "quarterly", "semiannual", "annual"]
FREQ_MONTHS = {"monthly": 1, "quarterly": 3, "semiannual": 6, "annual": 12}
TEST_STATES = ["pass", "watch", "breach", "insufficient_data"]
# Worst-first ordering used for the denormalised loan covenant_state.
COVENANT_STATE_RANK = {"breach": 4, "projected_breach": 3, "watch": 2, "pass": 1, "insufficient_data": 0, "none": -1}
RESERVE_TYPES = ["tax", "insurance", "replacement", "ti_lc", "interest", "capex", "debt_service", "other"]
RESERVE_TXN_KINDS = ["deposit", "release", "adjustment"]
REPORT_TYPES = ["financial_statements", "operating_statement", "rent_roll", "compliance_certificate", "budget",
                "insurance_certificate", "tax_returns", "other"]
EVENT_TYPES = ["created", "balance_change", "rate_change", "modification", "status_change", "payoff", "extension",
               "collateral_change"]
MATERIAL_FIELDS = {"current_balance", "rate", "spread", "maturity_on", "status", "index_name", "amortization_months",
                   "io_months", "cap_expires_on", "cap_strike", "prepayment", "recourse", "guarantors"}


class Loan(Entity, Base):
    __tablename__ = "loans"

    name: Mapped[str | None] = mapped_column(String(200))
    loan_number: Mapped[str | None] = mapped_column(String(80))
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    asset_id: Mapped[uuid.UUID | None] = fk("assets")
    lender_organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    lender_name: Mapped[str | None] = mapped_column(String(200), index=True)
    loan_type: Mapped[str] = mapped_column(String(30), default="senior", index=True)
    original_balance: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    current_balance: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    originated_on: Mapped[date | None] = mapped_column(Date)
    maturity_on: Mapped[date | None] = mapped_column(Date, index=True)
    extension_options: Mapped[list] = mapped_column(JSONB, default=list)  # [{months, fee_pct, conditions}]
    rate_type: Mapped[str] = mapped_column(String(10), default="fixed", index=True)
    rate: Mapped[float | None] = mapped_column(Float)  # current all-in rate %
    index_name: Mapped[str | None] = mapped_column(String(40))
    spread: Mapped[float | None] = mapped_column(Float)
    rate_floor: Mapped[float | None] = mapped_column(Float)
    amortization_months: Mapped[int | None] = mapped_column(Integer)
    io_months: Mapped[int | None] = mapped_column(Integer)
    recourse: Mapped[str] = mapped_column(String(20), default="non_recourse")
    recourse_notes: Mapped[str | None] = mapped_column(Text)
    # [{kind: person|organization, person_id, organization_id, name, guaranty_type, limit_amount}]
    guarantors: Mapped[list] = mapped_column(JSONB, default=list)
    prepayment: Mapped[dict] = mapped_column(JSONB, default=dict)
    cap_strike: Mapped[float | None] = mapped_column(Float)
    cap_provider: Mapped[str | None] = mapped_column(String(160))
    cap_expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    swap_rate: Mapped[float | None] = mapped_column(Float)
    swap_expires_on: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    covenant_state: Mapped[str] = mapped_column(String(20), default="none", index=True)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    notes: Mapped[str | None] = mapped_column(Text)


class LoanProperty(UUIDPk, Base):
    """Cross-collateralisation: every property securing a loan, with allocated amount and release price."""

    __tablename__ = "loan_properties"
    __table_args__ = (UniqueConstraint("loan_id", "property_id", name="uq_loan_properties_pair"),)

    loan_id: Mapped[uuid.UUID] = fk("loans", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    allocated_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    release_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    added_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class LoanEvent(UUIDPk, Base):
    """Immutable debt history: balance/rate/term/status changes are appended, never overwritten."""

    __tablename__ = "loan_events"

    loan_id: Mapped[uuid.UUID] = fk("loans", nullable=False, ondelete="CASCADE")
    event_type: Mapped[str] = mapped_column(String(30), index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    effective_on: Mapped[date | None] = mapped_column(Date)
    field: Mapped[str | None] = mapped_column(String(60))
    from_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    to_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    note: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))


class Covenant(Entity, Base):
    __tablename__ = "covenants"

    loan_id: Mapped[uuid.UUID] = fk("loans", nullable=False, ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(20), index=True)
    label: Mapped[str | None] = mapped_column(String(160))
    operator: Mapped[str] = mapped_column(String(4), default="min")  # min: value >= threshold; max: value <= threshold
    threshold: Mapped[float] = mapped_column(Float)
    watch_threshold: Mapped[float | None] = mapped_column(Float)
    frequency: Mapped[str] = mapped_column(String(12), default="quarterly")
    next_test_on: Mapped[date | None] = mapped_column(Date, index=True)
    cure_period_days: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_state: Mapped[str | None] = mapped_column(String(20))
    last_projected_state: Mapped[str | None] = mapped_column(String(20))
    notes: Mapped[str | None] = mapped_column(Text)


class CovenantTest(Entity, Base):
    """One scheduled or manual test; full history retained."""

    __tablename__ = "covenant_tests"

    covenant_id: Mapped[uuid.UUID] = fk("covenants", nullable=False, ondelete="CASCADE")
    loan_id: Mapped[uuid.UUID] = fk("loans", nullable=False, ondelete="CASCADE")
    test_date: Mapped[date] = mapped_column(Date, index=True)
    period_start: Mapped[date | None] = mapped_column(Date)
    period_end: Mapped[date | None] = mapped_column(Date)
    measured_value: Mapped[float | None] = mapped_column(Float)
    threshold: Mapped[float] = mapped_column(Float)
    state: Mapped[str] = mapped_column(String(20), index=True)
    projected_value: Mapped[float | None] = mapped_column(Float)
    projected_state: Mapped[str | None] = mapped_column(String(20))
    projected_on: Mapped[date | None] = mapped_column(Date)
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    basis: Mapped[str] = mapped_column(String(30), default="actual_verified")
    is_manual: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text)


class LoanReserve(Entity, Base):
    __tablename__ = "loan_reserves"

    loan_id: Mapped[uuid.UUID] = fk("loans", nullable=False, ondelete="CASCADE")
    reserve_type: Mapped[str] = mapped_column(String(20), default="replacement")
    label: Mapped[str | None] = mapped_column(String(160))
    required_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    monthly_deposit: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cap_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    balance: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    release_conditions: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class ReserveTransaction(Entity, Base):
    __tablename__ = "reserve_transactions"

    reserve_id: Mapped[uuid.UUID] = fk("loan_reserves", nullable=False, ondelete="CASCADE")
    loan_id: Mapped[uuid.UUID] = fk("loans", nullable=False, ondelete="CASCADE")
    kind: Mapped[str] = mapped_column(String(12))
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    occurred_on: Mapped[date] = mapped_column(Date, index=True)
    balance_after: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    memo: Mapped[str | None] = mapped_column(Text)


class LenderReportingObligation(Entity, Base):
    __tablename__ = "lender_reporting_obligations"

    loan_id: Mapped[uuid.UUID] = fk("loans", nullable=False, ondelete="CASCADE")
    report_type: Mapped[str] = mapped_column(String(30))
    label: Mapped[str | None] = mapped_column(String(160))
    frequency: Mapped[str] = mapped_column(String(12), default="quarterly")
    days_after_period: Mapped[int] = mapped_column(Integer, default=45)
    next_due_on: Mapped[date | None] = mapped_column(Date, index=True)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_submitted_on: Mapped[date | None] = mapped_column(Date)
    critical_date_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)


class DebtSetting(Entity, Base):
    """Configurable lead times and current market terms (one JSON document per key)."""

    __tablename__ = "debt_settings"

    key: Mapped[str] = mapped_column(String(60), unique=True)
    value: Mapped[dict] = mapped_column(JSONB, default=dict)
