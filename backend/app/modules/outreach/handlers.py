from sqlalchemy import update

from app.core import events
from app.modules.outreach.models import Sequence, SequenceEnrollment


@events.on("user.deactivated")
async def reassign_outreach(db, user_id=None, reassign_to_id=None, **_):
    """Active sequence work follows the successor so queued steps are not orphaned."""
    if not user_id or not reassign_to_id:
        return
    await db.execute(
        update(SequenceEnrollment)
        .where(SequenceEnrollment.owner_id == user_id, SequenceEnrollment.status.in_(["active", "paused"]))
        .values(owner_id=reassign_to_id)
    )
    await db.execute(update(Sequence).where(Sequence.owner_id == user_id).values(owner_id=reassign_to_id))
