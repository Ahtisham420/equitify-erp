import { z } from "zod";

const role = z.enum([
  "owner", "principal", "broker", "agent", "tenant_contact", "vendor_contact", "lender", "attorney",
  "title_officer", "capital_partner", "other",
]);
const strength = z.enum(["none", "weak", "moderate", "strong"]);
const responsiveness = z.enum(["unknown", "low", "medium", "high"]);
const entityType = z.enum(["person", "organization"]);
const phoneType = z.enum(["mobile", "landline", "voip", "fax", "unknown"]);
const uuid = z.string().uuid();
const date = z.string().date();
const dict = z.record(z.string(), z.any());

// ---------------------------------------------------------------- contact points / affiliations / enrichment

export const contactPointIn = z.object({
  kind: z.enum(["phone", "email"]),
  value: z.string().min(3).max(255),
  label: z.string().max(60).nullish(),
  phone_type: phoneType.nullish(),
  is_primary: z.boolean().default(false),
  source: z.string().max(200).nullish(),
  observed_on: date.nullish(),
});
export type ContactPointIn = z.infer<typeof contactPointIn>;

export const contactPointUpdate = z
  .object({
    value: z.string().min(3).max(255).nullish(),
    label: z.string().nullish(),
    phone_type: phoneType.nullish(),
    is_primary: z.boolean().nullish(),
    source: z.string().nullish(),
  })
  .strict();
export type ContactPointUpdate = z.infer<typeof contactPointUpdate>;

export const affiliationIn = z.object({
  person_id: uuid,
  organization_id: uuid,
  role,
  title: z.string().max(160).nullish(),
  is_current: z.boolean().default(true),
  started_on: date.nullish(),
  ended_on: date.nullish(),
  source: z.string().nullish(),
  notes: z.string().nullish(),
});
export type AffiliationIn = z.infer<typeof affiliationIn>;

export const affiliationUpdate = z
  .object({
    role: role.nullish(),
    title: z.string().nullish(),
    is_current: z.boolean().nullish(),
    started_on: date.nullish(),
    ended_on: date.nullish(),
    source: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type AffiliationUpdate = z.infer<typeof affiliationUpdate>;

export const enrichmentIn = z.object({
  provider: z.string().min(1).max(120),
  enriched_at: z.coerce.date().nullish(),
  cost: z.number().min(0).nullish(),
  reliability: z.number().min(0).max(1).nullish(),
  fields: z.array(z.string()).default([]),
  restrictions: dict.default({}),
  notes: z.string().nullish(),
});
export type EnrichmentIn = z.infer<typeof enrichmentIn>;

// ---------------------------------------------------------------- people

const personBase = {
  first_name: z.string().max(120).nullish(),
  last_name: z.string().max(120).nullish(),
  full_name: z.string().max(240).nullish(),
  title: z.string().max(160).nullish(),
  mailing_address: z.string().max(255).nullish(),
  city: z.string().nullish(),
  state: z.string().max(40).nullish(),
  postal_code: z.string().nullish(),
  contact_preferences: dict.default({}),
  owner_id: uuid.nullish(),
  next_action: z.string().max(300).nullish(),
  next_action_at: z.coerce.date().nullish(),
  responsiveness: responsiveness.default("unknown"),
  relationship_strength: strength.default("none"),
  preferences: dict.default({}),
  source: z.string().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};

export const personCreate = z.object({
  ...personBase,
  emails: z.array(z.string()).default([]),
  phones: z.array(z.string()).default([]),
});
export type PersonCreate = z.infer<typeof personCreate>;

export const personUpdate = z
  .object({
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    full_name: z.string().nullish(),
    title: z.string().nullish(),
    mailing_address: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    postal_code: z.string().nullish(),
    contact_preferences: dict.nullish(),
    owner_id: uuid.nullish(),
    next_action: z.string().nullish(),
    next_action_at: z.coerce.date().nullish(),
    responsiveness: responsiveness.nullish(),
    relationship_strength: strength.nullish(),
    preferences: dict.nullish(),
    source: z.string().nullish(),
    notes: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .strict();
export type PersonUpdate = z.infer<typeof personUpdate>;

// ---------------------------------------------------------------- organizations

const orgBase = {
  name: z.string().min(1).max(240),
  legal_name: z.string().max(240).nullish(),
  org_type: z.string().default("other"),
  website: z.string().max(255).nullish(),
  domain: z.string().max(160).nullish(),
  phone: z.string().max(40).nullish(),
  mailing_address: z.string().max(255).nullish(),
  city: z.string().nullish(),
  state: z.string().max(40).nullish(),
  postal_code: z.string().nullish(),
  state_of_formation: z.string().nullish(),
  registered_agent: z.string().max(240).nullish(),
  owner_id: uuid.nullish(),
  next_action: z.string().nullish(),
  next_action_at: z.coerce.date().nullish(),
  responsiveness: responsiveness.default("unknown"),
  relationship_strength: strength.default("none"),
  preferences: dict.default({}),
  source: z.string().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};

export const organizationCreate = z.object(orgBase);
export type OrganizationCreate = z.infer<typeof organizationCreate>;

export const organizationUpdate = z
  .object({
    name: z.string().min(1).max(240).nullish(),
    legal_name: z.string().nullish(),
    org_type: z.string().nullish(),
    website: z.string().nullish(),
    domain: z.string().nullish(),
    phone: z.string().nullish(),
    mailing_address: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    postal_code: z.string().nullish(),
    state_of_formation: z.string().nullish(),
    registered_agent: z.string().nullish(),
    owner_id: uuid.nullish(),
    next_action: z.string().nullish(),
    next_action_at: z.coerce.date().nullish(),
    responsiveness: responsiveness.nullish(),
    relationship_strength: strength.nullish(),
    preferences: dict.nullish(),
    source: z.string().nullish(),
    notes: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .strict();
export type OrganizationUpdate = z.infer<typeof organizationUpdate>;

export const bulkIn = z.object({
  ids: z.array(uuid).min(1).max(500),
  owner_id: uuid.nullish(),
  relationship_strength: strength.nullish(),
  add_tags: z.array(z.string()).default([]),
  remove_tags: z.array(z.string()).default([]),
});
export type BulkIn = z.infer<typeof bulkIn>;

// ---------------------------------------------------------------- duplicates / merges

export const mergeIn = z.object({
  entity_type: entityType,
  survivor_id: uuid,
  merged_id: uuid,
  take_from_merged: z.array(z.string()).default([]),
  review_id: uuid.nullish(),
  reason: z.string().nullish(),
});
export type MergeIn = z.infer<typeof mergeIn>;
