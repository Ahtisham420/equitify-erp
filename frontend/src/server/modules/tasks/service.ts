/**
 * Task/alert helpers used by every module's automations.
 *
 *   import { createTask, raiseAlert } from "../tasks/service";
 *   import { ruleConfig, recordRuleRun } from "../tasks/service";   // automation registry
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, inFilter } from "../../common/query";
import { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { get, insert, patch } from "../../db/orm";
import { utcnow } from "../../core/security";
import { users } from "../auth/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { buildWhere as buildPropertyWhere, type PropertyFilters } from "../properties/service";
import { savedViews } from "../search/schema";
import { strftime } from "./fmt";
import {
  ALERT_SEVERITIES,
  TASK_PRIORITIES,
  alertSubscriptions,
  alerts,
  automationRules,
  tasks,
  type Alert,
  type AlertSubscription,
  type AutomationRule,
  type Task,
} from "./schema";
import type { SubscriptionIn } from "./schemas";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export async function createTask(
  db: Db,
  o: {
    title: string;
    assignee_id?: string | null;
    due_at?: Date | null;
    task_type?: string;
    priority?: string;
    description?: string | null;
    related_type?: string | null;
    related_id?: string | null;
    related_label?: string | null;
    source?: string;
    idempotency_key?: string | null;
    actor_id?: string | null;
  },
): Promise<Task> {
  if (o.idempotency_key) {
    const [existing] = await db.select().from(tasks).where(eq(tasks.idempotency_key, o.idempotency_key)).limit(1);
    if (existing) return existing;
  }
  return insert(db, tasks, {
    title: o.title.slice(0, 300),
    description: o.description ?? null,
    task_type: o.task_type ?? "general",
    priority: o.priority ?? "normal",
    due_at: o.due_at ?? null,
    assignee_id: o.assignee_id ?? null,
    related_type: o.related_type ?? null,
    related_id: o.related_id ?? null,
    related_label: o.related_label ? o.related_label.slice(0, 300) : null,
    source: o.source ?? "manual",
    idempotency_key: o.idempotency_key ?? null,
    created_by_id: o.actor_id ?? null,
    updated_by_id: o.actor_id ?? null,
  });
}

export async function raiseAlert(
  db: Db,
  o: {
    title: string;
    reason: string;
    severity?: string;
    owner_id?: string | null;
    related_type?: string | null;
    related_id?: string | null;
    related_label?: string | null;
    rule_key?: string | null;
    due_at?: Date | null;
    idempotency_key?: string | null;
  },
): Promise<Alert> {
  if (o.idempotency_key) {
    const [existing] = await db.select().from(alerts).where(eq(alerts.idempotency_key, o.idempotency_key)).limit(1);
    if (existing) return existing;
  }
  return insert(db, alerts, {
    title: o.title.slice(0, 300),
    reason: o.reason,
    severity: o.severity ?? "medium",
    owner_id: o.owner_id ?? null,
    related_type: o.related_type ?? null,
    related_id: o.related_id ?? null,
    related_label: o.related_label ? o.related_label.slice(0, 300) : null,
    rule_key: o.rule_key ?? null,
    due_at: o.due_at ?? null,
    idempotency_key: o.idempotency_key ?? null,
  });
}

// --------------------------------------------------------------------------- automation registry

export const DEFAULT_RULES: Array<{
  key: string;
  name: string;
  event: string;
  description: string;
  thresholds: Record<string, any>;
}> = [
  {
    key: "buybox.insufficient_data",
    name: "Insufficient data for Buy Box",
    event: "buybox.evaluated",
    description:
      "Creates a research task when a property cannot be evaluated against an active Buy Box " +
      "because required fields are missing.",
    thresholds: { task_due_days: 3 },
  },
  {
    key: "pipeline.followup_on_contact",
    name: "Follow-up after contact",
    event: "opportunity.stage_changed",
    description: "Creates a follow-up task when an opportunity reaches the contact stage without a scheduled next step.",
    thresholds: { follow_up_days: 2 },
  },
  {
    key: "outreach.next_action_required",
    name: "Follow-up task from next action",
    event: "interaction.logged",
    description: "Turns the mandatory next action on a meaningful interaction into an owned follow-up task.",
    thresholds: { default_follow_up_days: 3 },
  },
  {
    key: "compliance.optout_propagation",
    name: "Cross-channel opt-out propagation",
    event: "compliance.opted_out",
    description:
      "Immediately suppresses every phone and email of a person who opted out on any channel and " +
      "exits their active sequences.",
    thresholds: {},
  },
  {
    key: "tasks.escalation",
    name: "Overdue escalation",
    event: "schedule",
    description:
      "Raises priority/severity of overdue tasks and unacknowledged alerts after the configured " +
      "intervals and notifies the owner's manager.",
    thresholds: {
      task_overdue_hours: 24,
      alert_unacknowledged_hours: { low: 72, medium: 48, high: 24, critical: 4 },
      max_level: 2,
      notify_manager: true,
      severity_channels: {
        low: ["digest"], medium: ["in_app", "digest"], high: ["in_app", "email"], critical: ["in_app", "email"],
      },
    },
  },
];
const DEFAULTS = Object.fromEntries(DEFAULT_RULES.map((r) => [r.key, r]));

/** Seeds any missing registry rows (lazy, idempotent) and returns all rules. */
export async function ensureRules(db: Db): Promise<AutomationRule[]> {
  const rows = await db.select().from(automationRules).where(isNull(automationRules.deleted_at));
  const have = new Set(rows.map((r) => r.key));
  for (const d of DEFAULT_RULES) {
    if (!have.has(d.key)) {
      rows.push(
        await insert(db, automationRules, {
          key: d.key, name: d.name, description: d.description, event: d.event, enabled: true,
          thresholds: structuredClone(d.thresholds), run_count: 0, error_count: 0,
        }),
      );
    }
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function getRule(db: Db, key: string): Promise<AutomationRule | undefined> {
  let [rule] = await db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.key, key), isNull(automationRules.deleted_at)))
    .limit(1);
  if (!rule && key in DEFAULTS) {
    await ensureRules(db);
    [rule] = await db.select().from(automationRules).where(eq(automationRules.key, key)).limit(1);
  }
  return rule;
}

