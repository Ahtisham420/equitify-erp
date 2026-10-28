import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { users } from "../auth/schema";

export const COMPONENTS = [
  "economics", "location", "motivation", "transaction_probability", "relationship", "negative_risk",
] as const;
export const COMPONENT_LABELS: Record<string, string> = {
  economics: "Economics / pricing gap",
  location: "Location / growth",
  motivation: "Owner motivation",
  transaction_probability: "Transaction probability",
  relationship: "Relationship strength",
  negative_risk: "Negative risk",
};
// Value components are weighted averages; negative risk is a penalty weight (score points per risk point).
export const DEFAULT_WEIGHTS: Record<string, number> = {
  economics: 0.25, location: 0.15, motivation: 0.25, transaction_probability: 0.2,
  relationship: 0.15, negative_risk: 0.2,
};
export const DEFAULT_BANDS: Record<string, number> = { high: 0.75, medium: 0.5 };
export const BANDS = ["high", "medium", "low"] as const;
export const CONFIG_STATUSES = ["draft", "proposed", "active", "retired", "rejected"] as const;
export const OUTCOME_RESULTS = ["open", "won", "lost"] as const;

/** Versioned weight configuration. Only one is active; prior versions are retained (never overwritten). */
export const scoreConfigs = pgTable(
  "score_configs",
  {
    ...entity(),
    version: integer("version").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    weights: jsonb("weights").$type<Record<string, number>>().notNull().$defaultFn(() => ({})),
    band_thresholds: jsonb("band_thresholds").$type<Record<string, number>>().notNull().$defaultFn(() => ({})),
    alert_threshold: doublePrecision("alert_threshold").notNull().$defaultFn(() => 75),
    high_dollar_threshold: numericFloat("high_dollar_threshold", 16, 2).notNull().$defaultFn(() => 5_000_000),
    notes: text("notes"),
    source: varchar("source", { length: 20 }).notNull().$defaultFn(() => "manual"), // manual | recalibration | default
    basis: jsonb("basis").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    based_on_version: integer("based_on_version"),
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    activated_at: tz("activated_at"),
    retired_at: tz("retired_at"),
    rejected_reason: text("rejected_reason"),
  },
  (t) => [
    unique("uq_score_configs_version").on(t.version),
    index("ix_score_configs_deleted_at").on(t.deleted_at),
    index("ix_score_configs_status").on(t.status),
  ],
);
export type ScoreConfig = typeof scoreConfigs.$inferSelect;

/** One computed score. History is every row; `is_current` marks the latest for a property. */
export const opportunityScores = pgTable(
  "opportunity_scores",
  {
    id: pk(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    score: doublePrecision("score").notNull(), // value score 0-100
    confidence: doublePrecision("confidence").notNull(), // certainty 0-1, kept separate from value
    adjusted_score: doublePrecision("adjusted_score").notNull(), // score x confidence, for reference only
    band: varchar("band", { length: 10 }).notNull(),
    components: jsonb("components").$type<any[]>().notNull().$defaultFn(() => []),
    confidence_factors: jsonb("confidence_factors").$type<any[]>().notNull().$defaultFn(() => []),
    drivers: jsonb("drivers").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    eligibility: jsonb("eligibility").$type<any[]>().notNull().$defaultFn(() => []),
    config_id: uuid("config_id"),
    config_version: integer("config_version").notNull(),
    needs_research: boolean("needs_research").notNull().$defaultFn(() => false),
    requires_human_approval: boolean("requires_human_approval").notNull().$defaultFn(() => true),
    value_basis: numericFloat("value_basis", 16, 2),
    signature: varchar("signature", { length: 64 }).notNull(),
    trigger: varchar("trigger", { length: 40 }).notNull().$defaultFn(() => "manual"),
    computed_at: tz("computed_at").notNull().$defaultFn(() => new Date()),
    computed_by_id: fk("computed_by_id", () => users.id),
    is_current: boolean("is_current").notNull().$defaultFn(() => true),
  },
  (t) => [
    index("ix_opportunity_scores_property_id").on(t.property_id),
    index("ix_opportunity_scores_score").on(t.score),
    index("ix_opportunity_scores_band").on(t.band),
    index("ix_opportunity_scores_needs_research").on(t.needs_research),
    index("ix_opportunity_scores_computed_at").on(t.computed_at),
    index("ix_opportunity_scores_is_current").on(t.is_current),
  ],
);
export type OpportunityScore = typeof opportunityScores.$inferSelect;

/** Decision log used to measure and recalibrate the model: disposition, score at decision, result, time. */
export const scoreOutcomes = pgTable(
  "score_outcomes",
  {
    ...entity(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    opportunity_id: fk("opportunity_id", () => opportunities.id),
    disposition: varchar("disposition", { length: 40 }).notNull(),
    decided_at: tz("decided_at").notNull().$defaultFn(() => new Date()),
    score_at_decision: doublePrecision("score_at_decision"),
    confidence_at_decision: doublePrecision("confidence_at_decision"),
    band_at_decision: varchar("band_at_decision", { length: 10 }),
    config_version: integer("config_version"),
    components_at_decision: jsonb("components_at_decision").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    result: varchar("result", { length: 10 }).notNull().$defaultFn(() => "open"),
    result_at: tz("result_at"),
    elapsed_days: doublePrecision("elapsed_days"),
    source: varchar("source", { length: 10 }).notNull().$defaultFn(() => "event"), // event | manual
    notes: text("notes"),
  },
  (t) => [
    index("ix_score_outcomes_deleted_at").on(t.deleted_at),
    index("ix_score_outcomes_property_id").on(t.property_id),
    index("ix_score_outcomes_opportunity_id").on(t.opportunity_id),
    index("ix_score_outcomes_disposition").on(t.disposition),
    index("ix_score_outcomes_decided_at").on(t.decided_at),
    index("ix_score_outcomes_result").on(t.result),
  ],
);
export type ScoreOutcome = typeof scoreOutcomes.$inferSelect;
