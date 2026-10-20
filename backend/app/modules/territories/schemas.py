import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

RuleType = Literal["explicit", "boundary", "radius", "corridor", "county", "city", "saved_query"]
Visibility = Literal["private", "role", "company"]
GrowthKind = Literal["permit", "plat", "rooftops", "school", "utility", "project"]

# NOTE: GeoJSON is exposed as `geojson` (never `geometry`) so from_attributes never reads deferred PostGIS columns.


# ----------------------------------------------------------------------------- corridors

class CorridorIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    road_name: str | None = Field(default=None, max_length=160)
    road_class: str = "arterial"
    side_of_road: str | None = Field(default=None, max_length=20)
    travel_direction: str | None = Field(default=None, max_length=20)
    frontage_length_ft: float | None = Field(default=None, ge=0)
    city: str | None = None
    county: str | None = None
    state: str | None = None
    source: str | None = None
    observed_on: date | None = None
    notes: str | None = None
    geometry: dict[str, Any] | None = None


class CorridorUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    road_name: str | None = None
    road_class: str | None = None
    side_of_road: str | None = None
    travel_direction: str | None = None
    frontage_length_ft: float | None = Field(default=None, ge=0)
    city: str | None = None
    county: str | None = None
    state: str | None = None
    source: str | None = None
    observed_on: date | None = None
    notes: str | None = None
    geometry: dict[str, Any] | None = None
    clear_geometry: bool = False


class CorridorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    road_name: str | None
    road_class: str
    side_of_road: str | None
    travel_direction: str | None
    frontage_length_ft: float | None
    city: str | None
    county: str | None
    state: str | None
    has_geometry: bool
    length_ft: float | None
    source: str | None
    observed_on: date | None
    notes: str | None
    node_count: int = 0
    latest_count: int | None = None
    latest_count_year: int | None = None
    geojson: dict[str, Any] | None = None
    updated_at: datetime


# ----------------------------------------------------------------------------- nodes

class NodeIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    corridor_id: uuid.UUID | None = None
    cross_street: str | None = None
    city: str | None = None
    county: str | None = None
    state: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    approach_traffic: dict[str, Any] = {}
    signalized: bool | None = None
    turn_restrictions: str | None = None
    quadrants: dict[str, Any] = {}
    nearby_development: str | None = None
    source: str | None = None
    observed_on: date | None = None
    notes: str | None = None


class NodeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    corridor_id: uuid.UUID | None = None
    cross_street: str | None = None
    city: str | None = None
    county: str | None = None
    state: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    approach_traffic: dict[str, Any] | None = None
    signalized: bool | None = None
    turn_restrictions: str | None = None
    quadrants: dict[str, Any] | None = None
    nearby_development: str | None = None
    source: str | None = None
    observed_on: date | None = None
    notes: str | None = None


class NodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    corridor_id: uuid.UUID | None
    corridor_name: str | None = None
    cross_street: str | None
    city: str | None
    county: str | None
    state: str | None
    latitude: float | None
    longitude: float | None
    approach_traffic: dict[str, Any]
    signalized: bool | None
    turn_restrictions: str | None
    quadrants: dict[str, Any]
    nearby_development: str | None
    source: str | None
    observed_on: date | None
    notes: str | None
    updated_at: datetime


# ----------------------------------------------------------------------------- traffic counts

class TrafficCountIn(BaseModel):
    corridor_id: uuid.UUID | None = None
    node_id: uuid.UUID | None = None
    segment: str | None = Field(default=None, max_length=200)
    approach: str | None = Field(default=None, max_length=40)
    count: int = Field(ge=0)
    count_year: int = Field(ge=1950, le=2100)
    count_type: str = "aadt"
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    source: str = Field(min_length=1, max_length=200)
    observed_on: date | None = None
    notes: str | None = None


class TrafficCountUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    corridor_id: uuid.UUID | None = None
    node_id: uuid.UUID | None = None
    segment: str | None = None
    approach: str | None = None
    count: int | None = Field(default=None, ge=0)
    count_year: int | None = Field(default=None, ge=1950, le=2100)
    count_type: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    source: str | None = Field(default=None, min_length=1, max_length=200)
    observed_on: date | None = None
    notes: str | None = None


class TrafficCountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    corridor_id: uuid.UUID | None
    corridor_name: str | None = None
    node_id: uuid.UUID | None
    node_name: str | None = None
    segment: str | None
    approach: str | None
    count: int
    count_year: int
    count_type: str
    latitude: float | None
    longitude: float | None
    source: str
    observed_on: date | None
    notes: str | None
    change_pct: float | None = None  # vs previous count year for the same segment/approach
    updated_at: datetime


class TrafficTrendPoint(BaseModel):
    count_year: int
    count: int
    source: str
    segment: str | None
    approach: str | None


