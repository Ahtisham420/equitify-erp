import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { utcnow } from "../../core/security";
import { get, insert, patch } from "../../db/orm";
import {
  ALERT_RESOLUTIONS,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  SUBSCRIPTION_CHANNELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  alertSubscriptions,
  alerts,
  tasks,
  type AlertSubscription,
  type AutomationRule,
} from "./schema";
import {
  alertAckIn,
  alertResolveIn,
  cancelIn,
  resolutionIn,
  ruleUpdate,
  subscriptionIn,
  taskCreate,
  taskUpdate,
} from "./schemas";
import * as service from "./service";
import type { CurrentUser } from "../../core/deps";
import type { Db } from "../../db";

export const router = new Router();

const TASK_SORTS = {
  title: tasks.title, due_at: tasks.due_at, priority: tasks.priority, status: tasks.status,
  task_type: tasks.task_type, created_at: tasks.created_at, updated_at: tasks.updated_at,
};
const DUE_ASC = sql`${tasks.due_at} asc nulls last`;
const ALERT_SORTS = {
  created_at: alerts.created_at, severity: alerts.severity, status: alerts.status, title: alerts.title,
  due_at: alerts.due_at,
};

function admin(user: CurrentUser): void {
  if (!user.is_admin) throw new HttpError(403, "Only administrators can change automations");
}

// --------------------------------------------------------------------------- tasks

function taskFilters(ctx: Ctx, user: CurrentUser, skip?: string): service.TaskFilters {
  const q = ctx.query;
  return {
    actor_id: user.id,
    q: q.str("q", { max: 200 }),
    status_: q.strs("status"),
    priority: q.strs("priority"),
    task_type: q.strs("task_type"),
    assignee: q.strs("assignee"),
    due: q.enum("due", ["overdue", "today", "this_week", "none"] as const),
    related_type: q.str("related_type"),
    related_id: q.uuid("related_id"),
    skip: skip ? new Set([skip]) : undefined,
  };
}

router.get("/tasks", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  const p = ctx.listParams();
  const sorted = applySort(p.sort, TASK_SORTS, DUE_ASC);
  const [items, total] = await paginate(ctx.db, tasks, service.taskWhere(taskFilters(ctx, user)), sorted, p);
  return page(await service.taskOuts(ctx.db, items), total, p);
});

router.get("/tasks/facets", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  const w = (skip: string) => service.taskWhere(taskFilters(ctx, user, skip));
  return {
    status: await facetCounts(ctx.db, tasks, w("status"), tasks.status),
    priority: await facetCounts(ctx.db, tasks, w("priority"), tasks.priority),
    task_type: await facetCounts(ctx.db, tasks, w("task_type"), tasks.task_type),
  };
});

router.get("/tasks/meta", async (ctx) => {
  await ctx.require("tasks", "view");
  return {
    statuses: TASK_STATUSES, priorities: TASK_PRIORITIES, types: TASK_TYPES, severities: ALERT_SEVERITIES,
    alert_statuses: ALERT_STATUSES, resolutions: ALERT_RESOLUTIONS, channels: SUBSCRIPTION_CHANNELS,
  };
});

/** Daily digest data for the current user: due today, overdue, new and subscribed alerts. */
router.get("/tasks/digest", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  return service.digest(ctx.db, user.id);
});

router.post("/tasks", async (ctx) => {
  const user = await ctx.require("tasks", "create");
  const t = await service.create(ctx.db, await ctx.body(taskCreate), user);
  return created((await service.taskOuts(ctx.db, [t], { with_dependencies: true }))[0]);
});

router.get("/tasks/{task_id}", async (ctx) => {
  await ctx.require("tasks", "view");
  const t = await service.getTask(ctx.db, ctx.uuid("task_id"));
  return (await service.taskOuts(ctx.db, [t], { with_dependencies: true }))[0];
});

router.patch("/tasks/{task_id}", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const body = await ctx.body(taskUpdate);
  const t = await service.update(ctx.db, await service.getTask(ctx.db, ctx.uuid("task_id")), body, user);
  return (await service.taskOuts(ctx.db, [t], { with_dependencies: true }))[0];
});

router.post("/tasks/{task_id}/complete", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const body = await ctx.body(resolutionIn);
  const t = await service.complete(ctx.db, await service.getTask(ctx.db, ctx.uuid("task_id")), body.note, user);
  return (await service.taskOuts(ctx.db, [t], { with_dependencies: true }))[0];
});

router.post("/tasks/{task_id}/cancel", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const body = await ctx.body(cancelIn);
  const t = await service.cancel(ctx.db, await service.getTask(ctx.db, ctx.uuid("task_id")), body.note, user);
  return (await service.taskOuts(ctx.db, [t], { with_dependencies: true }))[0];
});

