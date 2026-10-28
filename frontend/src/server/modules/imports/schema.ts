import { boolean, date, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";

export const ENTITY_TYPES = ["property", "person", "organization"] as const;
export const JOB_STATUSES = ["uploaded", "mapped", "validated", "committed", "rolled_back", "failed"] as const;
export const ROW_STATUSES = ["pending", "valid", "invalid", "duplicate", "created", "updated", "skipped"] as const;
export const CADENCES = ["one_time", "daily", "weekly", "monthly", "quarterly", "annual", "ad_hoc"] as const;

/** Source/license registry. External data cannot be committed without an active source. */
export const dataSources = pgTable(
  "data_sources",
  {
    ...entity(),
    provider: varchar("provider", { length: 200 }).notNull(),
    description: text("description"),
    license_terms: text("license_terms"),
    permitted_use: text("permitted_use"),
    redistribution_allowed: boolean("redistribution_allowed").notNull().$defaultFn(() => false),
    cadence: varchar("cadence", { length: 20 }).notNull().$defaultFn(() => "ad_hoc"),
    cost: numericFloat("cost", 16, 2),
    cost_notes: varchar("cost_notes", { length: 200 }),
    contact_name: varchar("contact_name", { length: 200 }),
    contact_email: varchar("contact_email", { length: 255 }),
    contact_phone: varchar("contact_phone", { length: 40 }),
    renewal_date: date("renewal_date", { mode: "string" }),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [
    index("ix_data_sources_deleted_at").on(t.deleted_at),
    index("ix_data_sources_provider").on(t.provider),
    index("ix_data_sources_is_active").on(t.is_active),
  ],
);
export type DataSource = typeof dataSources.$inferSelect;

export const importJobs = pgTable(
  "import_jobs",
  {
    ...entity(),
    entity_type: varchar("entity_type", { length: 20 }).notNull(),
    data_source_id: fk("data_source_id", () => dataSources.id),
    filename: varchar("filename", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "uploaded"),
    headers: jsonb("headers").$type<string[]>().notNull().$defaultFn(() => []),
    column_mapping: jsonb("column_mapping").$type<Record<string, string | null>>().notNull().$defaultFn(() => ({})),
    options: jsonb("options").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().$defaultFn(() => ({})),
    row_count: integer("row_count").notNull().$defaultFn(() => 0),
    error: text("error"),
    validated_at: tz("validated_at"),
    committed_at: tz("committed_at"),
    committed_by_id: uuid("committed_by_id").references(() => users.id, { onDelete: "set null" }),
    rolled_back_at: tz("rolled_back_at"),
    rolled_back_by_id: uuid("rolled_back_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_import_jobs_deleted_at").on(t.deleted_at),
    index("ix_import_jobs_entity_type").on(t.entity_type),
    index("ix_import_jobs_data_source_id").on(t.data_source_id),
    index("ix_import_jobs_status").on(t.status),
  ],
);
export type ImportJob = typeof importJobs.$inferSelect;

export const importRows = pgTable(
  "import_rows",
  {
    id: pk(),
    job_id: uuid("job_id").notNull().references(() => importJobs.id, { onDelete: "cascade" }),
    row_number: integer("row_number").notNull(),
    raw: jsonb("raw").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    mapped: jsonb("mapped").$type<Record<string, any> | null>(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "pending"),
    errors: jsonb("errors").$type<Array<Record<string, any>>>().notNull().$defaultFn(() => []),
    duplicate_of_id: uuid("duplicate_of_id"),
    created_entity_id: uuid("created_entity_id"),
    previous_values: jsonb("previous_values").$type<Record<string, any> | null>(),
  },
  (t) => [
    index("ix_import_rows_job_id").on(t.job_id),
    index("ix_import_rows_job_status").on(t.job_id, t.status),
  ],
);
export type ImportRow = typeof importRows.$inferSelect;

/** Admin override of the staleness threshold (days) for one property field. */
export const dataQualityThresholds = pgTable(
  "data_quality_thresholds",
  {
    ...entity(),
    field: varchar("field", { length: 80 }).notNull(),
    days: integer("days").notNull(),
  },
  (t) => [
    unique("uq_data_quality_thresholds_field").on(t.field),
    index("ix_data_quality_thresholds_deleted_at").on(t.deleted_at),
  ],
);
export type QualityThreshold = typeof dataQualityThresholds.$inferSelect;
