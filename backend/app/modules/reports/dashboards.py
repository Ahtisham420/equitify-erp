"""Dashboard definitions (spec 34) and the builders that turn KPI definitions into tiles, charts and tables.

Every number produced here carries an href to /reports/kpi/<key> with the exact filters (plus the bucket,
group or user it represents), which lists the constituent records.
"""
import csv
import io
from dataclasses import dataclass, field, replace
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.security import utcnow
from app.modules.reports.engine import (
    NONE, Ctx, Filters, Kpi, as_date, available, bucket_end, bucket_label, bucket_start, buckets, evaluate,
    granularity, grouped, license_restrictions, load, query_string, records, safe,
)
from app.modules.reports.kpis import REGISTRY
from app.modules.reports.schemas import (
    Column, DashboardOut, Point, Row, SeriesMeta, SeriesOut, TableOut, Tile,
)


@dataclass
class SeriesDef:
    key: str
    label: str
    kind: str  # time | breakdown
    kpis: list[str]
    by: str | None = None  # user|source|stage|property_type|state|<facet>
    chart: str = "bar"
    limit: int = 12
    order: str = "value"  # value | key
    description: str | None = None


@dataclass
class TableDef:
    key: str
    kind: str  # records | team | sources
    kpi: str | None = None
    label: str | None = None
    limit: int = 10


@dataclass
class Dashboard:
    key: str
    label: str
    description: str
    tiles: list[str]
    series: list[SeriesDef] = field(default_factory=list)
    tables: list[TableDef] = field(default_factory=list)
    default_me: bool = False

    def kpi_keys(self) -> set[str]:
        keys = set(self.tiles)
        for s in self.series:
            keys.update(s.kpis)
        for t in self.tables:
            if t.kpi:
                keys.add(t.kpi)
            keys.update(TEAM_COLUMNS if t.kind == "team" else [])
            keys.update(SOURCE_KPIS.values() if t.kind == "sources" else [])
        return keys


TEAM_COLUMNS = {
    "outreach.interactions": "Interactions", "outreach.meaningful": "Meaningful", "tasks.completed": "Tasks done",
    "tasks.overdue": "Tasks overdue", "pipeline.stage_moves": "Stage moves", "offers.sent": "Offers sent",
    "closings.completed": "Closings",
}
SOURCE_KPIS = {
    "leads": "sourcing.properties_added", "opportunities": "sourcing.opportunities_created", "offers": "offers.sent",
    "closings": "closings.completed", "volume": "closings.volume", "conversion": "pipeline.conversion",
}


def _r(key: str, kpi: str, limit: int = 10, label: str | None = None) -> TableDef:
    return TableDef(key=key, kind="records", kpi=kpi, limit=limit, label=label)


