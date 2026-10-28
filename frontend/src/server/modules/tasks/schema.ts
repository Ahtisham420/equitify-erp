import { boolean, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TASK_TYPES = ["follow_up", "call", "research", "review", "approval", "due_diligence", "general"] as const;
export const ALERT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
// How an alert was worked: actioned = real work done; the others count as noise for fatigue monitoring.
export const ALERT_RESOLUTIONS = ["actioned", "not_actionable", "duplicate", "false_positive"] as const;
export const SUBSCRIPTION_CHANNELS = ["in_app", "email", "digest"] as const;

/** Owned unit of work. Automation-created tasks carry an idempotency key so re-runs never duplicate. */
export const tasks = pgTable(
  "tasks",
  {
    ...entity(),
    title: varchar("title", { length: 300 }).notNull(),
    description: text("description"),
    task_type: varchar("task_type", { length: 30 }).notNull().$defaultFn(() => "general"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    priority: varchar("priority", { length: 10 }).notNull().$defaultFn(() => "normal"),
    due_at: tz("due_at"),
    assignee_id: fk("assignee_id", () => users.id),
    // Polymorphic link back to the originating record (property, opportunity, person, ...).
    related_type: varchar("related_type", { length: 40 }),
    related_id: uuid("related_id"),
    related_label: varchar("related_label", { length: 300 }),
    source: varchar("source", { length: 80 }).notNull().$defaultFn(() => "manual"),
    depends_on: jsonb("depends_on").$type<string[]>().notNull().$defaultFn(() => []),
    idempotency_key: varchar("idempotency_key", { length: 200 }),
    completed_at: tz("completed_at"),
    completed_by_id: fk("completed_by_id", () => users.id),
    resolution_note: text("resolution_note"),
    escalation_level: integer("escalation_level").notNull().$defaultFn(() => 0),
    escalated_at: tz("escalated_at"),
  },
  (t) => [
    index("ix_tasks_deleted_at").on(t.deleted_at),
    index("ix_tasks_task_type").on(t.task_type),
    index("ix_tasks_status").on(t.status),
    index("ix_tasks_priority").on(t.priority),
    index("ix_tasks_due_at").on(t.due_at),
    index("ix_tasks_assignee_id").on(t.assignee_id),
    index("ix_tasks_related_type").on(t.related_type),
    index("ix_tasks_related_id").on(t.related_id),
    unique("uq_tasks_idempotency_key").on(t.idempotency_key),
  ],
);
export type Task = typeof tasks.$inferSelect;

/** Every alert has a reason, an owner and a resolution state. */
export const alerts = pgTable(
  "alerts",
  {
    ...entity(),
    title: varchar("title", { length: 300 }).notNull(),
    reason: text("reason").notNull(),
    severity: varchar("severity", { length: 10 }).notNull().$defaultFn(() => "medium"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    owner_id: fk("owner_id", () => users.id),
    related_type: varchar("related_type", { length: 40 }),
    related_id: uuid("related_id"),
    related_label: varchar("related_label", { length: 300 }),
    rule_key: varchar("rule_key", { length: 80 }),
    due_at: tz("due_at"),
    idempotency_key: varchar("idempotency_key", { length: 200 }),
    acknowledged_at: tz("acknowledged_at"),
    resolved_at: tz("resolved_at"),
    resolved_by_id: fk("resolved_by_id", () => users.id),
    resolution_note: text("resolution_note"),
    acknowledged_by_id: fk("acknowledged_by_id", () => users.id),
    resolution_kind: varchar("resolution_kind", { length: 20 }),
    escalation_level: integer("escalation_level").notNull().$defaultFn(() => 0),
    escalated_at: tz("escalated_at"),
  },
  (t) => [
    index("ix_alerts_deleted_at").on(t.deleted_at),
    index("ix_alerts_severity").on(t.severity),
    index("ix_alerts_status").on(t.status),
    index("ix_alerts_owner_id").on(t.owner_id),
    index("ix_alerts_related_type").on(t.related_type),
    index("ix_alerts_related_id").on(t.related_id),
    index("ix_alerts_rule_key").on(t.rule_key),
    index("ix_alerts_resolution_kind").on(t.resolution_kind),
    unique("uq_alerts_idempotency_key").on(t.idempotency_key),
  ],
);
export type Alert = typeof alerts.$inferSelect;

/** Registry of event-driven automations. Each one is individually configurable and disableable. */
export const automationRules = pgTable(
  "automation_rules",
  {
    ...entity(),
    key: varchar("key", { length: 80 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    event: varchar("event", { length: 80 }),
    enabled: boolean("enabled").notNull().$defaultFn(() => true),
    thresholds: jsonb("thresholds").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    last_run_at: tz("last_run_at"),
    run_count: integer("run_count").notNull().$defaultFn(() => 0),
    error_count: integer("error_count").notNull().$defaultFn(() => 0),
    last_error: text("last_error"),
  },
  (t) => [index("ix_automation_rules_deleted_at").on(t.deleted_at), unique("uq_automation_rules_key").on(t.key)],
);
export type AutomationRule = typeof automationRules.$inferSelect;

/** A user's standing interest in alerts matching territory / property type / tenant / owner / saved view. */
export const alertSubscriptions = pgTable(
  "alert_subscriptions",
  {
    ...entity(),
    subscriber_id: fk("subscriber_id", () => users.id, { notNull: true, onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    territory_id: uuid("territory_id"),
    property_types: varchar("property_types", { length: 40 }).array().notNull().$defaultFn(() => []),
    tenant: varchar("tenant", { length: 200 }),
    owner_id: fk("owner_id", () => users.id),
    saved_view_id: uuid("saved_view_id"),
    rule_keys: varchar("rule_keys", { length: 80 }).array().notNull().$defaultFn(() => []),
    min_severity: varchar("min_severity", { length: 10 }).notNull().$defaultFn(() => "low"),
    channel: varchar("channel", { length: 10 }).notNull().$defaultFn(() => "in_app"),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [
    index("ix_alert_subscriptions_deleted_at").on(t.deleted_at),
    index("ix_alert_subscriptions_subscriber_id").on(t.subscriber_id),
    index("ix_alert_subscriptions_territory_id").on(t.territory_id),
  ],
);
export type AlertSubscription = typeof alertSubscriptions.$inferSelect;
