/** Reports service: context resolution, filter options, metric snapshots and scheduled report runs. */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import * as audit from "../../common/audit";
import { settings } from "../../config";
import { CurrentUser, loadUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { newId } from "../../db/columns";
import { get, insert, patch } from "../../db/orm";
import { build, DASHBOARDS, dashboardCsv } from "./dashboards";
import { available, Ctx, evaluate, Filters, load, preload, safe } from "./engine";
import { REGISTRY } from "./kpis";
import {
  metricSnapshots, reportRuns, reportSchedules, type MetricSnapshot, type ReportRun, type ReportSchedule,
} from "./schema";
import type {
  FilterOption, FilterOptions, RunDueOut, RunOut, ScheduleIn, ScheduleOut, ScheduleUpdate, SnapshotPoint,
  SnapshotRunOut,
} from "./schemas";

export const STORAGE = path.join(settings.STORAGE_DIR, "reports");

// ============================================================================ context

/** Territory filters only apply to territories the user may see. */
export async function resolveCtx(db: Db, user: CurrentUser, f: Filters): Promise<Ctx> {
  await preload();
  if (f.territory) {
    const T = load("territories.models:Territory");
    const vis = load("territories.service:visible_clause");
    if (T !== null && vis !== null) {
      const [ok] = await db
        .select({ id: T.id })
        .from(T)
        .where(and(eq(T.id, f.territory), isNull(T.deleted_at), vis(user)))
        .limit(1);
      if (!ok) throw new HttpError(404, "Territory not found");
    }
  }
  return new Ctx(user, f);
}

export async function filterOptions(db: Db, user: CurrentUser): Promise<FilterOptions> {
  await preload();
  const User = load("auth.models:User");
  const Team = load("auth.models:Team");
  const users: Array<{ id: string; name: string }> = await db
    .select({ id: User.id, name: User.full_name })
    .from(User)
    .where(and(isNull(User.deleted_at), eq(User.status, "active"), eq(User.is_service, false)))
    .orderBy(asc(User.full_name));
  const teams: Array<{ id: string; name: string }> = await db
    .select({ id: Team.id, name: Team.name })
    .from(Team)
    .where(isNull(Team.deleted_at))
    .orderBy(asc(Team.name));

  let territories: Array<{ id: string; name: string }> = [];
  const T = load("territories.models:Territory");
  const vis = load("territories.service:visible_clause");
  if (T !== null && vis !== null && user.can("territories", "view")) {
    territories =
      (await safe(db, (d) =>
        d.select({ id: T.id, name: T.name }).from(T).where(and(isNull(T.deleted_at), vis(user))).orderBy(asc(T.name)).limit(500),
      )) ?? [];
  }

  let states: string[] = [];
  const P = load("properties.models:Property");
  if (user.can("properties", "view")) {
    const rows: Array<{ s: string }> =
      (await safe(db, (d) =>
        d.selectDistinct({ s: P.state }).from(P).where(and(isNull(P.deleted_at), isNotNull(P.state))).orderBy(asc(P.state)),
      )) ?? [];
    states = rows.map((r) => r.s);
  }

  const sources = new Set<string>();
  const O = load("pipeline.models:Opportunity");
  const DS = load("imports.models:DataSource");
  if (O !== null && user.can("pipeline", "view")) {
    const rows: Array<{ s: string | null }> =
      (await safe(db, (d) => d.selectDistinct({ s: O.source }).from(O).where(isNotNull(O.source)).limit(300))) ?? [];
    for (const { s } of rows) if (s) sources.add(s);
  }
  if (DS !== null && user.can("imports", "view")) {
    const rows: Array<{ s: string | null }> =
      (await safe(db, (d) => d.selectDistinct({ s: DS.provider }).from(DS).where(isNull(DS.deleted_at)))) ?? [];
    for (const { s } of rows) if (s) sources.add(s);
  }

  const types: string[] = load("properties.models:PROPERTY_TYPES") ?? [];
  const stages: string[] = [];
  for (const ref of ["pipeline.models:STAGES", "brokerage.models:DEAL_STAGES"]) {
    for (const s of (load(ref) as string[] | null) ?? []) if (!stages.includes(s)) stages.push(s);
  }
  const opt = (value: string, label: string = value): FilterOption => ({ value, label });
  const lower = (a: string, b: string) => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return {
    users: [opt("me", "Me"), ...users.map((u) => opt(String(u.id), u.name))],
    teams: teams.map((t) => opt(String(t.id), t.name)),
    territories: territories.map((t) => opt(String(t.id), t.name)),
    property_types: types.map((t) => opt(t)),
    states: states.map((s) => opt(s)),
    sources: [...sources].sort(lower).map((s) => opt(s)),
    stages: stages.map((s) => opt(s)),
  };
}

// ============================================================================ snapshots

/** Record today's value of every KPI the actor can see (no filters). Existing snapshots are kept. */
export async function runSnapshots(db: Db, actor: CurrentUser): Promise<SnapshotRunOut> {
  await preload();
  const c = new Ctx(actor, new Filters());
  const today = c.today;
  const existing = new Set(
    (
      await db
        .select({ k: metricSnapshots.kpi_key })
        .from(metricSnapshots)
        .where(and(eq(metricSnapshots.as_of, today), eq(metricSnapshots.dims_key, "")))
    ).map((r) => r.k),
  );
  let created = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const k of Object.values(REGISTRY)) {
    if (!available(k, actor)) continue;
    if (existing.has(k.key)) {
      skipped += 1;
      continue;
    }
    const res = await safe(db, (d) => evaluate(d, k, c));
    if (res === null) {
      failed.push(k.key);
      continue;
    }
    await insert(db, metricSnapshots, {
      kpi_key: k.key, as_of: today, value: res[0], dims: {}, dims_key: "", created_by_id: actor.id,
    });
    created += 1;
  }
  await audit.record(db, {
    actor, action: "report.snapshots_run", entity_type: "metric_snapshot",
    summary: `${created} KPI snapshots for ${today}`, changes: { created, skipped, failed },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return { as_of: today, created, skipped, failed };
}

export async function history(db: Db, kpiKey: string): Promise<SnapshotPoint[]> {
  const rows: MetricSnapshot[] = await db
    .select()
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.kpi_key, kpiKey), eq(metricSnapshots.dims_key, "")))
    .orderBy(desc(metricSnapshots.as_of))
    .limit(400);
  return rows.reverse().map((r) => ({ as_of: r.as_of, value: r.value, dims: r.dims }));
}