DASHBOARDS: dict[str, Dashboard] = {d.key: d for d in [
    Dashboard(
        key="executive", label="Executive command center",
        description="Firm-wide view across acquisitions, portfolio, operations and brokerage.",
        tiles=["pipeline.active", "pipeline.stalled", "offers.sent", "contracts.dates_due_14", "closings.completed",
               "closings.volume", "portfolio.value", "debt.maturing_12m_balance", "receivables.delinquent",
               "operations.wo_overdue", "brokerage.weighted_gci", "tasks.alerts_open_high"],
        series=[
            SeriesDef("opps_closings", "Opportunities created and closings", "time",
                      ["sourcing.opportunities_created", "closings.completed"], chart="line"),
            SeriesDef("pipeline_stage", "Active pipeline by stage", "breakdown", ["pipeline.active"], by="stage"),
        ],
        tables=[_r("dates", "contracts.dates_due_14", 8), _r("watchlist", "portfolio.watchlist_open", 8)],
    ),
    Dashboard(
        key="acquisitions", label="Acquisitions",
        description="Sourcing through closing: volume, velocity, conversion and what is stuck.",
        tiles=["sourcing.opportunities_created", "pipeline.active", "pipeline.stalled", "pipeline.no_next_action",
               "pipeline.avg_days_in_stage", "pipeline.stage_moves", "offers.sent", "offers.acceptance_rate",
               "offers.awaiting_response", "contracts.executed", "closings.scheduled_30", "closings.completed",
               "pipeline.conversion", "pipeline.dead", "reactivation.pending", "reactivation.conversion_rate"],
        series=[
            SeriesDef("stage", "Active pipeline by stage", "breakdown", ["pipeline.active"], by="stage"),
            SeriesDef("created_dead", "Opportunities created vs. marked dead", "time",
                      ["sourcing.opportunities_created", "pipeline.dead"], chart="line"),
            SeriesDef("dead_reason", "Dead opportunities by reason", "breakdown", ["pipeline.dead"], by="dead_reason"),
            SeriesDef("by_source", "Opportunities created by source", "breakdown",
                      ["sourcing.opportunities_created"], by="source"),
        ],
        tables=[_r("stalled", "pipeline.stalled"), _r("closing_soon", "closings.scheduled_30")],
    ),
    Dashboard(
        key="queue", label="Daily queue",
        description="What needs attention today. Defaults to your own work; change the user filter to view others.",
        default_me=True,
        tiles=["tasks.overdue", "tasks.due_today", "queue.next_actions_due", "outreach.follow_ups_due",
               "outreach.open_loops", "offers.awaiting_response", "contracts.dates_due_14", "tasks.alerts_open_high",
               "reactivation.pending"],
        series=[SeriesDef("done", "Tasks completed", "time", ["tasks.completed"])],
        tables=[_r("overdue", "tasks.overdue"), _r("today", "tasks.due_today"),
                _r("next_actions", "queue.next_actions_due"), _r("follow_ups", "outreach.follow_ups_due"),
                _r("dates", "contracts.dates_due_14")],
    ),
    Dashboard(
        key="signals", label="Signals",
        description="Motivation and market signals: what is new, what is stacking, what is about to expire.",
        tiles=["sourcing.signals_new", "signals.active", "signals.high_severity", "sourcing.stacked_signal_properties",
               "sourcing.high_score_properties", "signals.expiring_30"],
        series=[
            SeriesDef("new", "New signals", "time", ["sourcing.signals_new"]),
            SeriesDef("category", "Active signals by category", "breakdown", ["signals.active"], by="category"),
            SeriesDef("severity", "Active signals by severity", "breakdown", ["signals.active"], by="severity",
                      order="key"),
        ],
        tables=[_r("high", "signals.high_severity"), _r("stacked", "sourcing.stacked_signal_properties")],
    ),
    Dashboard(
        key="portfolio", label="Portfolio",
        description="Owned assets: value, exposure, collections and watchlist.",
        tiles=["portfolio.active_assets", "portfolio.value", "portfolio.basis", "portfolio.acquired",
               "portfolio.watchlist_open", "receivables.delinquent", "receivables.collected", "leases.expiring_12m",
               "debt.total_balance", "debt.maturing_12m"],
        series=[
            SeriesDef("value_type", "Portfolio value by property type", "breakdown", ["portfolio.value"],
                      by="property_type"),
            SeriesDef("value_state", "Portfolio value by state", "breakdown", ["portfolio.value"], by="state"),
            SeriesDef("aging", "Delinquent balance by aging", "breakdown", ["receivables.delinquent"], by="aging",
                      order="key"),
            SeriesDef("collected", "Rent collected", "time", ["receivables.collected"]),
        ],
        tables=[_r("watchlist", "portfolio.watchlist_open"), _r("delinquent", "receivables.delinquent")],
    ),
    Dashboard(
        key="leases", label="Lease expiration & rollover",
        description="Rent at risk by expiration year, upcoming expirations and option notice deadlines.",
        tiles=["leases.active", "leases.expiring_12m", "leases.rent_expiring_12m", "leases.option_notices_90",
               "leases.holdover", "leases.unverified"],
        series=[
            SeriesDef("rollover", "Rent rolling by expiration year", "breakdown", ["leases.rent_by_expiration"],
                      by="exp_year", order="key"),
            SeriesDef("lease_type", "Active leases by type", "breakdown", ["leases.active"], by="lease_type"),
        ],
        tables=[_r("expiring", "leases.expiring_12m"), _r("options", "leases.option_notices_90")],
    ),
    Dashboard(
        key="debt", label="Debt maturity, covenants & rate",
        description="Maturity wall, covenant state and interest-rate exposure.",
        tiles=["debt.total_balance", "debt.weighted_rate", "debt.floating_balance", "debt.maturing_12m",
               "debt.maturing_12m_balance", "debt.covenant_breach", "debt.covenant_watch", "debt.caps_expiring_180",
               "debt.floating_uncapped", "debt.reports_overdue"],
        series=[
            SeriesDef("maturity", "Debt by maturity year", "breakdown", ["debt.balance_by_maturity"],
                      by="maturity_year", order="key"),
            SeriesDef("rate_type", "Debt by rate type", "breakdown", ["debt.total_balance"], by="rate_type"),
            SeriesDef("lender", "Debt by lender", "breakdown", ["debt.total_balance"], by="lender", limit=10),
        ],
        tables=[_r("maturing", "debt.maturing_12m"), _r("breach", "debt.covenant_breach"),
                _r("caps", "debt.caps_expiring_180")],
    ),
    Dashboard(
        key="operations", label="Operations",
        description="Work orders, preventive maintenance, vendors, insurance, capital projects and tax.",
        tiles=["operations.wo_open", "operations.wo_overdue", "operations.wo_completed", "operations.wo_avg_days",
               "operations.pm_due_14", "operations.findings_open", "operations.vendor_credentials",
               "operations.insurance_expiring_60", "operations.coi_deficient", "operations.capex_active",
               "operations.capex_budget", "operations.capex_over_budget", "operations.tax_due_30"],
        series=[
            SeriesDef("completed", "Work orders completed", "time", ["operations.wo_completed"]),
            SeriesDef("priority", "Open work orders by priority", "breakdown", ["operations.wo_open"], by="priority"),
            SeriesDef("category", "Open work orders by category", "breakdown", ["operations.wo_open"], by="category"),
        ],
        tables=[_r("overdue", "operations.wo_overdue"), _r("credentials", "operations.vendor_credentials"),
                _r("insurance", "operations.insurance_expiring_60")],
    ),
    Dashboard(
        key="brokerage", label="Brokerage",
        description="Listings, inquiries, showings, deal pipeline and commission production.",
        tiles=["brokerage.active_listings", "brokerage.listings_expiring_30", "brokerage.inquiries",
               "brokerage.showings", "brokerage.active_deals", "brokerage.pipeline_gci", "brokerage.weighted_gci",
               "brokerage.deals_closed", "commissions.earned_count", "commissions.earned", "commissions.receivable"],
        series=[
            SeriesDef("activity", "Inquiries and showings", "time", ["brokerage.inquiries", "brokerage.showings"],
                      chart="line"),
            SeriesDef("inq_source", "Inquiries by source", "breakdown", ["brokerage.inquiries"], by="source"),
            SeriesDef("deal_stage", "Active deals by stage", "breakdown", ["brokerage.active_deals"], by="stage"),
        ],
        tables=[_r("expiring", "brokerage.listings_expiring_30"), _r("deals", "brokerage.active_deals")],
    ),
    Dashboard(
        key="data", label="Data quality",
        description="Completeness, verification backlog, import exceptions and license renewals.",
        tiles=["data.avg_completeness", "data.low_completeness", "data.missing_location",
               "data.unverified_observations", "data.ai_unverified", "data.import_invalid", "data.import_duplicates",
               "data.sources_renewing", "sourcing.properties_added"],
        series=[
            SeriesDef("band", "Properties by completeness band", "breakdown", ["data.properties_total"], by="band",
                      order="key"),
            SeriesDef("unverified_field", "Unverified facts by field", "breakdown", ["data.unverified_observations"],
                      by="field"),
            SeriesDef("added", "Properties added", "time", ["sourcing.properties_added"]),
        ],
        tables=[_r("low", "data.low_completeness"), _r("invalid", "data.import_invalid")],
    ),
    Dashboard(
        key="sources", label="Source performance",
        description="Leads, opportunities, offers and closings by source, with conversion and cost per closed deal.",
        tiles=["sourcing.properties_added", "sourcing.opportunities_created", "offers.sent", "closings.completed",
               "pipeline.conversion", "data.sources_active"],
        series=[
            SeriesDef("opps", "Opportunities by source", "breakdown", ["sourcing.opportunities_created"], by="source"),
            SeriesDef("closings", "Closings by source", "breakdown", ["closings.completed"], by="source"),
        ],
        tables=[TableDef(key="sources", kind="sources", label="Source performance")],
    ),
    Dashboard(
        key="team", label="Team performance",
        description="Activity and output per person: interactions, tasks, stage moves, offers and closings.",
        tiles=list(TEAM_COLUMNS),
        series=[
            SeriesDef("activity", "Interactions and meaningful conversations", "time",
                      ["outreach.interactions", "outreach.meaningful"], chart="line"),
            SeriesDef("by_user", "Interactions by user", "breakdown", ["outreach.interactions"], by="user"),
        ],
        tables=[TableDef(key="team", kind="team", label="Team performance")],
    ),
    Dashboard(
        key="compliance", label="Compliance",
        description="Send-time blocks, opt-outs, DNC exposure and suppression.",
        tiles=["compliance.sends", "compliance.blocked", "compliance.opt_outs", "compliance.consent_revoked",
               "compliance.dnc_listed", "compliance.scrub_expired", "compliance.suppressed"],
        series=[
            SeriesDef("sends", "Outbound attempts and blocks", "time", ["compliance.sends", "compliance.blocked"],
                      chart="line"),
            SeriesDef("blocked_channel", "Blocked sends by channel", "breakdown", ["compliance.blocked"], by="channel"),
        ],
        tables=[_r("blocked", "compliance.blocked")],
    ),
]}


