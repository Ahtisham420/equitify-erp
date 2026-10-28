import { boolean, date, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { pk, tz } from "../../db/columns";
import { entity } from "../../db/entity";

export const CHANNELS = ["phone", "sms", "email"] as const;
export const PHONE_TYPES = ["mobile", "landline", "voip", "unknown"] as const;
export const DNC_STATUSES = ["clear", "listed", "unknown"] as const;
export const CONSENT_STATES = ["unknown", "granted", "revoked"] as const;
export const EVENT_TYPES = [
  "consent_granted", "consent_revoked", "opt_out", "suppressed", "suppression_lifted", "dnc_scrubbed",
] as const;
export const RESTRICTIONS = ["no_export", "no_outreach", "internal_only", "attribution_required"] as const;

/** Current compliance state for one channel + contact value. History lives in consent_events. */
export const complianceRecords = pgTable(
  "compliance_records",
  {
    ...entity(),
    channel: varchar("channel", { length: 10 }).notNull(),
    value: varchar("value", { length: 320 }).notNull(),
    normalized_value: varchar("normalized_value", { length: 320 }).notNull(),
    // Soft link to people.id (contacts module); kept without FK so compliance never depends on CRM deletes.
    person_id: uuid("person_id"),
    phone_type: varchar("phone_type", { length: 10 }).notNull().$defaultFn(() => "unknown"),
    jurisdiction_state: varchar("jurisdiction_state", { length: 10 }),
    jurisdiction_country: varchar("jurisdiction_country", { length: 2 }).notNull().$defaultFn(() => "US"),
    dnc_status: varchar("dnc_status", { length: 10 }).notNull().$defaultFn(() => "unknown"),
    scrub_date: date("scrub_date", { mode: "string" }),
    scrub_source: varchar("scrub_source", { length: 120 }),
    scrub_expires_on: date("scrub_expires_on", { mode: "string" }),
    internal_suppression: boolean("internal_suppression").notNull().$defaultFn(() => false),
    suppression_reason: varchar("suppression_reason", { length: 200 }),
    suppressed_at: tz("suppressed_at"),
    suppressed_until: tz("suppressed_until"),
    consent_state: varchar("consent_state", { length: 10 }).notNull().$defaultFn(() => "unknown"),
    consent_source: varchar("consent_source", { length: 200 }),
    consent_date: tz("consent_date"),
    opted_out_at: tz("opted_out_at"),
    opt_out_count: integer("opt_out_count").notNull().$defaultFn(() => 0),
    provider: varchar("provider", { length: 120 }),
    notes: text("notes"),
  },
  (t) => [
    unique("uq_compliance_records_channel_value").on(t.channel, t.normalized_value),
    index("ix_compliance_records_deleted_at").on(t.deleted_at),
    index("ix_compliance_records_channel").on(t.channel),
    index("ix_compliance_records_normalized_value").on(t.normalized_value),
    index("ix_compliance_records_person_id").on(t.person_id),
    index("ix_compliance_records_jurisdiction_state").on(t.jurisdiction_state),
    index("ix_compliance_records_dnc_status").on(t.dnc_status),
    index("ix_compliance_records_scrub_expires_on").on(t.scrub_expires_on),
    index("ix_compliance_records_internal_suppression").on(t.internal_suppression),
    index("ix_compliance_records_consent_state").on(t.consent_state),
    index("ix_compliance_records_provider").on(t.provider),
  ],
);
export type ComplianceRecord = typeof complianceRecords.$inferSelect;

/** Immutable log of consent / opt-out / suppression changes. No update or delete path exists. */
export const consentEvents = pgTable(
  "consent_events",
  {
    id: pk(),
    occurred_at: tz("occurred_at").notNull().$defaultFn(() => new Date()),
    record_id: uuid("record_id"),
    channel: varchar("channel", { length: 10 }).notNull(),
    normalized_value: varchar("normalized_value", { length: 320 }).notNull(),
    person_id: uuid("person_id"),
    event_type: varchar("event_type", { length: 30 }).notNull(),
    source: varchar("source", { length: 200 }),
    evidence: text("evidence"),
    actor_id: uuid("actor_id"),
    actor_name: varchar("actor_name", { length: 200 }),
    details: jsonb("details").$type<Record<string, any>>(),
  },
  (t) => [
    index("ix_consent_events_occurred_at").on(t.occurred_at),
    index("ix_consent_events_record_id").on(t.record_id),
    index("ix_consent_events_normalized_value").on(t.normalized_value),
    index("ix_consent_events_person_id").on(t.person_id),
    index("ix_consent_events_event_type").on(t.event_type),
  ],
);
export type ConsentEvent = typeof consentEvents.$inferSelect;

/** Immutable outbound content log, including attempts blocked at send time. */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: pk(),
    sent_at: tz("sent_at").notNull().$defaultFn(() => new Date()),
    channel: varchar("channel", { length: 10 }).notNull(),
    to_value: varchar("to_value", { length: 320 }).notNull(),
    normalized_value: varchar("normalized_value", { length: 320 }).notNull(),
    person_id: uuid("person_id"),
    subject: varchar("subject", { length: 300 }),
    content: text("content"),
    actor_id: uuid("actor_id"),
    actor_name: varchar("actor_name", { length: 200 }),
    interaction_id: uuid("interaction_id"),
    allowed: boolean("allowed").notNull(),
    block_reasons: jsonb("block_reasons").$type<any[]>().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_outbound_messages_sent_at").on(t.sent_at),
    index("ix_outbound_messages_channel").on(t.channel),
    index("ix_outbound_messages_normalized_value").on(t.normalized_value),
    index("ix_outbound_messages_person_id").on(t.person_id),
    index("ix_outbound_messages_actor_id").on(t.actor_id),
    index("ix_outbound_messages_interaction_id").on(t.interaction_id),
    index("ix_outbound_messages_allowed").on(t.allowed),
  ],
);
export type OutboundMessage = typeof outboundMessages.$inferSelect;

/** Singleton row: quiet hours, frequency caps and channel caps. Must be reviewed by counsel before campaigns. */
export const complianceSettings = pgTable(
  "compliance_settings",
  {
    ...entity(),
    quiet_hours: jsonb("quiet_hours").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    frequency_caps: jsonb("frequency_caps").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    channel_caps: jsonb("channel_caps").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    scrub_validity_days: integer("scrub_validity_days").notNull().$defaultFn(() => 31),
    not_interested_suppression_days: integer("not_interested_suppression_days").notNull().$defaultFn(() => 180),
    counsel_reviewed_at: date("counsel_reviewed_at", { mode: "string" }),
    counsel_reviewed_by: varchar("counsel_reviewed_by", { length: 200 }),
  },
  (t) => [index("ix_compliance_settings_deleted_at").on(t.deleted_at)],
);
export type ComplianceSettings = typeof complianceSettings.$inferSelect;

/** Usage restrictions of enrichment-data providers, used for export warnings / blocks. */
export const providerRestrictions = pgTable(
  "provider_restrictions",
  {
    ...entity(),
    provider: varchar("provider", { length: 120 }).notNull(),
    restriction: varchar("restriction", { length: 30 }).notNull().$defaultFn(() => "no_export"),
    block_export: boolean("block_export").notNull().$defaultFn(() => false),
    notes: text("notes"),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [
    unique("uq_provider_restrictions_provider").on(t.provider),
    index("ix_provider_restrictions_deleted_at").on(t.deleted_at),
  ],
);
export type ProviderRestriction = typeof providerRestrictions.$inferSelect;
