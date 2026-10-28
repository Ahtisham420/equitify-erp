import { z } from "zod";

// ---------------------------------------------------------------------------- response shapes (Out models)

export interface KpiMeta {
  key: string;
  label: string;
  family: string;
  module: string;
  definition: string;
  unit: string;
  point_in_time: boolean;
  module_href: string | null;
  facets: string[];
  dims: string[];
}

export interface DashboardMeta {
  key: string;
  label: string;
  description: string;
  default_me: boolean;
  tile_count: number;
}

export interface Catalog {
  dashboards: DashboardMeta[];
  kpis: KpiMeta[];
  families: string[];
  can_export: boolean;
  can_schedule: boolean;
  can_snapshot: boolean;
}

export interface Tile {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  delta: number | null;
  better: string | null;
  href: string;
  module_href: string | null;
  definition: string;
  point_in_time: boolean;
  ignored_filters: string[];
}

export interface SeriesMeta {
  key: string;
  label: string;
  href: string;
}

export interface Point {
  key: string;
  label: string;
  values: Record<string, number | null>;
  hrefs: Record<string, string>;
}

export interface SeriesOut {
  key: string;
  label: string;
  description: string | null;
  kind: string;
  chart: string;
  unit: string;
  series: SeriesMeta[];
  points: Point[];
}

export interface Column {
  key: string;
  label: string;
  kind: string;
}

export interface Row {
  id: string;
  title: string;
  href: string | null;
  cells: Record<string, any>;
  hrefs: Record<string, string>;
  source: string | null;
  restricted: boolean;
  restriction_reason: string | null;
}

/** Builds a Row with the same defaults as the pydantic model. */
export const mkRow = (r: Partial<Row> & Pick<Row, "id" | "title">): Row => ({
  href: null,
  cells: {},
  hrefs: {},
  source: null,
  restricted: false,
  restriction_reason: null,
  ...r,
});

export interface TableOut {
  key: string;
  label: string;
  description: string | null;
  columns: Column[];
  rows: Row[];
  total: number | null;
  href: string | null;
}

export interface DashboardOut {
  key: string;
  label: string;
  description: string;
  generated_at: Date;
  default_me: boolean;
  filters: Record<string, string[]>;
  tiles: Tile[];
  series: SeriesOut[];
  tables: TableOut[];
}

export interface KpiOut extends KpiMeta {
  value: number | null;
  delta: number | null;
  better: string | null;
  href: string;
  ignored_filters: string[];
  columns: Column[];
}

export interface RecordPage {
  columns: Column[];
  items: Row[];
  total: number;
  page: number;
  page_size: number;
  ignored_filters: string[];
  withheld: number;
}

export interface SnapshotPoint {
  as_of: string;
  value: number | null;
  dims: Record<string, unknown>;
}

export interface SnapshotRunOut {
  as_of: string;
  created: number;
  skipped: number;
  failed: string[];
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterOptions {
  users: FilterOption[];
  teams: FilterOption[];
  territories: FilterOption[];
  property_types: FilterOption[];
  states: FilterOption[];
  sources: FilterOption[];
  stages: FilterOption[];
}

export interface ScheduleOut {
  id: string;
  name: string;
  dashboard_key: string;
  dashboard_label: string | null;
  filters: Record<string, any>;
  cadence: string;
  recipient_ids: string[];
  recipient_names: string[];
  format: string;
  is_active: boolean;
  owner_id: string | null;
  owner_name: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  notes: string | null;
  created_at: Date;
}

export interface RunOut {
  id: string;
  schedule_id: string | null;
  dashboard_key: string;
  recipient_id: string | null;
  recipient_name: string | null;
  ran_at: Date;
  status: string;
  filename: string | null;
  size_bytes: number;
  row_count: number;
  withheld_rows: number;
  error: string | null;
}

export interface RunDueOut {
  schedules: number;
  runs: number;
  failed: number;
}

// ---------------------------------------------------------------------------- request bodies

const cadence = z.enum(["daily", "weekly", "monthly"]);
const filtersMap = z.record(z.string(), z.array(z.string()));

export const scheduleIn = z.object({
  name: z.string().min(1).max(200),
  dashboard_key: z.string().max(60),
  filters: filtersMap.default({}),
  cadence: cadence.default("weekly"),
  recipient_ids: z.array(z.string().uuid()).max(50).default([]),
  format: z.enum(["csv"]).default("csv"),
  is_active: z.boolean().default(true),
  notes: z.string().nullish(),
});
export type ScheduleIn = z.infer<typeof scheduleIn>;

export const scheduleUpdate = z.object({
  name: z.string().min(1).max(200).nullish(),
  filters: filtersMap.nullish(),
  cadence: cadence.nullish(),
  recipient_ids: z.array(z.string().uuid()).max(50).nullish(),
  is_active: z.boolean().nullish(),
  notes: z.string().nullish(),
});
export type ScheduleUpdate = z.infer<typeof scheduleUpdate>;
