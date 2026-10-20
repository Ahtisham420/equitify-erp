import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.modules.map.models import OBSERVATION_CATEGORIES

ObservationCategory = Literal[tuple(OBSERVATION_CATEGORIES)]  # type: ignore[valid-type]


# ----------------------------------------------------------------------------- layers


class LayersOut(BaseModel):
    layers: dict[str, dict[str, Any]]  # layer key -> GeoJSON FeatureCollection (+ truncated, count)
    hidden: list[str] = []  # requested layers the user has no permission for
    facets: dict[str, dict[str, int]] = {}


class ViewerLink(BaseModel):
    label: str
    url_template: str


class MapConfigOut(BaseModel):
    layers: list[dict[str, Any]]
    viewers: list[ViewerLink]
    observation_categories: list[str]


# ----------------------------------------------------------------------------- selection


class Circle(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    radius_m: float = Field(gt=0, le=200_000)


class SelectIn(BaseModel):
    polygon: dict[str, Any] | None = Field(default=None, description="GeoJSON Polygon / Feature")
    circle: Circle | None = None
    property_ids: list[uuid.UUID] = Field(default=[], max_length=2000)
    parcel_ids: list[uuid.UUID] = Field(default=[], max_length=2000)


class SelectedProperty(BaseModel):
    id: uuid.UUID
    label: str
    address_line: str
    city: str | None
    state: str | None
    status: str
    property_type: str
    opportunity_stage: str | None = None


class SelectedParcel(BaseModel):
    id: uuid.UUID
    apn: str
    county: str
    acreage: float | None
    situs_address: str | None
    property_ids: list[uuid.UUID] = []


class SelectOut(BaseModel):
    properties: list[SelectedProperty]
    parcels: list[SelectedParcel]
    truncated: bool = False
    parcels_hidden: bool = False


# ----------------------------------------------------------------------------- bulk actions (preview -> apply)


class BulkTarget(BaseModel):
    property_ids: list[uuid.UUID] = Field(default=[], max_length=2000)
    parcel_ids: list[uuid.UUID] = Field(default=[], max_length=2000)
    apply: bool = False


class BulkOpportunitiesIn(BulkTarget):
    owner_id: uuid.UUID | None = None
    priority: Literal["low", "normal", "high", "urgent"] = "normal"
    source: str = Field(default="map", max_length=80)
    override_reason: str | None = Field(default=None, max_length=2000)


class BulkTerritoryIn(BulkTarget):
    territory_id: uuid.UUID


class BulkSequenceIn(BulkTarget):
    sequence_id: uuid.UUID
    owner_id: uuid.UUID | None = None


class BulkExportIn(BulkTarget):
    pass


class SkipItem(BaseModel):
    id: str
    label: str | None = None
    reason: str


class BulkResult(BaseModel):
    action: str
    applied: bool
    properties: int  # resolved properties in scope
    eligible: int  # would be (or were) acted on
    done: int = 0
    skipped: list[SkipItem] = []
    warnings: list[str] = []
    blocked: bool = False
    details: dict[str, Any] = {}


class ExportOut(BulkResult):
    filename: str | None = None
    csv: str | None = None
    masked: bool = False


class SaveTerritoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = None
    polygon: dict[str, Any] | None = None
    circle: Circle | None = None
    visibility: Literal["private", "role", "company"] = "private"


# ----------------------------------------------------------------------------- record cards


class CardOwner(BaseModel):
    kind: str
    id: uuid.UUID
    name: str | None
    role: str | None = None
    interest_pct: float | None = None


class CardSignal(BaseModel):
    id: uuid.UUID
    category: str
    signal_type: str
    title: str | None
    severity: int
    observed_on: Any


class CardOut(BaseModel):
    kind: str
    property: dict[str, Any] | None = None
    parcel: dict[str, Any] | None = None
    comp: dict[str, Any] | None = None
    observation: dict[str, Any] | None = None
    owners: list[CardOwner] | None = None  # None = hidden (no ownership:view)
    opportunity: dict[str, Any] | None = None
    signals: list[CardSignal] | None = None
    motivation_index: float | None = None
    parcels: list[dict[str, Any]] = []
    viewer_links: list[dict[str, str]] = []


class AssemblageMapOut(BaseModel):
    result: dict[str, Any]
    geometry: dict[str, Any] | None = None


# ----------------------------------------------------------------------------- field observations


class ObservationIn(BaseModel):
    client_uuid: uuid.UUID
    property_id: uuid.UUID | None = None
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0)
    observed_at: datetime | None = None
    category: ObservationCategory = "general"
    note: str | None = Field(default=None, max_length=5000)
    photo_document_ids: list[uuid.UUID] = Field(default=[], max_length=20)


class ObservationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    client_uuid: uuid.UUID
    property_id: uuid.UUID | None
    property_label: str | None = None
    latitude: float
    longitude: float
    accuracy_m: float | None
    observed_at: datetime
    category: str
    note: str | None
    photo_document_ids: list[str]
    created_by_id: uuid.UUID | None
    created_by_name: str | None = None
    created_at: datetime
