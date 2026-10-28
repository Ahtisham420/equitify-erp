import { z } from "zod";

const loanStatus = z.enum(["active", "paid_off", "defeased", "refinanced", "default"]);
const rateType = z.enum(["fixed", "floating"]);
const recourse = z.enum(["non_recourse", "partial", "full"]);
const frequency = z.enum(["monthly", "quarterly", "semiannual", "annual"]);
const covenantKind = z.enum(["dscr", "debt_yield", "ltv", "occupancy", "net_worth"]);

const date = () => z.string().date();
const uuid = () => z.string().uuid();
// pydantic `X | None = None` on a model that is dumped in full: absent -> null
const optDate = () => date().nullable().default(null);
const optUuid = () => uuid().nullable().default(null);
const optStr = () => z.string().nullable().default(null);

export const guarantorIn = z.object({
  kind: z.enum(["person", "organization"]).default("organization"),
  person_id: optUuid(),
  organization_id: optUuid(),
  name: optStr(),
  guaranty_type: z.enum(["payment", "carveout", "completion", "environmental", "other"]).default("carveout"),
  limit_amount: z.number().min(0).nullable().default(null),
});
export type GuarantorIn = z.infer<typeof guarantorIn>;

export const stepDownIn = z.object({ until: date(), pct: z.number().min(0).max(100) });

export const prepaymentIn = z.object({
  type: z.enum(["none", "open", "lockout", "yield_maintenance", "defeasance", "step_down"]).default("none"),
  lockout_end: optDate(),
  open_from: optDate(),
  step_down: z.array(stepDownIn).default([]),
  ym_floor_pct: z.number().min(0).max(100).nullable().default(null),
  treasury_rate: z.number().min(0).max(100).nullable().default(null),
  defeasance_fee: z.number().min(0).nullable().default(null),
  notes: optStr(),
});
export type PrepaymentIn = z.infer<typeof prepaymentIn>;

export const loanCreate = z.object({
  name: z.string().max(200).nullable().default(null),
  loan_number: z.string().max(80).nullable().default(null),
  property_id: optUuid(),
  asset_id: optUuid(),
  lender_organization_id: optUuid(),
  lender_name: z.string().max(200).nullable().default(null),
  loan_type: z.string().default("senior"),
  original_balance: z.number().min(0).nullable().default(null),
  current_balance: z.number().min(0).nullable().default(null),
  originated_on: optDate(),
  maturity_on: optDate(),
  extension_options: z.array(z.record(z.string(), z.any())).default([]),
  rate_type: rateType.default("fixed"),
  rate: z.number().min(0).max(100).nullable().default(null),
  index_name: optStr(),
  spread: z.number().min(-100).max(100).nullable().default(null),
  rate_floor: z.number().min(0).max(100).nullable().default(null),
  amortization_months: z.number().int().min(0).max(600).nullable().default(null),
  io_months: z.number().int().min(0).max(600).nullable().default(null),
  recourse: recourse.default("non_recourse"),
  recourse_notes: optStr(),
  guarantors: z.array(guarantorIn).default([]),
  prepayment: prepaymentIn.default({}),
  cap_strike: z.number().min(0).max(100).nullable().default(null),
  cap_provider: optStr(),
  cap_expires_on: optDate(),
  swap_rate: z.number().min(0).max(100).nullable().default(null),
  swap_expires_on: optDate(),
  status: loanStatus.default("active"),
  owner_id: optUuid(),
  notes: optStr(),
});
export type LoanCreate = z.infer<typeof loanCreate>;

/** Partial update. Unknown keys are rejected (`extra="forbid"`); only provided keys are applied. */
export const loanUpdate = z
  .object({
    name: z.string().nullish(),
    loan_number: z.string().nullish(),
    property_id: uuid().nullish(),
    asset_id: uuid().nullish(),
    lender_organization_id: uuid().nullish(),
    lender_name: z.string().nullish(),
    loan_type: z.string().nullish(),
    original_balance: z.number().min(0).nullish(),
    current_balance: z.number().min(0).nullish(),
    originated_on: date().nullish(),
    maturity_on: date().nullish(),
    extension_options: z.array(z.record(z.string(), z.any())).nullish(),
    rate_type: rateType.nullish(),
    rate: z.number().min(0).max(100).nullish(),
    index_name: z.string().nullish(),
    spread: z.number().min(-100).max(100).nullish(),
    rate_floor: z.number().min(0).max(100).nullish(),
    amortization_months: z.number().int().min(0).max(600).nullish(),
    io_months: z.number().int().min(0).max(600).nullish(),
    recourse: recourse.nullish(),
    recourse_notes: z.string().nullish(),
    guarantors: z.array(guarantorIn).nullish(),
    prepayment: prepaymentIn.nullish(),
    cap_strike: z.number().min(0).max(100).nullish(),
    cap_provider: z.string().nullish(),
    cap_expires_on: date().nullish(),
    swap_rate: z.number().min(0).max(100).nullish(),
    swap_expires_on: date().nullish(),
    status: loanStatus.nullish(),
    owner_id: uuid().nullish(),
    notes: z.string().nullish(),
    // history context for material changes
    effective_on: date().nullish(),
    change_note: z.string().nullish(),
  })
  .strict();
