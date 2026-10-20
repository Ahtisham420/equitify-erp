import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Role = Literal[
    "owner", "principal", "broker", "agent", "tenant_contact", "vendor_contact", "lender", "attorney",
    "title_officer", "capital_partner", "other",
]
Strength = Literal["none", "weak", "moderate", "strong"]
Responsiveness = Literal["unknown", "low", "medium", "high"]
EntityType = Literal["person", "organization"]


# ---------------------------------------------------------------- contact points / affiliations / enrichment

class ContactPointIn(BaseModel):
    kind: Literal["phone", "email"]
    value: str = Field(min_length=3, max_length=255)
    label: str | None = Field(default=None, max_length=60)
    phone_type: Literal["mobile", "landline", "voip", "fax", "unknown"] | None = None
    is_primary: bool = False
    source: str | None = Field(default=None, max_length=200)
    observed_on: date | None = None


class ContactPointUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str | None = Field(default=None, min_length=3, max_length=255)
    label: str | None = None
    phone_type: Literal["mobile", "landline", "voip", "fax", "unknown"] | None = None
    is_primary: bool | None = None
    source: str | None = None


class ContactPointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    person_id: uuid.UUID | None
    organization_id: uuid.UUID | None
    kind: str
    value: str
    label: str | None
    phone_type: str | None
    is_primary: bool
    source: str | None
    observed_on: date | None
    masked: bool = False
    created_at: datetime


class AffiliationIn(BaseModel):
    person_id: uuid.UUID
    organization_id: uuid.UUID
    role: Role
    title: str | None = Field(default=None, max_length=160)
    is_current: bool = True
    started_on: date | None = None
    ended_on: date | None = None
    source: str | None = None
    notes: str | None = None


class AffiliationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Role | None = None
    title: str | None = None
    is_current: bool | None = None
    started_on: date | None = None
    ended_on: date | None = None
    source: str | None = None
    notes: str | None = None


class AffiliationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    person_id: uuid.UUID
    organization_id: uuid.UUID
    person_name: str | None = None
    organization_name: str | None = None
    role: str
    title: str | None
    is_current: bool
    started_on: date | None
    ended_on: date | None
    source: str | None
    notes: str | None


class EnrichmentIn(BaseModel):
    provider: str = Field(min_length=1, max_length=120)
    enriched_at: datetime | None = None
    cost: float | None = Field(default=None, ge=0)
    reliability: float | None = Field(default=None, ge=0, le=1)
    fields: list[str] = []
    restrictions: dict[str, Any] = {}
    notes: str | None = None


class EnrichmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    person_id: uuid.UUID | None
    organization_id: uuid.UUID | None
    provider: str
    enriched_at: datetime
    cost: float | None
    reliability: float | None
    fields: list
    restrictions: dict
    notes: str | None
    created_by_id: uuid.UUID | None


# ---------------------------------------------------------------- people

class PersonBase(BaseModel):
    first_name: str | None = Field(default=None, max_length=120)
    last_name: str | None = Field(default=None, max_length=120)
    full_name: str | None = Field(default=None, max_length=240)
    title: str | None = Field(default=None, max_length=160)
    mailing_address: str | None = Field(default=None, max_length=255)
    city: str | None = None
    state: str | None = Field(default=None, max_length=40)
    postal_code: str | None = None
    contact_preferences: dict[str, Any] = {}
    owner_id: uuid.UUID | None = None
    next_action: str | None = Field(default=None, max_length=300)
    next_action_at: datetime | None = None
    responsiveness: Responsiveness = "unknown"
    relationship_strength: Strength = "none"
    preferences: dict[str, Any] = {}
    source: str | None = None
    notes: str | None = None
    tags: list[str] = []


class PersonCreate(PersonBase):
    emails: list[str] = []
    phones: list[str] = []


class PersonUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_name: str | None = None
    last_name: str | None = None
    full_name: str | None = None
    title: str | None = None
    mailing_address: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    contact_preferences: dict[str, Any] | None = None
    owner_id: uuid.UUID | None = None
    next_action: str | None = None
    next_action_at: datetime | None = None
    responsiveness: Responsiveness | None = None
    relationship_strength: Strength | None = None
    preferences: dict[str, Any] | None = None
    source: str | None = None
    notes: str | None = None
    tags: list[str] | None = None


class PersonListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    full_name: str
    title: str | None
    primary_email: str | None
    primary_phone: str | None
    city: str | None
    state: str | None
    owner_id: uuid.UUID | None
    last_touch_at: datetime | None
    next_action_at: datetime | None
    relationship_strength: str
    responsiveness: str
    tags: list[str]
    organization_name: str | None = None
    roles: list[str] = []
    updated_at: datetime
    masked: bool = False


class ComplianceState(BaseModel):
    channel: str
    value: str
    allowed: bool
    reasons: list[str]