# ============================================================================ helpers


def kpi_href(key: str, f: Filters, *, facets: dict[str, str] | None = None, **override: Any) -> str:
    return f"/reports/kpi/{key}{query_string(f.params(facets=facets, **override))}"


def kpis_for(keys: list[str], c: Ctx) -> list[Kpi]:
    return [k for key in keys if (k := REGISTRY.get(key)) is not None and available(k, c.user)]


def dashboard_visible(d: Dashboard, c: Ctx) -> bool:
    return bool(kpis_for(sorted(d.kpi_keys()), c))


def effective_ctx(d: Dashboard, c: Ctx) -> Ctx:
    if d.default_me and not c.f.user and not c.f.team:
        return c.with_filters(replace(c.f, user=["me"]))
    return c


async def user_names(db: AsyncSession, ids: list[Any]) -> dict[str, str]:
    User = load("auth.models:User")
    valid = [i for i in ids if i is not None]
    if not valid:
        return {}
    rows = await db.execute(select(User.id, User.full_name).where(User.id.in_(valid)))
    return {str(i): n for i, n in rows.all()}


# ============================================================================ tiles


async def tile(db: AsyncSession, k: Kpi, c: Ctx) -> Tile | None:
    res = await safe(db, lambda s: evaluate(s, k, c))
    if res is None:
        return None
    value, ignored = res
    delta = None
    prev = c.previous()
    if prev is not None and not k.point_in_time and value is not None:
        p = await safe(db, lambda s: evaluate(s, k, prev))
        if p is not None and p[0] is not None:
            delta = round(value - p[0], 2)
    return Tile(key=k.key, label=k.label, value=value, unit=k.unit, delta=delta, better=k.better,
                href=kpi_href(k.key, c.f), module_href=k.module_href, definition=k.definition,
                point_in_time=k.point_in_time, ignored_filters=ignored)


