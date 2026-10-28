import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().date();

export const category = z.enum([
  "debt", "legal", "tax", "ownership", "physical", "tenancy", "behavioral", "market", "development",
]);
export const ownerKind = z.enum(["person", "organization"]);

export const signalCreate = z.object({
  property_id: uuid.nullish(),
  owner_kind: ownerKind.nullish(),
  owner_id: uuid.nullish(),
  signal_type: z.string().min(1).max(60),
  title: z.string().max(300).nullish(),
  description: z.string().nullish(),
  observed_on: isoDate,
  severity: z.number().int().min(1).max(5).nullish(),
  source: z.string().min(1).max(200),
  source_reference: z.string().max(300).nullish(),
  confidence: z.number().min(0).max(1).default(0.7),
  expires_on: isoDate.nullish(),
  is_sensitive: z.boolean().nullish(),
  verified: z.boolean().default(false),
  details: z.record(z.any()).default({}),
});
export type SignalCreate = z.infer<typeof signalCreate>;

export const signalUpdate = z
  .object({
    title: z.string().max(300).nullish(),
    description: z.string().nullish(),
    observed_on: isoDate.nullish(),
    severity: z.number().int().min(1).max(5).nullish(),
    source: z.string().min(1).max(200).nullish(),
    source_reference: z.string().max(300).nullish(),
    confidence: z.number().min(0).max(1).nullish(),
    expires_on: isoDate.nullish(),
    is_sensitive: z.boolean().nullish(),
    details: z.record(z.any()).nullish(),
  })
  .strict();
export type SignalUpdate = z.infer<typeof signalUpdate>;

export const dismissIn = z.object({ reason: z.string().min(3).max(2000) });
export const verifyIn = z.object({ state: z.enum(["verified", "rejected", "unverified"]) });

export const signalTypeIn = z.object({
  key: z.string().min(2).max(60).regex(/^[a-z0-9_]+$/),
  label: z.string().min(1).max(160),
  category,
  description: z.string().nullish(),
  default_severity: z.number().int().min(1).max(5).default(3),
  half_life_days: z.number().int().min(1).max(3650).nullish(),
  default_expiry_days: z.number().int().min(1).max(3650).nullish(),
  is_sensitive: z.boolean().default(false),
  is_active: z.boolean().default(true),
});
export type SignalTypeIn = z.infer<typeof signalTypeIn>;

export const signalTypeUpdate = z
  .object({
    label: z.string().min(1).max(160).nullish(),
    description: z.string().nullish(),
    default_severity: z.number().int().min(1).max(5).nullish(),
    half_life_days: z.number().int().min(1).max(3650).nullish(),
    default_expiry_days: z.number().int().min(1).max(3650).nullish(),
    is_sensitive: z.boolean().nullish(),
    is_active: z.boolean().nullish(),
  })
  .strict();
export type SignalTypeUpdate = z.infer<typeof signalTypeUpdate>;

export const settingsIn = z.object({
  enabled: z.boolean().nullish(),
  window_days: z.number().int().min(1).max(3650).nullish(),
  min_independent: z.number().int().min(2).max(10).nullish(),
  stack_bonus: z.number().min(0).max(2).nullish(),
  alert_min_severity: z.number().int().min(1).max(5).nullish(),
});
export type SettingsIn = z.infer<typeof settingsIn>;

export const subscriptionIn = z.object({
  name: z.string().min(1).max(160),
  categories: z.array(category).default([]),
  signal_types: z.array(z.string()).default([]),
  min_severity: z.number().int().min(1).max(5).default(1),
  property_id: uuid.nullish(),
  owner_kind: ownerKind.nullish(),
  owner_id: uuid.nullish(),
  territory_id: uuid.nullish(),
  property_types: z.array(z.string()).default([]),
  stacked_only: z.boolean().default(false),
  is_active: z.boolean().default(true),
});
export type SubscriptionIn = z.infer<typeof subscriptionIn>;
