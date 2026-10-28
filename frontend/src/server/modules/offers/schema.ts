import {
  boolean, doublePrecision, index, integer, jsonb, pgTable, text, uuid, varchar, type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";

export const OFFER_STATUSES = [
  "draft", "pending_approval", "approved", "sent", "countered", "accepted", "rejected", "expired", "withdrawn",
];
export const OPEN_STATUSES = ["draft", "pending_approval", "approved", "sent", "countered"];
export const FINAL_STATUSES = ["accepted", "rejected", "expired", "withdrawn"];
export const ORIGINS = ["buyer", "seller"]; // buyer = our version; seller = counterparty counter recorded verbatim
export const STRUCTURES = ["all_cash", "conventional_financing", "assumption", "seller_financing", "joint_venture", "other"];
export const OUTCOMES = ["accepted", "countered", "rejected", "expired", "withdrawn"];

// Typed negotiable terms: copied between versions and compared in the term delta.
export const TERM_FIELDS: Record<string, string> = {
  price: "Price",
  structure: "Structure",
  earnest_money: "Earnest money",
  earnest_money_hard_days: "Earnest money goes hard (days)",
  feasibility_days: "Feasibility period (days)",
  closing_days: "Closing period (days)",
  extension_count: "Extensions",
  extension_days: "Days per extension",
  extension_cost: "Cost per extension",
  financing_contingency: "Financing contingency",
  financing_days: "Financing period (days)",
  title_survey_days: "Title / survey review (days)",
  title_survey_terms: "Title / survey terms",
  assignment_allowed: "Assignment permitted",
  assignment_terms: "Assignment terms",
  access_terms: "Access / inspection rights",
  exclusivity_days: "Exclusivity (days)",
  expiration_at: "Offer expiration",
  buyer_entity: "Buyer entity",
  seller_name: "Seller",
  other_terms: "Other terms",
};

/** One version of an offer. Sent / received versions are frozen; every counter is a new row (spec 15). */
export const offers = pgTable(
  "offers",
  {
    ...entity(),
    opportunity_id: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "restrict" }),
    property_id: fk("property_id", () => properties.id),
    // Underwriting lives in another module: plain UUID keeps this table independent of its load order.
    uw_model_id: uuid("uw_model_id").notNull(),
    uw_model_version: integer("uw_model_version"),
    model_price: numericFloat("model_price", 16, 2),
    model_outputs: jsonb("model_outputs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),

    // Version chain
    root_offer_id: uuid("root_offer_id"),
    parent_offer_id: fk("parent_offer_id", (): AnyPgColumn => offers.id),
    version: integer("version").notNull().$defaultFn(() => 1),
    is_latest: boolean("is_latest").notNull().$defaultFn(() => true),
    origin: varchar("origin", { length: 10 }).notNull().$defaultFn(() => "buyer"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),

    // Terms
    price: numericFloat("price", 16, 2).notNull(),
    structure: varchar("structure", { length: 30 }).notNull().$defaultFn(() => "all_cash"),
    earnest_money: numericFloat("earnest_money", 16, 2),
    earnest_money_hard_days: integer("earnest_money_hard_days"),
    feasibility_days: integer("feasibility_days"),
    closing_days: integer("closing_days"),
    extension_count: integer("extension_count"),
    extension_days: integer("extension_days"),
    extension_cost: numericFloat("extension_cost", 16, 2),
    financing_contingency: boolean("financing_contingency").notNull().$defaultFn(() => false),
    financing_days: integer("financing_days"),
    title_survey_days: integer("title_survey_days"),
    title_survey_terms: text("title_survey_terms"),
    assignment_allowed: boolean("assignment_allowed").notNull().$defaultFn(() => false),
    assignment_terms: text("assignment_terms"),
    access_terms: text("access_terms"),
    exclusivity_days: integer("exclusivity_days"),
    expiration_at: tz("expiration_at"),
    buyer_entity: varchar("buyer_entity", { length: 200 }),
    seller_name: varchar("seller_name", { length: 200 }),
    other_terms: text("other_terms"),
    notes: text("notes"),

    // Approval routing
    deviation_pct: doublePrecision("deviation_pct"),
    approval_required: boolean("approval_required").notNull().$defaultFn(() => false),
    approvals_required: integer("approvals_required").notNull().$defaultFn(() => 0),
    approval_reasons: jsonb("approval_reasons").$type<string[]>().notNull().$defaultFn(() => []),
    submission_no: integer("submission_no").notNull().$defaultFn(() => 0),
    submitted_at: tz("submitted_at"),
    submitted_by_id: fk("submitted_by_id", () => users.id),
    approved_at: tz("approved_at"),

    // Delivery and response clock
    loi_payload: jsonb("loi_payload").$type<Record<string, any> | null>(),
    sent_at: tz("sent_at"),
    sent_by_id: fk("sent_by_id", () => users.id),
    sent_to: varchar("sent_to", { length: 300 }),
    sent_via: varchar("sent_via", { length: 60 }),
    response_due_at: tz("response_due_at"),
    critical_date_id: uuid("critical_date_id"),
    follow_up_task_id: uuid("follow_up_task_id"),
    escalation_task_id: uuid("escalation_task_id"),

    // Outcome
    responded_at: tz("responded_at"),
    response_recorded_by_id: fk("response_recorded_by_id", () => users.id),
    response_note: text("response_note"),
    expired_at: tz("expired_at"),
    winning_price: numericFloat("winning_price", 16, 2),
    winning_buyer: varchar("winning_buyer", { length: 200 }),
    winning_price_source: varchar("winning_price_source", { length: 200 }),
    winning_price_recorded_at: tz("winning_price_recorded_at"),
    winning_price_recorded_by_id: fk("winning_price_recorded_by_id", () => users.id),

    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_offers_deleted_at").on(t.deleted_at),
    index("ix_offers_opportunity_id").on(t.opportunity_id),
    index("ix_offers_property_id").on(t.property_id),
    index("ix_offers_uw_model_id").on(t.uw_model_id),
    index("ix_offers_root_offer_id").on(t.root_offer_id),
    index("ix_offers_parent_offer_id").on(t.parent_offer_id),
    index("ix_offers_is_latest").on(t.is_latest),
    index("ix_offers_origin").on(t.origin),
    index("ix_offers_status").on(t.status),
    index("ix_offers_sent_at").on(t.sent_at),
    index("ix_offers_response_due_at").on(t.response_due_at),
  ],
);
export type Offer = typeof offers.$inferSelect;

