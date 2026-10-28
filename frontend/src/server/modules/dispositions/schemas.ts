import { z, type ZodTypeAny } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().date();
/** Optional field that is `null` (not absent) once parsed, like a pydantic model dumped without exclude_unset. */
const nn = <T extends ZodTypeAny>(s: T) => s.nullish().transform((v): z.infer<T> | null => v ?? null);

export const STAGE_VALUES = [
  "candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed", "withdrawn",
] as const;
const stage = z.enum(STAGE_VALUES);

export const costLine = z.object({
  label: z.string().min(1).max(160),
  amount: z.number().min(0),
});
export type CostLine = z.infer<typeof costLine>;

export const taxInputs = z.object({
  tax_basis: nn(z.number().min(0)),
  accumulated_depreciation: nn(z.number().min(0)),
  cap_gains_rate: z.number().min(0).max(100).default(20),
  recapture_rate: z.number().min(0).max(100).default(25),
  state_rate: z.number().min(0).max(100).default(0),
  niit_rate: z.number().min(0).max(100).default(3.8),
});
export type TaxInputs = z.infer<typeof taxInputs>;

export const dispositionCreate = z.object({
  asset_id: uuid,
  name: z.string().max(200).nullish(),
  owner_id: uuid.nullish(),
  reason: z.string().nullish(),
  is_1031: z.boolean().default(false),
  target_price: z.number().min(0).nullish(),
});
export type DispositionCreate = z.infer<typeof dispositionCreate>;