# ============================================================================ series


def _group_fn(k: Kpi, by: str):
    if by in ("user", "source", "stage"):
        fn = k.dims.get(by)
        return (lambda M, c: fn(M)) if fn else None
    if by in ("property_type", "state"):
        pfn = k.dims.get("property")
        if not pfn:
            return None
        P = aliased(load("properties.models:Property"))
        return lambda M, c: select(getattr(P, by)).where(P.id == pfn(M)).scalar_subquery()
    return k.facets.get(by)


def _drill(k: Kpi, f: Filters, by: str, value: Any) -> str:
    v = NONE if value is None else str(value)
    if by in ("user", "source", "stage", "property_type", "state"):
        return kpi_href(k.key, f, **{by: [v]})
    return kpi_href(k.key, f, facets={by: v})


async def time_series(db: AsyncSession, s: SeriesDef, c: Ctx) -> SeriesOut | None:
    ks = [k for k in kpis_for(s.kpis, c) if "date" in k.dims]
    if not ks:
        return None
    start, end = c.period
    end = end or c.today
    start = start or end - timedelta(days=364)
    gran = granularity(start, end)
    cc = c.with_filters(replace(c.f, date_from=start, date_to=end, days=None))
    starts = buckets(start, end, gran)
    values: dict[str, dict] = {b.isoformat(): {} for b in starts}
    hrefs: dict[str, dict] = {b.isoformat(): {} for b in starts}
    metas: list[SeriesMeta] = []
    for k in ks:
        def group(M, c_, k=k):
            return func.date_trunc(gran, k.dims["date"](M))
        rows = await safe(db, lambda d, k=k, group=group: grouped(d, k, cc, group))
        if rows is None:
            continue
        got: dict[str, float | None] = {}
        for g, v in rows:
            gd = as_date(g)
            if gd:
                got[bucket_start(gd, gran).isoformat()] = v
        zero = 0.0 if k.agg in ("count", "sum") else None
        for b in starts:
            key = b.isoformat()
            values[key][k.key] = got.get(key, zero)
            hrefs[key][k.key] = kpi_href(k.key, c.f, date_from=max(b, start), date_to=min(bucket_end(b, gran), end))
        metas.append(SeriesMeta(key=k.key, label=k.label, href=kpi_href(k.key, cc.f)))
    if not metas:
        return None
    points = [Point(key=b.isoformat(), label=bucket_label(b, gran), values=values[b.isoformat()],
                    hrefs=hrefs[b.isoformat()]) for b in starts]
    return SeriesOut(key=s.key, label=s.label, description=s.description or f"Per {gran}", kind="time",
                     chart=s.chart, unit=ks[0].unit, series=metas, points=points)


