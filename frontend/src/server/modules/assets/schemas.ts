import { z } from "zod";

import { provenanceIn } from "../../common/provenance";

const assetStatus = z.enum(["active", "held_for_sale", "disposed"]);
const finCategory = z.enum(["income", "expense", "capex", "debt_service", "reserve", "distribution"]);
const milestoneStatus = z.enum(["planned", "in_progress", "done", "missed", "cancelled"]);
const dimension = z.enum(["tenant", "brand", "industry", "guarantor", "lender", "geography"]);

const date = () => z.string().date();
const uuid = () => z.string().uuid();
// pydantic `X | None = None` on a model that is dumped in full: absent -> null
const optDate = () => date().nullable().default(null);
const optUuid = () => uuid().nullable().default(null);
const optStr = () => z.string().nullable().default(null);

const assetBase = {
  status: assetStatus.default("active"),
  acquired_on: optDate(),
  basis: z.number().min(0).nullable().default(null),
  equity_invested: z.number().min(0).nullable().default(null),
  current_value: z.number().min(0).nullable().default(null),
  value_as_of: optDate(),
  hold_thesis: optStr(),
  business_plan: optStr(),
  target_hold_years: z.number().min(0).max(100).nullable().default(null),
  exit_cap_rate: z.number().min(0).max(100).nullable().default(null),
  target_exit_on: optDate(),
  exit_assumptions: z.record(z.string(), z.any()).default({}),
  manager_id: optUuid(),
  uw_model_id: optUuid(),
  opportunity_id: optUuid(),
  notes: optStr(),
};

export const assetCreate = z.object({
  ...assetBase,
  property_id: uuid(),
  provenance: provenanceIn.default({}),
});
export type AssetCreate = z.infer<typeof assetCreate>;

/** Partial update. Unknown keys are rejected (`extra="forbid"`); only provided keys are applied. */
export const assetUpdate = z
  .object({
    status: assetStatus.nullish(),
    acquired_on: date().nullish(),
    basis: z.number().min(0).nullish(),
    equity_invested: z.number().min(0).nullish(),
    current_value: z.number().min(0).nullish(),
    value_as_of: date().nullish(),
    hold_thesis: z.string().nullish(),
    business_plan: z.string().nullish(),
    target_hold_years: z.number().min(0).max(100).nullish(),
    exit_cap_rate: z.number().min(0).max(100).nullish(),
    target_exit_on: date().nullish(),
    exit_assumptions: z.record(z.string(), z.any()).nullish(),
    manager_id: uuid().nullish(),
    uw_model_id: uuid().nullish(),
    notes: z.string().nullish(),
    provenance: provenanceIn.default({}),
  })
  .strict();
export type AssetUpdate = z.infer<typeof assetUpdate>;

/** A KPI value with the href(s) of the records it is computed from. */
export interface Metric {
  value: number | null;
  label: string | null;
  source: string | null;
  drill: Array<Record<string, string>>;
}

export const financialIn = z.object({
  period: date(),
  account: z.string().min(1).max(120),
  category: finCategory,
  amount: z.number(),
  notes: optStr(),
});
export type FinancialIn = z.infer<typeof financialIn>;

export const financialBulkIn = z.object({
  rows: z.array(financialIn).min(1).max(5000),
  source: z.enum(["manual", "import"]).default("import"),
});
export type FinancialBulkIn = z.infer<typeof financialBulkIn>;

export const verifyPeriodsIn = z.object({ period_from: date(), period_to: date() });
export type VerifyPeriodsIn = z.infer<typeof verifyPeriodsIn>;

export const milestoneIn = z.object({
  title: z.string().min(1).max(200),
  description: optStr(),
  owner_id: optUuid(),
  due_on: optDate(),
  status: milestoneStatus.default("planned"),
});
export type MilestoneIn = z.infer<typeof milestoneIn>;

export const milestoneUpdate = z
  .object({
    title: z.string().min(1).max(200).nullish(),
    description: z.string().nullish(),
    owner_id: uuid().nullish(),
    due_on: date().nullish(),
    status: milestoneStatus.nullish(),
  })
  .strict();
export type MilestoneUpdate = z.infer<typeof milestoneUpdate>;

export const explainIn = z.object({
  period: date(),
  window: z.enum(["month", "ttm"]).default("month"),
  basis: z.enum(["budget", "underwriting"]).default("budget"),
  account: z.string().min(1).max(120),
  actual: z.number().nullish(),
  benchmark: z.number().nullish(),
  explanation: z.string().min(3),
  owner_id: uuid().nullish(),
});
export type ExplainIn = z.infer<typeof explainIn>;

export const explanationText = z.object({ explanation: z.string().min(3) });

export const reviewIn = z.object({ decision: z.enum(["accepted", "rejected"]), note: z.string().nullish() });
export type ReviewIn = z.infer<typeof reviewIn>;

export const limitIn = z.object({
  dimension,
  key: optStr(),
  max_pct: z.number().gt(0).max(100),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  is_active: z.boolean().default(true),
  notes: optStr(),
});
export type LimitIn = z.infer<typeof limitIn>;

export const tenantProfileIn = z.object({
  tenant_name: z.string().min(1).max(200),
  organization_id: optUuid(),
  brand: optStr(),
  industry: optStr(),
  credit_rating: optStr(),
  credit_watch: z.boolean().default(false),
  notes: optStr(),
});
export type TenantProfileIn = z.infer<typeof tenantProfileIn>;

export const watchResolveIn = z.object({
  status: z.enum(["resolved", "dismissed"]).default("resolved"),
  note: z.string().min(3),
});
export type WatchResolveIn = z.infer<typeof watchResolveIn>;

export const settingsIn = z.object({
  variance_pct: z.number().min(0).max(1000),
  variance_amount: z.number().min(0),
  watch_min_dscr: z.number().min(0),
  watch_min_occupancy: z.number().min(0).max(100),
  maturity_months: z.number().int().min(1).max(120),
  persistent_variance_months: z.number().int().min(2).max(24),
  maintenance_backlog: z.number().int().min(1),
  maintenance_overdue_days: z.number().int().min(1),
});
export type SettingsIn = z.infer<typeof settingsIn>;
