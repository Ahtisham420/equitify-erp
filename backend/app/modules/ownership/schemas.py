import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

OwnerKind = Literal["person", "organization"]
NodeKind = Literal["person", "organization", "property"]
Relationship = Literal[
    "manager", "member", "officer", "director", "registered_agent", "parent", "affiliate", "family", "advisor",
]
EvidenceType = Literal[
    "shared_mailing_address", "shared_phone", "shared_email_domain", "registered_agent", "officer_director_record",
    "deed_signatory", "corroborated_name", "other",
]


class EvidenceItem(BaseModel):
    type: EvidenceType
    detail: str | None = Field(default=None, max_length=500)
    source: str | None = Field(default=None, max_length=200)
    observed_on: date | None = None
    sensitive: bool = False


# ---------------------------------------------------------------- interests

class InterestIn(BaseModel):
    property_id: uuid.UUID
    owner_kind: OwnerKind
    owner_id: uuid.UUID
    interest_pct: float | None = Field(default=None, gt=0, le=100)
    role: str = "fee_owner"
    effective_from: date | None = None
    effective_to: date | None = None
    acquired_price: float | None = Field(default=None, ge=0)
    financing_type: str | None = None
    deed_reference: str | None = Field(default=None, max_length=120)
    evidence: list[EvidenceItem] = []
    source: str = Field(default="Manual entry", max_length=200)
    observed_on: date | None = None
    confidence: float = Field(default=0.8, ge=0, le=1)
    verified: bool = False
    notes: str | None = None


class InterestUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interest_pct: float | None = Field(default=None, gt=0, le=100)
    role: str | None = None
    effective_from: date | None = None
    acquired_price: float | None = Field(default=None, ge=0)
    financing_type: str | None = None
    deed_reference: str | None = None
    evidence: list[EvidenceItem] | None = None
    source: str | None = Field(default=None, max_length=200)
    observed_on: date | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    notes: str | None = None


class EndInterestIn(BaseModel):
    effective_to: date
    disposed_price: float | None = Field(default=None, ge=0)
    reason: str | None = Field(default=None, max_length=200)
    source: str = Field(default="Manual entry", max_length=200)


class VerifyIn(BaseModel):
    state: Literal["verified", "rejected", "unverified"]


class InterestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    property_id: uuid.UUID
    owner_kind: str
    owner_person_id: uuid.UUID | None
    owner_organization_id: uuid.UUID | None
    interest_pct: float | None
    role: str
    effective_from: date | None
    effective_to: date | None
    acquired_price: float | None
    disposed_price: float | None
    financing_type: str | None
    deed_reference: str | None
    end_reason: str | None
    evidence: list[dict[str, Any]]
    hidden_evidence: int = 0
    source: str
    observed_on: date | None
    confidence: float
    verification: str
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None
    notes: str | None
    created_at: datetime
    updated_at: datetime
    # derived
    owner_id: uuid.UUID | None = None
    owner_label: str | None = None
    owner_state: str | None = None
    property_label: str | None = None
    property_city: str | None = None
    property_state: str | None = None
    is_current: bool = True
    hold_years: float | None = None
    mismatch: bool = False


class InterestFacets(BaseModel):
    role: dict[str, int]
    verification: dict[str, int]
    owner_kind: dict[str, int]


# ---------------------------------------------------------------- links

class LinkIn(BaseModel):
    from_kind: OwnerKind
    from_id: uuid.UUID
    to_kind: OwnerKind
    to_id: uuid.UUID
    relationship: Relationship
    confidence: float = Field(default=0.8, ge=0, le=1)
    evidence: list[EvidenceItem] = []
    source: str = Field(default="Manual entry", max_length=200)
    effective_from: date | None = None
    notes: str | None = None
    confirmed: bool = True


class LinkUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    relationship: Relationship | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence: list[EvidenceItem] | None = None
    effective_from: date | None = None
    effective_to: date | None = None
    notes: str | None = None


class LinkReviewIn(BaseModel):
    relationship: Relationship | None = None
    reverse: bool = False
    note: str | None = Field(default=None, max_length=1000)


class LinkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    from_kind: str
    from_id: uuid.UUID
    to_kind: str
    to_id: uuid.UUID
    from_label: str | None = None
    to_label: str | None = None
    relationship: str
    confidence: float
    status: str
    evidence: list[dict[str, Any]]
    hidden_evidence: int = 0
    source: str
    suggested_by: str
    reviewed_by_id: uuid.UUID | None
    reviewed_at: datetime | None
    review_note: str | None
    effective_from: date | None
    effective_to: date | None
    notes: str | None
    created_at: datetime


class LinkFacets(BaseModel):
    status: dict[str, int]
    relationship: dict[str, int]


class SuggestOut(BaseModel):
    created: int
    updated: int


# ---------------------------------------------------------------- notes

class NoteIn(BaseModel):
    category: str = "other"
    body: str = Field(min_length=1, max_length=5000)
    sensitive: bool = False
    source: str | None = None
    observed_on: date | None = None


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    owner_kind: str
    owner_id: uuid.UUID
    category: str
    body: str
    sensitive: bool
    source: str | None
    observed_on: date | None
    created_at: datetime
    created_by_id: uuid.UUID | None


# ---------------------------------------------------------------- owner profile

class PortfolioItem(BaseModel):
    interest_id: uuid.UUID
    property_id: uuid.UUID
    property_label: str
    city: str | None
    state: str | None
    property_type: str | None
    role: str
    interest_pct: float | None
    effective_from: date | None
    effective_to: date | None
    acquired_price: float | None
    disposed_price: float | None
    financing_type: str | None
    hold_years: float | None
    is_current: bool
    verification: str
    via_label: str | None = None
    via_kind: str | None = None
    via_id: uuid.UUID | None = None


class OwnerProfile(BaseModel):
    kind: str
    id: uuid.UUID
    label: str
    subtitle: str | None
    city: str | None
    state: str | None
    mailing_address: str | None
    masked: bool
    relationship_strength: str | None
    preferences: dict[str, Any]
    current: list[PortfolioItem]
    prior: list[PortfolioItem]
    controlled: list[PortfolioItem]
    typical_hold_years: float | None
    average_current_hold_years: float | None
    total_acquired_value: float | None
    financing_patterns: dict[str, int]
    links: list[LinkOut]
    notes: list[NoteOut]
    hidden_notes: int
    performance: dict[str, Any]
    opportunities: list[dict[str, Any]]
    recent_interactions: list[dict[str, Any]]


# ---------------------------------------------------------------- warm paths

class PathStep(BaseModel):
    kind: str
    id: uuid.UUID
    label: str
    relation_to_next: str | None = None


class WarmPath(BaseModel):
    steps: list[PathStep]
    length: int
    start_reason: str | None = None


# ---------------------------------------------------------------- property panel

class ControlRelationship(BaseModel):
    link_id: uuid.UUID
    controller_kind: str
    controller_id: uuid.UUID
    controller_label: str | None
    relationship: str
    confidence: float
    status: str


class PanelOwner(BaseModel):
    interest: InterestOut
    mailing_address: str | None
    mailing_city: str | None
    mailing_state: str | None
    controllers: list[ControlRelationship]


class PanelOut(BaseModel):
    property_id: uuid.UUID
    property_state: str | None
    current_owners: list[PanelOwner]
    history: list[InterestOut]
    hold_years: float | None
    acquired_on: date | None
    acquired_price: float | None
    mismatch: bool
    controlling_confidence: float | None
    pending_suggestions: int
    masked: bool
