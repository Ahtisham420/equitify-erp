import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response

from app.common import audit
from app.core.deps import DB, CurrentUser, require
from app.modules.reports import service
from app.modules.reports.dashboards import (
    DASHBOARDS, build, dashboard_csv, dashboard_visible, kpi_href, records_csv,
)
from app.modules.reports.engine import (
    FAMILIES, Ctx, Filters, Kpi, available, evaluate, license_restrictions, record_columns, records, safe,
)
from app.modules.reports.kpis import REGISTRY
from app.modules.reports.schemas import (
    Catalog, Column, DashboardMeta, DashboardOut, FilterOptions, KpiMeta, KpiOut, RecordPage, Row, RunDueOut,
    RunOut, ScheduleIn, ScheduleOut, ScheduleUpdate, SnapshotPoint, SnapshotRunOut,
)

router = APIRouter(prefix="/reports", tags=["reports"])

VIEW = require("reports", "view")
EXPORT_LIMIT = 50_000


def report_filters(request: Request) -> Filters:
    return Filters.parse(request.query_params.multi_items())


def _meta(k: Kpi) -> KpiMeta:
    return KpiMeta(key=k.key, label=k.label, family=k.family, module=k.module, definition=k.definition, unit=k.unit,
                   point_in_time=k.point_in_time, module_href=k.module_href, facets=sorted(k.facets),
                   dims=sorted(k.dims))


def _kpi(key: str, user: CurrentUser) -> Kpi:
    k = REGISTRY.get(key)
    if k is None or not available(k, user):
        raise HTTPException(404, "Metric not found or not available to you")
    return k


