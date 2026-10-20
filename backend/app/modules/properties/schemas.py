import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.common.provenance import ObservationOut, ProvenanceIn

PropertyStatus = Literal["tracked", "pursued", "rejected", "owned", "managed", "listed", "sold"]


class PropertyBase(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    address_line: str = Field(min_length=1, max_length=255)
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    county: str | None = None
    alternate_addresses: list[str] = []
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    property_type: str = "other"
    property_subtype: str | None = None
    building_area_sf: float | None = Field(default=None, ge=0)
    land_area_acres: float | None = Field(default=None, ge=0)
    year_built: int | None = Field(default=None, ge=1700, le=2100)
    year_renovated: int | None = Field(default=None, ge=1700, le=2100)
    parking_spaces: int | None = Field(default=None, ge=0)
    construction_class: str | None = None
    status: PropertyStatus = "tracked"
    asking_price: float | None = Field(default=None, ge=0)
    last_sale_price: float | None = Field(default=None, ge=0)
    last_sale_date: date | None = None
    occupancy_pct: float | None = Field(default=None, ge=0, le=100)
    wale_years: float | None = Field(default=None, ge=0)
    noi: float | None = None
    zoning: str | None = None
    future_land_use: str | None = None
    flood_zone: str | None = None
    traffic_count: int | None = Field(default=None, ge=0)
    corridor: str | None = None
    notes: str | None = None
    tags: list[str] = []


class PropertyCreate(PropertyBase):
    provenance: ProvenanceIn = ProvenanceIn()


class PropertyUpdate(BaseModel):
    """Partial update; any field from PropertyBase."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    address_line: str | None = Field(default=None, min_length=1, max_length=255)
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    county: str | None = None
    alternate_addresses: list[str] | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    property_type: str | None = None
    property_subtype: str | None = None
    building_area_sf: float | None = Field(default=None, ge=0)
    land_area_acres: float | None = Field(default=None, ge=0)
    year_built: int | None = None
    year_renovated: int | None = None
    parking_spaces: int | None = None
    construction_class: str | None = None
    status: PropertyStatus | None = None
    asking_price: float | None = None
    last_sale_price: float | None = None
    last_sale_date: date | None = None
    occupancy_pct: float | None = Field(default=None, ge=0, le=100)
    wale_years: float | None = None
    noi: float | None = None
    zoning: str | None = None
    future_land_use: str | None = None
    flood_zone: str | None = None
    traffic_count: int | None = None
    corridor: str | None = None
    notes: str | None = None
    tags: list[str] | None = None
    provenance: ProvenanceIn = ProvenanceIn()


class PropertyListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str | None
    address_line: str
    city: str | None
    state: str | None
    county: str | None
    property_type: str
    status: str
    building_area_sf: float | None
    land_area_acres: float | None
    asking_price: float | None
    occupancy_pct: float | None
    year_built: int | None
    completeness_score: float
    tags: list[str]
    updated_at: datetime


class PropertyOut(PropertyBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    normalized_address: str
    completeness_score: float
    missing_fields: list[str] = []
    provenance: dict[str, ObservationOut] = {}
    created_at: datetime
    updated_at: datetime
    created_by_id: uuid.UUID | None


class DuplicateCandidate(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str | None
    address_line: str
    city: str | None
    state: str | None
    status: str


class PropertyFacets(BaseModel):
    status: dict[str, int]
    property_type: dict[str, int]
    state: dict[str, int]


class VerifyIn(BaseModel):
    state: Literal["verified", "rejected"]


class BulkIn(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    status: PropertyStatus | None = None
    add_tags: list[str] = []
    remove_tags: list[str] = []


__all__ = ["ObservationOut"]
