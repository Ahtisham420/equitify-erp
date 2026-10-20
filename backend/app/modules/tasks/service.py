"""Task/alert helpers used by every module's automations.

    from app.modules.tasks.service import create_task, raise_alert
    from app.modules.tasks.service import rule_config, record_rule_run   # automation registry
"""
import uuid
from dataclasses import fields as dc_fields
from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.core import events
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.tasks.models import (
    ALERT_SEVERITIES,
    TASK_PRIORITIES,
    Alert,
    AlertSubscription,
    AutomationRule,
    Task,
)


async def create_task(
    db: AsyncSession,
    *,
    title: str,
    assignee_id: uuid.UUID | None = None,
    due_at: datetime | None = None,
    task_type: str = "general",
    priority: str = "normal",
    description: str | None = None,
    related_type: str | None = None,
    related_id: uuid.UUID | None = None,
    related_label: str | None = None,
    source: str = "manual",
    idempotency_key: str | None = None,
    actor_id: uuid.UUID | None = None,
) -> Task:
    if idempotency_key:
        existing = await db.scalar(select(Task).where(Task.idempotency_key == idempotency_key))
        if existing:
            return existing
    task = Task(
        title=title[:300],
        description=description,
        task_type=task_type,
        priority=priority,
        due_at=due_at,
        assignee_id=assignee_id,
        related_type=related_type,
        related_id=related_id,
        related_label=related_label[:300] if related_label else None,
        source=source,
        idempotency_key=idempotency_key,
        created_by_id=actor_id,
        updated_by_id=actor_id,
    )
    db.add(task)
    await db.flush()
    return task


async def raise_alert(
    db: AsyncSession,
    *,
    title: str,
    reason: str,
    severity: str = "medium",
    owner_id: uuid.UUID | None = None,
    related_type: str | None = None,
    related_id: uuid.UUID | None = None,
    related_label: str | None = None,
    rule_key: str | None = None,
    due_at: datetime | None = None,
    idempotency_key: str | None = None,
) -> Alert:
    if idempotency_key:
        existing = await db.scalar(select(Alert).where(Alert.idempotency_key == idempotency_key))
        if existing:
            return existing
    alert = Alert(
        title=title[:300],
        reason=reason,
        severity=severity,
        owner_id=owner_id,
        related_type=related_type,
        related_id=related_id,
        related_label=related_label[:300] if related_label else None,
        rule_key=rule_key,
        due_at=due_at,
        idempotency_key=idempotency_key,
    )
    db.add(alert)
    await db.flush()
    return alert


# --------------------------------------------------------------------------- automation registry

DEFAULT_RULES: list[dict] = [
    {
        "key": "buybox.insufficient_data",
        "name": "Insufficient data for Buy Box",
        "event": "buybox.evaluated",
        "description": "Creates a research task when a property cannot be evaluated against an active Buy Box "
                       "because required fields are missing.",
        "thresholds": {"task_due_days": 3},
    },
    {
        "key": "pipeline.followup_on_contact",
        "name": "Follow-up after contact",
        "event": "opportunity.stage_changed",
        "description": "Creates a follow-up task when an opportunity reaches the contact stage without a scheduled next step.",
        "thresholds": {"follow_up_days": 2},
    },
    {
        "key": "outreach.next_action_required",
        "name": "Follow-up task from next action",
        "event": "interaction.logged",
        "description": "Turns the mandatory next action on a meaningful interaction into an owned follow-up task.",
        "thresholds": {"default_follow_up_days": 3},
    },
    {
        "key": "compliance.optout_propagation",
        "name": "Cross-channel opt-out propagation",
        "event": "compliance.opted_out",
        "description": "Immediately suppresses every phone and email of a person who opted out on any channel and "
                       "exits their active sequences.",
        "thresholds": {},
    },
    {
        "key": "tasks.escalation",
        "name": "Overdue escalation",
        "event": "schedule",
        "description": "Raises priority/severity of overdue tasks and unacknowledged alerts after the configured "
                       "intervals and notifies the owner's manager.",
        "thresholds": {
            "task_overdue_hours": 24,
            "alert_unacknowledged_hours": {"low": 72, "medium": 48, "high": 24, "critical": 4},
            "max_level": 2,
            "notify_manager": True,
            "severity_channels": {
                "low": ["digest"], "medium": ["in_app", "digest"], "high": ["in_app", "email"],
                "critical": ["in_app", "email"],
            },
        },
    },
]
_DEFAULTS = {r["key"]: r for r in DEFAULT_RULES}