# ----------------------------------------------------------------------------- trade areas

class TradeAreaIn(BaseModel):
    name: str | None = None
    node_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    minutes: Literal[5, 10, 15]
    geometry: dict[str, Any] | None = None
    demographics: dict[str, Any] = {}
    competitors: list[Any] = []
    anchors: list[Any] = []
    source: str = Field(min_length=1, max_length=200)
    observed_on: date | None = None
    notes: str | None = None


class TradeAreaUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    node_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    minutes: Literal[5, 10, 15] | None = None
    geometry: dict[str, Any] | None = None
    demographics: dict[str, Any] | None = None
    competitors: list[Any] | None = None
    anchors: list[Any] | None = None
    source: str | None = Field(default=None, min_length=1, max_length=200)
    observed_on: date | None = None
    notes: str | None = None


class TradeAreaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str | None
    node_id: uuid.UUID | None
    node_name: str | None = None
    property_id: uuid.UUID | None
    property_label: str | None = None
    minutes: int
    has_geometry: bool
    demographics: dict[str, Any]
    competitors: list[Any]
    anchors: list[Any]
    source: str
    observed_on: date | None
    notes: str | None
    geojson: dict[str, Any] | None = None
    updated_at: datetime


# ----------------------------------------------------------------------------- growth context

class GrowthIn(BaseModel):
    kind: GrowthKind
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    status: str | None = Field(default=None, max_length=40)
    units: int | None = Field(default=None, ge=0)
    value: float | None = Field(default=None, ge=0)
    event_date: date | None = None
    city: str | None = None
    county: str | None = None
    state: str | None = None
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    source: str = Field(min_length=1, max_length=200)
    observed_on: date | None = None


class GrowthUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: GrowthKind | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    status: str | None = None
    units: int | None = Field(default=None, ge=0)
    value: float | None = Field(default=None, ge=0)
    event_date: date | None = None
    city: str | None = None
    county: str | None = None
    state: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    source: str | None = Field(default=None, min_length=1, max_length=200)
    observed_on: date | None = None


class GrowthOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    name: str
    description: str | None
    status: str | None
    units: int | None
    value: float | None
    event_date: date | None
    city: str | None
    county: str | None
    state: str | None
    latitude: float
    longitude: float
    source: str
    observed_on: date | None
    distance_miles: float | None = None
    updated_at: datetime


class GrowthFacets(BaseModel):
    kind: dict[str, int]


# ----------------------------------------------------------------------------- territories

class TerritoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = None
    rule_type: RuleType = "explicit"
    rule: dict[str, Any] = {}
    geometry: dict[str, Any] | None = Field(default=None, description="GeoJSON polygon for boundary rules")
    parent_id: uuid.UUID | None = None
    visibility: Visibility = "private"
    allowed_roles: list[str] = []
    owner_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None


class TerritoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = None
    rule_type: RuleType | None = None
    rule: dict[str, Any] | None = None
    geometry: dict[str, Any] | None = None
    parent_id: uuid.UUID | None = None
    visibility: Visibility | None = None
    allowed_roles: list[str] | None = None
    owner_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None


class TerritoryListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    rule_type: str
    rule: dict[str, Any]
    has_geometry: bool
    parent_id: uuid.UUID | None
    visibility: str
    allowed_roles: list[str]
    owner_id: uuid.UUID | None
    assignee_id: uuid.UUID | None
    member_count: int
    last_computed_at: datetime | None
    updated_at: datetime


class TerritoryOut(TerritoryListItem):
    parent_name: str | None = None
    owner_name: str | None = None
    assignee_name: str | None = None
    children: list[TerritoryListItem] = []
    geojson: dict[str, Any] | None = None
    can_edit: bool = False
    created_at: datetime


class TerritoryFacets(BaseModel):
    rule_type: dict[str, int]
    visibility: dict[str, int]


class MemberOut(BaseModel):
    property_id: uuid.UUID
    source: str
    added_at: datetime
    name: str | None
    address_line: str
    city: str | None
    state: str | None
    county: str | None
    property_type: str
    status: str


class MembersIn(BaseModel):
    property_ids: list[uuid.UUID] = Field(default=[], max_length=1000)
    parcel_ids: list[uuid.UUID] = Field(default=[], max_length=1000)


class RecomputeOut(BaseModel):
    added: int
    removed: int
    total: int


class OverlapOut(BaseModel):
    id: uuid.UUID
    name: str
    rule_type: str
    shared: int


class PropertyRef(BaseModel):
    """Lightweight property row for geography-driven property queries."""

    id: uuid.UUID
    name: str | None
    address_line: str
    city: str | None
    state: str | None
    property_type: str
    status: str
    traffic_count: int | None
    distance_miles: float | None = None
