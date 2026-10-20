"""Field-level provenance and history for material facts.

Every material value change writes a FieldObservation (source, observed date, confidence,
verification state, AI flag). The previous observation is kept and marked non-current, so
history is never overwritten. AI-derived values stay AI-derived until a named human verifies.
"""
import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, String, select, update
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.common.audit import to_jsonable
from app.common.models import UUIDPk
from app.core.database import Base
from app.core.security import utcnow

Verification = Literal["unverified", "verified", "rejected"]


class FieldObservation(UUIDPk, Base):
    __tablename__ = "field_observations"

    entity_type: Mapped[str] = mapped_column(String(60), index=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    field: Mapped[str] = mapped_column(String(80), index=True)
    value: Mapped[Any] = mapped_column(JSONB)
    source: Mapped[str] = mapped_column(String(200))
    observed_on: Mapped[date | None] = mapped_column(Date)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    verification: Mapped[str] = mapped_column(String(20), default="unverified", index=True)
    ai_derived: Mapped[bool] = mapped_column(Boolean, default=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    recorded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    verified_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProvenanceIn(BaseModel):
    """Provenance block that accompanies a material-field write."""

    source: str = Field(default="Manual entry", max_length=200)
    observed_on: date | None = None
    confidence: float = Field(default=0.8, ge=0, le=1)
    verified: bool = False
    ai_derived: bool = False


class ObservationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    field: str
    value: Any
    source: str
    observed_on: date | None
    confidence: float
    verification: str
    ai_derived: bool
    is_current: bool
    recorded_at: datetime
    recorded_by_id: uuid.UUID | None
    verified_by_id: uuid.UUID | None
    verified_at: datetime | None


async def observe(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: uuid.UUID,
    field: str,
    value: Any,
    prov: ProvenanceIn,
    actor_id: uuid.UUID | None,
) -> FieldObservation:
    await db.execute(
        update(FieldObservation)
        .where(
            FieldObservation.entity_type == entity_type,
            FieldObservation.entity_id == entity_id,
            FieldObservation.field == field,
            FieldObservation.is_current.is_(True),
        )
        .values(is_current=False)
    )
    # AI output can never land as verified without a human verification step.
    verified = prov.verified and not prov.ai_derived
    obs = FieldObservation(
        entity_type=entity_type,
        entity_id=entity_id,
        field=field,
        value=to_jsonable(value),
        source=prov.source,
        observed_on=prov.observed_on or date.today(),
        confidence=prov.confidence,
        verification="verified" if verified else "unverified",
        ai_derived=prov.ai_derived,
        recorded_by_id=actor_id,
        verified_by_id=actor_id if verified else None,
        verified_at=utcnow() if verified else None,
    )
    db.add(obs)
    return obs


async def apply_material(
    db: AsyncSession,
    obj: Any,
    *,
    entity_type: str,
    data: dict[str, Any],
    material_fields: set[str],
    prov: ProvenanceIn,
    actor_id: uuid.UUID | None,
) -> dict[str, dict[str, Any]]:
    """Set attributes on `obj`; changed material fields get an observation. Returns the diff."""
    changes: dict[str, dict[str, Any]] = {}
    for field, new in data.items():
        old = getattr(obj, field, None)
        if old == new:
            continue
        changes[field] = {"from": to_jsonable(old), "to": to_jsonable(new)}
        setattr(obj, field, new)
        if field in material_fields and new is not None:
            await observe(
                db, entity_type=entity_type, entity_id=obj.id, field=field, value=new, prov=prov, actor_id=actor_id
            )
    return changes


async def current_observations(db: AsyncSession, entity_type: str, entity_id: uuid.UUID) -> dict[str, FieldObservation]:
    rows = await db.scalars(
        select(FieldObservation).where(
            FieldObservation.entity_type == entity_type,
            FieldObservation.entity_id == entity_id,
            FieldObservation.is_current.is_(True),
        )
    )
    return {o.field: o for o in rows}


async def history(
    db: AsyncSession, entity_type: str, entity_id: uuid.UUID, field: str | None = None
) -> list[FieldObservation]:
    stmt = select(FieldObservation).where(
        FieldObservation.entity_type == entity_type, FieldObservation.entity_id == entity_id
    )
    if field:
        stmt = stmt.where(FieldObservation.field == field)
    return list(await db.scalars(stmt.order_by(FieldObservation.recorded_at.desc())))


async def set_verification(
    db: AsyncSession, obs_id: uuid.UUID, state: Verification, actor_id: uuid.UUID
) -> FieldObservation | None:
    obs = await db.get(FieldObservation, obs_id)
    if not obs:
        return None
    obs.verification = state
    obs.verified_by_id = actor_id
    obs.verified_at = utcnow()
    return obs
