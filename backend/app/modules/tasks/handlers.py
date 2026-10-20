from sqlalchemy import update

from app.core import events
from app.modules.tasks.models import Alert, AlertSubscription, Task


@events.on("user.deactivated")
async def reassign_work(db, user_id=None, reassign_to_id=None, **_):
    """Open work never sits with a deactivated user: tasks/alerts move to the successor, subscriptions stop."""
    if not user_id:
        return
    await db.execute(
        update(AlertSubscription).where(AlertSubscription.subscriber_id == user_id).values(is_active=False)
    )
    if not reassign_to_id:
        return
    await db.execute(
        update(Task)
        .where(Task.assignee_id == user_id, Task.status.in_(["open", "in_progress"]), Task.deleted_at.is_(None))
        .values(assignee_id=reassign_to_id)
    )
    await db.execute(
        update(Alert)
        .where(Alert.owner_id == user_id, Alert.status != "resolved", Alert.deleted_at.is_(None))
        .values(owner_id=reassign_to_id)
    )
