import { z } from "zod";

const entityTypePattern = /^[a-z][a-z_]{1,39}$/;

export const linkIn = z.object({
  entity_type: z.string().regex(entityTypePattern),
  entity_id: z.string().uuid(),
});
export type LinkIn = z.infer<typeof linkIn>;

/** Partial update. Unknown keys are rejected (pydantic `extra="forbid"`); only provided keys are applied. */
export const documentUpdate = z
  .object({
    title: z.string().min(1).max(300).nullish(),
    description: z.string().nullish(),
    doc_class: z.string().nullish(),
    is_sensitive: z.boolean().nullish(),
    retention_until: z.string().date().nullish(),
    legal_hold: z.boolean().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .strict();
export type DocumentUpdate = z.infer<typeof documentUpdate>;

export const textIn = z.object({ text: z.string().max(5_000_000) });

// --- Extraction & verification ---------------------------------------------------------------

export const extractIn = z.object({
  target_entity_type: z.string().regex(entityTypePattern).nullish(),
  target_entity_id: z.string().uuid().nullish(),
  fields: z.array(z.string()).nullish(),
});
export type ExtractIn = z.infer<typeof extractIn>;

const requiredAny = z.any().refine((v) => v !== undefined, { message: "Field required" });

/** Human-abstracted value with citation; follows the same verification path as AI output. */
export const manualValueIn = z.object({
  field: z.string().min(1).max(80),
  value: requiredAny,
  value_type: z.enum(["text", "number", "money", "date", "percent"]).default("text"),
  page: z.number().int().min(1).nullish(),
  clause: z.string().max(200).nullish(),
  citation_text: z.string().nullish(),
  confidence: z.number().min(0).max(1).default(0.9),
  target_entity_type: z.string().regex(entityTypePattern).nullish(),
  target_entity_id: z.string().uuid().nullish(),
});
export type ManualValueIn = z.infer<typeof manualValueIn>;

export const confirmIn = z.object({
  accept_conflict: z.boolean().default(false),
  note: z.string().nullish(),
});
export type ConfirmIn = z.infer<typeof confirmIn>;

export const editIn = confirmIn.extend({ value: requiredAny });
export type EditIn = z.infer<typeof editIn>;

export const rejectIn = z.object({ note: z.string().nullish() });
export type RejectIn = z.infer<typeof rejectIn>;

// --- Retrieval, summaries, drafting ----------------------------------------------------------

export const citation = z.object({
  document_id: z.string().uuid().nullish(),
  page: z.number().int().nullish(),
  clause: z.string().nullish(),
  text: z.string().nullish(),
});
export type Citation = z.infer<typeof citation>;

export const summarizeIn = z.object({
  document_ids: z.array(z.string().uuid()).max(50).default([]),
  entity_type: z.string().nullish(),
  entity_id: z.string().uuid().nullish(),
  purpose: z.enum(["document_set", "deal_history", "calls", "portfolio"]).default("document_set"),
});
export type SummarizeIn = z.infer<typeof summarizeIn>;

export const draftIn = z.object({
  kind: z.enum(["outreach", "offer", "proposal", "report"]),
  entity_type: z.literal("property").default("property"),
  entity_id: z.string().uuid(),
  instructions: z.string().max(2000).nullish(),
});
export type DraftIn = z.infer<typeof draftIn>;

export interface DraftSource {
  field: string;
  value: any;
  source: string;
}

// --- Out models -------------------------------------------------------------------------------

export interface LinkOut {
  id: string;
  document_id: string;
  entity_type: string;
  entity_id: string;
  label: string | null;
  created_at: Date;
}

export interface DocumentRef {
  id: string;
  title: string;
  filename: string;
  version: number;
  created_at: Date;
}
