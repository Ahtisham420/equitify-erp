import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().date();

const side = z.enum(["listing", "buyer", "tenant", "landlord", "dual", "other"]);

// Python dumps unset optionals as null; keep stored participant/deduction JSON the same shape.
export const participant = z
  .object({
    agent_id: uuid,
    share_pct: z.number().gt(0).max(100).default(100),
    override_agent_pct: z.number().min(0).max(100).nullish(), // per-deal override of the plan
  })
  .transform((v) => ({ agent_id: v.agent_id, share_pct: v.share_pct, override_agent_pct: v.override_agent_pct ?? null }));

export const deduction = z
  .object({
    label: z.string().min(1).max(120),
    amount: z.number().min(0),
    agent_id: uuid.nullish(), // null -> charged to the primary agent
  })
  .transform((v) => ({ label: v.label, amount: v.amount, agent_id: v.agent_id ?? null }));

export const commissionCreate = z.object({
  brokerage_deal_id: uuid.nullish(),
  title: z.string().max(255).nullish(),
  agent_id: uuid.nullish(),
  property_id: uuid.nullish(),
  property_type: z.string().nullish(),
  source: z.string().nullish(),
  side: side.nullish(),
  deal_volume: z.number().min(0).nullish(),
  gross: z.number().min(0),
  probability: z.number().min(0).max(100).nullish(),
  expected_close_on: date.nullish(),
  expected_on: date.nullish(),
  split_plan_id: uuid.nullish(),
  participants: z.array(participant).default([]),
  referral_party: z.string().max(200).nullish(),
  referral_pct: z.number().min(0).max(100).nullish(),
  referral_amount: z.number().min(0).nullish(),
  deductions: z.array(deduction).default([]),
  notes: z.string().nullish(),
});
export type CommissionCreate = z.infer<typeof commissionCreate>;

export const commissionUpdate = z
  .object({
    title: z.string().max(255).nullish(),
    agent_id: uuid.nullish(),
    property_id: uuid.nullish(),
    property_type: z.string().nullish(),
    source: z.string().nullish(),
    side: side.nullish(),
    deal_volume: z.number().min(0).nullish(),
    gross: z.number().min(0).nullish(),
    probability: z.number().min(0).max(100).nullish(),
    expected_close_on: date.nullish(),
    expected_on: date.nullish(),
    split_plan_id: uuid.nullish(),
    participants: z.array(participant).nullish(),
    referral_party: z.string().nullish(),
    referral_pct: z.number().min(0).max(100).nullish(),
    referral_amount: z.number().min(0).nullish(),
    deductions: z.array(deduction).nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type CommissionUpdate = z.infer<typeof commissionUpdate>;

export const earnIn = z.object({
  earned_on: date.nullish(),
  note: z.string().nullish(),
});
export type EarnIn = z.infer<typeof earnIn>;

export const noteIn = z.object({ note: z.string().nullish() });

export const cancelIn = z.object({ reason: z.string().min(3) });

export const invoiceCreate = z.object({
  bill_to: z.string().min(1).max(300),
  issued_on: date.nullish(),
  due_on: date.nullish(),
  amount: z.number().gt(0).nullish(),
  memo: z.string().nullish(),
});
export type InvoiceCreate = z.infer<typeof invoiceCreate>;

export const voidIn = z.object({ reason: z.string().min(3) });

export const paymentCreate = z.object({
  amount: z.number().gt(0),
  received_on: date,
  invoice_id: uuid.nullish(),
  reference: z.string().max(120).nullish(),
  method: z.string().max(40).nullish(),
  note: z.string().nullish(),
});
export type PaymentCreate = z.infer<typeof paymentCreate>;

export const releaseIn = z.object({
  accept_discrepancy: z.boolean().default(false),
  note: z.string().nullish(),
});
export type ReleaseIn = z.infer<typeof releaseIn>;

export const planTier = z
  .object({
    min_ytd_gci: z.number().min(0),
    agent_pct: z.number().min(0).max(100),
  });

export const planIn = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullish(),
  tiers: z.array(planTier).min(1).max(20),
  annual_cap: z.number().min(0).nullish(),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
});
export type PlanIn = z.infer<typeof planIn>;

export const agentPlanIn = z.object({
  plan_id: uuid.nullable(), // null removes the assignment (agent falls back to the default plan)
  effective_from: date.nullish(),
});
export type AgentPlanIn = z.infer<typeof agentPlanIn>;
