import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.dealroom.service import reassign_user


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if reassign_to_id:
        await reassign_user(db, user_id, reassign_to_id)