async def ensure_rules(db: AsyncSession) -> list[AutomationRule]:
    """Seeds any missing registry rows (lazy, idempotent) and returns all rules."""
    rows = list(await db.scalars(select(AutomationRule).where(AutomationRule.deleted_at.is_(None))))
    have = {r.key for r in rows}
    added = False
    for d in DEFAULT_RULES:
        if d["key"] not in have:
            rule = AutomationRule(key=d["key"], name=d["name"], description=d["description"], event=d["event"],
                                  enabled=True, thresholds=dict(d["thresholds"]), run_count=0, error_count=0)
            db.add(rule)
            rows.append(rule)
            added = True
    if added:
        await db.flush()
    return sorted(rows, key=lambda r: r.key)


async def get_rule(db: AsyncSession, key: str) -> AutomationRule | None:
    rule = await db.scalar(select(AutomationRule).where(AutomationRule.key == key, AutomationRule.deleted_at.is_(None)))
    if rule is None and key in _DEFAULTS:
        await ensure_rules(db)
        rule = await db.scalar(select(AutomationRule).where(AutomationRule.key == key))
    return rule


async def rule_config(db: AsyncSession, key: str) -> tuple[bool, dict]:
    """(enabled, thresholds) for an automation; thresholds are merged over the registry defaults."""
    rule = await get_rule(db, key)
    defaults = dict(_DEFAULTS.get(key, {}).get("thresholds", {}))
    if rule is None:
        return True, defaults
    return bool(rule.enabled), {**defaults, **(rule.thresholds or {})}


async def record_rule_run(db: AsyncSession, key: str, *, error: str | None = None) -> None:
    """Observability for automations: last run, run and error counters. Does not commit."""
    rule = await get_rule(db, key)
    if rule is None:
        return
    rule.last_run_at = utcnow()
    rule.run_count = (rule.run_count or 0) + 1
    if error:
        rule.error_count = (rule.error_count or 0) + 1
        rule.last_error = error[:2000]


async def update_rule(db: AsyncSession, rule: AutomationRule, enabled: bool | None, thresholds: dict | None,
                      actor) -> AutomationRule:
    data: dict = {}
    if enabled is not None:
        data["enabled"] = enabled
    if thresholds is not None:
        data["thresholds"] = thresholds
    changes = audit.diff(rule, data)
    if not changes:
        return rule
    for k, v in data.items():
        setattr(rule, k, v)
    rule.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="automation_rule.updated", entity_type="automation_rule",
                       entity_id=rule.id, summary=rule.key, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return rule


# --------------------------------------------------------------------------- helpers

async def user_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))
    return {r[0]: r[1] for r in rows.all()}


