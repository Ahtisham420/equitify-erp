import { z } from "zod";

import { provenanceIn } from "../../common/provenance";

const uuid = () => z.string().uuid();
const isoDate = () => z.string().date();

const PartnerType = z.enum(["individual", "family_office", "fund", "institution", "trust", "sponsor", "other"]);
const PartnerStatus = z.enum(["prospect", "active", "inactive"]);
const Position = z.enum(["lp", "gp"]);
const DayCount = z.enum(["act_365", "act_360", "30_360"]);
const Compounding = z.enum(["simple", "annual"]);
const TierType = z.enum(["return_of_capital", "preferred_return", "catch_up", "split"]);
const HurdleType = z.enum(["none", "irr", "equity_multiple"]);
const EventType = z.enum(["call", "distribution", "liquidation"]);
const PackageType = z.enum(["property_performance", "portfolio", "valuation", "distributions", "capital_accounts"]);
const Frequency = z.enum(["monthly", "quarterly", "annual"]);

// --------------------------------------------------------------------------- partners

export const partnerCreate = z.object({
  name: z.string().min(1).max(200),
  type: PartnerType.default("individual"),
  status: PartnerStatus.default("active"),
  organization_id: uuid().nullish(),
  person_id: uuid().nullish(),
  email: z.string().max(255).nullish(),
  phone: z.string().max(40).nullish(),
  reporting_requirements: z.string().nullish(),
  reporting_prefs: z.record(z.any()).default({}),
  communication_prefs: z.record(z.any()).default({}),
  portal_user_id: uuid().nullish(),
  owner_id: uuid().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
});
export type PartnerCreate = z.infer<typeof partnerCreate>;

