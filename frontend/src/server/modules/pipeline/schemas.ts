import { z } from "zod";

export const stage = z.enum([
  "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
  "under_contract", "due_diligence", "closing", "closed", "dead", "nurture",
]);
const priority = z.enum(["low", "normal", "high", "urgent"]);
const deadReason = z.enum([
  "price_gap", "owner_not_selling", "failed_buybox", "title_or_survey", "financing", "competition", "timing", "other",
]);

/** ISO datetime (naive values are taken as UTC) -> Date. */
const dt = z
  .string()
  .refine((s) => !Number.isNaN(new Date(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s}Z` : s).getTime()), "Input should be a valid datetime")
  .transform((s) => new Date(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s}Z` : s));
const day = z.string().date();

/** Editable fields. Stage changes go through POST /opportunities/{id}/move. Unknown keys are rejected. */
export const opportunityUpdate = z
  .object({
    title: z.string().min(1).max(255).nullish(),
    owner_id: z.string().uuid().nullish(),
    primary_person_id: z.string().uuid().nullish(),
    primary_organization_id: z.string().uuid().nullish(),
    priority: priority.nullish(),
    source: z.string().max(80).nullish(),
    next_action: z.string().max(300).nullish(),
    next_action_at: dt.nullish(),
    research_missing_fields: z.array(z.string()).nullish(),
    research_notes: z.string().nullish(),
    estimated_value: z.number().min(0).nullish(),
    cap_rate: z.number().min(0).max(100).nullish(),
    underwriting_notes: z.string().nullish(),
    price_expectation: z.number().min(0).nullish(),
    offer_price: z.number().min(0).nullish(),
    offer_sent_at: dt.nullish(),
    response_due_at: dt.nullish(),
    contract_executed_on: day.nullish(),
    dd_deadline: day.nullish(),
    closing_date: day.nullish(),
    closed_price: z.number().min(0).nullish(),
    closed_on: day.nullish(),
    dead_reason: deadReason.nullish(),
    dead_notes: z.string().nullish(),
    price_gap: z.number().nullish(),
    reactivation_rule: z.record(z.string(), z.any()).nullish(),
    next_touch_on: day.nullish(),
    nurture_cadence_days: z.number().int().min(1).max(3650).nullish(),
    notes: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .strict();
export type OpportunityUpdate = z.infer<typeof opportunityUpdate>;

export const opportunityCreate = z.object({
  title: z.string().max(255).nullish(),
  property_id: z.string().uuid(),
  owner_id: z.string().uuid().nullish(),
  primary_person_id: z.string().uuid().nullish(),
  primary_organization_id: z.string().uuid().nullish(),
  priority: priority.default("normal"),
  source: z.string().max(80).nullish(),
  next_action: z.string().max(300).nullish(),
  next_action_at: dt.nullish(),
  price_expectation: z.number().min(0).nullish(),
  estimated_value: z.number().min(0).nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  override_reason: z.string().max(2000).nullish(),
});
export type OpportunityCreate = z.infer<typeof opportunityCreate>;

export const moveIn = z.object({
  to_stage: stage,
  fields: opportunityUpdate.default({}),
  override_reason: z.string().max(2000).nullish(),
});
export type MoveIn = z.infer<typeof moveIn>;

export const stageSettingsIn = z.object({ stall_days: z.record(z.string(), z.number().int()) });
export type StageSettingsIn = z.infer<typeof stageSettingsIn>;

/** Stage entry requirement (response shape of GET /opportunities/{id}/gates). */
export interface Requirement {
  key: string;
  label: string;
  met: boolean;
  blocking: boolean;
  detail: string | null;
  fields: string[];
}
