import uuid
from datetime import date, datetime

from geoalchemy2 import Geometry
from sqlalchemy import Boolean, Date, DateTime, Float, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, fk
from app.core.database import Base

VERIFICATION_STATUSES = ["unverified", "verified", "disputed"]
VERIFICATION_METHODS = ["buyer", "seller", "broker", "recorded_deed", "public_record", "lease_document",
                        "landlord", "tenant", "third_party_data", "appraisal", "other"]
TENANT_CREDIT = ["investment_grade", "national", "regional", "local", "none"]
RECOVERY_TYPES = ["nnn", "modified_gross", "gross", "base_year", "absolute_net"]
VALUATION_METHODS = ["direct_cap", "dcf", "sales_comparison", "land_residual", "appraisal", "bov"]
ADJUSTMENT_FACTORS = ["location", "size", "age", "condition", "lease_term", "tenant_credit", "timing"]
SALE_BASES = ["price_psf", "price_per_acre", "cap_rate", "price"]
LEASE_BASES = ["effective_rent_psf", "base_rent_psf"]


class _CompLocation:
    """Shared location/verification columns for sale and lease comps (no FKs here; mixin columns are copied)."""

    name:Mapped[str | None] = mapped_column(String(200))
    address_line: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str | None] = mapped_column(String(120), index=True)
    state: Mapped[str | None] = mapped_column(String(40), index=True)
    county: Mapped[str | None] = mapped_column(String(120), index=True)
    corridor: Mapped[str | None] = mapped_column(String(160), index=True)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    property_type: Mapped[str | None] = mapped_column(String(40), index=True)
    tenant_name: Mapped[str | None] = mapped_column(String(200))
    tenant_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    tenant_credit: Mapped[str | None] = mapped_column(String(30), index=True)
    building_area_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    land_area_acres: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    year_built: Mapped[int | None] = mapped_column(Integer)
    condition: Mapped[str | None] = mapped_column(String(30))

    source: Mapped[str | None] = mapped_column(String(200))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    verification_status: Mapped[str] = mapped_column(String(20), default="unverified", index=True)
    verification_method: Mapped[str | None] = mapped_column(String(40))
    verification_notes: Mapped[str | None] = mapped_column(Text)
    verified_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)


class SaleComp(_CompLocation, Entity, Base):
    """A verified-or-not sale transaction used as valuation evidence (spec module 13)."""

    __tablename__ = "sale_comps"

    property_id: Mapped[uuid.UUID | None] = fk("properties")
    location = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True)
    sale_date: Mapped[date | None] = mapped_column(Date, index=True)
    sale_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    price_psf: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    price_per_acre: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    cap_rate: Mapped[float | None] = mapped_column(Float)
    noi: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    buyer_name: Mapped[str | None] = mapped_column(String(200))
    buyer_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    seller_name: Mapped[str | None] = mapped_column(String(200))
    seller_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    financing: Mapped[str | None] = mapped_column(String(200))
    lease_term_remaining_years: Mapped[float | None] = mapped_column(Float)
    occupancy_pct: Mapped[float | None] = mapped_column(Float)


class LeaseComp(_CompLocation, Entity, Base):
    __tablename__ = "lease_comps"

    property_id: Mapped[uuid.UUID | None] = fk("properties")
    location = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True)
    space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    suite: Mapped[str | None] = mapped_column(String(60))
    lease_type: Mapped[str | None] = mapped_column(String(30))  # new | renewal | expansion | sublease
    commencement_on: Mapped[date | None] = mapped_column(Date, index=True)
    term_months: Mapped[int | None] = mapped_column(Integer)
    area_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    base_rent_psf: Mapped[float | None] = mapped_column(Numeric(10, 2, asdecimal=False))  # annual $/SF
    escalation_pct: Mapped[float | None] = mapped_column(Float)
    escalation_structure: Mapped[str | None] = mapped_column(String(120))
    recovery_type: Mapped[str | None] = mapped_column(String(30))
    recoveries_psf: Mapped[float | None] = mapped_column(Numeric(10, 2, asdecimal=False))
    free_rent_months: Mapped[float | None] = mapped_column(Float)
    concessions: Mapped[str | None] = mapped_column(Text)
    ti_psf: Mapped[float | None] = mapped_column(Numeric(10, 2, asdecimal=False))
    effective_rent_psf: Mapped[float | None] = mapped_column(Numeric(10, 2, asdecimal=False))


