import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar, type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { assets } from "../assets/schema";
import { organizations } from "../contacts/schema";
import { properties } from "../properties/schema";

// NOT NULL ON DELETE CASCADE foreign key (typed as non-nullable, unlike the generic fk() helper)
const fkReq = (column: string, ref: () => AnyPgColumn) => uuid(column).notNull().references(ref, { onDelete: "cascade" });

export const LOAN_STATUSES = ["active", "paid_off", "defeased", "refinanced", "default"] as const;
export const LOAN_TYPES = [
  "senior", "mezzanine", "bridge", "construction", "cmbs", "agency", "bank", "life_company", "seller_financing", "other",
] as const;
export const RATE_TYPES = ["fixed", "floating"] as const;
export const RECOURSE_TYPES = ["non_recourse", "partial", "full"] as const;
export const PREPAYMENT_TYPES = ["none", "open", "lockout", "yield_maintenance", "defeasance", "step_down"] as const;
export const COVENANT_KINDS = ["dscr", "debt_yield", "ltv", "occupancy", "net_worth"] as const;
export const FREQUENCIES = ["monthly", "quarterly", "semiannual", "annual"] as const;
export const FREQ_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
export const TEST_STATES = ["pass", "watch", "breach", "insufficient_data"] as const;
// Worst-first ordering used for the denormalised loan covenant_state.
export const COVENANT_STATE_RANK: Record<string, number> = {
  breach: 4, projected_breach: 3, watch: 2, pass: 1, insufficient_data: 0, none: -1,
};
export const RESERVE_TYPES = ["tax", "insurance", "replacement", "ti_lc", "interest", "capex", "debt_service", "other"] as const;
export const RESERVE_TXN_KINDS = ["deposit", "release", "adjustment"] as const;
export const REPORT_TYPES = [
  "financial_statements", "operating_statement", "rent_roll", "compliance_certificate", "budget",
  "insurance_certificate", "tax_returns", "other",
] as const;
export const EVENT_TYPES = [
  "created", "balance_change", "rate_change", "modification", "status_change", "payoff", "extension", "collateral_change",
] as const;
export const MATERIAL_FIELDS = new Set([
  "current_balance", "rate", "spread", "maturity_on", "status", "index_name", "amortization_months", "io_months",
  "cap_expires_on", "cap_strike", "prepayment", "recourse", "guarantors",
]);

