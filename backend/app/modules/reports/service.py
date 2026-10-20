"""Reports service: context resolution, filter options, metric snapshots and scheduled report runs."""
import calendar
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.core.config import settings
from app.core.deps import CurrentUser
from app.core.security import utcnow
from app.modules.reports.dashboards import DASHBOARDS, build, dashboard_csv
from app.modules.reports.engine import Ctx, Filters, available, evaluate, load, safe
from app.modules.reports.kpis import REGISTRY
from app.modules.reports.models import MetricSnapshot, ReportRun, ReportSchedule
from app.modules.reports.schemas import (
    FilterOption, FilterOptions, RunDueOut, RunOut, ScheduleIn, ScheduleOut, ScheduleUpdate, SnapshotRunOut,
)

STORAGE = Path(settings.STORAGE_DIR) / "reports"


# ============================================================================ context


async def resolve_ctx(db: AsyncSession, user: CurrentUser, f: Filters) -> Ctx:
    """Territory filters only apply to territories the user may see."""
    if f.territory:
        T = load("territories.models:Territory")
        vis = load("territories.service:visible_clause")
        if T is not None and vis is not None:
            ok = await db.scalar(select(T.id).where(T.id == f.territory, T.deleted_at.is_(None), vis(user)))
            if not ok:
                raise HTTPException(404, "Territory not found")
    return Ctx(user=user, f=f)


async def filter_options(db: AsyncSession, user: CurrentUser) -> FilterOptions:
    User, Team = load("auth.models:User"), load("auth.models:Team")
    users = (await db.execute(select(User.id, User.full_name).where(
        User.deleted_at.is_(None), User.status == "active", User.is_service.is_(False)).order_by(User.full_name))).all()
    teams = (await db.execute(select(Team.id, Team.name).where(Team.deleted_at.is_(None)).order_by(Team.name))).all()

    territories: list = []
    T, vis = load("territories.models:Territory"), load("territories.service:visible_clause")
    if T is not None and vis is not None and user.can("territories", "view"):
        async def q_territories(d):
            return (await d.execute(select(T.id, T.name).where(T.deleted_at.is_(None), vis(user))
                                    .order_by(T.name).limit(500))).all()
        territories = await safe(db, q_territories) or []

    states: list = []
    P = load("properties.models:Property")
    if user.can("properties", "view"):
        async def q_states(d):
            return (await d.execute(select(P.state).where(P.deleted_at.is_(None), P.state.is_not(None))
                                    .distinct().order_by(P.state))).all()
        states = [s for (s,) in await safe(db, q_states) or []]

    sources: set[str] = set()
    O, DS = load("pipeline.models:Opportunity"), load("imports.models:DataSource")
    if O is not None and user.can("pipeline", "view"):
        async def q_opp_sources(d):
            return (await d.execute(select(O.source).where(O.source.is_not(None)).distinct().limit(300))).all()
        sources.update(s for (s,) in await safe(db, q_opp_sources) or [] if s)
    if DS is not None and user.can("imports", "view"):
        async def q_providers(d):
            return (await d.execute(select(DS.provider).where(DS.deleted_at.is_(None)).distinct())).all()
        sources.update(s for (s,) in await safe(db, q_providers) or [] if s)

    types = load("properties.models:PROPERTY_TYPES") or []
    stages: list[str] = []
    for ref in ("pipeline.models:STAGES", "brokerage.models:DEAL_STAGES"):
        for s in load(ref) or []:
            if s not in stages:
                stages.append(s)
    return FilterOptions(
        users=[FilterOption(value="me", label="Me")] + [FilterOption(value=str(i), label=n) for i, n in users],
        teams=[FilterOption(value=str(i), label=n) for i, n in teams],
        territories=[FilterOption(value=str(i), label=n) for i, n in territories],
        property_types=[FilterOption(value=t, label=t) for t in types],
        states=[FilterOption(value=s, label=s) for s in states],
        sources=[FilterOption(value=s, label=s) for s in sorted(sources, key=str.lower)],
        stages=[FilterOption(value=s, label=s) for s in stages],
    )


# ============================================================================ snapshots


async def run_snapshots(db: AsyncSession, actor: CurrentUser) -> SnapshotRunOut:
    """Record today's value of every KPI the actor can see (no filters). Existing snapshots are kept."""
    c = Ctx(user=actor, f=Filters())
    today = c.today
    existing = set(await db.scalars(select(MetricSnapshot.kpi_key).where(
        MetricSnapshot.as_of == today, MetricSnapshot.dims_key == "")))
    created = skipped = 0
    failed: list[str] = []
    for k in REGISTRY.values():
        if not available(k, actor):
            continue
        if k.key in existing:
            skipped += 1
            continue
        res = await safe(db, lambda d, k=k: evaluate(d, k, c))
        if res is None:
            failed.append(k.key)
            continue
        db.add(MetricSnapshot(kpi_key=k.key, as_of=today, value=res[0], dims={}, dims_key="", created_by_id=actor.id))
        created += 1
    await audit.record(db, actor=actor, action="report.snapshots_run", entity_type="metric_snapshot",
                       summary=f"{created} KPI snapshots for {today.isoformat()}",
                       changes={"created": created, "skipped": skipped, "failed": failed},
                       ip_address=actor.ip_address)
    await db.commit()
    return SnapshotRunOut(as_of=today, created=created, skipped=skipped, failed=failed)