export const dispositionUpdate = z
  .object({
    name: z.string().max(200).nullish(),
    owner_id: uuid.nullish(),
    reason: z.string().nullish(),
    is_1031: z.boolean().nullish(),
    target_price: z.number().min(0).nullish(),
    list_price: z.number().min(0).nullish(),
    pricing_notes: z.string().nullish(),
    broker_organization_id: uuid.nullish(),
    broker_name: z.string().nullish(),
    commission_pct: z.number().min(0).max(100).nullish(),
    marketing_launched_on: isoDate.nullish(),
    offers_due_on: isoDate.nullish(),
    buyer_organization_id: uuid.nullish(),
    buyer_name: z.string().nullish(),
    contract_price: z.number().min(0).nullish(),
    contract_executed_on: isoDate.nullish(),
    dd_expires_on: isoDate.nullish(),
    target_closing_on: isoDate.nullish(),
    closed_on: isoDate.nullish(),
    sale_price: z.number().min(0).nullish(),
    cost_lines: z.array(costLine).nullish(),
    tax_inputs: taxInputs.nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type DispositionUpdate = z.infer<typeof dispositionUpdate>;

export const moveIn = z.object({
  to_stage: stage,
  reason: z.string().nullish(),
  override: z.boolean().default(false),
});
export type MoveIn = z.infer<typeof moveIn>;

export const compareIn = z.object({
  value: nn(z.number().min(0)),
  noi: nn(z.number()),
  noi_growth_pct: z.number().min(-50).max(50).default(2.0),
  hold_years: z.number().int().min(1).max(30).default(5),
  exit_cap_rate: nn(z.number().gt(0).max(100)),
  discount_rate: z.number().min(0).max(100).default(8.0),
  sale_cost_pct: nn(z.number().min(0).max(100)),
  capex_planned: z.number().min(0).default(0),
  remaining_lease_term_years: nn(z.number().min(0)),
  tax_basis: nn(z.number().min(0)),
  accumulated_depreciation: nn(z.number().min(0)),
  land_pct: z.number().min(0).max(100).default(20),
  depreciation_years: z.number().gt(0).max(100).default(39),
  cap_gains_rate: z.number().min(0).max(100).default(20),
  recapture_rate: z.number().min(0).max(100).default(25),
  state_rate: z.number().min(0).max(100).default(0),
  niit_rate: z.number().min(0).max(100).default(3.8),
  refi_rate: nn(z.number().min(0).max(100)),
  refi_ltv: nn(z.number().min(0).max(100)),
  refi_dscr: nn(z.number().min(0)),
  refi_debt_yield: nn(z.number().min(0).max(100)),
  refi_amort_years: nn(z.number().min(0).max(50)),
  refi_cost_pct: nn(z.number().min(0).max(100)),
  treasury_rate: nn(z.number().min(0).max(100)),
});
export type CompareIn = z.infer<typeof compareIn>;

export const offerIn = z.object({
  buyer_name: z.string().min(1).max(200),
  buyer_organization_id: nn(uuid),
  buyer_person_id: nn(uuid),
  broker_name: nn(z.string()),
  price: z.number().gt(0),
  earnest_money: nn(z.number().min(0)),
  dd_days: nn(z.number().int().min(0).max(365)),
  closing_days: nn(z.number().int().min(0).max(730)),
  financing_type: z.enum(["cash", "new_loan", "assumption", "seller_financing"]).default("cash"),
  contingencies: nn(z.string()),
  received_on: isoDate,
  expires_on: nn(isoDate),
  status: z.enum(["received", "countered", "best_and_final", "backup", "rejected", "withdrawn"]).default("received"),
  notes: nn(z.string()),
});
export type OfferIn = z.infer<typeof offerIn>;

const retradeReason = z.enum([
  "inspection", "environmental", "title_survey", "financing", "appraisal", "tenant", "market", "other",
]);

export const retradeIn = z.object({
  offer_id: nn(uuid),
  buyer_name: nn(z.string()),
  buyer_organization_id: nn(uuid),
  requested_on: isoDate,
  reason_category: retradeReason.default("other"),
  reason: z.string().min(3),
  amount_requested: z.number().min(0),
  notes: nn(z.string()),
});
export type RetradeIn = z.infer<typeof retradeIn>;

export const retradeDecisionIn = z.object({
  decision: z.enum(["pending", "accepted", "countered", "rejected"]).nullish(),
  agreed_amount: z.number().min(0).nullish(),
  outcome: z.enum(["pending", "closed", "buyer_walked", "seller_terminated"]).nullish(),
  notes: z.string().nullish(),
});
export type RetradeDecisionIn = z.infer<typeof retradeDecisionIn>;

/** Only the keys the client sent are applied (pydantic `exclude_unset`), so nothing here has a default. */
export const exchangeIn = z.object({
  exchange_type: z.enum(["forward", "reverse", "improvement"]).optional(),
  status: z.enum(["planned", "open", "identified", "completed", "failed", "cancelled"]).nullish(),
  qi_organization_id: uuid.nullish(),
  qi_name: z.string().nullish(),
  eat_organization_id: uuid.nullish(),
  parked_property_id: uuid.nullish(),
  start_on: isoDate.nullish(),
  tax_return_due_on: isoDate.nullish(),
  identification_rule: z.enum(["three_property", "two_hundred_percent", "ninety_five_percent"]).optional(),
  relinquished_sale_price: z.number().min(0).nullish(),
  relinquished_costs: z.number().min(0).nullish(),
  relinquished_debt_paid: z.number().min(0).nullish(),
  relinquished_adjusted_basis: z.number().min(0).nullish(),
  cash_received: z.number().min(0).nullish(),
  additional_cash_invested: z.number().min(0).nullish(),
  improvement_budget: z.number().min(0).nullish(),
  improvement_notes: z.string().nullish(),
  notes: z.string().nullish(),
});
export type ExchangeIn = z.infer<typeof exchangeIn>;

export const candidateIn = z.object({
  property_id: nn(uuid),
  description: nn(z.string().max(300)),
  is_backup: z.boolean().default(false),
  rank: z.number().int().min(1).max(50).default(1),
  status: z.enum(["candidate", "identified", "under_contract", "acquired", "dropped"]).default("candidate"),
  expected_price: nn(z.number().min(0)),
  expected_debt: nn(z.number().min(0)),
  acquired_on: nn(isoDate),
  acquired_price: nn(z.number().min(0)),
  acquired_debt: nn(z.number().min(0)),
  notes: nn(z.string()),
});
export type CandidateIn = z.infer<typeof candidateIn>;

// ----- plain output shapes

export interface Requirement {
  key: string;
  label: string;
  met: boolean;
  blocking: boolean;
  detail: string | null;
}
