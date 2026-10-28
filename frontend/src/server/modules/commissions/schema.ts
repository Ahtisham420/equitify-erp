import { boolean, date, doublePrecision, index, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { teams, users } from "../auth/schema";
import { properties } from "../properties/schema";

export const COMMISSION_STATUSES = ["forecast", "earned", "invoiced", "paid", "cancelled"] as const;
export const OPEN_STATUSES = ["forecast", "earned", "invoiced"] as const;
export const EARNED_STATUSES = ["earned", "invoiced", "paid"] as const;
export const SIDES = ["listing", "buyer", "tenant", "landlord", "dual", "other"] as const;
export const SPLIT_ROLES = ["primary", "co_agent", "referral", "house"] as const;
export const INVOICE_STATUSES = ["issued", "paid", "void"] as const;
export const RECONCILIATION_STATES = ["unpaid", "matched", "short", "over"] as const;
// brokerage_deals.stage values treated as a closed / lost transaction (brokerage module owns the list).
export const CLOSED_STAGES = new Set(["closed", "closed_won", "won", "completed"]);
export const LOST_STAGES = new Set(["dead", "lost", "closed_lost", "cancelled", "canceled", "withdrawn"]);

/** Graduated agent split plan keyed on agent YTD GCI, with an optional annual company-dollar cap. */
export const splitPlans = pgTable(
  "commission_split_plans",
  {
    ...entity(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    // [{min_ytd_gci: 0, agent_pct: 60}, {min_ytd_gci: 250000, agent_pct: 70}, ...]
    tiers: jsonb("tiers").$type<any[]>().notNull().$defaultFn(() => []),
    annual_cap: numericFloat("annual_cap", 16, 2), // max house share per agent-year
    is_default: boolean("is_default").notNull().$defaultFn(() => false),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [index("ix_commission_split_plans_deleted_at").on(t.deleted_at)],
);

export const agentPlans = pgTable(
  "commission_agent_plans",
  {
    ...entity(),
    agent_id: uuid("agent_id").notNull().references(() => users.id),
    plan_id: uuid("plan_id").notNull().references(() => splitPlans.id),
    effective_from: date("effective_from", { mode: "string" }),
  },
  (t) => [
    index("ix_commission_agent_plans_deleted_at").on(t.deleted_at),
    uniqueIndex("ix_commission_agent_plans_agent_id").on(t.agent_id),
    index("ix_commission_agent_plans_plan_id").on(t.plan_id),
  ],
);

/** Commission on one brokerage transaction: forecast -> earned -> invoiced -> paid. */
export const commissions = pgTable(
  "commissions",
  {
    ...entity(),
    // Brokerage module is loaded independently; plain UUID keeps this table independent of load order.
    brokerage_deal_id: uuid("brokerage_deal_id"),
    title: varchar("title", { length: 255 }).notNull(),
    agent_id: fk("agent_id", () => users.id),
    team_id: fk("team_id", () => teams.id),
    property_id: fk("property_id", () => properties.id),
    property_type: varchar("property_type", { length: 40 }),
    source: varchar("source", { length: 80 }),
    side: varchar("side", { length: 20 }),
    deal_volume: numericFloat("deal_volume", 16, 2),
    gross: numericFloat("gross", 16, 2).notNull().$defaultFn(() => 0),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "forecast"),
    probability: doublePrecision("probability"), // percent 0-100
    expected_close_on: date("expected_close_on", { mode: "string" }),
    expected_on: date("expected_on", { mode: "string" }), // expected payment date
    earned_on: date("earned_on", { mode: "string" }),
    paid_on: date("paid_on", { mode: "string" }),
    split_plan_id: fk("split_plan_id", () => splitPlans.id),
    // [{agent_id, share_pct, override_agent_pct}] - share of net GCI after referral
    participants: jsonb("participants").$type<any[]>().notNull().$defaultFn(() => []),
    referral_party: varchar("referral_party", { length: 200 }),
    referral_pct: doublePrecision("referral_pct"),
    referral_amount: numericFloat("referral_amount", 16, 2),
    // [{label, amount, agent_id}]
    deductions: jsonb("deductions").$type<any[]>().notNull().$defaultFn(() => []),
    house_amount: numericFloat("house_amount", 16, 2).notNull().$defaultFn(() => 0),
    agent_net_total: numericFloat("agent_net_total", 16, 2).notNull().$defaultFn(() => 0),
    calc: jsonb("calc").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    paid_total: numericFloat("paid_total", 16, 2).notNull().$defaultFn(() => 0),
    discrepancy: numericFloat("discrepancy", 16, 2).notNull().$defaultFn(() => 0),
    reconciliation_status: varchar("reconciliation_status", { length: 20 }).notNull().$defaultFn(() => "unpaid"),
    released_by_id: fk("released_by_id", () => users.id),
    released_at: tz("released_at"),
    release_note: text("release_note"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_commissions_deleted_at").on(t.deleted_at),
    index("ix_commissions_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_commissions_agent_id").on(t.agent_id),
    index("ix_commissions_team_id").on(t.team_id),
    index("ix_commissions_property_id").on(t.property_id),
    index("ix_commissions_property_type").on(t.property_type),
    index("ix_commissions_source").on(t.source),
    index("ix_commissions_side").on(t.side),
    index("ix_commissions_status").on(t.status),
    index("ix_commissions_expected_close_on").on(t.expected_close_on),
    index("ix_commissions_expected_on").on(t.expected_on),
    index("ix_commissions_earned_on").on(t.earned_on),
    index("ix_commissions_paid_on").on(t.paid_on),
    index("ix_commissions_split_plan_id").on(t.split_plan_id),
    index("ix_commissions_reconciliation_status").on(t.reconciliation_status),
  ],
);

/** Current split lines of a commission (prior versions are kept in commission_events snapshots). */
export const commissionSplits = pgTable(
  "commission_splits",
  {
    ...entity(),
    commission_id: uuid("commission_id").notNull().references(() => commissions.id),
    agent_id: fk("agent_id", () => users.id),
    role: varchar("role", { length: 20 }).notNull(),
    label: varchar("label", { length: 200 }),
    share_pct: doublePrecision("share_pct"),
    gci_amount: numericFloat("gci_amount", 16, 2).notNull().$defaultFn(() => 0),
    agent_pct: doublePrecision("agent_pct"),
    amount: numericFloat("amount", 16, 2).notNull().$defaultFn(() => 0),
    deductions: numericFloat("deductions", 16, 2).notNull().$defaultFn(() => 0),
    net_amount: numericFloat("net_amount", 16, 2).notNull().$defaultFn(() => 0),
    ytd_gci_before: numericFloat("ytd_gci_before", 16, 2),
    capped: boolean("capped").notNull().$defaultFn(() => false),
    detail: jsonb("detail").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [
    index("ix_commission_splits_deleted_at").on(t.deleted_at),
    index("ix_commission_splits_commission_id").on(t.commission_id),
    index("ix_commission_splits_agent_id").on(t.agent_id),
  ],
);

export const commissionInvoices = pgTable(
  "commission_invoices",
  {
    ...entity(),
    commission_id: uuid("commission_id").notNull().references(() => commissions.id),
    invoice_number: varchar("invoice_number", { length: 40 }).notNull(),
    bill_to: varchar("bill_to", { length: 300 }).notNull(),
    issued_on: date("issued_on", { mode: "string" }).notNull(),
    due_on: date("due_on", { mode: "string" }).notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "issued"),
    rendered_text: text("rendered_text").notNull(),
    void_reason: text("void_reason"),
  },
  (t) => [
    index("ix_commission_invoices_deleted_at").on(t.deleted_at),
    index("ix_commission_invoices_commission_id").on(t.commission_id),
    uniqueIndex("ix_commission_invoices_invoice_number").on(t.invoice_number),
    index("ix_commission_invoices_due_on").on(t.due_on),
    index("ix_commission_invoices_status").on(t.status),
  ],
);

export const commissionPayments = pgTable(
  "commission_payments",
  {
    ...entity(),
    commission_id: uuid("commission_id").notNull().references(() => commissions.id),
    invoice_id: fk("invoice_id", () => commissionInvoices.id),
    amount: numericFloat("amount", 16, 2).notNull(),
    received_on: date("received_on", { mode: "string" }).notNull(),
    reference: varchar("reference", { length: 120 }),
    method: varchar("method", { length: 40 }),
    note: text("note"),
  },
  (t) => [
    index("ix_commission_payments_deleted_at").on(t.deleted_at),
    index("ix_commission_payments_commission_id").on(t.commission_id),
    index("ix_commission_payments_invoice_id").on(t.invoice_id),
    index("ix_commission_payments_received_on").on(t.received_on),
  ],
);

/** Immutable history: status changes, recalculations (with the prior calc), approvals, payments. */
export const commissionEvents = pgTable(
  "commission_events",
  {
    id: pk(),
    commission_id: uuid("commission_id").notNull().references(() => commissions.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 40 }).notNull(),
    from_status: varchar("from_status", { length: 20 }),
    to_status: varchar("to_status", { length: 20 }),
    at: tz("at").notNull().$defaultFn(() => new Date()),
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
    note: text("note"),
    snapshot: jsonb("snapshot").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [
    index("ix_commission_events_commission_id").on(t.commission_id),
    index("ix_commission_events_at").on(t.at),
  ],
);

/** Monthly frozen copy of the weighted forecast, compared to actual collections for accuracy. */
export const forecastSnapshots = pgTable(
  "commission_forecast_snapshots",
  {
    id: pk(),
    snapshot_month: date("snapshot_month", { mode: "string" }).notNull(), // first day of month
    taken_at: tz("taken_at").notNull().$defaultFn(() => new Date()),
    taken_by_id: fk("taken_by_id", () => users.id),
    buckets: jsonb("buckets").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // {"YYYY-MM": {weighted, unweighted, count}}
    by_agent: jsonb("by_agent").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // {agent_id: {"YYYY-MM": weighted}}
    total_weighted: numericFloat("total_weighted", 16, 2).notNull().$defaultFn(() => 0),
  },
  (t) => [uniqueIndex("ix_commission_forecast_snapshots_snapshot_month").on(t.snapshot_month)],
);

export type SplitPlan = typeof splitPlans.$inferSelect;
export type AgentPlan = typeof agentPlans.$inferSelect;
export type Commission = typeof commissions.$inferSelect;
export type CommissionSplit = typeof commissionSplits.$inferSelect;
export type CommissionInvoice = typeof commissionInvoices.$inferSelect;
export type CommissionPayment = typeof commissionPayments.$inferSelect;
export type CommissionEvent = typeof commissionEvents.$inferSelect;
export type ForecastSnapshot = typeof forecastSnapshots.$inferSelect;
