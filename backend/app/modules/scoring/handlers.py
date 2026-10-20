"""Scoring automations: rescore when the facts behind a score change; log outcomes at decisions."""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.scoring import service


async def _signal_properties(db: AsyncSession, property_id, owner_kind, owner_id) -> list[uuid.UUID]:
    pids = [property_id] if property_id else []
    if owner_kind and owner_id:
        try:
            from app.modules.signals.service import owned_properties
        except ImportError:
            return pids
        pids += [p for p in await owned_properties(db, owner_kind, owner_id) if p not in pids]
    return pids[:50]


@events.on("property.created")
async def on_property_created(db: AsyncSession, property_id: uuid.UUID, actor=None, **_):
    await service.rescore_property(db, property_id, actor, trigger="property_created")


@events.on("property.updated")
async def on_property_updated(db: AsyncSession, property_id: uuid.UUID, actor=None, **_):
    # Runs after the buy box handler re-evaluates, so eligibility reflects the change.
    await service.rescore_property(db, property_id, actor, trigger="property_updated")


@events.on("ownership.changed")
async def on_ownership_changed(db: AsyncSession, property_id: uuid.UUID, actor=None, **_):
    await service.rescore_property(db, property_id, actor, trigger="ownership_changed")


@events.on("signal.created")
async def on_signal_created(db: AsyncSession, property_id=None, owner_kind=None, owner_id=None, actor=None, **_):
    for pid in await _signal_properties(db, property_id, owner_kind, owner_id):
        await service.rescore_property(db, pid, actor, trigger="signal_created")


@events.on("signal.updated")
async def on_signal_updated(db: AsyncSession, property_id=None, owner_kind=None, owner_id=None, actor=None, **_):
    for pid in await _signal_properties(db, property_id, owner_kind, owner_id):
        await service.rescore_property(db, pid, actor, trigger="signal_updated")


@events.on("interaction.logged")
async def on_interaction_logged(db: AsyncSession, property_id=None, opportunity_id=None, actor=None, **_):
    pid = property_id
    if pid is None and opportunity_id:
        from app.modules.pipeline.models import Opportunity

        o = await db.get(Opportunity, opportunity_id)
        pid = o.property_id if o else None
    if pid:
        await service.rescore_property(db, pid, actor, trigger="interaction_logged")


@events.on("opportunity.stage_changed")
async def on_stage_changed(db: AsyncSession, opportunity_id: uuid.UUID, to_stage: str | None = None, actor=None, **_):
    from app.modules.pipeline.models import Opportunity

    o = await db.get(Opportunity, opportunity_id)
    if not o or not o.property_id:
        return
    # Log first so the outcome captures the score the decision was made on, then rescore.
    if to_stage == "dead":
        await service.log_outcome(db, property_id=o.property_id, opportunity_id=o.id, disposition="dead",
                                  result="lost", actor=actor, notes=(o.dead_reason or "").replace("_", " ") or None)
    elif to_stage in service.PURSUE_STAGES or to_stage == "nurture":
        await service.log_outcome(db, property_id=o.property_id, opportunity_id=o.id, disposition=to_stage,
                                  result="open", actor=actor)
    elif to_stage == "closed":
        await service.log_outcome(db, property_id=o.property_id, opportunity_id=o.id, disposition="closed",
                                  result="won", actor=actor)
    await service.rescore_property(db, o.property_id, actor, trigger="stage_changed")


@events.on("opportunity.dead")
async def on_opportunity_dead(db: AsyncSession, opportunity_id: uuid.UUID, actor=None, **_):
    from app.modules.pipeline.models import Opportunity

    o = await db.get(Opportunity, opportunity_id)
    if not o or not o.property_id:
        return
    await service.log_outcome(db, property_id=o.property_id, opportunity_id=o.id, disposition="dead", result="lost",
                              actor=actor, notes=(o.dead_reason or "").replace("_", " ") or None)


@events.on("closing.completed")
async def on_closing_completed(db: AsyncSession, opportunity_id: uuid.UUID | None = None,
                               property_id: uuid.UUID | None = None, actor=None, **_):
    pid = property_id
    if opportunity_id and pid is None:
        from app.modules.pipeline.models import Opportunity

        o = await db.get(Opportunity, opportunity_id)
        pid = o.property_id if o else None
    if pid:
        await service.log_outcome(db, property_id=pid, opportunity_id=opportunity_id, disposition="closed",
                                  result="won", actor=actor)
