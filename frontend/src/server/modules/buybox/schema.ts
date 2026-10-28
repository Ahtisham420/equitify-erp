import { boolean, date, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const OPERATORS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "contains", "is_set"] as const;
export const REQUIREMENTS = ["mandatory", "preferred", "disqualifying"] as const;
export const RESULTS = ["pass", "pass_with_exception", "fail", "insufficient_data"] as const;
export const EXCEPTION_STATES = ["none", "requested", "approved", "rejected"] as const;
export const STRATEGY_SUGGESTIONS = [
  "stnl", "multi_tenant_retail", "core", "core_plus", "value_add", "opportunistic", "development", "land",
  "ground_lease", "other",
] as const;

/** A named investment strategy gate. Criteria edits bump `version`; every version is snapshotted. */
export const buyBoxes = pgTable(
  "buy_boxes",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    strategy: varchar("strategy", { length: 60 }).notNull().$defaultFn(() => "other"),
    owner_id: fk("owner_id", () => users.id),
    active_from: date("active_from", { mode: "string" }),
    active_to: date("active_to", { mode: "string" }),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    version: integer("version").notNull().$defaultFn(() => 1),
  },
  (t) => [
    index("ix_buy_boxes_deleted_at").on(t.deleted_at),
    index("ix_buy_boxes_strategy").on(t.strategy),
    index("ix_buy_boxes_owner_id").on(t.owner_id),
    index("ix_buy_boxes_is_active").on(t.is_active),
  ],
);
export type BuyBox = typeof buyBoxes.$inferSelect;

/** One rule of the current version. Prior versions live in `buybox_versions.criteria`. */
export const buyboxCriteria = pgTable(
  "buybox_criteria",
  {
    ...entity(),
    buy_box_id: uuid("buy_box_id").notNull().references(() => buyBoxes.id, { onDelete: "cascade" }),
    field: varchar("field", { length: 60 }).notNull(),
    operator: varchar("operator", { length: 20 }).notNull(),
    value: jsonb("value").$type<any>(),
    requirement: varchar("requirement", { length: 20 }).notNull().$defaultFn(() => "mandatory"),
    note: varchar("note", { length: 300 }),
    position: integer("position").notNull().$defaultFn(() => 0),
  },
  (t) => [
    index("ix_buybox_criteria_deleted_at").on(t.deleted_at),
    index("ix_buybox_criteria_buy_box_id").on(t.buy_box_id),
  ],
);
export type BuyboxCriterion = typeof buyboxCriteria.$inferSelect;

/** Immutable snapshot of a buy box's criteria at a given version. */
export const buyboxVersions = pgTable(
  "buybox_versions",
  {
    id: pk(),
    buy_box_id: uuid("buy_box_id").notNull().references(() => buyBoxes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    criteria: jsonb("criteria").$type<any[]>().notNull().$defaultFn(() => []),
    change_note: text("change_note"),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    created_by_id: fk("created_by_id", () => users.id),
  },
  (t) => [
    unique("uq_buybox_versions_box_version").on(t.buy_box_id, t.version),
    index("ix_buybox_versions_buy_box_id").on(t.buy_box_id),
  ],
);
export type BuyboxVersion = typeof buyboxVersions.$inferSelect;

/** One evaluation of one property against one buy box version. Older rows are kept (is_current=False). */
export const buyboxEvaluations = pgTable(
  "buybox_evaluations",
  {
    ...entity(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buy_box_id: uuid("buy_box_id").notNull().references(() => buyBoxes.id, { onDelete: "cascade" }),
    buy_box_version: integer("buy_box_version").notNull(),
    result: varchar("result", { length: 30 }).notNull(),
    raw_result: varchar("raw_result", { length: 30 }).notNull(), // engine result before any approved exception
    missing_fields: jsonb("missing_fields").$type<string[]>().notNull().$defaultFn(() => []),
    details: jsonb("details").$type<any[]>().notNull().$defaultFn(() => []),
    preferred_misses: jsonb("preferred_misses").$type<any[]>().notNull().$defaultFn(() => []),
    signature: varchar("signature", { length: 64 }).notNull(),
    evaluated_at: tz("evaluated_at").notNull().$defaultFn(() => new Date()),
    is_current: boolean("is_current").notNull().$defaultFn(() => true),
    trigger: varchar("trigger", { length: 30 }).notNull().$defaultFn(() => "manual"),

    exception_status: varchar("exception_status", { length: 20 }).notNull().$defaultFn(() => "none"),
    exception_requested_by_id: fk("exception_requested_by_id", () => users.id),
    exception_requested_at: tz("exception_requested_at"),
    exception_request_reason: text("exception_request_reason"),
    exception_approver_id: fk("exception_approver_id", () => users.id),
    exception_decided_at: tz("exception_decided_at"),
    exception_decision_reason: text("exception_decision_reason"),
  },
  (t) => [
    index("ix_buybox_evaluations_deleted_at").on(t.deleted_at),
    index("ix_buybox_evaluations_property_id").on(t.property_id),
    index("ix_buybox_evaluations_buy_box_id").on(t.buy_box_id),
    index("ix_buybox_evaluations_result").on(t.result),
    index("ix_buybox_evaluations_evaluated_at").on(t.evaluated_at),
    index("ix_buybox_evaluations_is_current").on(t.is_current),
    index("ix_buybox_evaluations_exception_status").on(t.exception_status),
  ],
);
export type BuyboxEvaluation = typeof buyboxEvaluations.$inferSelect;