export const partnerUpdate = z
  .object({
    name: z.string().min(1).max(200).nullish(),
    type: PartnerType.nullish(),
    status: PartnerStatus.nullish(),
    organization_id: uuid().nullish(),
    person_id: uuid().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    reporting_requirements: z.string().nullish(),
    reporting_prefs: z.record(z.any()).nullish(),
    communication_prefs: z.record(z.any()).nullish(),
    portal_user_id: uuid().nullish(),
    owner_id: uuid().nullish(),
    notes: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .strict();
export type PartnerUpdate = z.infer<typeof partnerUpdate>;

// --------------------------------------------------------------------------- investments

const investmentBase = {
  asset_id: uuid(),
  property_id: uuid().nullish(),
  waterfall_id: uuid().nullish(),
  commitment: z.number().min(0),
  ownership_pct: z.number().min(0).max(100),
  pref_rate: z.number().min(0).max(100).default(0),
  pref_compounding: Compounding.default("simple"),
  day_count: DayCount.default("act_365"),
  waterfall_position: Position.default("lp"),
  status: z.enum(["active", "exited"]).default("active"),
  invested_on: isoDate().nullish(),
  notes: z.string().nullish(),
};

export const investmentCreate = z.object({
  ...investmentBase,
  partner_id: uuid(),
  provenance: provenanceIn.default({ source: "Subscription documents", verified: true, confidence: 1 }),
});
export type InvestmentCreate = z.infer<typeof investmentCreate>;

export const investmentUpdate = z
  .object({
    property_id: uuid().nullish(),
    waterfall_id: uuid().nullish(),
    commitment: z.number().min(0).nullish(),
    ownership_pct: z.number().min(0).max(100).nullish(),
    pref_rate: z.number().min(0).max(100).nullish(),
    pref_compounding: Compounding.nullish(),
    day_count: DayCount.nullish(),
    waterfall_position: Position.nullish(),
    status: z.enum(["active", "exited"]).nullish(),
    invested_on: isoDate().nullish(),
    notes: z.string().nullish(),
    provenance: provenanceIn.default({}),
  })
  .strict();
export type InvestmentUpdate = z.infer<typeof investmentUpdate>;

// --------------------------------------------------------------------------- waterfalls

export const tierIn = z.object({
  position: z.number().int().min(1),
  name: z.string().max(120).nullish(),
  tier_type: TierType,
  hurdle_type: HurdleType.default("none"),
  hurdle_value: z.number().min(0).nullish(),
  lp_share: z.number().min(0).max(1).default(1.0),
  gp_share: z.number().min(0).max(1).default(0.0),
  catch_up_rate: z.number().min(0).max(1).default(1.0),
  catch_up_target: z.number().min(0).max(1).default(0.2),
});
export type TierIn = z.infer<typeof tierIn>;

export const waterfallIn = z.object({
  name: z.string().min(1).max(200),
  asset_id: uuid().nullish(),
  description: z.string().nullish(),
  is_active: z.boolean().default(true),
  tiers: z.array(tierIn).min(1).max(12),
});
export type WaterfallIn = z.infer<typeof waterfallIn>;

// --------------------------------------------------------------------------- capital events

/** Liquidation inputs and call default provisions. */
export const eventInputs = z.object({
  gross_proceeds: z.number().min(0).nullish(),
  debt_payoff: z.number().min(0).nullish(),
  closing_costs: z.number().min(0).nullish(),
  reserves: z.number().min(0).nullish(),
  default_rate: z.number().min(0).max(100).nullish(), // annual % late interest
  grace_days: z.number().int().min(0).max(365).nullish(),
  penalty_pct: z.number().min(0).max(100).nullish(),
  purpose: z.string().nullish(),
  wire_instructions: z.string().nullish(),
});
export type EventInputs = z.infer<typeof eventInputs>;

export const eventPreviewIn = z.object({
  event_type: EventType,
  asset_id: uuid(),
  amount: z.number().min(0).nullish(),
  event_date: isoDate(),
  due_on: isoDate().nullish(),
  waterfall_id: uuid().nullish(),
  inputs: eventInputs.default({}),
});
export type EventPreviewIn = z.infer<typeof eventPreviewIn>;

export const eventCreate = eventPreviewIn.extend({
  name: z.string().max(200).nullish(),
  notes: z.string().nullish(),
});
export type EventCreate = z.infer<typeof eventCreate>;

export const eventUpdate = z
  .object({
    name: z.string().max(200).nullish(),
    amount: z.number().min(0).nullish(),
    event_date: isoDate().nullish(),
    due_on: isoDate().nullish(),
    waterfall_id: uuid().nullish(),
    inputs: eventInputs.nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type EventUpdate = z.infer<typeof eventUpdate>;

export const decisionIn = z.object({ note: z.string().nullish() });
export type DecisionIn = z.infer<typeof decisionIn>;

export const reverseIn = z.object({ reason: z.string().min(3) });
export type ReverseIn = z.infer<typeof reverseIn>;

export const fundIn = z.object({
  amount: z.number().gt(0),
  funded_on: isoDate(),
  reference: z.string().max(120).nullish(),
});
export type FundIn = z.infer<typeof fundIn>;

export const defaultIn = z.object({
  default_flag: z.boolean().default(true),
  penalty_flag: z.boolean().nullish(),
  note: z.string().nullish(),
});
export type DefaultIn = z.infer<typeof defaultIn>;

export const incomeAllocationIn = z.object({
  amount: z.number(), // positive income, negative loss
  effective_on: isoDate(),
  memo: z.string().max(500).nullish(),
});
export type IncomeAllocationIn = z.infer<typeof incomeAllocationIn>;

// --------------------------------------------------------------------------- reports

export const packageCreate = z.object({
  partner_id: uuid().nullish(), // null -> every active partner (optionally limited to asset_id)
  asset_id: uuid().nullish(),
  period_start: isoDate(),
  period_end: isoDate(),
  package_types: z.array(PackageType).min(1),
  title: z.string().max(200).nullish(),
});
export type PackageCreate = z.infer<typeof packageCreate>;

export const scheduleIn = z.object({
  name: z.string().min(1).max(200),
  partner_id: uuid().nullish(),
  asset_id: uuid().nullish(),
  package_types: z.array(PackageType).min(1),
  frequency: Frequency.default("quarterly"),
  next_run_on: isoDate(),
  is_active: z.boolean().default(true),
  auto_issue: z.boolean().default(false),
});
export type ScheduleIn = z.infer<typeof scheduleIn>;

export const scheduleUpdate = z
  .object({
    name: z.string().nullish(),
    package_types: z.array(PackageType).nullish(),
    frequency: Frequency.nullish(),
    next_run_on: isoDate().nullish(),
    is_active: z.boolean().nullish(),
    auto_issue: z.boolean().nullish(),
  })
  .strict();
export type ScheduleUpdate = z.infer<typeof scheduleUpdate>;
