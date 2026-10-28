import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { assets } from "../assets/schema";
import { users } from "../auth/schema";
import { organizations, people } from "../contacts/schema";
import { properties } from "../properties/schema";

export const STAGES = ["candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed", "withdrawn"];
export const PROGRESSION = ["candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed"];
export const TERMINAL = ["closed", "withdrawn"];
export const OFFER_STATUSES = ["received", "countered", "best_and_final", "accepted", "backup", "rejected", "withdrawn"];
export const OFFER_OUTCOMES = ["closed", "fell_through"];
export const FINANCING_TYPES = ["cash", "new_loan", "assumption", "seller_financing"];
export const RETRADE_REASONS = ["inspection", "environmental", "title_survey", "financing", "appraisal", "tenant", "market", "other"];
export const RETRADE_DECISIONS = ["pending", "accepted", "countered", "rejected"];
export const RETRADE_OUTCOMES = ["pending", "closed", "buyer_walked", "seller_terminated"];
export const EXCHANGE_TYPES = ["forward", "reverse", "improvement"];
export const EXCHANGE_STATUSES = ["planned", "open", "identified", "completed", "failed", "cancelled"];
export const IDENTIFICATION_RULES = ["three_property", "two_hundred_percent", "ninety_five_percent"];
export const CANDIDATE_STATUSES = ["candidate", "identified", "under_contract", "acquired", "dropped"];

