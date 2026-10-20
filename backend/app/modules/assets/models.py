import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Index, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

ASSET_STATUSES = ["active", "held_for_sale", "disposed"]
# reserve is a superset of the shared contract (income|expense|capex|debt_service|distribution)
FIN_CATEGORIES = ["income", "expense", "capex", "debt_service", "reserve", "distribution"]
FIN_SOURCES = ["manual", "import", "system"]
MILESTONE_STATUSES = ["planned", "in_progress", "done", "missed", "cancelled"]
VARIANCE_STATUSES = ["required", "submitted", "accepted", "rejected"]
VARIANCE_BASES = ["budget", "underwriting"]
VARIANCE_WINDOWS = ["month", "ttm"]
WATCH_TRIGGERS = ["coverage", "occupancy", "tenant_credit", "maintenance", "covenant", "maturity", "variance"]
WATCH_STATUSES = ["open", "resolved", "dismissed"]
CONCENTRATION_DIMENSIONS = ["tenant", "brand", "industry", "guarantor", "lender", "geography"]
GROUP_BYS = ["property_type", "tenant", "geography", "corridor", "vintage", "lender", "capital_partner", "territory"]

# Material asset facts: every change keeps a provenance observation (source/date/confidence/verification).
MATERIAL_FIELDS = {"basis", "current_value", "acquired_on", "exit_cap_rate", "target_hold_years", "equity_invested"}


class Asset(Entity, Base):
    """An owned property under asset management. One asset per property."""

    __tablename__ = "assets"
    __table_args__ = (UniqueConstraint("property_id", name="uq_assets_property"),)

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    acquired_on: Mapped[date | None] = mapped_column(Date, index=True)
    basis: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    equity_invested: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    current_value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_as_of: Mapped[date | None] = mapped_column(Date)
    hold_thesis: Mapped[str | None] = mapped_column(Text)
    business_plan: Mapped[str | None] = mapped_column(Text)
    target_hold_years: Mapped[float | None] = mapped_column(Float)
    exit_cap_rate: Mapped[float | None] = mapped_column(Float)
    target_exit_on: Mapped[date | None] = mapped_column(Date)
    exit_assumptions: Mapped[dict] = mapped_column(JSONB, default=dict)
    manager_id: Mapped[uuid.UUID | None] = fk("users")
    # Approved acquisition underwriting — kept as the original benchmark.
    uw_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    opportunity_id: Mapped[uuid.UUID | None] = fk("opportunities")
    closing_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    disposed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class AssetFinancial(Entity, Base):
    """Monthly actual by account. Re-entries keep the prior row (is_current=False) as history."""

    __tablename__ = "asset_financials"
    __table_args__ = (Index("ix_asset_financials_asset_period", "asset_id", "period"),)

    asset_id: Mapped[uuid.UUID] = fk("assets", nullable=False, ondelete="CASCADE")
    period: Mapped[date] = mapped_column(Date, index=True)  # first day of month
    account: Mapped[str] = mapped_column(String(120), index=True)
    category: Mapped[str] = mapped_column(String(20), index=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False))
    source: Mapped[str] = mapped_column(String(40), default="manual")
    verified: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    verified_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    notes: Mapped[str | None] = mapped_column(Text)


class AssetMilestone(Entity, Base):
    __tablename__ = "asset_milestones"

    asset_id: Mapped[uuid.UUID] = fk("assets", nullable=False, ondelete="CASCADE")
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    due_on: Mapped[date | None] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(20), default="planned", index=True)
    completed_on: Mapped[date | None] = mapped_column(Date)
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class VarianceExplanation(Entity, Base):
    """Explanation record for a variance above the configured % and $ thresholds."""

    __tablename__ = "variance_explanations"

    asset_id: Mapped[uuid.UUID] = fk("assets", nullable=False, ondelete="CASCADE")
    period: Mapped[date] = mapped_column(Date, index=True)
    window: Mapped[str] = mapped_column(String(10), default="month")
    basis: Mapped[str] = mapped_column(String(20), default="budget")
    account: Mapped[str] = mapped_column(String(120))
    actual: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    benchmark: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    variance: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    variance_pct: Mapped[float | None] = mapped_column(Float)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    explanation: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="required", index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class ConcentrationLimit(Entity, Base):
    """Max share of portfolio exposure for a dimension (optionally a specific key)."""

    __tablename__ = "concentration_limits"

    dimension: Mapped[str] = mapped_column(String(20), index=True)
    key: Mapped[str | None] = mapped_column(String(200))  # null = applies to every key in the dimension
    max_pct: Mapped[float] = mapped_column(Float)
    severity: Mapped[str] = mapped_column(String(10), default="medium")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str | None] = mapped_column(Text)


class TenantProfile(Entity, Base):
    """Brand / industry / credit classification of a tenant for concentration and credit watch."""

    __tablename__ = "tenant_profiles"

    tenant_key: Mapped[str] = mapped_column(String(200), unique=True)
    tenant_name: Mapped[str] = mapped_column(String(200))
    organization_id: Mapped[uuid.UUID | None] = fk("organizations")
    brand: Mapped[str | None] = mapped_column(String(160), index=True)
    industry: Mapped[str | None] = mapped_column(String(120), index=True)
    credit_rating: Mapped[str | None] = mapped_column(String(20))
    credit_watch: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    notes: Mapped[str | None] = mapped_column(Text)


class WatchlistEntry(Entity, Base):
    """One episode of a watchlist trigger on an asset (open until the condition clears or is resolved)."""

    __tablename__ = "watchlist_entries"

    asset_id: Mapped[uuid.UUID] = fk("assets", nullable=False, ondelete="CASCADE")
    trigger: Mapped[str] = mapped_column(String(20), index=True)
    severity: Mapped[str] = mapped_column(String(10), default="medium")
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    detail: Mapped[str | None] = mapped_column(Text)
    metric_value: Mapped[float | None] = mapped_column(Float)
    threshold: Mapped[float | None] = mapped_column(Float)
    source_href: Mapped[str | None] = mapped_column(String(300))
    first_detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    resolution_note: Mapped[str | None] = mapped_column(Text)
    alert_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class AssetSetting(Entity, Base):
    """Configurable thresholds (variance, watchlist) stored as one JSON document per key."""

    __tablename__ = "asset_settings"

    key: Mapped[str] = mapped_column(String(60), unique=True)
    value: Mapped[dict] = mapped_column(JSONB, default=dict)
