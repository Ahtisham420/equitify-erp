"""Metric engine (spec 34): common filters, evaluation context, the KPI definition type and the SQL that
evaluates a KPI.

One KPI definition drives its tile value, chart breakdowns, drill-through records and exports, so a metric
means the same thing everywhere it appears. Every source module is optional: a KPI whose module is not
installed, whose table is missing or whose permission the user lacks is simply unavailable.
"""
import importlib
import logging
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException
from sqlalchemy import DateTime, String, cast, false, func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.audit import to_jsonable
from app.core.deps import CurrentUser
from app.core.security import utcnow

log = logging.getLogger("reports")

NONE = "__none__"  # filter / facet value meaning "not set"
UNITS = ["count", "currency", "percent", "days", "number"]
FAMILIES = ["sourcing", "outreach", "pipeline", "offers", "contracts", "closings", "portfolio", "operations",
            "brokerage", "data", "reactivation"]
DATE_PRESETS = [7, 30, 90, 365]


def load(ref: str) -> Any:
    """Lazily resolve `module.path:Name` (relative to app.modules unless it starts with `app.`)."""
    mod, _, name = ref.partition(":")
    path = mod if mod.startswith("app.") else f"app.modules.{mod}"
    try:
        return getattr(importlib.import_module(path), name)
    except (ImportError, AttributeError):
        return None


# ============================================================================ filters


def _uuid(value: str | None) -> uuid.UUID | None:
    return uuid.UUID(value) if value else None


