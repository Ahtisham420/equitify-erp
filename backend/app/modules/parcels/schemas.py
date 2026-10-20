import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.common.provenance import ObservationOut, ProvenanceIn
from app.modules.properties.schemas import PropertyCreate

Relationship = Literal["primary", "assemblage", "excess_land", "outparcel", "other"]
Occupancy = Literal["vacant", "occupied", "pending", "owner_occupied", "unavailable"]


# ----------------------------------------------------------------------------- parcels

class ParcelBase(BaseModel):
    county: str = Field(min_length=1, max_length=120)
    state: str | None = Field(default=None, max_length=40)
    apn: str = Field(min_length=1, max_length=80)
    situs_address: str | None = Field(default=None, max_length=255)
    legal_description: str | None = None
    acreage: float | None = Field(default=None, ge=0)
    facts: dict[str, Any] = {}
    source: str | None = Field(default=None, max_length=200)
    observed_on: date | None = None
    notes: str | None = None


class ParcelCreate(ParcelBase):
    geometry: dict[str, Any] | None = Field(default=None, description="GeoJSON Polygon/MultiPolygon, Feature or FeatureCollection")
    provenance: ProvenanceIn = ProvenanceIn()


class ParcelUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    county: str | None = Field(default=None, min_length=1, max_length=120)
    state: str | None = None
    apn: str | None = Field(default=None, min_length=1, max_length=80)
    situs_address: str | None = None
    legal_description: str | None = None
    acreage: float | None = Field(default=None, ge=0)
    facts: dict[str, Any] | None = None
    source: str | None = None
    observed_on: date | None = None
    notes: str | None = None
    geometry: dict[str, Any] | None = None
    clear_geometry: bool = False
    provenance: ProvenanceIn = ProvenanceIn()


class ParcelListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    county: str
    state: str | None
    apn: str
    apn_normalized: str
    situs_address: str | None
    legal_description: str | None
    acreage: float | None
    has_geometry: bool
    centroid_lat: float | None
    centroid_lng: float | None
    source: str | None
    observed_on: date | None
    property_count: int = 0
    updated_at: datetime


class ParcelOut(ParcelListItem):
    facts: dict[str, Any]
    notes: str | None
    # Named `geojson` (not `geometry`) so from_attributes never touches the deferred PostGIS column.
    geojson: dict[str, Any] | None = None
    geometry_acreage: float | None = None
    provenance: dict[str, ObservationOut] = {}
    created_at: datetime
    created_by_id: uuid.UUID | None


class ParcelFacets(BaseModel):
    county: dict[str, int]
    state: dict[str, int]


class ParcelVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    legal_description: str | None
    acreage: float | None
    changed_fields: list[str]
    source: str | None
    observed_on: date | None
    recorded_at: datetime
    recorded_by_id: uuid.UUID | None
    geojson: dict[str, Any] | None = None


class OwnerRef(BaseModel):
    kind: str
    id: uuid.UUID
    name: str | None = None


class AdjacentParcel(BaseModel):
    id: uuid.UUID
    county: str
    apn: str
    situs_address: str | None
    acreage: float | None
    distance_m: float
    touches: bool
    shared_owners: list[OwnerRef] = []


class AdjacencyOut(BaseModel):
    items: list[AdjacentParcel]
    owners: list[OwnerRef] = []
    owners_hidden: bool = False


class AssemblageGroup(BaseModel):
    owner: OwnerRef
    parcels: list[ParcelListItem]
    total_acreage: float


class AssemblageOut(BaseModel):
    owners: list[OwnerRef]
    groups: list[AssemblageGroup]
    owners_hidden: bool = False
    ownership_available: bool = True


class LinkedProperty(BaseModel):
    link_id: uuid.UUID
    relationship: str
    property_id: uuid.UUID
    name: str | None
    address_line: str
    city: str | None
    state: str | None
    status: str
    property_type: str


class ParcelMergeIn(BaseModel):
    into_id: uuid.UUID


class BulkAssociateIn(BaseModel):
    parcel_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    property_id: uuid.UUID | None = None
    new_property: PropertyCreate | None = None
    relationship: Relationship | None = None  # None = first parcel primary, rest assemblage
    preview: bool = True


class BulkPreviewParcel(BaseModel):
    id: uuid.UUID
    apn: str
    county: str
    acreage: float | None
    has_geometry: bool
    already_linked: bool
    relationship: str
    linked_elsewhere: list[uuid.UUID] = []


class BulkAssociateOut(BaseModel):
    preview: bool
    property_id: uuid.UUID | None
    parcels: list[BulkPreviewParcel]
    total_acreage: float
    contiguous: bool | None
    missing_ids: list[uuid.UUID] = []
    linked: int = 0


# ----------------------------------------------------------------------------- property links

class PropertyParcelIn(BaseModel):
    parcel_id: uuid.UUID
    relationship: Relationship = "primary"
    notes: str | None = None


class PropertyParcelUpdate(BaseModel):
    relationship: Relationship | None = None
    notes: str | None = None


class PropertyParcelOut(BaseModel):
    link_id: uuid.UUID
    relationship: str
    notes: str | None
    parcel: ParcelListItem


# ----------------------------------------------------------------------------- buildings / spaces

class BuildingIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    parcel_id: uuid.UUID | None = None
    building_area_sf: float | None = Field(default=None, ge=0)
    year_built: int | None = Field(default=None, ge=1700, le=2100)
    floors: int | None = Field(default=None, ge=0, le=300)
    construction_class: str | None = Field(default=None, max_length=20)
    use_type: str | None = Field(default=None, max_length=60)
    notes: str | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class BuildingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=160)
    parcel_id: uuid.UUID | None = None
    building_area_sf: float | None = Field(default=None, ge=0)
    year_built: int | None = Field(default=None, ge=1700, le=2100)
    floors: int | None = Field(default=None, ge=0, le=300)
    construction_class: str | None = None
    use_type: str | None = None
    notes: str | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class BuildingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    parcel_id: uuid.UUID | None
    name: str
    building_area_sf: float | None
    year_built: int | None
    floors: int | None
    construction_class: str | None
    use_type: str | None
    notes: str | None
    space_count: int = 0
    updated_at: datetime


class SpaceIn(BaseModel):
    suite: str = Field(min_length=1, max_length=60)
    building_id: uuid.UUID | None = None
    area_sf: float | None = Field(default=None, ge=0)
    floor: str | None = Field(default=None, max_length=20)
    location_note: str | None = Field(default=None, max_length=200)
    use_type: str | None = Field(default=None, max_length=60)
    occupancy_status: Occupancy = "vacant"
    tenant_name: str | None = Field(default=None, max_length=200)
    tenant_organization_id: uuid.UUID | None = None
    lease_id: uuid.UUID | None = None
    notes: str | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class SpaceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suite: str | None = Field(default=None, min_length=1, max_length=60)
    building_id: uuid.UUID | None = None
    area_sf: float | None = Field(default=None, ge=0)
    floor: str | None = None
    location_note: str | None = None
    use_type: str | None = None
    occupancy_status: Occupancy | None = None
    tenant_name: str | None = None
    tenant_organization_id: uuid.UUID | None = None
    lease_id: uuid.UUID | None = None
    notes: str | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class SpaceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    building_id: uuid.UUID | None
    suite: str
    area_sf: float | None
    floor: str | None
    location_note: str | None
    use_type: str | None
    occupancy_status: str
    tenant_name: str | None
    tenant_organization_id: uuid.UUID | None
    lease_id: uuid.UUID | None
    notes: str | None
    updated_at: datetime


__all__ = ["ObservationOut"]
