import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.common import audit
from app.common.query import ListParams, Page, apply_sort, facet_counts, paginate
from app.core.deps import DB, CurrentUser, require
from app.core.security import utcnow
from app.modules.tasks import service
from app.modules.tasks.models import (
    ALERT_RESOLUTIONS,
    ALERT_SEVERITIES,
    ALERT_STATUSES,
    SUBSCRIPTION_CHANNELS,
    TASK_PRIORITIES,
    TASK_STATUSES,
    TASK_TYPES,
    Alert,
    AlertSubscription,
    Task,
)
from app.modules.tasks.schemas import (
    AlertAckIn,
    AlertFacets,
    AlertOut,
    AlertResolveIn,
    AlertSummary,
    CancelIn,
    DigestOut,
    EscalationResult,
    NoiseRow,
    ResolutionIn,
    RuleOut,
    RuleUpdate,
    SubscriptionIn,
    SubscriptionOut,
    TaskCreate,
    TaskFacets,
    TaskOut,
    TaskUpdate,
)

router = APIRouter(tags=["tasks"])

TASK_SORTS = {
    "title": Task.title, "due_at": Task.due_at, "priority": Task.priority, "status": Task.status,
    "task_type": Task.task_type, "created_at": Task.created_at, "updated_at": Task.updated_at,
}
ALERT_SORTS = {"created_at": Alert.created_at, "severity": Alert.severity, "status": Alert.status, "title": Alert.title,
               "due_at": Alert.due_at}


def _admin(user: CurrentUser) -> None:
    if not user.is_admin:
        raise HTTPException(403, "Only administrators can change automations")


# --------------------------------------------------------------------------- tasks

class TaskFilters:
    def __init__(
        self,
        q: str | None = Query(None, max_length=200),
        status: list[str] | None = Query(None),
        priority: list[str] | None = Query(None),
        task_type: list[str] | None = Query(None),
        assignee: list[str] | None = Query(None, description="User ids, 'me' or 'none'"),
        due: str | None = Query(None, pattern="^(overdue|today|this_week|none)$"),
        related_type: str | None = None,
        related_id: uuid.UUID | None = None,
    ):
        self.kw = dict(q=q, status_=status, priority=priority, task_type=task_type, assignee=assignee, due=due,
                       related_type=related_type, related_id=related_id)


@router.get("/tasks", response_model=Page[TaskOut])
async def list_tasks(db: DB, params: ListParams = Depends(), f: TaskFilters = Depends(),
                     user: CurrentUser = Depends(require("tasks", "view"))):
    default = Task.due_at.asc().nulls_last()
    stmt = apply_sort(service.task_query(actor_id=user.id, **f.kw), params.sort, TASK_SORTS, default)
    items, total = await paginate(db, stmt, params)
    return Page[TaskOut](items=await service.task_outs(db, items), total=total, page=params.page, page_size=params.page_size)


@router.get("/tasks/facets", response_model=TaskFacets)
async def task_facets(db: DB, f: TaskFilters = Depends(), user: CurrentUser = Depends(require("tasks", "view"))):
    def q(skip: str):
        return service.task_query(actor_id=user.id, skip={skip}, **f.kw)

    return TaskFacets(
        status=await facet_counts(db, q("status"), Task.status),
        priority=await facet_counts(db, q("priority"), Task.priority),
        task_type=await facet_counts(db, q("task_type"), Task.task_type),
    )


@router.get("/tasks/meta")
async def task_meta(_: CurrentUser = Depends(require("tasks", "view"))):
    return {"statuses": TASK_STATUSES, "priorities": TASK_PRIORITIES, "types": TASK_TYPES,
            "severities": ALERT_SEVERITIES, "alert_statuses": ALERT_STATUSES, "resolutions": ALERT_RESOLUTIONS,
            "channels": SUBSCRIPTION_CHANNELS}


@router.get("/tasks/digest", response_model=DigestOut)
async def task_digest(db: DB, user: CurrentUser = Depends(require("tasks", "view"))):
    """Daily digest data for the current user: due today, overdue, new and subscribed alerts."""
    return await service.digest(db, user.id)


@router.post("/tasks", response_model=TaskOut, status_code=201)
async def create_task(body: TaskCreate, db: DB, user: CurrentUser = Depends(require("tasks", "create"))):
    t = await service.create(db, body, user)
    return (await service.task_outs(db, [t], with_dependencies=True))[0]


@router.get("/tasks/{task_id}", response_model=TaskOut)
async def get_task(task_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("tasks", "view"))):
    return (await service.task_outs(db, [await service.get_task(db, task_id)], with_dependencies=True))[0]


@router.patch("/tasks/{task_id}", response_model=TaskOut)
async def update_task(task_id: uuid.UUID, body: TaskUpdate, db: DB, user: CurrentUser = Depends(require("tasks", "edit"))):
    t = await service.update(db, await service.get_task(db, task_id), body, user)
    return (await service.task_outs(db, [t], with_dependencies=True))[0]


