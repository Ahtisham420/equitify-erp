import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";

export const TRIGGER_STATUSES = ["armed", "fired", "cancelled"] as const;
export const ITEM_STATUSES = ["pending", "snoozed", "reactivated", "dismissed"] as const;
// Backstop revisit interval by dead reason ("time triggers by dead reason").
export const REVISIT_DAYS_BY_REASON: Record<string, number> = {
  price_gap: 180, owner_not_selling: 365, failed_buybox: 365, title_or_survey: 180, financing: 120,
  competition: 270, timing: 180, other: 365,
};

/** A watch armed when an opportunity is marked dead; fires when its condition is met. */
export const reactivationTriggers = pgTable(
  "reactivation_triggers",
  {
    ...entity(),
    opportunity_id: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    trigger_type: varchar("trigger_type", { length: 20 }).notNull(),
    params: jsonb("params").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    origin: varchar("origin", { length: 20 }).notNull().$defaultFn(() => "rule"), // rule | dead_reason_backstop | rearm | manual
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "armed"),
    armed_at: tz("armed_at").notNull(),
    fire_on: date("fire_on", { mode: "string" }),
    fired_at: tz("fired_at"),
    last_checked_at: tz("last_checked_at"),
    check_count: integer("check_count").notNull().$defaultFn(() => 0),
    baseline: jsonb("baseline").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    dead_reason: varchar("dead_reason", { length: 40 }),
    cancelled_reason: text("cancelled_reason"),
  },
  (t) => [
    index("ix_reactivation_triggers_deleted_at").on(t.deleted_at),
    index("ix_reactivation_triggers_opportunity_id").on(t.opportunity_id),
    index("ix_reactivation_triggers_property_id").on(t.property_id),
    index("ix_reactivation_triggers_trigger_type").on(t.trigger_type),
    index("ix_reactivation_triggers_status").on(t.status),
    index("ix_reactivation_triggers_fire_on").on(t.fire_on),
  ],
);
export type ReactivationTrigger = typeof reactivationTriggers.$inferSelect;

/** Queue entry: a dead opportunity returning with its original context and what changed. */
export const reactivationItems = pgTable(
  "reactivation_items",
  {
    ...entity(),
    opportunity_id: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    trigger_id: fk("trigger_id", () => reactivationTriggers.id),
    trigger_type: varchar("trigger_type", { length: 20 }).notNull(),
    owner_id: fk("owner_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "pending"),
    fired_at: tz("fired_at").notNull(),
    what_changed: text("what_changed").notNull(),
    changes: jsonb("changes").$type<any[]>().notNull().$defaultFn(() => []),
    original_context: jsonb("original_context").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    score_before: doublePrecision("score_before"),
    score_after: doublePrecision("score_after"),
    snoozed_until: date("snoozed_until", { mode: "string" }),
    decided_by_id: uuid("decided_by_id").references(() => users.id, { onDelete: "set null" }),
    decided_at: tz("decided_at"),
    decision_reason: text("decision_reason"),
    reactivated_to_stage: varchar("reactivated_to_stage", { length: 30 }),
    converted: boolean("converted").notNull().$defaultFn(() => false),
    converted_at: tz("converted_at"),
    task_id: uuid("task_id"),
  },
  (t) => [
    index("ix_reactivation_items_deleted_at").on(t.deleted_at),
    index("ix_reactivation_items_opportunity_id").on(t.opportunity_id),
    index("ix_reactivation_items_property_id").on(t.property_id),
    index("ix_reactivation_items_trigger_id").on(t.trigger_id),
    index("ix_reactivation_items_trigger_type").on(t.trigger_type),
    index("ix_reactivation_items_owner_id").on(t.owner_id),
    index("ix_reactivation_items_status").on(t.status),
    index("ix_reactivation_items_fired_at").on(t.fired_at),
    index("ix_reactivation_items_snoozed_until").on(t.snoozed_until),
    index("ix_reactivation_items_converted").on(t.converted),
  ],
);
export type ReactivationItem = typeof reactivationItems.$inferSelect;
