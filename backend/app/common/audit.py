import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.common.models import UUIDPk
from app.core.database import Base
from app.core.security import utcnow


class AuditEvent(UUIDPk, Base):
    """Immutable audit trail. There is intentionally no update/delete path for this table."""

    __tablename__ = "audit_events"

    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    actor_name: Mapped[str | None] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(80), index=True)
    entity_type: Mapped[str] = mapped_column(String(60), index=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    summary: Mapped[str | None] = mapped_column(Text)
    changes: Mapped[dict | None] = mapped_column(JSONB)
    ip_address: Mapped[str | None] = mapped_column(String(64))


def to_jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    return value


def diff(obj: Any, data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Compute {field: {from, to}} for fields in `data` that differ from `obj`."""
    changes: dict[str, dict[str, Any]] = {}
    for field, new in data.items():
        old = getattr(obj, field, None)
        if old != new:
            changes[field] = {"from": to_jsonable(old), "to": to_jsonable(new)}
    return changes


async def record(
    db: AsyncSession,
    *,
    actor: Any,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | None = None,
    summary: str | None = None,
    changes: dict | None = None,
    ip_address: str | None = None,
) -> AuditEvent:
    event = AuditEvent(
        actor_id=getattr(actor, "id", None),
        actor_name=getattr(actor, "full_name", None),
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary,
        changes=to_jsonable(changes) if changes else None,
        ip_address=ip_address,
    )
    db.add(event)
    return event
