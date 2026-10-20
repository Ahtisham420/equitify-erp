import uuid
from datetime import date, datetime

from geoalchemy2 import Geometry
from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

RULE_TYPES = ["explicit", "boundary", "radius", "corridor", "county", "city", "saved_query"]
VISIBILITIES = ["private", "role", "company"]
ROAD_CLASSES = ["interstate", "highway", "arterial", "collector", "local", "other"]
GROWTH_KINDS = ["permit", "plat", "rooftops", "school", "utility", "project"]
TRADE_AREA_MINUTES = [5, 10, 15]


class Corridor(Entity, Base):
    __tablename__ = "corridors"

    name: Mapped[str] = mapped_column(String(160), index=True)
    road_name: Mapped[str | None] = mapped_column(String(160))  # named highway / arterial
    road_class: Mapped[str] = mapped_column(String(20), default="arterial", index=True)
    side_of_road: Mapped[str | None] = mapped_column(String(20))
    travel_direction: Mapped[str | None] = mapped_column(String(20))
    frontage_length_ft: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    city: Mapped[str | None] = mapped_column(String(120), index=True)
    county: Mapped[str | None] = mapped_column(String(120), index=True)
    state: Mapped[str | None] = mapped_column(String(40))
    geometry = mapped_column(Geometry("LINESTRING", srid=4326, spatial_index=True), nullable=True, deferred=True)
    has_geometry: Mapped[bool] = mapped_column(Boolean, default=False)
    length_ft: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    source: Mapped[str | None] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class Node(Entity, Base):
    __tablename__ = "nodes"

    name: Mapped[str] = mapped_column(String(160), index=True)  # intersection name
    corridor_id: Mapped[uuid.UUID | None] = fk("corridors")
    cross_street: Mapped[str | None] = mapped_column(String(160))
    city: Mapped[str | None] = mapped_column(String(120), index=True)
    county: Mapped[str | None] = mapped_column(String(120), index=True)
    state: Mapped[str | None] = mapped_column(String(40))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    location = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True, deferred=True)
    approach_traffic: Mapped[dict] = mapped_column(JSONB, default=dict)  # {"NB": 24000, ...}
    signalized: Mapped[bool | None] = mapped_column(Boolean)
    turn_restrictions: Mapped[str | None] = mapped_column(Text)
    quadrants: Mapped[dict] = mapped_column(JSONB, default=dict)  # {"NE": {"tenancy": "...", "vacancy": "..."}}
    nearby_development: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class TrafficCount(Entity, Base):
    """One count observation; history = multiple rows per segment/approach across count years."""

    __tablename__ = "traffic_counts"

    corridor_id: Mapped[uuid.UUID | None] = fk("corridors")
    node_id: Mapped[uuid.UUID | None] = fk("nodes")
    segment: Mapped[str | None] = mapped_column(String(200), index=True)
    approach: Mapped[str | None] = mapped_column(String(40))
    count: Mapped[int] = mapped_column(Integer)
    count_year: Mapped[int] = mapped_column(Integer, index=True)
    count_type: Mapped[str] = mapped_column(String(20), default="aadt")
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    location = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True, deferred=True)
    source: Mapped[str] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class TradeArea(Entity, Base):
    __tablename__ = "trade_areas"

    name: Mapped[str | None] = mapped_column(String(160))
    node_id: Mapped[uuid.UUID | None] = fk("nodes")
    property_id: Mapped[uuid.UUID | None] = fk("properties")
    minutes: Mapped[int] = mapped_column(Integer, index=True)
    geometry = mapped_column(Geometry("MULTIPOLYGON", srid=4326, spatial_index=True), nullable=True, deferred=True)
    has_geometry: Mapped[bool] = mapped_column(Boolean, default=False)
    demographics: Mapped[dict] = mapped_column(JSONB, default=dict)  # population, households, median income...
    competitors: Mapped[list] = mapped_column(JSONB, default=list)
    anchors: Mapped[list] = mapped_column(JSONB, default=list)
    source: Mapped[str] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class GrowthRecord(Entity, Base):
    """Dated, sourced growth context point: permit, plat, rooftops, school, utility, announced project."""

    __tablename__ = "growth_records"

    kind: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(String(40))
    units: Mapped[int | None] = mapped_column(Integer)
    value: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    event_date: Mapped[date | None] = mapped_column(Date, index=True)
    city: Mapped[str | None] = mapped_column(String(120))
    county: Mapped[str | None] = mapped_column(String(120))
    state: Mapped[str | None] = mapped_column(String(40))
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    location = mapped_column(Geometry("POINT", srid=4326, spatial_index=True), nullable=True, deferred=True)
    source: Mapped[str] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)


class Territory(Entity, Base):
    __tablename__ = "territories"

    name: Mapped[str] = mapped_column(String(160), index=True)
    description: Mapped[str | None] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(20), index=True, default="explicit")
    rule: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Boundary for `boundary` rules; computed buffer for radius/corridor rules (display + spatial filters).
    geometry = mapped_column(Geometry("GEOMETRY", srid=4326, spatial_index=True), nullable=True, deferred=True)
    has_geometry: Mapped[bool] = mapped_column(Boolean, default=False)
    parent_id: Mapped[uuid.UUID | None] = fk("territories")
    visibility: Mapped[str] = mapped_column(String(20), default="private", index=True)
    allowed_roles: Mapped[list[str]] = mapped_column(ARRAY(String(60)), default=list)
    owner_id: Mapped[uuid.UUID | None] = fk("users")
    assignee_id: Mapped[uuid.UUID | None] = fk("users")  # default assignee for territory-driven routing
    member_count: Mapped[int] = mapped_column(Integer, default=0)
    last_computed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TerritoryMember(UUIDPk, Base):
    __tablename__ = "territory_members"
    __table_args__ = (UniqueConstraint("territory_id", "property_id", name="uq_territory_members_pair"),)

    territory_id: Mapped[uuid.UUID] = fk("territories", nullable=False, ondelete="CASCADE")
    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    source: Mapped[str] = mapped_column(String(10), default="rule")  # rule | manual
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
