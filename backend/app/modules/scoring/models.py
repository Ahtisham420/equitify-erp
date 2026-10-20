import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import Entity, UUIDPk, fk
from app.core.database import Base
from app.core.security import utcnow

COMPONENTS = ["economics", "location", "motivation", "transaction_probability", "relationship", "negative_risk"]
COMPONENT_LABELS = {
    "economics": "Economics / pricing gap",
    "location": "Location / growth",
    "motivation": "Owner motivation",
    "transaction_probability": "Transaction probability",
    "relationship": "Relationship strength",
    "negative_risk": "Negative risk",
}
# Value components are weighted averages; negative risk is a penalty weight (score points per risk point).
DEFAULT_WEIGHTS = {
    "economics": 0.25, "location": 0.15, "motivation": 0.25, "transaction_probability": 0.20,
    "relationship": 0.15, "negative_risk": 0.20,
}
DEFAULT_BANDS = {"high": 0.75, "medium": 0.5}
BANDS = ["high", "medium", "low"]
CONFIG_STATUSES = ["draft", "proposed", "active", "retired", "rejected"]
OUTCOME_RESULTS = ["open", "won", "lost"]


class ScoreConfig(Entity, Base):
    """Versioned weight configuration. Only one is active; prior versions are retained (never overwritten)."""

    __tablename__ = "score_configs"

    version: Mapped[int] = mapped_column(Integer, unique=True)
    name: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    weights: Mapped[dict] = mapped_column(JSONB, default=dict)
    band_thresholds: Mapped[dict] = mapped_column(JSONB, default=dict)
    alert_threshold: Mapped[float] = mapped_column(Float, default=75)
    high_dollar_threshold: Mapped[float] = mapped_column(Numeric(16, 2, asdecimal=False), default=5_000_000)
    notes: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual | recalibration | default
    basis: Mapped[dict] = mapped_column(JSONB, default=dict)
    based_on_version: Mapped[int | None] = mapped_column(Integer)
    approved_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejected_reason: Mapped[str | None] = mapped_column(Text)


class OpportunityScore(UUIDPk, Base):
    """One computed score. History is every row; `is_current` marks the latest for a property."""

    __tablename__ = "opportunity_scores"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    score: Mapped[float] = mapped_column(Float, index=True)  # value score 0-100
    confidence: Mapped[float] = mapped_column(Float)  # certainty 0-1, kept separate from value
    adjusted_score: Mapped[float] = mapped_column(Float)  # score x confidence, for reference only
    band: Mapped[str] = mapped_column(String(10), index=True)
    components: Mapped[list] = mapped_column(JSONB, default=list)
    confidence_factors: Mapped[list] = mapped_column(JSONB, default=list)
    drivers: Mapped[dict] = mapped_column(JSONB, default=dict)
    eligibility: Mapped[list] = mapped_column(JSONB, default=list)
    config_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    config_version: Mapped[int] = mapped_column(Integer)
    needs_research: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    requires_human_approval: Mapped[bool] = mapped_column(Boolean, default=True)
    value_basis: Mapped[float | None] = mapped_column(Numeric(16, 2, asdecimal=False))
    signature: Mapped[str] = mapped_column(String(64))
    trigger: Mapped[str] = mapped_column(String(40), default="manual")
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    computed_by_id: Mapped[uuid.UUID | None] = fk("users", index=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class ScoreOutcome(Entity, Base):
    """Decision log used to measure and recalibrate the model: disposition, score at decision, result, time."""

    __tablename__ = "score_outcomes"

    property_id: Mapped[uuid.UUID] = fk("properties", nullable=False, ondelete="CASCADE")
    opportunity_id: Mapped[uuid.UUID | None] = fk("opportunities")
    disposition: Mapped[str] = mapped_column(String(40), index=True)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    score_at_decision: Mapped[float | None] = mapped_column(Float)
    confidence_at_decision: Mapped[float | None] = mapped_column(Float)
    band_at_decision: Mapped[str | None] = mapped_column(String(10))
    config_version: Mapped[int | None] = mapped_column(Integer)
    components_at_decision: Mapped[dict] = mapped_column(JSONB, default=dict)
    result: Mapped[str] = mapped_column(String(10), default="open", index=True)
    result_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    elapsed_days: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(10), default="event")  # event | manual
    notes: Mapped[str | None] = mapped_column(Text)
