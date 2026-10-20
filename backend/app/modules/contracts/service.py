"""Contracts, critical dates & due diligence (spec 16).

Public API used by other modules (lazy-import inside functions):

    from app.modules.contracts.service import upsert_critical_date, add_business_days

`upsert_critical_date` is idempotent on (related_type, related_id, key or date_type) and never commits.
AI-sourced dates are always stored as 'proposed'; a computed/AI value never overwrites a human-confirmed
date (it is parked in `proposed_due_on` for review instead).
"""
import hashlib
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import audit
from app.common.audit import AuditEvent
from app.common.query import apply_search, in_filter, range_filter
from app.core import events
from app.core.security import utcnow
from app.modules.auth.models import User
from app.modules.contracts.models import (
    CRITICAL_DATE_STATUSES,
    DD_DONE,
    EXCEPTION_OPEN,
    HIGH_SEVERITIES,
    OPEN_DATE_STATUSES,
    Contract,
    ContractDecision,
    CriticalDate,
    CriticalDateEvent,
    DDItem,
    DDTemplate,
    Estoppel,
    Holiday,
    HolidayCalendar,
    RiskItem,
    ThirdPartyReport,
    TitleException,
)
from app.modules.contracts.schemas import (
    Blocker,
    ConfirmIn,
    ContractCreate,
    ContractListItem,
    ContractOut,
    ContractStatusOut,
    ContractUpdate,
    CriticalDateCreate,
    CriticalDateOut,
    CriticalDateUpdate,
    DDItemCreate,
    DDItemOut,
    DDItemUpdate,
    DecisionCreate,
    DependencyRef,
    EstoppelCreate,
    EstoppelUpdate,
    ExecuteIn,
    ProposeOut,
    ReportCreate,
    ReportOut,
    ReportUpdate,
    RiskCreate,
    RiskDecideIn,
    RiskOut,
    RiskUpdate,
    TitleExceptionCreate,
    TitleExceptionOut,
    TitleExceptionUpdate,
)

ENTITY = "contract"
US_FEDERAL = "US_FEDERAL"


def today() -> date:
    return utcnow().date()


def _end_of_day(d: date) -> datetime:
    return datetime.combine(d, time(23, 59), tzinfo=timezone.utc)


def _uuid(value: Any) -> uuid.UUID | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


async def _user_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))
    return {r[0]: r[1] for r in rows.all()}


async def _manager_of(db: AsyncSession, user_id: uuid.UUID | None) -> uuid.UUID | None:
    if not user_id:
        return None
    return await db.scalar(select(User.manager_id).where(User.id == user_id))


async def _property_info(db: AsyncSession, ids) -> dict[uuid.UUID, tuple[str, str | None]]:
    from app.modules.properties.models import Property

    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await db.execute(
        select(Property.id, Property.name, Property.address_line, Property.property_type).where(Property.id.in_(ids))
    )
    return {r[0]: (r[1] or r[2], r[3]) for r in rows.all()}


def _apply(obj: Any, values: dict) -> dict:
    changes = audit.diff(obj, values)
    for k in changes:
        setattr(obj, k, values[k])
    return changes


# =========================================================================== holiday calendars