def day_bounds(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def _bump(scale: list[str], current: str, steps: int) -> str:
    idx = scale.index(current) if current in scale else 0
    return scale[min(len(scale) - 1, idx + max(0, steps))]


async def _manager_of(db: AsyncSession, user_id: uuid.UUID | None) -> uuid.UUID | None:
    if not user_id:
        return None
    return await db.scalar(select(User.manager_id).where(User.id == user_id))


# --------------------------------------------------------------------------- tasks

OPEN_TASK = ("open", "in_progress")


async def get_task(db: AsyncSession, task_id: uuid.UUID) -> Task:
    t = await db.get(Task, task_id)
    if not t or t.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    return t


async def task_outs(db: AsyncSession, tasks: list[Task], *, with_dependencies: bool = False) -> list[dict]:
    """Serializes tasks with assignee names and dependency/blocked state."""
    from app.modules.tasks.schemas import TaskOut, TaskRef

    dep_ids = {uuid.UUID(d) for t in tasks for d in (t.depends_on or [])}
    deps: dict[uuid.UUID, Task] = {}
    if dep_ids:
        deps = {d.id: d for d in await db.scalars(select(Task).where(Task.id.in_(dep_ids)))}
    names = await user_names(db, [t.assignee_id for t in tasks])
    out = []
    for t in tasks:
        o = TaskOut.model_validate(t)
        o.depends_on = [str(d) for d in (t.depends_on or [])]
        o.assignee_name = names.get(t.assignee_id)
        refs = [deps[uuid.UUID(d)] for d in (t.depends_on or []) if uuid.UUID(d) in deps]
        o.blocked = any(r.status in OPEN_TASK and not r.deleted_at for r in refs)
        if with_dependencies:
            o.dependencies = [TaskRef.model_validate(r) for r in refs]
        out.append(o)
    return out


async def _validate_dependencies(db: AsyncSession, task_id: uuid.UUID | None, dep_ids: list[uuid.UUID]) -> list[str]:
    if not dep_ids:
        return []
    if task_id and task_id in dep_ids:
        raise HTTPException(422, "A task cannot depend on itself")
    rows = list(await db.scalars(select(Task).where(Task.id.in_(dep_ids), Task.deleted_at.is_(None))))
    if len(rows) != len(set(dep_ids)):
        raise HTTPException(422, "One or more dependency tasks do not exist")
    if task_id and any(str(task_id) in (r.depends_on or []) for r in rows):
        raise HTTPException(422, "Circular dependency: a dependency already depends on this task")
    return [str(d) for d in dict.fromkeys(dep_ids)]


async def create(db: AsyncSession, data, actor) -> Task:
    deps = await _validate_dependencies(db, None, data.depends_on)
    t = await create_task(
        db, title=data.title, description=data.description, task_type=data.task_type, priority=data.priority,
        due_at=data.due_at, assignee_id=data.assignee_id or actor.id, related_type=data.related_type,
        related_id=data.related_id, related_label=data.related_label, source="manual", actor_id=actor.id,
    )
    t.depends_on = deps
    await audit.record(db, actor=actor, action="task.created", entity_type="task", entity_id=t.id, summary=t.title,
                       ip_address=actor.ip_address)
    if t.related_type and t.related_id:
        await audit.record(db, actor=actor, action=f"{t.related_type}.task_added", entity_type=t.related_type,
                           entity_id=t.related_id, summary=t.title, ip_address=actor.ip_address)
    await db.commit()
    return t


async def update(db: AsyncSession, t: Task, data, actor) -> Task:
    values = data.model_dump(exclude_unset=True)
    if "depends_on" in values:
        values["depends_on"] = await _validate_dependencies(db, t.id, values["depends_on"] or [])
    if t.status not in OPEN_TASK and set(values) - {"description"}:
        raise HTTPException(409, "Closed tasks cannot be changed")
    changes = audit.diff(t, values)
    if not changes:
        return t
    for k, v in values.items():
        setattr(t, k, v)
    if "due_at" in changes:
        t.escalation_level = 0
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="task.updated", entity_type="task", entity_id=t.id, changes=changes,
                       ip_address=actor.ip_address)
    await db.commit()
    return t


