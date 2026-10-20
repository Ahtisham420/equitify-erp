from sqlalchemy import update

from app.core import events
from app.modules.comps.models import CompSet


@events.on("user.deactivated")
async def reassign_comp_sets(db, user_id=None, reassign_to_id=None, **_):
    """Hand open comp sets to the replacement owner. Analyst/verifier attribution on history is never rewritten."""
    if user_id and reassign_to_id:
        await db.execute(
            update(CompSet).where(CompSet.owner_id == user_id, CompSet.deleted_at.is_(None)).values(owner_id=reassign_to_id)
        )
