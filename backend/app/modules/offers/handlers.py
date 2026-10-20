import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.offers import service


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID | None = None,
                              reassign_to_id: uuid.UUID | None = None, **_):
    if user_id:
        await service.reassign_user(db, user_id, reassign_to_id)