class CompSet(Entity, Base):
    """Comps selected for one subject property with a structured adjustment grid and indicated value range."""

    __tablename__ = "comp_sets"

    subject_property_id: Mapped[uuid.UUID | None] = fk("properties")
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(10), index=True)  # sale | lease
    purpose: Mapped[str | None] = mapped_column(String(30))  # valuation | underwriting | bov | mark
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)  # draft | final
    value_basis: Mapped[str] = mapped_column(String(30))
    subject_quantity: Mapped[float | None] = mapped_column(Float)  # SF, acres, NOI or 1 depending on basis
    subject_quantity_source: Mapped[str | None] = mapped_column(String(200))
    criteria: Mapped[dict] = mapped_column(JSONB, default=dict)
    indicated: Mapped[dict] = mapped_column(JSONB, default=dict)
    notes: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[uuid.UUID | None] = fk("users")


class CompSetItem(Entity, Base):
    __tablename__ = "comp_set_items"

    comp_set_id: Mapped[uuid.UUID] = fk("comp_sets", nullable=False, ondelete="CASCADE")
    sale_comp_id: Mapped[uuid.UUID | None] = fk("sale_comps")
    lease_comp_id: Mapped[uuid.UUID | None] = fk("lease_comps")
    included: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    exclusion_reason: Mapped[str | None] = mapped_column(Text)
    decision_history: Mapped[list] = mapped_column(JSONB, default=list)  # [{included, reason, by, by_name, at}]
    adjustments: Mapped[dict] = mapped_column(JSONB, default=dict)  # factor -> percent
    adjustment_notes: Mapped[dict] = mapped_column(JSONB, default=dict)  # factor -> rationale
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    base_metric: Mapped[float | None] = mapped_column(Float)
    net_adjustment_pct: Mapped[float | None] = mapped_column(Float)
    adjusted_metric: Mapped[float | None] = mapped_column(Float)
    adjusted_value: Mapped[float | None] = mapped_column(Float)
    distance_miles: Mapped[float | None] = mapped_column(Float)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class Valuation(Entity, Base):
    """A dated value conclusion. Never updated in place: marks and valuations are historical records."""

    __tablename__ = "valuations"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False)
    method: Mapped[str] = mapped_column(String(30), index=True)
    value_low: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_high: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_point: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    as_of: Mapped[date] = mapped_column(Date, index=True)
    analyst_id: Mapped[uuid.UUID | None] = fk("users")
    comp_set_id: Mapped[uuid.UUID | None] = fk("comp_sets")
    uw_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    is_mark: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    assumptions: Mapped[dict] = mapped_column(JSONB, default=dict)  # key -> {value, source, comp_ids, document_id}
    unsourced: Mapped[list] = mapped_column(JSONB, default=list)
    calculation: Mapped[dict] = mapped_column(JSONB, default=dict)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    third_party: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)


class ValuationDocument(Entity, Base):
    """Third-party appraisal / BOV document linkage (document ids from the documents module)."""

    __tablename__ = "valuation_documents"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False)
    valuation_id: Mapped[uuid.UUID | None] = fk("valuations")
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # appraisal | bov | other
    label: Mapped[str | None] = mapped_column(String(200))
    prepared_by: Mapped[str | None] = mapped_column(String(200))
    effective_date: Mapped[date | None] = mapped_column(Date)
    value_conclusion: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))


class Bov(Entity, Base):
    """Broker Opinion of Value generated from a comp set and its adjustment grid."""

    __tablename__ = "bovs"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False)
    comp_set_id: Mapped[uuid.UUID] = fk("comp_sets", nullable=False)
    valuation_id: Mapped[uuid.UUID | None] = fk("valuations")
    title: Mapped[str] = mapped_column(String(200))
    prepared_for: Mapped[str | None] = mapped_column(String(200))
    prepared_by_id: Mapped[uuid.UUID | None] = fk("users")
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)  # draft | final | delivered
    value_low: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_high: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    value_point: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    recommended_list_price: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    narrative: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
