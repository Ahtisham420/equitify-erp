import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

PARTNER_TYPES = ["individual", "family_office", "fund", "institution", "trust", "sponsor", "other"]
PARTNER_STATUSES = ["prospect", "active", "inactive"]
WATERFALL_POSITIONS = ["lp", "gp"]
DAY_COUNTS = ["act_365", "act_360", "30_360"]
COMPOUNDING = ["simple", "annual"]
TIER_TYPES = ["return_of_capital", "preferred_return", "catch_up", "split"]
HURDLE_TYPES = ["none", "irr", "equity_multiple"]
EVENT_TYPES = ["call", "distribution", "liquidation"]
EVENT_STATUSES = ["draft", "pending_approval", "approved", "posted", "rejected", "reversed"]
ENTRY_TYPES = ["contribution", "distribution", "income_allocation", "loss_allocation"]
COMPONENTS = ["return_of_capital", "preferred_return", "catch_up", "profit", "residual"]
CALL_ITEM_STATUSES = ["pending", "partial", "funded", "late", "default"]
PACKAGE_TYPES = ["property_performance", "portfolio", "valuation", "distributions", "capital_accounts"]
REPORT_FREQUENCIES = ["monthly", "quarterly", "annual"]
COMM_CHANNELS = ["email", "portal", "mail", "phone"]

# Investment fields whose changes are material facts kept with provenance history.
INVESTMENT_MATERIAL = {"commitment", "ownership_pct", "pref_rate", "waterfall_position", "waterfall_id", "status"}


class CapitalPartner(Entity, Base):
    """An equity relationship (LP investor or sponsor/GP entity) linked to the contact master."""

    __tablename__ = "capital_partners"

    name: Mapped[str] = mapped_column(String(200), index=True)
    type: Mapped[str] = mapped_column(String(30), default="individual", index=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    person_id: Mapped[uuid.UUID | None] = fk("people")
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(40))
    reporting_requirements: Mapped[str | None] = mapped_column(Text)
    # {frequency, packages: [...], delivery, format}
    reporting_prefs: Mapped[dict] = mapped_column(JSONB, default=dict)
    # {channel, recipients: [...], do_not_contact: bool, notes}
    communication_prefs: Mapped[dict] = mapped_column(JSONB, default=dict)
    portal_user_id: Mapped[uuid.UUID | None] = fk("users")
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class Waterfall(Entity, Base):
    """Configurable distribution waterfall. Tier edits bump `version`; calcs snapshot the tiers used."""

    __tablename__ = "waterfalls"

    name: Mapped[str] = mapped_column(String(200))
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    description: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class WaterfallTier(UUIDPk, Base):
    __tablename__ = "waterfall_tiers"

    waterfall_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("waterfalls.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(String(120))
    tier_type: Mapped[str] = mapped_column(String(30))
    hurdle_type: Mapped[str] = mapped_column(String(20), default="none")
    hurdle_value: Mapped[float | None] = mapped_column(Float)  # IRR in percent (15 = 15%) or equity multiple (1.8)
    # Shares / catch-up values are fractions 0–1.
    lp_share: Mapped[float] = mapped_column(Float, default=1.0)
    gp_share: Mapped[float] = mapped_column(Float, default=0.0)
    catch_up_rate: Mapped[float] = mapped_column(Float, default=1.0)
    catch_up_target: Mapped[float] = mapped_column(Float, default=0.2)


class Investment(Entity, Base):
    """A partner's position in one asset."""

    __tablename__ = "investments"

    partner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("capital_partners.id"), index=True)
    # Assets live in a separately-loaded module; a plain UUID keeps this table independent of load order.
    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    waterfall_id: Mapped[uuid.UUID | None] = fk("waterfalls")
    commitment: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    funded: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    ownership_pct: Mapped[float] = mapped_column(Float, default=0)  # percent 0–100
    pref_rate: Mapped[float] = mapped_column(Float, default=0)  # annual percent, e.g. 8.0
    pref_compounding: Mapped[str] = mapped_column(String(10), default="simple")
    day_count: Mapped[str] = mapped_column(String(10), default="act_365")
    waterfall_position: Mapped[str] = mapped_column(String(10), default="lp", index=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    invested_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class CapitalEvent(Entity, Base):
    """Call, distribution or liquidation. Calculations are versioned; approval locks a version."""

    __tablename__ = "capital_events"

    event_type: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(200))
    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    property_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    waterfall_id: Mapped[uuid.UUID | None] = fk("waterfalls")
    waterfall_version: Mapped[int | None] = mapped_column(Integer)
    event_date: Mapped[date] = mapped_column(Date, index=True)
    due_on: Mapped[date | None] = mapped_column(Date)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    # Liquidation inputs (gross, payoff, costs, reserves) and call default provisions.
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    calc: Mapped[dict] = mapped_column(JSONB, default=dict)
    notes: Mapped[str | None] = mapped_column(Text)
    submitted_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_version: Mapped[int | None] = mapped_column(Integer)
    decision_note: Mapped[str | None] = mapped_column(Text)
    posted_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversal_reason: Mapped[str | None] = mapped_column(Text)