/** [enabled, thresholds] for an automation; thresholds are merged over the registry defaults. */
export async function ruleConfig(db: Db, key: string): Promise<[boolean, Record<string, any>]> {
  const rule = await getRule(db, key);
  const defaults = { ...(DEFAULTS[key]?.thresholds ?? {}) };
  if (!rule) return [true, defaults];
  return [Boolean(rule.enabled), { ...defaults, ...(rule.thresholds ?? {}) }];
}

/** Observability for automations: last run, run and error counters. Does not commit. */
export async function recordRuleRun(db: Db, key: string, o: { error?: string | null } = {}): Promise<void> {
  const rule = await getRule(db, key);
  if (!rule) return;
  const set: Record<string, any> = { last_run_at: utcnow(), run_count: (rule.run_count || 0) + 1 };
  if (o.error) {
    set.error_count = (rule.error_count || 0) + 1;
    set.last_error = o.error.slice(0, 2000);
  }
  await patch(db, automationRules, rule, set as never);
}

export async function updateRule(
  db: Db,
  rule: AutomationRule,
  enabled: boolean | null | undefined,
  thresholds: Record<string, any> | null | undefined,
  actor: CurrentUser,
): Promise<AutomationRule> {
  const data: Record<string, any> = {};
  if (enabled !== null && enabled !== undefined) data.enabled = enabled;
  if (thresholds !== null && thresholds !== undefined) data.thresholds = thresholds;
  const changes = audit.diff(rule, data);
  if (!Object.keys(changes).length) return rule;
  await patch(db, automationRules, rule, { ...data, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "automation_rule.updated", entity_type: "automation_rule", entity_id: rule.id, summary: rule.key,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return rule;
}

// --------------------------------------------------------------------------- helpers

export async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter((i): i is string => !!i))];
  if (!set.length) return new Map();
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, set));
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

/** [start of the UTC day, start of the next day). */
export function dayBounds(now: Date): [Date, Date] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return [start, new Date(start.getTime() + DAY)];
}

function bump(scale: readonly string[], current: string, steps: number): string {
  const i = scale.indexOf(current);
  const idx = i >= 0 ? i : 0;
  return scale[Math.min(scale.length - 1, idx + Math.max(0, steps))];
}

async function managerOf(db: Db, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [r] = await db.select({ m: users.manager_id }).from(users).where(eq(users.id, userId)).limit(1);
  return r?.m ?? null;
}

// --------------------------------------------------------------------------- tasks

export const OPEN_TASK = ["open", "in_progress"];

export async function getTask(db: Db, taskId: string): Promise<Task> {
  const t = await get(db, tasks, taskId);
  if (!t || t.deleted_at) throw new HttpError(404, "Task not found");
  return t;
}

