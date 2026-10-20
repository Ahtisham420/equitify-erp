"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useUrlState } from "@/hooks/use-url-state";
import { api, type Params } from "@/lib/api";

export type Unit = "count" | "currency" | "percent" | "days" | "number";

export interface KpiMeta {
  key: string;
  label: string;
  family: string;
  module: string;
  definition: string;
  unit: Unit;
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
  unit: Unit;
  delta: number | null;
  better: "up" | "down" | null;
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
  kind: "time" | "breakdown";
  chart: "bar" | "line";
  unit: Unit;
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
  cells: Record<string, unknown>;
  hrefs: Record<string, string>;
  source: string | null;
  restricted: boolean;
  restriction_reason: string | null;
}

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
  generated_at: string;
  default_me: boolean;
  filters: Record<string, string[]>;
  tiles: Tile[];
  series: SeriesOut[];
  tables: TableOut[];
}

export interface KpiOut extends KpiMeta {
  value: number | null;
  delta: number | null;
  better: "up" | "down" | null;
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

export type Cadence = "daily" | "weekly" | "monthly";

export interface Schedule {
  id: string;
  name: string;
  dashboard_key: string;
  dashboard_label: string | null;
  filters: Record<string, string[]>;
  cadence: Cadence;
  recipient_ids: string[];
  recipient_names: string[];
  format: string;
  is_active: boolean;
  owner_id: string | null;
  owner_name: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface ScheduleInput {
  name: string;
  dashboard_key: string;
  filters: Record<string, string[]>;
  cadence: Cadence;
  recipient_ids: string[];
  is_active?: boolean;
  notes?: string | null;
}

export interface ReportRun {
  id: string;
  schedule_id: string | null;
  dashboard_key: string;
  recipient_id: string | null;
  recipient_name: string | null;
  ran_at: string;
  status: "success" | "failed";
  filename: string | null;
  size_bytes: number;
  row_count: number;
  withheld_rows: number;
  error: string | null;
}

/* ------------------------------------------------------------------ filter state (URL) */

export const FILTER_KEYS = ["days", "date_from", "date_to", "user", "team", "property_type", "state", "county", "territory", "source", "stage"] as const;
export const LIST_FILTERS = ["user", "property_type", "state", "county", "source", "stage"] as const;
export const DEFAULT_DAYS = "30";

/** Report filters from the URL (plus KPI facets `f_*`), with the default 30-day window applied. */
export function useReportParams() {
  const url = useUrlState();
  const params = useMemo(() => {
    const out: Params = {};
    for (const [key, value] of Object.entries(url.params)) {
      if ((FILTER_KEYS as readonly string[]).includes(key) || key.startsWith("f_")) out[key] = value;
    }
    if (!out.days && !out.date_from && !out.date_to) out.days = DEFAULT_DAYS;
    return out;
  }, [url.params]);
  return { url, params };
}

/** Converts report params into the stored-filter shape used by schedules. */
export function paramsToFilters(params: Params): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("f_")) continue;
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && v !== "").map(String);
    if (values.length) out[key] = values;
  }
  return out;
}

/* ------------------------------------------------------------------ queries */

export function useCatalog() {
  return useQuery({ queryKey: ["reports", "catalog"], queryFn: () => api.get<Catalog>("/reports/catalog"), staleTime: 5 * 60_000 });
}

export function useFilterOptions() {
  return useQuery({ queryKey: ["reports", "filter-options"], queryFn: () => api.get<FilterOptions>("/reports/filter-options"), staleTime: 5 * 60_000 });
}

export function useDashboard(key: string | null, params: Params) {
  return useQuery({
    queryKey: ["reports", "dashboard", key, params],
    queryFn: () => api.get<DashboardOut>(`/reports/dashboards/${key}`, params),
    enabled: !!key,
    placeholderData: keepPreviousData,
  });
}

export function useKpi(key: string, params: Params) {
  return useQuery({
    queryKey: ["reports", "kpi", key, params],
    queryFn: () => api.get<KpiOut>(`/reports/kpis/${encodeURIComponent(key)}`, params),
    placeholderData: keepPreviousData,
  });
}

export function useKpiRecords(key: string, params: Params, page: number, pageSize: number) {
  return useQuery({
    queryKey: ["reports", "kpi-records", key, params, page, pageSize],
    queryFn: () => api.get<RecordPage>(`/reports/kpis/${encodeURIComponent(key)}/records`, { ...params, page, page_size: pageSize }),
    placeholderData: keepPreviousData,
  });
}

export function useKpiHistory(key: string) {
  return useQuery({
    queryKey: ["reports", "kpi-history", key],
    queryFn: () => api.get<SnapshotPoint[]>(`/reports/kpis/${encodeURIComponent(key)}/history`),
  });
}

export function useSchedules(enabled = true) {
  return useQuery({ queryKey: ["reports", "schedules"], queryFn: () => api.get<Schedule[]>("/reports/schedules"), enabled });
}

export function useRuns(scheduleId?: string | null) {
  return useQuery({
    queryKey: ["reports", "runs", scheduleId ?? null],
    queryFn: () => api.get<ReportRun[]>("/reports/runs", { schedule_id: scheduleId ?? undefined }),
  });
}

/* ------------------------------------------------------------------ mutations */

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["reports", "schedules"] });
    void qc.invalidateQueries({ queryKey: ["reports", "runs"] });
  };
}

export function useCreateSchedule() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (body: ScheduleInput) => api.post<Schedule>("/reports/schedules", body), onSuccess: done });
}

export function useUpdateSchedule() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<ScheduleInput> & { id: string }) => api.patch<Schedule>(`/reports/schedules/${id}`, body),
    onSuccess: done,
  });
}

export function useDeleteSchedule() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/reports/schedules/${id}`), onSuccess: done });
}

export function useRunDue() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: () => api.post<{ schedules: number; runs: number; failed: number }>("/reports/schedules/run-due"),
    onSuccess: done,
  });
}

export function useRunSnapshots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ as_of: string; created: number; skipped: number; failed: string[] }>("/reports/snapshots/run"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reports", "kpi-history"] }),
  });
}

/* ------------------------------------------------------------------ downloads */

export function downloadDashboard(key: string, params: Params) {
  return api.download(`/reports/dashboards/${key}/export`, params, `${key}.csv`);
}

export function downloadKpi(key: string, params: Params) {
  return api.download(`/reports/kpis/${encodeURIComponent(key)}/export`, params, `${key.replace(".", "-")}.csv`);
}

export function downloadRun(run: ReportRun) {
  return api.download(`/reports/runs/${run.id}/download`, undefined, run.filename ?? "report.csv");
}
