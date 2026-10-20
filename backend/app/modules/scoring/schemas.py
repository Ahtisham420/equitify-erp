import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ComponentOut(BaseModel):
    key: str
    label: str
    value: float
    weight: float
    contribution: float
    inputs: dict[str, Any] = {}
    positive: list[str] = []
    negative: list[str] = []
    missing: list[str] = []


class ConfidenceFactorOut(BaseModel):
    key: str
    label: str
    value: float
    weight: float
    detail: str | None = None


class ScoreOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    score: float
    confidence: float
    adjusted_score: float
    band: str
    components: list[ComponentOut]
    confidence_factors: list[ConfidenceFactorOut]
    drivers: dict
    eligibility: list
    config_version: int
    needs_research: bool
    requires_human_approval: bool
    value_basis: float | None
    trigger: str
    computed_at: datetime
    is_current: bool


class HistoryPoint(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    score: float
    confidence: float
    band: str
    config_version: int
    trigger: str
    computed_at: datetime


class PropertyScoreOut(BaseModel):
    property_id: uuid.UUID
    eligible: bool
    eligibility: list[dict]
    score: ScoreOut | None
    history: list[HistoryPoint]


class RankingItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    property_label: str | None = None
    property_city: str | None = None
    property_state: str | None = None
    property_type: str | None = None
    asking_price: float | None = None
    position: int = 0
    score: float
    confidence: float
    adjusted_score: float
    band: str
    config_version: int
    needs_research: bool
    requires_human_approval: bool
    component_values: dict[str, float] = {}
    top_positive: str | None = None
    top_negative: str | None = None
    previous_score: float | None = None
    computed_at: datetime


class RankingFacets(BaseModel):
    band: dict[str, int]
    property_type: dict[str, int]


class ConfigIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    weights: dict[str, float]
    band_thresholds: dict[str, float] = {"high": 0.75, "medium": 0.5}
    alert_threshold: float = Field(default=75, ge=0, le=100)
    high_dollar_threshold: float = Field(default=5_000_000, ge=0)
    notes: str | None = None


class ConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    name: str
    status: str
    weights: dict[str, float]
    band_thresholds: dict[str, float]
    alert_threshold: float
    high_dollar_threshold: float
    notes: str | None
    source: str
    basis: dict
    based_on_version: int | None
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    activated_at: datetime | None
    retired_at: datetime | None
    rejected_reason: str | None
    created_at: datetime
    created_by_id: uuid.UUID | None


class RejectIn(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class OutcomeIn(BaseModel):
    property_id: uuid.UUID
    opportunity_id: uuid.UUID | None = None
    disposition: str = Field(min_length=1, max_length=40)
    result: Literal["open", "won", "lost"] = "open"
    notes: str | None = None


class OutcomeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    property_id: uuid.UUID
    property_label: str | None = None
    opportunity_id: uuid.UUID | None
    disposition: str
    decided_at: datetime
    score_at_decision: float | None
    confidence_at_decision: float | None
    band_at_decision: str | None
    config_version: int | None
    components_at_decision: dict
    result: str
    result_at: datetime | None
    elapsed_days: float | None
    source: str
    notes: str | None


class OutcomeSummary(BaseModel):
    total: int
    won: int
    lost: int
    open: int
    avg_score_won: float | None
    avg_score_lost: float | None
    by_band: dict[str, dict[str, int]]
    recalibration_ready: bool
    min_required: dict[str, int]
