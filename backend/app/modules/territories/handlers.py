"""Keep rule-based territory membership current and reassign territories of departing users.

Handlers run inside the caller's transaction and never commit."""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.territories import service


@events.on("property.created")
async def on_property_created(db: AsyncSession, property_id: uuid.UUID, **_):
    await service.evaluate_property(db, property_id)


@events.on("property.updated")
async def on_property_updated(db: AsyncSession, property_id: uuid.UUID, changed: set[str] | None = None, **_):
    await service.evaluate_property(db, property_id, set(changed) if changed is not None else None)


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    await service.reassign_owner(db, user_id, reassign_to_id)