def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = (date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def us_federal_holidays(year: int) -> list[tuple[date, str]]:
    """Observed US federal holidays for `year` (5 U.S.C. 6103). Saturday → Friday, Sunday → Monday."""
    out: list[tuple[date, str]] = []
    fixed = [(1, 1, "New Year's Day"), (7, 4, "Independence Day"), (11, 11, "Veterans Day"), (12, 25, "Christmas Day")]
    if year >= 2021:
        fixed.append((6, 19, "Juneteenth National Independence Day"))
    for month, day, name in fixed:
        d = date(year, month, day)
        if d.weekday() == 5:
            out.append((d - timedelta(days=1), f"{name} (observed)"))
        elif d.weekday() == 6:
            out.append((d + timedelta(days=1), f"{name} (observed)"))
        else:
            out.append((d, name))
    out += [
        (_nth_weekday(year, 1, 0, 3), "Birthday of Martin Luther King, Jr."),
        (_nth_weekday(year, 2, 0, 3), "Washington's Birthday"),
        (_last_weekday(year, 5, 0), "Memorial Day"),
        (_nth_weekday(year, 9, 0, 1), "Labor Day"),
        (_nth_weekday(year, 10, 0, 2), "Columbus Day"),
        (_nth_weekday(year, 11, 3, 4), "Thanksgiving Day"),
    ]
    return sorted(out)


async def ensure_holidays(db: AsyncSession, cal: HolidayCalendar, years) -> None:
    """Seeds computed holidays for rule-based calendars for any year not yet seeded (idempotent, no commit)."""
    if cal.rule_set != "us_federal":
        return
    have = set(cal.seeded_years or [])
    missing = sorted({int(y) for y in years} - have)
    if not missing:
        return
    rows = [
        {"id": uuid.uuid4(), "calendar_id": cal.id, "holiday_on": d, "name": name, "source": "rule",
         "created_at": utcnow()}
        for y in missing for d, name in us_federal_holidays(y)
    ]
    await db.execute(pg_insert(Holiday).values(rows).on_conflict_do_nothing(index_elements=["calendar_id", "holiday_on"]))
    cal.seeded_years = sorted(have | set(missing))
    await db.flush()


async def ensure_default_calendar(db: AsyncSession) -> HolidayCalendar:
    cal = await db.scalar(select(HolidayCalendar).where(HolidayCalendar.code == US_FEDERAL))
    if cal is None:
        now = utcnow()
        await db.execute(
            pg_insert(HolidayCalendar)
            .values(id=uuid.uuid4(), code=US_FEDERAL, name="US federal holidays",
                    description="Observed US federal holidays, computed from statutory rules.",
                    weekend_days=[5, 6], is_default=True, rule_set="us_federal", seeded_years=[],
                    created_at=now, updated_at=now)
            .on_conflict_do_nothing(index_elements=["code"])
        )
        cal = await db.scalar(select(HolidayCalendar).where(HolidayCalendar.code == US_FEDERAL))
    y = today().year
    await ensure_holidays(db, cal, range(y, y + 3))
    return cal


async def get_calendar(db: AsyncSession, calendar_id: uuid.UUID | None = None) -> HolidayCalendar:
    if calendar_id:
        cal = await db.get(HolidayCalendar, calendar_id)
        if cal and not cal.deleted_at:
            return cal
    default = await db.scalar(
        select(HolidayCalendar).where(HolidayCalendar.is_default.is_(True), HolidayCalendar.deleted_at.is_(None))
        .order_by(HolidayCalendar.created_at)
    )
    return default or await ensure_default_calendar(db)


async def _holidays_between(db: AsyncSession, cal: HolidayCalendar, lo: date, hi: date) -> set[date]:
    # +1 year: a Saturday New Year's Day is observed on Dec 31 of the prior year.
    await ensure_holidays(db, cal, range(lo.year, hi.year + 2))
    rows = await db.scalars(
        select(Holiday.holiday_on).where(Holiday.calendar_id == cal.id, Holiday.holiday_on >= lo, Holiday.holiday_on <= hi)
    )
    return set(rows)


async def add_business_days(db: AsyncSession, start: date, days: int, calendar_id: uuid.UUID | None = None) -> date:
    """`start` + `days` business days (negative counts backwards). The start day itself is never counted;
    weekends and holidays of the calendar (default: US federal) are skipped. Does not commit."""
    cal = await get_calendar(db, _uuid(calendar_id))
    weekend = set(cal.weekend_days or [5, 6])
    if len(weekend) >= 7:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Calendar has no business days")
    step = 1 if days >= 0 else -1
    remaining = abs(int(days))
    span = remaining * 2 + 14
    lo, hi = sorted([start, start + timedelta(days=step * span)])
    holidays = await _holidays_between(db, cal, lo, hi)
    d = start
    while remaining > 0:
        d += timedelta(days=step)
        if d < lo or d > hi:
            lo, hi = (min(lo, d - timedelta(days=400)), max(hi, d + timedelta(days=400)))
            holidays = await _holidays_between(db, cal, lo, hi)
        if d.weekday() not in weekend and d not in holidays:
            remaining -= 1
    return d


async def create_calendar(db: AsyncSession, data, actor) -> HolidayCalendar:
    if await db.scalar(select(HolidayCalendar.id).where(HolidayCalendar.code == data.code)):
        raise HTTPException(status.HTTP_409_CONFLICT, "A calendar with this code already exists")
    weekend = sorted({int(d) for d in data.weekend_days if 0 <= int(d) <= 6})
    if len(weekend) >= 7:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A calendar needs at least one business day")
    cal = HolidayCalendar(code=data.code, name=data.name, description=data.description, weekend_days=weekend,
                          is_default=False, rule_set=None, seeded_years=[], created_by_id=actor.id, updated_by_id=actor.id)
    db.add(cal)
    await db.flush()
    if data.copy_from_id:
        src = await get_calendar(db, data.copy_from_id)
        y = today().year
        await ensure_holidays(db, src, range(y, y + 3))
        for h in await db.scalars(select(Holiday).where(Holiday.calendar_id == src.id)):
            db.add(Holiday(calendar_id=cal.id, holiday_on=h.holiday_on, name=h.name, source="manual",
                           created_by_id=actor.id))
    await audit.record(db, actor=actor, action="holiday_calendar.created", entity_type="holiday_calendar",
                       entity_id=cal.id, summary=cal.name, ip_address=actor.ip_address)
    await db.commit()
    return cal


async def list_holidays(db: AsyncSession, cal: HolidayCalendar, year: int) -> list[Holiday]:
    await ensure_holidays(db, cal, [year])
    rows = list(await db.scalars(select(Holiday).where(
        Holiday.calendar_id == cal.id, Holiday.holiday_on >= date(year, 1, 1), Holiday.holiday_on <= date(year, 12, 31)
    ).order_by(Holiday.holiday_on)))
    await db.commit()
    return rows


async def add_holiday(db: AsyncSession, cal: HolidayCalendar, holiday_on: date, name: str, actor) -> Holiday:
    await ensure_holidays(db, cal, [holiday_on.year])
    if await db.scalar(select(Holiday.id).where(Holiday.calendar_id == cal.id, Holiday.holiday_on == holiday_on)):
        raise HTTPException(status.HTTP_409_CONFLICT, "This calendar already has a holiday on that date")
    h = Holiday(calendar_id=cal.id, holiday_on=holiday_on, name=name, source="manual", created_by_id=actor.id)
    db.add(h)
    await db.flush()
    await audit.record(db, actor=actor, action="holiday_calendar.holiday_added", entity_type="holiday_calendar",
                       entity_id=cal.id, summary=f"{holiday_on.isoformat()} {name}", ip_address=actor.ip_address)
    await db.commit()
    return h


async def delete_holiday(db: AsyncSession, cal: HolidayCalendar, holiday_id: uuid.UUID, actor) -> None:
    h = await db.get(Holiday, holiday_id)
    if not h or h.calendar_id != cal.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Holiday not found")
    await audit.record(db, actor=actor, action="holiday_calendar.holiday_removed", entity_type="holiday_calendar",
                       entity_id=cal.id, summary=f"{h.holiday_on.isoformat()} {h.name}", ip_address=actor.ip_address)
    await db.delete(h)
    await db.commit()


async def is_business_day(db: AsyncSession, d: date, calendar_id: uuid.UUID | None = None) -> bool:
    cal = await get_calendar(db, _uuid(calendar_id))
    if d.weekday() in set(cal.weekend_days or [5, 6]):
        return False
    return d not in await _holidays_between(db, cal, d, d)


async def roll_forward(db: AsyncSession, d: date, calendar_id: uuid.UUID | None = None) -> date:
    """Next business day on or after `d` (calendar-day deadlines landing on a weekend/holiday)."""
    if await is_business_day(db, d, calendar_id):
        return d
    return await add_business_days(db, d, 1, calendar_id)


async def compute_rule_date(db: AsyncSession, rule: dict, anchors: dict[str, date],
                            default_calendar_id: uuid.UUID | None = None) -> date | None:
    """Evaluates {"from": anchor, "days": n, "business_days": bool, "calendar_id": id, "roll_forward": bool}."""
    base = anchors.get(rule.get("from") or "effective_on")
    if base is None:
        return None
    days = int(rule.get("days") or 0)
    cal = _uuid(rule.get("calendar_id")) or default_calendar_id
    if rule.get("business_days"):
        return await add_business_days(db, base, days, cal)
    d = base + timedelta(days=days)
    if rule.get("roll_forward"):
        d = await roll_forward(db, d, cal)
    return d


# =========================================================================== critical-date engine

async def _date_event(db: AsyncSession, cd: CriticalDate, kind: str, actor=None, *, from_status=None, to_status=None,
                      from_due=None, to_due=None, reason: str | None = None, data: dict | None = None) -> None:
    db.add(CriticalDateEvent(
        critical_date_id=cd.id, kind=kind, from_status=from_status, to_status=to_status, from_due_on=from_due,
        to_due_on=to_due, reason=reason, actor_id=getattr(actor, "id", None),
        actor_name=getattr(actor, "full_name", None), at=utcnow(), data=audit.to_jsonable(data or {}),
    ))


async def _default_owner(db: AsyncSession, related_type: str, related_id: uuid.UUID) -> uuid.UUID | None:
    if related_type == "contract":
        return await db.scalar(select(Contract.owner_id).where(Contract.id == related_id))
    if related_type == "opportunity":
        from app.modules.pipeline.models import Opportunity

        return await db.scalar(select(Opportunity.owner_id).where(Opportunity.id == related_id))
    return None


async def upsert_critical_date(
    db: AsyncSession,
    *,
    related_type: str,
    related_id: uuid.UUID,
    date_type: str,
    label: str,
    due_on: date,
    property_id: uuid.UUID | None = None,
    owner_id: uuid.UUID | None = None,
    lead_days: int = 14,
    is_blocking: bool = False,
    source: str = "rule",
    status: str = "confirmed",
    key: str | None = None,
    actor=None,
    related_label: str | None = None,
    rule: dict | None = None,
    business_days: bool = False,
    calendar_id: uuid.UUID | None = None,
    citation: dict | None = None,
    notes: str | None = None,
) -> CriticalDate:
    """Create or update the critical date identified by (related_type, related_id, key or date_type).

    - source='ai' is always stored as 'proposed' (human confirmation is mandatory).
    - A 'proposed' value never overwrites a confirmed/missed date; it is parked in `proposed_due_on`.
    - Completed/waived dates are left untouched.
    - Every change is written to critical_date_events and the audit log. Does not commit.
    """
    if status not in CRITICAL_DATE_STATUSES:
        raise ValueError(f"Invalid critical date status {status!r}")
    if source == "ai":
        status = "proposed"
    k = (key or date_type)[:80]
    now = utcnow()
    actor_id = getattr(actor, "id", None)
    where = (CriticalDate.related_type == related_type, CriticalDate.related_id == related_id, CriticalDate.key == k)
    rule_json = audit.to_jsonable(rule) if rule else None

    cd = await db.scalar(select(CriticalDate).where(*where))
    if cd is None:
        cd = CriticalDate(
            related_type=related_type, related_id=related_id, related_label=(related_label or None) and related_label[:300],
            key=k, property_id=property_id, date_type=date_type, label=label[:300], due_on=due_on,
            original_due_on=due_on, rule=rule_json, business_days=business_days, calendar_id=calendar_id,
            status=status, source=source, citation=audit.to_jsonable(citation) if citation else None,
            owner_id=owner_id or await _default_owner(db, related_type, related_id), lead_days=lead_days,
            is_blocking=is_blocking, notes=notes, escalation_level=0, created_by_id=actor_id, updated_by_id=actor_id,
        )
        if status == "confirmed":
            cd.confirmed_at = now
            cd.confirmed_by_id = actor_id
            cd.confirm_note = None if actor_id else f"Confirmed from verified {source} source record"
        try:
            async with db.begin_nested():
                db.add(cd)
                await db.flush()
        except IntegrityError:
            cd = await db.scalar(select(CriticalDate).where(*where))  # created concurrently: fall through to update
            if cd is None:
                raise
        else:
            await _date_event(db, cd, "created", actor, to_status=status, to_due=due_on, reason=f"Source: {source}",
                              data={"rule": rule_json, "citation": cd.citation})
            await audit.record(db, actor=actor, action="critical_date.created", entity_type="critical_date",
                               entity_id=cd.id, summary=f"{cd.label} · {due_on.isoformat()} ({status})")
            return cd

    changes: dict[str, Any] = {}
    meta = {"label": label[:300], "date_type": date_type}
    if related_label:
        meta["related_label"] = related_label[:300]
    if property_id and not cd.property_id:
        meta["property_id"] = property_id
    if owner_id and not cd.owner_id:
        meta["owner_id"] = owner_id
    changes.update(_apply(cd, meta))

    if cd.deleted_at is not None:
        prev_status, prev_due = cd.status, cd.due_on
        cd.deleted_at = None
        changes.update(_apply(cd, {"status": status, "due_on": due_on, "source": source, "rule": rule_json,
                                   "proposed_due_on": None}))
        await _date_event(db, cd, "restored", actor, from_status=prev_status, to_status=status, from_due=prev_due,
                          to_due=due_on, reason=f"Re-created by {source}")
    elif cd.status in ("completed", "waived"):
        pass
    elif cd.status in ("confirmed", "missed") and status == "proposed":
        # Never overwrite a human-confirmed deadline with a computed or AI value.
        new_proposal = due_on if due_on != cd.due_on else None
        if new_proposal != cd.proposed_due_on:
            changes.update(_apply(cd, {"proposed_due_on": new_proposal}))
            if new_proposal:
                await _date_event(db, cd, "proposal_differs", actor, from_due=cd.due_on, to_due=due_on,
                                  reason=f"New {source} value differs from the confirmed date",
                                  data={"citation": citation, "rule": rule_json})
    elif cd.status == "proposed":
        if due_on != cd.due_on:
            await _date_event(db, cd, "rescheduled", actor, from_due=cd.due_on, to_due=due_on,
                              reason=f"Recomputed ({source})", data={"rule": rule_json})
        changes.update(_apply(cd, {"due_on": due_on, "source": source, "rule": rule_json, "business_days": business_days,
                                   "calendar_id": calendar_id, "proposed_due_on": None}))
        if citation:
            cd.citation = audit.to_jsonable(citation)
        if status == "confirmed":
            changes.update(_apply(cd, {"status": "confirmed", "confirmed_at": now, "confirmed_by_id": actor_id}))
            await _date_event(db, cd, "confirmed", actor, from_status="proposed", to_status="confirmed",
                              reason=f"Confirmed by verified {source} source")
    else:
        # confirmed/missed date updated from a verified system of record (e.g. an amended lease).
        if due_on != cd.due_on:
            await _date_event(db, cd, "rescheduled", actor, from_due=cd.due_on, to_due=due_on,
                              reason=f"Updated from verified {source} source")
            changes.update(_apply(cd, {"due_on": due_on, "proposed_due_on": None}))
            if cd.status == "missed" and due_on >= today():
                changes.update(_apply(cd, {"status": "confirmed", "escalation_level": 0}))
        if rule_json:
            changes.update(_apply(cd, {"rule": rule_json}))

    if changes:
        cd.updated_by_id = actor_id
        await audit.record(db, actor=actor, action="critical_date.upserted", entity_type="critical_date",
                           entity_id=cd.id, summary=cd.label, changes=changes)
    await db.flush()
    return cd


async def get_date(db: AsyncSession, date_id: uuid.UUID) -> CriticalDate:
    cd = await db.get(CriticalDate, date_id)
    if not cd or cd.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Critical date not found")
    return cd


async def date_outs(db: AsyncSession, rows: list[CriticalDate]) -> list[CriticalDateOut]:
    names = await _user_names(db, [r.owner_id for r in rows] + [r.confirmed_by_id for r in rows])
    props = await _property_info(db, [r.property_id for r in rows])
    t = today()
    out = []
    for r in rows:
        o = CriticalDateOut.model_validate(r)
        o.owner_name = names.get(r.owner_id)
        o.confirmed_by_name = names.get(r.confirmed_by_id)
        o.property_label = props.get(r.property_id, (None, None))[0]
        o.days_until = (r.due_on - t).days
        out.append(o)
    return out


@dataclass
class DateFilters:
    q: str | None = None
    related_type: list[str] | None = None
    related_id: uuid.UUID | None = None
    property_id: uuid.UUID | None = None
    owner_id: list[uuid.UUID] | None = None
    status: list[str] | None = None
    date_type: list[str] | None = None
    source: list[str] | None = None
    window: str | None = None  # overdue | 7 | 30 | 90
    blocking: bool | None = None
    due_from: date | None = None
    due_to: date | None = None
    mine: bool | None = None


def build_date_query(f: DateFilters, *, skip: set[str] = frozenset(), user_id: uuid.UUID | None = None) -> Select:
    stmt = select(CriticalDate).where(CriticalDate.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [CriticalDate.label, CriticalDate.related_label])
    if "related_type" not in skip:
        stmt = in_filter(stmt, CriticalDate.related_type, f.related_type)
    if "status" not in skip:
        stmt = in_filter(stmt, CriticalDate.status, f.status)
    if "date_type" not in skip:
        stmt = in_filter(stmt, CriticalDate.date_type, f.date_type)
    if "owner_id" not in skip:
        stmt = in_filter(stmt, CriticalDate.owner_id, f.owner_id)
    stmt = in_filter(stmt, CriticalDate.source, f.source)
    if f.related_id:
        stmt = stmt.where(CriticalDate.related_id == f.related_id)
    if f.property_id:
        stmt = stmt.where(CriticalDate.property_id == f.property_id)
    if f.blocking:
        stmt = stmt.where(CriticalDate.is_blocking.is_(True))
    if f.mine and user_id:
        stmt = stmt.where(CriticalDate.owner_id == user_id)
    stmt = range_filter(stmt, CriticalDate.due_on, f.due_from, f.due_to)
    t = today()
    if f.window == "overdue":
        stmt = stmt.where(CriticalDate.due_on < t, CriticalDate.status.in_(OPEN_DATE_STATUSES))
    elif f.window in ("7", "30", "90"):
        stmt = stmt.where(CriticalDate.due_on >= t, CriticalDate.due_on <= t + timedelta(days=int(f.window)),
                          CriticalDate.status.in_(("proposed", "confirmed")))
    return stmt


async def date_summary(db: AsyncSession, f: DateFilters, user_id: uuid.UUID | None = None) -> dict[str, int]:
    base = build_date_query(DateFilters(**{**vars(f), "window": None, "status": None}), user_id=user_id).subquery()
    c = base.c
    t = today()
    upcoming = c.status.in_(("proposed", "confirmed"))
    row = (await db.execute(select(
        func.count().filter(and_(c.due_on < t, c.status.in_(OPEN_DATE_STATUSES))),
        func.count().filter(and_(upcoming, c.due_on >= t, c.due_on <= t + timedelta(days=7))),
        func.count().filter(and_(upcoming, c.due_on >= t, c.due_on <= t + timedelta(days=30))),
        func.count().filter(and_(upcoming, c.due_on >= t, c.due_on <= t + timedelta(days=90))),
        func.count().filter(c.status == "proposed"),
        func.count().filter(and_(c.is_blocking.is_(True), c.status.in_(OPEN_DATE_STATUSES))),
        func.count().filter(c.status == "missed"),
    ))).one()
    keys = ["overdue", "next_7", "next_30", "next_90", "proposed", "blocking_open", "missed"]
    return {k: int(v or 0) for k, v in zip(keys, row)}


async def create_manual_date(db: AsyncSession, data: CriticalDateCreate, actor) -> CriticalDate:
    """A date entered by a person directly from a source document is recorded as confirmed by them."""
    key = data.key or f"manual:{uuid.uuid4().hex[:12]}"
    property_id = data.property_id
    related_label = data.related_label
    if data.related_type == "contract":
        c = await get_contract(db, data.related_id)
        property_id = property_id or c.property_id
        related_label = related_label or c.title
    cd = await upsert_critical_date(
        db, related_type=data.related_type, related_id=data.related_id, date_type=data.date_type, label=data.label,
        due_on=data.due_on, property_id=property_id, owner_id=data.owner_id, lead_days=data.lead_days,
        is_blocking=data.is_blocking, source="manual", status="confirmed", key=key, actor=actor,
        related_label=related_label, notes=data.notes,
    )
    await db.commit()
    return cd


async def update_date(db: AsyncSession, cd: CriticalDate, data: CriticalDateUpdate, actor) -> CriticalDate:
    changes = _apply(cd, data.model_dump(exclude_unset=True))
    if changes:
        cd.updated_by_id = actor.id
        if "owner_id" in changes:
            await _date_event(db, cd, "owner_changed", actor, data={"owner_id": changes["owner_id"]})
        await audit.record(db, actor=actor, action="critical_date.updated", entity_type="critical_date",
                           entity_id=cd.id, summary=cd.label, changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return cd


async def _confirm(db: AsyncSession, cd: CriticalDate, data: ConfirmIn, actor) -> bool:
    """Human confirmation against the source document. Returns True when the due date was corrected."""
    if cd.status != "proposed":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Only proposed dates can be confirmed (this one is {cd.status})")
    corrected = bool(data.due_on and data.due_on != cd.due_on)
    if corrected:
        await _date_event(db, cd, "rescheduled", actor, from_due=cd.due_on, to_due=data.due_on,
                          reason=f"Corrected against source{': ' + data.note if data.note else ''}")
        cd.due_on = data.due_on
    cd.status = "confirmed"
    cd.confirmed_by_id = actor.id
    cd.confirmed_at = utcnow()
    cd.confirm_note = data.note
    cd.proposed_due_on = None
    cd.updated_by_id = actor.id
    await _date_event(db, cd, "confirmed", actor, from_status="proposed", to_status="confirmed", reason=data.note)
    await audit.record(db, actor=actor, action="critical_date.confirmed", entity_type="critical_date", entity_id=cd.id,
                       summary=f"{cd.label} · {cd.due_on.isoformat()}", ip_address=actor.ip_address,
                       changes={"status": {"from": "proposed", "to": "confirmed"}, "note": data.note})
    return corrected


async def confirm_date(db: AsyncSession, cd: CriticalDate, data: ConfirmIn, actor) -> CriticalDate:
    corrected = await _confirm(db, cd, data, actor)
    if corrected and cd.related_type == "contract":
        await _recompute_dependents(db, cd.related_id, actor)
    await db.commit()
    return cd


async def _complete(db: AsyncSession, cd: CriticalDate, note: str | None, actor) -> None:
    if cd.status == "proposed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Confirm this date against the source document before completing it")
    if cd.status not in ("confirmed", "missed"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Date is already {cd.status}")
    prev = cd.status
    cd.status = "completed"
    cd.completed_at = utcnow()
    cd.completed_by_id = actor.id
    cd.resolution_note = note
    cd.updated_by_id = actor.id
    await _date_event(db, cd, "completed", actor, from_status=prev, to_status="completed", reason=note)
    await audit.record(db, actor=actor, action="critical_date.completed", entity_type="critical_date", entity_id=cd.id,
                       summary=cd.label, changes={"status": {"from": prev, "to": "completed"}, "note": note},
                       ip_address=getattr(actor, "ip_address", None))


async def complete_date(db: AsyncSession, cd: CriticalDate, note: str | None, actor) -> CriticalDate:
    await _complete(db, cd, note, actor)
    await db.commit()
    return cd


async def _waive(db: AsyncSession, cd: CriticalDate, note: str, actor) -> None:
    if cd.status not in OPEN_DATE_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Date is already {cd.status}")
    prev = cd.status
    cd.status = "waived"
    cd.completed_at = utcnow()
    cd.completed_by_id = actor.id
    cd.resolution_note = note
    cd.updated_by_id = actor.id
    await _date_event(db, cd, "waived", actor, from_status=prev, to_status="waived", reason=note)
    await audit.record(db, actor=actor, action="critical_date.waived", entity_type="critical_date", entity_id=cd.id,
                       summary=cd.label, changes={"status": {"from": prev, "to": "waived"}, "note": note},
                       ip_address=getattr(actor, "ip_address", None))


async def waive_date(db: AsyncSession, cd: CriticalDate, note: str, actor) -> CriticalDate:
    await _waive(db, cd, note, actor)
    await db.commit()
    return cd


async def _reschedule(db: AsyncSession, cd: CriticalDate, due_on: date, reason: str, actor) -> None:
    if cd.status not in OPEN_DATE_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, f"A {cd.status} date cannot be rescheduled")
    if due_on == cd.due_on:
        return
    prev_due, prev_status = cd.due_on, cd.status
    cd.due_on = due_on
    if cd.proposed_due_on == due_on:
        cd.proposed_due_on = None
    if cd.status == "missed" and due_on >= today():
        cd.status = "confirmed"
        cd.escalation_level = 0
    cd.updated_by_id = actor.id
    await _date_event(db, cd, "rescheduled", actor, from_status=prev_status, to_status=cd.status, from_due=prev_due,
                      to_due=due_on, reason=reason)
    await audit.record(db, actor=actor, action="critical_date.rescheduled", entity_type="critical_date",
                       entity_id=cd.id, summary=f"{cd.label}: {reason}", ip_address=getattr(actor, "ip_address", None),
                       changes={"due_on": {"from": prev_due.isoformat(), "to": due_on.isoformat()}, "reason": reason})


async def reschedule_date(db: AsyncSession, cd: CriticalDate, due_on: date, reason: str, actor) -> CriticalDate:
    await _reschedule(db, cd, due_on, reason, actor)
    if cd.related_type == "contract":
        await _recompute_dependents(db, cd.related_id, actor)
    await db.commit()
    return cd


async def bulk_dates(db: AsyncSession, ids: list[uuid.UUID], action: str, note: str | None, actor) -> dict:
    rows = list(await db.scalars(select(CriticalDate).where(CriticalDate.id.in_(ids), CriticalDate.deleted_at.is_(None))))
    done, skipped = 0, []
    for cd in rows:
        try:
            if action == "confirm":
                await _confirm(db, cd, ConfirmIn(note=note), actor)
            else:
                await _complete(db, cd, note, actor)
            done += 1
        except HTTPException as e:
            skipped.append(f"{cd.label}: {e.detail}")
    await db.commit()
    return {"updated": done, "skipped": skipped}


async def date_events(db: AsyncSession, date_id: uuid.UUID) -> list[CriticalDateEvent]:
    return list(await db.scalars(
        select(CriticalDateEvent).where(CriticalDateEvent.critical_date_id == date_id).order_by(CriticalDateEvent.at.desc())
    ))


# --------------------------------------------------------------------------- scan / escalation

SCAN_RULE_KEY = "contracts.critical_dates"
SCAN_DEFAULTS = {"imminent_days": 3, "escalate_after_days": 2, "risk_decision_window_days": 7}


async def _scan_config(db: AsyncSession) -> tuple[bool, dict]:
    from app.modules.tasks.models import AutomationRule
    from app.modules.tasks.service import rule_config

    rule = await db.scalar(select(AutomationRule).where(AutomationRule.key == SCAN_RULE_KEY))
    if rule is None:
        db.add(AutomationRule(
            key=SCAN_RULE_KEY, name="Critical dates: lead time and escalation", event="schedule", enabled=True,
            description="Creates owner tasks as critical dates enter their lead window, asks for confirmation of "
                        "proposed dates, alerts on imminent deadlines and escalates missed dates, overdue DD items, "
                        "late third-party reports and high-severity risks without a decision before feasibility.",
            thresholds=dict(SCAN_DEFAULTS), run_count=0, error_count=0,
        ))
        await db.flush()
    enabled, cfg = await rule_config(db, SCAN_RULE_KEY)
    return enabled, {**SCAN_DEFAULTS, **cfg}


async def scan_critical_dates(db: AsyncSession, *, actor=None, on: date | None = None) -> dict:
    """Lead-window tasks, imminent alerts and missed-date escalation. Idempotent (keys); does not commit."""
    from app.modules.tasks.service import create_task, raise_alert, record_rule_run

    enabled, cfg = await _scan_config(db)
    if not enabled:
        return {"skipped": True}
    t = on or today()
    started = utcnow()
    imminent = int(cfg.get("imminent_days", 3))
    esc_after = int(cfg.get("escalate_after_days", 2))
    counts = {"scanned": 0, "tasks": 0, "alerts": 0, "missed": 0, "escalated": 0}

    def fresh(obj) -> bool:
        return obj.created_at is not None and obj.created_at >= started

    async def alert(**kw) -> None:
        a = await raise_alert(db, rule_key=SCAN_RULE_KEY, **kw)
        counts["alerts"] += fresh(a)

    async def task(**kw) -> None:
        tk = await create_task(db, source=SCAN_RULE_KEY, actor_id=getattr(actor, "id", None), **kw)
        counts["tasks"] += fresh(tk)

    rows = list(await db.scalars(
        select(CriticalDate).where(CriticalDate.deleted_at.is_(None), CriticalDate.status.in_(OPEN_DATE_STATUSES),
                                   CriticalDate.due_on <= t + timedelta(days=366))
    ))
    for cd in rows:
        counts["scanned"] += 1
        days = (cd.due_on - t).days
        label = f"{cd.label} — {cd.related_label}" if cd.related_label else cd.label
        link = {"related_type": cd.related_type, "related_id": cd.related_id, "related_label": cd.related_label or cd.label}
        base_key = f"critical_date:{cd.id}:{cd.due_on.isoformat()}"
        if days < 0:
            if cd.status in ("proposed", "confirmed"):
                prev = cd.status
                cd.status = "missed"
                cd.escalation_level = max(cd.escalation_level or 0, 1)
                cd.escalated_at = utcnow()
                counts["missed"] += 1
                await _date_event(db, cd, "missed", actor, from_status=prev, to_status="missed",
                                  reason="Due date passed without completion")
                why = "was never confirmed against the source and " if prev == "proposed" else ""
                await alert(title=f"Missed critical date: {label}", severity="critical" if cd.is_blocking else "high",
                            reason=f"{cd.label} {why}passed on {cd.due_on.isoformat()} without being completed or waived.",
                            owner_id=cd.owner_id, due_at=_end_of_day(cd.due_on), idempotency_key=f"{base_key}:missed", **link)
                manager = await _manager_of(db, cd.owner_id)
                if manager:
                    await alert(title=f"Escalation: missed critical date {label}", severity="high",
                                reason=f"Owner did not complete {cd.label} due {cd.due_on.isoformat()}.",
                                owner_id=manager, idempotency_key=f"{base_key}:missed:manager", **link)
                await events.emit(db, "critical_date.missed", critical_date_id=cd.id, related_type=cd.related_type,
                                  related_id=cd.related_id, property_id=cd.property_id, actor=actor)
            elif cd.status == "missed" and (cd.escalation_level or 0) < 2 and -days >= esc_after:
                cd.escalation_level = 2
                cd.escalated_at = utcnow()
                counts["escalated"] += 1
                target = await _manager_of(db, cd.owner_id) or cd.owner_id
                await alert(title=f"Still unresolved: {label}", severity="critical",
                            reason=f"{cd.label} was due {cd.due_on.isoformat()} ({-days} days ago) and remains open.",
                            owner_id=target, idempotency_key=f"{base_key}:escalation2", **link)
                await _date_event(db, cd, "escalated", actor, reason=f"Escalation level 2 after {-days} days")
            continue
        if days > (cd.lead_days or 0) and days > imminent:
            continue
        due_at = _end_of_day(cd.due_on)
        if cd.status == "proposed":
            await task(title=f"Confirm against source: {label}", assignee_id=cd.owner_id, due_at=due_at,
                       task_type="review", priority="high" if cd.is_blocking else "normal",
                       description=f"Proposed date {cd.due_on.isoformat()} ({cd.source}) must be verified against the "
                                   "source contract before it can be relied on.",
                       idempotency_key=f"critical_date:{cd.id}:confirm", **link)
        else:
            await task(title=f"Due {cd.due_on.isoformat()}: {label}", assignee_id=cd.owner_id, due_at=due_at,
                       task_type="due_diligence" if cd.related_type == "contract" else "follow_up",
                       priority="urgent" if cd.is_blocking and days <= imminent else "high" if cd.is_blocking else "normal",
                       idempotency_key=f"{base_key}:lead", **link)
        if days <= imminent:
            await alert(title=f"Critical date in {days} day{'s' if days != 1 else ''}: {label}",
                        severity="critical" if cd.is_blocking else "high",
                        reason=f"{cd.label} is due {cd.due_on.isoformat()}"
                               f"{' and is still unconfirmed' if cd.status == 'proposed' else ''}.",
                        owner_id=cd.owner_id, due_at=due_at, idempotency_key=f"{base_key}:imminent", **link)

    # DD items past due
    dd_rows = (await db.execute(
        select(DDItem, Contract.title, Contract.owner_id).join(Contract, Contract.id == DDItem.contract_id)
        .where(DDItem.deleted_at.is_(None), DDItem.due_on < t, DDItem.status.notin_(DD_DONE),
               Contract.deleted_at.is_(None), Contract.status == "executed")
    )).all()
    for item, c_title, c_owner in dd_rows:
        owner = item.owner_id or c_owner
        link = {"related_type": "contract", "related_id": item.contract_id, "related_label": c_title}
        overdue = (t - item.due_on).days
        key = f"dd_item:{item.id}:{item.due_on.isoformat()}"
        if (item.escalation_level or 0) < 1:
            item.escalation_level = 1
            item.escalated_at = utcnow()
            counts["escalated"] += 1
        await alert(title=f"DD item overdue: {item.title}", owner_id=owner,
                    severity="high" if item.severity in HIGH_SEVERITIES else "medium",
                    reason=f"Due {item.due_on.isoformat()} ({overdue} days ago), status {item.status}.",
                    idempotency_key=f"{key}:overdue", **link)
        if overdue >= esc_after and (item.escalation_level or 0) < 2:
            item.escalation_level = 2
            item.escalated_at = utcnow()
            await alert(title=f"Escalation: DD item overdue {item.title}", severity="high",
                        owner_id=await _manager_of(db, owner) or c_owner,
                        reason=f"{item.title} is {overdue} days overdue on {c_title}.",
                        idempotency_key=f"{key}:escalation2", **link)

    # Late third-party reports
    rep_rows = (await db.execute(
        select(ThirdPartyReport, Contract.title, Contract.owner_id).join(Contract, Contract.id == ThirdPartyReport.contract_id)
        .where(ThirdPartyReport.deleted_at.is_(None), ThirdPartyReport.expected_on < t,
               ThirdPartyReport.status.in_(("ordered", "in_progress")), Contract.deleted_at.is_(None))
    )).all()
    for rep, c_title, c_owner in rep_rows:
        await alert(title=f"Late {rep.report_type.replace('_', ' ')} report: {c_title}", severity="medium",
                    owner_id=rep.owner_id or c_owner,
                    reason=f"Expected {rep.expected_on.isoformat()} from {rep.vendor_name or 'vendor'}; not delivered.",
                    related_type="contract", related_id=rep.contract_id, related_label=c_title,
                    idempotency_key=f"third_party_report:{rep.id}:{rep.expected_on.isoformat()}:late")

    # High-severity risks without a decision as the feasibility deadline approaches
    window = int(cfg.get("risk_decision_window_days", 7))
    feas = (await db.execute(
        select(CriticalDate.related_id, CriticalDate.due_on).where(
            CriticalDate.related_type == "contract", CriticalDate.key == "feasibility_expiry",
            CriticalDate.deleted_at.is_(None), CriticalDate.status.in_(OPEN_DATE_STATUSES),
            CriticalDate.due_on <= t + timedelta(days=window))
    )).all()
    feas_by_contract = {r[0]: r[1] for r in feas}
    if feas_by_contract:
        risk_rows = (await db.execute(
            select(RiskItem, Contract.title, Contract.owner_id).join(Contract, Contract.id == RiskItem.contract_id)
            .where(RiskItem.contract_id.in_(feas_by_contract), RiskItem.deleted_at.is_(None),
                   RiskItem.severity.in_(HIGH_SEVERITIES), RiskItem.decision_required.is_(True),
                   RiskItem.decision.is_(None), RiskItem.status != "closed", Contract.status == "executed")
        )).all()
        for risk, c_title, c_owner in risk_rows:
            fd = feas_by_contract[risk.contract_id]
            await alert(title=f"Decision required before feasibility: {risk.title}", severity="critical",
                        owner_id=risk.owner_id or c_owner,
                        reason=f"{risk.severity.title()} risk on {c_title} has no recorded decision; feasibility "
                               f"expires {fd.isoformat()}.",
                        related_type="contract", related_id=risk.contract_id, related_label=c_title,
                        idempotency_key=f"risk_item:{risk.id}:{fd.isoformat()}:decision")

    await record_rule_run(db, SCAN_RULE_KEY)
    return counts


# =========================================================================== contracts

# Day counts read from Contract.key_terms. Defaults (marked `assumed` in the rule) apply only to the core
# PSA deadlines so execution always yields a reviewable candidate set; all are 'proposed' until confirmed.
TERM_DEFAULTS = {
    "deposit_days": 3, "feasibility_days": 30, "title_objection_days": 20, "title_cure_days": 10,
    "survey_days": 25, "closing_days": 30,
}
TERM_KEYS = [
    "deposit_days", "additional_deposit_days", "feasibility_days", "title_objection_days", "title_cure_days",
    "survey_days", "financing_days", "estoppel_days", "snda_days", "closing_days", "extension_count",
    "extension_days", "post_close_days",
]
# (key, date_type, label, from, term, business_days default, blocking, lead_days, roll_forward)
DATE_RULES: list[tuple[str, str, str, str, str | None, bool, bool, int, bool]] = [
    ("effective", "effective", "Effective date", "effective_on", None, False, False, 0, False),
    ("deposit", "deposit", "Earnest money deposit due", "effective_on", "deposit_days", True, True, 2, False),
    ("feasibility_expiry", "feasibility_expiry", "Feasibility / due diligence period expires", "effective_on",
     "feasibility_days", False, True, 10, True),
    ("additional_deposit", "additional_deposit", "Additional deposit due", "feasibility_expiry",
     "additional_deposit_days", True, True, 2, False),
    ("title_objection", "title_objection", "Title objection deadline", "effective_on", "title_objection_days",
     False, True, 7, True),
    ("title_cure", "title_cure", "Seller title cure period ends", "title_objection", "title_cure_days", False, False, 5,
     True),
    ("survey", "survey", "Survey objection deadline", "effective_on", "survey_days", False, True, 7, True),
    ("financing", "financing", "Financing contingency expires", "effective_on", "financing_days", False, True, 10, True),
    ("estoppel", "estoppel", "Tenant estoppels due", "effective_on", "estoppel_days", False, False, 7, True),
    ("snda", "snda", "SNDAs due", "effective_on", "snda_days", False, False, 7, True),
    ("closing", "closing", "Closing", "feasibility_expiry", "closing_days", False, True, 14, True),
    ("post_close", "post_close", "Post-closing obligations due", "closing", "post_close_days", False, False, 14, False),
]
RULE_ANCHORS = ["effective_on", "executed_on"] + [r[0] for r in DATE_RULES]


def _clean_terms(terms: dict | None) -> dict:
    out = dict(terms or {})
    for k in TERM_KEYS:
        if k in out:
            v = out[k]
            if v in (None, ""):
                out.pop(k)
                continue
            try:
                out[k] = int(v)
            except (TypeError, ValueError):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"key_terms.{k} must be a whole number of days")
            if out[k] < 0 or out[k] > 3650:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"key_terms.{k} is out of range")
    if "closing_from" in out and out["closing_from"] not in RULE_ANCHORS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "key_terms.closing_from is not a known anchor")
    rules = out.get("rules") or []
    if not isinstance(rules, list):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "key_terms.rules must be a list")
    for r in rules:
        if not isinstance(r, dict) or not r.get("key") or not r.get("label") or not r.get("from"):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Each custom rule needs key, label and from")
    return out


