"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page, type Params } from "@/lib/api";

export const ENTITY_TYPES = ["property", "person", "organization"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const JOB_STATUSES = ["uploaded", "mapped", "validated", "committed", "rolled_back", "failed"] as const;
export const ROW_STATUSES = ["pending", "valid", "invalid", "duplicate", "created", "updated", "skipped"] as const;
export const CADENCES = ["one_time", "daily", "weekly", "monthly", "quarterly", "annual", "ad_hoc"] as const;

export const ENTITY_LABELS: Record<string, string> = { property: "Properties", person: "People", organization: "Organizations" };
export const CADENCE_LABELS: Record<string, string> = {
  one_time: "One time", daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", annual: "Annual", ad_hoc: "Ad hoc",
};
export const JOB_STATUS_LABELS: Record<string, string> = {
  uploaded: "Uploaded", mapped: "Mapped", validated: "Validated", committed: "Committed", rolled_back: "Rolled back", failed: "Failed",
};

/** Detail route for a record an import created, updated or matched. */
export function entityHref(entityType: string, id: string): string {
  if (entityType === "person") return `/people/${id}`;
  if (entityType === "organization") return `/organizations/${id}`;
  return `/properties/${id}`;
}

export interface DataSource {
  id: string;
  provider: string;
  description: string | null;
  license_terms: string | null;
  permitted_use: string | null;
  redistribution_allowed: boolean;
  cadence: string;
  cost: number | null;
  cost_notes: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  renewal_date: string | null;
  is_active: boolean;
  import_count: number;
  created_at: string;
  updated_at: string;
}

export type DataSourceInput = Omit<DataSource, "id" | "import_count" | "created_at" | "updated_at">;

export interface TargetField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  group: string;
}

export interface ImportCounts {
  total?: number;
  pending?: number;
  valid?: number;
  invalid?: number;
  duplicate?: number;
  existing_duplicates?: number;
  file_duplicates?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  reverted?: number;
  rollback_conflicts?: number;
}

export interface ImportJob {
  id: string;
  entity_type: EntityType;
  data_source_id: string | null;
  data_source_name: string | null;
  filename: string;
  status: string;
  row_count: number;
  counts: ImportCounts;
  column_mapping: Record<string, string | null>;
  options: { on_duplicate?: "skip" | "update" };
  error: string | null;
  created_by_id: string | null;
  created_at: string;
  validated_at: string | null;
  committed_at: string | null;
  rolled_back_at: string | null;
}

export interface ImportJobDetail extends ImportJob {
  headers: string[];
  sample: Record<string, string>[];
  suggested_mapping: Record<string, string | null>;
  fields: TargetField[];
}

export interface ImportRow {
  id: string;
  row_number: number;
  raw: Record<string, string>;
  mapped: Record<string, unknown> | null;
  status: string;
  errors: { field?: string | null; column?: string; message: string }[];
  duplicate_of_id: string | null;
  created_entity_id: string | null;
  previous_values: Record<string, unknown> | null;
}

export interface ImportFacets {
  status: Record<string, number>;
  entity_type: Record<string, number>;
}

/* ------------------------------------------------------------------ data sources */

export function useDataSourceOptions() {
  return useQuery({
    queryKey: ["data-sources", "options"],
    queryFn: async () => (await api.get<Page<DataSource>>("/data-sources", { is_active: true, page_size: 200 })).items,
    staleTime: 60_000,
  });
}

export function useSaveDataSource(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<DataSourceInput>) =>
      id ? api.patch<DataSource>(`/data-sources/${id}`, data) : api.post<DataSource>("/data-sources", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["data-sources"] }),
  });
}

export function useArchiveDataSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/data-sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["data-sources"] }),
  });
}

/* ------------------------------------------------------------------ jobs */

export function useImportJob(id: string | null) {
  return useQuery({
    queryKey: ["imports", id],
    queryFn: () => api.get<ImportJobDetail>(`/imports/${id}`),
    enabled: !!id,
  });
}

export function useImportRows(id: string, params: Params, enabled = true) {
  return useQuery({
    queryKey: ["imports", id, "rows", params],
    queryFn: () => api.get<Page<ImportRow>>(`/imports/${id}/rows`, params),
    enabled,
    placeholderData: (prev) => prev,
  });
}

function useJobMutation<TVars>(id: string, fn: (vars: TVars) => Promise<ImportJobDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (job) => {
      qc.setQueryData(["imports", id], job);
      qc.invalidateQueries({ queryKey: ["imports"] });
      qc.invalidateQueries({ queryKey: ["timeline", "import_job", id] });
      if (job.entity_type === "property") qc.invalidateQueries({ queryKey: ["properties"] });
    },
  });
}

export function useUploadImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, entityType, dataSourceId }: { file: File; entityType: EntityType; dataSourceId: string }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("entity_type", entityType);
      form.append("data_source_id", dataSourceId);
      return api.post<ImportJobDetail>("/imports", form);
    },
    onSuccess: (job) => {
      qc.setQueryData(["imports", job.id], job);
      qc.invalidateQueries({ queryKey: ["imports", "list"] });
    },
  });
}

export function useSaveMapping(id: string) {
  return useJobMutation(id, (mapping: Record<string, string | null>) =>
    api.put<ImportJobDetail>(`/imports/${id}/mapping`, { column_mapping: mapping }),
  );
}

export function useValidateImport(id: string) {
  return useJobMutation(id, () => api.post<ImportJobDetail>(`/imports/${id}/validate`));
}

export function useCommitImport(id: string) {
  return useJobMutation(id, (onDuplicate: "skip" | "update") =>
    api.post<ImportJobDetail>(`/imports/${id}/commit`, { on_duplicate: onDuplicate }),
  );
}

export function useRollbackImport(id: string) {
  return useJobMutation(id, () => api.post<ImportJobDetail>(`/imports/${id}/rollback`));
}