/** Serializes tasks with assignee names and dependency/blocked state (TaskOut). */
export async function taskOuts(db: Db, rows: Task[], o: { with_dependencies?: boolean } = {}) {
  const depIds = [...new Set(rows.flatMap((t) => t.depends_on ?? []))];
  const deps = new Map<string, Task>();
  if (depIds.length) {
    for (const d of await db.select().from(tasks).where(inArray(tasks.id, depIds))) deps.set(d.id, d);
  }
  const names = await userNames(db, rows.map((t) => t.assignee_id));
  return rows.map((t) => {
    const refs = (t.depends_on ?? []).map((d) => deps.get(d)).filter((r): r is Task => !!r);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      task_type: t.task_type,
      status: t.status,
      priority: t.priority,
      due_at: t.due_at,
      assignee_id: t.assignee_id,
      assignee_name: (t.assignee_id && names.get(t.assignee_id)) || null,
      related_type: t.related_type,
      related_id: t.related_id,
      related_label: t.related_label,
      source: t.source,
      depends_on: (t.depends_on ?? []).map(String),
      dependencies: o.with_dependencies ? refs.map((r) => ({ id: r.id, title: r.title, status: r.status, due_at: r.due_at })) : [],
      blocked: refs.some((r) => OPEN_TASK.includes(r.status) && !r.deleted_at),
      completed_at: t.completed_at,
      completed_by_id: t.completed_by_id,
      resolution_note: t.resolution_note,
      escalation_level: t.escalation_level ?? 0,
      created_at: t.created_at,
      updated_at: t.updated_at,
      created_by_id: t.created_by_id,
    };
  });
}

async function validateDependencies(db: Db, taskId: string | null, depIds: string[]): Promise<string[]> {
  if (!depIds.length) return [];
  if (taskId && depIds.includes(taskId)) throw new HttpError(422, "A task cannot depend on itself");
  const rows = await db.select().from(tasks).where(and(inArray(tasks.id, depIds), isNull(tasks.deleted_at)));
  if (rows.length !== new Set(depIds).size) throw new HttpError(422, "One or more dependency tasks do not exist");
  if (taskId && rows.some((r) => (r.depends_on ?? []).includes(taskId))) {
    throw new HttpError(422, "Circular dependency: a dependency already depends on this task");
  }
  return [...new Set(depIds)];
}