async def complete(db: AsyncSession, t: Task, note: str | None, actor) -> Task:
    if t.status not in OPEN_TASK:
        raise HTTPException(409, f"Task is already {t.status}")
    if t.depends_on:
        open_deps = list(await db.scalars(select(Task).where(
            Task.id.in_([uuid.UUID(d) for d in t.depends_on]), Task.status.in_(OPEN_TASK), Task.deleted_at.is_(None))))
        if open_deps:
            raise HTTPException(409, {"message": "Complete the tasks this one depends on first",
                                      "open_dependencies": [{"id": str(d.id), "title": d.title} for d in open_deps]})
    t.status = "done"
    t.completed_at = utcnow()
    t.completed_by_id = actor.id
    t.resolution_note = note
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="task.completed", entity_type="task", entity_id=t.id, summary=t.title,
                       changes={"resolution_note": note} if note else None, ip_address=actor.ip_address)
    await events.emit(db, "task.completed", task_id=t.id, related_type=t.related_type, related_id=t.related_id,
                      actor=actor)
    await db.commit()
    return t


async def cancel(db: AsyncSession, t: Task, note: str, actor) -> Task:
    if t.status not in OPEN_TASK:
        raise HTTPException(409, f"Task is already {t.status}")
    t.status = "cancelled"
    t.completed_at = utcnow()
    t.completed_by_id = actor.id
    t.resolution_note = note
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="task.cancelled", entity_type="task", entity_id=t.id, summary=t.title,
                       changes={"resolution_note": note}, ip_address=actor.ip_address)
    await db.commit()
    return t


async def reopen(db: AsyncSession, t: Task, actor) -> Task:
    if t.status in OPEN_TASK:
        return t
    t.status = "open"
    t.completed_at = None
    t.completed_by_id = None
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="task.reopened", entity_type="task", entity_id=t.id, summary=t.title,
                       ip_address=actor.ip_address)
    await db.commit()
    return t


async def archive(db: AsyncSession, t: Task, actor) -> None:
    t.deleted_at = utcnow()
    t.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="task.archived", entity_type="task", entity_id=t.id, summary=t.title,
                       ip_address=actor.ip_address)
    await db.commit()


def task_query(
    *, actor_id: uuid.UUID, q: str | None = None, status_: list[str] | None = None, priority: list[str] | None = None,
    task_type: list[str] | None = None, assignee: list[str] | None = None, due: str | None = None,
    related_type: str | None = None, related_id: uuid.UUID | None = None, skip: set[str] = frozenset(),
) -> Select:
    from app.common.query import apply_search, in_filter

    now = utcnow()
    start, end = day_bounds(now)
    stmt = select(Task).where(Task.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [Task.title, Task.description, Task.related_label])
    if "status" not in skip:
        stmt = in_filter(stmt, Task.status, status_)
    if "priority" not in skip:
        stmt = in_filter(stmt, Task.priority, priority)
    if "task_type" not in skip:
        stmt = in_filter(stmt, Task.task_type, task_type)
    if assignee:
        ids: list[uuid.UUID] = []
        unassigned = False
        for a in assignee:
            if a == "me":
                ids.append(actor_id)
            elif a == "none":
                unassigned = True
            else:
                try:
                    ids.append(uuid.UUID(a))
                except ValueError:
                    continue
        conds = [Task.assignee_id.in_(ids)] if ids else []
        if unassigned:
            conds.append(Task.assignee_id.is_(None))
        if conds:
            stmt = stmt.where(or_(*conds))
    if due == "overdue":
        stmt = stmt.where(Task.due_at < now, Task.status.in_(OPEN_TASK))
    elif due == "today":
        stmt = stmt.where(Task.due_at >= start, Task.due_at < end)
    elif due == "this_week":
        stmt = stmt.where(Task.due_at >= start, Task.due_at < start + timedelta(days=7))
    elif due == "none":
        stmt = stmt.where(Task.due_at.is_(None))
    if related_type:
        stmt = stmt.where(Task.related_type == related_type)
    if related_id:
        stmt = stmt.where(Task.related_id == related_id)
    return stmt


# --------------------------------------------------------------------------- alerts

