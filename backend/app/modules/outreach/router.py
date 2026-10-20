import uuid
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.common.query import ListParams, Page, apply_search, apply_sort, facet_counts, in_filter, paginate
from app.core.deps import DB, CurrentUser, require
from app.core.security import utcnow
from app.modules.outreach import service
from app.modules.outreach.models import (
    CHANNELS,
    DIRECTIONS,
    DISPOSITIONS,
    ENROLLMENT_STATUSES,
    MEANINGFUL_CHANNELS,
    MEANINGFUL_DISPOSITIONS,
    SEQUENCE_STATUSES,
    Interaction,
    Sequence,
    SequenceEnrollment,
)
from app.modules.outreach.schemas import (
    ContextOut,
    EnrollIn,
    EnrollmentOut,
    EnrollResult,
    ExitIn,
    InteractionCreate,
    InteractionFacets,
    InteractionOut,
    InteractionUpdate,
    QueueOut,
    SequenceIn,
    SequenceOut,
    TeamActivityOut,
)

router = APIRouter(tags=["outreach"])

SORTS = {"occurred_at": Interaction.occurred_at, "channel": Interaction.channel,
         "disposition": Interaction.disposition, "next_action_at": Interaction.next_action_at}


class InteractionFilters:
    def __init__(
        self,
        q: str | None = Query(None, max_length=200),
        channel: list[str] | None = Query(None),
        direction: list[str] | None = Query(None),
        disposition: list[str] | None = Query(None),
        person_id: uuid.UUID | None = None,
        organization_id: uuid.UUID | None = None,
        property_id: uuid.UUID | None = None,
        opportunity_id: uuid.UUID | None = None,
        logged_by: list[str] | None = Query(None, description="User ids or 'me'"),
        date_from: date | None = None,
        date_to: date | None = None,
        meaningful: bool | None = None,
    ):
        start = datetime.combine(date_from, time.min, tzinfo=timezone.utc) if date_from else None
        end = datetime.combine(date_to, time.max, tzinfo=timezone.utc) if date_to else None
        self.kw = dict(q=q, channel=channel, direction=direction, disposition=disposition, person_id=person_id,
                       organization_id=organization_id, property_id=property_id, opportunity_id=opportunity_id,
                       logged_by=logged_by, date_from=start, date_to=end, meaningful=meaningful)


# --------------------------------------------------------------------------- interactions

@router.get("/interactions", response_model=Page[InteractionOut])
async def list_interactions(db: DB, params: ListParams = Depends(), f: InteractionFilters = Depends(),
                            user: CurrentUser = Depends(require("outreach", "view"))):
    stmt = apply_sort(service.interaction_query(actor_id=user.id, **f.kw), params.sort, SORTS,
                      Interaction.occurred_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[InteractionOut](items=await service.interaction_outs(db, items), total=total, page=params.page,
                page_size=params.page_size)


@router.get("/interactions/facets", response_model=InteractionFacets)
async def interaction_facets(db: DB, f: InteractionFilters = Depends(),
                             user: CurrentUser = Depends(require("outreach", "view"))):
    def q(skip: str):
        return service.interaction_query(actor_id=user.id, skip={skip}, **f.kw)

    return InteractionFacets(
        channel=await facet_counts(db, q("channel"), Interaction.channel),
        direction=await facet_counts(db, q("direction"), Interaction.direction),
        disposition=await facet_counts(db, q("disposition"), Interaction.disposition),
    )


@router.get("/interactions/meta")
async def interaction_meta(_: CurrentUser = Depends(require("outreach", "view"))):
    return {"channels": CHANNELS, "directions": DIRECTIONS, "dispositions": DISPOSITIONS,
            "meaningful_dispositions": sorted(MEANINGFUL_DISPOSITIONS), "meaningful_channels": sorted(MEANINGFUL_CHANNELS),
            "sequence_statuses": SEQUENCE_STATUSES, "enrollment_statuses": ENROLLMENT_STATUSES}


@router.post("/interactions", response_model=InteractionOut, status_code=201)
async def log_interaction(body: InteractionCreate, db: DB, user: CurrentUser = Depends(require("outreach", "create"))):
    """Logs a touchpoint. Outbound calls/texts/emails are checked against compliance first (422 with reasons)."""
    it = await service.log_interaction(db, body, user)
    return (await service.interaction_outs(db, [it]))[0]


@router.get("/interactions/{interaction_id}", response_model=InteractionOut)
async def get_interaction(interaction_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("outreach", "view"))):
    return (await service.interaction_outs(db, [await service.get_interaction(db, interaction_id)]))[0]


@router.patch("/interactions/{interaction_id}", response_model=InteractionOut)
async def update_interaction(interaction_id: uuid.UUID, body: InteractionUpdate, db: DB,
                             user: CurrentUser = Depends(require("outreach", "edit"))):
    it = await service.update_interaction(db, await service.get_interaction(db, interaction_id), body, user)
    return (await service.interaction_outs(db, [it]))[0]


@router.delete("/interactions/{interaction_id}", status_code=204)
async def archive_interaction(interaction_id: uuid.UUID, db: DB,
                              user: CurrentUser = Depends(require("outreach", "delete"))):
    await service.archive_interaction(db, await service.get_interaction(db, interaction_id), user)