def contract_rules(c: Contract) -> list[dict]:
    """Ordered rule set for a contract: defaults driven by key_terms, then custom `key_terms.rules`."""
    terms = c.key_terms or {}
    global_bd = terms.get("business_days")
    roll = terms.get("roll_forward", True)
    rules: list[dict] = []
    for key, date_type, label, frm, term, bd, blocking, lead, roll_default in DATE_RULES:
        if key == "closing":
            frm = terms.get("closing_from") or frm
        if term is None:
            days, assumed = 0, False
        elif terms.get(term) is not None:
            days, assumed = int(terms[term]), False
        elif term in TERM_DEFAULTS:
            days, assumed = TERM_DEFAULTS[term], True
        else:
            if key == "additional_deposit" and c.additional_deposit:
                days, assumed = 2, True
            else:
                continue
        business = bool(global_bd) if global_bd is not None and term != "deposit_days" else bd
        rules.append({"key": key, "date_type": date_type, "label": label, "from": frm, "days": days,
                      "business_days": business, "roll_forward": bool(roll and roll_default and not business),
                      "calendar_id": str(c.calendar_id) if c.calendar_id else None, "is_blocking": blocking,
                      "lead_days": lead, "term": term, "assumed": assumed})
    for i in range(1, int(terms.get("extension_count") or 0) + 1):
        ext_days = int(terms.get("extension_days") or 30)
        rules.append({"key": f"extension_{i}", "date_type": "extension", "label": f"Extended closing (extension {i})",
                      "from": "closing", "days": ext_days * i, "business_days": False, "roll_forward": bool(roll),
                      "calendar_id": str(c.calendar_id) if c.calendar_id else None, "is_blocking": False,
                      "lead_days": 14, "term": "extension_days", "assumed": terms.get("extension_days") is None})
    for r in terms.get("rules") or []:
        custom = {"date_type": "other", "days": 0, "business_days": bool(global_bd), "roll_forward": False,
                  "calendar_id": str(c.calendar_id) if c.calendar_id else None, "is_blocking": False,
                  "lead_days": 7, "assumed": False, **r, "custom": True}
        rules = [x for x in rules if x["key"] != custom["key"]] + [custom]
    return rules


