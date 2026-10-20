import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.maintenance.models import Inspection, PMSchedule, WorkOrder


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if not reassign_to_id:
        return
    await db.execute(
        update(WorkOrder)
        .where(WorkOrder.assigned_user_id == user_id, WorkOrder.deleted_at.is_(None),
               WorkOrder.status.in_(["open", "assigned", "in_progress"]))
        .values(assigned_user_id=reassign_to_id)
    )
    await db.execute(
        update(PMSchedule).where(PMSchedule.default_assignee_id == user_id, PMSchedule.deleted_at.is_(None))
        .values(default_assignee_id=reassign_to_id)
    )
    await db.execute(
        update(Inspection)
        .where(Inspection.inspector_id == user_id, Inspection.deleted_at.is_(None),
               Inspection.status.in_(["scheduled", "in_progress"]))
        .values(inspector_id=reassign_to_id)
    )