/** Immutable, named and timestamped approval decision for one submission of one offer version. */
export const offerApprovals = pgTable(
  "offer_approvals",
  {
    id: pk(),
    offer_id: uuid("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
    submission_no: integer("submission_no").notNull().$defaultFn(() => 1),
    decision: varchar("decision", { length: 20 }).notNull(), // approved | rejected
    approver_id: uuid("approver_id").references(() => users.id, { onDelete: "set null" }),
    approver_name: varchar("approver_name", { length: 200 }),
    decided_at: tz("decided_at").notNull().$defaultFn(() => new Date()),
    note: text("note"),
    price: numericFloat("price", 16, 2),
    deviation_pct: doublePrecision("deviation_pct"),
    reasons: jsonb("reasons").$type<string[]>().notNull().$defaultFn(() => []),
  },
  (t) => [index("ix_offer_approvals_offer_id").on(t.offer_id)],
);
export type OfferApproval = typeof offerApprovals.$inferSelect;

/** Singleton (id = 1) approval routing thresholds. */
export const offerSettings = pgTable("offer_settings", {
  id: integer("id").primaryKey().$defaultFn(() => 1),
  // Any price above this needs approval.
  price_threshold: numericFloat("price_threshold", 16, 2).$defaultFn(() => 10_000_000),
  // Price above the approved model's purchase price by more than this % needs approval.
  deviation_threshold_pct: doublePrecision("deviation_threshold_pct").notNull().$defaultFn(() => 2.0),
  // ... and by more than this % needs two approvals.
  second_approval_deviation_pct: doublePrecision("second_approval_deviation_pct").notNull().$defaultFn(() => 5.0),
  // Structures that always route for approval.
  approval_structures: jsonb("approval_structures").$type<string[]>().notNull()
    .$defaultFn(() => ["assumption", "seller_financing", "joint_venture", "other"]),
  // Terms outside these bounds route for approval (deviation from house standard).
  max_feasibility_days: integer("max_feasibility_days").$defaultFn(() => 60),
  max_earnest_money_pct: doublePrecision("max_earnest_money_pct").$defaultFn(() => 5.0),
  require_approval_always: boolean("require_approval_always").notNull().$defaultFn(() => false),
  default_response_days: integer("default_response_days").notNull().$defaultFn(() => 3),
  updated_at: tz("updated_at").notNull().$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
  updated_by_id: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
});
export type OfferSettings = typeof offerSettings.$inferSelect;
