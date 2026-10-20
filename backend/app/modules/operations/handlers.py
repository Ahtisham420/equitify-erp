import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.operations.models import CapitalProject


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if reassign_to_id:
        await db.execute(
            update(CapitalProject)
            .where(CapitalProject.manager_id == user_id, CapitalProject.deleted_at.is_(None),
                   CapitalProject.status.not_in(["closed", "cancelled"]))
            .values(manager_id=reassign_to_id)
        )