@router.post("/tasks/{task_id}/complete", response_model=TaskOut)
async def complete_task(task_id: uuid.UUID, body: ResolutionIn, db: DB,
                        user: CurrentUser = Depends(require("tasks", "edit"))):
    t = await service.complete(db, await service.get_task(db, task_id), body.note, user)
    return (await service.task_outs(db, [t], with_dependencies=True))[0]


@router.post("/tasks/{task_id}/cancel", response_model=TaskOut)
async def cancel_task(task_id: uuid.UUID, body: CancelIn, db: DB, user: CurrentUser = Depends(require("tasks", "edit"))):
    t = await service.cancel(db, await service.get_task(db, task_id), body.note, user)
    return (await service.task_outs(db, [t], with_dependencies=True))[0]


@router.post("/tasks/{task_id}/reopen", response_model=TaskOut)
async def reopen_task(task_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("tasks", "edit"))):
    t = await service.reopen(db, await service.get_task(db, task_id), user)
    return (await service.task_outs(db, [t], with_dependencies=True))[0]


@router.delete("/tasks/{task_id}", status_code=204)
async def archive_task(task_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("tasks", "delete"))):
    await service.archive(db, await service.get_task(db, task_id), user)


# --------------------------------------------------------------------------- alerts

class AlertFilters:
    def __init__(
        self,
        q: str | None = Query(None, max_length=200),
        status: list[str] | None = Query(None),
        severity: list[str] | None = Query(None),
        rule_key: list[str] | None = Query(None),
        owner: list[str] | None = Query(None, description="User ids or 'me'"),
        related_type: str | None = None,
        related_id: uuid.UUID | None = None,
        subscribed: bool = False,
    ):
        self.subscribed = subscribed
        self.kw = dict(q=q, status_=status, severity=severity, rule_key=rule_key, owner=owner,
                       related_type=related_type, related_id=related_id)


async def _alert_stmt(db, f: AlertFilters, user: CurrentUser, skip: set[str] = frozenset()):
    stmt = service.alert_query(actor_id=user.id, skip=skip, **f.kw)
    if f.subscribed:
        matched = await service.subscribed_alerts(db, user.id, since=utcnow() - timedelta(days=30), limit=500)
        stmt = stmt.where(Alert.id.in_([a.id for a in matched] or [uuid.uuid4()]))
    return stmt


@router.get("/alerts", response_model=Page[AlertOut])
async def list_alerts(db: DB, params: ListParams = Depends(), f: AlertFilters = Depends(),
                      user: CurrentUser = Depends(require("tasks", "view"))):
    stmt = apply_sort(await _alert_stmt(db, f, user), params.sort, ALERT_SORTS, Alert.created_at.desc())
    items, total = await paginate(db, stmt, params)
    return Page[AlertOut](items=await service.alert_outs(db, items), total=total, page=params.page, page_size=params.page_size)


@router.get("/alerts/facets", response_model=AlertFacets)
async def alert_facets(db: DB, f: AlertFilters = Depends(), user: CurrentUser = Depends(require("tasks", "view"))):
    return AlertFacets(
        status=await facet_counts(db, await _alert_stmt(db, f, user, {"status"}), Alert.status),
        severity=await facet_counts(db, await _alert_stmt(db, f, user, {"severity"}), Alert.severity),
        rule_key=await facet_counts(db, await _alert_stmt(db, f, user, {"rule_key"}), Alert.rule_key),
    )


@router.get("/alerts/summary", response_model=AlertSummary)
async def alerts_summary(db: DB, user: CurrentUser = Depends(require("tasks", "view"))):
    return await service.alert_summary(db, user.id)


@router.get("/alerts/noise", response_model=list[NoiseRow])
async def alert_noise(db: DB, since_days: int = Query(90, ge=1, le=730),
                      _: CurrentUser = Depends(require("tasks", "view"))):
    """Alert-fatigue monitoring: dismissed vs actioned resolutions per automation rule."""
    return await service.noise_metrics(db, since_days)


@router.get("/alerts/{alert_id}", response_model=AlertOut)
async def get_alert(alert_id: uuid.UUID, db: DB, _: CurrentUser = Depends(require("tasks", "view"))):
    return (await service.alert_outs(db, [await service.get_alert(db, alert_id)]))[0]


@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertOut)
async def acknowledge_alert(alert_id: uuid.UUID, body: AlertAckIn, db: DB,
                            user: CurrentUser = Depends(require("tasks", "edit"))):
    a = await service.acknowledge(db, await service.get_alert(db, alert_id), body.note, user)
    return (await service.alert_outs(db, [a]))[0]


@router.post("/alerts/{alert_id}/resolve", response_model=AlertOut)
async def resolve_alert(alert_id: uuid.UUID, body: AlertResolveIn, db: DB,
                        user: CurrentUser = Depends(require("tasks", "edit"))):
    a = await service.resolve(db, await service.get_alert(db, alert_id), body.note, body.kind, user)
    return (await service.alert_outs(db, [a]))[0]


