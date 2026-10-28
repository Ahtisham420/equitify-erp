import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().date();

const category = z.enum([
  "settlement_statement", "prorations", "insurance", "entity_standing", "lender_conditions", "tenant_notices",
  "vendors", "utilities", "other",
]);
const itemStatus = z.enum(["open", "in_progress", "done", "waived", "not_applicable"]);
const sourceKind = z.enum(["equity", "senior_debt", "mezzanine", "seller_financing", "deposit_credit", "other"]);
const useKind = z.enum([
  "purchase_price", "closing_costs", "acquisition_fee", "financing_costs", "reserves", "capex", "other",
]);

export const closingCreate = z.object({
  opportunity_id: uuid,
  scheduled_closing_on: isoDate.nullish(),
  coordinator_id: uuid.nullish(),
  manager_id: uuid.nullish(),
});
export type ClosingCreate = z.infer<typeof closingCreate>;

export const closingUpdate = z
  .object({
    scheduled_closing_on: isoDate.nullish(),
    coordinator_id: uuid.nullish(),
    manager_id: uuid.nullish(),
    hold_thesis: z.string().nullish(),
    business_plan: z.string().nullish(),
    target_hold_years: z.number().min(0).max(100).nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type ClosingUpdate = z.infer<typeof closingUpdate>;

export const sourceLine = z.object({
  label: z.string().min(1).max(200),
  kind: sourceKind.default("other"),
  amount: z.number().min(0),
});
export type SourceLine = z.infer<typeof sourceLine>;

export const useLine = z.object({
  label: z.string().min(1).max(200),
  kind: useKind.default("other"),
  amount: z.number().min(0),
  capitalized: z.boolean().default(true),
});
export type UseLine = z.infer<typeof useLine>;

export const sourcesUsesIn = z.object({
  sources: z.array(sourceLine).default([]),
  uses: z.array(useLine).default([]),
});
export type SourcesUsesIn = z.infer<typeof sourcesUsesIn>;

export const checklistItemIn = z.object({
  category: category.default("other"),
  title: z.string().min(1).max(300),
  owner_id: uuid.nullish().transform((v) => v ?? null),
  due_on: isoDate.nullish().transform((v) => v ?? null),
  is_blocking: z.boolean().default(false),
  document_id: uuid.nullish().transform((v) => v ?? null),
  notes: z.string().nullish().transform((v) => v ?? null),
});
export type ChecklistItemIn = z.infer<typeof checklistItemIn>;

export const checklistItemUpdate = z
  .object({
    category: category.nullish(),
    title: z.string().min(1).max(300).nullish(),
    owner_id: uuid.nullish(),
    due_on: isoDate.nullish(),
    status: itemStatus.nullish(),
    is_blocking: z.boolean().nullish(),
    document_id: uuid.nullish(),
    notes: z.string().nullish(),
    waived_reason: z.string().nullish(),
  })
  .strict();
export type ChecklistItemUpdate = z.infer<typeof checklistItemUpdate>;

export const wireIn = z.object({
  beneficiary_name: z.string().min(1).max(200),
  bank_name: z.string().min(1).max(200),
  routing_number: z.string().min(9).max(20),
  account_number: z.string().min(4).max(40),
  amount: z.number().gt(0).nullish().transform((v) => v ?? null),
  instruction_source: z.string().min(2).max(200),
  instruction_received_from: z.string().max(200).nullish().transform((v) => v ?? null),
  instruction_contact_phone: z.string().max(40).nullish().transform((v) => v ?? null),
  received_at: z.coerce.date().nullish(),
});
export type WireIn = z.infer<typeof wireIn>;

export const callbackIn = z.object({
  callback_phone: z.string().min(7).max(40),
  callback_phone_source: z.string().min(2).max(200),
  callback_contact_name: z.string().min(1).max(200),
  result: z.enum(["passed", "failed"]),
  result_notes: z.string().max(4000).nullish().transform((v) => v ?? null),
  verified_at: z.coerce.date().nullish(),
});
export type CallbackIn = z.infer<typeof callbackIn>;

export const completeIn = z.object({
  closed_on: isoDate,
  note: z.string().max(4000).nullish().transform((v) => v ?? null),
});
export type CompleteIn = z.infer<typeof completeIn>;

export const handoffItem = z.object({
  label: z.string().min(1).max(300),
  detail: z.string().nullish().transform((v) => v ?? null),
  document_id: uuid.nullish().transform((v) => v ?? null),
  status: z.enum(["pending", "delivered", "not_applicable"]).default("pending"),
});

export const handoffSectionIn = z.object({
  items: z.array(handoffItem).default([]),
  notes: z.string().nullish().transform((v) => v ?? null),
});

export const handoffUpdate = z.object({
  sections: z.record(z.string(), handoffSectionIn).default({}),
  recipient_id: uuid.nullish(),
});
export type HandoffUpdate = z.infer<typeof handoffUpdate>;

export const auditCompleteIn = z.object({
  findings: z.string().min(1).max(8000),
  lessons_for_acquisitions: z.string().max(8000).nullish().transform((v) => v ?? null),
});
export type AuditCompleteIn = z.infer<typeof auditCompleteIn>;

// ----- plain output shapes (response_model equivalents)

export interface Blocker {
  key: string;
  label: string;
  detail?: string | null;
}

export interface AuditMetric {
  key: string;
  label: string;
  assumed: number | null;
  actual: number | null;
  variance: number | null;
  variance_pct: number | null;
  unit: "currency" | "percent" | "ratio";
}

export interface PostCloseAuditOut {
  closing_id: string;
  asset_id: string | null;
  closed_on: string | null;
  due_on: string | null;
  period_start: string | null;
  period_end: string | null;
  months_of_data: number;
  metrics: AuditMetric[];
  notes: string[];
  completed: Record<string, any> | null;
}