export async function create(db: Db, data: import("./schemas").TaskCreate, actor: CurrentUser): Promise<Task> {
  const deps = await validateDependencies(db, null, data.depends_on);
  let t = await createTask(db, {
    title: data.title, description: data.description, task_type: data.task_type, priority: data.priority,
    due_at: data.due_at, assignee_id: data.assignee_id || actor.id, related_type: data.related_type,
    related_id: data.related_id, related_label: data.related_label, source: "manual", actor_id: actor.id,
  });
  t = await patch(db, tasks, t, { depends_on: deps });
  await audit.record(db, {
    actor, action: "task.created", entity_type: "task", entity_id: t.id, summary: t.title, ip_address: actor.ip_address,
  });
  if (t.related_type && t.related_id) {
    await audit.record(db, {
      actor, action: `${t.related_type}.task_added`, entity_type: t.related_type, entity_id: t.related_id,
      summary: t.title, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return t;
}

export async function update(db: Db, t: Task, data: import("./schemas").TaskUpdate, actor: CurrentUser): Promise<Task> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if ("depends_on" in values) values.depends_on = await validateDependencies(db, t.id, values.depends_on || []);
  if (!OPEN_TASK.includes(t.status) && Object.keys(values).some((k) => k !== "description")) {
    throw new HttpError(409, "Closed tasks cannot be changed");
  }
  const changes = audit.diff(t, values);
  if (!Object.keys(changes).length) return t;
  const set: Record<string, any> = { ...values };
  if ("due_at" in changes) set.escalation_level = 0;
  set.updated_by_id = actor.id;
  await patch(db, tasks, t, set as never);
  await audit.record(db, {
    actor, action: "task.updated", entity_type: "task", entity_id: t.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function complete(db: Db, t: Task, note: string | null | undefined, actor: CurrentUser): Promise<Task> {
  if (!OPEN_TASK.includes(t.status)) throw new HttpError(409, `Task is already ${t.status}`);
  if (t.depends_on?.length) {
    const openDeps = await db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.id, t.depends_on), inArray(tasks.status, OPEN_TASK), isNull(tasks.deleted_at)));
    if (openDeps.length) {
      throw new HttpError(409, {
        message: "Complete the tasks this one depends on first",
        open_dependencies: openDeps.map((d) => ({ id: String(d.id), title: d.title })),
      });
    }
  }
  await patch(db, tasks, t, {
    status: "done", completed_at: utcnow(), completed_by_id: actor.id, resolution_note: note ?? null,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "task.completed", entity_type: "task", entity_id: t.id, summary: t.title,
    changes: note ? { resolution_note: note } : null, ip_address: actor.ip_address,
  });
  await events.emit(db, "task.completed", { task_id: t.id, related_type: t.related_type, related_id: t.related_id, actor });
  await db.commit();
  return t;
}

export async function cancel(db: Db, t: Task, note: string, actor: CurrentUser): Promise<Task> {
  if (!OPEN_TASK.includes(t.status)) throw new HttpError(409, `Task is already ${t.status}`);
  await patch(db, tasks, t, {
    status: "cancelled", completed_at: utcnow(), completed_by_id: actor.id, resolution_note: note,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "task.cancelled", entity_type: "task", entity_id: t.id, summary: t.title,
    changes: { resolution_note: note }, ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function reopen(db: Db, t: Task, actor: CurrentUser): Promise<Task> {
  if (OPEN_TASK.includes(t.status)) return t;
  await patch(db, tasks, t, { status: "open", completed_at: null, completed_by_id: null, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "task.reopened", entity_type: "task", entity_id: t.id, summary: t.title, ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function archive(db: Db, t: Task, actor: CurrentUser): Promise<void> {
  await patch(db, tasks, t, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "task.archived", entity_type: "task", entity_id: t.id, summary: t.title, ip_address: actor.ip_address,
  });
  await db.commit();
}

export interface TaskFilters {
  actor_id: string;
  q?: string;
  status_?: string[];
  priority?: string[];
  task_type?: string[];
  assignee?: string[];
  due?: string;
  related_type?: string;
  related_id?: string;
  skip?: Set<string>;
}

export function taskWhere(f: TaskFilters): SQL | undefined {
  const t = tasks;
  const skip = f.skip ?? new Set<string>();
  const now = utcnow();
  const [start, end] = dayBounds(now);
  const conds: Array<SQL | undefined> = [
    isNull(t.deleted_at),
    applySearch(f.q, [t.title, t.description, t.related_label]),
    skip.has("status") ? undefined : inFilter(t.status, f.status_),
    skip.has("priority") ? undefined : inFilter(t.priority, f.priority),
    skip.has("task_type") ? undefined : inFilter(t.task_type, f.task_type),
  ];
  if (f.assignee?.length) {
    const ids: string[] = [];
    let unassigned = false;
    for (const a of f.assignee) {
      if (a === "me") ids.push(f.actor_id);
      else if (a === "none") unassigned = true;
      else if (UUID_RE.test(a)) ids.push(a);
    }
    const ors: SQL[] = [];
    if (ids.length) ors.push(inArray(t.assignee_id, ids));
    if (unassigned) ors.push(isNull(t.assignee_id));
    if (ors.length) conds.push(or(...ors));
  }
  if (f.due === "overdue") conds.push(and(lt(t.due_at, now), inArray(t.status, OPEN_TASK)));
  else if (f.due === "today") conds.push(and(gte(t.due_at, start), lt(t.due_at, end)));
  else if (f.due === "this_week") conds.push(and(gte(t.due_at, start), lt(t.due_at, new Date(start.getTime() + 7 * DAY))));
  else if (f.due === "none") conds.push(isNull(t.due_at));
  if (f.related_type) conds.push(eq(t.related_type, f.related_type));
  if (f.related_id) conds.push(eq(t.related_id, f.related_id));
  return and(...conds);
}

// --------------------------------------------------------------------------- alerts

export async function getAlert(db: Db, alertId: string): Promise<Alert> {
  const a = await get(db, alerts, alertId);
  if (!a || a.deleted_at) throw new HttpError(404, "Alert not found");
  return a;
}

function checkAlertAccess(a: Alert, actor: CurrentUser): void {
  if (a.owner_id && a.owner_id !== actor.id && !actor.can("tasks", "approve")) {
    throw new HttpError(403, "Only the alert owner or a manager can work this alert");
  }
}

/** AlertOut with the owner name. */
export async function alertOuts(db: Db, rows: Alert[]) {
  const names = await userNames(db, rows.map((a) => a.owner_id));
  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    reason: a.reason,
    severity: a.severity,
    status: a.status,
    owner_id: a.owner_id,
    owner_name: (a.owner_id && names.get(a.owner_id)) || null,
    related_type: a.related_type,
    related_id: a.related_id,
    related_label: a.related_label,
    rule_key: a.rule_key,
    due_at: a.due_at,
    acknowledged_at: a.acknowledged_at,
    resolved_at: a.resolved_at,
    resolved_by_id: a.resolved_by_id,
    resolution_note: a.resolution_note,
    resolution_kind: a.resolution_kind,
    escalation_level: a.escalation_level ?? 0,
    created_at: a.created_at,
  }));
}

export async function acknowledge(db: Db, a: Alert, note: string | null | undefined, actor: CurrentUser): Promise<Alert> {
  checkAlertAccess(a, actor);
  if (a.status !== "open") throw new HttpError(409, `Alert is already ${a.status}`);
  await patch(db, alerts, a, {
    status: "acknowledged", acknowledged_at: utcnow(), acknowledged_by_id: actor.id, updated_by_id: actor.id,
    ...(a.owner_id === null ? { owner_id: actor.id } : {}),
  });
  await audit.record(db, {
    actor, action: "alert.acknowledged", entity_type: "alert", entity_id: a.id, summary: a.title,
    changes: note ? { note } : null, ip_address: actor.ip_address,
  });
  await db.commit();
  return a;
}

/** Alerts are worked to a recorded resolution - there is no silent dismiss. */
export async function resolve(db: Db, a: Alert, note: string, kind: string, actor: CurrentUser): Promise<Alert> {
  checkAlertAccess(a, actor);
  if (a.status === "resolved") throw new HttpError(409, "Alert is already resolved");
  if (!note || note.trim().length < 3) throw new HttpError(422, "A resolution note is required");
  const now = utcnow();
  await patch(db, alerts, a, {
    ...(a.acknowledged_at ? {} : { acknowledged_at: now, acknowledged_by_id: actor.id }),
    status: "resolved", resolved_at: now, resolved_by_id: actor.id, resolution_note: note.trim(),
    resolution_kind: kind, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "alert.resolved", entity_type: "alert", entity_id: a.id, summary: a.title,
    changes: { resolution_kind: kind, resolution_note: a.resolution_note }, ip_address: actor.ip_address,
  });
  await db.commit();
  return a;
}

export interface AlertFilters {
  actor_id: string;
  q?: string;
  status_?: string[];
  severity?: string[];
  rule_key?: string[];
  owner?: string[];
  related_type?: string;
  related_id?: string;
  skip?: Set<string>;
}

export function alertWhere(f: AlertFilters): SQL | undefined {
  const t = alerts;
  const skip = f.skip ?? new Set<string>();
  const conds: Array<SQL | undefined> = [
    isNull(t.deleted_at),
    applySearch(f.q, [t.title, t.reason, t.related_label]),
    skip.has("status") ? undefined : inFilter(t.status, f.status_),
    skip.has("severity") ? undefined : inFilter(t.severity, f.severity),
    skip.has("rule_key") ? undefined : inFilter(t.rule_key, f.rule_key),
  ];
  if (f.owner?.length) {
    const ids: string[] = [];
    for (const o of f.owner) {
      if (o === "me") ids.push(f.actor_id);
      else if (UUID_RE.test(o)) ids.push(o);
    }
    if (ids.length) conds.push(inArray(t.owner_id, ids));
  }
  if (f.related_type) conds.push(eq(t.related_type, f.related_type));
  if (f.related_id) conds.push(eq(t.related_id, f.related_id));
  return and(...conds);
}

export async function alertSummary(db: Db, userId: string) {
  const rows = await db
    .select({ severity: alerts.severity, n: sql<number>`count(*)::int` })
    .from(alerts)
    .where(
      and(isNull(alerts.deleted_at), ne(alerts.status, "resolved"), or(eq(alerts.owner_id, userId), isNull(alerts.owner_id))),
    )
    .groupBy(alerts.severity);
  const counts = Object.fromEntries(rows.map((r) => [r.severity, Number(r.n)]));
  return { open: Object.values(counts).reduce((a, b) => a + b, 0), critical: counts.critical ?? 0 };
}

/** Alert fatigue monitoring: how often each rule's alerts are dismissed as noise vs actioned. */
export async function noiseMetrics(db: Db, sinceDays = 90) {
  const since = new Date(utcnow().getTime() - sinceDays * DAY);
  const rows = await db
    .select({
      rule_key: alerts.rule_key,
      status: alerts.status,
      kind: alerts.resolution_kind,
      n: sql<number>`count(*)::int`,
      avg_secs: sql<string | null>`avg(extract(epoch from ${alerts.resolved_at} - ${alerts.created_at}))`,
    })
    .from(alerts)
    .where(and(isNull(alerts.deleted_at), gte(alerts.created_at, since)))
    .groupBy(alerts.rule_key, alerts.status, alerts.resolution_kind);
  const agg = new Map<string, any>();
  for (const r of rows) {
    const key = r.rule_key || "manual";
    let a = agg.get(key);
    if (!a) {
      a = { rule_key: key, total: 0, open: 0, actioned: 0, dismissed: 0, _secs: 0, _resolved: 0 };
      agg.set(key, a);
    }
    const count = Number(r.n);
    a.total += count;
    if (r.status !== "resolved") a.open += count;
    else if (r.kind === "actioned") a.actioned += count;
    else a.dismissed += count;
    if (r.status === "resolved" && r.avg_secs !== null && r.avg_secs !== undefined) {
      a._secs += Number(r.avg_secs) * count;
      a._resolved += count;
    }
  }
  const out = [...agg.values()].map((a) => {
    const { _resolved: resolved, _secs: secs, ...rest } = a;
    return {
      ...rest,
      dismiss_rate: resolved ? Math.round((rest.dismissed / resolved) * 1000) / 1000 : 0.0,
      avg_hours_to_resolve: resolved ? Math.round((secs / resolved / 3600) * 10) / 10 : null,
    };
  });
  return out.sort((a, b) => b.dismiss_rate - a.dismiss_rate || b.total - a.total);
}

// --------------------------------------------------------------------------- escalation

type EscalationOpts = { actor?: CurrentUser | null; dry_run?: boolean };

/** Escalates overdue tasks and unacknowledged alerts one level per configured interval. Idempotent.
 *  The scheduler calls `runEscalations(db, actor)`; Python-style `runEscalations(db, { actor, dry_run })` also works. */
export async function runEscalations(db: Db, actorOrOpts?: CurrentUser | EscalationOpts | null, opts: EscalationOpts = {}) {
  const isOpts = !!actorOrOpts && !(actorOrOpts instanceof CurrentUser) && ("actor" in actorOrOpts || "dry_run" in actorOrOpts);
  const actor = isOpts ? ((actorOrOpts as EscalationOpts).actor ?? null) : ((actorOrOpts as CurrentUser | null | undefined) ?? opts.actor ?? null);
  const dry_run = (isOpts ? (actorOrOpts as EscalationOpts).dry_run : opts.dry_run) ?? false;

  const [enabled, th] = await ruleConfig(db, "tasks.escalation");
  if (!enabled) return { dry_run, skipped: true } as Record<string, any>;
  const now = utcnow();
  const taskHours = Math.max(1.0, Number(th.task_overdue_hours ?? 24));
  const alertHours: Record<string, number> = th.alert_unacknowledged_hours || {};
  const maxLevel = Math.trunc(Number(th.max_level ?? 2));
  const notify = Boolean(th.notify_manager ?? true);
  const result = {
    dry_run, skipped: false, tasks_escalated: 0, alerts_escalated: 0, managers_notified: 0, items: [] as any[],
  };
  try {
    const dueTasks = await db
      .select()
      .from(tasks)
      .where(
        and(
          isNull(tasks.deleted_at), inArray(tasks.status, OPEN_TASK), isNotNull(tasks.due_at),
          lt(tasks.due_at, new Date(now.getTime() - taskHours * HOUR)), lt(tasks.escalation_level, maxLevel),
        ),
      );
    for (const t of dueTasks) {
      const level = t.escalation_level || 0;
      const target = Math.min(maxLevel, Math.trunc(Math.floor((now.getTime() - t.due_at!.getTime()) / 1000 / 3600 / taskHours)));
      if (target <= level) continue;
      const newPriority = bump(TASK_PRIORITIES, t.priority, target - level);
      result.items.push({
        kind: "task", id: String(t.id), title: t.title, level: target, priority: { from: t.priority, to: newPriority },
      });
      result.tasks_escalated += 1;
      if (dry_run) continue;
      await patch(db, tasks, t, { priority: newPriority, escalation_level: target, escalated_at: now });
      await audit.record(db, {
        actor, action: "task.escalated", entity_type: "task", entity_id: t.id, summary: `Escalation level ${target}`,
        changes: { priority: newPriority },
      });
      const manager = notify ? await managerOf(db, t.assignee_id) : null;
      if (manager) {
        await raiseAlert(db, {
          title: `Overdue task escalated: ${t.title}`,
          reason: `Task has been overdue since ${strftime(t.due_at!, "%b %d, %Y %H:%M")} UTC (escalation level ${target}).`,
          severity: target >= maxLevel ? "high" : "medium", owner_id: manager, related_type: "task",
          related_id: t.id, related_label: t.title, rule_key: "tasks.escalation",
          idempotency_key: `escalation:task:${t.id}:${target}`,
        });
        result.managers_notified += 1;
      }
    }

    const openAlerts = await db
      .select()
      .from(alerts)
      .where(
        and(
          isNull(alerts.deleted_at), eq(alerts.status, "open"), lt(alerts.escalation_level, maxLevel),
          or(isNull(alerts.rule_key), ne(alerts.rule_key, "tasks.escalation")),
        ),
      );
    for (const a of openAlerts) {
      const level = a.escalation_level || 0;
      const hours = Number(alertHours[a.severity] || 48) || 48;
      if ((now.getTime() - a.created_at.getTime()) / HOUR < hours * (level + 1)) continue;
      const newSev = bump(ALERT_SEVERITIES, a.severity, 1);
      result.items.push({
        kind: "alert", id: String(a.id), title: a.title, level: level + 1, severity: { from: a.severity, to: newSev },
      });
      result.alerts_escalated += 1;
      if (dry_run) continue;
      await patch(db, alerts, a, { severity: newSev, escalation_level: level + 1, escalated_at: now });
      await audit.record(db, {
        actor, action: "alert.escalated", entity_type: "alert", entity_id: a.id, summary: `Escalation level ${level + 1}`,
        changes: { severity: newSev },
      });
      const manager = notify ? await managerOf(db, a.owner_id) : null;
      if (manager) {
        await raiseAlert(db, {
          title: `Unacknowledged alert escalated: ${a.title}`,
          reason:
            `Alert open without acknowledgement since ${strftime(a.created_at, "%b %d, %Y %H:%M")} UTC. ` +
            `Original reason: ${a.reason}`,
          severity: newSev, owner_id: manager, related_type: a.related_type, related_id: a.related_id,
          related_label: a.related_label, rule_key: "tasks.escalation",
          idempotency_key: `escalation:alert:${a.id}:${level + 1}`,
        });
        result.managers_notified += 1;
      }
    }
    if (!dry_run) {
      await recordRuleRun(db, "tasks.escalation");
      await db.commit();
    }
  } catch (exc: any) {
    // observable failure: counted on the rule, then re-raised
    await db.rollback();
    await recordRuleRun(db, "tasks.escalation", { error: `${exc?.constructor?.name ?? "Error"}: ${exc?.message ?? exc}` });
    await db.commit();
    throw exc;
  }
  return result as Record<string, any>;
}

// --------------------------------------------------------------------------- subscriptions & digest

const SEV_RANK: Record<string, number> = Object.fromEntries(ALERT_SEVERITIES.map((s, i) => [s, i]));

/** Rebuilds properties list filters from a saved view's URL params. */
function propertyFiltersFromParams(params: Record<string, any>): PropertyFilters {
  const f: Record<string, any> = {};
  const lists = ["status", "property_type", "state", "tag", "ids"];
  const floats = [
    "min_area", "max_area", "min_acres", "max_acres", "min_price", "max_price", "min_completeness", "near_lat",
    "near_lng", "radius_miles",
  ];
  const ints = ["min_year", "max_year"];
  const strs = ["q", "county", "city"];
  for (const name of [...strs, ...lists, ...floats, ...ints]) {
    if (!(name in params)) continue;
    const raw = params[name];
    const values = Array.isArray(raw) ? raw : [raw];
    try {
      if (lists.includes(name)) {
        f[name] = values.map(String);
      } else if (floats.includes(name)) {
        const n = Number(values[0]);
        if (values[0] === null || values[0] === "" || Number.isNaN(n)) continue;
        f[name] = n;
      } else if (ints.includes(name)) {
        const n = Number(values[0]);
        if (values[0] === null || values[0] === "" || !Number.isInteger(n)) continue;
        f[name] = n;
      } else {
        f[name] = String(values[0]);
      }
    } catch {
      continue;
    }
  }
  return f as PropertyFilters;
}

async function alertPropertyId(db: Db, a: Alert): Promise<string | null> {
  if (a.related_type === "property") return a.related_id;
  if (a.related_type === "opportunity" && a.related_id) {
    const [r] = await db
      .select({ property_id: opportunities.property_id })
      .from(opportunities)
      .where(eq(opportunities.id, a.related_id))
      .limit(1);
    return r?.property_id ?? null;
  }
  return null;
}

export async function alertMatches(db: Db, sub: AlertSubscription, a: Alert): Promise<boolean> {
  if (sub.rule_keys?.length && !sub.rule_keys.includes(a.rule_key as string)) return false;
  if ((SEV_RANK[a.severity] ?? 0) < (SEV_RANK[sub.min_severity] ?? 0)) return false;
  if (sub.owner_id && a.owner_id !== sub.owner_id) return false;
  if (!(sub.property_types?.length || sub.territory_id || sub.saved_view_id || sub.tenant)) return true;
  const pid = await alertPropertyId(db, a);
  if (pid === null) return false;
  if (sub.property_types?.length) {
    const [r] = await db
      .select({ t: properties.property_type })
      .from(properties)
      .where(eq(properties.id, pid))
      .limit(1);
    if (!r || !sub.property_types.includes(r.t)) return false;
  }
  if (sub.territory_id) {
    const rows = Array.from(
      (await db.execute(
        sql`select count(*)::int as n from territory_members where territory_id = ${sub.territory_id} and property_id = ${pid}`,
      )) as unknown as Array<{ n: number }>,
    );
    if (!rows[0]?.n) return false;
  }
  if (sub.tenant) {
    const rows = Array.from(
      (await db.execute(
        sql`select count(*)::int as n from spaces where property_id = ${pid} and tenant_name ilike ${`%${sub.tenant}%`}`,
      )) as unknown as Array<{ n: number }>,
    );
    if (!rows[0]?.n) return false;
  }
  if (sub.saved_view_id) {
    const view = await get(db, savedViews, sub.saved_view_id);
    if (!view || view.deleted_at || view.module !== "properties") return false;
    const where = and(buildPropertyWhere(propertyFiltersFromParams((view.params as Record<string, any>) ?? {})), eq(properties.id, pid));
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(properties).where(where);
    if (!r?.n) return false;
  }
  return true;
}

export async function subscribedAlerts(
  db: Db,
  userId: string,
  o: { since: Date; limit?: number },
): Promise<Alert[]> {
  const limit = o.limit ?? 100;
  const subs = await db
    .select()
    .from(alertSubscriptions)
    .where(
      and(eq(alertSubscriptions.subscriber_id, userId), eq(alertSubscriptions.is_active, true), isNull(alertSubscriptions.deleted_at)),
    );
  if (!subs.length) return [];
  const candidates = await db
    .select()
    .from(alerts)
    .where(
      and(
        isNull(alerts.deleted_at), gte(alerts.created_at, o.since),
        or(isNull(alerts.owner_id), ne(alerts.owner_id, userId)),
      ),
    )
    .orderBy(desc(alerts.created_at))
    .limit(500);
  const out: Alert[] = [];
  for (const a of candidates) {
    for (const s of subs) {
      if (await alertMatches(db, s, a)) {
        out.push(a);
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

export async function digest(db: Db, userId: string) {
  const now = utcnow();
  const [, end] = dayBounds(now);
  const base = and(isNull(tasks.deleted_at), eq(tasks.assignee_id, userId), inArray(tasks.status, OPEN_TASK));
  const dueToday = await db
    .select()
    .from(tasks)
    .where(and(base, gte(tasks.due_at, now), lt(tasks.due_at, end)))
    .orderBy(asc(tasks.due_at));
  const overdue = await db.select().from(tasks).where(and(base, lt(tasks.due_at, now))).orderBy(asc(tasks.due_at)).limit(100);
  const since = new Date(now.getTime() - 24 * HOUR);
  const newAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        isNull(alerts.deleted_at), eq(alerts.owner_id, userId), ne(alerts.status, "resolved"),
        or(gte(alerts.created_at, since), and(isNotNull(alerts.escalated_at), gte(alerts.escalated_at, since))),
      ),
    )
    .orderBy(desc(alerts.created_at))
    .limit(100);
  const subscribed = await subscribedAlerts(db, userId, { since, limit: 50 });
  return {
    generated_at: now,
    due_today: await taskOuts(db, dueToday),
    overdue: await taskOuts(db, overdue),
    new_alerts: await alertOuts(db, newAlerts),
    subscribed_alerts: await alertOuts(db, subscribed),
  };
}

export type { SubscriptionIn };
