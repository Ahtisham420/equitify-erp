import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class KpiMeta(BaseModel):
    key: str
    label: str
    family: str
    module: str
    definition: str
    unit: str
    point_in_time: bool
    module_href: str | None = None
    facets: list[str] = []
    dims: list[str] = []


class DashboardMeta(BaseModel):
    key: str
    label: str
    description: str
    default_me: bool = False
    tile_count: int


class Catalog(BaseModel):
    dashboards: list[DashboardMeta]
    kpis: list[KpiMeta]
    families: list[str]
    can_export: bool
    can_schedule: bool
    can_snapshot: bool


class Tile(BaseModel):
    key: str
    label: str
    value: float | None
    unit: str
    delta: float | None = None
    better: str | None = None
    href: str
    module_href: str | None = None
    definition: str
    point_in_time: bool
    ignored_filters: list[str] = []


class SeriesMeta(BaseModel):
    key: str
    label: str
    href: str


class Point(BaseModel):
    key: str
    label: str
    values: dict[str, float | None]
    hrefs: dict[str, str]


class SeriesOut(BaseModel):
    key: str
    label: str
    description: str | None = None
    kind: str
    chart: str
    unit: str
    series: list[SeriesMeta]
    points: list[Point]


class Column(BaseModel):
    key: str
    label: str
    kind: str = "text"


class Row(BaseModel):
    id: str
    title: str
    href: str | None = None
    cells: dict[str, Any] = {}
    hrefs: dict[str, str] = {}
    source: str | None = None
    restricted: bool = False
    restriction_reason: str | None = None


class TableOut(BaseModel):
    key: str
    label: str
    description: str | None = None
    columns: list[Column]
    rows: list[Row]
    total: int | None = None
    href: str | None = None


class DashboardOut(BaseModel):
    key: str
    label: str
    description: str
    generated_at: datetime
    default_me: bool
    filters: dict[str, list[str]]
    tiles: list[Tile]
    series: list[SeriesOut]
    tables: list[TableOut]


class KpiOut(KpiMeta):
    value: float | None
    delta: float | None = None
    better: str | None = None
    href: str
    ignored_filters: list[str] = []
    columns: list[Column] = []


class RecordPage(BaseModel):
    columns: list[Column]
    items: list[Row]
    total: int
    page: int
    page_size: int
    ignored_filters: list[str] = []
    withheld: int = 0


class SnapshotPoint(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    as_of: date
    value: float | None
    dims: dict = {}


class SnapshotRunOut(BaseModel):
    as_of: date
    created: int
    skipped: int
    failed: list[str]


class FilterOption(BaseModel):
    value: str
    label: str


class FilterOptions(BaseModel):
    users: list[FilterOption]
    teams: list[FilterOption]
    territories: list[FilterOption]
    property_types: list[FilterOption]
    states: list[FilterOption]
    sources: list[FilterOption]
    stages: list[FilterOption]


Cadence = Literal["daily", "weekly", "monthly"]


class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dashboard_key: str = Field(max_length=60)
    filters: dict[str, list[str]] = {}
    cadence: Cadence = "weekly"
    recipient_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    format: Literal["csv"] = "csv"
    is_active: bool = True
    notes: str | None = None


class ScheduleUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    filters: dict[str, list[str]] | None = None
    cadence: Cadence | None = None
    recipient_ids: list[uuid.UUID] | None = Field(None, max_length=50)
    is_active: bool | None = None
    notes: str | None = None


class ScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    dashboard_key: str
    dashboard_label: str | None = None
    filters: dict
    cadence: str
    recipient_ids: list[uuid.UUID]
    recipient_names: list[str] = []
    format: str
    is_active: bool
    owner_id: uuid.UUID | None
    owner_name: str | None = None
    next_run_at: datetime | None
    last_run_at: datetime | None
    notes: str | None
    created_at: datetime


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    schedule_id: uuid.UUID | None
    dashboard_key: str
    recipient_id: uuid.UUID | None
    recipient_name: str | None = None
    ran_at: datetime
    status: str
    filename: str | None
    size_bytes: int
    row_count: int
    withheld_rows: int
    error: str | None


class RunDueOut(BaseModel):
    schedules: int
    runs: int
    failed: int
