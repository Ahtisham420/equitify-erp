import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.pipeline.models import Opportunity


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if reassign_to_id:
        await db.execute(
            update(Opportunity)
            .where(Opportunity.owner_id == user_id, Opportunity.deleted_at.is_(None))
            .values(owner_id=reassign_to_id)
        )
