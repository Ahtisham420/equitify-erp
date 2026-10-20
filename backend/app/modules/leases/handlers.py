import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.leases.models import Lease


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if reassign_to_id:
        await db.execute(
            update(Lease).where(Lease.manager_id == user_id, Lease.deleted_at.is_(None)).values(manager_id=reassign_to_id)
        )


@events.on("closing.completed")
async def on_closing_completed(db: AsyncSession, property_id: uuid.UUID | None = None,
                               asset_id: uuid.UUID | None = None, **_):
    """Leases on an acquired property roll up to the new asset."""
    if property_id and asset_id:
        await db.execute(
            update(Lease)
            .where(Lease.property_id == property_id, Lease.asset_id.is_(None), Lease.deleted_at.is_(None))
            .values(asset_id=asset_id)
        )