export const dispositions = pgTable(
  "dispositions",
  {
    ...entity(),
    asset_id: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    stage: varchar("stage", { length: 20 }).notNull().$defaultFn(() => "candidate"),
    stage_entered_at: tz("stage_entered_at").notNull().$defaultFn(() => new Date()),
    owner_id: fk("owner_id", () => users.id),
    reason: text("reason"),
    is_1031: boolean("is_1031").notNull().$defaultFn(() => false),
    target_price: numericFloat("target_price", 16, 2),
    list_price: numericFloat("list_price", 16, 2),
    pricing_notes: text("pricing_notes"),
    broker_organization_id: fk("broker_organization_id", () => organizations.id),
    broker_name: varchar("broker_name", { length: 200 }),
    commission_pct: doublePrecision("commission_pct"),
    marketing_launched_on: date("marketing_launched_on", { mode: "string" }),
    offers_due_on: date("offers_due_on", { mode: "string" }),
    accepted_offer_id: uuid("accepted_offer_id"),
    buyer_organization_id: fk("buyer_organization_id", () => organizations.id),
    buyer_name: varchar("buyer_name", { length: 200 }),
    contract_price: numericFloat("contract_price", 16, 2),
    contract_executed_on: date("contract_executed_on", { mode: "string" }),
    dd_expires_on: date("dd_expires_on", { mode: "string" }),
    target_closing_on: date("target_closing_on", { mode: "string" }),
    closed_on: date("closed_on", { mode: "string" }),
    sale_price: numericFloat("sale_price", 16, 2),
    cost_lines: jsonb("cost_lines").$type<any[]>().notNull().$defaultFn(() => []), // [{label, amount}]
    tax_inputs: jsonb("tax_inputs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    comparison: jsonb("comparison").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    comparison_at: tz("comparison_at"),
    withdrawn_reason: text("withdrawn_reason"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_dispositions_deleted_at").on(t.deleted_at),
    index("ix_dispositions_asset_id").on(t.asset_id),
    index("ix_dispositions_property_id").on(t.property_id),
    index("ix_dispositions_stage").on(t.stage),
    index("ix_dispositions_owner_id").on(t.owner_id),
    index("ix_dispositions_is_1031").on(t.is_1031),
    index("ix_dispositions_broker_organization_id").on(t.broker_organization_id),
    index("ix_dispositions_buyer_organization_id").on(t.buyer_organization_id),
    index("ix_dispositions_target_closing_on").on(t.target_closing_on),
  ],
);
export type Disposition = typeof dispositions.$inferSelect;

export const dispositionEvents = pgTable(
  "disposition_events",
  {
    id: pk(),
    disposition_id: uuid("disposition_id").notNull().references(() => dispositions.id, { onDelete: "cascade" }),
    from_stage: varchar("from_stage", { length: 20 }),
    to_stage: varchar("to_stage", { length: 20 }).notNull(),
    at: tz("at").notNull().$defaultFn(() => new Date()),
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
    reason: text("reason"),
    override: boolean("override").notNull().$defaultFn(() => false),
    unmet: jsonb("unmet").$type<any[]>().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_disposition_events_disposition_id").on(t.disposition_id),
    index("ix_disposition_events_at").on(t.at),
  ],
);
export type DispositionEvent = typeof dispositionEvents.$inferSelect;

export const dispositionOffers = pgTable(
  "disposition_offers",
  {
    ...entity(),
    disposition_id: uuid("disposition_id").notNull().references(() => dispositions.id, { onDelete: "cascade" }),
    buyer_name: varchar("buyer_name", { length: 200 }).notNull(),
    buyer_organization_id: fk("buyer_organization_id", () => organizations.id),
    buyer_person_id: fk("buyer_person_id", () => people.id),
    broker_name: varchar("broker_name", { length: 200 }),
    price: numericFloat("price", 16, 2).notNull(),
    earnest_money: numericFloat("earnest_money", 16, 2),
    dd_days: integer("dd_days"),
    closing_days: integer("closing_days"),
    financing_type: varchar("financing_type", { length: 20 }).notNull().$defaultFn(() => "cash"),
    contingencies: text("contingencies"),
    received_on: date("received_on", { mode: "string" }).notNull(),
    expires_on: date("expires_on", { mode: "string" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "received"),
    outcome: varchar("outcome", { length: 20 }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_disposition_offers_deleted_at").on(t.deleted_at),
    index("ix_disposition_offers_disposition_id").on(t.disposition_id),
    index("ix_disposition_offers_buyer_name").on(t.buyer_name),
    index("ix_disposition_offers_buyer_organization_id").on(t.buyer_organization_id),
    index("ix_disposition_offers_buyer_person_id").on(t.buyer_person_id),
    index("ix_disposition_offers_status").on(t.status),
  ],
);
export type DispositionOffer = typeof dispositionOffers.$inferSelect;

/** Buyer retrade request — retained permanently for counterparty intelligence. */
export const retrades = pgTable(
  "retrades",
  {
    ...entity(),
    disposition_id: uuid("disposition_id").notNull().references(() => dispositions.id, { onDelete: "cascade" }),
    offer_id: fk("offer_id", () => dispositionOffers.id),
    buyer_organization_id: fk("buyer_organization_id", () => organizations.id),
    buyer_name: varchar("buyer_name", { length: 200 }).notNull(),
    requested_on: date("requested_on", { mode: "string" }).notNull(),
    reason_category: varchar("reason_category", { length: 20 }).notNull().$defaultFn(() => "other"),
    reason: text("reason").notNull(),
    amount_requested: numericFloat("amount_requested", 16, 2).notNull(),
    decision: varchar("decision", { length: 20 }).notNull().$defaultFn(() => "pending"),
    agreed_amount: numericFloat("agreed_amount", 16, 2),
    decided_on: date("decided_on", { mode: "string" }),
    decided_by_id: fk("decided_by_id", () => users.id),
    outcome: varchar("outcome", { length: 20 }).notNull().$defaultFn(() => "pending"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_retrades_deleted_at").on(t.deleted_at),
    index("ix_retrades_disposition_id").on(t.disposition_id),
    index("ix_retrades_offer_id").on(t.offer_id),
    index("ix_retrades_buyer_organization_id").on(t.buyer_organization_id),
    index("ix_retrades_buyer_name").on(t.buyer_name),
    index("ix_retrades_decision").on(t.decision),
  ],
);
export type Retrade = typeof retrades.$inferSelect;

export const exchanges1031 = pgTable(
  "exchanges_1031",
  {
    ...entity(),
    disposition_id: uuid("disposition_id").notNull().references(() => dispositions.id, { onDelete: "cascade" }),
    exchange_type: varchar("exchange_type", { length: 20 }).notNull().$defaultFn(() => "forward"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "planned"),
    qi_organization_id: fk("qi_organization_id", () => organizations.id),
    qi_name: varchar("qi_name", { length: 200 }),
    eat_organization_id: fk("eat_organization_id", () => organizations.id), // reverse/improvement titleholder
    parked_property_id: fk("parked_property_id", () => properties.id),
    start_on: date("start_on", { mode: "string" }), // relinquished closing (forward) or parking date (reverse)
    identification_deadline: date("identification_deadline", { mode: "string" }),
    replacement_deadline: date("replacement_deadline", { mode: "string" }),
    tax_return_due_on: date("tax_return_due_on", { mode: "string" }),
    identification_rule: varchar("identification_rule", { length: 30 }).notNull().$defaultFn(() => "three_property"),
    relinquished_sale_price: numericFloat("relinquished_sale_price", 16, 2),
    relinquished_costs: numericFloat("relinquished_costs", 16, 2),
    relinquished_debt_paid: numericFloat("relinquished_debt_paid", 16, 2),
    relinquished_adjusted_basis: numericFloat("relinquished_adjusted_basis", 16, 2),
    cash_received: numericFloat("cash_received", 16, 2),
    additional_cash_invested: numericFloat("additional_cash_invested", 16, 2),
    improvement_budget: numericFloat("improvement_budget", 16, 2),
    improvement_notes: text("improvement_notes"),
    id_critical_date_id: uuid("id_critical_date_id"),
    replacement_critical_date_id: uuid("replacement_critical_date_id"),
    notes: text("notes"),
  },
  (t) => [
    unique("uq_exchanges_1031_disposition").on(t.disposition_id),
    index("ix_exchanges_1031_deleted_at").on(t.deleted_at),
    index("ix_exchanges_1031_disposition_id").on(t.disposition_id),
    index("ix_exchanges_1031_status").on(t.status),
    index("ix_exchanges_1031_qi_organization_id").on(t.qi_organization_id),
    index("ix_exchanges_1031_eat_organization_id").on(t.eat_organization_id),
    index("ix_exchanges_1031_parked_property_id").on(t.parked_property_id),
    index("ix_exchanges_1031_identification_deadline").on(t.identification_deadline),
    index("ix_exchanges_1031_replacement_deadline").on(t.replacement_deadline),
  ],
);
export type Exchange1031 = typeof exchanges1031.$inferSelect;

export const exchangeCandidates = pgTable(
  "exchange_candidates",
  {
    ...entity(),
    exchange_id: uuid("exchange_id").notNull().references(() => exchanges1031.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    description: varchar("description", { length: 300 }),
    is_backup: boolean("is_backup").notNull().$defaultFn(() => false),
    rank: integer("rank").notNull().$defaultFn(() => 1),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "candidate"),
    identified_on: date("identified_on", { mode: "string" }),
    expected_price: numericFloat("expected_price", 16, 2),
    expected_debt: numericFloat("expected_debt", 16, 2),
    acquired_on: date("acquired_on", { mode: "string" }),
    acquired_price: numericFloat("acquired_price", 16, 2),
    acquired_debt: numericFloat("acquired_debt", 16, 2),
    notes: text("notes"),
  },
  (t) => [
    index("ix_exchange_candidates_deleted_at").on(t.deleted_at),
    index("ix_exchange_candidates_exchange_id").on(t.exchange_id),
    index("ix_exchange_candidates_property_id").on(t.property_id),
    index("ix_exchange_candidates_status").on(t.status),
  ],
);
export type ExchangeCandidate = typeof exchangeCandidates.$inferSelect;