async def get_alert(db: AsyncSession, alert_id: uuid.UUID) -> Alert:
    a = await db.get(Alert, alert_id)
    if not a or a.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alert not found")
    return a


def _check_alert_access(a: Alert, actor) -> None:
    if a.owner_id and a.owner_id != actor.id and not actor.can("tasks", "approve"):
        raise HTTPException(403, "Only the alert owner or a manager can work this alert")


async def alert_outs(db: AsyncSession, alerts: list[Alert]) -> list[dict]:
    from app.modules.tasks.schemas import AlertOut

    names = await user_names(db, [a.owner_id for a in alerts])
    out = []
    for a in alerts:
        o = AlertOut.model_validate(a)
        o.owner_name = names.get(a.owner_id)
        out.append(o)
    return out


async def acknowledge(db: AsyncSession, a: Alert, note: str | None, actor) -> Alert:
    _check_alert_access(a, actor)
    if a.status != "open":
        raise HTTPException(409, f"Alert is already {a.status}")
    a.status = "acknowledged"
    a.acknowledged_at = utcnow()
    a.acknowledged_by_id = actor.id
    a.updated_by_id = actor.id
    if a.owner_id is None:
        a.owner_id = actor.id
    await audit.record(db, actor=actor, action="alert.acknowledged", entity_type="alert", entity_id=a.id,
                       summary=a.title, changes={"note": note} if note else None, ip_address=actor.ip_address)
    await db.commit()
    return a


async def resolve(db: AsyncSession, a: Alert, note: str, kind: str, actor) -> Alert:
    """Alerts are worked to a recorded resolution — there is no silent dismiss."""
    _check_alert_access(a, actor)
    if a.status == "resolved":
        raise HTTPException(409, "Alert is already resolved")
    if not note or len(note.strip()) < 3:
        raise HTTPException(422, "A resolution note is required")
    now = utcnow()
    if not a.acknowledged_at:
        a.acknowledged_at = now
        a.acknowledged_by_id = actor.id
    a.status = "resolved"
    a.resolved_at = now
    a.resolved_by_id = actor.id
    a.resolution_note = note.strip()
    a.resolution_kind = kind
    a.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="alert.resolved", entity_type="alert", entity_id=a.id, summary=a.title,
                       changes={"resolution_kind": kind, "resolution_note": a.resolution_note},
                       ip_address=actor.ip_address)
    await db.commit()
    return a


def alert_query(
    *, actor_id: uuid.UUID, q: str | None = None, status_: list[str] | None = None, severity: list[str] | None = None,
    rule_key: list[str] | None = None, owner: list[str] | None = None, related_type: str | None = None,
    related_id: uuid.UUID | None = None, skip: set[str] = frozenset(),
) -> Select:
    from app.common.query import apply_search, in_filter

    stmt = select(Alert).where(Alert.deleted_at.is_(None))
    stmt = apply_search(stmt, q, [Alert.title, Alert.reason, Alert.related_label])
    if "status" not in skip:
        stmt = in_filter(stmt, Alert.status, status_)
    if "severity" not in skip:
        stmt = in_filter(stmt, Alert.severity, severity)
    if "rule_key" not in skip:
        stmt = in_filter(stmt, Alert.rule_key, rule_key)
    if owner:
        ids = []
        for o in owner:
            if o == "me":
                ids.append(actor_id)
            else:
                try:
                    ids.append(uuid.UUID(o))
                except ValueError:
                    continue
        if ids:
            stmt = stmt.where(Alert.owner_id.in_(ids))
    if related_type:
        stmt = stmt.where(Alert.related_type == related_type)
    if related_id:
        stmt = stmt.where(Alert.related_id == related_id)
    return stmt