export const loans = pgTable(
  "loans",
  {
    ...entity(),
    name: varchar("name", { length: 200 }),
    loan_number: varchar("loan_number", { length: 80 }),
    property_id: fk("property_id", () => properties.id),
    asset_id: fk("asset_id", () => assets.id),
    lender_organization_id: fk("lender_organization_id", () => organizations.id),
    lender_name: varchar("lender_name", { length: 200 }),
    loan_type: varchar("loan_type", { length: 30 }).notNull().$defaultFn(() => "senior"),
    original_balance: numericFloat("original_balance", 16, 2),
    current_balance: numericFloat("current_balance", 16, 2),
    originated_on: date("originated_on", { mode: "string" }),
    maturity_on: date("maturity_on", { mode: "string" }),
    extension_options: jsonb("extension_options").$type<Array<Record<string, any>>>().notNull().$defaultFn(() => []), // [{months, fee_pct, conditions}]
    rate_type: varchar("rate_type", { length: 10 }).notNull().$defaultFn(() => "fixed"),
    rate: doublePrecision("rate"), // current all-in rate %
    index_name: varchar("index_name", { length: 40 }),
    spread: doublePrecision("spread"),
    rate_floor: doublePrecision("rate_floor"),
    amortization_months: integer("amortization_months"),
    io_months: integer("io_months"),
    recourse: varchar("recourse", { length: 20 }).notNull().$defaultFn(() => "non_recourse"),
    recourse_notes: text("recourse_notes"),
    // [{kind: person|organization, person_id, organization_id, name, guaranty_type, limit_amount}]
    guarantors: jsonb("guarantors").$type<Array<Record<string, any>>>().notNull().$defaultFn(() => []),
    prepayment: jsonb("prepayment").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    cap_strike: doublePrecision("cap_strike"),
    cap_provider: varchar("cap_provider", { length: 160 }),
    cap_expires_on: date("cap_expires_on", { mode: "string" }),
    swap_rate: doublePrecision("swap_rate"),
    swap_expires_on: date("swap_expires_on", { mode: "string" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    covenant_state: varchar("covenant_state", { length: 20 }).notNull().$defaultFn(() => "none"),
    owner_id: fk("owner_id", () => users.id),
    notes: text("notes"),
  },
  (t) => [
    index("ix_loans_deleted_at").on(t.deleted_at),
    index("ix_loans_property_id").on(t.property_id),
    index("ix_loans_asset_id").on(t.asset_id),
    index("ix_loans_lender_organization_id").on(t.lender_organization_id),
    index("ix_loans_lender_name").on(t.lender_name),
    index("ix_loans_loan_type").on(t.loan_type),
    index("ix_loans_maturity_on").on(t.maturity_on),
    index("ix_loans_rate_type").on(t.rate_type),
    index("ix_loans_cap_expires_on").on(t.cap_expires_on),
    index("ix_loans_status").on(t.status),
    index("ix_loans_covenant_state").on(t.covenant_state),
    index("ix_loans_owner_id").on(t.owner_id),
  ],
);
export type Loan = typeof loans.$inferSelect;

/** Cross-collateralisation: every property securing a loan, with allocated amount and release price. */
export const loanProperties = pgTable(
  "loan_properties",
  {
    id: pk(),
    loan_id: fkReq("loan_id", () => loans.id),
    property_id: fkReq("property_id", () => properties.id),
    allocated_amount: numericFloat("allocated_amount", 16, 2),
    release_price: numericFloat("release_price", 16, 2),
    added_at: tz("added_at").notNull().$defaultFn(() => new Date()),
    added_by_id: fk("added_by_id", () => users.id),
  },
  (t) => [
    unique("uq_loan_properties_pair").on(t.loan_id, t.property_id),
    index("ix_loan_properties_loan_id").on(t.loan_id),
    index("ix_loan_properties_property_id").on(t.property_id),
  ],
);
export type LoanProperty = typeof loanProperties.$inferSelect;

/** Immutable debt history: balance/rate/term/status changes are appended, never overwritten. */
export const loanEvents = pgTable(
  "loan_events",
  {
    id: pk(),
    loan_id: fkReq("loan_id", () => loans.id),
    event_type: varchar("event_type", { length: 30 }).notNull(),
    at: tz("at").notNull().$defaultFn(() => new Date()),
    effective_on: date("effective_on", { mode: "string" }),
    field: varchar("field", { length: 60 }),
    from_value: jsonb("from_value").$type<any>(),
    to_value: jsonb("to_value").$type<any>(),
    note: text("note"),
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
  },
  (t) => [
    index("ix_loan_events_loan_id").on(t.loan_id),
    index("ix_loan_events_event_type").on(t.event_type),
    index("ix_loan_events_at").on(t.at),
  ],
);
export type LoanEvent = typeof loanEvents.$inferSelect;

export const covenants = pgTable(
  "covenants",
  {
    ...entity(),
    loan_id: fkReq("loan_id", () => loans.id),
    kind: varchar("kind", { length: 20 }).notNull(),
    label: varchar("label", { length: 160 }),
    operator: varchar("operator", { length: 4 }).notNull().$defaultFn(() => "min"), // min: value >= threshold; max: value <= threshold
    threshold: doublePrecision("threshold").notNull(),
    watch_threshold: doublePrecision("watch_threshold"),
    frequency: varchar("frequency", { length: 12 }).notNull().$defaultFn(() => "quarterly"),
    next_test_on: date("next_test_on", { mode: "string" }),
    cure_period_days: integer("cure_period_days"),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    last_state: varchar("last_state", { length: 20 }),
    last_projected_state: varchar("last_projected_state", { length: 20 }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_covenants_deleted_at").on(t.deleted_at),
    index("ix_covenants_loan_id").on(t.loan_id),
    index("ix_covenants_kind").on(t.kind),
    index("ix_covenants_next_test_on").on(t.next_test_on),
  ],
);
export type Covenant = typeof covenants.$inferSelect;

/** One scheduled or manual test; full history retained. */
export const covenantTests = pgTable(
  "covenant_tests",
  {
    ...entity(),
    covenant_id: fkReq("covenant_id", () => covenants.id),
    loan_id: fkReq("loan_id", () => loans.id),
    test_date: date("test_date", { mode: "string" }).notNull(),
    period_start: date("period_start", { mode: "string" }),
    period_end: date("period_end", { mode: "string" }),
    measured_value: doublePrecision("measured_value"),
    threshold: doublePrecision("threshold").notNull(),
    state: varchar("state", { length: 20 }).notNull(),
    projected_value: doublePrecision("projected_value"),
    projected_state: varchar("projected_state", { length: 20 }),
    projected_on: date("projected_on", { mode: "string" }),
    inputs: jsonb("inputs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    basis: varchar("basis", { length: 30 }).notNull().$defaultFn(() => "actual_verified"),
    is_manual: boolean("is_manual").notNull().$defaultFn(() => false),
    notes: text("notes"),
  },
  (t) => [
    index("ix_covenant_tests_deleted_at").on(t.deleted_at),
    index("ix_covenant_tests_covenant_id").on(t.covenant_id),
    index("ix_covenant_tests_loan_id").on(t.loan_id),
    index("ix_covenant_tests_test_date").on(t.test_date),
    index("ix_covenant_tests_state").on(t.state),
  ],
);
export type CovenantTest = typeof covenantTests.$inferSelect;

export const loanReserves = pgTable(
  "loan_reserves",
  {
    ...entity(),
    loan_id: fkReq("loan_id", () => loans.id),
    reserve_type: varchar("reserve_type", { length: 20 }).notNull().$defaultFn(() => "replacement"),
    label: varchar("label", { length: 160 }),
    required_amount: numericFloat("required_amount", 16, 2),
    monthly_deposit: numericFloat("monthly_deposit", 16, 2),
    cap_amount: numericFloat("cap_amount", 16, 2),
    balance: numericFloat("balance", 16, 2).notNull().$defaultFn(() => 0),
    release_conditions: text("release_conditions"),
    notes: text("notes"),
  },
  (t) => [index("ix_loan_reserves_deleted_at").on(t.deleted_at), index("ix_loan_reserves_loan_id").on(t.loan_id)],
);
export type LoanReserve = typeof loanReserves.$inferSelect;

export const reserveTransactions = pgTable(
  "reserve_transactions",
  {
    ...entity(),
    reserve_id: fkReq("reserve_id", () => loanReserves.id),
    loan_id: fkReq("loan_id", () => loans.id),
    kind: varchar("kind", { length: 12 }).notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    occurred_on: date("occurred_on", { mode: "string" }).notNull(),
    balance_after: numericFloat("balance_after", 16, 2).notNull(),
    document_id: uuid("document_id"),
    memo: text("memo"),
  },
  (t) => [
    index("ix_reserve_transactions_deleted_at").on(t.deleted_at),
    index("ix_reserve_transactions_reserve_id").on(t.reserve_id),
    index("ix_reserve_transactions_loan_id").on(t.loan_id),
    index("ix_reserve_transactions_occurred_on").on(t.occurred_on),
  ],
);
export type ReserveTransaction = typeof reserveTransactions.$inferSelect;

export const lenderReportingObligations = pgTable(
  "lender_reporting_obligations",
  {
    ...entity(),
    loan_id: fkReq("loan_id", () => loans.id),
    report_type: varchar("report_type", { length: 30 }).notNull(),
    label: varchar("label", { length: 160 }),
    frequency: varchar("frequency", { length: 12 }).notNull().$defaultFn(() => "quarterly"),
    days_after_period: integer("days_after_period").notNull().$defaultFn(() => 45),
    next_due_on: date("next_due_on", { mode: "string" }),
    owner_id: fk("owner_id", () => users.id),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    last_submitted_on: date("last_submitted_on", { mode: "string" }),
    critical_date_id: uuid("critical_date_id"),
    task_id: uuid("task_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_lender_reporting_obligations_deleted_at").on(t.deleted_at),
    index("ix_lender_reporting_obligations_loan_id").on(t.loan_id),
    index("ix_lender_reporting_obligations_next_due_on").on(t.next_due_on),
    index("ix_lender_reporting_obligations_owner_id").on(t.owner_id),
  ],
);
export type LenderReportingObligation = typeof lenderReportingObligations.$inferSelect;

/** Configurable lead times and current market terms (one JSON document per key). */
export const debtSettings = pgTable(
  "debt_settings",
  {
    ...entity(),
    key: varchar("key", { length: 60 }).notNull(),
    value: jsonb("value").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [unique("uq_debt_settings_key").on(t.key), index("ix_debt_settings_deleted_at").on(t.deleted_at)],
);
export type DebtSetting = typeof debtSettings.$inferSelect;