// ============================================================================ schedules

export function advance(dt: Date, cadence: string): Date {
  if (cadence === "daily") return new Date(dt.getTime() + 86_400_000);
  if (cadence === "weekly") return new Date(dt.getTime() + 7 * 86_400_000);
  const month = (dt.getUTCMonth() + 1) % 12 + 1; // 1-based next month
  const year = dt.getUTCFullYear() + (dt.getUTCMonth() === 11 ? 1 : 0);
  const day = Math.min(dt.getUTCDate(), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return new Date(Date.UTC(year, month - 1, day, dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds(), dt.getUTCMilliseconds()));
}

export function nextRun(prev: Date | null, cadence: string, now: Date): Date {
  let nxt = advance(prev ?? now, cadence);
  while (nxt <= now) nxt = advance(nxt, cadence);
  return nxt;
}

const canManage = (s: ReportSchedule, user: CurrentUser) => s.owner_id === user.id || user.can("reports", "approve");

async function names(db: Db, ids: string[]): Promise<Map<string, string>> {
  const User = load("auth.models:User");
  if (!ids.length) return new Map();
  const rows: Array<{ id: string; name: string }> = await db
    .select({ id: User.id, name: User.full_name })
    .from(User)
    .where(inArray(User.id, ids));
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

export async function scheduleOut(db: Db, s: ReportSchedule): Promise<ScheduleOut> {
  const recipients = s.recipient_ids ?? [];
  const nm = await names(db, [...recipients, ...(s.owner_id ? [s.owner_id] : [])]);
  const d = DASHBOARDS[s.dashboard_key];
  return {
    id: s.id, name: s.name, dashboard_key: s.dashboard_key, dashboard_label: d ? d.label : s.dashboard_key,
    filters: s.filters, cadence: s.cadence, recipient_ids: recipients,
    recipient_names: recipients.map((r) => nm.get(r) ?? "Unknown user"), format: s.format, is_active: s.is_active,
    owner_id: s.owner_id, owner_name: s.owner_id ? nm.get(s.owner_id) ?? null : null, next_run_at: s.next_run_at,
    last_run_at: s.last_run_at, notes: s.notes, created_at: s.created_at,
  };
}

async function validateRecipients(db: Db, ids: string[]): Promise<string[]> {
  const User = load("auth.models:User");
  const unique = [...new Set(ids)];
  const rows: Array<{ id: string }> = unique.length
    ? await db
      .select({ id: User.id })
      .from(User)
      .where(and(inArray(User.id, unique), isNull(User.deleted_at), eq(User.status, "active")))
    : [];
  const found = new Set(rows.map((r) => String(r.id)));
  const missing = unique.filter((i) => !found.has(i));
  if (missing.length) throw new HttpError(422, `Unknown or inactive recipients: ${missing.join(", ")}`);
  return unique;
}

export async function listSchedules(db: Db, user: CurrentUser): Promise<ScheduleOut[]> {
  await preload();
  const t = reportSchedules;
  const where = user.can("reports", "approve")
    ? isNull(t.deleted_at)
    : and(isNull(t.deleted_at), or(eq(t.owner_id, user.id), sql`${user.id} = any(${t.recipient_ids})`));
  const rows: ReportSchedule[] = await db.select().from(t).where(where).orderBy(desc(t.created_at));
  const out: ScheduleOut[] = [];
  for (const s of rows) out.push(await scheduleOut(db, s));
  return out;
}

export async function getSchedule(db: Db, scheduleId: string, user: CurrentUser): Promise<ReportSchedule> {
  const s = await get(db, reportSchedules, scheduleId);
  if (!s || s.deleted_at || !canManage(s, user)) throw new HttpError(404, "Schedule not found");
  return s;
}

export async function createSchedule(db: Db, body: ScheduleIn, actor: CurrentUser): Promise<ScheduleOut> {
  await preload();
  if (!(body.dashboard_key in DASHBOARDS)) throw new HttpError(422, "Unknown dashboard");
  const filters = Filters.fromDict(body.filters).toDict();
  const recipients = await validateRecipients(db, body.recipient_ids.length ? body.recipient_ids : [actor.id]);
  const s = await insert(db, reportSchedules, {
    name: body.name, dashboard_key: body.dashboard_key, filters, cadence: body.cadence,
    recipient_ids: recipients, format: body.format, is_active: body.is_active, notes: body.notes ?? null,
    owner_id: actor.id, next_run_at: utcnow(), created_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "report_schedule.created", entity_type: "report_schedule", entity_id: s.id,
    summary: `Scheduled ${body.dashboard_key} (${body.cadence})`, changes: { ...body, notes: body.notes ?? null },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return scheduleOut(db, s);
}

export async function updateSchedule(
  db: Db, s: ReportSchedule, body: ScheduleUpdate, actor: CurrentUser,
): Promise<ScheduleOut> {
  await preload();
  const sent: Record<string, any> = { ...body }; // only keys the client sent (exclude_unset)
  if ("filters" in sent && sent.filters !== null && sent.filters !== undefined) {
    sent.filters = Filters.fromDict(sent.filters).toDict();
  }
  if (sent.recipient_ids !== null && sent.recipient_ids !== undefined) {
    sent.recipient_ids = await validateRecipients(db, sent.recipient_ids.length ? sent.recipient_ids : [actor.id]);
  }
  const values: Record<string, any> = Object.fromEntries(
    Object.entries(sent).filter(([k, v]) => (v !== null && v !== undefined) || k === "notes"),
  );
  const changes = audit.diff(s, values);
  const extra: Record<string, any> = {};
  if (values.is_active && (!s.next_run_at || s.next_run_at < utcnow())) extra.next_run_at = utcnow();
  await patch(db, reportSchedules, s, { ...values, ...extra, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "report_schedule.updated", entity_type: "report_schedule", entity_id: s.id, summary: s.name,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return scheduleOut(db, s);
}

export async function deleteSchedule(db: Db, s: ReportSchedule, actor: CurrentUser): Promise<void> {
  await patch(db, reportSchedules, s, { deleted_at: utcnow(), is_active: false, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "report_schedule.deleted", entity_type: "report_schedule", entity_id: s.id, summary: s.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

async function recipientUser(db: Db, userId: string): Promise<CurrentUser | null> {
  const u = await loadUser(db, userId);
  if (!u || u.deleted_at || u.status !== "active") return null;
  return new CurrentUser(
    u,
    (u.role.permissions as Record<string, string[]>) ?? {},
    (u.role.approval_limits as Record<string, number | null>) ?? {},
  );
}

/** One file per recipient, computed with the recipient's own permissions. */
async function generate(db: Db, s: ReportSchedule, recipientId: string, actor: CurrentUser): Promise<ReportRun> {
  const run = {
    id: newId(), schedule_id: s.id, dashboard_key: s.dashboard_key, recipient_id: recipientId, ran_at: utcnow(),
    filters: s.filters ?? {}, run_by_id: actor.id, status: "success", error: null as string | null,
    filename: null as string | null, storage_key: null as string | null, size_bytes: 0, row_count: 0, withheld_rows: 0,
  };
  const d = DASHBOARDS[s.dashboard_key];
  const who = await recipientUser(db, recipientId);
  if (d === undefined) {
    run.status = "failed";
    run.error = "Dashboard no longer exists";
  } else if (who === null) {
    run.status = "failed";
    run.error = "Recipient is inactive";
  } else if (!who.can("reports", "view")) {
    run.status = "failed";
    run.error = "Recipient lacks reports access";
  } else {
    try {
      const out = await build(db, d, new Ctx(who, Filters.fromDict(s.filters)));
      const [content, rows, withheld] = dashboardCsv(out);
      await mkdir(STORAGE, { recursive: true });
      const key = `reports/${run.id}.csv`;
      const data = Buffer.from(content, "utf-8");
      await writeFile(path.join(settings.STORAGE_DIR, key), data);
      run.status = "success";
      run.storage_key = key;
      run.filename = `${s.dashboard_key}-${run.ran_at.toISOString().slice(0, 10)}.csv`;
      run.size_bytes = data.length;
      run.row_count = rows;
      run.withheld_rows = withheld;
    } catch (exc) {
      if (exc instanceof HttpError) {
        run.status = "failed";
        run.error = `${exc.status}: ${exc.detail}`.slice(0, 500);
      } else if ((exc as NodeJS.ErrnoException)?.code) {
        run.status = "failed"; // OSError
        run.error = String((exc as Error).message).slice(0, 500);
      } else {
        throw exc;
      }
    }
  }
  return insert(db, reportRuns, run);
}

export async function runDue(db: Db, actor: CurrentUser): Promise<RunDueOut> {
  await preload();
  const now = utcnow();
  const t = reportSchedules;
  const due: ReportSchedule[] = await db
    .select()
    .from(t)
    .where(and(isNull(t.deleted_at), eq(t.is_active, true), isNotNull(t.next_run_at), lte(t.next_run_at, now)));
  let runs = 0;
  let failed = 0;
  for (const s of due) {
    for (const rid of s.recipient_ids ?? []) {
      const run = await generate(db, s, rid, actor);
      runs += 1;
      failed += run.status !== "success" ? 1 : 0;
    }
    await patch(db, t, s, { last_run_at: now, next_run_at: nextRun(s.next_run_at, s.cadence, now) });
    await audit.record(db, {
      actor, action: "report_schedule.run", entity_type: "report_schedule", entity_id: s.id,
      summary: `${s.name}: ${(s.recipient_ids ?? []).length} recipient file(s)`, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return { schedules: due.length, runs, failed };
}

export async function listRuns(db: Db, user: CurrentUser, scheduleId: string | undefined): Promise<RunOut[]> {
  const t = reportRuns;
  const runs: ReportRun[] = await db
    .select()
    .from(t)
    .where(and(user.is_admin ? undefined : eq(t.recipient_id, user.id), scheduleId ? eq(t.schedule_id, scheduleId) : undefined))
    .orderBy(desc(t.ran_at))
    .limit(200);
  const nm = await names(db, [...new Set(runs.map((r) => r.recipient_id).filter((x): x is string => !!x))]);
  return runs.map((r) => ({
    id: r.id, schedule_id: r.schedule_id, dashboard_key: r.dashboard_key, recipient_id: r.recipient_id,
    recipient_name: r.recipient_id ? nm.get(r.recipient_id) ?? null : null, ran_at: r.ran_at, status: r.status,
    filename: r.filename, size_bytes: r.size_bytes, row_count: r.row_count, withheld_rows: r.withheld_rows,
    error: r.error,
  }));
}

/** Only the recipient (or an administrator) may download a run: it reflects the recipient's permissions. */
export async function runFile(db: Db, runId: string, user: CurrentUser): Promise<[ReportRun, Buffer]> {
  const run = await get(db, reportRuns, runId);
  if (!run || (run.recipient_id !== user.id && !user.is_admin)) throw new HttpError(404, "Report run not found");
  if (run.status !== "success" || !run.storage_key) throw new HttpError(409, "This run has no file");
  const file = path.join(settings.STORAGE_DIR, run.storage_key);
  const isFile = await stat(file).then((st) => st.isFile(), () => false);
  if (!isFile) throw new HttpError(410, "Report file is no longer available");
  await audit.record(db, {
    actor: user, action: "report_run.downloaded", entity_type: "report_run", entity_id: run.id,
    summary: run.filename, ip_address: user.ip_address,
  });
  await db.commit();
  return [run, await readFile(file)];
}