# --------------------------------------------------------------------------- daily queue

@router.get("/queue", response_model=QueueOut)
async def daily_queue(db: DB, limit: int = Query(40, ge=5, le=100),
                      user: CurrentUser = Depends(require("outreach", "view"))):
    """The current user's capped, prioritized action list; each item explains why it is here."""
    return await service.build_queue(db, user.id, limit)


@router.get("/queue/context/{person_id}", response_model=ContextOut)
async def precall_context(person_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("outreach", "view"))):
    ctx = await service.person_context(db, person_id)
    await db.commit()  # compliance settings may be initialised lazily
    return ctx


@router.get("/outreach/team-activity", response_model=TeamActivityOut)
async def team_activity(
    db: DB, date_from: date | None = None, date_to: date | None = None, team_id: uuid.UUID | None = None,
    _: CurrentUser = Depends(require("outreach", "approve")),
):
    """Manager view: activity per user, overdue follow-ups and stale/untouched records."""
    end = datetime.combine(date_to, time.max, tzinfo=timezone.utc) if date_to else utcnow()
    start = datetime.combine(date_from, time.min, tzinfo=timezone.utc) if date_from else end - timedelta(days=7)
    return await service.team_activity(db, start, end, team_id)


# --------------------------------------------------------------------------- sequences

@router.get("/sequences", response_model=list[SequenceOut])
async def list_sequences(db: DB, q: str | None = None, status: list[str] | None = Query(None),
                         _: CurrentUser = Depends(require("outreach", "view"))):
    stmt = select(Sequence).where(Sequence.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [Sequence.name, Sequence.description])
    stmt = in_filter(stmt, Sequence.status, status)
    return await service.sequence_outs(db, list(await db.scalars(stmt.order_by(Sequence.name))))


@router.post("/sequences", response_model=SequenceOut, status_code=201)
async def create_sequence(body: SequenceIn, db: DB, user: CurrentUser = Depends(require("outreach", "create"))):
    return (await service.sequence_outs(db, [await service.save_sequence(db, None, body, user)]))[0]


@router.get("/sequences/{sequence_id}", response_model=SequenceOut)
async def get_sequence(sequence_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("outreach", "view"))):
    return (await service.sequence_outs(db, [await service.get_sequence(db, sequence_id)]))[0]


@router.patch("/sequences/{sequence_id}", response_model=SequenceOut)
async def update_sequence(sequence_id: uuid.UUID, body: SequenceIn, db: DB,
                          user: CurrentUser = Depends(require("outreach", "edit"))):
    s = await service.save_sequence(db, await service.get_sequence(db, sequence_id), body, user)
    return (await service.sequence_outs(db, [s]))[0]


@router.post("/sequences/{sequence_id}/enroll", response_model=EnrollResult)
async def enroll(sequence_id: uuid.UUID, body: EnrollIn, db: DB,
                 user: CurrentUser = Depends(require("outreach", "create"))):
    """Enrolls people, respecting the sequence's enrollment cap and each person's suppression state."""
    s = await service.get_sequence(db, sequence_id)
    return await service.enroll(db, s, body.person_ids, body.owner_id, user)


@router.get("/sequence-enrollments", response_model=Page[EnrollmentOut])
async def list_enrollments(
    db: DB, params: ListParams = Depends(), sequence_id: uuid.UUID | None = None, person_id: uuid.UUID | None = None,
    status: list[str] | None = Query(None), _: CurrentUser = Depends(require("outreach", "view")),
):
    stmt = select(SequenceEnrollment).where(SequenceEnrollment.deleted_at.is_(None))
    if sequence_id:
        stmt = stmt.where(SequenceEnrollment.sequence_id == sequence_id)
    if person_id:
        stmt = stmt.where(SequenceEnrollment.person_id == person_id)
    stmt = in_filter(stmt, SequenceEnrollment.status, status)
    sorts = {"enrolled_at": SequenceEnrollment.enrolled_at, "next_step_at": SequenceEnrollment.next_step_at,
             "status": SequenceEnrollment.status}
    items, total = await paginate(db, apply_sort(stmt, params.sort, sorts, SequenceEnrollment.enrolled_at.desc()),
                                  params)
    return Page[EnrollmentOut](items=await service.enrollment_outs(db, items), total=total, page=params.page,
                page_size=params.page_size)


@router.post("/sequence-enrollments/{enrollment_id}/exit", response_model=EnrollmentOut)
async def exit_enrollment(enrollment_id: uuid.UUID, body: ExitIn, db: DB,
                          user: CurrentUser = Depends(require("outreach", "edit"))):
    e = await service.exit_enrollment(db, await service.get_enrollment(db, enrollment_id), body.reason, user)
    return (await service.enrollment_outs(db, [e]))[0]


@router.post("/sequence-enrollments/{enrollment_id}/advance", response_model=EnrollmentOut)
async def advance_enrollment(enrollment_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("outreach", "edit"))):
    """Marks the current step done (without logging an interaction) and schedules the next one."""
    e = await service.advance_enrollment(db, await service.get_enrollment(db, enrollment_id), user)
    return (await service.enrollment_outs(db, [e]))[0]

