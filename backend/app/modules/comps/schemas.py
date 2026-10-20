import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

TenantCredit = Literal["investment_grade", "national", "regional", "local", "none"]
VerificationStatus = Literal["unverified", "verified", "disputed"]
ValuationMethod = Literal["direct_cap", "dcf", "sales_comparison", "land_residual", "appraisal", "bov"]


class VerificationIn(BaseModel):
    status: VerificationStatus = "verified"
    method: str | None = Field(default=None, max_length=40)
    notes: str | None = None


# --------------------------------------------------------------------------- comps (shared)


class _CompCommon(BaseModel):
    property_id: uuid.UUID | None = None
    name: str | None = Field(default=None, max_length=200)
    address_line: str | None = Field(default=None, max_length=255)
    city: str | None = None
    state: str | None = None
    county: str | None = None
    corridor: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    property_type: str | None = None
    tenant_name: str | None = None
    tenant_organization_id: uuid.UUID | None = None
    tenant_credit: TenantCredit | None = None
    building_area_sf: float | None = Field(default=None, ge=0)
    land_area_acres: float | None = Field(default=None, ge=0)
    year_built: int | None = Field(default=None, ge=1700, le=2100)
    condition: str | None = None
    source: str | None = Field(default=None, max_length=200)
    document_id: uuid.UUID | None = None
    notes: str | None = None
    tags: list[str] = []


class SaleCompFields(_CompCommon):
    sale_date: date | None = None
    sale_price: float | None = Field(default=None, ge=0)
    price_psf: float | None = Field(default=None, ge=0)
    price_per_acre: float | None = Field(default=None, ge=0)
    cap_rate: float | None = Field(default=None, ge=0, le=100)
    noi: float | None = None
    buyer_name: str | None = None
    buyer_organization_id: uuid.UUID | None = None
    seller_name: str | None = None
    seller_organization_id: uuid.UUID | None = None
    financing: str | None = None
    lease_term_remaining_years: float | None = Field(default=None, ge=0)
    occupancy_pct: float | None = Field(default=None, ge=0, le=100)


class SaleCompCreate(SaleCompFields):
    verification: VerificationIn | None = None


class SaleCompUpdate(SaleCompFields):
    model_config = ConfigDict(extra="forbid")
    tags: list[str] | None = None  # type: ignore[assignment]


class LeaseCompFields(_CompCommon):
    space_id: uuid.UUID | None = None
    suite: str | None = None
    lease_type: str | None = None
    commencement_on: date | None = None
    term_months: int | None = Field(default=None, ge=0, le=1200)
    area_sf: float | None = Field(default=None, ge=0)
    base_rent_psf: float | None = Field(default=None, ge=0)
    escalation_pct: float | None = None
    escalation_structure: str | None = None
    recovery_type: str | None = None
    recoveries_psf: float | None = Field(default=None, ge=0)
    free_rent_months: float | None = Field(default=None, ge=0)
    concessions: str | None = None
    ti_psf: float | None = Field(default=None, ge=0)
    effective_rent_psf: float | None = None


class LeaseCompCreate(LeaseCompFields):
    verification: VerificationIn | None = None


class LeaseCompUpdate(LeaseCompFields):
    model_config = ConfigDict(extra="forbid")
    tags: list[str] | None = None  # type: ignore[assignment]


class _CompOutMixin(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    verification_status: str
    verification_method: str | None
    verification_notes: str | None
    verified_by_id: uuid.UUID | None
    verified_by_name: str | None = None
    verified_at: datetime | None
    property_label: str | None = None
    created_at: datetime
    updated_at: datetime


class SaleCompOut(SaleCompFields, _CompOutMixin):
    pass


class LeaseCompOut(LeaseCompFields, _CompOutMixin):
    pass


class CompFacets(BaseModel):
    property_type: dict[str, int]
    verification_status: dict[str, int]
    tenant_credit: dict[str, int]
    state: dict[str, int]


class Candidate(BaseModel):
    id: uuid.UUID
    kind: str
    label: str
    city: str | None
    state: str | None
    county: str | None
    corridor: str | None
    property_type: str | None
    tenant_name: str | None
    tenant_credit: str | None
    date: date | None
    price: float | None = None
    price_psf: float | None = None
    cap_rate: float | None = None
    rent_psf: float | None = None
    term_years: float | None = None
    area_sf: float | None = None
    verification_status: str
    distance_miles: float | None = None


# --------------------------------------------------------------------------- comp sets


class CompSetCreate(BaseModel):
    subject_property_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["sale", "lease"]
    purpose: Literal["valuation", "underwriting", "bov", "mark"] | None = "valuation"
    value_basis: str | None = None
    subject_quantity: float | None = None
    subject_quantity_source: str | None = None
    criteria: dict[str, Any] = {}
    notes: str | None = None
    comp_ids: list[uuid.UUID] = Field(default=[], max_length=100)


class CompSetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    purpose: Literal["valuation", "underwriting", "bov", "mark"] | None = None
    status: Literal["draft", "final"] | None = None
    value_basis: str | None = None
    subject_quantity: float | None = None
    subject_quantity_source: str | None = None
    notes: str | None = None


class AddItemsIn(BaseModel):
    comp_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)


class ItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    included: bool | None = None
    exclusion_reason: str | None = Field(default=None, max_length=2000)
    adjustments: dict[str, float] | None = None
    adjustment_notes: dict[str, str] | None = None
    weight: float | None = Field(default=None, ge=0, le=100)


class GridRow(BaseModel):
    id: uuid.UUID
    adjustments: dict[str, float] = {}
    adjustment_notes: dict[str, str] = {}
    weight: float = Field(default=1.0, ge=0, le=100)


class GridIn(BaseModel):
    value_basis: str | None = None
    subject_quantity: float | None = None
    subject_quantity_source: str | None = None
    items: list[GridRow] = Field(max_length=200)


class CompSetItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    sale_comp_id: uuid.UUID | None
    lease_comp_id: uuid.UUID | None
    included: bool
    exclusion_reason: str | None
    decision_history: list[dict[str, Any]]
    adjustments: dict[str, float]
    adjustment_notes: dict[str, str]
    weight: float
    base_metric: float | None
    net_adjustment_pct: float | None
    adjusted_metric: float | None
    adjusted_value: float | None
    distance_miles: float | None
    sort_order: int
    comp: dict[str, Any] = {}


class CompSetListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    kind: str
    purpose: str | None
    status: str
    value_basis: str
    subject_property_id: uuid.UUID | None
    subject_label: str | None = None
    indicated: dict[str, Any]
    included_count: int = 0
    excluded_count: int = 0
    updated_at: datetime
    created_at: datetime


class CompSetOut(CompSetListItem):
    subject_quantity: float | None
    subject_quantity_source: str | None
    criteria: dict[str, Any]
    notes: str | None
    owner_id: uuid.UUID | None
    subject: dict[str, Any] = {}
    items: list[CompSetItemOut] = []


class CompSetFacets(BaseModel):
    kind: dict[str, int]
    status: dict[str, int]
    purpose: dict[str, int]


# --------------------------------------------------------------------------- valuations


class SourcedValue(BaseModel):
    value: float | None = None
    source: str | None = Field(default=None, max_length=300)
    comp_ids: list[uuid.UUID] = []
    document_id: uuid.UUID | None = None


class ValuationCreate(BaseModel):
    property_id: uuid.UUID
    method: ValuationMethod
    as_of: date
    is_mark: bool = False
    analyst_id: uuid.UUID | None = None
    comp_set_id: uuid.UUID | None = None
    uw_model_id: uuid.UUID | None = None
    assumptions: dict[str, SourcedValue] = {}
    value_low: float | None = Field(default=None, ge=0)
    value_high: float | None = Field(default=None, ge=0)
    value_point: float | None = Field(default=None, ge=0)
    document_id: uuid.UUID | None = None
    third_party: str | None = Field(default=None, max_length=200)
    notes: str | None = None


class FromCompSetIn(BaseModel):
    as_of: date
    is_mark: bool = False
    notes: str | None = None


class ValuationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    property_id: uuid.UUID
    property_label: str | None = None
    method: str
    value_low: float | None
    value_high: float | None
    value_point: float | None
    as_of: date
    analyst_id: uuid.UUID | None
    analyst_name: str | None = None
    comp_set_id: uuid.UUID | None
    uw_model_id: uuid.UUID | None
    is_mark: bool
    inputs: dict[str, Any]
    assumptions: dict[str, Any]
    unsourced: list[Any]
    calculation: dict[str, Any]
    document_id: uuid.UUID | None
    third_party: str | None
    notes: str | None
    prior_value_point: float | None = None
    change_pct: float | None = None
    created_at: datetime


class ValuationPreview(BaseModel):
    value_low: float | None
    value_high: float | None
    value_point: float | None
    calculation: dict[str, Any]
    unsourced: list[str]


class ValuationFacets(BaseModel):
    method: dict[str, int]
    is_mark: dict[str, int]


class ValuationDocumentIn(BaseModel):
    property_id: uuid.UUID
    document_id: uuid.UUID
    kind: Literal["appraisal", "bov", "other"] = "appraisal"
    label: str | None = Field(default=None, max_length=200)
    prepared_by: str | None = Field(default=None, max_length=200)
    effective_date: date | None = None
    value_conclusion: float | None = Field(default=None, ge=0)
    valuation_id: uuid.UUID | None = None


class ValuationDocumentOut(ValuationDocumentIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    created_at: datetime


# --------------------------------------------------------------------------- BOV


class BovCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    prepared_for: str | None = Field(default=None, max_length=200)
    narrative: str | None = None
    recommended_list_price: float | None = Field(default=None, ge=0)
    valuation_id: uuid.UUID | None = None


class BovUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=200)
    prepared_for: str | None = None
    narrative: str | None = None
    recommended_list_price: float | None = Field(default=None, ge=0)
    status: Literal["draft", "final", "delivered"] | None = None
    document_id: uuid.UUID | None = None


class BovOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    property_id: uuid.UUID
    property_label: str | None = None
    comp_set_id: uuid.UUID
    valuation_id: uuid.UUID | None
    title: str
    prepared_for: str | None
    prepared_by_id: uuid.UUID | None
    prepared_by_name: str | None = None
    status: str
    value_low: float | None
    value_high: float | None
    value_point: float | None
    recommended_list_price: float | None
    narrative: str | None
    payload: dict[str, Any]
    generated_at: datetime | None
    document_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
