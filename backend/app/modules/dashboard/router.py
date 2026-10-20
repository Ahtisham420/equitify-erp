"""Executive / acquisitions command center (spec module 34, Release 1 scope).

Every metric carries an `href` that drills to the exact list of records behind the number.
Sources from other modules are optional: a missing module or permission simply omits its block.
"""
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import DB, CurrentUser, require
from app.core.security import utcnow

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

ACTIVE_STAGES = ["sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
                 "under_contract", "due_diligence", "closing"]


class Metric(BaseModel):
    label: str
    value: float
    href: str | None = None
    hint: str | None = None
    tone: str | None = None


class Bucket(BaseModel):
    key: str
    label: str
    value: float
    href: str | None = None


class Overview(BaseModel):
    generated_at: datetime
    headline: list[Metric]
    pipeline_by_stage: list[Bucket] = []
    properties_by_status: list[Bucket] = []
    interactions_by_day: list[Bucket] = []
    buybox_results: list[Bucket] = []


async def _properties(db: AsyncSession, out: Overview) -> None:
    from app.modules.properties.models import Property

    live = Property.deleted_at.is_(None)
    total = await db.scalar(select(func.count()).where(live)) or 0
    since = utcnow() - timedelta(days=30)
    new = await db.scalar(select(func.count()).where(live, Property.created_at >= since)) or 0
    avg = await db.scalar(select(func.avg(Property.completeness_score)).where(live)) or 0
    out.headline += [
        Metric(label="Properties tracked", value=total, href="/properties", hint=f"{new} added in 30 days"),
        Metric(label="Avg. data completeness", value=round(float(avg), 1), href="/data-quality",
               tone="caution" if avg < 60 else None),
    ]
    rows = await db.execute(select(Property.status, func.count()).where(live).group_by(Property.status))
    out.properties_by_status = [
        Bucket(key=s, label=s, value=c, href=f"/properties?status={s}") for s, c in rows.all()
    ]


async def _pipeline(db: AsyncSession, out: Overview) -> None:
    try:
        from app.modules.pipeline.models import Opportunity
    except ImportError:
        return
    live = Opportunity.deleted_at.is_(None)
    rows = dict((await db.execute(
        select(Opportunity.stage, func.count()).where(live).group_by(Opportunity.stage)
    )).all())
    out.pipeline_by_stage = [
        Bucket(key=s, label=s, value=rows.get(s, 0), href=f"/pipeline?view=table&stage={s}") for s in ACTIVE_STAGES
    ]
    active = sum(rows.get(s, 0) for s in ACTIVE_STAGES)
    stalled = await db.scalar(
        select(func.count()).where(live, Opportunity.stage.in_(ACTIVE_STAGES),
                                   Opportunity.stage_entered_at < utcnow() - timedelta(days=14))
    ) or 0
    out.headline += [
        Metric(label="Active opportunities", value=active, href="/pipeline"),
        Metric(label="Stalled > 14 days", value=stalled, href="/pipeline?view=table&stalled=true",
               tone="negative" if stalled else None),
    ]


async def _work(db: AsyncSession, out: Overview, user: CurrentUser) -> None:
    from app.modules.tasks.models import Alert, Task

    open_states = Task.status.in_(["open", "in_progress"])
    mine = and_(Task.deleted_at.is_(None), Task.assignee_id == user.id, open_states)
    overdue = await db.scalar(select(func.count()).where(mine, Task.due_at < utcnow())) or 0
    end_of_day = datetime.combine(date.today(), datetime.max.time()).astimezone()
    due_today = await db.scalar(
        select(func.count()).where(mine, Task.due_at >= utcnow(), Task.due_at <= end_of_day)
    ) or 0
    critical = await db.scalar(
        select(func.count()).where(Alert.deleted_at.is_(None), Alert.status != "resolved",
                                   Alert.severity.in_(["high", "critical"]))
    ) or 0
    out.headline += [
        Metric(label="My overdue tasks", value=overdue, href="/tasks?assignee=me&due=overdue", tone="negative" if overdue else None),
        Metric(label="Due today", value=due_today, href="/tasks?assignee=me&due=today"),
        Metric(label="High-severity alerts", value=critical, href="/tasks?tab=alerts&severity=high&severity=critical",
               tone="caution" if critical else None),
    ]


async def _outreach(db: AsyncSession, out: Overview) -> None:
    try:
        from app.modules.outreach.models import Interaction
    except ImportError:
        return
    start = date.today() - timedelta(days=13)
    day = func.date(Interaction.occurred_at)
    rows = dict((await db.execute(
        select(day, func.count()).where(Interaction.occurred_at >= datetime.combine(start, datetime.min.time()).astimezone())
        .group_by(day)
    )).all())
    out.interactions_by_day = [
        Bucket(key=(d := start + timedelta(days=i)).isoformat(), label=d.strftime("%b %d"), value=rows.get(d, 0),
               href=f"/interactions?date_from={d.isoformat()}&date_to={d.isoformat()}")
        for i in range(14)
    ]


async def _buybox(db: AsyncSession, out: Overview) -> None:
    try:
        from app.modules.buybox.models import BuyboxEvaluation
    except ImportError:
        return
    rows = await db.execute(
        select(BuyboxEvaluation.result, func.count(func.distinct(BuyboxEvaluation.property_id)))
        .where(BuyboxEvaluation.is_current.is_(True)).group_by(BuyboxEvaluation.result)
    )
    out.buybox_results = [Bucket(key=r, label=r, value=c, href=f"/buy-boxes?result={r}") for r, c in rows.all()]


@router.get("/overview", response_model=Overview)
async def overview(db: DB, user: CurrentUser = Depends(require("dashboard", "view"))):
    out = Overview(generated_at=utcnow(), headline=[])
    if user.can("properties", "view"):
        await _properties(db, out)
    if user.can("pipeline", "view"):
        await _pipeline(db, out)
    if user.can("tasks", "view"):
        await _work(db, out, user)
    if user.can("outreach", "view"):
        await _outreach(db, out)
    if user.can("buybox", "view"):
        await _buybox(db, out)
    return out
