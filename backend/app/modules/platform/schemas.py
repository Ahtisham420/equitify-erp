import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.modules.properties.schemas import PropertyListItem

# --- Integrations ----------------------------------------------------------------------------------


class ProviderOption(BaseModel):
    name: str
    label: str
    description: str | None = None
    required_config: list[str] = []
    required_credentials: list[str] = []


class IntegrationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    category: str
    provider: str
    label: str | None
    status: str
    is_primary: bool
    config: dict
    credentials: dict[str, str] = {}  # masked values only
    credentials_version: int
    credentials_rotated_at: datetime | None
    usage_restrictions: str | None
    last_success_at: datetime | None
    last_error: str | None
    last_error_at: datetime | None
    last_tested_at: datetime | None
    updated_at: datetime


class CategoryOut(BaseModel):
    key: str
    label: str
    providers: list[IntegrationOut]
    options: list[ProviderOption]


class IntegrationCreate(BaseModel):
    category: str
    provider: str = Field(min_length=1, max_length=80)
    label: str | None = Field(default=None, max_length=160)
    config: dict[str, Any] = {}
    credentials: dict[str, str] = {}
    usage_restrictions: str | None = None
    is_primary: bool = False


class IntegrationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = None
    status: Literal["not_configured", "manual", "active", "disabled"] | None = None
    config: dict[str, Any] | None = None
    usage_restrictions: str | None = None
    is_primary: bool | None = None


class CredentialsIn(BaseModel):
    """Rotation: non-empty values replace/add keys, `remove_keys` deletes keys, other stored keys are kept."""

    credentials: dict[str, str] = {}
    remove_keys: list[str] = []
    reason: str | None = None


class TestResult(BaseModel):
    ok: bool
    message: str
    missing: list[str] = []
    integration: IntegrationOut


# --- Feature flags -------------------------------------------------------------------------------


class FlagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    description: str | None
    enabled: bool
    is_sensitive: bool
    rollout_roles: list[str]
    rollout_user_ids: list[str]
    updated_at: datetime
    updated_by_id: uuid.UUID | None


class FlagCreate(BaseModel):
    key: str = Field(min_length=2, max_length=80, pattern=r"^[a-z0-9_.\-]+$")
    description: str | None = None
    enabled: bool = False
    is_sensitive: bool = False
    rollout_roles: list[str] = []
    rollout_user_ids: list[uuid.UUID] = []


class FlagUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str | None = None
    enabled: bool | None = None
    is_sensitive: bool | None = None
    rollout_roles: list[str] | None = None
    rollout_user_ids: list[uuid.UUID] | None = None
    reason: str | None = Field(default=None, max_length=500)


# --- Webhooks ------------------------------------------------------------------------------------


class SubscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    url: str
    events: list[str]
    active: bool
    last_delivery_at: datetime | None
    consecutive_failures: int
    created_at: datetime
    secret: str | None = None  # only on create / rotate


class SubscriptionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    url: str = Field(min_length=8, max_length=1000, pattern=r"^https?://")
    events: list[str] = Field(min_length=1)
    active: bool = True


class SubscriptionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=160)
    url: str | None = Field(default=None, max_length=1000, pattern=r"^https?://")
    events: list[str] | None = None
    active: bool | None = None


class DeliveryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    subscription_id: uuid.UUID
    subscription_name: str | None = None
    event: str
    payload: dict
    status: str
    attempts: int
    next_attempt_at: datetime
    last_attempt_at: datetime | None
    last_status_code: int | None
    last_error: str | None
    delivered_at: datetime | None
    created_at: datetime


class DeliverResult(BaseModel):
    attempted: int
    delivered: int
    failed: int
    dead: int


# --- Jobs / exports ------------------------------------------------------------------------------


class JobRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    job_key: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    duration_ms: int | None
    error: str | None
    counts: dict
    triggered_by_id: uuid.UUID | None


class JobSummary(BaseModel):
    job_key: str
    runs: int
    failures: int
    last_status: str
    last_started_at: datetime
    last_error: str | None


class ExportEventOut(BaseModel):
    id: uuid.UUID
    occurred_at: datetime
    actor_id: uuid.UUID | None
    actor_name: str | None
    action: str
    entity_type: str
    summary: str | None
    rows: int | None
    ip_address: str | None


class ExportByUser(BaseModel):
    actor_id: uuid.UUID | None
    actor_name: str | None
    exports: int
    rows: int
    last_at: datetime


# --- Retention / legal hold ----------------------------------------------------------------------


class RetentionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: str
    retain_days: int
    action: str
    description: str | None
    is_active: bool
    updated_at: datetime


class RetentionIn(BaseModel):
    entity_type: str = Field(min_length=1, max_length=60)
    retain_days: int = Field(ge=1, le=36500)
    action: Literal["review", "archive"] = "review"
    description: str | None = None
    is_active: bool = True


class HoldOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID | None
    reason: str
    matter: str | None
    placed_by_id: uuid.UUID | None
    placed_by_name: str | None = None
    placed_at: datetime
    released_at: datetime | None
    released_by_id: uuid.UUID | None
    release_reason: str | None


class HoldIn(BaseModel):
    entity_type: str = Field(min_length=1, max_length=60)
    entity_id: uuid.UUID | None = None
    reason: str = Field(min_length=3)
    matter: str | None = Field(default=None, max_length=200)


class ReleaseIn(BaseModel):
    reason: str = Field(min_length=3)


# --- Backups / environment / health --------------------------------------------------------------


class BackupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    environment: str
    performed_at: datetime
    reference: str | None
    encrypted: bool
    point_in_time: bool
    size_bytes: int | None
    rpo_target_minutes: int | None
    rto_target_minutes: int | None
    achieved_rpo_minutes: float | None
    achieved_rto_minutes: float | None
    result: str
    notes: str | None
    performed_by_id: uuid.UUID | None
    meets_targets: bool | None = None


class BackupIn(BaseModel):
    kind: Literal["backup", "restore_test"]
    environment: Literal["production", "staging", "development"] = "production"
    performed_at: datetime | None = None
    reference: str | None = Field(default=None, max_length=300)
    encrypted: bool = True
    point_in_time: bool = False
    size_bytes: int | None = Field(default=None, ge=0)
    rpo_target_minutes: int | None = Field(default=None, ge=0)
    rto_target_minutes: int | None = Field(default=None, ge=0)
    achieved_rpo_minutes: float | None = Field(default=None, ge=0)
    achieved_rto_minutes: float | None = Field(default=None, ge=0)
    result: Literal["success", "partial", "failed"] = "success"
    notes: str | None = None


class HealthCheck(BaseModel):
    key: str
    label: str
    status: Literal["ok", "warning", "error"]
    detail: str


class HealthOut(BaseModel):
    status: Literal["ok", "warning", "error"]
    environment: str
    checked_at: datetime
    db_latency_ms: float | None
    job_failures_24h: int
    webhook_dead_letters: int
    webhook_pending: int
    integrations_in_error: int
    ai: dict
    last_backup_at: datetime | None
    last_restore_test_at: datetime | None
    checks: list[HealthCheck]


class EnvironmentOut(BaseModel):
    environment: str
    app_name: str
    api_prefix: str
    api_version: str
    encryption_key_configured: bool
    ai_configured: bool
    mfa_enforced: bool
    data_rules: list[str]


class ApiScope(BaseModel):
    module: str
    label: str
    scopes: list[str]


class ApiOut(BaseModel):
    version: str
    prefix: str
    auth: list[str]
    actions: list[str]
    modules: list[ApiScope]
    webhook_events: list[str]


# --- AI ------------------------------------------------------------------------------------------


class NLQueryIn(BaseModel):
    question: str = Field(min_length=3, max_length=500)
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)


class NLFilters(BaseModel):
    """Exactly the PropertyFilters fields the AI may set (ids excluded)."""

    q: str | None = None
    status: list[str] | None = None
    property_type: list[str] | None = None
    state: list[str] | None = None
    county: str | None = None
    city: str | None = None
    tag: list[str] | None = None
    min_area: float | None = None
    max_area: float | None = None
    min_acres: float | None = None
    max_acres: float | None = None
    min_price: float | None = None
    max_price: float | None = None
    min_year: int | None = None
    max_year: int | None = None
    min_completeness: float | None = None
    near_lat: float | None = Field(default=None, ge=-90, le=90)
    near_lng: float | None = Field(default=None, ge=-180, le=180)
    radius_miles: float | None = Field(default=None, gt=0, le=200)
    sort: str | None = None


class NLQueryOut(BaseModel):
    question: str
    ai_used: bool
    provider: str
    message: str | None = None
    filters: dict[str, Any]
    unmapped: list[str] = []
    items: list[PropertyListItem]
    total: int
    page: int
    page_size: int


class SuggestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source_type: str
    source_id: uuid.UUID
    kind: str
    content: str
    details: dict
    status: str
    provider: str | None
    model: str | None
    decided_by_id: uuid.UUID | None
    decided_at: datetime | None
    task_id: uuid.UUID | None
    created_at: datetime


class SummarizeOut(BaseModel):
    ai_used: bool
    provider: str
    message: str | None = None
    suggestions: list[SuggestionOut]


class AcceptIn(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    due_at: datetime | None = None
    assignee_id: uuid.UUID | None = None


class TalkingPoint(BaseModel):
    text: str
    basis: str  # the record/fact the point is grounded in


class TalkingPointsOut(BaseModel):
    person_id: uuid.UUID
    person_name: str
    ai_used: bool
    provider: str
    message: str | None = None
    points: list[TalkingPoint]
    properties: list[dict]
    recent_interactions: list[dict]
    signals: list[dict]
    valuations: list[dict]
