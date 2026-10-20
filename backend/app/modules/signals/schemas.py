import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Category = Literal["debt", "legal", "tax", "ownership", "physical", "tenancy", "behavioral", "market", "development"]
OwnerKind = Literal["person", "organization"]


class SignalCreate(BaseModel):
    property_id: uuid.UUID | None = None
    owner_kind: OwnerKind | None = None
    owner_id: uuid.UUID | None = None
    signal_type: str = Field(min_length=1, max_length=60)
    title: str | None = Field(default=None, max_length=300)
    description: str | None = None
    observed_on: date
    severity: int | None = Field(default=None, ge=1, le=5)
    source: str = Field(min_length=1, max_length=200)
    source_reference: str | None = Field(default=None, max_length=300)
    confidence: float = Field(default=0.7, ge=0, le=1)
    expires_on: date | None = None
    is_sensitive: bool | None = None
    verified: bool = False
    details: dict[str, Any] = {}


class SignalUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    description: str | None = None
    observed_on: date | None = None
    severity: int | None = Field(default=None, ge=1, le=5)
    source: str | None = Field(default=None, min_length=1, max_length=200)
    source_reference: str | None = Field(default=None, max_length=300)
    confidence: float | None = Field(default=None, ge=0, le=1)
    expires_on: date | None = None
    is_sensitive: bool | None = None
    details: dict[str, Any] | None = None


class SignalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID | None
    property_label: str | None = None
    owner_kind: str | None
    owner_id: uuid.UUID | None
    owner_label: str | None = None
    category: str
    signal_type: str
    type_label: str | None = None
    title: str | None
    description: str | None
    observed_on: date
    severity: int
    source: str
    source_reference: str | None
    confidence: float
    expires_on: date | None
    half_life_days: int | None
    is_sensitive: bool
    redacted: bool = False
    status: str
    effective_status: str = "active"
    current_weight: float = 1.0
    age_days: int = 0
    priority: str = "normal"
    stacked: bool = False
    details: dict
    verification: str
    verified_at: datetime | None
    dismissed_reason: str | None
    dismissed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    created_by_id: uuid.UUID | None


class SignalFacets(BaseModel):
    category: dict[str, int]
    severity: dict[str, int]
    status: dict[str, int]
    signal_type: dict[str, int]


class DismissIn(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class VerifyIn(BaseModel):
    state: Literal["verified", "rejected", "unverified"]


class SignalTypeIn(BaseModel):
    key: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1, max_length=160)
    category: Category
    description: str | None = None
    default_severity: int = Field(default=3, ge=1, le=5)
    half_life_days: int | None = Field(default=None, ge=1, le=3650)
    default_expiry_days: int | None = Field(default=None, ge=1, le=3650)
    is_sensitive: bool = False
    is_active: bool = True


class SignalTypeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = None
    default_severity: int | None = Field(default=None, ge=1, le=5)
    half_life_days: int | None = Field(default=None, ge=1, le=3650)
    default_expiry_days: int | None = Field(default=None, ge=1, le=3650)
    is_sensitive: bool | None = None
    is_active: bool | None = None


class SignalTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    label: str
    category: str
    description: str | None
    default_severity: int
    half_life_days: int | None
    default_expiry_days: int | None
    is_sensitive: bool
    is_active: bool
    signal_count: int = 0
    updated_at: datetime


class SettingsOut(BaseModel):
    enabled: bool
    window_days: int
    min_independent: int
    stack_bonus: float
    alert_min_severity: int


class SettingsIn(BaseModel):
    enabled: bool | None = None
    window_days: int | None = Field(default=None, ge=1, le=3650)
    min_independent: int | None = Field(default=None, ge=2, le=10)
    stack_bonus: float | None = Field(default=None, ge=0, le=2)
    alert_min_severity: int | None = Field(default=None, ge=1, le=5)


class SubscriptionIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    categories: list[Category] = []
    signal_types: list[str] = []
    min_severity: int = Field(default=1, ge=1, le=5)
    property_id: uuid.UUID | None = None
    owner_kind: OwnerKind | None = None
    owner_id: uuid.UUID | None = None
    territory_id: uuid.UUID | None = None
    property_types: list[str] = []
    stacked_only: bool = False
    is_active: bool = True


class SubscriptionOut(SubscriptionIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    subscriber_id: uuid.UUID
    created_at: datetime


class MotivationContribution(BaseModel):
    signal_id: uuid.UUID
    signal_type: str
    category: str
    severity: int
    confidence: float
    weight: float
    contribution: float
    observed_on: date
    source: str
    stacked: bool


class MotivationOut(BaseModel):
    property_id: uuid.UUID
    index: float
    base: float
    stack_multiplier: float
    stacked: bool
    stack_count: int
    window_days: int
    active_signals: int
    contributions: list[MotivationContribution]


class PropertySignalsOut(BaseModel):
    motivation: MotivationOut
    signals: list[SignalOut]