async def _contract_dates(db: AsyncSession, contract_id: uuid.UUID) -> list[CriticalDate]:
    return list(await db.scalars(
        select(CriticalDate).where(CriticalDate.related_type == "contract", CriticalDate.related_id == contract_id,
                                   CriticalDate.deleted_at.is_(None)).order_by(CriticalDate.due_on)
    ))


async def generate_dates(db: AsyncSession, c: Contract, actor=None, *, source: str = "rule",
                         overrides: dict[str, int] | None = None, citations: dict[str, dict] | None = None) -> list[CriticalDate]:
    """Candidate dates from the contract's terms. All are 'proposed' until a person confirms them against the
    source. Anchors use confirmed values where they exist. Does not commit."""
    if not c.effective_on:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Set the effective date before generating dates")
    anchors: dict[str, date] = {"effective_on": c.effective_on, "executed_on": c.executed_on or c.effective_on}
    existing = {d.key: d for d in await _contract_dates(db, c.id)}
    out: list[CriticalDate] = []
    for rule in contract_rules(c):
        if overrides and rule.get("term") in overrides:
            rule = {**rule, "days": overrides[rule["term"]], "assumed": False}
        elif overrides is not None:
            # Extraction-driven runs only touch the dates the extraction speaks to; keep anchors flowing.
            ex = existing.get(rule["key"])
            if ex is not None:
                anchors[rule["key"]] = ex.due_on
            continue
        if rule["key"] == "effective":
            due = c.effective_on
        else:
            due = await compute_rule_date(db, rule, anchors, c.calendar_id)
        if due is None:
            continue
        cd = await upsert_critical_date(
            db, related_type="contract", related_id=c.id, date_type=rule["date_type"], label=rule["label"],
            due_on=due, property_id=c.property_id, owner_id=c.owner_id, lead_days=int(rule.get("lead_days") or 7),
            is_blocking=bool(rule.get("is_blocking")), source=source, status="proposed", key=rule["key"],
            actor=actor, related_label=c.title, rule=rule, business_days=bool(rule.get("business_days")),
            calendar_id=c.calendar_id, citation=(citations or {}).get(rule.get("term") or ""),
        )
        anchors[rule["key"]] = cd.due_on
        out.append(cd)
    return out


async def _recompute_dependents(db: AsyncSession, contract_id: uuid.UUID, actor) -> None:
    c = await db.get(Contract, contract_id)
    if c and not c.deleted_at and c.status == "executed" and c.effective_on:
        await generate_dates(db, c, actor)


async def get_contract(db: AsyncSession, contract_id: uuid.UUID) -> Contract:
    c = await db.get(Contract, contract_id)
    if not c or c.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Contract not found")
    return c


@dataclass
class ContractFilters:
    q: str | None = None
    status: list[str] | None = None
    contract_type: list[str] | None = None
    owner_id: list[uuid.UUID] | None = None
    property_id: uuid.UUID | None = None
    opportunity_id: uuid.UUID | None = None
    effective_from: date | None = None
    effective_to: date | None = None


def build_contract_query(f: ContractFilters, *, skip: set[str] = frozenset()) -> Select:
    stmt = select(Contract).where(Contract.deleted_at.is_(None))
    stmt = apply_search(stmt, f.q, [Contract.title, Contract.notes])
    if "status" not in skip:
        stmt = in_filter(stmt, Contract.status, f.status)
    if "contract_type" not in skip:
        stmt = in_filter(stmt, Contract.contract_type, f.contract_type)
    if "owner_id" not in skip:
        stmt = in_filter(stmt, Contract.owner_id, f.owner_id)
    if f.property_id:
        stmt = stmt.where(Contract.property_id == f.property_id)
    if f.opportunity_id:
        stmt = stmt.where(Contract.opportunity_id == f.opportunity_id)
    return range_filter(stmt, Contract.effective_on, f.effective_from, f.effective_to)


async def contract_items(db: AsyncSession, rows: list[Contract], *, full: bool = False) -> list:
    from app.modules.pipeline.models import Opportunity

    ids = [c.id for c in rows]
    names = await _user_names(db, [c.owner_id for c in rows])
    props = await _property_info(db, [c.property_id for c in rows])
    opp_ids = {c.opportunity_id for c in rows if c.opportunity_id}
    opps = dict((await db.execute(select(Opportunity.id, Opportunity.title).where(Opportunity.id.in_(opp_ids)))).all()) if opp_ids else {}
    key_dates: dict[tuple, date] = {}
    dd: dict[uuid.UUID, tuple[int, int]] = {}
    blockers: dict[uuid.UUID, int] = {}
    if ids:
        for rid, key, due in (await db.execute(
            select(CriticalDate.related_id, CriticalDate.key, CriticalDate.due_on).where(
                CriticalDate.related_type == "contract", CriticalDate.related_id.in_(ids),
                CriticalDate.key.in_(("feasibility_expiry", "closing")), CriticalDate.deleted_at.is_(None),
                CriticalDate.status != "waived"))
        ).all():
            key_dates[(rid, key)] = due
        for cid, total, done in (await db.execute(
            select(DDItem.contract_id, func.count(), func.count().filter(DDItem.status.in_(DD_DONE)))
            .where(DDItem.contract_id.in_(ids), DDItem.deleted_at.is_(None)).group_by(DDItem.contract_id)
        )).all():
            dd[cid] = (int(total), int(done))
        for stmt in (
            select(CriticalDate.related_id, func.count()).where(
                CriticalDate.related_type == "contract", CriticalDate.related_id.in_(ids), CriticalDate.deleted_at.is_(None),
                or_(CriticalDate.status == "missed", and_(CriticalDate.status == "proposed", CriticalDate.is_blocking.is_(True)))
            ).group_by(CriticalDate.related_id),
            select(RiskItem.contract_id, func.count()).where(
                RiskItem.contract_id.in_(ids), RiskItem.deleted_at.is_(None), RiskItem.severity.in_(HIGH_SEVERITIES),
                RiskItem.decision_required.is_(True), RiskItem.decision.is_(None), RiskItem.status != "closed",
            ).group_by(RiskItem.contract_id),
            select(DDItem.contract_id, func.count()).where(
                DDItem.contract_id.in_(ids), DDItem.deleted_at.is_(None), DDItem.severity.in_(HIGH_SEVERITIES),
                DDItem.status.notin_(DD_DONE),
            ).group_by(DDItem.contract_id),
        ):
            for cid, n in (await db.execute(stmt)).all():
                blockers[cid] = blockers.get(cid, 0) + int(n)
    t = today()
    schema = ContractOut if full else ContractListItem
    out = []
    for c in rows:
        o = schema.model_validate(c)
        o.owner_name = names.get(c.owner_id)
        o.property_label, o.property_type = props.get(c.property_id, (None, None))
        o.opportunity_label = opps.get(c.opportunity_id)
        o.feasibility_on = key_dates.get((c.id, "feasibility_expiry"))
        o.closing_on = key_dates.get((c.id, "closing"))
        o.days_to_feasibility = (o.feasibility_on - t).days if o.feasibility_on else None
        o.dd_total, o.dd_done = dd.get(c.id, (0, 0))
        o.open_blockers = blockers.get(c.id, 0)
        out.append(o)
    return out


