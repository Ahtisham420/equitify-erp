import { boolean, index, integer, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const UW_STATUSES = ["draft", "submitted", "approved", "rejected", "superseded"] as const;

/**
 * One version of an underwriting model (spec module 12).
 *
 * Versions of the same model share `root_id`. Approved versions are locked; any edit to a non-draft version
 * creates a new draft version, so prior versions are never destroyed.
 */
export const uwModels = pgTable(
  "uw_models",
  {
    ...entity(),

    root_id: uuid("root_id"),
    parent_id: uuid("parent_id"),
    property_id: fk("property_id", () => properties.id),
    opportunity_id: uuid("opportunity_id"),
    comp_set_id: uuid("comp_set_id"),
    version: integer("version").notNull().$defaultFn(() => 1),
    is_latest: boolean("is_latest").notNull().$defaultFn(() => true),
    name: varchar("name", { length: 200 }).notNull(),
    template: varchar("template", { length: 40 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    is_locked: boolean("is_locked").notNull().$defaultFn(() => false),
    change_note: text("change_note"),

    assumptions: jsonb("assumptions").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    scenarios: jsonb("scenarios").$type<Array<Record<string, any>>>().notNull().$defaultFn(() => []), // [{key, name, kind, overrides, outputs}]
    outputs: jsonb("outputs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    annual: jsonb("annual").$type<Array<Record<string, any>>>().notNull().$defaultFn(() => []),
    warnings: jsonb("warnings").$type<string[]>().notNull().$defaultFn(() => []),
    unsourced: jsonb("unsourced").$type<Array<Record<string, any>>>().notNull().$defaultFn(() => []),
    simulation: jsonb("simulation").$type<Record<string, any>>(),
    calculated_at: tz("calculated_at"),

    submitted_by_id: fk("submitted_by_id", () => users.id),
    submitted_at: tz("submitted_at"),
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    rejected_by_id: fk("rejected_by_id", () => users.id),
    rejected_at: tz("rejected_at"),
    decision_note: text("decision_note"),
  },
  (t) => [
    index("ix_uw_models_deleted_at").on(t.deleted_at),
    index("ix_uw_models_root_id").on(t.root_id),
    index("ix_uw_models_parent_id").on(t.parent_id),
    index("ix_uw_models_property_id").on(t.property_id),
    index("ix_uw_models_opportunity_id").on(t.opportunity_id),
    index("ix_uw_models_comp_set_id").on(t.comp_set_id),
    index("ix_uw_models_is_latest").on(t.is_latest),
    index("ix_uw_models_template").on(t.template),
    index("ix_uw_models_status").on(t.status),
  ],
);
export type UwModel = typeof uwModels.$inferSelect;

/** Immutable approval / version history for underwriting models. */
export const uwModelEvents = pgTable(
  "uw_model_events",
  {
    id: pk(),
    model_id: uuid("model_id").notNull().references(() => uwModels.id, { onDelete: "cascade" }),
    root_id: uuid("root_id"),
    action: varchar("action", { length: 30 }).notNull(), // created|versioned|submitted|approved|rejected|superseded
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
    at: tz("at").notNull().$defaultFn(() => new Date()),
    note: text("note"),
    details: jsonb("details").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [
    index("ix_uw_model_events_model_id").on(t.model_id),
    index("ix_uw_model_events_root_id").on(t.root_id),
    index("ix_uw_model_events_at").on(t.at),
  ],
);
export type UwModelEvent = typeof uwModelEvents.$inferSelect;
