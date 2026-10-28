import {
  bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid, varchar,
} from "drizzle-orm/pg-core";

import { pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { tasks } from "../tasks/schema";

// Spec 36 integration catalog (+ AI, the assistive provider behind documents/search/outreach intelligence).
export const INTEGRATION_CATEGORIES: Record<string, string> = {
  email_calendar: "Email & calendar",
  telephony: "Telephony",
  messaging: "Messaging",
  meetings: "Meetings",
  parcel_ownership: "Parcel & ownership",
  recorded_documents: "Recorded documents & liens",
  tax_court_entity: "Tax, court & entity",
  traffic_demographics: "Traffic, demographics & permits",
  tenant_brand: "Tenant & brand",
  market_comps: "Market comps",
  accounting: "Accounting",
  banking: "Banking",
  payments: "Payments",
  esignature: "E-signature",
  title_escrow: "Title & escrow",
  lender_exchange: "Lender exchange",
  storage: "Storage",
  spreadsheets: "Spreadsheets",
  task_calendar: "Task & calendar",
  ai: "AI",
};
export const INTEGRATION_STATUSES = ["not_configured", "manual", "active", "error", "disabled"];
export const DELIVERY_STATUSES = ["pending", "sending", "delivered", "failed", "dead"];
export const JOB_STATUSES = ["running", "succeeded", "failed"];
export const SUGGESTION_KINDS = ["summary", "commitment", "next_action"];
export const SUGGESTION_STATUSES = ["pending", "accepted", "rejected", "superseded"];

/** A configured provider for one integration category. Core logic talks to it only via platform/providers.ts. */
export const integrationProviders = pgTable(
  "integration_providers",
  {
    ...entity(),
    category: varchar("category", { length: 40 }).notNull(),
    provider: varchar("provider", { length: 80 }).notNull(),
    label: varchar("label", { length: 160 }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "not_configured"),
    is_primary: boolean("is_primary").notNull().$defaultFn(() => false),
    config: jsonb("config").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    // Fernet token of a JSON object. Never returned in plaintext.
    credentials_encrypted: text("credentials_encrypted"),
    credential_keys: varchar("credential_keys", { length: 80 }).array().notNull().$defaultFn(() => []),
    credentials_version: integer("credentials_version").notNull().$defaultFn(() => 0),
    credentials_rotated_at: tz("credentials_rotated_at"),
    usage_restrictions: text("usage_restrictions"),
    last_success_at: tz("last_success_at"),
    last_error: text("last_error"),
    last_error_at: tz("last_error_at"),
    last_tested_at: tz("last_tested_at"),
  },
  (t) => [
    unique("uq_integration_providers_category_provider").on(t.category, t.provider),
    index("ix_integration_providers_category").on(t.category),
    index("ix_integration_providers_status").on(t.status),
  ],
);
export type IntegrationProvider = typeof integrationProviders.$inferSelect;

/** Deployment control. Money/date/permission-sensitive changes ship behind a sensitive flag. */
export const featureFlags = pgTable(
  "feature_flags",
  {
    ...entity(),
    key: varchar("key", { length: 80 }).notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().$defaultFn(() => false),
    is_sensitive: boolean("is_sensitive").notNull().$defaultFn(() => false),
    rollout_roles: varchar("rollout_roles", { length: 60 }).array().notNull().$defaultFn(() => []),
    rollout_user_ids: varchar("rollout_user_ids", { length: 40 }).array().notNull().$defaultFn(() => []),
  },
  (t) => [uniqueIndex("ix_feature_flags_key").on(t.key)],
);
export type FeatureFlag = typeof featureFlags.$inferSelect;

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(),
    url: varchar("url", { length: 1000 }).notNull(),
    events: varchar("events", { length: 80 }).array().notNull().$defaultFn(() => []),
    secret_encrypted: text("secret_encrypted").notNull(),
    active: boolean("active").notNull().$defaultFn(() => true),
    last_delivery_at: tz("last_delivery_at"),
    consecutive_failures: integer("consecutive_failures").notNull().$defaultFn(() => 0),
  },
  (t) => [index("ix_webhook_subscriptions_active").on(t.active)],
);
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;

