import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Cadence = Literal["one_time", "daily", "weekly", "monthly", "quarterly", "annual", "ad_hoc"]


# --- Data sources -----------------------------------------------------------------------------

class DataSourceBase(BaseModel):
    provider: str = Field(min_length=1, max_length=200)
    description: str | None = None
    license_terms: str | None = None
    permitted_use: str | None = None
    redistribution_allowed: bool = False
    cadence: Cadence = "ad_hoc"
    cost: float | None = Field(default=None, ge=0)
    cost_notes: str | None = Field(default=None, max_length=200)
    contact_name: str | None = Field(default=None, max_length=200)
    contact_email: str | None = Field(default=None, max_length=255)
    contact_phone: str | None = Field(default=None, max_length=40)
    renewal_date: date | None = None
    is_active: bool = True


class DataSourceIn(DataSourceBase):
    pass


class DataSourceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    license_terms: str | None = None
    permitted_use: str | None = None
    redistribution_allowed: bool | None = None
    cadence: Cadence | None = None
    cost: float | None = Field(default=None, ge=0)
    cost_notes: str | None = Field(default=None, max_length=200)
    contact_name: str | None = Field(default=None, max_length=200)
    contact_email: str | None = Field(default=None, max_length=255)
    contact_phone: str | None = Field(default=None, max_length=40)
    renewal_date: date | None = None
    is_active: bool | None = None


class DataSourceOut(DataSourceBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    import_count: int = 0
    created_at: datetime
    updated_at: datetime


# --- Import jobs ------------------------------------------------------------------------------

class TargetField(BaseModel):
    key: str
    label: str
    type: str
    required: bool
    options: list[str] = []
    group: str


class ImportJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: str
    data_source_id: uuid.UUID | None
    data_source_name: str | None = None
    filename: str
    status: str
    row_count: int
    counts: dict[str, int]
    column_mapping: dict[str, str | None]
    options: dict[str, Any]
    error: str | None
    created_by_id: uuid.UUID | None
    created_at: datetime
    validated_at: datetime | None
    committed_at: datetime | None
    rolled_back_at: datetime | None


class ImportJobDetail(ImportJobOut):
    headers: list[str] = []
    sample: list[dict[str, Any]] = []
    suggested_mapping: dict[str, str | None] = {}
    fields: list[TargetField] = []


class ImportFacets(BaseModel):
    status: dict[str, int]
    entity_type: dict[str, int]


class MappingIn(BaseModel):
    column_mapping: dict[str, str | None]


class CommitIn(BaseModel):
    on_duplicate: Literal["skip", "update"] = "skip"


class ImportRowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    row_number: int
    raw: dict[str, Any]
    mapped: dict[str, Any] | None
    status: str
    errors: list[dict[str, Any]]
    duplicate_of_id: uuid.UUID | None
    created_entity_id: uuid.UUID | None
    previous_values: dict[str, Any] | None


# --- Data quality -----------------------------------------------------------------------------

class TypeCompleteness(BaseModel):
    property_type: str
    count: int
    average: float


class StaleField(BaseModel):
    field: str
    threshold_days: int
    stale: int


class QualitySummary(BaseModel):
    total_properties: int
    average_completeness: float
    completeness_bands: dict[str, int]
    completeness_by_type: list[TypeCompleteness]
    verification_backlog: int
    ai_unverified: int
    stale_total: int
    stale_by_field: list[StaleField]
    duplicate_groups: int
    duplicate_properties: int
    duplicate_rate: float


class BacklogItem(BaseModel):
    id: uuid.UUID
    property_id: uuid.UUID
    property_title: str
    property_location: str | None
    field: str
    value: Any
    source: str
    observed_on: date | None
    confidence: float
    ai_derived: bool
    recorded_at: datetime


class BacklogFacets(BaseModel):
    field: dict[str, int]
    ai_derived: dict[str, int]


class StaleItem(BacklogItem):
    verification: str
    threshold_days: int
    age_days: int


class DuplicateMember(BaseModel):
    id: uuid.UUID
    name: str | None
    address_line: str
    city: str | None
    state: str | None
    status: str
    completeness_score: float
    created_at: datetime


class DuplicateGroup(BaseModel):
    normalized_address: str
    count: int
    properties: list[DuplicateMember]


class Threshold(BaseModel):
    field: str
    days: int | None
    default_days: int | None
    is_default: bool


class ThresholdsIn(BaseModel):
    thresholds: dict[str, int | None]
