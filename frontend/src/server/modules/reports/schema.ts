import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
} from "drizzle-orm/pg-core";

import { pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";

export const CADENCES = ["daily", "weekly", "monthly"] as const;
export const FORMATS = ["csv"] as const;
export const RUN_STATUSES = ["success", "failed"] as const;

/** Dated value of one KPI (historical metrics). Rows are immutable; one per kpi/day/dimension set. */
export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: pk(),
    kpi_key: varchar("kpi_key", { length: 80 }).notNull(),
    as_of: date("as_of", { mode: "string" }).notNull(),
    value: doublePrecision("value"),
    dims: jsonb("dims").$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    dims_key: varchar("dims_key", { length: 300 }).notNull().$defaultFn(() => ""),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    created_by_id: fk("created_by_id", () => users.id),
  },
  (t) => [
    index("ix_metric_snapshots_kpi_key").on(t.kpi_key),
    index("ix_metric_snapshots_as_of").on(t.as_of),
    unique("uq_metric_snapshots_key_day_dims").on(t.kpi_key, t.as_of, t.dims_key),
  ],
);

/** A dashboard delivered on a cadence; each recipient receives a file computed with their own permissions. */
export const reportSchedules = pgTable(
  "report_schedules",
  {
    ...entity(),
    name: varchar("name", { length: 200 }).notNull(),
    dashboard_key: varchar("dashboard_key", { length: 60 }).notNull(),
    // Query-string style filters: {"days": ["30"], "state": ["TX", "FL"], ...}
    filters: jsonb("filters").$type<Record<string, string[]>>().notNull().$defaultFn(() => ({})),
    cadence: varchar("cadence", { length: 10 }).notNull().$defaultFn(() => "weekly"),
    recipient_ids: uuid("recipient_ids").array().notNull().$defaultFn(() => []),
    format: varchar("format", { length: 10 }).notNull().$defaultFn(() => "csv"),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    owner_id: fk("owner_id", () => users.id),
    next_run_at: tz("next_run_at"),
    last_run_at: tz("last_run_at"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_report_schedules_deleted_at").on(t.deleted_at),
    index("ix_report_schedules_dashboard_key").on(t.dashboard_key),
    index("ix_report_schedules_is_active").on(t.is_active),
    index("ix_report_schedules_owner_id").on(t.owner_id),
    index("ix_report_schedules_next_run_at").on(t.next_run_at),
  ],
);

/** One generated report file for one recipient. Immutable. */
export const reportRuns = pgTable(
  "report_runs",
  {
    id: pk(),
    schedule_id: fk("schedule_id", () => reportSchedules.id),
    dashboard_key: varchar("dashboard_key", { length: 60 }).notNull(),
    recipient_id: fk("recipient_id", () => users.id),
    ran_at: tz("ran_at").notNull().$defaultFn(() => new Date()),
    status: varchar("status", { length: 10 }).notNull().$defaultFn(() => "success"),
    filters: jsonb("filters").$type<Record<string, string[]>>().notNull().$defaultFn(() => ({})),
    filename: varchar("filename", { length: 255 }),
    storage_key: varchar("storage_key", { length: 400 }),
    size_bytes: integer("size_bytes").notNull().$defaultFn(() => 0),
    row_count: integer("row_count").notNull().$defaultFn(() => 0),
    withheld_rows: integer("withheld_rows").notNull().$defaultFn(() => 0),
    error: text("error"),
    run_by_id: fk("run_by_id", () => users.id),
  },
  (t) => [
    index("ix_report_runs_schedule_id").on(t.schedule_id),
    index("ix_report_runs_dashboard_key").on(t.dashboard_key),
    index("ix_report_runs_recipient_id").on(t.recipient_id),
    index("ix_report_runs_ran_at").on(t.ran_at),
    index("ix_report_runs_status").on(t.status),
  ],
);

export type MetricSnapshot = typeof metricSnapshots.$inferSelect;
export type ReportSchedule = typeof reportSchedules.$inferSelect;
export type ReportRun = typeof reportRuns.$inferSelect;