class CapitalEventVersion(UUIDPk, Base):
    """Immutable record of every calculation version of an event."""

    __tablename__ = "capital_event_versions"
    __table_args__ = (UniqueConstraint("event_id", "version", name="uq_capital_event_versions_event_version"),)

    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("capital_events.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    calc: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class CapitalEventAllocation(Entity, Base):
    """Per-partner result of a posted event: a call notice line or a distribution record."""

    __tablename__ = "capital_event_allocations"

    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("capital_events.id"), index=True)
    partner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("capital_partners.id"), index=True)
    investment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("investments.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(20), index=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    tiers: Mapped[list] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(20), index=True)  # call: pending..default; distribution: paid|reversed
    due_on: Mapped[date | None] = mapped_column(Date)
    funded_amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    funded_on: Mapped[date | None] = mapped_column(Date)
    late_interest: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=0)
    penalty_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    default_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    notice_text: Mapped[str | None] = mapped_column(Text)
    paid_on: Mapped[date | None] = mapped_column(Date)
    payment_reference: Mapped[str | None] = mapped_column(String(120))


class CapitalAccountEntry(UUIDPk, Base):
    """Immutable capital-account ledger. Corrections are reversing entries (negative amount)."""

    __tablename__ = "capital_account_entries"

    partner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("capital_partners.id"), index=True)
    investment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("investments.id"), index=True)
    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    event_id: Mapped[uuid.UUID | None] = fk("capital_events")
    allocation_id: Mapped[uuid.UUID | None] = fk("capital_event_allocations")
    entry_type: Mapped[str] = mapped_column(String(30), index=True)
    component: Mapped[str | None] = mapped_column(String(30))
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    effective_on: Mapped[date] = mapped_column(Date, index=True)
    memo: Mapped[str | None] = mapped_column(Text)
    reverses_entry_id: Mapped[uuid.UUID | None] = fk("capital_account_entries")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)


class ReportSchedule(Entity, Base):
    __tablename__ = "investor_report_schedules"

    name: Mapped[str] = mapped_column(String(200))
    partner_id: Mapped[uuid.UUID | None] = fk("capital_partners")
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    package_types: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    frequency: Mapped[str] = mapped_column(String(20), default="quarterly")
    next_run_on: Mapped[date] = mapped_column(Date, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_issue: Mapped[bool] = mapped_column(Boolean, default=False)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ReportPackage(Entity, Base):
    """A partner reporting package assembled from verified data, frozen as a snapshot."""

    __tablename__ = "report_packages"

    partner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("capital_partners.id"), index=True)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    schedule_id: Mapped[uuid.UUID | None] = fk("investor_report_schedules")
    title: Mapped[str] = mapped_column(String(200))
    package_types: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(20), default="generated", index=True)  # generated | issued
    snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)
    excluded: Mapped[list] = mapped_column(JSONB, default=list)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    issued_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