class PersonOut(PersonBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    full_name: str
    primary_email: str | None
    primary_phone: str | None
    last_touch_at: datetime | None
    contact_points: list[ContactPointOut] = []
    affiliations: list[AffiliationOut] = []
    compliance: list[ComplianceState] = []
    masked: bool = False
    merged_into_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    created_by_id: uuid.UUID | None


# ---------------------------------------------------------------- organizations

class OrganizationBase(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    legal_name: str | None = Field(default=None, max_length=240)
    org_type: str = "other"
    website: str | None = Field(default=None, max_length=255)
    domain: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=40)
    mailing_address: str | None = Field(default=None, max_length=255)
    city: str | None = None
    state: str | None = Field(default=None, max_length=40)
    postal_code: str | None = None
    state_of_formation: str | None = None
    registered_agent: str | None = Field(default=None, max_length=240)
    owner_id: uuid.UUID | None = None
    next_action: str | None = None
    next_action_at: datetime | None = None
    responsiveness: Responsiveness = "unknown"
    relationship_strength: Strength = "none"
    preferences: dict[str, Any] = {}
    source: str | None = None
    notes: str | None = None
    tags: list[str] = []


class OrganizationCreate(OrganizationBase):
    pass


class OrganizationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=240)
    legal_name: str | None = None
    org_type: str | None = None
    website: str | None = None
    domain: str | None = None
    phone: str | None = None
    mailing_address: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    state_of_formation: str | None = None
    registered_agent: str | None = None
    owner_id: uuid.UUID | None = None
    next_action: str | None = None
    next_action_at: datetime | None = None
    responsiveness: Responsiveness | None = None
    relationship_strength: Strength | None = None
    preferences: dict[str, Any] | None = None
    source: str | None = None
    notes: str | None = None
    tags: list[str] | None = None


class OrganizationListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    legal_name: str | None
    org_type: str
    domain: str | None
    phone: str | None
    city: str | None
    state: str | None
    owner_id: uuid.UUID | None
    last_touch_at: datetime | None
    next_action_at: datetime | None
    relationship_strength: str
    tags: list[str]
    member_count: int = 0
    updated_at: datetime
    masked: bool = False


class OrganizationOut(OrganizationBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    last_touch_at: datetime | None
    contact_points: list[ContactPointOut] = []
    members: list[AffiliationOut] = []
    masked: bool = False
    merged_into_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    created_by_id: uuid.UUID | None


class PeopleFacets(BaseModel):
    state: dict[str, int]
    relationship_strength: dict[str, int]
    responsiveness: dict[str, int]
    role: dict[str, int]


class OrganizationFacets(BaseModel):
    org_type: dict[str, int]
    state: dict[str, int]
    relationship_strength: dict[str, int]


class BulkIn(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    owner_id: uuid.UUID | None = None
    relationship_strength: Strength | None = None
    add_tags: list[str] = []
    remove_tags: list[str] = []


# ---------------------------------------------------------------- duplicates / merges

class DuplicateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    entity_type: str
    a_id: uuid.UUID
    b_id: uuid.UUID
    a_label: str | None = None
    b_label: str | None = None
    reasons: list
    score: float
    status: str
    reviewed_at: datetime | None
    created_at: datetime


class ScanOut(BaseModel):
    scanned: int
    new_candidates: int


class MergeIn(BaseModel):
    entity_type: EntityType
    survivor_id: uuid.UUID
    merged_id: uuid.UUID
    take_from_merged: list[str] = []
    review_id: uuid.UUID | None = None
    reason: str | None = None


class MergeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    entity_type: str
    survivor_id: uuid.UUID
    merged_id: uuid.UUID
    survivor_label: str | None = None
    merged_label: str | None = None
    repointed_count: int = 0
    reason: str | None
    status: str
    merged_at: datetime
    created_by_id: uuid.UUID | None
    reversed_at: datetime | None
    reversed_by_id: uuid.UUID | None


# ---------------------------------------------------------------- context

class ContextProperty(BaseModel):
    interest_id: uuid.UUID
    property_id: uuid.UUID
    property_label: str
    city: str | None
    state: str | None
    property_type: str | None
    role: str | None
    interest_pct: float | None
    effective_from: date | None
    effective_to: date | None
    is_current: bool
    via_organization_id: uuid.UUID | None = None
    via_organization_name: str | None = None


class ContextOpportunity(BaseModel):
    id: uuid.UUID
    title: str | None
    stage: str | None
    property_id: uuid.UUID | None
    next_action_at: datetime | None
    source: str | None


class ContextInteraction(BaseModel):
    id: uuid.UUID
    channel: str | None
    direction: str | None
    occurred_at: datetime | None
    summary: str | None
    disposition: str | None
    property_id: uuid.UUID | None
    opportunity_id: uuid.UUID | None
    next_action_at: datetime | None
    loop_closed: bool | None


class ContextTask(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    priority: str
    due_at: datetime | None
    assignee_id: uuid.UUID | None


class RelationshipMetrics(BaseModel):
    last_touch_at: datetime | None
    next_action_at: datetime | None
    interactions: int
    meaningful_interactions: int
    outbound: int
    inbound: int
    response_rate: float | None
    opportunities: int
    won: int
    lost: int
    close_rate: float | None
    source_attribution: dict[str, int]


class ContextOut(BaseModel):
    properties: list[ContextProperty]
    opportunities: list[ContextOpportunity]
    interactions: list[ContextInteraction]
    tasks: list[ContextTask]
    metrics: RelationshipMetrics
