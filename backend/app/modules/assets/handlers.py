import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.assets.models import Asset, AssetMilestone, VarianceExplanation


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if not reassign_to_id:
        return
    await db.execute(update(Asset).where(Asset.manager_id == user_id, Asset.deleted_at.is_(None))
                     .values(manager_id=reassign_to_id))
    await db.execute(update(AssetMilestone)
                     .where(AssetMilestone.owner_id == user_id, AssetMilestone.status.in_(["planned", "in_progress"]))
                     .values(owner_id=reassign_to_id))
    await db.execute(update(VarianceExplanation)
                     .where(VarianceExplanation.owner_id == user_id,
                            VarianceExplanation.status.in_(["required", "rejected"]))
                     .values(owner_id=reassign_to_id))
