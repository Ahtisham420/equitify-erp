import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

COMMISSION_STATUSES = ["forecast", "earned", "invoiced", "paid", "cancelled"]
OPEN_STATUSES = ["forecast", "earned", "invoiced"]
EARNED_STATUSES = ["earned", "invoiced", "paid"]
SIDES = ["listing", "buyer", "tenant", "landlord", "dual", "other"]
SPLIT_ROLES = ["primary", "co_agent", "referral", "house"]
INVOICE_STATUSES = ["issued", "paid", "void"]
RECONCILIATION_STATES = ["unpaid", "matched", "short", "over"]
# brokerage_deals.stage values treated as a closed / lost transaction (brokerage module owns the list).
CLOSED_STAGES = {"closed", "closed_won", "won", "completed"}
LOST_STAGES = {"dead", "lost", "closed_lost", "cancelled", "canceled", "withdrawn"}


class SplitPlan(Entity, Base):
    """Graduated agent split plan keyed on agent YTD GCI, with an optional annual company-dollar cap."""

    __tablename__ = "commission_split_plans"

    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    # [{min_ytd_gci: 0, agent_pct: 60}, {min_ytd_gci: 250000, agent_pct: 70}, ...]
    tiers: Mapped[list] = mapped_column(JSONB, default=list)
    annual_cap: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))  # max house share per agent-year
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class AgentPlan(Entity, Base):
    __tablename__ = "commission_agent_plans"

    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("commission_split_plans.id"), index=True)
    effective_from: Mapped[date | None] = mapped_column(Date)


class Commission(Entity, Base):
    """Commission on one brokerage transaction: forecast → earned → invoiced → paid."""

    __tablename__ = "commissions"

    # Brokerage module is loaded independently; plain UUID keeps this table independent of load order.
    brokerage_deal_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    title: Mapped[str] = mapped_column(String(255))
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    team_id: Mapped[uuid.UUID | None] = fk("teams")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    property_type: Mapped[str | None] = mapped_column(String(40), index=True)
    source: Mapped[str | None] = mapped_column(String(80), index=True)
    side: Mapped[str | None] = mapped_column(String(20), index=True)
    deal_volume: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    gross: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    status: Mapped[str] = mapped_column(String(20), default="forecast", index=True)
    probability: Mapped[float | None] = mapped_column(Float)  # percent 0–100
    expected_close_on: Mapped[date | None] = mapped_column(Date, index=True)
    expected_on: Mapped[date | None] = mapped_column(Date, index=True)  # expected payment date
    earned_on: Mapped[date | None] = mapped_column(Date, index=True)
    paid_on: Mapped[date | None] = mapped_column(Date, index=True)
    split_plan_id: Mapped[uuid.UUID | None] = fk("commission_split_plans")
    # [{agent_id, share_pct, override_agent_pct}] — share of net GCI after referral
    participants: Mapped[list] = mapped_column(JSONB, default=list)
    referral_party: Mapped[str | None] = mapped_column(String(200))
    referral_pct: Mapped[float | None] = mapped_column(Float)
    referral_amount: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    # [{label, amount, agent_id}]
    deductions: Mapped[list] = mapped_column(JSONB, default=list)
    house_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    agent_net_total: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    calc: Mapped[dict] = mapped_column(JSONB, default=dict)
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_total: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    discrepancy: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    reconciliation_status: Mapped[str] = mapped_column(String(20), default="unpaid", index=True)
    released_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    release_note: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)


class CommissionSplit(Entity, Base):
    """Current split lines of a commission (prior versions are kept in commission_events snapshots)."""

    __tablename__ = "commission_splits"

    commission_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("commissions.id"), index=True)
    agent_id: Mapped[uuid.UUID | None] = fk("users")
    role: Mapped[str] = mapped_column(String(20))
    label: Mapped[str | None] = mapped_column(String(200))
    share_pct: Mapped[float | None] = mapped_column(Float)
    gci_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    agent_pct: Mapped[float | None] = mapped_column(Float)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    deductions: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    net_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    ytd_gci_before: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    capped: Mapped[bool] = mapped_column(Boolean, default=False)
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)


class CommissionInvoice(Entity, Base):
    __tablename__ = "commission_invoices"

    commission_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("commissions.id"), index=True)
    invoice_number: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    bill_to: Mapped[str] = mapped_column(String(300))
    issued_on: Mapped[date] = mapped_column(Date)
    due_on: Mapped[date] = mapped_column(Date, index=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    status: Mapped[str] = mapped_column(String(20), default="issued", index=True)
    rendered_text: Mapped[str] = mapped_column(Text)
    void_reason: Mapped[str | None] = mapped_column(Text)


class CommissionPayment(Entity, Base):
    __tablename__ = "commission_payments"

    commission_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("commissions.id"), index=True)
    invoice_id: Mapped[uuid.UUID | None] = fk("commission_invoices")
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    received_on: Mapped[date] = mapped_column(Date, index=True)
    reference: Mapped[str | None] = mapped_column(String(120))
    method: Mapped[str | None] = mapped_column(String(40))
    note: Mapped[str | None] = mapped_column(Text)


class CommissionEvent(UUIDPk, Base):
    """Immutable history: status changes, recalculations (with the prior calc), approvals, payments."""

    __tablename__ = "commission_events"

    commission_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("commissions.id", ondelete="CASCADE"), index=True
    )
    action: Mapped[str] = mapped_column(String(40))
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str | None] = mapped_column(String(20))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    note: Mapped[str | None] = mapped_column(Text)
    snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)


class ForecastSnapshot(UUIDPk, Base):
    """Monthly frozen copy of the weighted forecast, compared to actual collections for accuracy."""

    __tablename__ = "commission_forecast_snapshots"

    snapshot_month: Mapped[date] = mapped_column(Date, unique=True, index=True)  # first day of month
    taken_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    taken_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    buckets: Mapped[dict] = mapped_column(JSONB, default=dict)  # {"YYYY-MM": {weighted, unweighted, count}}
    by_agent: Mapped[dict] = mapped_column(JSONB, default=dict)  # {agent_id: {"YYYY-MM": weighted}}
    total_weighted: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
