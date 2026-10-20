import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.closing import service


@events.on("opportunity.stage_changed")
async def on_stage_changed(db: AsyncSession, opportunity_id: uuid.UUID | None = None, to_stage: str | None = None,
                           actor=None, **_):
    """Reaching the closing stage opens the closing workspace (idempotent; runs in the caller's transaction)."""
    if opportunity_id and to_stage == "closing":
        await service.ensure_closing(db, opportunity_id, actor)


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID | None = None,
                              reassign_to_id: uuid.UUID | None = None, **_):
    if user_id:
        await service.reassign_user(db, user_id, reassign_to_id)