async def contract_out(db: AsyncSession, c: Contract) -> ContractOut:
    return (await contract_items(db, [c], full=True))[0]


async def _resolve_links(db: AsyncSession, values: dict) -> None:
    """Fill property/opportunity from the linked offer or opportunity when not given."""
    if values.get("offer_id") and not (values.get("opportunity_id") and values.get("property_id")):
        try:
            from app.modules.offers.models import Offer
        except ImportError:
            Offer = None
        if Offer is not None:
            row = (await db.execute(select(Offer.opportunity_id, Offer.property_id).where(Offer.id == values["offer_id"]))).first()
            if row:
                values["opportunity_id"] = values.get("opportunity_id") or row[0]
                values["property_id"] = values.get("property_id") or row[1]
    if values.get("opportunity_id") and not values.get("property_id"):
        from app.modules.pipeline.models import Opportunity

        values["property_id"] = await db.scalar(select(Opportunity.property_id).where(Opportunity.id == values["opportunity_id"]))


async def create_contract(db: AsyncSession, data: ContractCreate, actor) -> Contract:
    values = data.model_dump(mode="python", exclude={"title"})
    values["parties"] = [audit.to_jsonable(p) for p in values["parties"]]
    values["key_terms"] = audit.to_jsonable(_clean_terms(values["key_terms"]))
    await _resolve_links(db, values)
    title = (data.title or "").strip()
    if not title:
        label = (await _property_info(db, [values.get("property_id")])).get(values.get("property_id"), (None, None))[0]
        title = f"Purchase agreement — {label}" if label else "Purchase agreement"
    c = Contract(**values, title=title, status="draft", created_by_id=actor.id, updated_by_id=actor.id)
    db.add(c)
    await db.flush()
    await audit.record(db, actor=actor, action="contract.created", entity_type=ENTITY, entity_id=c.id, summary=c.title,
                       ip_address=actor.ip_address)
    await db.commit()
    return c


async def _execute(db: AsyncSession, c: Contract, actor, effective_on: date | None = None,
                   executed_on: date | None = None) -> None:
    if c.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Contract is already {c.status}")
    c.effective_on = effective_on or c.effective_on or executed_on or c.executed_on or today()
    c.executed_on = executed_on or c.executed_on or c.effective_on
    c.status = "executed"
    c.executed_at = utcnow()
    c.executed_by_id = actor.id
    c.updated_by_id = actor.id
    await generate_dates(db, c, actor)
    has_items = await db.scalar(select(func.count()).select_from(DDItem).where(DDItem.contract_id == c.id,
                                                                                 DDItem.deleted_at.is_(None)))
    if not has_items:
        await apply_template(db, c, None, actor)
    await audit.record(db, actor=actor, action="contract.executed", entity_type=ENTITY, entity_id=c.id, summary=c.title,
                       changes={"status": {"from": "draft", "to": "executed"},
                                "effective_on": c.effective_on.isoformat()}, ip_address=getattr(actor, "ip_address", None))
    await events.emit(db, "contract.executed", contract_id=c.id, opportunity_id=c.opportunity_id,
                      property_id=c.property_id, actor=actor)


async def execute_contract(db: AsyncSession, c: Contract, data: ExecuteIn, actor) -> Contract:
    await _execute(db, c, actor, data.effective_on, data.executed_on)
    await db.commit()
    return c


async def update_contract(db: AsyncSession, c: Contract, data: ContractUpdate, actor) -> Contract:
    values = data.model_dump(mode="python", exclude_unset=True)
    new_status = values.pop("status", None)
    if "parties" in values:
        values["parties"] = [audit.to_jsonable(p) for p in values["parties"] or []]
    if "key_terms" in values:
        values["key_terms"] = audit.to_jsonable(_clean_terms(values["key_terms"]))
    if c.status in ("closed", "terminated") and values:
        raise HTTPException(status.HTTP_409_CONFLICT, f"A {c.status} contract cannot be edited")
    old_owner = c.owner_id
    changes = _apply(c, values)
    if changes:
        c.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="contract.updated", entity_type=ENTITY, entity_id=c.id,
                           summary=c.title, changes=changes, ip_address=actor.ip_address)
        if c.status == "executed" and {"key_terms", "effective_on", "executed_on", "calendar_id"} & changes.keys():
            await generate_dates(db, c, actor)
        if "owner_id" in changes and c.owner_id:
            for cd in await _contract_dates(db, c.id):
                if cd.owner_id is None or cd.owner_id == old_owner:
                    cd.owner_id = c.owner_id
    if new_status and new_status != c.status:
        if new_status == "executed":
            await _execute(db, c, actor)
        elif new_status == "terminated":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Record a termination decision with reasoning instead")
        elif new_status == "closed":
            if c.status != "executed":
                raise HTTPException(status.HTTP_409_CONFLICT, "Only executed contracts can be closed")
            prev = c.status
            c.status = "closed"
            c.updated_by_id = actor.id
            await audit.record(db, actor=actor, action="contract.closed", entity_type=ENTITY, entity_id=c.id,
                               summary=c.title, changes={"status": {"from": prev, "to": "closed"}},
                               ip_address=actor.ip_address)
        else:
            raise HTTPException(status.HTTP_409_CONFLICT, "A contract cannot return to draft")
    await db.commit()
    return c


async def archive_contract(db: AsyncSession, c: Contract, actor) -> None:
    if c.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft contracts can be deleted; executed contracts are retained")
    c.deleted_at = utcnow()
    c.updated_by_id = actor.id
    for cd in await _contract_dates(db, c.id):
        cd.deleted_at = c.deleted_at
    await audit.record(db, actor=actor, action="contract.archived", entity_type=ENTITY, entity_id=c.id, summary=c.title,
                       ip_address=actor.ip_address)
    await db.commit()


async def regenerate_dates(db: AsyncSession, c: Contract, actor) -> list[CriticalDate]:
    rows = await generate_dates(db, c, actor)
    await audit.record(db, actor=actor, action="contract.dates_generated", entity_type=ENTITY, entity_id=c.id,
                       summary=f"{len(rows)} candidate dates", ip_address=actor.ip_address)
    await db.commit()
    return await _contract_dates(db, c.id)


async def feasibility_date(db: AsyncSession, contract_id: uuid.UUID) -> CriticalDate | None:
    return await db.scalar(select(CriticalDate).where(
        CriticalDate.related_type == "contract", CriticalDate.related_id == contract_id,
        CriticalDate.key == "feasibility_expiry", CriticalDate.deleted_at.is_(None)))


async def contract_status(db: AsyncSession, c: Contract) -> ContractStatusOut:
    t = today()
    dates = await _contract_dates(db, c.id)
    by_key = {d.key: d for d in dates}
    feas, closing = by_key.get("feasibility_expiry"), by_key.get("closing")
    blockers: list[Blocker] = []
    for d in dates:
        if d.status == "missed":
            blockers.append(Blocker(kind="critical_date", id=d.id, label=f"Missed: {d.label}", severity="critical",
                                    detail=f"Was due {d.due_on.isoformat()}"))
        elif d.status == "proposed" and d.is_blocking:
            blockers.append(Blocker(kind="critical_date", id=d.id, label=f"Unconfirmed: {d.label}", severity="high",
                                    detail="Verify against the source contract"))
        elif d.status == "confirmed" and d.proposed_due_on:
            blockers.append(Blocker(kind="critical_date", id=d.id, label=f"Conflicting value: {d.label}",
                                    severity="medium", detail=f"New value {d.proposed_due_on.isoformat()} differs"))
    items = list(await db.scalars(select(DDItem).where(DDItem.contract_id == c.id, DDItem.deleted_at.is_(None))))
    for i in items:
        if i.status in DD_DONE:
            continue
        if i.severity in HIGH_SEVERITIES:
            blockers.append(Blocker(kind="dd_item", id=i.id, label=f"Open finding: {i.title}", severity=i.severity,
                                    detail=(i.findings or "")[:160] or None))
        elif i.due_on and i.due_on < t:
            blockers.append(Blocker(kind="dd_item", id=i.id, label=f"Overdue: {i.title}", severity="medium",
                                    detail=f"Was due {i.due_on.isoformat()}"))
    risks = list(await db.scalars(select(RiskItem).where(RiskItem.contract_id == c.id, RiskItem.deleted_at.is_(None))))
    for r in risks:
        if _needs_decision(r):
            due = r.decision_due_on or (feas.due_on if feas else None)
            blockers.append(Blocker(kind="risk", id=r.id, label=f"Decision required: {r.title}", severity=r.severity,
                                    detail=f"Decide before {due.isoformat()}" if due else None))
    ests = list(await db.scalars(select(Estoppel).where(Estoppel.contract_id == c.id, Estoppel.deleted_at.is_(None))))
    for e in ests:
        if e.has_discrepancy and not e.discrepancy_resolved_at:
            blockers.append(Blocker(kind="estoppel", id=e.id, label=f"{e.kind.upper()} discrepancy: {e.tenant_name}",
                                    severity="high", detail=", ".join(x.get("label", x.get("field", "")) for x in e.discrepancies)))
    excs = list(await db.scalars(select(TitleException).where(TitleException.contract_id == c.id,
                                                               TitleException.deleted_at.is_(None))))
    for x in excs:
        if x.status in ("objected", "cure_pending", "uncured"):
            blockers.append(Blocker(kind="title_exception", id=x.id, label=f"Title: {x.description[:80]}",
                                    severity="critical" if x.status == "uncured" else (x.severity or "medium"),
                                    detail=x.status.replace("_", " ")))
    reps = list(await db.scalars(select(ThirdPartyReport).where(ThirdPartyReport.contract_id == c.id,
                                                                 ThirdPartyReport.deleted_at.is_(None))))
    for r in reps:
        if r.expected_on and r.expected_on < t and r.status in ("ordered", "in_progress"):
            blockers.append(Blocker(kind="third_party_report", id=r.id, label=f"Late report: {r.report_type.replace('_', ' ')}",
                                    severity="medium", detail=f"Expected {r.expected_on.isoformat()}"))
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    blockers.sort(key=lambda b: order.get(b.severity, 4))
    counts = {
        "dates_total": len(dates), "dates_proposed": sum(d.status == "proposed" for d in dates),
        "dates_confirmed": sum(d.status == "confirmed" for d in dates), "dates_missed": sum(d.status == "missed" for d in dates),
        "dd_total": len(items), "dd_done": sum(i.status in DD_DONE for i in items),
        "dd_open_high": sum(i.status not in DD_DONE and i.severity in HIGH_SEVERITIES for i in items),
        "reports_total": len(reps), "reports_delivered": sum(r.status in ("delivered", "reviewed") for r in reps),
        "title_open": sum(x.status in EXCEPTION_OPEN for x in excs), "estoppels_total": len(ests),
        "estoppels_received": sum(e.status in ("received", "approved") for e in ests),
        "discrepancies": sum(e.has_discrepancy and not e.discrepancy_resolved_at for e in ests),
        "risks_open": sum(r.status != "closed" for r in risks), "risks_need_decision": sum(_needs_decision(r) for r in risks),
    }
    live = lambda d: d and d.status != "waived"  # noqa: E731
    return ContractStatusOut(
        contract_id=c.id, status=c.status, effective_on=c.effective_on,
        feasibility_on=feas.due_on if live(feas) else None, feasibility_status=feas.status if feas else None,
        days_to_feasibility=(feas.due_on - t).days if live(feas) and feas.status in OPEN_DATE_STATUSES else None,
        closing_on=closing.due_on if live(closing) else None,
        days_to_closing=(closing.due_on - t).days if live(closing) and closing.status in OPEN_DATE_STATUSES else None,
        blockers=blockers, counts=counts,
    )


# Extracted field name → contract date key (direct dates) or term (day counts).
EXTRACTED_DATE_FIELDS = {
    "effective_date": "effective", "effective_on": "effective", "deposit_due_date": "deposit", "deposit_date": "deposit",
    "earnest_money_due": "deposit", "feasibility_expiration": "feasibility_expiry", "feasibility_expiry": "feasibility_expiry",
    "due_diligence_expiration": "feasibility_expiry", "dd_expiration": "feasibility_expiry",
    "additional_deposit_due": "additional_deposit", "title_objection_deadline": "title_objection",
    "title_cure_deadline": "title_cure", "survey_deadline": "survey", "financing_deadline": "financing",
    "financing_contingency_expiration": "financing", "estoppel_deadline": "estoppel", "snda_deadline": "snda",
    "closing_date": "closing", "outside_closing_date": "extension_1", "post_closing_deadline": "post_close",
}
EXTRACTED_TERM_FIELDS = set(TERM_KEYS) - {"extension_count", "extension_days"}


def _norm_field(name: str) -> str:
    return name.strip().lower().replace(" ", "_").replace("-", "_")


