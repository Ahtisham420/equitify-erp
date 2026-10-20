"""In-process scheduler for the periodic automations (critical dates, escalations, scans...).

Every job is idempotent (the services key their tasks/alerts), runs in its own session as the
"System Automation" service user, and takes a Postgres advisory lock so that several API workers
never run the same job concurrently. Disable with SCHEDULER_ENABLED=false on extra workers if wanted.
"""
import asyncio
import importlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import SessionLocal
from app.core.deps import CurrentUser
from app.core.security import utcnow

log = logging.getLogger("equitify.scheduler")

SYSTEM_EMAIL = "system@equitify.local"
TICK_SECONDS = 60


@dataclass
class Job:
    key: str
    every_minutes: int
    module: str  # dotted service module, imported lazily so a missing module only skips its job
    run: Callable[[Any, AsyncSession, CurrentUser], Awaitable[Any]]


def _jobs() -> list[Job]:
    def receivables_evaluate(svc, db, actor):
        from app.modules.receivables.schemas import EvaluateIn

        return svc.evaluate(db, EvaluateIn(), actor)

    return [
        Job("offers.expire", 15, "app.modules.offers.service", lambda s, db, a: s.expire_due(db, a)),
        Job("tasks.escalation", 60, "app.modules.tasks.service", lambda s, db, a: s.run_escalations(db, actor=a)),
        Job("contracts.critical_dates", 60, "app.modules.contracts.service",
            lambda s, db, a: s.scan_critical_dates(db, actor=a)),
        Job("reactivation.scan", 360, "app.modules.reactivation.service", lambda s, db, a: s.scan(db, a)),
        Job("debt.scan", 720, "app.modules.debt.service", lambda s, db, a: s.scan(db, a)),
        Job("assets.watchlist", 720, "app.modules.assets.service", lambda s, db, a: s.scan_watchlist(db, a)),
        Job("operations.scan", 720, "app.modules.operations.service", lambda s, db, a: s.run_scan(db, a)),
        Job("maintenance.pm", 720, "app.modules.maintenance.service", lambda s, db, a: s.generate_pm_work_orders(db, a)),
        Job("dealroom.compliance", 720, "app.modules.dealroom.service", lambda s, db, a: s.scan_compliance(db, a)),
        Job("receivables.delinquency", 720, "app.modules.receivables.service", receivables_evaluate),
        Job("commissions.forecast_snapshot", 1440, "app.modules.commissions.service",
            lambda s, db, a: s.ensure_snapshot(db, a)),
        Job("investors.report_schedules", 1440, "app.modules.investors.service",
            lambda s, db, a: s.run_due_schedules(db, date.today(), a)),
        Job("brokerage.seller_reports", 1440, "app.modules.brokerage.service", lambda s, db, a: s.run_due_reports(db, a)),
        Job("webhooks.deliver", 5, "app.modules.platform.service", lambda s, db, a: s.deliver_pending(db, a)),
        Job("reports.schedules", 60, "app.modules.reports.service", lambda s, db, a: s.run_due(db, a)),
        Job("reports.snapshots", 1440, "app.modules.reports.service", lambda s, db, a: s.run_snapshots(db, a)),
    ]


async def _system_actor(db: AsyncSession) -> CurrentUser | None:
    from app.modules.auth.models import Role, User

    user = await db.scalar(select(User).where(func.lower(User.email) == SYSTEM_EMAIL))
    if user is None:
        admin = await db.scalar(select(Role).where(Role.key == "admin"))
        if admin is None:
            return None
        user = User(email=SYSTEM_EMAIL, full_name="System Automation", role_id=admin.id, is_service=True,
                    job_title="Scheduled automations")
        db.add(user)
        await db.commit()
        user = await db.get(User, user.id, populate_existing=True)
    if user.status != "active":
        return None
    return CurrentUser(user=user, permissions={"*": ["*"]}, approval_limits={})


async def run_job(job: Job) -> None:
    try:
        svc = importlib.import_module(job.module)
    except ImportError:
        return
    async with SessionLocal() as db:
        actor = await _system_actor(db)  # may commit on first run, so it happens before taking the lock
        if actor is None:
            return
        # Transaction-scoped: released automatically when the job's transaction commits or rolls back.
        if not await db.scalar(text("SELECT pg_try_advisory_xact_lock(hashtext(:k))"), {"k": job.key}):
            return
        started = utcnow()
        try:
            result = await job.run(svc, db, actor)
            await db.commit()
            log.info("job %s ok in %.1fs: %s", job.key, (utcnow() - started).total_seconds(), _short(result))
        except Exception:
            await db.rollback()
            log.exception("job %s failed", job.key)


def _short(result: Any) -> str:
    text_ = repr(result)
    return text_ if len(text_) < 300 else text_[:300] + "..."


async def scheduler_loop(stop: asyncio.Event) -> None:
    jobs = _jobs()
    last_run: dict[str, float] = {}
    loop = asyncio.get_running_loop()
    # Give the app a moment to finish startup before the first pass.
    try:
        await asyncio.wait_for(stop.wait(), timeout=30)
        return
    except asyncio.TimeoutError:
        pass
    while not stop.is_set():
        now = loop.time()
        for job in jobs:
            if now - last_run.get(job.key, -1e12) >= job.every_minutes * 60:
                last_run[job.key] = now
                try:
                    await run_job(job)
                except Exception:  # e.g. DB unreachable in _system_actor: never let one failure kill the loop
                    log.exception("job %s could not start", job.key)
        try:
            await asyncio.wait_for(stop.wait(), timeout=TICK_SECONDS)
        except asyncio.TimeoutError:
            pass
