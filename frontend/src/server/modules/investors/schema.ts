import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
} from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { organizations, people } from "../contacts/schema";
import { properties } from "../properties/schema";

export const PARTNER_TYPES = ["individual", "family_office", "fund", "institution", "trust", "sponsor", "other"] as const;
export const PARTNER_STATUSES = ["prospect", "active", "inactive"] as const;
export const WATERFALL_POSITIONS = ["lp", "gp"] as const;
export const DAY_COUNTS = ["act_365", "act_360", "30_360"] as const;
export const COMPOUNDING = ["simple", "annual"] as const;
export const TIER_TYPES = ["return_of_capital", "preferred_return", "catch_up", "split"] as const;
export const HURDLE_TYPES = ["none", "irr", "equity_multiple"] as const;
export const EVENT_TYPES = ["call", "distribution", "liquidation"] as const;
export const EVENT_STATUSES = ["draft", "pending_approval", "approved", "posted", "rejected", "reversed"] as const;
export const ENTRY_TYPES = ["contribution", "distribution", "income_allocation", "loss_allocation"] as const;
export const COMPONENTS = ["return_of_capital", "preferred_return", "catch_up", "profit", "residual"] as const;
export const CALL_ITEM_STATUSES = ["pending", "partial", "funded", "late", "default"] as const;
export const PACKAGE_TYPES = ["property_performance", "portfolio", "valuation", "distributions", "capital_accounts"] as const;
export const REPORT_FREQUENCIES = ["monthly", "quarterly", "annual"] as const;
export const COMM_CHANNELS = ["email", "portal", "mail", "phone"] as const;

// Investment fields whose changes are material facts kept with provenance history.
export const INVESTMENT_MATERIAL = new Set([
  "commitment", "ownership_pct", "pref_rate", "waterfall_position", "waterfall_id", "status",
]);

const d = (name: string) => date(name, { mode: "string" });

