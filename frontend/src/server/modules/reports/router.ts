import * as audit from "../../common/audit";
import { Router, type Ctx as RouteCtx } from "../../core/router";
import { HttpError, created, noContent } from "../../core/http";
import type { CurrentUser } from "../../core/deps";
import {
  build, DASHBOARDS, dashboardCsv, dashboardVisible, kpiHref, recordsCsv, type Dashboard,
} from "./dashboards";
import {
  available, Ctx, evaluate, FAMILIES, Filters, licenseRestrictions, preload, recordColumns, records, safe, type Kpi,
} from "./engine";
import { REGISTRY } from "./kpis";
import * as service from "./service";
import {
  mkRow, scheduleIn, scheduleUpdate, type Catalog, type DashboardOut, type KpiMeta, type KpiOut, type RecordPage,
} from "./schemas";

export const router = new Router();

const EXPORT_LIMIT = 50_000;

const reportFilters = (ctx: RouteCtx): Filters => Filters.parse(ctx.url.searchParams.entries());

function meta(k: Kpi): KpiMeta {
  return {
    key: k.key, label: k.label, family: k.family, module: k.module, definition: k.definition, unit: k.unit,
    point_in_time: k.point_in_time, module_href: k.module_href, facets: Object.keys(k.facets).sort(),
    dims: Object.keys(k.dims).sort(),
  };
}

function kpi(key: string, user: CurrentUser): Kpi {
  const k = REGISTRY[key];
  if (k === undefined || !available(k, user)) throw new HttpError(404, "Metric not found or not available to you");
  return k;
}

