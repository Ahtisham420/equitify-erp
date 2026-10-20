import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.signals.models import SignalSubscription


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, **_):
    # Subscriptions are personal: a deactivated user stops receiving signal alerts.
    await db.execute(
        update(SignalSubscription)
        .where(SignalSubscription.subscriber_id == user_id, SignalSubscription.is_active.is_(True))
        .values(is_active=False)
    )