async def history(db: AsyncSession, kpi_key: str) -> list[MetricSnapshot]:
    rows = await db.scalars(select(MetricSnapshot).where(MetricSnapshot.kpi_key == kpi_key, MetricSnapshot.dims_key == "")
                            .order_by(MetricSnapshot.as_of.desc()).limit(400))
    return list(reversed(list(rows)))


# ============================================================================ schedules


def advance(dt: datetime, cadence: str) -> datetime:
    if cadence == "daily":
        return dt + timedelta(days=1)
    if cadence == "weekly":
        return dt + timedelta(days=7)
    month = dt.month % 12 + 1
    year = dt.year + (dt.month == 12)
    return dt.replace(year=year, month=month, day=min(dt.day, calendar.monthrange(year, month)[1]))


def next_run(prev: datetime | None, cadence: str, now: datetime) -> datetime:
    nxt = advance(prev or now, cadence)
    while nxt <= now:
        nxt = advance(nxt, cadence)
    return nxt


def _can_manage(s: ReportSchedule, user: CurrentUser) -> bool:
    return s.owner_id == user.id or user.can("reports", "approve")


async def _names(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    User = load("auth.models:User")
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())


async def schedule_out(db: AsyncSession, s: ReportSchedule) -> ScheduleOut:
    names = await _names(db, list(s.recipient_ids or []) + ([s.owner_id] if s.owner_id else []))
    d = DASHBOARDS.get(s.dashboard_key)
    return ScheduleOut.model_validate(s).model_copy(update={
        "dashboard_label": d.label if d else s.dashboard_key,
        "recipient_names": [names.get(r, "Unknown user") for r in s.recipient_ids or []],
        "owner_name": names.get(s.owner_id) if s.owner_id else None,
    })


async def _validate_recipients(db: AsyncSession, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    User = load("auth.models:User")
    unique = list(dict.fromkeys(ids))
    found = set(await db.scalars(select(User.id).where(User.id.in_(unique), User.deleted_at.is_(None),
                                                         User.status == "active")))
    missing = [str(i) for i in unique if i not in found]
    if missing:
        raise HTTPException(422, f"Unknown or inactive recipients: {', '.join(missing)}")
    return unique


async def list_schedules(db: AsyncSession, user: CurrentUser) -> list[ScheduleOut]:
    stmt = select(ReportSchedule).where(ReportSchedule.deleted_at.is_(None))
    if not user.can("reports", "approve"):
        stmt = stmt.where(or_(ReportSchedule.owner_id == user.id, ReportSchedule.recipient_ids.any(user.id)))
    return [await schedule_out(db, s) for s in await db.scalars(stmt.order_by(ReportSchedule.created_at.desc()))]


async def get_schedule(db: AsyncSession, schedule_id: uuid.UUID, user: CurrentUser) -> ReportSchedule:
    s = await db.get(ReportSchedule, schedule_id)
    if not s or s.deleted_at or not _can_manage(s, user):
        raise HTTPException(404, "Schedule not found")
    return s


async def create_schedule(db: AsyncSession, body: ScheduleIn, actor: CurrentUser) -> ScheduleOut:
    if body.dashboard_key not in DASHBOARDS:
        raise HTTPException(422, "Unknown dashboard")
    filters = Filters.from_dict(body.filters).to_dict()
    recipients = await _validate_recipients(db, body.recipient_ids or [actor.id])
    s = ReportSchedule(
        name=body.name, dashboard_key=body.dashboard_key, filters=filters, cadence=body.cadence,
        recipient_ids=recipients, format=body.format, is_active=body.is_active, notes=body.notes,
        owner_id=actor.id, next_run_at=utcnow(), created_by_id=actor.id, updated_by_id=actor.id,
    )
    db.add(s)
    await db.flush()
    await audit.record(db, actor=actor, action="report_schedule.created", entity_type="report_schedule",
                       entity_id=s.id, summary=f"Scheduled {body.dashboard_key} ({body.cadence})",
                       changes=body.model_dump(mode="json"), ip_address=actor.ip_address)
    await db.commit()
    return await schedule_out(db, s)


async def update_schedule(db: AsyncSession, s: ReportSchedule, body: ScheduleUpdate, actor: CurrentUser) -> ScheduleOut:
    values = body.model_dump(exclude_unset=True)
    if "filters" in values and values["filters"] is not None:
        values["filters"] = Filters.from_dict(values["filters"]).to_dict()
    if values.get("recipient_ids") is not None:
        values["recipient_ids"] = await _validate_recipients(db, values["recipient_ids"] or [actor.id])
    values = {k: v for k, v in values.items() if v is not None or k == "notes"}
    changes = audit.diff(s, values)
    for key, value in values.items():
        setattr(s, key, value)
    if values.get("is_active") and (not s.next_run_at or s.next_run_at < utcnow()):
        s.next_run_at = utcnow()
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="report_schedule.updated", entity_type="report_schedule",
                       entity_id=s.id, summary=s.name, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return await schedule_out(db, s)


async def delete_schedule(db: AsyncSession, s: ReportSchedule, actor: CurrentUser) -> None:
    s.deleted_at = utcnow()
    s.is_active = False
    s.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="report_schedule.deleted", entity_type="report_schedule",
                       entity_id=s.id, summary=s.name, ip_address=actor.ip_address)
    await db.commit()


