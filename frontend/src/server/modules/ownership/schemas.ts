import { z } from "zod";

const ownerKind = z.enum(["person", "organization"]);
const relationship = z.enum([
  "manager", "member", "officer", "director", "registered_agent", "parent", "affiliate", "family", "advisor",
]);
const evidenceType = z.enum([
  "shared_mailing_address", "shared_phone", "shared_email_domain", "registered_agent", "officer_director_record",
  "deed_signatory", "corroborated_name", "other",
]);
const uuid = z.string().uuid();
const date = z.string().date();

export const evidenceItem = z.object({
  type: evidenceType,
  detail: z.string().max(500).nullish(),
  source: z.string().max(200).nullish(),
  observed_on: date.nullish(),
  sensitive: z.boolean().default(false),
});
export type EvidenceItem = z.infer<typeof evidenceItem>;

/** Stored shape of an evidence entry (pydantic `model_dump(mode="json")` keeps every field, nulls included). */
export const evidenceJson = (e: EvidenceItem) => ({
  type: e.type,
  detail: e.detail ?? null,
  source: e.source ?? null,
  observed_on: e.observed_on ?? null,
  sensitive: e.sensitive ?? false,
});

// ---------------------------------------------------------------- interests

export const interestIn = z.object({
  property_id: uuid,
  owner_kind: ownerKind,
  owner_id: uuid,
  interest_pct: z.number().gt(0).max(100).nullish(),
  role: z.string().default("fee_owner"),
  effective_from: date.nullish(),
  effective_to: date.nullish(),
  acquired_price: z.number().min(0).nullish(),
  financing_type: z.string().nullish(),
  deed_reference: z.string().max(120).nullish(),
  evidence: z.array(evidenceItem).default([]),
  source: z.string().max(200).default("Manual entry"),
  observed_on: date.nullish(),
  confidence: z.number().min(0).max(1).default(0.8),
  verified: z.boolean().default(false),
  notes: z.string().nullish(),
});
export type InterestIn = z.infer<typeof interestIn>;

export const interestUpdate = z
  .object({
    interest_pct: z.number().gt(0).max(100).nullish(),
    role: z.string().nullish(),
    effective_from: date.nullish(),
    acquired_price: z.number().min(0).nullish(),
    financing_type: z.string().nullish(),
    deed_reference: z.string().nullish(),
    evidence: z.array(evidenceItem).nullish(),
    source: z.string().max(200).nullish(),
    observed_on: date.nullish(),
    confidence: z.number().min(0).max(1).nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type InterestUpdate = z.infer<typeof interestUpdate>;

export const endInterestIn = z.object({
  effective_to: date,
  disposed_price: z.number().min(0).nullish(),
  reason: z.string().max(200).nullish(),
  source: z.string().max(200).default("Manual entry"),
});
export type EndInterestIn = z.infer<typeof endInterestIn>;

export const verifyIn = z.object({ state: z.enum(["verified", "rejected", "unverified"]) });

// ---------------------------------------------------------------- links

export const linkIn = z.object({
  from_kind: ownerKind,
  from_id: uuid,
  to_kind: ownerKind,
  to_id: uuid,
  relationship,
  confidence: z.number().min(0).max(1).default(0.8),
  evidence: z.array(evidenceItem).default([]),
  source: z.string().max(200).default("Manual entry"),
  effective_from: date.nullish(),
  notes: z.string().nullish(),
  confirmed: z.boolean().default(true),
});
export type LinkIn = z.infer<typeof linkIn>;

export const linkUpdate = z
  .object({
    relationship: relationship.nullish(),
    confidence: z.number().min(0).max(1).nullish(),
    evidence: z.array(evidenceItem).nullish(),
    effective_from: date.nullish(),
    effective_to: date.nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type LinkUpdate = z.infer<typeof linkUpdate>;

export const linkReviewIn = z.object({
  relationship: relationship.nullish(),
  reverse: z.boolean().default(false),
  note: z.string().max(1000).nullish(),
});
export type LinkReviewIn = z.infer<typeof linkReviewIn>;

// ---------------------------------------------------------------- notes

export const noteIn = z.object({
  category: z.string().default("other"),
  body: z.string().min(1).max(5000),
  sensitive: z.boolean().default(false),
  source: z.string().nullish(),
  observed_on: date.nullish(),
});
export type NoteIn = z.infer<typeof noteIn>;