def _csv(content: str, filename: str) -> Response:
    return Response(content=content.encode("utf-8"), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ---------------------------------------------------------------------------- catalog


@router.get("/catalog", response_model=Catalog)
async def catalog(user: CurrentUser = Depends(VIEW)):
    c = Ctx(user=user, f=Filters())
    dashboards = []
    for d in DASHBOARDS.values():
        if dashboard_visible(d, c):
            dashboards.append(DashboardMeta(key=d.key, label=d.label, description=d.description,
                                            default_me=d.default_me,
                                            tile_count=sum(1 for t in d.tiles if t in REGISTRY
                                                           and available(REGISTRY[t], user))))
    kpis = [_meta(k) for k in REGISTRY.values() if available(k, user)]
    return Catalog(dashboards=dashboards, kpis=kpis, families=FAMILIES, can_export=user.can("reports", "export"),
                   can_schedule=user.can("reports", "create"), can_snapshot=user.can("reports", "approve"))


@router.get("/filter-options", response_model=FilterOptions)
async def filter_options(db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.filter_options(db, user)


# ---------------------------------------------------------------------------- dashboards


async def _dashboard(db, key: str, user: CurrentUser, f: Filters) -> DashboardOut:
    d = DASHBOARDS.get(key)
    if d is None:
        raise HTTPException(404, "Dashboard not found")
    c = await service.resolve_ctx(db, user, f)
    if not dashboard_visible(d, c):
        raise HTTPException(403, "You do not have access to any metric on this dashboard")
    return await build(db, d, c)


@router.get("/dashboards/{key}/export")
async def export_dashboard(key: str, db: DB, f: Filters = Depends(report_filters),
                           user: CurrentUser = Depends(require("reports", "export"))):
    out = await _dashboard(db, key, user, f)
    content, rows, withheld = dashboard_csv(out)
    await audit.record(db, actor=user, action="report.exported", entity_type="report", summary=f"Dashboard {key}",
                       changes={"dashboard": key, "filters": out.filters, "rows": rows, "withheld": withheld},
                       ip_address=user.ip_address)
    await db.commit()
    return _csv(content, f"{key}-{out.generated_at.date().isoformat()}.csv")


@router.get("/dashboards/{key}", response_model=DashboardOut)
async def get_dashboard(key: str, db: DB, f: Filters = Depends(report_filters), user: CurrentUser = Depends(VIEW)):
    return await _dashboard(db, key, user, f)


# ---------------------------------------------------------------------------- KPIs


@router.get("/kpis/{key}/records", response_model=RecordPage)
async def kpi_records(key: str, db: DB, f: Filters = Depends(report_filters), page: int = Query(1, ge=1),
                      page_size: int = Query(25, ge=1, le=200), user: CurrentUser = Depends(VIEW)):
    k = _kpi(key, user)
    c = await service.resolve_ctx(db, user, f)
    restricted = await license_restrictions(db)
    res = await safe(db, lambda d: records(d, k, c, page=page, page_size=page_size, facets=f.facets,
                                           restricted=restricted))
    if res is None:
        raise HTTPException(409, "The source data for this metric is not available")
    cols, items, total, ignored = res
    rows = [Row(**i) for i in items]
    return RecordPage(columns=[Column(key=x.key, label=x.label, kind=x.kind) for x in cols], items=rows, total=total,
                      page=page, page_size=page_size, ignored_filters=ignored,
                      withheld=sum(1 for r in rows if r.restricted))


@router.get("/kpis/{key}/history", response_model=list[SnapshotPoint])
async def kpi_history(key: str, db: DB, user: CurrentUser = Depends(VIEW)):
    _kpi(key, user)
    return await service.history(db, key)


@router.get("/kpis/{key}/export")
async def export_kpi(key: str, db: DB, f: Filters = Depends(report_filters),
                     user: CurrentUser = Depends(require("reports", "export"))):
    k = _kpi(key, user)
    if not user.can(k.module, "export"):
        raise HTTPException(403, f"Exporting these records requires {k.module}:export")
    c = await service.resolve_ctx(db, user, f)
    restricted = await license_restrictions(db)
    res = await safe(db, lambda d: records(d, k, c, page=1, page_size=EXPORT_LIMIT, facets=f.facets,
                                           restricted=restricted))
    if res is None:
        raise HTTPException(409, "The source data for this metric is not available")
    cols, items, total, _ = res
    columns = [Column(key=x.key, label=x.label, kind=x.kind) for x in cols]
    content, rows, withheld = records_csv(k.label, columns, [Row(**i) for i in items])
    await audit.record(db, actor=user, action="report.exported", entity_type="report", summary=f"KPI {key}",
                       changes={"kpi": key, "filters": f.to_dict(), "rows": rows, "withheld": withheld,
                                "total": total}, ip_address=user.ip_address)
    await db.commit()
    return _csv(content, f"{key.replace('.', '-')}-{c.today.isoformat()}.csv")


@router.get("/kpis/{key}", response_model=KpiOut)
async def get_kpi(key: str, db: DB, f: Filters = Depends(report_filters), user: CurrentUser = Depends(VIEW)):
    k = _kpi(key, user)
    c = await service.resolve_ctx(db, user, f)
    res = await safe(db, lambda d: evaluate(d, k, c, facets=f.facets))
    if res is None:
        raise HTTPException(409, "The source data for this metric is not available")
    value, ignored = res
    delta = None
    prev = c.previous()
    if prev is not None and not k.point_in_time and value is not None:
        p = await safe(db, lambda d: evaluate(d, k, prev, facets=f.facets))
        if p is not None and p[0] is not None:
            delta = round(value - p[0], 2)
    return KpiOut(**_meta(k).model_dump(), value=value, delta=delta, better=k.better,
                  href=kpi_href(k.key, f), ignored_filters=ignored,
                  columns=[Column(key=x.key, label=x.label, kind=x.kind) for x in record_columns(k)])


# ---------------------------------------------------------------------------- snapshots


@router.post("/snapshots/run", response_model=SnapshotRunOut)
async def run_snapshots(db: DB, user: CurrentUser = Depends(require("reports", "approve"))):
    return await service.run_snapshots(db, user)


# ---------------------------------------------------------------------------- schedules and runs


@router.get("/schedules", response_model=list[ScheduleOut])
async def list_schedules(db: DB, user: CurrentUser = Depends(VIEW)):
    return await service.list_schedules(db, user)


@router.post("/schedules", response_model=ScheduleOut, status_code=201)
async def create_schedule(body: ScheduleIn, db: DB, user: CurrentUser = Depends(require("reports", "create"))):
    return await service.create_schedule(db, body, user)


@router.post("/schedules/run-due", response_model=RunDueOut)
async def run_due(db: DB, user: CurrentUser = Depends(require("reports", "approve"))):
    return await service.run_due(db, user)


@router.patch("/schedules/{schedule_id}", response_model=ScheduleOut)
async def update_schedule(schedule_id: uuid.UUID, body: ScheduleUpdate, db: DB,
                          user: CurrentUser = Depends(require("reports", "edit"))):
    return await service.update_schedule(db, await service.get_schedule(db, schedule_id, user), body, user)


@router.delete("/schedules/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: uuid.UUID, db: DB, user: CurrentUser = Depends(require("reports", "delete"))):
    await service.delete_schedule(db, await service.get_schedule(db, schedule_id, user), user)


@router.get("/runs", response_model=list[RunOut])
async def list_runs(db: DB, schedule_id: uuid.UUID | None = None, user: CurrentUser = Depends(VIEW)):
    return await service.list_runs(db, user, schedule_id)


@router.get("/runs/{run_id}/download")
async def download_run(run_id: uuid.UUID, db: DB, user: CurrentUser = Depends(VIEW)):
    run, data = await service.run_file(db, run_id, user)
    return Response(content=data, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{run.filename or "report.csv"}"'})