export type LoanUpdate = z.infer<typeof loanUpdate>;

export const collateralIn = z.object({
  property_id: uuid(),
  allocated_amount: z.number().min(0).nullable().default(null),
  release_price: z.number().min(0).nullable().default(null),
});
export type CollateralIn = z.infer<typeof collateralIn>;

export const covenantIn = z.object({
  kind: covenantKind,
  label: optStr(),
  operator: z.enum(["min", "max"]).nullable().default(null),
  threshold: z.number(),
  watch_threshold: z.number().nullable().default(null),
  frequency: frequency.default("quarterly"),
  next_test_on: optDate(),
  cure_period_days: z.number().int().min(0).nullable().default(null),
  is_active: z.boolean().default(true),
  notes: optStr(),
});
export type CovenantIn = z.infer<typeof covenantIn>;

export const covenantTestIn = z.object({
  test_date: date().nullish(),
  manual_value: z.number().nullish(),
  notes: z.string().nullish(),
});
export type CovenantTestIn = z.infer<typeof covenantTestIn>;

export const reserveIn = z.object({
  reserve_type: z.string().default("replacement"),
  label: optStr(),
  required_amount: z.number().min(0).nullable().default(null),
  monthly_deposit: z.number().min(0).nullable().default(null),
  cap_amount: z.number().min(0).nullable().default(null),
  release_conditions: optStr(),
  notes: optStr(),
});
export type ReserveIn = z.infer<typeof reserveIn>;

export const reserveTxnIn = z.object({
  kind: z.enum(["deposit", "release", "adjustment"]),
  amount: z.number(),
  occurred_on: date(),
  document_id: optUuid(),
  memo: optStr(),
});
export type ReserveTxnIn = z.infer<typeof reserveTxnIn>;

export const obligationIn = z.object({
  report_type: z.string().default("operating_statement"),
  label: optStr(),
  frequency: frequency.default("quarterly"),
  days_after_period: z.number().int().min(0).max(365).default(45),
  next_due_on: optDate(),
  owner_id: optUuid(),
  is_active: z.boolean().default(true),
  notes: optStr(),
});
export type ObligationIn = z.infer<typeof obligationIn>;

export const submitIn = z.object({
  submitted_on: date().nullish(),
  document_id: uuid().nullish(),
  note: z.string().nullish(),
});
export type SubmitIn = z.infer<typeof submitIn>;

export const marketTerms = z.object({
  rate: z.number().min(0).max(100).default(6.5),
  ltv: z.number().min(0).max(100).default(60),
  dscr: z.number().min(0).default(1.25),
  debt_yield: z.number().min(0).max(100).default(9.0),
  amort_years: z.number().min(0).max(50).default(30),
  cap_rate: z.number().gt(0).max(100).default(7.0),
  treasury_rate: z.number().min(0).max(100).default(4.25),
  sale_cost_pct: z.number().min(0).max(100).default(2.5),
  refi_cost_pct: z.number().min(0).max(100).default(1.0),
});
export type MarketTerms = z.infer<typeof marketTerms>;

export const debtSettingsIn = z.object({
  maturity_lead_months: z.array(z.number().int()).min(1).default([24, 12, 6, 3]),
  refi_window_months: z.number().int().min(1).max(120).default(18),
  cap_lead_days: z.array(z.number().int()).min(1).default([90, 30]),
  covenant_watch_buffer_pct: z.number().min(0).max(100).default(10),
  projection_quarters: z.number().int().min(1).max(8).default(2),
  market: marketTerms.default({}),
});
export type DebtSettingsIn = z.infer<typeof debtSettingsIn>;