async def _recipient_user(db: AsyncSession, user_id: uuid.UUID) -> CurrentUser | None:
    User = load("auth.models:User")
    u = await db.get(User, user_id)
    if not u or u.deleted_at or u.status != "active":
        return None
    return CurrentUser(user=u, permissions=u.role.permissions or {}, approval_limits=u.role.approval_limits or {})


async def _generate(db: AsyncSession, s: ReportSchedule, recipient_id: uuid.UUID, actor: CurrentUser) -> ReportRun:
    """One file per recipient, computed with the recipient's own permissions."""
    run = ReportRun(id=uuid.uuid4(), schedule_id=s.id, dashboard_key=s.dashboard_key, recipient_id=recipient_id,
                    ran_at=utcnow(), filters=s.filters or {}, run_by_id=actor.id)
    d = DASHBOARDS.get(s.dashboard_key)
    who = await _recipient_user(db, recipient_id)
    if d is None:
        run.status, run.error = "failed", "Dashboard no longer exists"
    elif who is None:
        run.status, run.error = "failed", "Recipient is inactive"
    elif not who.can("reports", "view"):
        run.status, run.error = "failed", "Recipient lacks reports access"
    else:
        try:
            out = await build(db, d, Ctx(user=who, f=Filters.from_dict(s.filters)))
            content, rows, withheld = dashboard_csv(out)
            STORAGE.mkdir(parents=True, exist_ok=True)
            key = f"reports/{run.id}.csv"
            data = content.encode("utf-8")
            (Path(settings.STORAGE_DIR) / key).write_bytes(data)
            run.status = "success"
            run.storage_key = key
            run.filename = f"{s.dashboard_key}-{run.ran_at.date().isoformat()}.csv"
            run.size_bytes, run.row_count, run.withheld_rows = len(data), rows, withheld
        except (OSError, HTTPException) as exc:
            run.status, run.error = "failed", str(exc)[:500]
    db.add(run)
    return run


async def run_due(db: AsyncSession, actor: CurrentUser) -> RunDueOut:
    now = utcnow()
    due = list(await db.scalars(select(ReportSchedule).where(
        ReportSchedule.deleted_at.is_(None), ReportSchedule.is_active.is_(True),
        ReportSchedule.next_run_at.is_not(None), ReportSchedule.next_run_at <= now)))
    runs = failed = 0
    for s in due:
        for rid in s.recipient_ids or []:
            run = await _generate(db, s, rid, actor)
            runs += 1
            failed += run.status != "success"
        s.last_run_at = now
        s.next_run_at = next_run(s.next_run_at, s.cadence, now)
        await audit.record(db, actor=actor, action="report_schedule.run", entity_type="report_schedule",
                           entity_id=s.id, summary=f"{s.name}: {len(s.recipient_ids or [])} recipient file(s)",
                           ip_address=actor.ip_address)
    await db.commit()
    return RunDueOut(schedules=len(due), runs=runs, failed=failed)


async def list_runs(db: AsyncSession, user: CurrentUser, schedule_id: uuid.UUID | None) -> list[RunOut]:
    stmt = select(ReportRun)
    if not user.is_admin:
        stmt = stmt.where(ReportRun.recipient_id == user.id)
    if schedule_id:
        stmt = stmt.where(ReportRun.schedule_id == schedule_id)
    runs = list(await db.scalars(stmt.order_by(ReportRun.ran_at.desc()).limit(200)))
    names = await _names(db, list({r.recipient_id for r in runs if r.recipient_id}))
    return [RunOut.model_validate(r).model_copy(update={"recipient_name": names.get(r.recipient_id)}) for r in runs]


async def run_file(db: AsyncSession, run_id: uuid.UUID, user: CurrentUser) -> tuple[ReportRun, bytes]:
    """Only the recipient (or an administrator) may download a run: it reflects the recipient's permissions."""
    run = await db.get(ReportRun, run_id)
    if not run or (run.recipient_id != user.id and not user.is_admin):
        raise HTTPException(404, "Report run not found")
    if run.status != "success" or not run.storage_key:
        raise HTTPException(409, "This run has no file")
    path = Path(settings.STORAGE_DIR) / run.storage_key
    if not path.is_file():
        raise HTTPException(410, "Report file is no longer available")
    await audit.record(db, actor=user, action="report_run.downloaded", entity_type="report_run", entity_id=run.id,
                       summary=run.filename, ip_address=user.ip_address)
    await db.commit()
    return run, path.read_bytes()
