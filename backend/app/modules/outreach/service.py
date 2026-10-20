import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.query import apply_search, in_filter
from app.core import events
from app.core.database import Base
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.compliance import service as compliance
from app.modules.outreach.models import (
    COMPLIANCE_CHANNEL,
    EXIT_DISPOSITIONS,
    MEANINGFUL_CHANNELS,
    MEANINGFUL_DISPOSITIONS,
    Interaction,
    Sequence,
    SequenceEnrollment,
)
from app.modules.outreach.schemas import EnrollmentOut, InteractionOut, SequenceOut
from app.modules.tasks.models import Task
from app.modules.tasks.service import create_task, day_bounds, record_rule_run, rule_config, user_names

OPEN_TASK = ("open", "in_progress")
STALLED_STAGES = ("negotiation", "offer")


def _label(value: str | None) -> str:
    return (value or "").replace("_", " ")


def _aware(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _table(name: str):
    """Core table from shared metadata — used for cross-module reads where only the table contract is known."""
    return Base.metadata.tables.get(name)


# --------------------------------------------------------------------------- record labels (guarded)

def _person_name(p) -> str:
    return getattr(p, "full_name", None) or " ".join(
        x for x in [getattr(p, "first_name", None), getattr(p, "last_name", None)] if x) or "Unnamed contact"


async def person_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    try:
        from app.modules.contacts.models import Person
    except ImportError:
        return {}
    return {p.id: _person_name(p) for p in await db.scalars(select(Person).where(Person.id.in_(ids)))}


async def _org_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    t = _table("organizations")
    if not ids or t is None:
        return {}
    return {r[0]: r[1] for r in (await db.execute(select(t.c.id, t.c.name).where(t.c.id.in_(ids)))).all()}


async def _property_labels(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    from app.modules.properties.models import Property

    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(Property.id, Property.name, Property.address_line).where(Property.id.in_(ids)))
    return {r[0]: r[1] or r[2] for r in rows.all()}


async def _opportunity_titles(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    t = _table("opportunities")
    if not ids or t is None:
        return {}
    return {r[0]: r[1] for r in (await db.execute(select(t.c.id, t.c.title).where(t.c.id.in_(ids)))).all()}


async def interaction_outs(db: AsyncSession, rows: list[Interaction]) -> list[InteractionOut]:
    people = await person_names(db, [r.person_id for r in rows])
    orgs = await _org_names(db, [r.organization_id for r in rows])
    props = await _property_labels(db, [r.property_id for r in rows])
    opps = await _opportunity_titles(db, [r.opportunity_id for r in rows])
    users = await user_names(db, [r.logged_by_id for r in rows])
    out = []
    for r in rows:
        o = InteractionOut.model_validate(r)
        o.person_name = people.get(r.person_id)
        o.organization_name = orgs.get(r.organization_id)
        o.property_label = props.get(r.property_id)
        o.opportunity_title = opps.get(r.opportunity_id)
        o.logged_by_name = users.get(r.logged_by_id)
        out.append(o)
    return out


async def _primary_related(db: AsyncSession, it: Interaction) -> tuple[str | None, uuid.UUID | None, str | None]:
    if it.opportunity_id:
        return "opportunity", it.opportunity_id, (await _opportunity_titles(db, [it.opportunity_id])).get(it.opportunity_id)
    if it.person_id:
        return "person", it.person_id, (await person_names(db, [it.person_id])).get(it.person_id)
    if it.organization_id:
        return "organization", it.organization_id, (await _org_names(db, [it.organization_id])).get(it.organization_id)
    if it.property_id:
        return "property", it.property_id, (await _property_labels(db, [it.property_id])).get(it.property_id)
    return None, None, None


# --------------------------------------------------------------------------- interaction rules

def is_meaningful(channel: str, disposition: str | None) -> bool:
    return channel in MEANINGFUL_CHANNELS or disposition in MEANINGFUL_DISPOSITIONS


def check_loop(meaningful: bool, next_action: str | None, next_action_at: datetime | None, loop_closed: bool,
               closed_reason: str | None) -> None:
    """No meaningful interaction may remain without a next action or an explicit closure."""
    has_action = bool((next_action or "").strip())
    if next_action_at and not has_action:
        raise HTTPException(422, "Describe the next action for the chosen date")
    if has_action and not next_action_at:
        raise HTTPException(422, "Choose a date for the next action")
    if loop_closed and not (closed_reason or "").strip():
        raise HTTPException(422, "Give a reason for closing the loop")
    if meaningful and not has_action and not loop_closed:
        raise HTTPException(422, {
            "message": "A meaningful conversation needs a next action with a date, or an explicit loop closure "
                       "with a reason",
            "code": "next_action_required",
        })


async def _resolve_contact_value(db: AsyncSession, channel: str, contact_value: str | None,
                                 contact_point_id: uuid.UUID | None, person_id: uuid.UUID | None) -> str | None:
    if contact_value and contact_value.strip():
        return contact_value.strip()
    try:
        from app.modules.contacts.models import ContactPoint, Person
    except ImportError:
        return None
    if contact_point_id:
        cp = await db.get(ContactPoint, contact_point_id)
        if cp is not None and cp.value:
            return cp.value
    if person_id:
        p = await db.get(Person, person_id)
        if p is not None:
            return p.primary_email if channel == "email" else p.primary_phone
    return None


async def _invalidate_contact_point(db: AsyncSession, it: Interaction, actor) -> None:
    try:
        from app.modules.contacts.models import ContactPoint
    except ImportError:
        return
    cp = await db.get(ContactPoint, it.contact_point_id) if it.contact_point_id else None
    if cp is None and it.person_id and it.contact_value:
        norm = compliance.normalize_value("phone", it.contact_value)
        rows = await db.scalars(select(ContactPoint).where(ContactPoint.person_id == it.person_id,
                                                           ContactPoint.kind == "phone"))
        cp = next((r for r in rows if compliance.normalize_value("phone", r.value) == norm), None)
    if cp is None:
        return
    # Mark invalid through whichever validity fields the contacts module exposes.
    for attr, val in (("is_valid", False), ("status", "invalid"), ("invalid_reason", "Wrong number"),
                      ("invalid_at", utcnow()), ("is_primary", False)):
        if hasattr(cp, attr):
            setattr(cp, attr, val)
    if hasattr(cp, "updated_by_id"):
        cp.updated_by_id = actor.id
    if cp.person_id:
        await audit.record(db, actor=actor, action="person.contact_point_invalidated", entity_type="person",
                           entity_id=cp.person_id, summary=f"{cp.value} marked as wrong number",
                           ip_address=actor.ip_address)


async def _apply_disposition_effects(db: AsyncSession, it: Interaction, actor) -> None:
    if it.disposition == "wrong_number" and it.contact_value and it.channel in ("call", "sms"):
        await _invalidate_contact_point(db, it, actor)
        await compliance.suppress_value(db, channel="phone", value=it.contact_value, actor=actor,
                                        reason="Wrong number reported on outreach", source="outreach")
    elif it.disposition == "not_interested" and it.person_id:
        settings = await compliance.get_settings(db)
        days = settings.not_interested_suppression_days or 0
        if days > 0:
            until = it.occurred_at + timedelta(days=days)
            for kind, value, _label_ in await compliance.person_contact_values(db, it.person_id):
                await compliance.suppress_value(
                    db, channel="email" if kind == "email" else "phone", value=value, actor=actor,
                    person_id=it.person_id, until=until, source="outreach",
                    reason=f"Not interested (logged {it.occurred_at:%b %d, %Y}); suppressed for {days} days")


async def _touch_person(db: AsyncSession, it: Interaction) -> None:
    if not it.person_id:
        return
    try:
        from app.modules.contacts.models import Person
    except ImportError:
        return
    p = await db.get(Person, it.person_id)
    if p is None:
        return
    if it.channel != "note" and it.direction != "internal":
        if not p.last_touch_at or p.last_touch_at < it.occurred_at:
            p.last_touch_at = it.occurred_at
    if it.next_action_at and not it.loop_closed:
        p.next_action_at = it.next_action_at
    elif it.loop_closed and it.is_meaningful:
        p.next_action_at = None


async def exit_enrollments(db: AsyncSession, person_id: uuid.UUID, reason: str, *, disposition: str | None = None,
                           inbound: bool = False, force: bool = False) -> int:
    """Automatic sequence exit on reply, on a conversation disposition, or forced (opt-out). Does not commit."""
    rows = (await db.execute(
        select(SequenceEnrollment, Sequence).join(Sequence, Sequence.id == SequenceEnrollment.sequence_id)
        .where(SequenceEnrollment.person_id == person_id, SequenceEnrollment.status.in_(["active", "paused"]),
               SequenceEnrollment.deleted_at.is_(None))
    )).all()
    n = 0
    now = utcnow()
    for e, s in rows:
        if force or inbound or (disposition and (disposition in EXIT_DISPOSITIONS
                                                 or disposition in (s.exit_dispositions or []))):
            e.status, e.exited_at, e.exit_reason, e.next_step_at = "exited", now, reason[:200], None
            n += 1
    return n


def _advance(e: SequenceEnrollment, s: Sequence, now: datetime) -> None:
    steps = s.steps or []
    e.current_step = (e.current_step or 0) + 1
    e.last_step_at = now
    if e.current_step >= len(steps):
        e.status, e.next_step_at, e.exited_at, e.exit_reason = "completed", None, now, "Completed all steps"
    else:
        e.next_step_at = now + timedelta(days=int(steps[e.current_step].get("delay_days", 0) or 0))


# --------------------------------------------------------------------------- log / update interactions

async def log_interaction(db: AsyncSession, data, actor) -> Interaction:
    data.occurred_at, data.next_action_at = _aware(data.occurred_at), _aware(data.next_action_at)
    meaningful = is_meaningful(data.channel, data.disposition)
    check_loop(meaningful, data.next_action, data.next_action_at, data.loop_closed, data.closed_reason)
    if not any([data.person_id, data.organization_id, data.property_id, data.opportunity_id]):
        raise HTTPException(422, "Link the interaction to a person, organization, property or opportunity")
    now = utcnow()
    occurred_at = data.occurred_at or now
    if occurred_at > now + timedelta(minutes=5):
        raise HTTPException(422, "An interaction cannot be logged in the future")

    value = None
    reasons: list[str] = []
    comp_channel = COMPLIANCE_CHANNEL.get(data.channel)
    if data.direction == "outbound" and comp_channel:
        value = await _resolve_contact_value(db, data.channel, data.contact_value, data.contact_point_id,
                                             data.person_id)
        if value:
            allowed, reasons = await compliance.check_send(db, channel=comp_channel, value=value, at=occurred_at)
            if not allowed:
                await compliance.log_outbound(db, channel=comp_channel, value=value, content=data.summary,
                                              subject=data.subject, actor=actor, allowed=False, reasons=reasons,
                                              person_id=data.person_id)
                await audit.record(db, actor=actor, action="interaction.blocked", entity_type="person" if
                                   data.person_id else "interaction", entity_id=data.person_id,
                                   summary=f"{data.channel} to {value} blocked by compliance",
                                   changes={"reasons": reasons}, ip_address=actor.ip_address)
                await db.commit()
                raise HTTPException(422, {"message": "Blocked by communication compliance", "reasons": reasons,
                                          "code": "compliance_blocked"})

    it = Interaction(
        channel=data.channel, direction=data.direction, occurred_at=occurred_at, person_id=data.person_id,
        organization_id=data.organization_id, property_id=data.property_id, opportunity_id=data.opportunity_id,
        contact_point_id=data.contact_point_id, contact_value=value or data.contact_value,
        disposition=data.disposition, subject=data.subject, summary=data.summary,
        duration_seconds=data.duration_seconds, is_meaningful=meaningful,
        next_action=(data.next_action or "").strip() or None, next_action_at=data.next_action_at,
        loop_closed=data.loop_closed, closed_reason=(data.closed_reason or "").strip() or None,
        logged_by_id=actor.id, sequence_enrollment_id=data.sequence_enrollment_id, compliance_reasons=reasons,
        created_by_id=actor.id, updated_by_id=actor.id,
    )
    if it.loop_closed:
        it.next_action, it.next_action_at = None, None
    db.add(it)
    await db.flush()

    if value and comp_channel:
        await compliance.log_outbound(db, channel=comp_channel, value=value, content=data.summary, subject=data.subject,
                                      actor=actor, allowed=True, interaction_id=it.id, person_id=data.person_id)

    if it.next_action and it.next_action_at:
        enabled, _th = await rule_config(db, "outreach.next_action_required")
        if enabled:
            rtype, rid, rlabel = await _primary_related(db, it)
            task = await create_task(
                db, title=it.next_action, assignee_id=actor.id, due_at=it.next_action_at, task_type="follow_up",
                priority="high" if it.disposition == "offer_requested" else "normal",
                description=f"Follow-up from {_label(it.channel)} on {occurred_at:%b %d, %Y}"
                            + (f" ({_label(it.disposition)})" if it.disposition else "")
                            + (f": {it.summary[:500]}" if it.summary else ""),
                related_type=rtype, related_id=rid, related_label=rlabel, source="outreach",
                idempotency_key=f"interaction:{it.id}:follow_up", actor_id=actor.id,
            )
            it.follow_up_task_id = task.id
            await record_rule_run(db, "outreach.next_action_required")

    if data.complete_task_id:
        await _complete_queue_task(db, data.complete_task_id, it, actor)

    await _apply_disposition_effects(db, it, actor)
    await _touch_person(db, it)

    if it.person_id:
        inbound = it.direction == "inbound"
        reason = "Replied" if inbound else f"Disposition: {_label(it.disposition)}"
        await exit_enrollments(db, it.person_id, reason, disposition=it.disposition, inbound=inbound)
    if it.sequence_enrollment_id and it.direction == "outbound":
        row = (await db.execute(select(SequenceEnrollment, Sequence)
                                .join(Sequence, Sequence.id == SequenceEnrollment.sequence_id)
                                .where(SequenceEnrollment.id == it.sequence_enrollment_id))).first()
        if row and row[0].status == "active":
            _advance(row[0], row[1], occurred_at)

    summary = f"{_label(it.channel)}" + (f" · {_label(it.disposition)}" if it.disposition else "")
    await audit.record(db, actor=actor, action="interaction.logged", entity_type="interaction", entity_id=it.id,
                       summary=summary, ip_address=actor.ip_address)
    for etype, eid in (("person", it.person_id), ("organization", it.organization_id),
                       ("property", it.property_id), ("opportunity", it.opportunity_id)):
        if eid:
            await audit.record(db, actor=actor, action=f"{etype}.interaction_logged", entity_type=etype, entity_id=eid,
                               summary=summary + (f": {it.summary[:200]}" if it.summary else ""),
                               ip_address=actor.ip_address)
    await events.emit(db, "interaction.logged", interaction_id=it.id, person_id=it.person_id,
                      organization_id=it.organization_id, property_id=it.property_id,
                      opportunity_id=it.opportunity_id, channel=it.channel, direction=it.direction,
                      disposition=it.disposition, meaningful=it.is_meaningful, next_action_at=it.next_action_at,
                      actor=actor)
    await db.commit()
    return it


async def _complete_queue_task(db: AsyncSession, task_id: uuid.UUID, it: Interaction, actor) -> None:
    t = await db.get(Task, task_id)
    if not t or t.deleted_at or t.status not in OPEN_TASK:
        return
    if t.depends_on:
        blocked = await db.scalar(select(func.count()).select_from(Task).where(
            Task.id.in_([uuid.UUID(d) for d in t.depends_on]), Task.status.in_(OPEN_TASK)))
        if blocked:
            return
    t.status, t.completed_at, t.completed_by_id = "done", utcnow(), actor.id
    t.resolution_note = f"Logged {_label(it.channel)}" + (f" ({_label(it.disposition)})" if it.disposition else "")
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="task.completed", entity_type="task", entity_id=t.id, summary=t.title,
                       ip_address=actor.ip_address)


async def get_interaction(db: AsyncSession, interaction_id: uuid.UUID) -> Interaction:
    it = await db.get(Interaction, interaction_id)
    if not it or it.deleted_at:
        raise HTTPException(404, "Interaction not found")
    return it


async def update_interaction(db: AsyncSession, it: Interaction, data, actor) -> Interaction:
    values = data.model_dump(exclude_unset=True)
    if "loop_closed" in values and values["loop_closed"] is None:
        values["loop_closed"] = False  # column is NOT NULL
    if values.get("next_action_at"):
        values["next_action_at"] = _aware(values["next_action_at"])
    merged ={k: values.get(k, getattr(it, k)) for k in ("next_action", "next_action_at", "loop_closed",
                                                         "closed_reason")}
    merged["loop_closed"] = bool(merged["loop_closed"])
    check_loop(it.is_meaningful, merged["next_action"], merged["next_action_at"], merged["loop_closed"],
               merged["closed_reason"])
    if merged["loop_closed"]:
        values["next_action"], values["next_action_at"] = None, None
    changes = audit.diff(it, values)
    if not changes:
        return it
    for k, v in values.items():
        setattr(it, k, v)
    it.updated_by_id = actor.id

    task = await db.get(Task, it.follow_up_task_id) if it.follow_up_task_id else None
    if it.loop_closed and task and task.status in OPEN_TASK:
        task.status, task.completed_at, task.completed_by_id = "cancelled", utcnow(), actor.id
        task.resolution_note = f"Loop closed: {it.closed_reason}"
    elif it.next_action and it.next_action_at and {"next_action", "next_action_at"} & changes.keys():
        if task and task.status in OPEN_TASK:
            task.title, task.due_at, task.escalation_level = it.next_action[:300], it.next_action_at, 0
        else:
            rtype, rid, rlabel = await _primary_related(db, it)
            task = await create_task(
                db, title=it.next_action, assignee_id=actor.id, due_at=it.next_action_at, task_type="follow_up",
                related_type=rtype, related_id=rid, related_label=rlabel, source="outreach",
                idempotency_key=f"interaction:{it.id}:follow_up:{utcnow():%Y%m%d%H%M%S}", actor_id=actor.id,
            )
            it.follow_up_task_id = task.id
    await _touch_person(db, it)
    await audit.record(db, actor=actor, action="interaction.updated", entity_type="interaction", entity_id=it.id,
                       changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return it


async def archive_interaction(db: AsyncSession, it: Interaction, actor) -> None:
    it.deleted_at = utcnow()
    it.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="interaction.archived", entity_type="interaction", entity_id=it.id,
                       ip_address=actor.ip_address)
    await db.commit()


def interaction_query(
    *, actor_id: uuid.UUID, q: str | None = None, channel: list[str] | None = None,
    direction: list[str] | None = None, disposition: list[str] | None = None, person_id: uuid.UUID | None = None,
    organization_id: uuid.UUID | None = None, property_id: uuid.UUID | None = None,
    opportunity_id: uuid.UUID | None = None, logged_by: list[str] | None = None, date_from: datetime | None = None,
    date_to: datetime | None = None, meaningful: bool | None = None, skip: set[str] = frozenset(),
) -> Select:
    stmt = select(Interaction).where(Interaction.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [Interaction.summary, Interaction.subject, Interaction.contact_value,
                                  Interaction.next_action])
    if "channel" not in skip:
        stmt = in_filter(stmt, Interaction.channel, channel)
    if "direction" not in skip:
        stmt = in_filter(stmt, Interaction.direction, direction)
    if "disposition" not in skip:
        stmt = in_filter(stmt, Interaction.disposition, disposition)
    for col, val in ((Interaction.person_id, person_id), (Interaction.organization_id, organization_id),
                     (Interaction.property_id, property_id), (Interaction.opportunity_id, opportunity_id)):
        if val:
            stmt = stmt.where(col == val)
    if logged_by:
        ids = []
        for v in logged_by:
            try:
                ids.append(actor_id if v == "me" else uuid.UUID(v))
            except ValueError:
                continue
        if ids:
            stmt = stmt.where(Interaction.logged_by_id.in_(ids))
    if date_from:
        stmt = stmt.where(Interaction.occurred_at >= date_from)
    if date_to:
        stmt = stmt.where(Interaction.occurred_at <= date_to)
    if meaningful is not None:
        stmt = stmt.where(Interaction.is_meaningful.is_(meaningful))
    return stmt


# --------------------------------------------------------------------------- sequences

async def get_sequence(db: AsyncSession, sequence_id: uuid.UUID) -> Sequence:
    s = await db.get(Sequence, sequence_id)
    if not s or s.deleted_at:
        raise HTTPException(404, "Sequence not found")
    return s


async def sequence_outs(db: AsyncSession, rows: list[Sequence]) -> list[SequenceOut]:
    counts: dict = {}
    if rows:
        res = await db.execute(
            select(SequenceEnrollment.sequence_id, SequenceEnrollment.status, func.count())
            .where(SequenceEnrollment.sequence_id.in_([s.id for s in rows]), SequenceEnrollment.deleted_at.is_(None))
            .group_by(SequenceEnrollment.sequence_id, SequenceEnrollment.status))
        for sid, st, n in res.all():
            c = counts.setdefault(sid, {"active": 0, "total": 0})
            c["total"] += n
            if st == "active":
                c["active"] += n
    out = []
    for s in rows:
        o = SequenceOut.model_validate(s)
        o.active_enrollments = counts.get(s.id, {}).get("active", 0)
        o.total_enrollments = counts.get(s.id, {}).get("total", 0)
        out.append(o)
    return out


async def save_sequence(db: AsyncSession, s: Sequence | None, data, actor) -> Sequence:
    values = data.model_dump()
    values["steps"] = [st.model_dump() for st in data.steps]
    if s is None:
        s = Sequence(**values, owner_id=actor.id, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(s)
        await db.flush()
        await audit.record(db, actor=actor, action="sequence.created", entity_type="sequence", entity_id=s.id,
                           summary=s.name, ip_address=actor.ip_address)
    else:
        changes = audit.diff(s, values)
        for k, v in values.items():
            setattr(s, k, v)
        s.updated_by_id = actor.id
        if changes:
            await audit.record(db, actor=actor, action="sequence.updated", entity_type="sequence", entity_id=s.id,
                               changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return s


async def enroll(db: AsyncSession, s: Sequence, person_ids: list[uuid.UUID], owner_id: uuid.UUID | None,
                 actor) -> dict:
    if s.status != "active":
        raise HTTPException(409, "Only active sequences accept enrollments")
    steps = s.steps or []
    if not steps:
        raise HTTPException(422, "Add at least one step before enrolling people")
    active_rows = list(await db.scalars(select(SequenceEnrollment.person_id).where(
        SequenceEnrollment.sequence_id == s.id, SequenceEnrollment.status.in_(["active", "paused"]),
        SequenceEnrollment.deleted_at.is_(None))))
    already = set(active_rows)
    active = len(active_rows)
    known = await person_names(db, person_ids)
    now = utcnow()
    skipped: list[dict] = []
    enrolled = 0
    for pid in dict.fromkeys(person_ids):
        if pid in already:
            skipped.append({"person_id": str(pid), "reason": "Already enrolled"})
            continue
        if s.enrollment_cap and active >= s.enrollment_cap:
            skipped.append({"person_id": str(pid), "reason": f"Enrollment cap of {s.enrollment_cap} reached"})
            continue
        if known is not None and _table("people") is not None and pid not in known:
            skipped.append({"person_id": str(pid), "reason": "Person not found"})
            continue
        blocked = await compliance.person_suppression_reasons(db, pid)
        if blocked:
            skipped.append({"person_id": str(pid), "reason": "; ".join(blocked[:2])})
            continue
        db.add(SequenceEnrollment(
            sequence_id=s.id, person_id=pid, owner_id=owner_id or actor.id, status="active", current_step=0,
            next_step_at=now + timedelta(days=int(steps[0].get("delay_days", 0) or 0)), enrolled_at=now,
            created_by_id=actor.id, updated_by_id=actor.id,
        ))
        active += 1
        enrolled += 1
    await audit.record(db, actor=actor, action="sequence.enrolled", entity_type="sequence", entity_id=s.id,
                       summary=f"{enrolled} enrolled, {len(skipped)} skipped", ip_address=actor.ip_address)
    await db.commit()
    return {"enrolled": enrolled, "skipped": skipped}


async def enrollment_outs(db: AsyncSession, rows: list[SequenceEnrollment]) -> list[EnrollmentOut]:
    seqs = {s.id: s for s in await db.scalars(select(Sequence).where(
        Sequence.id.in_({r.sequence_id for r in rows})))} if rows else {}
    names = await person_names(db, [r.person_id for r in rows])
    out = []
    for r in rows:
        o = EnrollmentOut.model_validate(r)
        s = seqs.get(r.sequence_id)
        steps = (s.steps or []) if s else []
        o.sequence_name = s.name if s else None
        o.person_name = names.get(r.person_id)
        o.total_steps = len(steps)
        if r.status == "active" and r.current_step < len(steps):
            o.next_step_channel = steps[r.current_step].get("channel")
        out.append(o)
    return out


async def get_enrollment(db: AsyncSession, enrollment_id: uuid.UUID) -> SequenceEnrollment:
    e = await db.get(SequenceEnrollment, enrollment_id)
    if not e or e.deleted_at:
        raise HTTPException(404, "Enrollment not found")
    return e


async def exit_enrollment(db: AsyncSession, e: SequenceEnrollment, reason: str, actor) -> SequenceEnrollment:
    if e.status not in ("active", "paused"):
        raise HTTPException(409, f"Enrollment is already {e.status}")
    e.status, e.exited_at, e.exit_reason, e.next_step_at = "exited", utcnow(), reason, None
    e.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="sequence.enrollment_exited", entity_type="sequence",
                       entity_id=e.sequence_id, summary=reason, ip_address=actor.ip_address)
    await db.commit()
    return e


async def advance_enrollment(db: AsyncSession, e: SequenceEnrollment, actor) -> SequenceEnrollment:
    if e.status != "active":
        raise HTTPException(409, "Only active enrollments can advance")
    _advance(e, await get_sequence(db, e.sequence_id), utcnow())
    e.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="sequence.step_completed", entity_type="sequence",
                       entity_id=e.sequence_id, summary=f"Step {e.current_step}", ip_address=actor.ip_address)
    await db.commit()
    return e


# --------------------------------------------------------------------------- daily queue

def _days(delta: timedelta) -> int:
    return max(0, int(delta.total_seconds() // 86400))


async def build_queue(db: AsyncSession, user_id: uuid.UUID, limit: int) -> dict:
    """Finite, explainable daily action list. Every item carries the reasons it was prioritized."""
    now = utcnow()
    start, end = day_bounds(now)
    items: dict[str, dict] = {}
    people_in_queue: set[uuid.UUID] = set()

    def add(key: str, **item) -> None:
        item["score"] = round(item["score"], 1)
        items[key] = {"key": key, **item}
        if item.get("person_id"):
            people_in_queue.add(item["person_id"])

    # Tasks and follow-ups due today or overdue
    tasks = list(await db.scalars(select(Task).where(
        Task.deleted_at.is_(None), Task.assignee_id == user_id, Task.status.in_(OPEN_TASK),
        Task.due_at.is_not(None), Task.due_at < end).order_by(Task.due_at).limit(200)))
    for t in tasks:
        follow_up = t.task_type == "follow_up"
        score = 40.0 + (8 if follow_up else 0)
        reasons = ["Follow-up you committed to"] if follow_up else []
        if t.due_at < now:
            d = _days(now - t.due_at)
            reasons.append(f"Overdue by {d} day{'s' if d != 1 else ''}" if d else "Overdue today")
            score += 25 + min(20, (now - t.due_at).total_seconds() / 86400 * 3)
        else:
            reasons.append("Due today")
            score += 10
        if t.priority == "urgent":
            reasons.append("Urgent priority")
            score += 25
        elif t.priority == "high":
            reasons.append("High priority")
            score += 12
        if t.escalation_level:
            reasons.append(f"Escalated (level {t.escalation_level})")
            score += 10
        rel = {f"{t.related_type}_id": t.related_id} if t.related_type in (
            "person", "organization", "property", "opportunity") else {}
        add(f"task:{t.id}", kind="follow_up" if follow_up else "task", title=t.title, subtitle=t.related_label,
            score=score, reasons=reasons, due_at=t.due_at, task_id=t.id, **rel)

    # Sequence steps due
    rows = (await db.execute(
        select(SequenceEnrollment, Sequence).join(Sequence, Sequence.id == SequenceEnrollment.sequence_id)
        .where(SequenceEnrollment.status == "active", SequenceEnrollment.deleted_at.is_(None),
               Sequence.status == "active", SequenceEnrollment.next_step_at < end,
               or_(SequenceEnrollment.owner_id == user_id,
                   and_(SequenceEnrollment.owner_id.is_(None), Sequence.owner_id == user_id)))
        .order_by(SequenceEnrollment.next_step_at).limit(200)
    )).all()
    for e, s in rows:
        steps = s.steps or []
        if e.current_step >= len(steps):
            continue
        step = steps[e.current_step]
        score = 35.0
        reasons = [f"Step {e.current_step + 1} of {len(steps)} in sequence “{s.name}” ({_label(step.get('channel'))})"]
        if e.next_step_at and e.next_step_at < start:
            reasons.append(f"Step was due {e.next_step_at:%b %d}")
            score += 15
        add(f"seq:{e.id}", kind="sequence_step", title=f"{_label(step.get('channel')).capitalize()} step",
            subtitle=s.name, score=score, reasons=reasons, due_at=e.next_step_at, person_id=e.person_id,
            enrollment_id=e.id)

    # Stalled negotiations
    try:
        from app.modules.pipeline.models import Opportunity

        stmt = select(Opportunity).where(
            Opportunity.owner_id == user_id, Opportunity.stage.in_(STALLED_STAGES),
            or_(Opportunity.next_action_at < now, Opportunity.stage_entered_at < now - timedelta(days=14)))
        if hasattr(Opportunity, "deleted_at"):
            stmt = stmt.where(Opportunity.deleted_at.is_(None))
        for o in await db.scalars(stmt.limit(100)):
            score = 50.0
            reasons = []
            if o.stage_entered_at and o.stage_entered_at < now - timedelta(days=14):
                d = _days(now - o.stage_entered_at)
                reasons.append(f"In {_label(o.stage)} for {d} days without moving forward")
                score += min(25, d - 14)
            if o.next_action_at and o.next_action_at < now:
                reasons.append(f"Next action overdue since {o.next_action_at:%b %d}"
                               + (f": {o.next_action}" if o.next_action else ""))
                score += 15
            if (o.priority or "") in ("high", "urgent"):
                reasons.append("High-priority deal")
                score += 10
            add(f"opp:{o.id}", kind="stalled_deal", title=o.title, subtitle=_label(o.stage).capitalize(),
                score=score, reasons=reasons, due_at=o.next_action_at, opportunity_id=o.id,
                property_id=o.property_id, person_id=o.primary_person_id,
                organization_id=o.primary_organization_id)
    except ImportError:
        pass

    # People with a due next action, then relationship recency
    try:
        from app.modules.contacts.models import Person

        base = select(Person).where(Person.owner_id == user_id)
        if hasattr(Person, "deleted_at"):
            base = base.where(Person.deleted_at.is_(None))
        for p in await db.scalars(base.where(Person.next_action_at < end).order_by(Person.next_action_at).limit(100)):
            if p.id in people_in_queue:
                continue
            score = 45.0
            if p.next_action_at < start:
                d = max(1, _days(now - p.next_action_at))
                reasons = [f"Next action overdue by {d} day{'s' if d != 1 else ''}"]
                score += 15 + min(15, d * 2)
            else:
                reasons = ["Next action due today"]
            add(f"person:{p.id}", kind="person_due", title=_person_name(p), subtitle=p.title, score=score,
                reasons=reasons, due_at=p.next_action_at, person_id=p.id)
        cutoff = now - timedelta(days=90)
        for p in await db.scalars(base.where(Person.last_touch_at < cutoff).order_by(Person.last_touch_at)
                                  .limit(60)):
            if p.id in people_in_queue:
                continue
            d = _days(now - p.last_touch_at)
            score = 25.0 + min(15, (d - 90) / 30 * 3)
            reasons = [f"No touch in {d} days"]
            if str(p.relationship_strength or "").lower() in ("strong", "high", "5", "4"):
                reasons.append("Strong relationship going cold")
                score += 10
            add(f"recency:{p.id}", kind="relationship", title=_person_name(p), subtitle=p.title, score=score,
                reasons=reasons, due_at=None, person_id=p.id)
    except ImportError:
        pass

    # Fill person names for sequence steps
    names = await person_names(db, [i.get("person_id") for i in items.values() if i["kind"] == "sequence_step"])
    for i in items.values():
        if i["kind"] == "sequence_step" and i.get("person_id") in names:
            i["title"] = f"{i['title']}: {names[i['person_id']]}"

    ordered = sorted(items.values(), key=lambda i: -i["score"])
    done_today = (await db.scalar(select(func.count()).select_from(Interaction).where(
        Interaction.logged_by_id == user_id, Interaction.created_at >= start, Interaction.deleted_at.is_(None))) or 0)
    done_today += (await db.scalar(select(func.count()).select_from(Task).where(
        Task.completed_by_id == user_id, Task.status == "done", Task.completed_at >= start)) or 0)
    return {"items": ordered[:limit], "cap": limit, "total_candidates": len(ordered), "done_today": int(done_today)}


# --------------------------------------------------------------------------- pre-call context

async def person_context(db: AsyncSession, person_id: uuid.UUID) -> dict:
    now = utcnow()
    person: dict | None = None
    try:
        from app.modules.contacts.models import Person

        p = await db.get(Person, person_id)
        if p is None or getattr(p, "deleted_at", None):
            raise HTTPException(404, "Person not found")
        person = {k: getattr(p, k, None) for k in (
            "id", "first_name", "last_name", "full_name", "title", "primary_email", "primary_phone", "mailing_address",
            "city", "state", "contact_preferences", "owner_id", "last_touch_at", "next_action_at",
            "relationship_strength", "tags")}
        person["full_name"] = _person_name(p)
    except ImportError:
        pass

    organizations: list[dict] = []
    aff, orgs = _table("affiliations"), _table("organizations")
    if aff is not None and orgs is not None:
        rows = await db.execute(
            select(orgs.c.id, orgs.c.name, aff.c.role, aff.c.title, aff.c.is_current)
            .join(orgs, orgs.c.id == aff.c.organization_id).where(aff.c.person_id == person_id).limit(25))
        organizations = [dict(r._mapping) for r in rows.all()]

    properties: list[dict] = []
    oi = _table("ownership_interests")
    if oi is not None:
        from app.modules.properties.models import Property

        org_ids = [o["id"] for o in organizations]
        cond = and_(oi.c.owner_kind == "person", oi.c.owner_person_id == person_id)
        if org_ids:
            cond = or_(cond, and_(oi.c.owner_kind == "organization", oi.c.owner_organization_id.in_(org_ids)))
        rows = await db.execute(
            select(Property.id, Property.name, Property.address_line, Property.city, Property.state,
                   Property.property_type, Property.status, oi.c.role, oi.c.interest_pct)
            .join(oi, oi.c.property_id == Property.id).where(cond, Property.deleted_at.is_(None)).limit(25))
        seen: set = set()
        for r in rows.all():
            if r.id not in seen:
                seen.add(r.id)
                properties.append(dict(r._mapping))

    opportunities: list[dict] = []
    try:
        from app.modules.pipeline.models import Opportunity

        stmt = select(Opportunity).where(Opportunity.primary_person_id == person_id)
        if hasattr(Opportunity, "deleted_at"):
            stmt = stmt.where(Opportunity.deleted_at.is_(None))
        for o in await db.scalars(stmt.limit(10)):
            opportunities.append({k: getattr(o, k, None) for k in (
                "id", "title", "stage", "stage_entered_at", "next_action", "next_action_at", "property_id",
                "price_expectation", "priority")})
    except ImportError:
        pass

    interactions = list(await db.scalars(
        select(Interaction).where(Interaction.person_id == person_id, Interaction.deleted_at.is_(None))
        .order_by(Interaction.occurred_at.desc()).limit(10)))

    related_ids = [person_id] + [o["id"] for o in opportunities]
    tasks = list(await db.scalars(select(Task).where(
        Task.deleted_at.is_(None), Task.status.in_(OPEN_TASK), Task.related_id.in_(related_ids))
        .order_by(Task.due_at.asc().nulls_last()).limit(20)))
    open_tasks = [{"id": t.id, "title": t.title, "due_at": t.due_at, "priority": t.priority, "status": t.status,
                   "task_type": t.task_type} for t in tasks]

    enrollments = list(await db.scalars(select(SequenceEnrollment).where(
        SequenceEnrollment.person_id == person_id, SequenceEnrollment.status.in_(["active", "paused"]),
        SequenceEnrollment.deleted_at.is_(None))))

    contacts = []
    for kind, value, label in await compliance.person_contact_values(db, person_id):
        chans = ["email"] if kind == "email" else ["phone", "sms"]
        contacts.append({"kind": kind, "label": label, "value": value,
                         "channels": [await compliance.status_for(db, ch, value) for ch in chans]})
    suppression = await compliance.person_suppression_reasons(db, person_id)

    points: list[str] = []
    if interactions:
        last = interactions[0]
        points.append(f"Last touch {last.occurred_at:%b %d, %Y} by {_label(last.channel)}"
                      + (f" ({_label(last.disposition)})" if last.disposition else "")
                      + (f": {last.summary[:160]}" if last.summary else ""))
        committed = next((i for i in interactions if i.next_action and not i.loop_closed), None)
        if committed:
            points.append(f"Committed next step: {committed.next_action}"
                          + (f" (due {committed.next_action_at:%b %d})" if committed.next_action_at else ""))
    elif person is not None:
        points.append("No logged interactions yet — introduce yourself and confirm the best contact channel")
    for o in opportunities[:3]:
        since = f" since {o['stage_entered_at']:%b %d}" if o.get("stage_entered_at") else ""
        price = f"; price expectation ${o['price_expectation']:,.0f}" if o.get("price_expectation") else ""
        points.append(f"Deal “{o['title']}” is in {_label(o.get('stage'))}{since}{price}")
    if properties:
        names = ", ".join((p.get("name") or p.get("address_line") or "") for p in properties[:3])
        points.append(f"Linked to {len(properties)} propert{'ies' if len(properties) != 1 else 'y'}: {names}")
    if person and person.get("last_touch_at") and person["last_touch_at"] < now - timedelta(days=90):
        points.append(f"Relationship has gone {_days(now - person['last_touch_at'])} days without a touch")
    if contacts and not any(ch["allowed"] for c in contacts for ch in c["channels"]):
        points.append("Every phone and email is currently blocked by compliance — do not contact")

    return {
        "person": person,
        "organizations": organizations,
        "properties": properties,
        "opportunities": opportunities,
        "interactions": await interaction_outs(db, interactions),
        "open_tasks": open_tasks,
        "enrollments": await enrollment_outs(db, enrollments),
        "contacts": contacts,
        "suppression_reasons": suppression,
        "talking_points": points,
    }


# --------------------------------------------------------------------------- manager view

async def team_activity(db: AsyncSession, date_from: datetime, date_to: datetime,
                        team_id: uuid.UUID | None) -> dict:
    now = utcnow()
    ustmt = select(User).where(User.deleted_at.is_(None), User.status == "active", User.is_service.is_(False))
    if team_id:
        ustmt = ustmt.where(User.team_id == team_id)
    users = {u.id: u for u in await db.scalars(ustmt)}
    uid_filter = list(users)

    rows: dict[uuid.UUID, dict] = {}

    def row(uid):
        return rows.setdefault(uid, {"user_id": uid, "user_name": users[uid].full_name, "total": 0, "meaningful": 0,
                                     "by_channel": {}, "by_disposition": {}, "overdue_follow_ups": 0,
                                     "stale_records": 0, "untouched_records": 0})

    res = await db.execute(
        select(Interaction.logged_by_id, Interaction.channel, Interaction.disposition, Interaction.is_meaningful,
               func.count())
        .where(Interaction.deleted_at.is_(None), Interaction.occurred_at >= date_from,
               Interaction.occurred_at <= date_to, Interaction.logged_by_id.in_(uid_filter))
        .group_by(Interaction.logged_by_id, Interaction.channel, Interaction.disposition, Interaction.is_meaningful))
    for uid, channel, disposition, meaningful, n in res.all():
        r = row(uid)
        r["total"] += n
        r["meaningful"] += n if meaningful else 0
        r["by_channel"][channel] = r["by_channel"].get(channel, 0) + n
        if disposition:
            r["by_disposition"][disposition] = r["by_disposition"].get(disposition, 0) + n

    overdue_cond = and_(Task.deleted_at.is_(None), Task.status.in_(OPEN_TASK), Task.due_at < now,
                        or_(Task.task_type == "follow_up", Task.source == "outreach"),
                        Task.assignee_id.in_(uid_filter))
    for uid, n in (await db.execute(select(Task.assignee_id, func.count()).where(overdue_cond)
                                    .group_by(Task.assignee_id))).all():
        row(uid)["overdue_follow_ups"] = n

    try:
        from app.modules.contacts.models import Person

        pbase = [Person.owner_id.in_(uid_filter)]
        if hasattr(Person, "deleted_at"):
            pbase.append(Person.deleted_at.is_(None))
        for uid, n in (await db.execute(select(Person.owner_id, func.count()).where(
                *pbase, Person.last_touch_at < now - timedelta(days=90)).group_by(Person.owner_id))).all():
            row(uid)["stale_records"] = n
        for uid, n in (await db.execute(select(Person.owner_id, func.count()).where(
                *pbase, Person.last_touch_at.is_(None)).group_by(Person.owner_id))).all():
            row(uid)["untouched_records"] = n
    except ImportError:
        pass

    overdue = list(await db.scalars(select(Task).where(overdue_cond).order_by(Task.due_at).limit(50)))
    overdue_items = [{"id": t.id, "title": t.title, "due_at": t.due_at, "assignee_id": t.assignee_id,
                      "assignee_name": users[t.assignee_id].full_name if t.assignee_id in users else None,
                      "related_type": t.related_type, "related_id": t.related_id, "related_label": t.related_label}
                     for t in overdue]
    return {"date_from": date_from, "date_to": date_to,
            "rows": sorted(rows.values(), key=lambda r: (-r["total"], r["user_name"])), "overdue": overdue_items}