router.post("/tasks/{task_id}/reopen", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const t = await service.reopen(ctx.db, await service.getTask(ctx.db, ctx.uuid("task_id")), user);
  return (await service.taskOuts(ctx.db, [t], { with_dependencies: true }))[0];
});

router.delete("/tasks/{task_id}", async (ctx) => {
  const user = await ctx.require("tasks", "delete");
  await service.archive(ctx.db, await service.getTask(ctx.db, ctx.uuid("task_id")), user);
  return noContent();
});

// --------------------------------------------------------------------------- alerts

function alertFilters(ctx: Ctx, user: CurrentUser, skip?: string): service.AlertFilters {
  const q = ctx.query;
  return {
    actor_id: user.id,
    q: q.str("q", { max: 200 }),
    status_: q.strs("status"),
    severity: q.strs("severity"),
    rule_key: q.strs("rule_key"),
    owner: q.strs("owner"),
    related_type: q.str("related_type"),
    related_id: q.uuid("related_id"),
    skip: skip ? new Set([skip]) : undefined,
  };
}

async function alertWhere(ctx: Ctx, user: CurrentUser, skip?: string) {
  const where = service.alertWhere(alertFilters(ctx, user, skip));
  if (ctx.query.bool("subscribed") ?? false) {
    const matched = await service.subscribedAlerts(ctx.db, user.id, {
      since: new Date(utcnow().getTime() - 30 * 24 * 3600 * 1000), limit: 500,
    });
    return and(where, inArray(alerts.id, matched.length ? matched.map((a) => a.id) : [randomUUID()]));
  }
  return where;
}

router.get("/alerts", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  const p = ctx.listParams();
  const [items, total] = await paginate(ctx.db, alerts, await alertWhere(ctx, user), applySort(p.sort, ALERT_SORTS, desc(alerts.created_at)), p);
  return page(await service.alertOuts(ctx.db, items), total, p);
});

router.get("/alerts/facets", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  return {
    status: await facetCounts(ctx.db, alerts, await alertWhere(ctx, user, "status"), alerts.status),
    severity: await facetCounts(ctx.db, alerts, await alertWhere(ctx, user, "severity"), alerts.severity),
    rule_key: await facetCounts(ctx.db, alerts, await alertWhere(ctx, user, "rule_key"), alerts.rule_key),
  };
});

router.get("/alerts/summary", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  return service.alertSummary(ctx.db, user.id);
});

/** Alert-fatigue monitoring: dismissed vs actioned resolutions per automation rule. */
router.get("/alerts/noise", async (ctx) => {
  await ctx.require("tasks", "view");
  return service.noiseMetrics(ctx.db, ctx.query.int("since_days", { ge: 1, le: 730 }) ?? 90);
});

router.get("/alerts/{alert_id}", async (ctx) => {
  await ctx.require("tasks", "view");
  return (await service.alertOuts(ctx.db, [await service.getAlert(ctx.db, ctx.uuid("alert_id"))]))[0];
});

router.post("/alerts/{alert_id}/acknowledge", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const body = await ctx.body(alertAckIn);
  const a = await service.acknowledge(ctx.db, await service.getAlert(ctx.db, ctx.uuid("alert_id")), body.note, user);
  return (await service.alertOuts(ctx.db, [a]))[0];
});

router.post("/alerts/{alert_id}/resolve", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const body = await ctx.body(alertResolveIn);
  const a = await service.resolve(ctx.db, await service.getAlert(ctx.db, ctx.uuid("alert_id")), body.note, body.kind, user);
  return (await service.alertOuts(ctx.db, [a]))[0];
});

// --------------------------------------------------------------------------- automation registry

const ruleOut = (r: AutomationRule) => ({
  id: r.id, key: r.key, name: r.name, description: r.description, event: r.event, enabled: r.enabled,
  thresholds: r.thresholds, last_run_at: r.last_run_at, run_count: r.run_count, error_count: r.error_count,
  last_error: r.last_error, updated_at: r.updated_at,
});

router.get("/automation/rules", async (ctx) => {
  await ctx.require("tasks", "view");
  const rules = await service.ensureRules(ctx.db);
  await ctx.db.commit();
  return rules.map(ruleOut);
});

router.patch("/automation/rules/{key}", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const body = await ctx.body(ruleUpdate);
  admin(user);
  const rule = await service.getRule(ctx.db, ctx.param("key"));
  if (!rule) throw new HttpError(404, "Automation rule not found");
  return ruleOut(await service.updateRule(ctx.db, rule, body.enabled, body.thresholds, user));
});

