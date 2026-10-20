import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.dispositions.models import TERMINAL, Disposition


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if reassign_to_id:
        await db.execute(update(Disposition)
                         .where(Disposition.owner_id == user_id, Disposition.deleted_at.is_(None),
                                Disposition.stage.not_in(TERMINAL))
                         .values(owner_id=reassign_to_id))
