"""Reactivation automations: arm triggers at dead disposition; evaluate them when related facts change."""
import uuid

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.modules.reactivation import service
from app.modules.reactivation.models import ReactivationItem

SIGNAL_TYPES = {"debt", "lease", "market", "development", "ownership", "price"}


@events.on("opportunity.dead")
async def on_opportunity_dead(db: AsyncSession, opportunity_id: uuid.UUID, actor=None, **_):
    from app.modules.pipeline.models import Opportunity

    o = await db.get(Opportunity, opportunity_id)
    if o and o.stage == "dead":
        await service.arm_from_opportunity(db, o, actor)


@events.on("opportunity.stage_changed")
async def on_stage_changed(db: AsyncSession, opportunity_id: uuid.UUID, from_stage: str | None = None,
                           to_stage: str | None = None, actor=None, **_):
    if from_stage == "dead" and to_stage and to_stage != "dead":
        await service.on_left_dead(db, opportunity_id, to_stage, actor)
    if to_stage in service.CONVERTED_STAGES:
        await service.mark_converted(db, opportunity_id)


@events.on("closing.completed")
async def on_closing_completed(db: AsyncSession, opportunity_id: uuid.UUID | None = None, **_):
    if opportunity_id:
        await service.mark_converted(db, opportunity_id)


@events.on("property.updated")
async def on_property_updated(db: AsyncSession, property_id: uuid.UUID, actor=None, **_):
    await service.check_property(db, property_id, types={"price", "manual"}, actor=actor)


@events.on("ownership.changed")
async def on_ownership_changed(db: AsyncSession, property_id: uuid.UUID, actor=None, **_):
    await service.check_property(db, property_id, types={"ownership", "relationship"}, actor=actor)


@events.on("signal.created")
async def on_signal_created(db: AsyncSession, property_id=None, owner_kind=None, owner_id=None, actor=None, **_):
    pids = [property_id] if property_id else []
    if owner_kind and owner_id:
        try:
            from app.modules.signals.service import owned_properties

            pids += [p for p in await owned_properties(db, owner_kind, owner_id) if p not in pids]
        except ImportError:
            pass
    for pid in pids[:50]:
        await service.check_property(db, pid, types=SIGNAL_TYPES, actor=actor)


@events.on("interaction.logged")
async def on_interaction_logged(db: AsyncSession, person_id=None, organization_id=None, property_id=None,
                                opportunity_id=None, disposition=None, direction=None, meaningful=False,
                                actor=None, **_):
    if disposition not in service.POSITIVE_DISPOSITIONS and not (direction == "inbound" and meaningful):
        return
    from app.modules.pipeline.models import Opportunity

    conds = []
    if opportunity_id:
        conds.append(Opportunity.id == opportunity_id)
    if property_id:
        conds.append(Opportunity.property_id == property_id)
    if person_id:
        conds.append(Opportunity.primary_person_id == person_id)
    if organization_id:
        conds.append(Opportunity.primary_organization_id == organization_id)
    ids = list(await db.scalars(select(Opportunity.id).where(Opportunity.stage == "dead", or_(*conds)))) if conds else []
    # Owners of a dead deal's property count as a warm path too (checked against the trigger baseline).
    if person_id or organization_id:
        from app.modules.reactivation.models import ReactivationTrigger

        key = f"person:{person_id}" if person_id else f"organization:{organization_id}"
        ids += [i for i in await db.scalars(select(ReactivationTrigger.opportunity_id).where(
            ReactivationTrigger.status == "armed", ReactivationTrigger.trigger_type == "relationship",
            ReactivationTrigger.baseline["owners"].contains([key]))) if i not in ids]
    await service.check_opportunities(db, ids, types={"relationship"}, actor=actor)


@events.on("loan.maturity_window")
async def on_loan_maturity_window(db: AsyncSession, property_id: uuid.UUID | None = None, actor=None, **_):
    await service.check_property(db, property_id, types={"debt"}, actor=actor)


@events.on("user.deactivated")
async def on_user_deactivated(db: AsyncSession, user_id: uuid.UUID, reassign_to_id: uuid.UUID | None = None, **_):
    if reassign_to_id:
        await db.execute(update(ReactivationItem).where(
            ReactivationItem.owner_id == user_id, ReactivationItem.status.in_(["pending", "snoozed"]))
            .values(owner_id=reassign_to_id))