/** Run (or preview with dry_run=true) the overdue escalation automation. */
router.post("/automation/run-escalations", async (ctx) => {
  const user = await ctx.require("tasks", "edit");
  const dry_run = ctx.query.bool("dry_run") ?? false;
  admin(user);
  const result = await service.runEscalations(ctx.db, { actor: user, dry_run });
  if (!dry_run && !result.skipped) {
    await audit.record(ctx.db, {
      actor: user, action: "automation_rule.run", entity_type: "automation_rule", summary: "tasks.escalation",
      changes: {
        tasks_escalated: result.tasks_escalated, alerts_escalated: result.alerts_escalated,
        managers_notified: result.managers_notified,
      },
      ip_address: user.ip_address,
    });
    await ctx.db.commit();
  }
  return {
    dry_run: false, skipped: false, tasks_escalated: 0, alerts_escalated: 0, managers_notified: 0, items: [], ...result,
  };
});

// --------------------------------------------------------------------------- subscriptions

async function subOuts(db: Db, subs: AlertSubscription[]) {
  const names = await service.userNames(db, subs.map((s) => s.subscriber_id));
  return subs.map((s) => ({
    id: s.id, name: s.name, subscriber_id: s.subscriber_id, subscriber_name: names.get(s.subscriber_id!) ?? null,
    territory_id: s.territory_id, property_types: s.property_types, tenant: s.tenant, owner_id: s.owner_id,
    saved_view_id: s.saved_view_id, rule_keys: s.rule_keys, min_severity: s.min_severity, channel: s.channel,
    is_active: s.is_active, created_at: s.created_at,
  }));
}

async function getSub(db: Db, subId: string, user: CurrentUser): Promise<AlertSubscription> {
  const s = await get(db, alertSubscriptions, subId);
  if (!s || s.deleted_at) throw new HttpError(404, "Subscription not found");
  if (s.subscriber_id !== user.id && !user.is_admin) throw new HttpError(403, "You can only manage your own subscriptions");
  return s;
}

/** SubscriptionIn minus `subscriber_id`, with unset optional fields as null (pydantic defaults). */
function subValues(body: ReturnType<typeof subscriptionIn.parse>) {
  return {
    name: body.name,
    territory_id: body.territory_id ?? null,
    property_types: body.property_types,
    tenant: body.tenant ?? null,
    owner_id: body.owner_id ?? null,
    saved_view_id: body.saved_view_id ?? null,
    rule_keys: body.rule_keys,
    min_severity: body.min_severity,
    channel: body.channel,
    is_active: body.is_active,
  };
}

router.get("/alert-subscriptions", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  const scope = ctx.query.enum("scope", ["mine", "all"] as const) ?? "mine";
  const where = and(
    isNull(alertSubscriptions.deleted_at),
    scope === "mine" || !user.is_admin ? eq(alertSubscriptions.subscriber_id, user.id) : undefined,
  );
  const rows = await ctx.db.select().from(alertSubscriptions).where(where).orderBy(asc(alertSubscriptions.name));
  return subOuts(ctx.db, rows);
});

router.post("/alert-subscriptions", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  const body = await ctx.body(subscriptionIn);
  const subscriber = body.subscriber_id || user.id;
  if (subscriber !== user.id && !user.is_admin) throw new HttpError(403, "You can only subscribe yourself");
  const s = await insert(ctx.db, alertSubscriptions, {
    ...subValues(body), subscriber_id: subscriber, created_by_id: user.id, updated_by_id: user.id,
  });
  await audit.record(ctx.db, {
    actor: user, action: "alert_subscription.created", entity_type: "alert_subscription", entity_id: s.id,
    summary: s.name, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return created((await subOuts(ctx.db, [s]))[0]);
});

router.patch("/alert-subscriptions/{sub_id}", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  const body = await ctx.body(subscriptionIn);
  const s = await getSub(ctx.db, ctx.uuid("sub_id"), user);
  const data = subValues(body);
  const changes = audit.diff(s, data);
  await patch(ctx.db, alertSubscriptions, s, { ...data, updated_by_id: user.id });
  if (Object.keys(changes).length) {
    await audit.record(ctx.db, {
      actor: user, action: "alert_subscription.updated", entity_type: "alert_subscription", entity_id: s.id,
      changes, ip_address: user.ip_address,
    });
  }
  await ctx.db.commit();
  return (await subOuts(ctx.db, [s]))[0];
});

router.delete("/alert-subscriptions/{sub_id}", async (ctx) => {
  const user = await ctx.require("tasks", "view");
  const s = await getSub(ctx.db, ctx.uuid("sub_id"), user);
  await patch(ctx.db, alertSubscriptions, s, { deleted_at: utcnow(), updated_by_id: user.id });
  await audit.record(ctx.db, {
    actor: user, action: "alert_subscription.deleted", entity_type: "alert_subscription", entity_id: s.id,
    summary: s.name, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return noContent();
});
