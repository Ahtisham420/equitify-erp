import { z } from "zod";

const uuid = () => z.string().uuid();
const date = () => z.string().date();

export interface Buckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
}
export const emptyBuckets = (): Buckets => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 });

// --------------------------------------------------------------------------- charges

export const manualChargeIn = z.object({
  lease_id: uuid(),
  charge_type: z.string().min(1).max(30),
  amount: z.number(),
  due_on: date(),
  period_start: date().nullish(),
  period_end: date().nullish(),
  description: z.string().min(1).max(300),
});
export type ManualChargeIn = z.infer<typeof manualChargeIn>;

export const generateIn = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  property_id: uuid().nullish(),
  lease_ids: z.array(uuid()).nullish(),
});
export type GenerateIn = z.infer<typeof generateIn>;

export interface GenerateOut {
  period: string;
  created: number;
  existing: number;
  skipped_unverified: number;
  leases: number;
  amount: number;
}

export const voidIn = z.object({ reason: z.string().min(3).max(300) });
export type VoidIn = z.infer<typeof voidIn>;

// --------------------------------------------------------------------------- payments

export const allocationIn = z.object({ charge_id: uuid(), amount: z.number().gt(0) });
export type AllocationIn = z.infer<typeof allocationIn>;

export const paymentIn = z.object({
  lease_id: uuid(),
  received_on: date(),
  amount: z.number().gt(0),
  method: z.enum(["ach", "check", "wire", "card", "cash", "other"]).default("ach"),
  reference: z.string().max(120).nullish(),
  notes: z.string().nullish(),
  auto_apply: z.boolean().default(true),
  allocations: z.array(allocationIn).default([]),
});
export type PaymentIn = z.infer<typeof paymentIn>;

export const applyIn = z.object({ allocations: z.array(allocationIn).default([]) }); // empty -> oldest-first auto-apply
export type ApplyIn = z.infer<typeof applyIn>;

export const unapplyIn = z.object({ application_id: uuid(), reason: z.string().min(3).max(300) });
export type UnapplyIn = z.infer<typeof unapplyIn>;

// --------------------------------------------------------------------------- delinquency / settings

export const ladderStep = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(160),
  days_past_due: z.number().int().min(0).max(3650),
  min_balance: z.number().min(0).default(0),
  create_task: z.boolean().default(true),
  task_priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  collection_status: z.enum(["delinquent", "legal"]).default("delinquent"),
  subject: z.string(),
  body: z.string(),
});
export type LadderStep = z.infer<typeof ladderStep>;

export const lateFeeDefaults = z.object({
  grace_days: z.number().int().min(0).max(90).default(5),
  pct: z.number().min(0).max(100).nullable().default(5.0),
  flat: z.number().min(0).nullable().default(null),
  charge_types: z.array(z.string()).default(["base_rent", "recovery", "cam", "tax", "insurance", "fixed_cam"]),
});
export type LateFeeDefaults = z.infer<typeof lateFeeDefaults>;

export interface SettingsOut {
  late_fee_defaults: LateFeeDefaults;
  ladder: LadderStep[];
  alert_days: number;
}

export const settingsIn = z.object({
  late_fee_defaults: lateFeeDefaults.nullish(),
  ladder: z.array(ladderStep).nullish(),
  alert_days: z.number().int().min(1).max(3650).nullish(),
});
export type SettingsIn = z.infer<typeof settingsIn>;

/** Every field is defaulted so the scheduler can call `evaluateIn.parse({})`. */
export const evaluateIn = z.object({
  as_of: date().nullish().default(null),
  property_id: uuid().nullish().default(null),
});
export type EvaluateIn = z.infer<typeof evaluateIn>;

export interface EvaluateOut {
  evaluated: number;
  escalated: number;
  resolved: number;
  notices: number;
  breached_plans: number;
  late_fees: number;
}

export const noticeCreate = z.object({ lease_id: uuid(), step_key: z.string() });
export type NoticeCreate = z.infer<typeof noticeCreate>;

export const noticeSendIn = z.object({
  delivery_method: z.enum(["email", "mail", "certified_mail", "hand", "portal"]).default("email"),
});
export type NoticeSendIn = z.infer<typeof noticeSendIn>;

// --------------------------------------------------------------------------- payment plans

export const planIn = z.object({
  lease_id: uuid(),
  total_amount: z.number().gt(0).nullish(),
  start_on: date(),
  installment_count: z.number().int().min(1).max(60),
  frequency_months: z.number().int().min(1).max(12).default(1),
  grace_days: z.number().int().min(0).max(60).default(5),
  notes: z.string().nullish(),
});
export type PlanIn = z.infer<typeof planIn>;

// --------------------------------------------------------------------------- reconciliation billing

export const reconBillIn = z.object({
  reconciliation_ids: z.array(uuid()).min(1).max(500),
  due_on: date(),
});
export type ReconBillIn = z.infer<typeof reconBillIn>;

export interface ReconBillOut {
  billed: number;
  skipped: number;
  amount: number;
}

// --------------------------------------------------------------------------- sync

export const exportIn = z.object({
  system: z.string().min(1).max(80),
  period_from: date(),
  period_to: date(),
  property_id: uuid().nullish(),
});
export type ExportIn = z.infer<typeof exportIn>;

export const externalEntry = z.object({
  external_id: z.string().min(1).max(120),
  kind: z.enum(["charge", "payment"]),
  local_id: uuid().nullish(),
  lease_id: uuid().nullish(),
  amount: z.number().nullish(),
  entry_date: date().nullish(),
  status: z.string().nullish(),
  reference: z.string().nullish(),
});
export type ExternalEntry = z.infer<typeof externalEntry>;

export const importIn = z.object({
  system: z.string().min(1).max(80),
  external_batch_id: z.string().nullish(),
  entries: z.array(externalEntry).min(1).max(5000),
});
export type ImportIn = z.infer<typeof importIn>;

export const resolveIn = z.object({
  resolution: z.enum(["accept_external", "keep_local", "dismissed"]),
  note: z.string().max(300).nullish(),
});
export type ResolveIn = z.infer<typeof resolveIn>;