async def breakdown(db: AsyncSession, s: SeriesDef, c: Ctx) -> SeriesOut | None:
    ks = kpis_for(s.kpis, c)
    data: dict[str, dict] = {}
    raw: dict[str, Any] = {}
    metas: list[SeriesMeta] = []
    for k in ks:
        fn = _group_fn(k, s.by or "")
        if fn is None:
            continue
        rows = await safe(db, lambda d, k=k, fn=fn: grouped(d, k, c, fn))
        if rows is None:
            continue
        for g, v in rows:
            key = NONE if g is None else str(g)
            raw[key] = g
            data.setdefault(key, {"values": {}, "hrefs": {}})
            data[key]["values"][k.key] = v
            data[key]["hrefs"][k.key] = _drill(k, c.f, s.by or "", g)
        metas.append(SeriesMeta(key=k.key, label=k.label, href=kpi_href(k.key, c.f)))
    if not metas:
        return None
    first = metas[0].key
    keys = list(data)
    if s.order == "key":
        keys.sort()
    else:
        keys.sort(key=lambda x: -(data[x]["values"].get(first) or 0))
    keys = keys[: s.limit]
    names = await user_names(db, [raw[x] for x in keys if raw[x] is not None]) if s.by == "user" else {}
    points = []
    for x in keys:
        label = "Not set" if x == NONE else names.get(x, x)
        points.append(Point(key=x, label=label, values=data[x]["values"], hrefs=data[x]["hrefs"]))
    unit = next(k.unit for k in ks if k.key == first)
    return SeriesOut(key=s.key, label=s.label, description=s.description, kind="breakdown", chart="bar", unit=unit,
                     series=metas, points=points)


# ============================================================================ tables


async def records_table(db: AsyncSession, t: TableDef, c: Ctx, restricted: dict[str, str]) -> TableOut | None:
    ks = kpis_for([t.kpi or ""], c)
    if not ks:
        return None
    k = ks[0]
    res = await safe(db, lambda d: records(d, k, c, page=1, page_size=t.limit, restricted=restricted))
    if res is None:
        return None
    cols, items, total, _ = res
    return TableOut(key=t.key, label=t.label or k.label, description=k.definition,
                    columns=[Column(key=col.key, label=col.label, kind=col.kind) for col in cols],
                    rows=[Row(**i) for i in items], total=total, href=kpi_href(k.key, c.f))


