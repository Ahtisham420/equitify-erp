import { z } from "zod";

const channel = z.enum(["phone", "sms", "email"]);
const phoneType = z.enum(["mobile", "landline", "voip", "unknown"]);
const dncStatus = z.enum(["clear", "listed", "unknown"]);
const restriction = z.enum(["no_export", "no_outreach", "internal_only", "attribution_required"]);

/** ISO datetime (naive values are taken as UTC) -> Date. */
const NAIVE = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const dt = z
  .string()
  .refine((s) => !Number.isNaN(new Date(NAIVE.test(s) ? `${s}Z` : s).getTime()), "Input should be a valid datetime")
  .transform((s) => new Date(NAIVE.test(s) ? `${s}Z` : s));
const uuid = z.string().uuid();

/** Create or update the scrub / classification facts for a contact value. */
export const recordUpsert = z.object({
  channel,
  value: z.string().min(3).max(320),
  person_id: uuid.nullish(),
  phone_type: phoneType.nullish(),
  jurisdiction_state: z.string().max(10).nullish(),
  jurisdiction_country: z.string().max(2).nullish(),
  dnc_status: dncStatus.nullish(),
  scrub_date: z.string().date().nullish(),
  scrub_source: z.string().max(120).nullish(),
  provider: z.string().max(120).nullish(),
  notes: z.string().nullish(),
});
export type RecordUpsert = z.infer<typeof recordUpsert>;

export const recordUpdate = z
  .object({
    person_id: uuid.nullish(),
    phone_type: phoneType.nullish(),
    jurisdiction_state: z.string().max(10).nullish(),
    jurisdiction_country: z.string().max(2).nullish(),
    dnc_status: dncStatus.nullish(),
    scrub_date: z.string().date().nullish(),
    scrub_source: z.string().max(120).nullish(),
    provider: z.string().max(120).nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type RecordUpdate = z.infer<typeof recordUpdate>;

export const checkIn = z.object({
  channel,
  value: z.string().min(3).max(320),
  at: dt.nullish(),
});
export type CheckIn = z.infer<typeof checkIn>;

export const optOutIn = z.object({
  channel,
  value: z.string().min(3).max(320),
  person_id: uuid.nullish(),
  source: z.string().min(2).max(200),
  evidence: z.string().max(4000).nullish(),
});
export type OptOutIn = z.infer<typeof optOutIn>;

export const consentIn = z.object({
  channel,
  value: z.string().min(3).max(320),
  person_id: uuid.nullish(),
  state: z.enum(["granted", "revoked"]),
  source: z.string().min(2).max(200),
  evidence: z.string().max(4000).nullish(),
  lift_suppression: z.boolean().default(false),
});
export type ConsentIn = z.infer<typeof consentIn>;

export const suppressIn = z.object({
  channel,
  value: z.string().min(3).max(320),
  person_id: uuid.nullish(),
  reason: z.string().min(2).max(200),
  until: dt.nullish(),
});
export type SuppressIn = z.infer<typeof suppressIn>;

const quietHours = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  channels: z.array(channel).default(["phone", "sms"]),
  default_utc_offset: z.number().min(-12).max(14),
});

const cap = z.object({ count: z.number().int().min(0).max(1000), period_days: z.number().int().min(1).max(365) });

export const settingsUpdate = z
  .object({
    quiet_hours: quietHours.nullish(),
    frequency_caps: z.record(z.string(), cap).nullish(),
    channel_caps: z.record(channel, cap).nullish(),
    scrub_validity_days: z.number().int().min(1).max(365).nullish(),
    not_interested_suppression_days: z.number().int().min(0).max(3650).nullish(),
    counsel_reviewed_at: z.string().date().nullish(),
    counsel_reviewed_by: z.string().nullish(),
  })
  .strict();
export type SettingsUpdate = z.infer<typeof settingsUpdate>;

export const restrictionIn = z.object({
  provider: z.string().min(1).max(120),
  restriction: restriction.default("no_export"),
  block_export: z.boolean().default(false),
  notes: z.string().nullish(),
  is_active: z.boolean().default(true),
});
export type RestrictionIn = z.infer<typeof restrictionIn>;

export const exportCheckIn = z.object({
  providers: z.array(z.string()).default([]),
  values: z.array(checkIn).default([]),
});
export type ExportCheckIn = z.infer<typeof exportCheckIn>;