# --------------------------------------------------------------------------- automation registry

@router.get("/automation/rules", response_model=list[RuleOut])
async def list_rules(db: DB, _: CurrentUser = Depends(require("tasks", "view"))):
    rules = await service.ensure_rules(db)
    await db.commit()
    return rules


@router.patch("/automation/rules/{key}", response_model=RuleOut)
async def update_rule(key: str, body: RuleUpdate, db: DB, user: CurrentUser = Depends(require("tasks", "edit"))):
    _admin(user)
    rule = await service.get_rule(db, key)
    if not rule:
        raise HTTPException(404, "Automation rule not found")
    return await service.update_rule(db, rule, body.enabled, body.thresholds, user)


@router.post("/automation/run-escalations", response_model=EscalationResult)
async def run_escalations(db: DB, dry_run: bool = False, user: CurrentUser = Depends(require("tasks", "edit"))):
    """Run (or preview with dry_run=true) the overdue escalation automation."""
    _admin(user)
    result = await service.run_escalations(db, actor=user, dry_run=dry_run)
    if not dry_run and not result.get("skipped"):
        await audit.record(db, actor=user, action="automation_rule.run", entity_type="automation_rule",
                           summary="tasks.escalation",
                           changes={k: result[k] for k in ("tasks_escalated", "alerts_escalated", "managers_notified")},
                           ip_address=user.ip_address)
        await db.commit()
    return result


# --------------------------------------------------------------------------- subscriptions

async def _sub_outs(db, subs: list[AlertSubscription]) -> list[SubscriptionOut]:
    names = await service.user_names(db, [s.subscriber_id for s in subs])
    out = []
    for s in subs:
        o = SubscriptionOut.model_validate(s)
        o.subscriber_name = names.get(s.subscriber_id)
        out.append(o)
    return out


async def _get_sub(db, sub_id: uuid.UUID, user: CurrentUser) -> AlertSubscription:
    s = await db.get(AlertSubscription, sub_id)
    if not s or s.deleted_at:
        raise HTTPException(404, "Subscription not found")
    if s.subscriber_id != user.id and not user.is_admin:
        raise HTTPException(403, "You can only manage your own subscriptions")
    return s


@router.get("/alert-subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(db: DB, scope: str = Query("mine", pattern="^(mine|all)$"),
                             user: CurrentUser = Depends(require("tasks", "view"))):
    stmt = select(AlertSubscription).where(AlertSubscription.deleted_at.is_(None))
    if scope == "mine" or not user.is_admin:
        stmt = stmt.where(AlertSubscription.subscriber_id == user.id)
    return await _sub_outs(db, list(await db.scalars(stmt.order_by(AlertSubscription.name))))


@router.post("/alert-subscriptions", response_model=SubscriptionOut, status_code=201)
async def create_subscription(body: SubscriptionIn, db: DB, user: CurrentUser = Depends(require("tasks", "view"))):
    subscriber = body.subscriber_id or user.id
    if subscriber != user.id and not user.is_admin:
        raise HTTPException(403, "You can only subscribe yourself")
    s = AlertSubscription(**body.model_dump(exclude={"subscriber_id"}), subscriber_id=subscriber,
                          created_by_id=user.id, updated_by_id=user.id)
    db.add(s)
    await db.flush()
    await audit.record(db, actor=user, action="alert_subscription.created", entity_type="alert_subscription",
                       entity_id=s.id, summary=s.name, ip_address=user.ip_address)
    await db.commit()
    return (await _sub_outs(db, [s]))[0]


@router.patch("/alert-subscriptions/{sub_id}", response_model=SubscriptionOut)
async def update_subscription(sub_id: uuid.UUID, body: SubscriptionIn, db: DB,
                              user: CurrentUser = Depends(require("tasks", "view"))):
    s = await _get_sub(db, sub_id, user)
    data = body.model_dump(exclude={"subscriber_id"})
    changes = audit.diff(s, data)
    for k, v in data.items():
        setattr(s, k, v)
    s.updated_by_id = user.id
    if changes:
        await audit.record(db, actor=user, action="alert_subscription.updated", entity_type="alert_subscription",
                           entity_id=s.id, changes=changes, ip_address=user.ip_address)
    await db.commit()
    return (await _sub_outs(db, [s]))[0]


@router.delete("/alert-subscriptions/{sub_id}", status_code=204)
async def delete_subscription(sub_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("tasks", "view"))):
    s = await _get_sub(db, sub_id, user)
    s.deleted_at = utcnow()
    s.updated_by_id = user.id
    await audit.record(db, actor=user, action="alert_subscription.deleted", entity_type="alert_subscription",
                       entity_id=s.id, summary=s.name, ip_address=user.ip_address)
    await db.commit()