async def alert_summary(db: AsyncSession, user_id: uuid.UUID) -> dict:
    rows = await db.execute(
        select(Alert.severity, func.count()).where(
            Alert.deleted_at.is_(None), Alert.status != "resolved",
            or_(Alert.owner_id == user_id, Alert.owner_id.is_(None)),
        ).group_by(Alert.severity)
    )
    counts = {k: int(v) for k, v in rows.all()}
    return {"open": sum(counts.values()), "critical": counts.get("critical", 0)}


async def noise_metrics(db: AsyncSession, since_days: int = 90) -> list[dict]:
    """Alert fatigue monitoring: how often each rule's alerts are dismissed as noise vs actioned."""
    since = utcnow() - timedelta(days=since_days)
    rows = await db.execute(
        select(
            Alert.rule_key, Alert.status, Alert.resolution_kind, func.count(),
            func.avg(func.extract("epoch", Alert.resolved_at - Alert.created_at)),
        )
        .where(Alert.deleted_at.is_(None), Alert.created_at >= since)
        .group_by(Alert.rule_key, Alert.status, Alert.resolution_kind)
    )
    agg: dict[str, dict] = {}
    for rule_key, st, kind, count, avg_secs in rows.all():
        key = rule_key or "manual"
        r = agg.setdefault(key, {"rule_key": key, "total": 0, "open": 0, "actioned": 0, "dismissed": 0,
                                 "_secs": 0.0, "_resolved": 0})
        r["total"] += count
        if st != "resolved":
            r["open"] += count
        elif kind == "actioned":
            r["actioned"] += count
        else:
            r["dismissed"] += count
        if st == "resolved" and avg_secs is not None:
            r["_secs"] += float(avg_secs) * count
            r["_resolved"] += count
    out = []
    for r in agg.values():
        resolved = r.pop("_resolved")
        secs = r.pop("_secs")
        r["dismiss_rate"] = round(r["dismissed"] / resolved, 3) if resolved else 0.0
        r["avg_hours_to_resolve"] = round(secs / resolved / 3600, 1) if resolved else None
        out.append(r)
    return sorted(out, key=lambda r: (-r["dismiss_rate"], -r["total"]))


# --------------------------------------------------------------------------- escalation