def _extracted_scalar(value: Any) -> Any:
    if isinstance(value, dict):
        for k in ("value", "date", "days", "normalized"):
            if k in value:
                return value[k]
        return None
    return value


async def propose_from_extracted(db: AsyncSession, c: Contract, actor) -> ProposeOut:
    """Reads reviewer-confirmed extracted values (documents module) and records them as *proposed* dates only."""
    try:
        from app.modules.documents.models import ExtractedValue
    except ImportError:
        return ProposeOut(proposed=[], skipped=[], message="Document extraction is not available")
    conds = [and_(ExtractedValue.target_entity_type == "contract", ExtractedValue.target_entity_id == c.id)]
    if c.document_id:
        conds.append(ExtractedValue.document_id == c.document_id)
    rows = list(await db.scalars(
        select(ExtractedValue).where(or_(*conds), ExtractedValue.status.in_(("confirmed", "edited")))
        .order_by(ExtractedValue.reviewed_at.asc().nulls_first())
    ))
    if not c.effective_on:
        return ProposeOut(proposed=[], skipped=[],
                          message="Set the contract's effective date (verified against the document) first")

    rules = {r["key"]: r for r in contract_rules(c)}
    direct: dict[str, tuple[date, dict]] = {}
    terms: dict[str, int] = {}
    citations: dict[str, dict] = {}
    skipped: list[str] = []
    for ev in rows:
        field = _norm_field(ev.field)
        cite = {"document_id": ev.document_id, "page": ev.page, "clause": ev.clause, "text": ev.citation_text,
                "confidence": ev.confidence, "extracted_value_id": ev.id, "ai_model": getattr(ev, "ai_model", None)}
        raw = _extracted_scalar(ev.value)
        if field in EXTRACTED_DATE_FIELDS:
            try:
                direct[EXTRACTED_DATE_FIELDS[field]] = (date.fromisoformat(str(raw)[:10]), cite)
            except (ValueError, TypeError):
                skipped.append(f"{ev.field}: not a date ({raw!r})")
        elif field in EXTRACTED_TERM_FIELDS:
            try:
                terms[field] = int(raw)
                citations[field] = cite
            except (ValueError, TypeError):
                skipped.append(f"{ev.field}: not a number of days ({raw!r})")
    out: list[CriticalDate] = []
    if terms:
        out += await generate_dates(db, c, actor, source="ai", overrides=terms, citations=citations)
    for key, (due, cite) in direct.items():
        r = rules.get(key) or {"date_type": "extension" if key.startswith("extension") else key,
                               "label": key.replace("_", " ").capitalize(), "is_blocking": False, "lead_days": 7}
        out.append(await upsert_critical_date(
            db, related_type="contract", related_id=c.id, date_type=r["date_type"], label=r["label"], due_on=due,
            property_id=c.property_id, owner_id=c.owner_id, lead_days=int(r.get("lead_days") or 7),
            is_blocking=bool(r.get("is_blocking")), source="ai", status="proposed", key=key, actor=actor,
            related_label=c.title, citation=cite,
        ))
    await audit.record(db, actor=actor, action="contract.dates_proposed", entity_type=ENTITY, entity_id=c.id,
                       summary=f"{len(out)} proposed from confirmed extraction", ip_address=actor.ip_address)
    await db.commit()
    seen: dict[uuid.UUID, CriticalDate] = {d.id: d for d in out}
    return ProposeOut(proposed=await date_outs(db, list(seen.values())), skipped=skipped,
                      message=None if out else "No confirmed date fields were found in extraction")


async def contract_activity(db: AsyncSession, c: Contract, limit: int = 200) -> list[AuditEvent]:
    child: list[tuple[str, Any]] = [
        ("critical_date", select(CriticalDate.id).where(CriticalDate.related_type == "contract", CriticalDate.related_id == c.id)),
        ("dd_item", select(DDItem.id).where(DDItem.contract_id == c.id)),
        ("third_party_report", select(ThirdPartyReport.id).where(ThirdPartyReport.contract_id == c.id)),
        ("title_exception", select(TitleException.id).where(TitleException.contract_id == c.id)),
        ("estoppel", select(Estoppel.id).where(Estoppel.contract_id == c.id)),
        ("risk_item", select(RiskItem.id).where(RiskItem.contract_id == c.id)),
    ]
    conds = [and_(AuditEvent.entity_type == ENTITY, AuditEvent.entity_id == c.id)]
    for et, sub in child:
        conds.append(and_(AuditEvent.entity_type == et, AuditEvent.entity_id.in_(sub)))
    return list(await db.scalars(select(AuditEvent).where(or_(*conds)).order_by(AuditEvent.occurred_at.desc()).limit(limit)))


# =========================================================================== DD templates & items

def _ti(key, category, title, due_days=None, depends_on=(), report_type=None, severity=None, description=None) -> dict:
    return {"key": key, "category": category, "title": title, "description": description, "severity": severity,
            "due_days": due_days, "depends_on": list(depends_on), "report_type": report_type}


_TITLE_SURVEY = [
    _ti("title_commitment", "title", "Order and review title commitment and exception documents", 10, report_type="title"),
    _ti("survey_order", "survey", "Order ALTA/NSPS survey", 3, report_type="survey"),
    _ti("survey_review", "survey", "Review survey for encroachments, easements and access", 21, ["survey_order"]),
    _ti("title_objection_letter", "title", "Deliver title and survey objection letter", 20,
        ["title_commitment", "survey_review"]),
]
_ENV = [_ti("phase_i", "environmental", "Phase I environmental site assessment", 21, report_type="phase_i")]
_PHYS = [_ti("pca", "physical", "Property condition assessment", 21, report_type="pca")]
_ZONING = [_ti("zoning", "zoning", "Zoning report and compliance confirmation", 21, report_type="zoning")]
_FIN = [
    _ti("appraisal", "financial", "Appraisal", 25, report_type="appraisal"),
    _ti("financials", "financial", "Review operating statements, tax bills and utility history", 14),
    _ti("insurance", "financial", "Insurance quote and loss runs", 20),
]
_LEGAL = [
    _ti("service_contracts", "legal", "Review service contracts and warranties", 20),
    _ti("seller_authority", "legal", "Seller entity, authority and closing deliverables", 25),
]
_LEASE_SINGLE = [
    _ti("lease_review", "tenancy", "Abstract and review the lease and amendments", 10),
    _ti("lease_audit", "tenancy", "Lease audit", 15, ["lease_review"], report_type="lease_audit"),
    _ti("tenant_credit", "financial", "Tenant and guarantor credit review", 14),
    _ti("rofr", "legal", "Confirm tenant ROFR / ROFO waiver or expiration", 15, ["lease_review"]),
    _ti("estoppel_snda", "tenancy", "Tenant estoppel and SNDA", 25, ["lease_review"]),
]
_LEASE_MULTI = [
    _ti("rent_roll", "tenancy", "Reconcile rent roll to leases", 10),
    _ti("lease_audit", "tenancy", "Lease audit", 15, ["rent_roll"], report_type="lease_audit"),
    _ti("cam_recon", "financial", "Review CAM reconciliations and recoveries", 15),
    _ti("co_tenancy", "legal", "Review co-tenancy, exclusives and radius restrictions", 14, ["rent_roll"]),
    _ti("estoppels", "tenancy", "Tenant estoppels (all tenants)", 25, ["rent_roll"]),
    _ti("sndas", "tenancy", "SNDAs for lender", 25, ["rent_roll"]),
]

DEFAULT_TEMPLATES: list[dict] = [
    {"code": "stnl", "name": "Single-tenant net lease", "property_types": ["stnl", "ground_lease"], "is_generic": False,
     "items": _TITLE_SURVEY + _ENV + _PHYS + _ZONING + _LEASE_SINGLE + _FIN + _LEGAL},
    {"code": "multi_tenant_retail", "name": "Multi-tenant retail", "property_types": ["multi_tenant_retail", "retail"],
     "is_generic": False, "items": _TITLE_SURVEY + _ENV + _PHYS + _ZONING + _LEASE_MULTI + _FIN + _LEGAL},
    {"code": "gas_convenience", "name": "Gas / convenience", "property_types": ["gas_convenience"], "is_generic": False,
     "items": _TITLE_SURVEY + _ENV + [
         _ti("ust_records", "environmental", "UST registrations, tank tightness and release history", 14),
         _ti("phase_ii", "environmental", "Phase II subsurface investigation (if Phase I recommends)", 28, ["phase_i"],
             report_type="phase_ii", severity="high"),
         _ti("env_permits", "environmental", "Environmental permits and regulatory compliance history", 14),
         _ti("fuel_supply", "legal", "Review fuel supply and branding agreements", 14),
     ] + _PHYS + _ZONING + _LEASE_SINGLE + _FIN + _LEGAL},
    {"code": "medical", "name": "Medical office", "property_types": ["medical"], "is_generic": False,
     "items": _TITLE_SURVEY + _ENV + _PHYS + _ZONING + [
         _ti("healthcare_licensing", "legal", "Healthcare licensing / certificate-of-need review", 14),
         _ti("medical_waste", "environmental", "Medical waste and hazardous materials handling review", 14),
         _ti("ada", "physical", "ADA accessibility review", 20, ["pca"]),
     ] + _LEASE_MULTI + _FIN + _LEGAL},
    {"code": "land", "name": "Land", "property_types": ["land"], "is_generic": False,
     "items": _TITLE_SURVEY + _ENV + _ZONING + [
         _ti("entitlements", "zoning", "Entitlement and land-use path review", 20, ["zoning"]),
         _ti("utilities", "physical", "Utility availability and capacity letters", 20),
         _ti("geotech", "physical", "Geotechnical investigation", 25),
         _ti("wetlands_flood", "environmental", "Wetlands delineation and flood determination", 20),
         _ti("access", "physical", "Access, curb cuts and traffic review", 15, ["survey_review"]),
         _ti("appraisal", "financial", "Appraisal", 25, report_type="appraisal"),
         _ti("seller_authority", "legal", "Seller entity, authority and closing deliverables", 25),
     ]},
    {"code": "office_industrial", "name": "Office / industrial (generic)",
     "property_types": ["office", "industrial", "mixed_use", "multifamily", "hospitality", "other"], "is_generic": True,
     "items": _TITLE_SURVEY + _ENV + _PHYS + _ZONING + _LEASE_MULTI + _FIN + _LEGAL},
]


async def ensure_templates(db: AsyncSession) -> list[DDTemplate]:
    rows = list(await db.scalars(select(DDTemplate).where(DDTemplate.deleted_at.is_(None))))
    have = {r.code for r in rows}
    missing = [t for t in DEFAULT_TEMPLATES if t["code"] not in have]
    if missing:
        now = utcnow()
        await db.execute(pg_insert(DDTemplate).values([
            {"id": uuid.uuid4(), "code": t["code"], "name": t["name"], "property_types": t["property_types"],
             "is_generic": t["is_generic"], "is_active": True, "version": 1, "items": t["items"],
             "created_at": now, "updated_at": now} for t in missing
        ]).on_conflict_do_nothing(index_elements=["code"]))
        rows = list(await db.scalars(select(DDTemplate).where(DDTemplate.deleted_at.is_(None))))
    return sorted(rows, key=lambda r: (r.is_generic, r.name))


async def get_template(db: AsyncSession, template_id: uuid.UUID) -> DDTemplate:
    t = await db.get(DDTemplate, template_id)
    if not t or t.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "DD template not found")
    return t


async def template_for(db: AsyncSession, property_type: str | None) -> DDTemplate | None:
    rows = [t for t in await ensure_templates(db) if t.is_active]
    for t in rows:
        if property_type and property_type in (t.property_types or []):
            return t
    return next((t for t in rows if t.is_generic), rows[0] if rows else None)


async def apply_template(db: AsyncSession, c: Contract, template_id: uuid.UUID | None, actor) -> list[DDItem]:
    """Creates DD items (and their third-party report placeholders) from a template. Items whose key already
    exists on the contract are skipped, so re-applying is safe. Does not commit."""
    if template_id:
        tpl = await get_template(db, template_id)
    else:
        ptype = (await _property_info(db, [c.property_id])).get(c.property_id, (None, None))[1]
        tpl = await template_for(db, ptype)
    if tpl is None:
        return []
    existing = {i.key: i for i in await db.scalars(select(DDItem).where(DDItem.contract_id == c.id,
                                                                         DDItem.deleted_at.is_(None))) if i.key}
    reports = {r.report_type: r for r in await db.scalars(select(ThirdPartyReport).where(
        ThirdPartyReport.contract_id == c.id, ThirdPartyReport.deleted_at.is_(None)))}
    actor_id = getattr(actor, "id", None)
    created: list[tuple[DDItem, dict]] = []
    base_order = len(existing)
    for n, spec in enumerate(tpl.items or []):
        if spec["key"] in existing:
            continue
        due = c.effective_on + timedelta(days=int(spec["due_days"])) if c.effective_on and spec.get("due_days") is not None else None
        item = DDItem(contract_id=c.id, property_id=c.property_id, template_id=tpl.id, key=spec["key"],
                      category=spec.get("category") or "general", title=spec["title"], description=spec.get("description"),
                      owner_id=c.owner_id, status="not_started", due_on=due, depends_on=[], source="template",
                      severity=spec.get("severity"), escalation_level=0, sort_order=base_order + n,
                      created_by_id=actor_id, updated_by_id=actor_id)
        db.add(item)
        rt = spec.get("report_type")
        if rt and rt not in reports:
            rep = ThirdPartyReport(contract_id=c.id, property_id=c.property_id, report_type=rt, status="not_ordered",
                                   expected_on=due, owner_id=c.owner_id, created_by_id=actor_id, updated_by_id=actor_id)
            db.add(rep)
            reports[rt] = rep
        created.append((item, spec))
        existing[spec["key"]] = item
    await db.flush()
    for item, spec in created:
        item.depends_on = [str(existing[k].id) for k in spec.get("depends_on") or [] if k in existing]
        rt = spec.get("report_type")
        if rt and rt in reports:
            item.report_id = reports[rt].id
    if created:
        await audit.record(db, actor=actor, action="contract.dd_template_applied", entity_type=ENTITY, entity_id=c.id,
                           summary=f"{tpl.name} v{tpl.version}: {len(created)} items",
                           ip_address=getattr(actor, "ip_address", None))
    await db.flush()
    return [i for i, _ in created]


