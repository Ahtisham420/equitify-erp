import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

CATEGORIES = ["debt", "legal", "tax", "ownership", "physical", "tenancy", "behavioral", "market", "development"]
STATUSES = ["active", "expired", "dismissed"]
OWNER_KINDS = ["person", "organization"]

# Lazily seeded signal type catalogue: (key, label, category, default severity, half-life days, expiry days, sensitive).
DEFAULT_TYPES: list[tuple[str, str, str, int, int | None, int | None, bool]] = [
    ("loan_maturity", "Loan maturity approaching", "debt", 4, 180, 540, False),
    ("rate_reset", "Rate reset / cap expiry", "debt", 3, 120, 365, False),
    ("lien_filed", "Lien filed", "debt", 4, 180, 730, False),
    ("loan_default", "Loan default / notice of default", "debt", 5, 120, 365, False),
    ("lis_pendens", "Lis pendens / litigation", "legal", 4, 180, 730, False),
    ("foreclosure_filing", "Foreclosure filing", "legal", 5, 120, 365, False),
    ("probate_estate", "Probate / estate proceeding", "legal", 4, 365, 1095, True),
    ("divorce_filing", "Divorce / partnership dispute", "legal", 4, 365, 1095, True),
    ("tax_delinquent", "Property tax delinquency", "tax", 4, 180, 730, False),
    ("assessment_increase", "Assessment increase", "tax", 2, 120, 365, False),
    ("ownership_change", "Ownership / entity change", "ownership", 3, 180, 730, False),
    ("long_hold", "Long hold period", "ownership", 2, None, None, False),
    ("owner_age_succession", "Owner age / succession", "ownership", 3, 730, None, True),
    ("deferred_maintenance", "Deferred maintenance observed", "physical", 3, 365, None, False),
    ("code_violation", "Code violation", "physical", 3, 180, 730, False),
    ("casualty_event", "Casualty / damage event", "physical", 4, 180, 540, False),
    ("vacancy_observed", "Vacancy observed", "tenancy", 3, 180, 540, False),
    ("lease_expiration", "Major lease expiration", "tenancy", 3, 365, 730, False),
    ("tenant_bankruptcy", "Tenant bankruptcy / closure", "tenancy", 5, 180, 540, False),
    ("owner_inbound_inquiry", "Owner inbound inquiry", "behavioral", 4, 60, 180, False),
    ("listed_for_sale", "Listed for sale", "behavioral", 4, 90, 365, False),
    ("price_reduction", "Price reduction", "behavioral", 3, 90, 365, False),
    ("cap_rate_shift", "Cap rate shift", "market", 2, 180, 365, False),
    ("interest_rate_shift", "Interest rate shift", "market", 2, 120, 365, False),
    ("comp_sale_nearby", "Comparable sale nearby", "market", 2, 180, 365, False),
    ("rezoning", "Rezoning / entitlement", "development", 3, 365, 1095, False),
    ("infrastructure_project", "Infrastructure project", "development", 2, 365, 1095, False),
    ("new_development_nearby", "New development nearby", "development", 2, 365, 1095, False),
]


class SignalType(Entity, Base):
    """Configurable catalogue: decay (half-life), default severity/expiry and sensitivity per signal type."""

    __tablename__ = "signal_types"

    key: Mapped[str] = mapped_column(String(60), unique=True)
    label: Mapped[str] = mapped_column(String(160))
    category: Mapped[str] = mapped_column(String(20), index=True)
    description: Mapped[str | None] = mapped_column(Text)
    default_severity: Mapped[int] = mapped_column(Integer, default=3)
    half_life_days: Mapped[int | None] = mapped_column(Integer)  # None = no decay
    default_expiry_days: Mapped[int | None] = mapped_column(Integer)
    is_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class Signal(Entity, Base):
    """A sourced, dated event linked to a property and/or an owner (spec module 10)."""

    __tablename__ = "signals"

    property_id: Mapped[uuid.UUID | None] = fk("properties")
    owner_kind: Mapped[str | None] = mapped_column(String(20), index=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    category: Mapped[str] = mapped_column(String(20), index=True)
    signal_type: Mapped[str] = mapped_column(String(60), index=True)
    title: Mapped[str | None] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    observed_on: Mapped[date] = mapped_column(Date, index=True)
    severity: Mapped[int] = mapped_column(Integer, default=3, index=True)
    source: Mapped[str] = mapped_column(String(200))
    source_reference: Mapped[str | None] = mapped_column(String(300))
    confidence: Mapped[float] = mapped_column(Float, default=0.7)
    expires_on: Mapped[date | None] = mapped_column(Date, index=True)
    half_life_days: Mapped[int | None] = mapped_column(Integer)
    is_sensitive: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    details: Mapped[dict] = mapped_column(JSONB, default=dict)
    verification: Mapped[str] = mapped_column(String(20), default="unverified", index=True)
    verified_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_reason: Mapped[str | None] = mapped_column(Text)
    dismissed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SignalSubscription(Entity, Base):
    """A user's standing interest in new signals (by category/type/severity/property/owner/territory)."""

    __tablename__ = "signal_subscriptions"

    subscriber_id: Mapped[uuid.UUID] = fk("users", nullable=False, ondelete="CASCADE")
    name: Mapped[str] = mapped_column(String(160))
    categories: Mapped[list[str]] = mapped_column(ARRAY(String(20)), default=list)
    signal_types: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    min_severity: Mapped[int] = mapped_column(Integer, default=1)
    property_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    owner_kind: Mapped[str | None] = mapped_column(String(20))
    owner_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    territory_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    property_types: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    stacked_only: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
