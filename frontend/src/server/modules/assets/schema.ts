import { boolean, date, doublePrecision, index, jsonb, pgTable, text, unique, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { organizations } from "../contacts/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";

// NOT NULL ON DELETE CASCADE foreign key (typed as non-nullable, unlike the generic fk() helper)
const fkReq = (column: string, ref: () => AnyPgColumn) => uuid(column).notNull().references(ref, { onDelete: "cascade" });

export const ASSET_STATUSES = ["active", "held_for_sale", "disposed"] as const;
// reserve is a superset of the shared contract (income|expense|capex|debt_service|distribution)
export const FIN_CATEGORIES = ["income", "expense", "capex", "debt_service", "reserve", "distribution"] as const;
export const FIN_SOURCES = ["manual", "import", "system"] as const;
export const MILESTONE_STATUSES = ["planned", "in_progress", "done", "missed", "cancelled"] as const;
export const VARIANCE_STATUSES = ["required", "submitted", "accepted", "rejected"] as const;
export const VARIANCE_BASES = ["budget", "underwriting"] as const;
export const VARIANCE_WINDOWS = ["month", "ttm"] as const;
export const WATCH_TRIGGERS = ["coverage", "occupancy", "tenant_credit", "maintenance", "covenant", "maturity", "variance"] as const;
export const WATCH_STATUSES = ["open", "resolved", "dismissed"] as const;
export const CONCENTRATION_DIMENSIONS = ["tenant", "brand", "industry", "guarantor", "lender", "geography"] as const;
export const GROUP_BYS = [
  "property_type", "tenant", "geography", "corridor", "vintage", "lender", "capital_partner", "territory",
] as const;

// Material asset facts: every change keeps a provenance observation (source/date/confidence/verification).
export const MATERIAL_FIELDS = new Set([
  "basis", "current_value", "acquired_on", "exit_cap_rate", "target_hold_years", "equity_invested",
]);

/** An owned property under asset management. One asset per property. */
export const assets = pgTable(
  "assets",
  {
    ...entity(),
    property_id: fkReq("property_id", () => properties.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    acquired_on: date("acquired_on", { mode: "string" }),
    basis: numericFloat("basis", 16, 2),
    equity_invested: numericFloat("equity_invested", 16, 2),
    current_value: numericFloat("current_value", 16, 2),
    value_as_of: date("value_as_of", { mode: "string" }),
    hold_thesis: text("hold_thesis"),
    business_plan: text("business_plan"),
    target_hold_years: doublePrecision("target_hold_years"),
    exit_cap_rate: doublePrecision("exit_cap_rate"),
    target_exit_on: date("target_exit_on", { mode: "string" }),
    exit_assumptions: jsonb("exit_assumptions").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    manager_id: fk("manager_id", () => users.id),
    // Approved acquisition underwriting — kept as the original benchmark.
    uw_model_id: uuid("uw_model_id"),
    opportunity_id: fk("opportunity_id", () => opportunities.id),
    closing_id: uuid("closing_id"),
    disposed_on: date("disposed_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    unique("uq_assets_property").on(t.property_id),
    index("ix_assets_deleted_at").on(t.deleted_at),
    index("ix_assets_property_id").on(t.property_id),
    index("ix_assets_status").on(t.status),
    index("ix_assets_acquired_on").on(t.acquired_on),
    index("ix_assets_manager_id").on(t.manager_id),
    index("ix_assets_uw_model_id").on(t.uw_model_id),
    index("ix_assets_opportunity_id").on(t.opportunity_id),
    index("ix_assets_closing_id").on(t.closing_id),
  ],
);
export type Asset = typeof assets.$inferSelect;

/** Monthly actual by account. Re-entries keep the prior row (is_current=False) as history. */
export const assetFinancials = pgTable(
  "asset_financials",
  {
    ...entity(),
    asset_id: fkReq("asset_id", () => assets.id),
    period: date("period", { mode: "string" }).notNull(), // first day of month
    account: varchar("account", { length: 120 }).notNull(),
    category: varchar("category", { length: 20 }).notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    source: varchar("source", { length: 40 }).notNull().$defaultFn(() => "manual"),
    verified: boolean("verified").notNull().$defaultFn(() => false),
    verified_by_id: fk("verified_by_id", () => users.id),
    verified_at: tz("verified_at"),
    is_current: boolean("is_current").notNull().$defaultFn(() => true),
    notes: text("notes"),
  },
  (t) => [
    index("ix_asset_financials_asset_period").on(t.asset_id, t.period),
    index("ix_asset_financials_deleted_at").on(t.deleted_at),
    index("ix_asset_financials_asset_id").on(t.asset_id),
    index("ix_asset_financials_period").on(t.period),
    index("ix_asset_financials_account").on(t.account),
    index("ix_asset_financials_category").on(t.category),
    index("ix_asset_financials_verified").on(t.verified),
    index("ix_asset_financials_is_current").on(t.is_current),
  ],
);
export type AssetFinancial = typeof assetFinancials.$inferSelect;

export const assetMilestones = pgTable(
  "asset_milestones",
  {
    ...entity(),
    asset_id: fkReq("asset_id", () => assets.id),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    owner_id: fk("owner_id", () => users.id),
    due_on: date("due_on", { mode: "string" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "planned"),
    completed_on: date("completed_on", { mode: "string" }),
    task_id: uuid("task_id"),
  },
  (t) => [
    index("ix_asset_milestones_deleted_at").on(t.deleted_at),
    index("ix_asset_milestones_asset_id").on(t.asset_id),
    index("ix_asset_milestones_owner_id").on(t.owner_id),
    index("ix_asset_milestones_due_on").on(t.due_on),
    index("ix_asset_milestones_status").on(t.status),
  ],
);
export type AssetMilestone = typeof assetMilestones.$inferSelect;

/** Explanation record for a variance above the configured % and $ thresholds. */
export const varianceExplanations = pgTable(
  "variance_explanations",
  {
    ...entity(),
    asset_id: fkReq("asset_id", () => assets.id),
    period: date("period", { mode: "string" }).notNull(),
    window: varchar("window", { length: 10 }).notNull().$defaultFn(() => "month"),
    basis: varchar("basis", { length: 20 }).notNull().$defaultFn(() => "budget"),
    account: varchar("account", { length: 120 }).notNull(),
    actual: numericFloat("actual", 16, 2),
    benchmark: numericFloat("benchmark", 16, 2),
    variance: numericFloat("variance", 16, 2),
    variance_pct: doublePrecision("variance_pct"),
    owner_id: fk("owner_id", () => users.id),
    explanation: text("explanation"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "required"),
    submitted_at: tz("submitted_at"),
    reviewed_by_id: fk("reviewed_by_id", () => users.id),
    reviewed_at: tz("reviewed_at"),
    review_note: text("review_note"),
    task_id: uuid("task_id"),
  },
  (t) => [
    index("ix_variance_explanations_deleted_at").on(t.deleted_at),
    index("ix_variance_explanations_asset_id").on(t.asset_id),
    index("ix_variance_explanations_period").on(t.period),
    index("ix_variance_explanations_owner_id").on(t.owner_id),
    index("ix_variance_explanations_status").on(t.status),
  ],
);
export type VarianceExplanation = typeof varianceExplanations.$inferSelect;

/** Max share of portfolio exposure for a dimension (optionally a specific key). */
export const concentrationLimits = pgTable(
  "concentration_limits",
  {
    ...entity(),
    dimension: varchar("dimension", { length: 20 }).notNull(),
    key: varchar("key", { length: 200 }), // null = applies to every key in the dimension
    max_pct: doublePrecision("max_pct").notNull(),
    severity: varchar("severity", { length: 10 }).notNull().$defaultFn(() => "medium"),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    notes: text("notes"),
  },
  (t) => [
    index("ix_concentration_limits_deleted_at").on(t.deleted_at),
    index("ix_concentration_limits_dimension").on(t.dimension),
  ],
);
export type ConcentrationLimit = typeof concentrationLimits.$inferSelect;

/** Brand / industry / credit classification of a tenant for concentration and credit watch. */
export const tenantProfiles = pgTable(
  "tenant_profiles",
  {
    ...entity(),
    tenant_key: varchar("tenant_key", { length: 200 }).notNull(),
    tenant_name: varchar("tenant_name", { length: 200 }).notNull(),
    organization_id: fk("organization_id", () => organizations.id),
    brand: varchar("brand", { length: 160 }),
    industry: varchar("industry", { length: 120 }),
    credit_rating: varchar("credit_rating", { length: 20 }),
    credit_watch: boolean("credit_watch").notNull().$defaultFn(() => false),
    notes: text("notes"),
  },
  (t) => [
    unique("uq_tenant_profiles_tenant_key").on(t.tenant_key),
    index("ix_tenant_profiles_deleted_at").on(t.deleted_at),
    index("ix_tenant_profiles_organization_id").on(t.organization_id),
    index("ix_tenant_profiles_brand").on(t.brand),
    index("ix_tenant_profiles_industry").on(t.industry),
    index("ix_tenant_profiles_credit_watch").on(t.credit_watch),
  ],
);
export type TenantProfile = typeof tenantProfiles.$inferSelect;

/** One episode of a watchlist trigger on an asset (open until the condition clears or is resolved). */
export const watchlistEntries = pgTable(
  "watchlist_entries",
  {
    ...entity(),
    asset_id: fkReq("asset_id", () => assets.id),
    trigger: varchar("trigger", { length: 20 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull().$defaultFn(() => "medium"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    detail: text("detail"),
    metric_value: doublePrecision("metric_value"),
    threshold: doublePrecision("threshold"),
    source_href: varchar("source_href", { length: 300 }),
    first_detected_at: tz("first_detected_at").notNull(),
    last_detected_at: tz("last_detected_at").notNull(),
    resolved_at: tz("resolved_at"),
    resolved_by_id: fk("resolved_by_id", () => users.id),
    resolution_note: text("resolution_note"),
    alert_id: uuid("alert_id"),
  },
  (t) => [
    index("ix_watchlist_entries_deleted_at").on(t.deleted_at),
    index("ix_watchlist_entries_asset_id").on(t.asset_id),
    index("ix_watchlist_entries_trigger").on(t.trigger),
    index("ix_watchlist_entries_status").on(t.status),
  ],
);
export type WatchlistEntry = typeof watchlistEntries.$inferSelect;

/** Configurable thresholds (variance, watchlist) stored as one JSON document per key. */
export const assetSettings = pgTable(
  "asset_settings",
  {
    ...entity(),
    key: varchar("key", { length: 60 }).notNull(),
    value: jsonb("value").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [unique("uq_asset_settings_key").on(t.key), index("ix_asset_settings_deleted_at").on(t.deleted_at)],
);
export type AssetSetting = typeof assetSettings.$inferSelect;
