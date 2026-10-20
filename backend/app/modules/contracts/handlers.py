import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.contracts.models import Contract, CriticalDate, DDItem, RiskItem, ThirdPartyReport


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    """Accountable owners must never point at an inactive user."""
    if not reassign_to_id:
        return
    for model in (Contract, CriticalDate, DDItem, RiskItem, ThirdPartyReport):
        await db.execute(
            update(model).where(model.owner_id == user_id, model.deleted_at.is_(None)).values(owner_id=reassign_to_id)
        )