async def run_escalations(db: AsyncSession, *, actor=None, dry_run: bool = False) -> dict:
    """Escalates overdue tasks and unacknowledged alerts one level per configured interval. Idempotent."""
    enabled, th = await rule_config(db, "tasks.escalation")
    if not enabled:
        return {"dry_run": dry_run, "skipped": True}
    now = utcnow()
    task_hours = max(1.0, float(th.get("task_overdue_hours", 24)))
    alert_hours: dict = th.get("alert_unacknowledged_hours") or {}
    max_level = int(th.get("max_level", 2))
    notify = bool(th.get("notify_manager", True))
    result = {"dry_run": dry_run, "skipped": False, "tasks_escalated": 0, "alerts_escalated": 0,
              "managers_notified": 0, "items": []}
    try:
        tasks = list(await db.scalars(select(Task).where(
            Task.deleted_at.is_(None), Task.status.in_(OPEN_TASK), Task.due_at.is_not(None),
            Task.due_at < now - timedelta(hours=task_hours), Task.escalation_level < max_level,
        )))
        for t in tasks:
            level = t.escalation_level or 0
            target = min(max_level, int((now - t.due_at).total_seconds() / 3600 // task_hours))
            if target <= level:
                continue
            new_priority = _bump(TASK_PRIORITIES, t.priority, target - level)
            result["items"].append({"kind": "task", "id": str(t.id), "title": t.title, "level": target,
                                    "priority": {"from": t.priority, "to": new_priority}})
            result["tasks_escalated"] += 1
            if dry_run:
                continue
            t.priority, t.escalation_level, t.escalated_at = new_priority, target, now
            await audit.record(db, actor=actor, action="task.escalated", entity_type="task", entity_id=t.id,
                               summary=f"Escalation level {target}", changes={"priority": new_priority})
            manager = await _manager_of(db, t.assignee_id) if notify else None
            if manager:
                await raise_alert(
                    db, title=f"Overdue task escalated: {t.title}",
                    reason=f"Task has been overdue since {t.due_at:%b %d, %Y %H:%M} UTC (escalation level {target}).",
                    severity="high" if target >= max_level else "medium", owner_id=manager, related_type="task",
                    related_id=t.id, related_label=t.title, rule_key="tasks.escalation",
                    idempotency_key=f"escalation:task:{t.id}:{target}",
                )
                result["managers_notified"] += 1

        alerts = list(await db.scalars(select(Alert).where(
            Alert.deleted_at.is_(None), Alert.status == "open", Alert.escalation_level < max_level,
            or_(Alert.rule_key.is_(None), Alert.rule_key != "tasks.escalation"),
        )))
        for a in alerts:
            level = a.escalation_level or 0
            hours = float(alert_hours.get(a.severity, 48) or 48)
            if (now - a.created_at).total_seconds() / 3600 < hours * (level + 1):
                continue
            new_sev = _bump(ALERT_SEVERITIES, a.severity, 1)
            result["items"].append({"kind": "alert", "id": str(a.id), "title": a.title, "level": level + 1,
                                    "severity": {"from": a.severity, "to": new_sev}})
            result["alerts_escalated"] += 1
            if dry_run:
                continue
            a.severity, a.escalation_level, a.escalated_at = new_sev, level + 1, now
            await audit.record(db, actor=actor, action="alert.escalated", entity_type="alert", entity_id=a.id,
                               summary=f"Escalation level {level + 1}", changes={"severity": new_sev})
            manager = await _manager_of(db, a.owner_id) if notify else None
            if manager:
                await raise_alert(
                    db, title=f"Unacknowledged alert escalated: {a.title}",
                    reason=f"Alert open without acknowledgement since {a.created_at:%b %d, %Y %H:%M} UTC. "
                           f"Original reason: {a.reason}",
                    severity=new_sev, owner_id=manager, related_type=a.related_type, related_id=a.related_id,
                    related_label=a.related_label, rule_key="tasks.escalation",
                    idempotency_key=f"escalation:alert:{a.id}:{level + 1}",
                )
                result["managers_notified"] += 1
        if not dry_run:
            await record_rule_run(db, "tasks.escalation")
            await db.commit()
    except Exception as exc:  # observable failure: counted on the rule, then re-raised
        await db.rollback()
        await record_rule_run(db, "tasks.escalation", error=f"{type(exc).__name__}: {exc}")
        await db.commit()
        raise
    return result


# --------------------------------------------------------------------------- subscriptions & digest

_SEV_RANK = {s: i for i, s in enumerate(ALERT_SEVERITIES)}


def _property_filters_from_params(params: dict):
    """Rebuilds properties list filters from a saved view's URL params."""
    from app.modules.properties.service import PropertyFilters

    kwargs: dict = {}
    for f in dc_fields(PropertyFilters):
        if f.name not in params:
            continue
        raw = params[f.name]
        values = raw if isinstance(raw, list) else [raw]
        t = str(f.type)
        try:
            if "list" in t:
                kwargs[f.name] = [uuid.UUID(str(v)) if "UUID" in t else str(v) for v in values]
            elif "float" in t:
                kwargs[f.name] = float(values[0])
            elif "int" in t:
                kwargs[f.name] = int(values[0])
            else:
                kwargs[f.name] = str(values[0])
        except (TypeError, ValueError):
            continue
    return PropertyFilters(**kwargs)


async def _alert_property_id(db: AsyncSession, a: Alert) -> uuid.UUID | None:
    if a.related_type == "property":
        return a.related_id
    if a.related_type == "opportunity" and a.related_id:
        try:
            from app.modules.pipeline.models import Opportunity
        except ImportError:
            return None
        return await db.scalar(select(Opportunity.property_id).where(Opportunity.id == a.related_id))
    return None


async def alert_matches(db: AsyncSession, sub: AlertSubscription, a: Alert) -> bool:
    from app.core.database import Base
    from app.modules.properties.models import Property

    if sub.rule_keys and a.rule_key not in sub.rule_keys:
        return False
    if _SEV_RANK.get(a.severity, 0) < _SEV_RANK.get(sub.min_severity, 0):
        return False
    if sub.owner_id and a.owner_id != sub.owner_id:
        return False
    if not (sub.property_types or sub.territory_id or sub.saved_view_id or sub.tenant):
        return True
    pid = await _alert_property_id(db, a)
    if pid is None:
        return False
    if sub.property_types:
        ptype = await db.scalar(select(Property.property_type).where(Property.id == pid))
        if ptype not in sub.property_types:
            return False
    if sub.territory_id:
        members = Base.metadata.tables.get("territory_members")
        if members is None or not await db.scalar(select(func.count()).select_from(members).where(
                members.c.territory_id == sub.territory_id, members.c.property_id == pid)):
            return False
    if sub.tenant:
        spaces = Base.metadata.tables.get("spaces")
        if spaces is None or not await db.scalar(select(func.count()).select_from(spaces).where(
                spaces.c.property_id == pid, spaces.c.tenant_name.ilike(f"%{sub.tenant}%"))):
            return False
    if sub.saved_view_id:
        from app.modules.properties.service import build_query
        from app.modules.search.models import SavedView

        view = await db.get(SavedView, sub.saved_view_id)
        if not view or view.deleted_at or view.module != "properties":
            return False
        stmt = build_query(_property_filters_from_params(view.params or {})).where(Property.id == pid)
        if not await db.scalar(select(func.count()).select_from(stmt.subquery())):
            return False
    return True


async def subscribed_alerts(db: AsyncSession, user_id: uuid.UUID, *, since: datetime, limit: int = 100) -> list[Alert]:
    subs = list(await db.scalars(select(AlertSubscription).where(
        AlertSubscription.subscriber_id == user_id, AlertSubscription.is_active.is_(True),
        AlertSubscription.deleted_at.is_(None))))
    if not subs:
        return []
    candidates = list(await db.scalars(
        select(Alert).where(Alert.deleted_at.is_(None), Alert.created_at >= since,
                            or_(Alert.owner_id.is_(None), Alert.owner_id != user_id))
        .order_by(Alert.created_at.desc()).limit(500)
    ))
    out = []
    for a in candidates:
        for s in subs:
            if await alert_matches(db, s, a):
                out.append(a)
                break
        if len(out) >= limit:
            break
    return out


async def digest(db: AsyncSession, user_id: uuid.UUID) -> dict:
    now = utcnow()
    _, end = day_bounds(now)
    base = select(Task).where(Task.deleted_at.is_(None), Task.assignee_id == user_id, Task.status.in_(OPEN_TASK))
    due_today = list(await db.scalars(base.where(Task.due_at >= now, Task.due_at < end).order_by(Task.due_at)))
    overdue = list(await db.scalars(base.where(Task.due_at < now).order_by(Task.due_at).limit(100)))
    since = now - timedelta(hours=24)
    new_alerts = list(await db.scalars(
        select(Alert).where(Alert.deleted_at.is_(None), Alert.owner_id == user_id, Alert.status != "resolved",
                            or_(Alert.created_at >= since, and_(Alert.escalated_at.is_not(None), Alert.escalated_at >= since)))
        .order_by(Alert.created_at.desc()).limit(100)
    ))
    subscribed = await subscribed_alerts(db, user_id, since=since, limit=50)
    return {
        "generated_at": now,
        "due_today": await task_outs(db, due_today),
        "overdue": await task_outs(db, overdue),
        "new_alerts": await alert_outs(db, new_alerts),
        "subscribed_alerts": await alert_outs(db, subscribed),
    }