async def apply_template_commit(db: AsyncSession, c: Contract, template_id: uuid.UUID | None, actor) -> list[DDItem]:
    items = await apply_template(db, c, template_id, actor)
    await db.commit()
    return items


async def save_template(db: AsyncSession, t: DDTemplate | None, data, actor) -> DDTemplate:
    values = data.model_dump(exclude_unset=True)
    if "items" in values:
        keys = [i["key"] for i in values["items"]]
        if len(keys) != len(set(keys)):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Template item keys must be unique")
        for i in values["items"]:
            unknown = set(i["depends_on"]) - set(keys)
            if unknown:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown dependency {sorted(unknown)[0]}")
    if t is None:
        if await db.scalar(select(DDTemplate.id).where(DDTemplate.code == values["code"])):
            raise HTTPException(status.HTTP_409_CONFLICT, "A template with this code already exists")
        t = DDTemplate(**values, is_generic=False, is_active=True, version=1, created_by_id=actor.id, updated_by_id=actor.id)
        db.add(t)
        await db.flush()
        await audit.record(db, actor=actor, action="dd_template.created", entity_type="dd_template", entity_id=t.id,
                           summary=t.name, ip_address=actor.ip_address)
    else:
        changes = _apply(t, values)
        if changes:
            if "items" in changes:
                t.version = (t.version or 1) + 1
                changes["items"] = {"from": f"{len(changes['items']['from'] or [])} items",
                                    "to": f"{len(values['items'])} items (v{t.version})"}
            t.updated_by_id = actor.id
            await audit.record(db, actor=actor, action="dd_template.updated", entity_type="dd_template", entity_id=t.id,
                               summary=t.name, changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return t


async def get_dd_item(db: AsyncSession, item_id: uuid.UUID) -> DDItem:
    i = await db.get(DDItem, item_id)
    if not i or i.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "DD item not found")
    return i


async def dd_outs(db: AsyncSession, items: list[DDItem]) -> list[DDItemOut]:
    names = await _user_names(db, [i.owner_id for i in items])
    dep_ids = {_uuid(d) for i in items for d in (i.depends_on or [])} - {None}
    deps = {d.id: d for d in await db.scalars(select(DDItem).where(DDItem.id.in_(dep_ids)))} if dep_ids else {}
    t = today()
    out = []
    for i in items:
        o = DDItemOut.model_validate(i)
        o.owner_name = names.get(i.owner_id)
        o.blocked_by = [DependencyRef(id=d.id, title=d.title, status=d.status)
                        for d in (deps.get(_uuid(x)) for x in i.depends_on or [])
                        if d is not None and not d.deleted_at and d.status not in DD_DONE]
        o.is_overdue = bool(i.due_on and i.due_on < t and i.status not in DD_DONE)
        out.append(o)
    return out


async def _validate_deps(db: AsyncSession, contract_id: uuid.UUID, item_id: uuid.UUID | None,
                         dep_ids: list[uuid.UUID]) -> list[str]:
    if not dep_ids:
        return []
    if item_id and item_id in dep_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "An item cannot depend on itself")
    rows = list(await db.scalars(select(DDItem).where(DDItem.contract_id == contract_id, DDItem.deleted_at.is_(None))))
    graph = {r.id: [_uuid(x) for x in (r.depends_on or [])] for r in rows}
    if set(dep_ids) - set(graph):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Dependencies must be DD items on the same contract")
    if item_id:
        graph[item_id] = list(dep_ids)
        stack, seen = list(dep_ids), set()
        while stack:
            n = stack.pop()
            if n == item_id:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Dependency would create a cycle")
            if n in seen:
                continue
            seen.add(n)
            stack += [x for x in graph.get(n, []) if x]
    return [str(d) for d in dict.fromkeys(dep_ids)]


async def _check_completable(db: AsyncSession, i: DDItem) -> None:
    dep_ids = [_uuid(x) for x in i.depends_on or []]
    dep_ids = [d for d in dep_ids if d]
    if not dep_ids:
        return
    open_deps = list(await db.scalars(select(DDItem).where(DDItem.id.in_(dep_ids), DDItem.deleted_at.is_(None),
                                                           DDItem.status.notin_(DD_DONE))))
    if open_deps:
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "message": "Complete the items this depends on first",
            "open_dependencies": [{"id": str(d.id), "title": d.title, "status": d.status} for d in open_deps],
        })


async def create_dd_item(db: AsyncSession, c: Contract, data: DDItemCreate, actor) -> DDItem:
    values = data.model_dump()
    values["depends_on"] = await _validate_deps(db, c.id, None, values["depends_on"])
    max_order = await db.scalar(select(func.max(DDItem.sort_order)).where(DDItem.contract_id == c.id)) or 0
    i = DDItem(**values, contract_id=c.id, property_id=c.property_id, escalation_level=0, sort_order=max_order + 1,
               created_by_id=actor.id, updated_by_id=actor.id)
    if i.status in DD_DONE:
        await _check_completable(db, i)
        i.completed_at, i.completed_by_id = utcnow(), actor.id
    db.add(i)
    await db.flush()
    await audit.record(db, actor=actor, action="dd_item.created", entity_type="dd_item", entity_id=i.id, summary=i.title,
                       ip_address=actor.ip_address)
    await db.commit()
    return i


async def update_dd_item(db: AsyncSession, i: DDItem, data: DDItemUpdate, actor) -> DDItem:
    values = data.model_dump(exclude_unset=True)
    if "depends_on" in values:
        values["depends_on"] = await _validate_deps(db, i.contract_id, i.id, values["depends_on"] or [])
    new_status = values.get("status")
    if new_status and new_status != i.status:
        if new_status == "complete":
            probe = DDItem(depends_on=values.get("depends_on", i.depends_on))
            await _check_completable(db, probe)
        if new_status in DD_DONE:
            values["completed_at"], values["completed_by_id"] = utcnow(), actor.id
        elif i.status in DD_DONE:
            values["completed_at"], values["completed_by_id"] = None, None
    changes = _apply(i, values)
    if changes:
        i.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="dd_item.updated", entity_type="dd_item", entity_id=i.id,
                           summary=i.title, changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return i


async def escalate_dd_item(db: AsyncSession, i: DDItem, note: str, actor) -> DDItem:
    from app.modules.tasks.service import raise_alert

    c = await get_contract(db, i.contract_id)
    i.escalation_level = (i.escalation_level or 0) + 1
    i.escalated_at = utcnow()
    i.escalation_note = note
    i.updated_by_id = actor.id
    target = await _manager_of(db, i.owner_id) or c.owner_id or i.owner_id
    await raise_alert(db, title=f"Escalated DD item: {i.title}", reason=note,
                      severity="high" if i.severity in HIGH_SEVERITIES else "medium", owner_id=target,
                      related_type="contract", related_id=c.id, related_label=c.title, rule_key="contracts.dd_escalation",
                      idempotency_key=f"dd_item:{i.id}:escalation:{i.escalation_level}")
    await audit.record(db, actor=actor, action="dd_item.escalated", entity_type="dd_item", entity_id=i.id,
                       summary=f"{i.title}: {note}", changes={"escalation_level": i.escalation_level},
                       ip_address=actor.ip_address)
    await db.commit()
    return i


async def _soft_delete(db: AsyncSession, obj, entity_type: str, label: str, actor) -> None:
    obj.deleted_at = utcnow()
    obj.updated_by_id = actor.id
    await audit.record(db, actor=actor, action=f"{entity_type}.archived", entity_type=entity_type, entity_id=obj.id,
                       summary=label, ip_address=actor.ip_address)
    await db.commit()


async def delete_dd_item(db: AsyncSession, i: DDItem, actor) -> None:
    dependents = await db.scalar(select(func.count()).select_from(DDItem).where(
        DDItem.contract_id == i.contract_id, DDItem.deleted_at.is_(None), DDItem.depends_on.contains([str(i.id)])))
    if dependents:
        raise HTTPException(status.HTTP_409_CONFLICT, "Other items depend on this one; remove the dependency first")
    await _soft_delete(db, i, "dd_item", i.title, actor)


# =========================================================================== third-party reports

async def _child(db: AsyncSession, model, obj_id: uuid.UUID, what: str):
    obj = await db.get(model, obj_id)
    if not obj or obj.deleted_at:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")
    return obj


async def _org_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    from app.modules.contacts.models import Organization

    return dict((await db.execute(select(Organization.id, Organization.name).where(Organization.id.in_(ids)))).all())