async def team_table(db: AsyncSession, t: TableDef, c: Ctx) -> TableOut | None:
    ks = [k for k in kpis_for(list(TEAM_COLUMNS), c) if "user" in k.dims]
    if not ks:
        return None
    User = load("auth.models:User")
    stmt = select(User.id, User.full_name).where(User.deleted_at.is_(None), User.status == "active",
                                                 User.is_service.is_(False))
    ids = [i for i in c.user_ids if i != NONE]
    if c.f.user:
        stmt = stmt.where(User.id.in_(ids))
    if c.f.team:
        stmt = stmt.where(User.team_id == c.f.team)
    users = (await db.execute(stmt.order_by(User.full_name))).all()
    per: dict[str, dict[str, float | None]] = {}
    for k in ks:
        rows = await safe(db, lambda d, k=k: grouped(d, k, c, lambda M, c_, k=k: k.dims["user"](M)))
        per[k.key] = {str(g): v for g, v in rows or [] if g is not None}
    out_rows = []
    for uid, name in users:
        cells = {k.key: per[k.key].get(str(uid), 0.0) for k in ks}
        hrefs = {k.key: kpi_href(k.key, c.f, user=[str(uid)]) for k in ks}
        out_rows.append(Row(id=str(uid), title=name, href=kpi_href(ks[0].key, c.f, user=[str(uid)]),
                            cells=cells, hrefs=hrefs))
    out_rows.sort(key=lambda r: -sum(v or 0 for v in r.cells.values()))
    return TableOut(key=t.key, label=t.label or "Team performance", description="Per user, filtered period",
                    columns=[Column(key=k.key, label=TEAM_COLUMNS[k.key], kind="number") for k in ks],
                    rows=out_rows, total=len(out_rows))


async def sources_table(db: AsyncSession, t: TableDef, c: Ctx, restricted: dict[str, str]) -> TableOut | None:
    ks = {col: k for col, key in SOURCE_KPIS.items()
          if (k := REGISTRY.get(key)) is not None and available(k, c.user) and "source" in k.dims}
    if not ks:
        return None
    display: dict[str, str] = {}  # lower -> display
    vals: dict[str, dict[str, float | None]] = {}
    for col, k in ks.items():
        rows = await safe(db, lambda d, k=k: grouped(d, k, c, lambda M, c_, k=k: k.dims["source"](M)))
        for g, v in rows or []:
            name = NONE if g is None or not str(g).strip() else str(g).strip()
            low = name.lower()
            display.setdefault(low, name)
            vals.setdefault(low, {})
            vals[low][col] = (vals[low].get(col) or 0) + (v or 0) if col != "conversion" else v
    costs: dict[str, tuple[float, str]] = {}
    DS = load("imports.models:DataSource")
    if DS is not None and c.user.can("imports", "view"):
        async def load_costs(d):
            return (await d.execute(select(DS.provider, DS.cost).where(DS.deleted_at.is_(None)))).all()
        for provider, cost in await safe(db, load_costs) or []:
            if cost is not None:
                costs[provider.strip().lower()] = (float(cost), provider)
    rows_out = []
    for low, name in display.items():
        v = vals[low]
        cost = costs.get(low)
        closings = v.get("closings") or 0
        cells: dict[str, Any] = {col: v.get(col, 0.0 if col != "conversion" else None) for col in ks}
        hrefs = {col: kpi_href(k.key, c.f, source=[name]) for col, k in ks.items()}
        if cost:
            cells["cost"] = cost[0]
            hrefs["cost"] = kpi_href("data.sources_active", Filters(), source=[cost[1]])
            if closings:
                cells["cost_per_closed"] = round(cost[0] / closings, 2)
                hrefs["cost_per_closed"] = hrefs.get("closings") or hrefs["cost"]
        reason = restricted.get(low)
        rows_out.append(Row(id=name, title="Not recorded" if name == NONE else name,
                            href=hrefs.get("opportunities") or next(iter(hrefs.values())), cells=cells, hrefs=hrefs,
                            restricted=reason is not None, restriction_reason=reason))
    rows_out.sort(key=lambda r: -(r.cells.get("opportunities") or r.cells.get("leads") or 0))
    labels = {"leads": ("Leads (properties)", "number"), "opportunities": ("Opportunities", "number"),
              "offers": ("Offers sent", "number"), "closings": ("Closings", "number"),
              "volume": ("Closed volume", "currency"), "conversion": ("Conversion %", "percent")}
    columns = [Column(key=col, label=labels[col][0], kind=labels[col][1]) for col in ks]
    if costs:
        columns += [Column(key="cost", label="Source cost", kind="currency"),
                    Column(key="cost_per_closed", label="Cost per closed deal", kind="currency")]
    return TableOut(key=t.key, label=t.label or "Source performance",
                    description="Opportunity source, or the data source a property was imported from",
                    columns=columns, rows=rows_out, total=len(rows_out))


