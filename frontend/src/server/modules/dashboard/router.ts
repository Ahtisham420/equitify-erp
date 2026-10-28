/**
 * Executive / acquisitions command center (spec module 34, Release 1 scope).
 *
 * Every metric carries an `href` that drills to the exact list of records behind the number.
 * A missing permission simply omits its block.
 */
import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";

import type { CurrentUser } from "../../core/deps";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { Router } from "../../core/router";
import { buyboxEvaluations } from "../buybox/schema";
import { interactions } from "../outreach/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { alerts, tasks } from "../tasks/schema";

export const router = new Router();

const ACTIVE_STAGES = [
  "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
  "under_contract", "due_diligence", "closing",
];

interface Metric {
  label: string;
  value: number;
  href: string | null;
  hint: string | null;
  tone: string | null;
}
interface Bucket {
  key: string;
  label: string;
  value: number;
  href: string | null;
}
interface Overview {
  generated_at: Date;
  headline: Metric[];
  pipeline_by_stage: Bucket[];
  properties_by_status: Bucket[];
  interactions_by_day: Bucket[];
  buybox_results: Bucket[];
}

const metric = (label: string, value: number, o: { href?: string; hint?: string; tone?: string | null } = {}): Metric => ({
  label, value, href: o.href ?? null, hint: o.hint ?? null, tone: o.tone ?? null,
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
// Server-local calendar date (Python date.today()).
const isoLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function propertiesBlock(db: Db, out: Overview) {
  const live = isNull(properties.deleted_at);
  const since = new Date(utcnow().getTime() - 30 * 86_400_000);
  const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(properties).where(live);
  const [fresh] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(properties)
    .where(and(live, gte(properties.created_at, since)));
  const [a] = await db.select({ v: sql<number | null>`avg(${properties.completeness_score})::float8` }).from(properties).where(live);
  const avgScore = a?.v ?? 0;
  out.headline.push(
    metric("Properties tracked", total?.n ?? 0, { href: "/properties", hint: `${fresh?.n ?? 0} added in 30 days` }),
    metric("Avg. data completeness", Math.round(Number(avgScore) * 10) / 10, {
      href: "/data-quality", tone: avgScore < 60 ? "caution" : null,
    }),
  );
  const rows = await db
    .select({ s: properties.status, c: sql<number>`count(*)::int` })
    .from(properties)
    .where(live)
    .groupBy(properties.status);
  out.properties_by_status = rows.map((r) => ({ key: r.s, label: r.s, value: r.c, href: `/properties?status=${r.s}` }));
}

async function pipelineBlock(db: Db, out: Overview) {
  const live = isNull(opportunities.deleted_at);
  const rows = await db
    .select({ s: opportunities.stage, c: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(live)
    .groupBy(opportunities.stage);
  const byStage = new Map<string, number>(rows.map((r) => [r.s, r.c]));
  out.pipeline_by_stage = ACTIVE_STAGES.map((s) => ({
    key: s, label: s, value: byStage.get(s) ?? 0, href: `/pipeline?view=table&stage=${s}`,
  }));
  const active = ACTIVE_STAGES.reduce((sum, s) => sum + (byStage.get(s) ?? 0), 0);
  const [stalled] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(
      and(
        live,
        inArray(opportunities.stage, ACTIVE_STAGES),
        lt(opportunities.stage_entered_at, new Date(utcnow().getTime() - 14 * 86_400_000)),
      ),
    );
  const stalledN = stalled?.n ?? 0;
  out.headline.push(
    metric("Active opportunities", active, { href: "/pipeline" }),
    metric("Stalled > 14 days", stalledN, { href: "/pipeline?view=table&stalled=true", tone: stalledN ? "negative" : null }),
  );
}

async function workBlock(db: Db, out: Overview, user: CurrentUser) {
  const mine = and(
    isNull(tasks.deleted_at),
    eq(tasks.assignee_id, user.id),
    inArray(tasks.status, ["open", "in_progress"]),
  );
  const now = utcnow();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const count_ = async (where: ReturnType<typeof and>) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(where);
    return r?.n ?? 0;
  };
  const overdue = await count_(and(mine, lt(tasks.due_at, now)));
  const dueToday = await count_(and(mine, gte(tasks.due_at, now), lte(tasks.due_at, endOfDay)));
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(alerts)
    .where(
      and(isNull(alerts.deleted_at), sql`${alerts.status} <> 'resolved'`, inArray(alerts.severity, ["high", "critical"])),
    );
  const critical = c?.n ?? 0;
  out.headline.push(
    metric("My overdue tasks", overdue, { href: "/tasks?assignee=me&due=overdue", tone: overdue ? "negative" : null }),
    metric("Due today", dueToday, { href: "/tasks?assignee=me&due=today" }),
    metric("High-severity alerts", critical, {
      href: "/tasks?tab=alerts&severity=high&severity=critical", tone: critical ? "caution" : null,
    }),
  );
}

async function outreachBlock(db: Db, out: Overview) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 13);
  const day = sql<string>`to_char(date(${interactions.occurred_at}), 'YYYY-MM-DD')`;
  const rows = await db
    .select({ d: day, c: sql<number>`count(*)::int` })
    .from(interactions)
    .where(gte(interactions.occurred_at, start))
    .groupBy(day);
  const byDay = new Map<string, number>(rows.map((r) => [r.d, r.c]));
  out.interactions_by_day = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = isoLocal(d);
    return {
      key: iso,
      label: `${MONTHS[d.getMonth()]} ${pad(d.getDate())}`,
      value: byDay.get(iso) ?? 0,
      href: `/interactions?date_from=${iso}&date_to=${iso}`,
    };
  });
}

async function buyboxBlock(db: Db, out: Overview) {
  const rows = await db
    .select({ r: buyboxEvaluations.result, c: sql<number>`count(distinct ${buyboxEvaluations.property_id})::int` })
    .from(buyboxEvaluations)
    .where(eq(buyboxEvaluations.is_current, true))
    .groupBy(buyboxEvaluations.result);
  out.buybox_results = rows.map((r) => ({ key: r.r, label: r.r, value: r.c, href: `/buy-boxes?result=${r.r}` }));
}

router.get("/dashboard/overview", async (ctx) => {
  const user = await ctx.require("dashboard", "view");
  const out: Overview = {
    generated_at: utcnow(),
    headline: [],
    pipeline_by_stage: [],
    properties_by_status: [],
    interactions_by_day: [],
    buybox_results: [],
  };
  if (user.can("properties", "view")) await propertiesBlock(ctx.db, out);
  if (user.can("pipeline", "view")) await pipelineBlock(ctx.db, out);
  if (user.can("tasks", "view")) await workBlock(ctx.db, out, user);
  if (user.can("outreach", "view")) await outreachBlock(ctx.db, out);
  if (user.can("buybox", "view")) await buyboxBlock(ctx.db, out);
  return out;
});
