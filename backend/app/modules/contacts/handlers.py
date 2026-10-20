import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.contacts.models import Organization, Person


@events.on("user.deactivated")
async def reassign_contact_owners(db: AsyncSession, user_id: uuid.UUID | None = None,
                                  reassign_to_id: uuid.UUID | None = None, **_):
    if not user_id or not reassign_to_id:
        return
    for model in (Person, Organization):
        await db.execute(update(model).where(model.owner_id == user_id).values(owner_id=reassign_to_id))