# ============================================================================ build + CSV


async def build(db: AsyncSession, d: Dashboard, c: Ctx) -> DashboardOut:
    c = effective_ctx(d, c)
    tiles = []
    for k in kpis_for(d.tiles, c):
        t = await tile(db, k, c)
        if t is not None:
            tiles.append(t)
    series = []
    for s in d.series:
        out = await (time_series(db, s, c) if s.kind == "time" else breakdown(db, s, c))
        if out is not None and out.points:
            series.append(out)
    restricted = await license_restrictions(db) if d.tables else {}
    tables = []
    for t in d.tables:
        if t.kind == "team":
            out_t = await team_table(db, t, c)
        elif t.kind == "sources":
            out_t = await sources_table(db, t, c, restricted)
        else:
            out_t = await records_table(db, t, c, restricted)
        if out_t is not None:
            tables.append(out_t)
    return DashboardOut(key=d.key, label=d.label, description=d.description, generated_at=utcnow(),
                        default_me=d.default_me, filters=c.f.to_dict(), tiles=tiles, series=series, tables=tables)


def _fmt(v: Any) -> Any:
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, (list, dict)):
        return str(v)
    return "" if v is None else v


def dashboard_csv(out: DashboardOut) -> tuple[str, int, int]:
    """CSV of a built dashboard. Rows from license-restricted sources are withheld with the reason."""
    buf = io.StringIO()
    w = csv.writer(buf)
    rows = withheld = 0
    w.writerow(["Dashboard", out.label])
    w.writerow(["Generated", out.generated_at.isoformat()])
    w.writerow(["Filters", query_string([(k, v) for k, vs in out.filters.items() for v in vs]).lstrip("?") or "none"])
    w.writerow([])
    w.writerow(["Metric", "Value", "Unit", "Change vs previous period", "Definition"])
    for t in out.tiles:
        w.writerow([t.label, _fmt(t.value), t.unit, _fmt(t.delta), t.definition])
        rows += 1
    for s in out.series:
        w.writerow([])
        w.writerow([s.label])
        w.writerow(["Group"] + [m.label for m in s.series])
        for p in s.points:
            w.writerow([p.label] + [_fmt(p.values.get(m.key)) for m in s.series])
            rows += 1
    for t in out.tables:
        w.writerow([])
        w.writerow([t.label])
        w.writerow(["Record"] + [col.label for col in t.columns])
        reasons: set[str] = set()
        for r in t.rows:
            if r.restricted:
                withheld += 1
                reasons.add(r.restriction_reason or "Restricted source")
                continue
            w.writerow([r.title] + [_fmt(r.cells.get(col.key)) for col in t.columns])
            rows += 1
        if reasons:
            w.writerow([f"Withheld rows: {'; '.join(sorted(reasons))}"])
    return buf.getvalue(), rows, withheld


def records_csv(label: str, columns: list[Column], items: list[Row]) -> tuple[str, int, int]:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", label] + [col.label for col in columns] + ["source"])
    rows = withheld = 0
    reasons: set[str] = set()
    for r in items:
        if r.restricted:
            withheld += 1
            reasons.add(r.restriction_reason or "Restricted source")
            continue
        w.writerow([r.id, r.title] + [_fmt(r.cells.get(col.key)) for col in columns] + [r.source or ""])
        rows += 1
    if reasons:
        w.writerow([])
        w.writerow([f"{withheld} rows withheld: {'; '.join(sorted(reasons))}"])
    return buf.getvalue(), rows, withheld
