import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.debt.models import LenderReportingObligation, Loan


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if not reassign_to_id:
        return
    await db.execute(update(Loan).where(Loan.owner_id == user_id, Loan.deleted_at.is_(None)).values(owner_id=reassign_to_id))
    await db.execute(update(LenderReportingObligation)
                     .where(LenderReportingObligation.owner_id == user_id, LenderReportingObligation.deleted_at.is_(None))
                     .values(owner_id=reassign_to_id))


@events.on("asset.created")
async def on_asset_created(db: AsyncSession, asset_id: uuid.UUID, property_id: uuid.UUID | None = None, **_):
    """Loans recorded while a property was being pursued attach to the new asset automatically."""
    if property_id:
        await db.execute(update(Loan).where(Loan.property_id == property_id, Loan.asset_id.is_(None),
                                            Loan.deleted_at.is_(None)).values(asset_id=asset_id))