async def _person_names(db: AsyncSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    from app.modules.contacts.models import Person

    return dict((await db.execute(select(Person.id, Person.full_name).where(Person.id.in_(ids)))).all())


async def report_outs(db: AsyncSession, rows: list[ThirdPartyReport]) -> list[ReportOut]:
    orgs = await _org_names(db, [r.vendor_organization_id for r in rows])
    names = await _user_names(db, [r.owner_id for r in rows])
    t = today()
    out = []
    for r in rows:
        o = ReportOut.model_validate(r)
        o.vendor_label = orgs.get(r.vendor_organization_id) or r.vendor_name
        o.owner_name = names.get(r.owner_id)
        o.is_late = bool(r.expected_on and r.expected_on < t and r.status in ("not_ordered", "ordered", "in_progress"))
        out.append(o)
    return out


def _report_defaults(values: dict, current: ThirdPartyReport | None = None) -> None:
    st = values.get("status")
    if st in ("ordered", "in_progress") and not values.get("ordered_on") and not (current and current.ordered_on):
        values["ordered_on"] = today()
    if st in ("delivered", "reviewed") and not values.get("delivered_on") and not (current and current.delivered_on):
        values["delivered_on"] = today()


async def create_report(db: AsyncSession, c: Contract, data: ReportCreate, actor) -> ThirdPartyReport:
    values = data.model_dump()
    _report_defaults(values)
    r = ThirdPartyReport(**values, contract_id=c.id, property_id=c.property_id, created_by_id=actor.id,
                         updated_by_id=actor.id)
    db.add(r)
    await db.flush()
    await audit.record(db, actor=actor, action="third_party_report.created", entity_type="third_party_report",
                       entity_id=r.id, summary=r.report_type, ip_address=actor.ip_address)
    await db.commit()
    return r


async def update_report(db: AsyncSession, r: ThirdPartyReport, data: ReportUpdate, actor) -> ThirdPartyReport:
    values = data.model_dump(exclude_unset=True)
    _report_defaults(values, r)
    changes = _apply(r, values)
    if changes:
        r.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="third_party_report.updated", entity_type="third_party_report",
                           entity_id=r.id, summary=r.report_type, changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return r


# =========================================================================== title & survey

async def exception_outs(db: AsyncSession, rows: list[TitleException]) -> list[TitleExceptionOut]:
    people = await _person_names(db, [r.attorney_person_id for r in rows])
    orgs = await _org_names(db, [r.attorney_organization_id for r in rows])
    out = []
    for r in rows:
        o = TitleExceptionOut.model_validate(r)
        o.attorney_label = " · ".join(x for x in (people.get(r.attorney_person_id), orgs.get(r.attorney_organization_id)) if x) or None
        out.append(o)
    return out


def _exception_defaults(values: dict, current: TitleException | None = None) -> None:
    st = values.get("status")
    if st == "objected" and not values.get("objection_sent_on") and not (current and current.objection_sent_on):
        values["objection_sent_on"] = today()
    if st in ("cured", "accepted", "waived") and not values.get("resolved_on"):
        values["resolved_on"] = today()
    if st in ("open", "objected", "cure_pending", "uncured") and current and current.resolved_on:
        values["resolved_on"] = None


async def create_exception(db: AsyncSession, c: Contract, data: TitleExceptionCreate, actor) -> TitleException:
    values = data.model_dump()
    _exception_defaults(values)
    if not values.get("attorney_person_id") and not values.get("attorney_organization_id"):
        values["attorney_person_id"], values["attorney_organization_id"] = c.attorney_person_id, c.attorney_organization_id
    x = TitleException(**values, contract_id=c.id, property_id=c.property_id, created_by_id=actor.id, updated_by_id=actor.id)
    db.add(x)
    await db.flush()
    await audit.record(db, actor=actor, action="title_exception.created", entity_type="title_exception", entity_id=x.id,
                       summary=x.description[:200], ip_address=actor.ip_address)
    await db.commit()
    return x


async def update_exception(db: AsyncSession, x: TitleException, data: TitleExceptionUpdate, actor) -> TitleException:
    values = data.model_dump(exclude_unset=True)
    _exception_defaults(values, x)
    changes = _apply(x, values)
    if changes:
        x.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="title_exception.updated", entity_type="title_exception",
                           entity_id=x.id, summary=x.description[:200], changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return x


# =========================================================================== estoppels / SNDA

def detect_discrepancies(e: Estoppel) -> list[dict]:
    """Compares tenant-reported values with lease / rent-roll values. Only fields with both values are compared."""
    out: list[dict] = []

    def money(field: str, label: str, expected, reported, tolerance_pct: float) -> None:
        if expected is None or reported is None:
            return
        tol = max(1.0, abs(expected) * tolerance_pct)
        if abs(float(reported) - float(expected)) > tol:
            out.append({"field": field, "label": label, "expected": expected, "reported": reported,
                        "delta": round(float(reported) - float(expected), 2)})

    money("monthly_rent", "Monthly rent", e.expected_monthly_rent, e.reported_monthly_rent, 0.005)
    money("security_deposit", "Security deposit", e.expected_security_deposit, e.reported_security_deposit, 0.0)
    if e.expected_expiration_on and e.reported_expiration_on and e.expected_expiration_on != e.reported_expiration_on:
        out.append({"field": "expiration_on", "label": "Lease expiration", "expected": e.expected_expiration_on.isoformat(),
                    "reported": e.reported_expiration_on.isoformat(),
                    "delta": (e.reported_expiration_on - e.expected_expiration_on).days})
    if e.reported_landlord_default:
        out.append({"field": "landlord_default", "label": "Tenant reports landlord default", "expected": False,
                    "reported": True, "delta": None})
    return out


async def _prefill_from_lease(db: AsyncSession, e: Estoppel) -> None:
    """Fills expected values from the leases module when a lease is linked (guarded: module may be absent)."""
    if not e.lease_id:
        return
    try:
        from app.modules.leases import models as lease_models
    except ImportError:
        return
    Lease = getattr(lease_models, "Lease", None)
    RentStep = getattr(lease_models, "RentStep", None)
    if Lease is None:
        return
    lease = await db.get(Lease, e.lease_id)
    if not lease:
        return
    if e.expected_expiration_on is None:
        e.expected_expiration_on = getattr(lease, "expiration_on", None)
    if e.expected_monthly_rent is None and RentStep is not None:
        t = today()
        step = await db.scalar(select(RentStep).where(
            RentStep.lease_id == e.lease_id, RentStep.start_on <= t,
            or_(RentStep.end_on.is_(None), RentStep.end_on >= t)).order_by(RentStep.start_on.desc()).limit(1))
        if step is not None:
            monthly = getattr(step, "monthly_rent", None)
            annual = getattr(step, "annual_rent", None)
            e.expected_monthly_rent = monthly if monthly is not None else (round(annual / 12, 2) if annual else None)
    if not e.tenant_name and getattr(lease, "tenant_name", None):
        e.tenant_name = lease.tenant_name


async def _refresh_discrepancies(db: AsyncSession, e: Estoppel, c: Contract, actor) -> None:
    from app.modules.tasks.service import raise_alert

    found = detect_discrepancies(e)
    sig = hashlib.sha1(repr(sorted((d["field"], str(d["reported"])) for d in found)).encode()).hexdigest()[:12]
    old_sig = hashlib.sha1(repr(sorted((d["field"], str(d["reported"])) for d in (e.discrepancies or []))).encode()).hexdigest()[:12]
    e.discrepancies = audit.to_jsonable(found)
    e.has_discrepancy = bool(found)
    if sig != old_sig:
        e.discrepancy_resolution = None
        e.discrepancy_resolved_at = None
        e.discrepancy_resolved_by_id = None
    if found and sig != old_sig:
        await raise_alert(
            db, title=f"{e.kind.upper()} discrepancy: {e.tenant_name}", severity="high", owner_id=c.owner_id,
            reason="; ".join(f"{d['label']}: expected {d['expected']}, reported {d['reported']}" for d in found),
            related_type="contract", related_id=c.id, related_label=c.title, rule_key="contracts.estoppel_discrepancy",
            idempotency_key=f"estoppel:{e.id}:discrepancy:{sig}",
        )


def _estoppel_defaults(values: dict, current: Estoppel | None = None) -> None:
    st = values.get("status")
    if st == "requested" and not values.get("requested_on") and not (current and current.requested_on):
        values["requested_on"] = today()
    if st in ("received", "approved") and not values.get("received_on") and not (current and current.received_on):
        values["received_on"] = today()


async def create_estoppel(db: AsyncSession, c: Contract, data: EstoppelCreate, actor) -> Estoppel:
    values = data.model_dump()
    _estoppel_defaults(values)
    if values.get("status") == "approved":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Record the estoppel as received before approving it")
    e = Estoppel(**values, contract_id=c.id, property_id=c.property_id, discrepancies=[], has_discrepancy=False,
                 created_by_id=actor.id, updated_by_id=actor.id)
    db.add(e)
    await db.flush()
    await _prefill_from_lease(db, e)
    await _refresh_discrepancies(db, e, c, actor)
    await audit.record(db, actor=actor, action="estoppel.created", entity_type="estoppel", entity_id=e.id,
                       summary=f"{e.kind}: {e.tenant_name}", ip_address=actor.ip_address)
    await db.commit()
    return e


async def update_estoppel(db: AsyncSession, e: Estoppel, data: EstoppelUpdate, actor) -> Estoppel:
    c = await get_contract(db, e.contract_id)
    values = data.model_dump(exclude_unset=True)
    _estoppel_defaults(values, e)
    changes = _apply(e, values)
    if not changes:
        return e
    if "lease_id" in changes:
        await _prefill_from_lease(db, e)
    await _refresh_discrepancies(db, e, c, actor)
    if e.status == "approved" and e.has_discrepancy and not e.discrepancy_resolved_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Resolve the reported discrepancies before approving")
    e.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="estoppel.updated", entity_type="estoppel", entity_id=e.id,
                       summary=f"{e.kind}: {e.tenant_name}", changes=changes, ip_address=actor.ip_address)
    await db.commit()
    return e


async def resolve_estoppel(db: AsyncSession, e: Estoppel, note: str, actor) -> Estoppel:
    if not e.has_discrepancy:
        raise HTTPException(status.HTTP_409_CONFLICT, "No discrepancy to resolve")
    e.discrepancy_resolution = note
    e.discrepancy_resolved_at = utcnow()
    e.discrepancy_resolved_by_id = actor.id
    e.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="estoppel.discrepancy_resolved", entity_type="estoppel", entity_id=e.id,
                       summary=f"{e.tenant_name}: {note}", changes={"discrepancies": e.discrepancies},
                       ip_address=actor.ip_address)
    await db.commit()
    return e


# =========================================================================== risks

def _needs_decision(r: RiskItem) -> bool:
    return bool(r.decision_required and r.decision is None and r.status != "closed" and r.severity in HIGH_SEVERITIES)


async def risk_outs(db: AsyncSession, rows: list[RiskItem]) -> list[RiskOut]:
    names = await _user_names(db, [r.owner_id for r in rows] + [r.decided_by_id for r in rows])
    out = []
    for r in rows:
        o = RiskOut.model_validate(r)
        o.owner_name = names.get(r.owner_id)
        o.decided_by_name = names.get(r.decided_by_id)
        o.needs_decision = _needs_decision(r)
        out.append(o)
    return out


async def create_risk(db: AsyncSession, c: Contract, data: RiskCreate, actor) -> RiskItem:
    values = data.model_dump()
    if values["decision_required"] is None:
        values["decision_required"] = values["severity"] in HIGH_SEVERITIES
    if values["decision_due_on"] is None:
        feas = await feasibility_date(db, c.id)
        values["decision_due_on"] = feas.due_on if feas else None
    r = RiskItem(**values, contract_id=c.id, property_id=c.property_id, status="open", created_by_id=actor.id,
                 updated_by_id=actor.id)
    if r.owner_id is None:
        r.owner_id = c.owner_id
    db.add(r)
    await db.flush()
    await audit.record(db, actor=actor, action="risk_item.created", entity_type="risk_item", entity_id=r.id,
                       summary=f"{r.severity}: {r.title}", ip_address=actor.ip_address)
    await db.commit()
    return r


async def update_risk(db: AsyncSession, r: RiskItem, data: RiskUpdate, actor) -> RiskItem:
    changes = _apply(r, data.model_dump(exclude_unset=True))
    if changes:
        r.updated_by_id = actor.id
        await audit.record(db, actor=actor, action="risk_item.updated", entity_type="risk_item", entity_id=r.id,
                           summary=r.title, changes=changes, ip_address=actor.ip_address)
        await db.commit()
    return r


async def decide_risk(db: AsyncSession, r: RiskItem, data: RiskDecideIn, actor) -> RiskItem:
    """Every decision (including revisions) is kept in the audit trail with its reasoning."""
    prev = {"decision": r.decision, "reason": r.decision_reason}
    r.decision = data.decision
    r.decision_reason = data.reason
    r.decided_by_id = actor.id
    r.decided_at = utcnow()
    if r.status in ("open", "mitigating"):
        r.status = "decided"
    r.updated_by_id = actor.id
    await audit.record(db, actor=actor, action="risk_item.decided", entity_type="risk_item", entity_id=r.id,
                       summary=f"{data.decision}: {r.title}", ip_address=actor.ip_address,
                       changes={"decision": {"from": prev["decision"], "to": data.decision},
                                "reason": {"from": prev["reason"], "to": data.reason}})
    await db.commit()
    return r


# =========================================================================== extension / termination decisions

async def record_decision(db: AsyncSession, c: Contract, data: DecisionCreate, actor) -> ContractDecision:
    """Immutable decision history. Extensions reschedule the targeted date (default: closing) with the reasoning;
    termination waives open dates; proceeding requires every high-severity risk to have a decision."""
    if c.status not in ("executed",):
        raise HTTPException(status.HTTP_409_CONFLICT, "Decisions are recorded on executed contracts")
    dates = {d.key: d for d in await _contract_dates(db, c.id)}
    target: CriticalDate | None = None
    if data.critical_date_id:
        target = next((d for d in dates.values() if d.id == data.critical_date_id), None)
        if target is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Critical date is not on this contract")
    previous_due = target.due_on if target else None
    extra: dict[str, Any] = {}

    if data.kind == "extend":
        target = target or dates.get("closing") or dates.get("feasibility_expiry")
        if target is None or not data.new_due_on:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "An extension needs the date to extend and the new date")
        if data.new_due_on <= target.due_on:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The extended date must be after the current date")
        previous_due = target.due_on
        if target.status == "proposed":
            await _confirm(db, target, ConfirmIn(note="Confirmed when recording extension"), actor)
        await _reschedule(db, target, data.new_due_on, f"Extension: {data.reasoning}", actor)
        await _recompute_dependents(db, c.id, actor)
    elif data.kind == "terminate":
        waived = 0
        for d in dates.values():
            if d.status in OPEN_DATE_STATUSES:
                await _waive(db, d, f"Contract terminated: {data.reasoning}", actor)
                waived += 1
        prev = c.status
        c.status = "terminated"
        c.terminated_at = utcnow()
        c.updated_by_id = actor.id
        extra["waived_dates"] = waived
        await audit.record(db, actor=actor, action="contract.terminated", entity_type=ENTITY, entity_id=c.id,
                           summary=data.reasoning[:300], changes={"status": {"from": prev, "to": "terminated"}},
                           ip_address=actor.ip_address)
    elif data.kind == "proceed":
        risks = list(await db.scalars(select(RiskItem).where(RiskItem.contract_id == c.id, RiskItem.deleted_at.is_(None))))
        pending = [r for r in risks if _needs_decision(r)]
        if pending:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {
                "message": "Record a decision on every high-severity risk before proceeding past feasibility",
                "risks": [{"id": str(r.id), "title": r.title, "severity": r.severity} for r in pending],
            })
        feas = target or dates.get("feasibility_expiry")
        if feas is not None and feas.status in OPEN_DATE_STATUSES:
            if feas.status == "proposed":
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                    "Confirm the feasibility deadline against the contract first")
            await _complete(db, feas, f"Proceeding: {data.reasoning}", actor)
            target = feas
    elif data.kind == "waive_contingency":
        if target is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose the contingency date being waived")
        await _waive(db, target, f"Contingency waived: {data.reasoning}", actor)

    d = ContractDecision(
        contract_id=c.id, kind=data.kind, reasoning=data.reasoning, critical_date_id=target.id if target else None,
        previous_due_on=previous_due, new_due_on=data.new_due_on if data.kind == "extend" else None,
        effective_on=data.effective_on or today(), decided_by_id=actor.id, decided_by_name=actor.full_name,
        decided_at=utcnow(), data=audit.to_jsonable({**extra, "target_label": target.label if target else None}),
    )
    db.add(d)
    await db.flush()
    await audit.record(db, actor=actor, action="contract.decision_recorded", entity_type=ENTITY, entity_id=c.id,
                       summary=f"{data.kind}: {data.reasoning[:200]}", ip_address=actor.ip_address,
                       changes={"decision_id": d.id, "kind": data.kind, "new_due_on": d.new_due_on})
    await db.commit()
    return d