@dataclass
class Filters:
    """Filters shared by every dashboard and KPI (date, user/team, property type, geography, territory,
    source, stage) plus KPI-specific facets (`f_<name>`) used for drill-through from breakdowns."""

    date_from: date | None = None
    date_to: date | None = None
    days: int | None = None
    user: list[str] = field(default_factory=list)
    team: uuid.UUID | None = None
    property_type: list[str] = field(default_factory=list)
    state: list[str] = field(default_factory=list)
    county: list[str] = field(default_factory=list)
    territory: uuid.UUID | None = None
    source: list[str] = field(default_factory=list)
    stage: list[str] = field(default_factory=list)
    facets: dict[str, str] = field(default_factory=dict)

    LIST_KEYS = ("user", "property_type", "state", "county", "source", "stage")

    @classmethod
    def parse(cls, items: Iterable[tuple[str, str]]) -> "Filters":
        multi: dict[str, list[str]] = {}
        for key, value in items:
            value = (value or "").strip()
            if value:
                multi.setdefault(key, []).append(value[:200])

        def one(key: str) -> str | None:
            values = multi.get(key)
            return values[-1] if values else None

        try:
            days_raw = one("days")
            days = int(days_raw) if days_raw and days_raw != "all" else None
            if days is not None and not 1 <= days <= 3650:
                raise ValueError("days")
            out = cls(
                date_from=date.fromisoformat(v) if (v := one("date_from")) else None,
                date_to=date.fromisoformat(v) if (v := one("date_to")) else None,
                days=days,
                team=_uuid(one("team")),
                territory=_uuid(one("territory")),
            )
        except ValueError:
            raise HTTPException(422, "Invalid report filter value")
        for key in cls.LIST_KEYS:
            setattr(out, key, multi.get(key, [])[:50])
        out.facets = {k[2:]: v[-1] for k, v in multi.items() if k.startswith("f_") and len(k) > 2}
        if out.date_from and out.date_to and out.date_from > out.date_to:
            raise HTTPException(422, "date_from must be on or before date_to")
        return out

    @classmethod
    def from_dict(cls, data: dict | None) -> "Filters":
        items: list[tuple[str, str]] = []
        for key, value in (data or {}).items():
            for v in value if isinstance(value, list) else [value]:
                if v is not None:
                    items.append((key, str(v)))
        return cls.parse(items)

    def params(self, *, facets: dict[str, str] | None = None, **override: Any) -> list[tuple[str, str]]:
        """Query-string items for hrefs. `override` replaces a filter (e.g. user=[id]); facets are added."""
        values = {**{k: getattr(self, k) for k in ("date_from", "date_to", "days", "team", "territory",
                                                   *self.LIST_KEYS)}, **override}
        out: list[tuple[str, str]] = []
        if values.get("date_from") or values.get("date_to"):
            for key in ("date_from", "date_to"):
                if values.get(key):
                    out.append((key, values[key].isoformat()))
        else:
            # Explicit "all" so drill pages (whose UI defaults to 30 days) keep the same window.
            out.append(("days", str(values["days"]) if values.get("days") else "all"))
        for key in ("team", "territory"):
            if values.get(key):
                out.append((key, str(values[key])))
        for key in self.LIST_KEYS:
            out += [(key, str(v)) for v in values.get(key) or []]
        for name, value in {**self.facets, **(facets or {})}.items():
            out.append((f"f_{name}", value))
        return out

    def to_dict(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for key, value in self.params():
            out.setdefault(key, []).append(value)
        return out

    def period(self, today: date) -> tuple[date | None, date | None]:
        if self.date_from or self.date_to:
            return self.date_from, self.date_to
        if self.days:
            return today - timedelta(days=self.days - 1), today
        return None, None


def query_string(items: list[tuple[str, str]]) -> str:
    qs = urlencode(items)
    return f"?{qs}" if qs else ""


# ============================================================================ context


@dataclass
class Ctx:
    user: CurrentUser
    f: Filters
    now: datetime = field(default_factory=utcnow)

    @property
    def today(self) -> date:
        return self.now.date()

    @property
    def eod(self) -> datetime:
        """Start of tomorrow (UTC) — `< eod` means "due today or earlier"."""
        return datetime.combine(self.today + timedelta(days=1), time.min, tzinfo=timezone.utc)

    @property
    def period(self) -> tuple[date | None, date | None]:
        return self.f.period(self.today)

    @property
    def user_ids(self) -> list[Any]:
        out: list[Any] = []
        for value in self.f.user:
            if value == "me":
                out.append(self.user.id)
            elif value == NONE:
                out.append(NONE)
            else:
                try:
                    out.append(uuid.UUID(value))
                except ValueError:
                    continue
        return out

    def with_filters(self, f: Filters) -> "Ctx":
        return Ctx(user=self.user, f=f, now=self.now)

    def previous(self) -> "Ctx | None":
        """The equal-length period immediately before the current one (for deltas)."""
        start, end = self.period
        if not start:
            return None
        end = end or self.today
        length = (end - start).days + 1
        return self.with_filters(replace(self.f, date_from=start - timedelta(days=length),
                                         date_to=start - timedelta(days=1), days=None))


# ============================================================================ KPI definition


Fn = Callable[..., Any]


@dataclass(frozen=True)
class Col:
    key: str
    label: str
    expr: Fn  # (Model, Ctx) -> column expression
    kind: str = "text"  # text|date|datetime|currency|number|percent|status|bool|days


@dataclass
class Kpi:
    """One metric definition reused everywhere: tile, chart, drill-through records, export and snapshot."""

    key: str
    label: str
    family: str
    module: str  # permission module the records belong to
    model: str  # "module.models:Class"
    definition: str
    title: Fn  # (M, c) -> record title expression
    href: Fn  # (M, c) -> record link expression
    where: Fn = lambda M, c: []  # (M, c) -> list of conditions
    unit: str = "count"
    agg: str = "count"  # count | sum | avg | rate | wavg
    measure: Fn | None = None  # (M, c) -> expr (sum/avg value, rate hit condition, wavg value)
    weight: Fn | None = None  # (M, c) -> expr for wavg
    measure_label: str | None = None
    weight_label: str | None = None
    hit_label: str | None = None
    dims: dict[str, Fn] = field(default_factory=dict)  # date|user|property|source|stage -> (M) -> expr
    facets: dict[str, Fn] = field(default_factory=dict)  # name -> (M, c) -> expr
    cols: list[Col] = field(default_factory=list)
    sort: Fn | None = None  # (M, c) -> list of order-by expressions
    module_href: str | None = None
    requires: tuple[tuple[str, str], ...] = ()
    scope: Fn | None = None  # (M, c) -> list of record-permission conditions
    better: str | None = None  # "up" | "down" for delta tone

    @property
    def point_in_time(self) -> bool:
        return "date" not in self.dims


def available(k: Kpi, user: CurrentUser) -> bool:
    if not user.can(k.module, "view") or not all(user.can(m, a) for m, a in k.requires):
        return False
    return load(k.model) is not None


def _dim(k: Kpi, name: str, M: Any) -> Any:
    fn = k.dims.get(name)
    return fn(M) if fn else None


def _in(col: Any, values: list[Any]) -> Any:
    vals = [v for v in values if v != NONE]
    conds = []
    if vals:
        conds.append(col.in_(vals))
    if NONE in values:
        conds.append(col.is_(None))
    return or_(*conds) if conds else false()


def date_conds(col: Any, start: date | None, end: date | None) -> list:
    is_dt = isinstance(getattr(col, "type", None), DateTime)
    out = []
    if start:
        out.append(col >= (datetime.combine(start, time.min, tzinfo=timezone.utc) if is_dt else start))
    if end:
        nxt = end + timedelta(days=1)
        out.append(col < (datetime.combine(nxt, time.min, tzinfo=timezone.utc) if is_dt else nxt))
    return out


def property_subquery(f: Filters) -> Any:
    P = load("properties.models:Property")
    sub = select(P.id).where(P.deleted_at.is_(None))
    if f.property_type:
        sub = sub.where(_in(P.property_type, f.property_type))
    if f.state:
        sub = sub.where(_in(func.upper(P.state), [s if s == NONE else s.upper() for s in f.state]))
    if f.county:
        sub = sub.where(_in(func.lower(P.county), [s if s == NONE else s.lower() for s in f.county]))
    if f.territory:
        TM = load("territories.models:TerritoryMember")
        if TM is not None:
            sub = sub.where(P.id.in_(select(TM.property_id).where(TM.territory_id == f.territory)))
    # Standalone: never correlate with an outer `properties` (KPIs over Property itself).
    return sub.correlate(None)


def property_source(col: Any) -> Any:
    """Data source (provider) a property was imported from — used for source attribution and licensing."""
    R, J, S = (load(f"imports.models:{n}") for n in ("ImportRow", "ImportJob", "DataSource"))
    if R is None or J is None or S is None:
        return None
    return (
        select(S.provider).select_from(R).join(J, J.id == R.job_id).join(S, S.id == J.data_source_id)
        .where(R.created_entity_id == col).order_by(J.created_at).limit(1).scalar_subquery()
    )


def conditions(k: Kpi, M: Any, c: Ctx, *, facets: dict[str, str] | None = None) -> tuple[list, list[str]]:
    """All WHERE conditions for a KPI under the context's filters. Returns (conditions, ignored filters)."""
    conds = list(k.where(M, c))
    if hasattr(M, "deleted_at"):
        conds.append(M.deleted_at.is_(None))
    if k.scope:
        conds += list(k.scope(M, c))
    ignored: list[str] = []
    f = c.f
    start, end = c.period
    if start or end:
        col = _dim(k, "date", M)
        if col is None:
            ignored.append("date")
        else:
            conds += date_conds(col, start, end)
    if f.user or f.team:
        col = _dim(k, "user", M)
        if col is None:
            ignored.append("user")
        else:
            if f.user:
                conds.append(_in(col, c.user_ids))
            if f.team:
                User = load("auth.models:User")
                conds.append(col.in_(select(User.id).where(User.team_id == f.team)))
    if f.property_type or f.state or f.county or f.territory:
        col = _dim(k, "property", M)
        if col is None:
            ignored.append("geography")
        else:
            conds.append(col.in_(property_subquery(f)))
    for name in ("source", "stage"):
        values = getattr(f, name)
        if values:
            col = _dim(k, name, M)
            if col is None:
                ignored.append(name)
            else:
                conds.append(_in(col, values))
    for name, value in (facets or {}).items():
        fn = k.facets.get(name)
        if fn is None:
            ignored.append(f"f_{name}")
            continue
        expr = fn(M, c)
        conds.append(expr.is_(None) if value == NONE else cast(expr, String) == value)
    return conds, ignored


# ============================================================================ evaluation


def _agg_cols(k: Kpi, M: Any, c: Ctx) -> list:
    if k.agg == "count":
        return [func.count()]
    m = k.measure(M, c)
    if k.agg == "sum":
        return [func.coalesce(func.sum(m), 0)]
    if k.agg == "avg":
        return [func.avg(m)]
    if k.agg == "rate":
        return [func.count(), func.count().filter(m)]
    if k.agg == "wavg":
        w = k.weight(M, c)
        return [func.sum(m * w), func.sum(w).filter(m.is_not(None))]
    raise ValueError(f"Unknown aggregation {k.agg}")


def _agg_value(k: Kpi, vals: tuple) -> float | None:
    if k.agg == "rate":
        total, hit = vals
        return round(float(hit) * 100.0 / float(total), 1) if total else None
    if k.agg == "wavg":
        num, den = vals
        return round(float(num) / float(den), 3) if num is not None and den else None
    v = vals[0]
    if v is None:
        return None
    return round(float(v), 2) if k.agg == "avg" else float(v)


async def evaluate(db: AsyncSession, k: Kpi, c: Ctx, *, facets: dict[str, str] | None = None
                   ) -> tuple[float | None, list[str]]:
    M = load(k.model)
    conds, ignored = conditions(k, M, c, facets=facets)
    row = (await db.execute(select(*_agg_cols(k, M, c)).select_from(M).where(*conds))).one()
    return _agg_value(k, tuple(row)), ignored


async def grouped(db: AsyncSession, k: Kpi, c: Ctx, group: Fn, *, facets: dict[str, str] | None = None
                  ) -> list[tuple[Any, float | None]] | None:
    """KPI value per group. `group(M, c)` returns the grouping expression (None = not groupable)."""
    M = load(k.model)
    g = group(M, c)
    if g is None:
        return None
    conds, _ = conditions(k, M, c, facets=facets)
    stmt = select(g.label("g"), *_agg_cols(k, M, c)).select_from(M).where(*conds).group_by(text("1"))
    rows = (await db.execute(stmt)).all()
    return [(r[0], _agg_value(k, tuple(r[1:]))) for r in rows]


UNIT_KIND = {"count": "number", "currency": "currency", "percent": "percent", "days": "days", "number": "number"}


def record_columns(k: Kpi) -> list[Col]:
    cols = list(k.cols)
    if k.agg in ("sum", "avg", "wavg") and k.measure:
        cols.append(Col("_measure", k.measure_label or k.label, k.measure, UNIT_KIND.get(k.unit, "number")))
    if k.agg == "wavg" and k.weight:
        cols.append(Col("_weight", k.weight_label or "Weight", k.weight, "currency"))
    if k.agg == "rate" and k.measure:
        cols.append(Col("_hit", k.hit_label or "Counted", k.measure, "bool"))
    return cols


def license_source(k: Kpi, M: Any) -> Any:
    src = _dim(k, "source", M)
    if src is not None:
        return src
    prop = _dim(k, "property", M)
    return property_source(prop) if prop is not None else None


async def records(db: AsyncSession, k: Kpi, c: Ctx, *, page: int = 1, page_size: int = 25,
                  facets: dict[str, str] | None = None, restricted: dict[str, str] | None = None
                  ) -> tuple[list[Col], list[dict], int, list[str]]:
    """The exact records that make up the KPI value (for rate KPIs: the denominator, with a hit flag)."""
    M = load(k.model)
    conds, ignored = conditions(k, M, c, facets=facets)
    cols = record_columns(k)
    sel = [M.id.label("id"), k.title(M, c).label("title"), k.href(M, c).label("href")]
    sel += [col.expr(M, c).label(f"c{i}") for i, col in enumerate(cols)]
    lic = license_source(k, M)
    if lic is not None:
        sel.append(lic.label("lic"))
    total = await db.scalar(select(func.count()).select_from(M).where(*conds)) or 0
    order = list(k.sort(M, c)) if k.sort else ([M.created_at.desc()] if hasattr(M, "created_at") else [])
    stmt = (select(*sel).select_from(M).where(*conds).order_by(*order, M.id)
            .offset((page - 1) * page_size).limit(page_size))
    items = []
    for r in (await db.execute(stmt)).all():
        m = r._mapping
        src = m["lic"] if lic is not None else None
        reason = (restricted or {}).get(str(src).strip().lower()) if src else None
        items.append({
            "id": str(m["id"]),
            "title": m["title"] or "—",
            "href": m["href"],
            "cells": {col.key: to_jsonable(m[f"c{i}"]) for i, col in enumerate(cols)},
            "source": src,
            "restricted": reason is not None,
            "restriction_reason": reason,
        })
    return cols, items, int(total), ignored


async def license_restrictions(db: AsyncSession) -> dict[str, str]:
    """lower(provider) -> reason, for sources whose data may not be redistributed/exported."""
    out: dict[str, str] = {}
    S = load("imports.models:DataSource")
    PR = load("compliance.models:ProviderRestriction")

    async def sources(d: AsyncSession) -> list:
        stmt = select(S.provider).where(S.deleted_at.is_(None), S.redistribution_allowed.is_(False))
        return list((await d.execute(stmt)).all())

    async def provider_rules(d: AsyncSession) -> list:
        stmt = select(PR.provider, PR.restriction).where(PR.deleted_at.is_(None), PR.is_active.is_(True),
                                                         PR.block_export.is_(True))
        return list((await d.execute(stmt)).all())

    if S is not None:
        for (provider,) in await safe(db, sources) or []:
            out[provider.strip().lower()] = f"License for {provider} does not allow redistribution"
    if PR is not None:
        for provider, restriction in await safe(db, provider_rules) or []:
            out.setdefault(provider.strip().lower(),
                           f"Provider restriction ({restriction}) blocks export of {provider} data")
    return out


async def safe(db: AsyncSession, fn: Callable[[AsyncSession], Awaitable[Any]]) -> Any:
    """Run one read block inside a savepoint; a missing table/column omits the block instead of failing."""
    try:
        async with db.begin_nested():
            return await fn(db)
    except (SQLAlchemyError, AttributeError, ImportError, TypeError) as exc:
        log.warning("report block omitted: %s", exc)
        return None


# ============================================================================ time buckets


def granularity(start: date, end: date) -> str:
    days = (end - start).days + 1
    return "day" if days <= 31 else "week" if days <= 183 else "month"


def bucket_start(d: date, gran: str) -> date:
    if gran == "week":
        return d - timedelta(days=d.weekday())
    if gran == "month":
        return d.replace(day=1)
    return d


def bucket_end(s: date, gran: str) -> date:
    if gran == "week":
        return s + timedelta(days=6)
    if gran == "month":
        nxt = date(s.year + (s.month == 12), s.month % 12 + 1, 1)
        return nxt - timedelta(days=1)
    return s


def bucket_label(s: date, gran: str) -> str:
    return s.strftime("%b %Y") if gran == "month" else s.strftime("%b %d")


def buckets(start: date, end: date, gran: str) -> list[date]:
    out, cur = [], bucket_start(start, gran)
    while cur <= end:
        out.append(cur)
        cur = bucket_end(cur, gran) + timedelta(days=1)
    return out


def as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    return value if isinstance(value, date) else None
