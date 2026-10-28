import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const STAGES = [
  "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
  "under_contract", "due_diligence", "closing", "closed", "dead", "nurture",
] as const;
// Ordered progression used for board columns, velocity and conversion.
export const ACTIVE_STAGES = STAGES.slice(0, 10) as unknown as readonly string[];
export const TERMINAL_STAGES = ["closed", "dead", "nurture"] as const;
export const DEAD_REASONS = [
  "price_gap", "owner_not_selling", "failed_buybox", "title_or_survey", "financing", "competition", "timing",
  "other",
] as const;
export const REACTIVATION_TYPES = [
  "time", "debt", "price", "ownership", "lease", "market", "development", "relationship", "manual",
] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const DEFAULT_STALL_DAYS = 14;

/** A pursuit of one property, moved through explicit stage gates (spec module 11). */
export const opportunities = pgTable(
  "opportunities",
  {
    ...entity(),
    title: varchar("title", { length: 255 }).notNull(),
    property_id: fk("property_id", () => properties.id),
    owner_id: fk("owner_id", () => users.id),
    stage: varchar("stage", { length: 30 }).notNull().$defaultFn(() => "sourced"),
    stage_entered_at: tz("stage_entered_at").notNull().$defaultFn(() => new Date()),
    // Contacts live in another module; plain UUID columns keep this table independent of its load order.
    primary_person_id: uuid("primary_person_id"),
    primary_organization_id: uuid("primary_organization_id"),
    priority: varchar("priority", { length: 10 }).notNull().$defaultFn(() => "normal"),
    source: varchar("source", { length: 80 }),
    next_action: varchar("next_action", { length: 300 }),
    next_action_at: tz("next_action_at"),

    // Research
    research_missing_fields: jsonb("research_missing_fields").$type<string[]>().notNull().$defaultFn(() => []),
    research_notes: text("research_notes"),
    // Underwriting summary (full underwriting is a later release)
    estimated_value: numericFloat("estimated_value", 16, 2),
    cap_rate: doublePrecision("cap_rate"),
    underwriting_notes: text("underwriting_notes"),
    // Negotiation / offer
    price_expectation: numericFloat("price_expectation", 16, 2),
    offer_price: numericFloat("offer_price", 16, 2),
    offer_sent_at: tz("offer_sent_at"),
    response_due_at: tz("response_due_at"),
    // Contract / DD / closing
    contract_executed_on: date("contract_executed_on", { mode: "string" }),
    dd_deadline: date("dd_deadline", { mode: "string" }),
    closing_date: date("closing_date", { mode: "string" }),
    closed_price: numericFloat("closed_price", 16, 2),
    closed_on: date("closed_on", { mode: "string" }),
    closed_snapshot: jsonb("closed_snapshot").$type<Record<string, any>>(),
    // Dead / nurture
    dead_reason: varchar("dead_reason", { length: 40 }),
    dead_notes: text("dead_notes"),
    price_gap: numericFloat("price_gap", 16, 2),
    reactivation_rule: jsonb("reactivation_rule").$type<Record<string, any>>(),
    dead_at: tz("dead_at"),
    next_touch_on: date("next_touch_on", { mode: "string" }),
    nurture_cadence_days: integer("nurture_cadence_days"),

    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_opportunities_deleted_at").on(t.deleted_at),
    index("ix_opportunities_property_id").on(t.property_id),
    index("ix_opportunities_owner_id").on(t.owner_id),
    index("ix_opportunities_stage").on(t.stage),
    index("ix_opportunities_stage_entered_at").on(t.stage_entered_at),
    index("ix_opportunities_primary_person_id").on(t.primary_person_id),
    index("ix_opportunities_primary_organization_id").on(t.primary_organization_id),
    index("ix_opportunities_priority").on(t.priority),
    index("ix_opportunities_source").on(t.source),
    index("ix_opportunities_next_action_at").on(t.next_action_at),
    index("ix_opportunities_dead_reason").on(t.dead_reason),
    index("ix_opportunities_next_touch_on").on(t.next_touch_on),
  ],
);
export type Opportunity = typeof opportunities.$inferSelect;

/** Immutable stage history: every movement, including overrides and the reason given. */
export const opportunityEvents = pgTable(
  "opportunity_events",
  {
    id: pk(),
    opportunity_id: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }).notNull(),
    from_stage: varchar("from_stage", { length: 30 }),
    to_stage: varchar("to_stage", { length: 30 }).notNull(),
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
    at: tz("at").notNull().$defaultFn(() => new Date()),
    override: boolean("override").notNull().$defaultFn(() => false),
    reason: text("reason"),
    unmet: jsonb("unmet").$type<any[]>().notNull().$defaultFn(() => []),
    snapshot: jsonb("snapshot").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [
    index("ix_opportunity_events_opportunity_id").on(t.opportunity_id),
    index("ix_opportunity_events_to_stage").on(t.to_stage),
    index("ix_opportunity_events_at").on(t.at),
  ],
);
export type OpportunityEvent = typeof opportunityEvents.$inferSelect;

/** Per-stage stall threshold (days). Missing rows fall back to DEFAULT_STALL_DAYS. */
export const pipelineStageSettings = pgTable("pipeline_stage_settings", {
  stage: varchar("stage", { length: 30 }).primaryKey(),
  stall_days: integer("stall_days").notNull().$defaultFn(() => DEFAULT_STALL_DAYS),
  updated_at: tz("updated_at").notNull().$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
  updated_by_id: fk("updated_by_id", () => users.id),
});
export type PipelineStageSetting = typeof pipelineStageSettings.$inferSelect;
