from sqlalchemy import update

from app.core import events
from app.modules.investors.models import CapitalPartner


@events.on("user.deactivated")
async def on_user_deactivated(db, user_id=None, reassign_to_id=None, **_):
    """Relationship ownership moves to the successor. Portal links are left intact (access is
    already blocked for deactivated users) so the partner's history stays attributable."""
    if user_id and reassign_to_id:
        await db.execute(
            update(CapitalPartner)
            .where(CapitalPartner.owner_id == user_id, CapitalPartner.deleted_at.is_(None))
            .values(owner_id=reassign_to_id)
        )