const csv = (content: string, filename: string) =>
  new Response(content, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` },
  });

const round2 = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------- catalog

router.get("/reports/catalog", async (ctx) => {
  const user = await ctx.require("reports", "view");
  await preload();
  const c = new Ctx(user, new Filters());
  const dashboards = Object.values(DASHBOARDS)
    .filter((d) => dashboardVisible(d, c))
    .map((d) => ({
      key: d.key, label: d.label, description: d.description, default_me: d.default_me,
      tile_count: d.tiles.filter((t) => t in REGISTRY && available(REGISTRY[t], user)).length,
    }));
  const kpis = Object.values(REGISTRY).filter((k) => available(k, user)).map(meta);
  const out: Catalog = {
    dashboards, kpis, families: FAMILIES, can_export: user.can("reports", "export"),
    can_schedule: user.can("reports", "create"), can_snapshot: user.can("reports", "approve"),
  };
  return out;
});

router.get("/reports/filter-options", async (ctx) => {
  const user = await ctx.require("reports", "view");
  return service.filterOptions(ctx.db, user);
});

// ---------------------------------------------------------------------------- dashboards

async function dashboard(ctx: RouteCtx, key: string, user: CurrentUser, f: Filters): Promise<DashboardOut> {
  await preload();
  const d: Dashboard | undefined = DASHBOARDS[key];
  if (d === undefined) throw new HttpError(404, "Dashboard not found");
  const c = await service.resolveCtx(ctx.db, user, f);
  if (!dashboardVisible(d, c)) throw new HttpError(403, "You do not have access to any metric on this dashboard");
  return build(ctx.db, d, c);
}

router.get("/reports/dashboards/{key}/export", async (ctx) => {
  const user = await ctx.require("reports", "export");
  const key = ctx.param("key");
  const out = await dashboard(ctx, key, user, reportFilters(ctx));
  const [content, rows, withheld] = dashboardCsv(out);
  await audit.record(ctx.db, {
    actor: user, action: "report.exported", entity_type: "report", summary: `Dashboard ${key}`,
    changes: { dashboard: key, filters: out.filters, rows, withheld }, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csv(content, `${key}-${out.generated_at.toISOString().slice(0, 10)}.csv`);
});

router.get("/reports/dashboards/{key}", async (ctx) => {
  const user = await ctx.require("reports", "view");
  return dashboard(ctx, ctx.param("key"), user, reportFilters(ctx));
});

// ---------------------------------------------------------------------------- KPIs

router.get("/reports/kpis/{key}/records", async (ctx) => {
  const user = await ctx.require("reports", "view");
  await preload();
  const f = reportFilters(ctx);
  const page = ctx.query.int("page", { ge: 1 }) ?? 1;
  const page_size = ctx.query.int("page_size", { ge: 1, le: 200 }) ?? 25;
  const k = kpi(ctx.param("key"), user);
  const c = await service.resolveCtx(ctx.db, user, f);
  const restricted = await licenseRestrictions(ctx.db);
  const res = await safe(ctx.db, (d) => records(d, k, c, { page, page_size, facets: f.facets, restricted }));
  if (res === null) throw new HttpError(409, "The source data for this metric is not available");
  const [cols, items, total, ignored] = res;
  const rows = items.map((i) => mkRow(i));
  const out: RecordPage = {
    columns: cols.map((x) => ({ key: x.key, label: x.label, kind: x.kind })), items: rows, total, page, page_size,
    ignored_filters: ignored, withheld: rows.filter((r) => r.restricted).length,
  };
  return out;
});

router.get("/reports/kpis/{key}/history", async (ctx) => {
  const user = await ctx.require("reports", "view");
  await preload();
  kpi(ctx.param("key"), user);
  return service.history(ctx.db, ctx.param("key"));
});

router.get("/reports/kpis/{key}/export", async (ctx) => {
  const user = await ctx.require("reports", "export");
  await preload();
  const f = reportFilters(ctx);
  const key = ctx.param("key");
  const k = kpi(key, user);
  if (!user.can(k.module, "export")) throw new HttpError(403, `Exporting these records requires ${k.module}:export`);
  const c = await service.resolveCtx(ctx.db, user, f);
  const restricted = await licenseRestrictions(ctx.db);
  const res = await safe(ctx.db, (d) =>
    records(d, k, c, { page: 1, page_size: EXPORT_LIMIT, facets: f.facets, restricted }));
  if (res === null) throw new HttpError(409, "The source data for this metric is not available");
  const [cols, items, total] = res;
  const columns = cols.map((x) => ({ key: x.key, label: x.label, kind: x.kind }));
  const [content, rows, withheld] = recordsCsv(k.label, columns, items.map((i) => mkRow(i)));
  await audit.record(ctx.db, {
    actor: user, action: "report.exported", entity_type: "report", summary: `KPI ${key}`,
    changes: { kpi: key, filters: f.toDict(), rows, withheld, total }, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csv(content, `${key.replace(/\./g, "-")}-${c.today}.csv`);
});

router.get("/reports/kpis/{key}", async (ctx) => {
  const user = await ctx.require("reports", "view");
  await preload();
  const f = reportFilters(ctx);
  const k = kpi(ctx.param("key"), user);
  const c = await service.resolveCtx(ctx.db, user, f);
  const res = await safe(ctx.db, (d) => evaluate(d, k, c, { facets: f.facets }));
  if (res === null) throw new HttpError(409, "The source data for this metric is not available");
  const [value, ignored] = res;
  let delta: number | null = null;
  const prev = c.previous();
  if (prev !== null && !k.point_in_time && value !== null) {
    const p = await safe(ctx.db, (d) => evaluate(d, k, prev, { facets: f.facets }));
    if (p !== null && p[0] !== null) delta = round2(value - p[0]);
  }
  const out: KpiOut = {
    ...meta(k), value, delta, better: k.better, href: kpiHref(k.key, f), ignored_filters: ignored,
    columns: recordColumns(k).map((x) => ({ key: x.key, label: x.label, kind: x.kind })),
  };
  return out;
});

// ---------------------------------------------------------------------------- snapshots

router.post("/reports/snapshots/run", async (ctx) => {
  const user = await ctx.require("reports", "approve");
  return service.runSnapshots(ctx.db, user);
});

// ---------------------------------------------------------------------------- schedules and runs

router.get("/reports/schedules", async (ctx) => {
  const user = await ctx.require("reports", "view");
  return service.listSchedules(ctx.db, user);
});

router.post("/reports/schedules", async (ctx) => {
  const user = await ctx.require("reports", "create");
  const body = await ctx.body(scheduleIn);
  return created(await service.createSchedule(ctx.db, body, user));
});

router.post("/reports/schedules/run-due", async (ctx) => {
  const user = await ctx.require("reports", "approve");
  return service.runDue(ctx.db, user);
});

router.patch("/reports/schedules/{schedule_id}", async (ctx) => {
  const user = await ctx.require("reports", "edit");
  const scheduleId = ctx.uuid("schedule_id");
  const body = await ctx.body(scheduleUpdate);
  return service.updateSchedule(ctx.db, await service.getSchedule(ctx.db, scheduleId, user), body, user);
});

router.delete("/reports/schedules/{schedule_id}", async (ctx) => {
  const user = await ctx.require("reports", "delete");
  await service.deleteSchedule(ctx.db, await service.getSchedule(ctx.db, ctx.uuid("schedule_id"), user), user);
  return noContent();
});

router.get("/reports/runs", async (ctx) => {
  const user = await ctx.require("reports", "view");
  return service.listRuns(ctx.db, user, ctx.query.uuid("schedule_id"));
});

router.get("/reports/runs/{run_id}/download", async (ctx) => {
  const user = await ctx.require("reports", "view");
  const [run, data] = await service.runFile(ctx.db, ctx.uuid("run_id"), user);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${run.filename || "report.csv"}"`,
    },
  });
});
