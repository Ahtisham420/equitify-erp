import { and, asc, desc, eq, getTableColumns, isNull, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { applySearch, applySort, facetCounts, inFilter, page, paginate } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { people, organizations } from "../contacts/schema";
import { properties } from "../properties/schema";
import { tasks } from "../tasks/schema";
import * as quality from "./quality";
import {
  CADENCES, ENTITY_TYPES, JOB_STATUSES, ROW_STATUSES, dataSources, importJobs, importRows,
} from "./schema";
import { commitIn, dataSourceIn, dataSourceUpdate, mappingIn, thresholdsIn } from "./schemas";
import * as service from "./service";

export const router = new Router();

const ENTITY_MODULE: Record<string, string> = { property: "properties", person: "contacts", organization: "contacts" };

const requiredParam = (name: string) =>
  new HttpError(422, [{ loc: ["query", name], msg: "Field required", type: "missing" }]);

// --- Data sources (source/license registry) ---------------------------------------------------

async function sourceOuts(ctx: Ctx, sources: Array<typeof dataSources.$inferSelect>) {
  const ids = sources.map((s) => s.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const rows = await ctx.db
      .select({ id: importJobs.data_source_id, n: sql<number>`count(*)::int` })
      .from(importJobs)
      .where(and(sql`${importJobs.data_source_id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`, isNull(importJobs.deleted_at)))
      .groupBy(importJobs.data_source_id);
    for (const r of rows) if (r.id) counts.set(r.id, Number(r.n));
  }
  return sources.map((s) => service.dataSourceOut(s, counts.get(s.id) ?? 0));
}

router.get("/data-sources", async (ctx) => {
  await ctx.require("imports", "view");
  const params = ctx.listParams();
  const t = dataSources;
  const isActive = ctx.query.bool("is_active");
  const where = and(
    isNull(t.deleted_at),
    applySearch(params.q, [t.provider, t.description, t.contact_name, t.permitted_use]),
    isActive !== undefined ? eq(t.is_active, isActive) : undefined,
    inFilter(t.cadence, ctx.query.strs("cadence")),
  );
  const order = applySort(
    params.sort,
    { provider: t.provider, renewal_date: t.renewal_date, cost: t.cost, updated_at: t.updated_at, cadence: t.cadence },
    asc(t.provider),
  );
  const [items, total] = await paginate(ctx.db, t, where, order, params);
  return page(await sourceOuts(ctx, items), total, params);
});

router.get("/data-sources/meta", async (ctx) => {
  await ctx.require("imports", "view");
  return { cadences: CADENCES };
});

router.post("/data-sources", async (ctx) => {
  const user = await ctx.require("imports", "create");
  const body = await ctx.body(dataSourceIn);
  return created((await sourceOuts(ctx, [await service.createSource(ctx.db, body, user)]))[0]);
});

router.get("/data-sources/{source_id}", async (ctx) => {
  await ctx.require("imports", "view");
  return (await sourceOuts(ctx, [await service.getSource(ctx.db, ctx.uuid("source_id"))]))[0];
});

router.patch("/data-sources/{source_id}", async (ctx) => {
  const user = await ctx.require("imports", "edit");
  const body = await ctx.body(dataSourceUpdate);
  const src = await service.updateSource(ctx.db, await service.getSource(ctx.db, ctx.uuid("source_id")), body, user);
  return (await sourceOuts(ctx, [src]))[0];
});

router.delete("/data-sources/{source_id}", async (ctx) => {
  const user = await ctx.require("imports", "delete");
  await service.archiveSource(ctx.db, await service.getSource(ctx.db, ctx.uuid("source_id")), user);
  return noContent();
});

// --- Import jobs ------------------------------------------------------------------------------

function jobWhere(
  q: string | undefined, status: string[] | undefined, entityType: string[] | undefined, dataSourceId: string | undefined,
  skip: Set<string> = new Set(),
): SQL | undefined {
  const t = importJobs;
  return and(
    isNull(t.deleted_at),
    applySearch(q, [t.filename]),
    skip.has("status") ? undefined : inFilter(t.status, status),
    skip.has("entity_type") ? undefined : inFilter(t.entity_type, entityType),
    dataSourceId ? eq(t.data_source_id, dataSourceId) : undefined,
  );
}

router.get("/imports", async (ctx) => {
  await ctx.require("imports", "view");
  const params = ctx.listParams();
  const q = ctx.query;
  const t = importJobs;
  const where = jobWhere(params.q, q.strs("status"), q.strs("entity_type"), q.uuid("data_source_id"));
  const order = applySort(
    params.sort,
    { created_at: t.created_at, filename: t.filename, status: t.status, row_count: t.row_count, committed_at: t.committed_at },
    desc(t.created_at),
  );
  const [items, total] = await paginate(ctx.db, t, where, order, params);
  const sourceIds = [...new Set(items.map((j) => j.data_source_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (sourceIds.length) {
    const rows = await ctx.db
      .select({ id: dataSources.id, p: dataSources.provider })
      .from(dataSources)
      .where(sql`${dataSources.id} in (${sql.join(sourceIds.map((i) => sql`${i}`), sql`, `)})`);
    for (const r of rows) names.set(r.id, r.p);
  }
  return page(items.map((j) => service.jobOut(j, j.data_source_id ? names.get(j.data_source_id) ?? null : null)), total, params);
});

router.get("/imports/facets", async (ctx) => {
  await ctx.require("imports", "view");
  const q = ctx.query;
  const search = q.str("q", { max: 200 });
  const status = q.strs("status");
  const entityType = q.strs("entity_type");
  const sourceId = q.uuid("data_source_id");
  return {
    status: await facetCounts(ctx.db, importJobs, jobWhere(search, status, entityType, sourceId, new Set(["status"])), importJobs.status),
    entity_type: await facetCounts(
      ctx.db, importJobs, jobWhere(search, status, entityType, sourceId, new Set(["entity_type"])), importJobs.entity_type,
    ),
  };
});

router.get("/imports/meta", async (ctx) => {
  await ctx.require("imports", "view");
  return { entity_types: ENTITY_TYPES, statuses: JOB_STATUSES, row_statuses: ROW_STATUSES, max_rows: service.MAX_ROWS };
});

router.get("/imports/fields", async (ctx) => {
  const entityType = ctx.query.enum("entity_type", ["property", "person", "organization"] as const);
  await ctx.require("imports", "view");
  if (!entityType) throw requiredParam("entity_type");
  return service.targetFields(entityType);
});

router.post("/imports", async (ctx) => {
  const user = await ctx.require("imports", "create");
  const form = await ctx.form();
  const file = form.get("file");
  const entityType = form.get("entity_type");
  const sourceId = form.get("data_source_id");
  const missing = (name: string) => ({ loc: ["body", name], msg: "Field required", type: "missing" });
  const problems: unknown[] = [];
  if (!(file instanceof File)) problems.push(missing("file"));
  if (typeof entityType !== "string") problems.push(missing("entity_type"));
  if (typeof sourceId !== "string") problems.push(missing("data_source_id"));
  else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)) {
    problems.push({ loc: ["body", "data_source_id"], msg: "Input should be a valid UUID", type: "uuid_parsing" });
  }
  if (problems.length) throw new HttpError(422, problems);
  const job = await service.upload(ctx.db, {
    file: file as File, entity_type: entityType as string, data_source_id: sourceId as string, actor: user,
  });
  return created(await service.jobDetail(ctx.db, job));
});

router.get("/imports/{job_id}", async (ctx) => {
  await ctx.require("imports", "view");
  return service.jobDetail(ctx.db, await service.getJob(ctx.db, ctx.uuid("job_id")));
});

router.put("/imports/{job_id}/mapping", async (ctx) => {
  const user = await ctx.require("imports", "create");
  const body = await ctx.body(mappingIn);
  const job = await service.setMapping(ctx.db, await service.getJob(ctx.db, ctx.uuid("job_id")), body.column_mapping, user);
  return service.jobDetail(ctx.db, job);
});

router.post("/imports/{job_id}/validate", async (ctx) => {
  const user = await ctx.require("imports", "create");
  const job = await service.validate(ctx.db, await service.getJob(ctx.db, ctx.uuid("job_id")), user);
  return service.jobDetail(ctx.db, job);
});

router.get("/imports/{job_id}/rows", async (ctx) => {
  await ctx.require("imports", "view");
  const params = ctx.listParams();
  const jobId = ctx.uuid("job_id");
  await service.getJob(ctx.db, jobId);
  const t = importRows;
  const where = and(
    eq(t.job_id, jobId),
    inFilter(t.status, ctx.query.strs("status")),
    params.q ? sql`${t.raw}::text ilike ${"%" + params.q + "%"}` : undefined,
  );
  const order = applySort(params.sort, { row_number: t.row_number, status: t.status }, asc(t.row_number));
  const [items, total] = await paginate(ctx.db, t, where, order, params);
  return page(items, total, params);
});

router.get("/imports/{job_id}/row-facets", async (ctx) => {
  await ctx.require("imports", "view");
  const jobId = ctx.uuid("job_id");
  await service.getJob(ctx.db, jobId);
  return facetCounts(ctx.db, importRows, eq(importRows.job_id, jobId), importRows.status);
});

router.post("/imports/{job_id}/commit", async (ctx) => {
  const user = await ctx.require("imports", "create");
  const body = await ctx.body(commitIn);
  const job0 = await service.getJob(ctx.db, ctx.uuid("job_id"));
  const module = ENTITY_MODULE[job0.entity_type];
  if (!user.can(module, "create") || (body.on_duplicate === "update" && !user.can(module, "edit"))) {
    throw new HttpError(403, `Missing permission ${module}:${body.on_duplicate === "update" ? "edit" : "create"}`);
  }
  const job = await service.commit(ctx.db, job0, body, user);
  return service.jobDetail(ctx.db, job);
});

router.post("/imports/{job_id}/rollback", async (ctx) => {
  const user = await ctx.require("imports", "edit");
  const job0 = await service.getJob(ctx.db, ctx.uuid("job_id"));
  const module = ENTITY_MODULE[job0.entity_type];
  if (!user.can(module, "edit")) throw new HttpError(403, `Missing permission ${module}:edit`);
  const job = await service.rollback(ctx.db, job0, user);
  return service.jobDetail(ctx.db, job);
});

// --- Data quality -----------------------------------------------------------------------------

function obsParams(ctx: Ctx) {
  return {
    params: ctx.listParams(),
    field: ctx.query.strs("field"),
    source: ctx.query.str("source", { max: 200 }),
    ai_derived: ctx.query.bool("ai_derived"),
  };
}

router.get("/data-quality/summary", async (ctx) => {
  await ctx.require("properties", "view");
  return quality.summary(ctx.db);
});

router.get("/data-quality/backlog", async (ctx) => {
  await ctx.require("properties", "view");
  const { params, field, source, ai_derived } = obsParams(ctx);
  const [items, total] = await quality.backlog(ctx.db, params, field, source, ai_derived);
  return page(items, total, params);
});

router.get("/data-quality/backlog/facets", async (ctx) => {
  await ctx.require("properties", "view");
  const { params, field, source, ai_derived } = obsParams(ctx);
  return quality.backlogFacets(ctx.db, params, field, source, ai_derived);
});

router.get("/data-quality/stale", async (ctx) => {
  await ctx.require("properties", "view");
  const params = ctx.listParams();
  const [items, total] = await quality.stale(ctx.db, params, ctx.query.strs("field"));
  return page(items, total, params);
});

router.get("/data-quality/duplicates", async (ctx) => {
  await ctx.require("properties", "view");
  const params = ctx.listParams();
  const [items, total] = await quality.duplicates(ctx.db, params);
  return page(items, total, params);
});

router.get("/data-quality/thresholds", async (ctx) => {
  await ctx.require("properties", "view");
  return quality.listThresholds(ctx.db);
});

router.put("/data-quality/thresholds", async (ctx) => {
  const user = await ctx.require("properties", "approve");
  const body = await ctx.body(thresholdsIn);
  return quality.setThresholds(ctx.db, body.thresholds, user);
});

// --- Core data export (open format) -----------------------------------------------------------

const EXPORT_ENTITIES = ["properties", "people", "organizations", "tasks"] as const;

function exportTarget(entity: (typeof EXPORT_ENTITIES)[number]): { table: PgTable; module: string; entityType: string } {
  if (entity === "properties") return { table: properties, module: "properties", entityType: "property" };
  if (entity === "tasks") return { table: tasks, module: "tasks", entityType: "task" };
  return entity === "people"
    ? { table: people, module: "contacts", entityType: "person" }
    : { table: organizations, module: "contacts", entityType: "organization" };
}

/** Python `json.dumps` (default separators, ensure_ascii) so exported JSON cells are unchanged. */
function pyDumps(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
  return "{" + Object.entries(v).map(([k, x]) => `${pyDumps(k)}: ${pyDumps(x)}`).join(", ") + "}";
}

/** Python `datetime.isoformat()` for an aware UTC datetime. */
function pyIso(d: Date): string {
  const iso = d.toISOString(); // 2026-01-01T10:00:00.123Z
  const ms = iso.slice(20, 23);
  return iso.slice(0, 19) + (ms === "000" ? "" : `.${ms}000`) + "+00:00";
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return pyIso(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  const v = toJsonable(value);
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return pyDumps(v);
  return String(v);
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

router.get("/exports/core", async (ctx) => {
  const user = await ctx.authed();
  const entity = ctx.query.enum("entity", EXPORT_ENTITIES);
  if (!entity) throw requiredParam("entity");
  const includeArchived = ctx.query.bool("include_archived") ?? false;
  const { table, module, entityType } = exportTarget(entity);
  if (!user.can(module, "export")) throw new HttpError(403, `Missing permission ${module}:export`);

  const cols = Object.entries(getTableColumns(table)).filter(([, c]) => !c.getSQLType().startsWith("geometry"));
  const t = table as any;
  const rows = await ctx.db
    .select()
    .from(table)
    .where(includeArchived ? undefined : isNull(t.deleted_at))
    .orderBy(asc(t.created_at));

  const lines = [cols.map(([, c]) => csvField(c.name)).join(",")];
  for (const r of rows as Array<Record<string, unknown>>) {
    lines.push(cols.map(([key]) => csvField(cell(r[key]))).join(","));
  }
  await audit.record(ctx.db, {
    actor: user, action: `${entityType}.exported`, entity_type: entityType, summary: `Core export · ${rows.length} rows`,
    changes: { include_archived: includeArchived }, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename=${entity}.csv` },
  });
});

