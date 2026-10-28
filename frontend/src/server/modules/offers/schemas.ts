import { z } from "zod";

const structure = z.enum(["all_cash", "conventional_financing", "assumption", "seller_financing", "joint_venture", "other"]);
const outcome = z.enum(["accepted", "countered", "rejected", "expired", "withdrawn"]);

/** ISO datetime -> Date. Like pydantic, a naive timestamp is accepted (it is treated as UTC by the service). */
const datetime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) || !/T|\s\d/.test(s) ? s : `${s}Z`)), {
    message: "Input should be a valid datetime",
  })
  .transform((s) => new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) || !/T|\s\d/.test(s) ? s : `${s.replace(" ", "T")}Z`));

/** Every negotiable term; all optional so the same schema serves partial updates and counter overrides. */
const termsShape = {
  price: z.number().gt(0).nullish(),
  structure: structure.nullish(),
  earnest_money: z.number().min(0).nullish(),
  earnest_money_hard_days: z.number().int().min(0).max(3650).nullish(),
  feasibility_days: z.number().int().min(0).max(3650).nullish(),
  closing_days: z.number().int().min(0).max(3650).nullish(),
  extension_count: z.number().int().min(0).max(20).nullish(),
  extension_days: z.number().int().min(0).max(3650).nullish(),
  extension_cost: z.number().min(0).nullish(),
  financing_contingency: z.boolean().nullish(),
  financing_days: z.number().int().min(0).max(3650).nullish(),
  title_survey_days: z.number().int().min(0).max(3650).nullish(),
  title_survey_terms: z.string().nullish(),
  assignment_allowed: z.boolean().nullish(),
  assignment_terms: z.string().nullish(),
  access_terms: z.string().nullish(),
  exclusivity_days: z.number().int().min(0).max(3650).nullish(),
  expiration_at: datetime.nullish(),
  buyer_entity: z.string().max(200).nullish(),
  seller_name: z.string().max(200).nullish(),
  other_terms: z.string().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
};

export const offerTerms = z.object(termsShape).strict();
export type OfferTerms = z.infer<typeof offerTerms>;

export const offerCreate = z
  .object({
    ...termsShape,
    opportunity_id: z.string().uuid(),
    uw_model_id: z.string().uuid(),
    price: z.number().gt(0),
  })
  .strict();
export type OfferCreate = z.infer<typeof offerCreate>;

/** Create the next version. origin=seller records the counterparty's counter to our sent version verbatim;
 *  origin=buyer starts our next draft from the latest version. */
export const counterIn = z
  .object({
    ...termsShape,
    origin: z.enum(["buyer", "seller"]).default("buyer"),
    uw_model_id: z.string().uuid().nullish(),
    response_note: z.string().nullish(),
    responded_at: datetime.nullish(),
  })
  .strict();
export type CounterIn = z.infer<typeof counterIn>;

export const approvalIn = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(4000).nullish(),
});
export type ApprovalIn = z.infer<typeof approvalIn>;

export const sendIn = z.object({
  sent_to: z.string().max(300).nullish(),
  sent_via: z.string().max(60).nullish(),
  response_due_at: datetime.nullish(),
  note: z.string().nullish(),
});
export type SendIn = z.infer<typeof sendIn>;

export const respondIn = z.object({
  outcome,
  note: z.string().max(4000).nullish(),
  responded_at: datetime.nullish(),
  // When countered: the counterparty's terms (merged over this version's terms).
  counter_terms: offerTerms.nullish(),
  // When lost (rejected / expired / withdrawn) and discoverable.
  winning_price: z.number().gt(0).nullish(),
  winning_buyer: z.string().max(200).nullish(),
  winning_price_source: z.string().max(200).nullish(),
});
export type RespondIn = z.infer<typeof respondIn>;

export const winningPriceIn = z.object({
  winning_price: z.number().gt(0),
  winning_buyer: z.string().max(200).nullish(),
  winning_price_source: z.string().min(1).max(200),
});
export type WinningPriceIn = z.infer<typeof winningPriceIn>;

export const offerSettingsIn = z.object({
  price_threshold: z.number().min(0).nullable().default(null),
  deviation_threshold_pct: z.number().min(0).max(100),
  second_approval_deviation_pct: z.number().min(0).max(100),
  approval_structures: z.array(structure).default([]),
  max_feasibility_days: z.number().int().min(0).nullable().default(null),
  max_earnest_money_pct: z.number().min(0).max(100).nullable().default(null),
  require_approval_always: z.boolean().default(false),
  default_response_days: z.number().int().min(1).max(60),
});
export type OfferSettingsIn = z.infer<typeof offerSettingsIn>;

export interface TermDelta {
  field: string;
  label: string;
  from_value: any;
  to_value: any;
  change: number | null;
  change_pct: number | null;
}