/** Outbox row written inside the event transaction; network I/O happens later in the delivery worker. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: pk(),
    subscription_id: fk("subscription_id", () => webhookSubscriptions.id, { notNull: true, onDelete: "cascade" }),
    event: varchar("event", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "pending"),
    attempts: integer("attempts").notNull().$defaultFn(() => 0),
    next_attempt_at: tz("next_attempt_at").notNull().$defaultFn(() => new Date()),
    last_attempt_at: tz("last_attempt_at"),
    last_status_code: integer("last_status_code"),
    last_error: text("last_error"),
    delivered_at: tz("delivered_at"),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("ix_webhook_deliveries_subscription_id").on(t.subscription_id),
    index("ix_webhook_deliveries_event").on(t.event),
    index("ix_webhook_deliveries_status").on(t.status),
    index("ix_webhook_deliveries_next_attempt_at").on(t.next_attempt_at),
    index("ix_webhook_deliveries_created_at").on(t.created_at),
  ],
);
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/** Observable background job runs (spec 35/36: idempotent, retryable, observable jobs). */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: pk(),
    job_key: varchar("job_key", { length: 80 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "running"),
    started_at: tz("started_at").notNull().$defaultFn(() => new Date()),
    finished_at: tz("finished_at"),
    duration_ms: integer("duration_ms"),
    error: text("error"),
    counts: jsonb("counts").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    triggered_by_id: fk("triggered_by_id", () => users.id),
  },
  (t) => [
    index("ix_job_runs_job_key").on(t.job_key),
    index("ix_job_runs_status").on(t.status),
    index("ix_job_runs_started_at").on(t.started_at),
    index("ix_job_runs_triggered_by_id").on(t.triggered_by_id),
  ],
);
export type JobRun = typeof jobRuns.$inferSelect;

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    ...entity(),
    entity_type: varchar("entity_type", { length: 60 }).notNull(),
    retain_days: integer("retain_days").notNull(),
    action: varchar("action", { length: 20 }).notNull().$defaultFn(() => "review"), // review | archive
    description: text("description"),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [uniqueIndex("ix_retention_policies_entity_type").on(t.entity_type)],
);
export type RetentionPolicy = typeof retentionPolicies.$inferSelect;

/** While a hold is open (released_at is null) the record must not be purged or destroyed. */
export const legalHolds = pgTable(
  "legal_holds",
  {
    ...entity(),
    entity_type: varchar("entity_type", { length: 60 }).notNull(),
    entity_id: uuid("entity_id"), // null = whole entity type
    reason: text("reason").notNull(),
    matter: varchar("matter", { length: 200 }),
    placed_by_id: fk("placed_by_id", () => users.id),
    placed_at: tz("placed_at").notNull().$defaultFn(() => new Date()),
    released_at: tz("released_at"),
    released_by_id: fk("released_by_id", () => users.id),
    release_reason: text("release_reason"),
  },
  (t) => [
    index("ix_legal_holds_entity_type").on(t.entity_type),
    index("ix_legal_holds_entity_id").on(t.entity_id),
    index("ix_legal_holds_placed_by_id").on(t.placed_by_id),
    index("ix_legal_holds_released_at").on(t.released_at),
  ],
);
export type LegalHold = typeof legalHolds.$inferSelect;

/** Manual log of backups and restoration tests against RPO/RTO targets. */
export const backupRecords = pgTable(
  "backup_records",
  {
    ...entity(),
    kind: varchar("kind", { length: 20 }).notNull(), // backup | restore_test
    environment: varchar("environment", { length: 20 }).notNull().$defaultFn(() => "production"),
    performed_at: tz("performed_at").notNull().$defaultFn(() => new Date()),
    reference: varchar("reference", { length: 300 }),
    encrypted: boolean("encrypted").notNull().$defaultFn(() => true),
    point_in_time: boolean("point_in_time").notNull().$defaultFn(() => false),
    size_bytes: bigint("size_bytes", { mode: "number" }),
    rpo_target_minutes: integer("rpo_target_minutes"),
    rto_target_minutes: integer("rto_target_minutes"),
    achieved_rpo_minutes: doublePrecision("achieved_rpo_minutes"),
    achieved_rto_minutes: doublePrecision("achieved_rto_minutes"),
    result: varchar("result", { length: 20 }).notNull().$defaultFn(() => "success"), // success | partial | failed
    notes: text("notes"),
    performed_by_id: fk("performed_by_id", () => users.id),
  },
  (t) => [
    index("ix_backup_records_kind").on(t.kind),
    index("ix_backup_records_performed_at").on(t.performed_at),
    index("ix_backup_records_performed_by_id").on(t.performed_by_id),
  ],
);
export type BackupRecord = typeof backupRecords.$inferSelect;

/** AI output awaiting human confirmation. Nothing is applied unless a named user accepts it. */
export const aiSuggestions = pgTable(
  "ai_suggestions",
  {
    ...entity(),
    source_type: varchar("source_type", { length: 40 }).notNull(), // interaction
    source_id: uuid("source_id").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    content: text("content").notNull(),
    details: jsonb("details").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "pending"),
    provider: varchar("provider", { length: 60 }),
    model: varchar("model", { length: 120 }),
    decided_by_id: fk("decided_by_id", () => users.id),
    decided_at: tz("decided_at"),
    task_id: fk("task_id", () => tasks.id),
  },
  (t) => [
    index("ix_ai_suggestions_source_type").on(t.source_type),
    index("ix_ai_suggestions_source_id").on(t.source_id),
    index("ix_ai_suggestions_kind").on(t.kind),
    index("ix_ai_suggestions_status").on(t.status),
  ],
);
export type AISuggestion = typeof aiSuggestions.$inferSelect;