/** An equity relationship (LP investor or sponsor/GP entity) linked to the contact master. */
export const capitalPartners = pgTable(
  "capital_partners",
  {
    ...entity(),
    name: varchar("name", { length: 200 }).notNull(),
    type: varchar("type", { length: 30 }).notNull().$defaultFn(() => "individual"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    organization_id: fk("organization_id", () => organizations.id),
    person_id: fk("person_id", () => people.id),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 40 }),
    reporting_requirements: text("reporting_requirements"),
    // {frequency, packages: [...], delivery, format}
    reporting_prefs: jsonb("reporting_prefs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    // {channel, recipients: [...], do_not_contact: bool, notes}
    communication_prefs: jsonb("communication_prefs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    portal_user_id: fk("portal_user_id", () => users.id),
    owner_id: fk("owner_id", () => users.id),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_capital_partners_deleted_at").on(t.deleted_at),
    index("ix_capital_partners_name").on(t.name),
    index("ix_capital_partners_type").on(t.type),
    index("ix_capital_partners_status").on(t.status),
    index("ix_capital_partners_organization_id").on(t.organization_id),
    index("ix_capital_partners_person_id").on(t.person_id),
    index("ix_capital_partners_portal_user_id").on(t.portal_user_id),
    index("ix_capital_partners_owner_id").on(t.owner_id),
  ],
);
export type CapitalPartner = typeof capitalPartners.$inferSelect;

/** Configurable distribution waterfall. Tier edits bump `version`; calcs snapshot the tiers used. */
export const waterfalls = pgTable(
  "waterfalls",
  {
    ...entity(),
    name: varchar("name", { length: 200 }).notNull(),
    asset_id: uuid("asset_id"),
    description: text("description"),
    version: integer("version").notNull().$defaultFn(() => 1),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [index("ix_waterfalls_deleted_at").on(t.deleted_at), index("ix_waterfalls_asset_id").on(t.asset_id)],
);
export type Waterfall = typeof waterfalls.$inferSelect;

export const waterfallTiers = pgTable(
  "waterfall_tiers",
  {
    id: pk(),
    waterfall_id: uuid("waterfall_id").notNull().references(() => waterfalls.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: varchar("name", { length: 120 }),
    tier_type: varchar("tier_type", { length: 30 }).notNull(),
    hurdle_type: varchar("hurdle_type", { length: 20 }).notNull().$defaultFn(() => "none"),
    hurdle_value: doublePrecision("hurdle_value"), // IRR in percent (15 = 15%) or equity multiple (1.8)
    // Shares / catch-up values are fractions 0-1.
    lp_share: doublePrecision("lp_share").notNull().$defaultFn(() => 1.0),
    gp_share: doublePrecision("gp_share").notNull().$defaultFn(() => 0.0),
    catch_up_rate: doublePrecision("catch_up_rate").notNull().$defaultFn(() => 1.0),
    catch_up_target: doublePrecision("catch_up_target").notNull().$defaultFn(() => 0.2),
  },
  (t) => [index("ix_waterfall_tiers_waterfall_id").on(t.waterfall_id)],
);
export type WaterfallTier = typeof waterfallTiers.$inferSelect;

/** A partner's position in one asset. */
export const investments = pgTable(
  "investments",
  {
    ...entity(),
    partner_id: uuid("partner_id").notNull().references(() => capitalPartners.id),
    // Assets live in a separately-loaded module; a plain UUID keeps this table independent of load order.
    asset_id: uuid("asset_id").notNull(),
    property_id: fk("property_id", () => properties.id),
    waterfall_id: fk("waterfall_id", () => waterfalls.id),
    commitment: numericFloat("commitment", 16, 2).notNull().$defaultFn(() => 0),
    funded: numericFloat("funded", 16, 2).notNull().$defaultFn(() => 0),
    ownership_pct: doublePrecision("ownership_pct").notNull().$defaultFn(() => 0), // percent 0-100
    pref_rate: doublePrecision("pref_rate").notNull().$defaultFn(() => 0), // annual percent, e.g. 8.0
    pref_compounding: varchar("pref_compounding", { length: 10 }).notNull().$defaultFn(() => "simple"),
    day_count: varchar("day_count", { length: 10 }).notNull().$defaultFn(() => "act_365"),
    waterfall_position: varchar("waterfall_position", { length: 10 }).notNull().$defaultFn(() => "lp"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    invested_on: d("invested_on"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_investments_deleted_at").on(t.deleted_at),
    index("ix_investments_partner_id").on(t.partner_id),
    index("ix_investments_asset_id").on(t.asset_id),
    index("ix_investments_property_id").on(t.property_id),
    index("ix_investments_waterfall_id").on(t.waterfall_id),
    index("ix_investments_waterfall_position").on(t.waterfall_position),
    index("ix_investments_status").on(t.status),
  ],
);
export type Investment = typeof investments.$inferSelect;

/** Call, distribution or liquidation. Calculations are versioned; approval locks a version. */
export const capitalEvents = pgTable(
  "capital_events",
  {
    ...entity(),
    event_type: varchar("event_type", { length: 20 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    asset_id: uuid("asset_id").notNull(),
    property_id: uuid("property_id"),
    waterfall_id: fk("waterfall_id", () => waterfalls.id),
    waterfall_version: integer("waterfall_version"),
    event_date: d("event_date").notNull(),
    due_on: d("due_on"),
    amount: numericFloat("amount", 16, 2).notNull(),
    // Liquidation inputs (gross, payoff, costs, reserves) and call default provisions.
    inputs: jsonb("inputs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    version: integer("version").notNull().$defaultFn(() => 1),
    calc: jsonb("calc").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    notes: text("notes"),
    submitted_by_id: uuid("submitted_by_id").references(() => users.id, { onDelete: "set null" }),
    submitted_at: tz("submitted_at"),
    approved_by_id: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approved_at: tz("approved_at"),
    approved_version: integer("approved_version"),
    decision_note: text("decision_note"),
    posted_by_id: uuid("posted_by_id").references(() => users.id, { onDelete: "set null" }),
    posted_at: tz("posted_at"),
    reversed_by_id: uuid("reversed_by_id").references(() => users.id, { onDelete: "set null" }),
    reversed_at: tz("reversed_at"),
    reversal_reason: text("reversal_reason"),
  },
  (t) => [
    index("ix_capital_events_deleted_at").on(t.deleted_at),
    index("ix_capital_events_event_type").on(t.event_type),
    index("ix_capital_events_asset_id").on(t.asset_id),
    index("ix_capital_events_property_id").on(t.property_id),
    index("ix_capital_events_waterfall_id").on(t.waterfall_id),
    index("ix_capital_events_event_date").on(t.event_date),
    index("ix_capital_events_status").on(t.status),
  ],
);
export type CapitalEvent = typeof capitalEvents.$inferSelect;

/** Immutable record of every calculation version of an event. */
export const capitalEventVersions = pgTable(
  "capital_event_versions",
  {
    id: pk(),
    event_id: uuid("event_id").notNull().references(() => capitalEvents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    inputs: jsonb("inputs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    calc: jsonb("calc").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    created_by_id: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("uq_capital_event_versions_event_version").on(t.event_id, t.version),
    index("ix_capital_event_versions_event_id").on(t.event_id),
  ],
);
export type CapitalEventVersion = typeof capitalEventVersions.$inferSelect;

/** Per-partner result of a posted event: a call notice line or a distribution record. */
export const capitalEventAllocations = pgTable(
  "capital_event_allocations",
  {
    ...entity(),
    event_id: uuid("event_id").notNull().references(() => capitalEvents.id),
    partner_id: uuid("partner_id").notNull().references(() => capitalPartners.id),
    investment_id: uuid("investment_id").notNull().references(() => investments.id),
    event_type: varchar("event_type", { length: 20 }).notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    tiers: jsonb("tiers").$type<any[]>().notNull().$defaultFn(() => []),
    status: varchar("status", { length: 20 }).notNull(), // call: pending..default; distribution: paid|reversed
    due_on: d("due_on"),
    funded_amount: numericFloat("funded_amount", 16, 2).notNull().$defaultFn(() => 0),
    funded_on: d("funded_on"),
    late_interest: numericFloat("late_interest", 16, 2).notNull().$defaultFn(() => 0),
    penalty_flag: boolean("penalty_flag").notNull().$defaultFn(() => false),
    default_flag: boolean("default_flag").notNull().$defaultFn(() => false),
    notice_text: text("notice_text"),
    paid_on: d("paid_on"),
    payment_reference: varchar("payment_reference", { length: 120 }),
  },
  (t) => [
    index("ix_capital_event_allocations_deleted_at").on(t.deleted_at),
    index("ix_capital_event_allocations_event_id").on(t.event_id),
    index("ix_capital_event_allocations_partner_id").on(t.partner_id),
    index("ix_capital_event_allocations_investment_id").on(t.investment_id),
    index("ix_capital_event_allocations_event_type").on(t.event_type),
    index("ix_capital_event_allocations_status").on(t.status),
  ],
);
export type CapitalEventAllocation = typeof capitalEventAllocations.$inferSelect;

/** Immutable capital-account ledger. Corrections are reversing entries (negative amount). */
export const capitalAccountEntries = pgTable(
  "capital_account_entries",
  {
    id: pk(),
    partner_id: uuid("partner_id").notNull().references(() => capitalPartners.id),
    investment_id: uuid("investment_id").notNull().references(() => investments.id),
    asset_id: uuid("asset_id").notNull(),
    event_id: fk("event_id", () => capitalEvents.id),
    allocation_id: fk("allocation_id", () => capitalEventAllocations.id),
    entry_type: varchar("entry_type", { length: 30 }).notNull(),
    component: varchar("component", { length: 30 }),
    amount: numericFloat("amount", 16, 2).notNull(),
    effective_on: d("effective_on").notNull(),
    memo: text("memo"),
    reverses_entry_id: uuid("reverses_entry_id").references((): any => capitalAccountEntries.id, { onDelete: "set null" }),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    created_by_id: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_capital_account_entries_partner_id").on(t.partner_id),
    index("ix_capital_account_entries_investment_id").on(t.investment_id),
    index("ix_capital_account_entries_asset_id").on(t.asset_id),
    index("ix_capital_account_entries_event_id").on(t.event_id),
    index("ix_capital_account_entries_allocation_id").on(t.allocation_id),
    index("ix_capital_account_entries_entry_type").on(t.entry_type),
    index("ix_capital_account_entries_effective_on").on(t.effective_on),
    index("ix_capital_account_entries_reverses_entry_id").on(t.reverses_entry_id),
  ],
);
export type CapitalAccountEntry = typeof capitalAccountEntries.$inferSelect;

export const reportSchedules = pgTable(
  "investor_report_schedules",
  {
    ...entity(),
    name: varchar("name", { length: 200 }).notNull(),
    partner_id: fk("partner_id", () => capitalPartners.id),
    asset_id: uuid("asset_id"),
    package_types: varchar("package_types", { length: 40 }).array().notNull().$defaultFn(() => []),
    frequency: varchar("frequency", { length: 20 }).notNull().$defaultFn(() => "quarterly"),
    next_run_on: d("next_run_on").notNull(),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    auto_issue: boolean("auto_issue").notNull().$defaultFn(() => false),
    last_run_at: tz("last_run_at"),
  },
  (t) => [
    index("ix_investor_report_schedules_deleted_at").on(t.deleted_at),
    index("ix_investor_report_schedules_partner_id").on(t.partner_id),
    index("ix_investor_report_schedules_asset_id").on(t.asset_id),
    index("ix_investor_report_schedules_next_run_on").on(t.next_run_on),
  ],
);
export type ReportSchedule = typeof reportSchedules.$inferSelect;

/** A partner reporting package assembled from verified data, frozen as a snapshot. */
export const reportPackages = pgTable(
  "report_packages",
  {
    ...entity(),
    partner_id: uuid("partner_id").notNull().references(() => capitalPartners.id),
    asset_id: uuid("asset_id"),
    schedule_id: fk("schedule_id", () => reportSchedules.id),
    title: varchar("title", { length: 200 }).notNull(),
    package_types: varchar("package_types", { length: 40 }).array().notNull().$defaultFn(() => []),
    period_start: d("period_start").notNull(),
    period_end: d("period_end").notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "generated"), // generated | issued
    snapshot: jsonb("snapshot").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    excluded: jsonb("excluded").$type<any[]>().notNull().$defaultFn(() => []),
    generated_at: tz("generated_at").notNull().$defaultFn(() => new Date()),
    issued_at: tz("issued_at"),
    issued_by_id: uuid("issued_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_report_packages_deleted_at").on(t.deleted_at),
    index("ix_report_packages_partner_id").on(t.partner_id),
    index("ix_report_packages_asset_id").on(t.asset_id),
    index("ix_report_packages_schedule_id").on(t.schedule_id),
    index("ix_report_packages_period_end").on(t.period_end),
    index("ix_report_packages_status").on(t.status),
  ],
);
export type ReportPackage = typeof reportPackages.$inferSelect;
