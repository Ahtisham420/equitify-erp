import { z } from "zod";

// --- Integrations ----------------------------------------------------------------------------------

export const integrationCreate = z.object({
  category: z.string(),
  provider: z.string().min(1).max(80),
  label: z.string().max(160).nullish(),
  config: z.record(z.string(), z.any()).default({}),
  credentials: z.record(z.string(), z.string()).default({}),
  usage_restrictions: z.string().nullish(),
  is_primary: z.boolean().default(false),
});
export type IntegrationCreate = z.infer<typeof integrationCreate>;

export const integrationUpdate = z
  .object({
    label: z.string().nullish(),
    status: z.enum(["not_configured", "manual", "active", "disabled"]).nullish(),
    config: z.record(z.string(), z.any()).nullish(),
    usage_restrictions: z.string().nullish(),
    is_primary: z.boolean().nullish(),
  })
  .strict();
export type IntegrationUpdate = z.infer<typeof integrationUpdate>;

/** Rotation: non-empty values replace/add keys, `remove_keys` deletes keys, other stored keys are kept. */
export const credentialsIn = z.object({
  credentials: z.record(z.string(), z.string()).default({}),
  remove_keys: z.array(z.string()).default([]),
  reason: z.string().nullish(),
});
export type CredentialsIn = z.infer<typeof credentialsIn>;

// --- Feature flags -------------------------------------------------------------------------------

export const flagCreate = z.object({
  key: z.string().min(2).max(80).regex(/^[a-z0-9_.\-]+$/),
  description: z.string().nullish(),
  enabled: z.boolean().default(false),
  is_sensitive: z.boolean().default(false),
  rollout_roles: z.array(z.string()).default([]),
  rollout_user_ids: z.array(z.string().uuid()).default([]),
});
export type FlagCreate = z.infer<typeof flagCreate>;

export const flagUpdate = z
  .object({
    description: z.string().nullish(),
    enabled: z.boolean().nullish(),
    is_sensitive: z.boolean().nullish(),
    rollout_roles: z.array(z.string()).nullish(),
    rollout_user_ids: z.array(z.string().uuid()).nullish(),
    reason: z.string().max(500).nullish(),
  })
  .strict();
export type FlagUpdate = z.infer<typeof flagUpdate>;

// --- Webhooks ------------------------------------------------------------------------------------

export const subscriptionCreate = z.object({
  name: z.string().min(1).max(160),
  url: z.string().min(8).max(1000).regex(/^https?:\/\//),
  events: z.array(z.string()).min(1),
  active: z.boolean().default(true),
});
export type SubscriptionCreate = z.infer<typeof subscriptionCreate>;

export const subscriptionUpdate = z
  .object({
    name: z.string().max(160).nullish(),
    url: z.string().max(1000).regex(/^https?:\/\//).nullish(),
    events: z.array(z.string()).nullish(),
    active: z.boolean().nullish(),
  })
  .strict();
export type SubscriptionUpdate = z.infer<typeof subscriptionUpdate>;

export interface DeliverResult {
  attempted: number;
  delivered: number;
  failed: number;
  dead: number;
}

// --- Retention / legal hold ----------------------------------------------------------------------

export const retentionIn = z.object({
  entity_type: z.string().min(1).max(60),
  retain_days: z.number().int().min(1).max(36500),
  action: z.enum(["review", "archive"]).default("review"),
  description: z.string().nullish(),
  is_active: z.boolean().default(true),
});
export type RetentionIn = z.infer<typeof retentionIn>;

export const holdIn = z.object({
  entity_type: z.string().min(1).max(60),
  entity_id: z.string().uuid().nullish(),
  reason: z.string().min(3),
  matter: z.string().max(200).nullish(),
});
export type HoldIn = z.infer<typeof holdIn>;

export const releaseIn = z.object({ reason: z.string().min(3) });
export type ReleaseIn = z.infer<typeof releaseIn>;

// --- Backups -------------------------------------------------------------------------------------

export const backupIn = z.object({
  kind: z.enum(["backup", "restore_test"]),
  environment: z.enum(["production", "staging", "development"]).default("production"),
  performed_at: z.coerce.date().nullish(),
  reference: z.string().max(300).nullish(),
  encrypted: z.boolean().default(true),
  point_in_time: z.boolean().default(false),
  size_bytes: z.number().int().min(0).nullish(),
  rpo_target_minutes: z.number().int().min(0).nullish(),
  rto_target_minutes: z.number().int().min(0).nullish(),
  achieved_rpo_minutes: z.number().min(0).nullish(),
  achieved_rto_minutes: z.number().min(0).nullish(),
  result: z.enum(["success", "partial", "failed"]).default("success"),
  notes: z.string().nullish(),
});
export type BackupIn = z.infer<typeof backupIn>;

// --- AI ------------------------------------------------------------------------------------------

export const nlQueryIn = z.object({
  question: z.string().min(3).max(500),
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(100).default(25),
});
export type NLQueryIn = z.infer<typeof nlQueryIn>;

/** Exactly the PropertyFilters fields the AI may set (ids excluded). */
export const nlFilters = z.object({
  q: z.string().nullish(),
  status: z.array(z.string()).nullish(),
  property_type: z.array(z.string()).nullish(),
  state: z.array(z.string()).nullish(),
  county: z.string().nullish(),
  city: z.string().nullish(),
  tag: z.array(z.string()).nullish(),
  min_area: z.number().nullish(),
  max_area: z.number().nullish(),
  min_acres: z.number().nullish(),
  max_acres: z.number().nullish(),
  min_price: z.number().nullish(),
  max_price: z.number().nullish(),
  min_year: z.number().int().nullish(),
  max_year: z.number().int().nullish(),
  min_completeness: z.number().nullish(),
  near_lat: z.number().min(-90).max(90).nullish(),
  near_lng: z.number().min(-180).max(180).nullish(),
  radius_miles: z.number().gt(0).max(200).nullish(),
  sort: z.string().nullish(),
});
export type NLFilters = z.infer<typeof nlFilters>;

export const acceptIn = z.object({
  title: z.string().max(300).nullish(),
  due_at: z.coerce.date().nullish(),
  assignee_id: z.string().uuid().nullish(),
});
export type AcceptIn = z.infer<typeof acceptIn>;
