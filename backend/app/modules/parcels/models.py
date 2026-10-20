import uuid
from datetime import date, datetime

from geoalchemy2 import Geometry
from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

PARCEL_RELATIONSHIPS = ["primary", "assemblage", "excess_land", "outparcel", "other"]
OCCUPANCY_STATES = ["vacant", "occupied", "pending", "owner_occupied", "unavailable"]
SPACE_USE_TYPES = ["retail", "restaurant", "office", "medical", "industrial", "flex", "storage", "residential", "other"]

# Material facts that keep sourced history (field_observations).
PARCEL_MATERIAL = {"apn", "legal_description", "acreage"}
BUILDING_MATERIAL = {"building_area_sf", "year_built", "floors"}
SPACE_MATERIAL = {"area_sf", "occupancy_status", "tenant_name"}


class Parcel(Entity, Base):
    __tablename__ = "parcels"

    county: Mapped[str] = mapped_column(String(120), index=True)
    state: Mapped[str | None] = mapped_column(String(40), index=True)
    apn: Mapped[str] = mapped_column(String(80))  # as observed
    apn_normalized: Mapped[str] = mapped_column(String(80), index=True)
    situs_address: Mapped[str | None] = mapped_column(String(255))
    legal_description: Mapped[str | None] = mapped_column(Text)
    acreage: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    geometry = mapped_column(Geometry("MULTIPOLYGON", srid=4326, spatial_index=True), nullable=True, deferred=True)
    centroid = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True, deferred=True)
    has_geometry: Mapped[bool] = mapped_column(default=False, index=True)
    centroid_lat: Mapped[float | None] = mapped_column(Numeric(10, 7, asdecimal=False))
    centroid_lng: Mapped[float | None] = mapped_column(Numeric(10, 7, asdecimal=False))
    facts: Mapped[dict] = mapped_column(JSONB, default=dict)  # zoning, land use code, assessed value...
    source: Mapped[str | None] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class ParcelVersion(UUIDPk, Base):
    """Snapshot of legal description + geometry each time the source data changes."""

    __tablename__ = "parcel_versions"

    parcel_id: Mapped[uuid.UUID] = fk("parcels", nullable=False, ondelete="CASCADE")
    version: Mapped[int] = mapped_column(Integer)
    legal_description: Mapped[str | None] = mapped_column(Text)
    geometry = mapped_column(Geometry("MULTIPOLYGON", srid=4326, spatial_index=False), nullable=True, deferred=True)
    acreage: Mapped[float | None] = mapped_column(Numeric(12, 4, asdecimal=False))
    changed_fields: Mapped[list] = mapped_column(JSONB, default=list)
    source: Mapped[str | None] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    recorded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


class PropertyParcel(Entity, Base):
    __tablename__ = "property_parcels"
    __table_args__ = (UniqueConstraint("property_id", "parcel_id", name="uq_property_parcels_pair"),)

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    parcel_id: Mapped[uuid.UUID] = fk("parcels", nullable=False, ondelete="CASCADE")
    relationship: Mapped[str] = mapped_column(String(30), default="primary")
    notes: Mapped[str | None] = mapped_column(Text)


class Building(Entity, Base):
    __tablename__ = "buildings"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    parcel_id: Mapped[uuid.UUID | None] = fk("parcels")
    name: Mapped[str] = mapped_column(String(160))
    building_area_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    year_built: Mapped[int | None] = mapped_column(Integer)
    floors: Mapped[int | None] = mapped_column(Integer)
    construction_class: Mapped[str | None] = mapped_column(String(20))
    use_type: Mapped[str | None] = mapped_column(String(60))
    notes: Mapped[str | None] = mapped_column(Text)


class Space(Entity, Base):
    __tablename__ = "spaces"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    building_id: Mapped[uuid.UUID | None] = fk("buildings")
    suite: Mapped[str] = mapped_column(String(60))
    area_sf: Mapped[float | None] = mapped_column(Numeric(14, 2, asdecimal=False))
    floor: Mapped[str | None] = mapped_column(String(20))
    location_note: Mapped[str | None] = mapped_column(String(200))
    use_type: Mapped[str | None] = mapped_column(String(60))
    occupancy_status: Mapped[str] = mapped_column(String(20), default="vacant", index=True)
    tenant_name: Mapped[str | None] = mapped_column(String(200))
    # Plain UUID references: organizations (contacts module) and leases (later release) are owned elsewhere.
    tenant_organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    lease_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    notes: Mapped[str | None] = mapped_column(Text)
