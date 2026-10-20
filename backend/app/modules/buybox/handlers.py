"""Buy box automations: evaluate new properties and re-evaluate when referenced facts change."""
import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.buybox import service
from app.modules.buybox.models import BuyBox


def _actor_id(actor) -> uuid.UUID | None:
    return getattr(actor, "id", None)


@events.on("property.created")
async def on_property_created(db: AsyncSession, property_id: uuid.UUID, actor=None, **_):
    await service.evaluate_property(db, property_id, trigger="property_created", actor_id=_actor_id(actor))


@events.on("property.updated")
async def on_property_updated(db: AsyncSession, property_id: uuid.UUID, changed=None, actor=None, **_):
    # Only boxes whose criteria reference a changed field are re-evaluated (see evaluate_property).
    await service.evaluate_property(db, property_id, trigger="property_updated", actor_id=_actor_id(actor),
                                    changed=set(changed or ()))


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if reassign_to_id:
        await db.execute(update(BuyBox).where(BuyBox.owner_id == user_id).values(owner_id=reassign_to_id))
