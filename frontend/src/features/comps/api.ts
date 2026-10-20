"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page, type Params } from "@/lib/api";

export const VERIFICATION_STATUSES = ["unverified", "verified", "disputed"] as const;
export const TENANT_CREDIT = ["investment_grade", "national", "regional", "local", "none"] as const;
export const TENANT_CREDIT_LABELS: Record<string, string> = {
  investment_grade: "Investment grade",
  national: "National",
  regional: "Regional",
  local: "Local",
  none: "No credit",
};
export const VERIFICATION_METHODS = [
  "buyer", "seller", "broker", "recorded_deed", "public_record", "lease_document", "landlord", "tenant", "third_party_data", "appraisal", "other",
] as const;
export const ADJUSTMENT_FACTORS = ["location", "size", "age", "condition", "lease_term", "tenant_credit", "timing"] as const;
export const SALE_BASES = ["price_psf", "price_per_acre", "cap_rate", "price"] as const;
export const LEASE_BASES = ["effective_rent_psf", "base_rent_psf"] as const;
export const BASIS_LABELS: Record<string, string> = {
  price_psf: "Price per SF",
  price_per_acre: "Price per acre",
  cap_rate: "Cap rate",
  price: "Total price",
  effective_rent_psf: "Effective rent per SF",
  base_rent_psf: "Base rent per SF",
};
export const VALUATION_METHODS = ["direct_cap", "dcf", "sales_comparison", "land_residual", "appraisal", "bov"] as const;
export const VALUATION_METHOD_LABELS: Record<string, string> = {
  direct_cap: "Direct capitalization",
  dcf: "Discounted cash flow",
  sales_comparison: "Sales comparison",
  land_residual: "Land residual",
  appraisal: "Third-party appraisal",
  bov: "Broker opinion of value",
};

export interface Verification {
  verification_status: "unverified" | "verified" | "disputed";
  verification_method: string | null;
  verification_notes: string | null;
  verified_by_id: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
}

interface CompCommon extends Verification {
  id: string;
  property_id: string | null;
  property_label: string | null;
  name: string | null;
  address_line: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  corridor: string | null;
  latitude: number | null;
  longitude: number | null;
  property_type: string | null;
  tenant_name: string | null;
  tenant_organization_id: string | null;
  tenant_credit: string | null;
  building_area_sf: number | null;
  land_area_acres: number | null;
  year_built: number | null;
  condition: string | null;
  source: string | null;
  document_id: string | null;
  notes: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface SaleComp extends CompCommon {
  sale_date: string | null;
  sale_price: number | null;
  price_psf: number | null;
  price_per_acre: number | null;
  cap_rate: number | null;
  noi: number | null;
  buyer_name: string | null;
  buyer_organization_id: string | null;
  seller_name: string | null;
  seller_organization_id: string | null;
  financing: string | null;
  lease_term_remaining_years: number | null;
  occupancy_pct: number | null;
}

export interface LeaseComp extends CompCommon {
  space_id: string | null;
  suite: string | null;
  lease_type: string | null;
  commencement_on: string | null;
  term_months: number | null;
  area_sf: number | null;
  base_rent_psf: number | null;
  escalation_pct: number | null;
  escalation_structure: string | null;
  recovery_type: string | null;
  recoveries_psf: number | null;
  free_rent_months: number | null;
  concessions: string | null;
  ti_psf: number | null;
  effective_rent_psf: number | null;
}

export type CompKind = "sale" | "lease";

export interface CompFacets {
  property_type: Record<string, number>;
  verification_status: Record<string, number>;
  tenant_credit: Record<string, number>;
  state: Record<string, number>;
}

export interface Candidate {
  id: string;
  kind: CompKind;
  label: string;
  city: string | null;
  state: string | null;
  county: string | null;
  corridor: string | null;
  property_type: string | null;
  tenant_name: string | null;
  tenant_credit: string | null;
  date: string | null;
  price: number | null;
  price_psf: number | null;
  cap_rate: number | null;
  rent_psf: number | null;
  term_years: number | null;
  area_sf: number | null;
  verification_status: string;
  distance_miles: number | null;
}

export interface Indicated {
  count: number;
  basis: string;
  subject_quantity: number | null;
  metric_low: number | null;
  metric_high: number | null;
  metric_point: number | null;
  value_low: number | null;
  value_high: number | null;
  value_point: number | null;
  method: string;
  comp_ids?: string[];
  computed_at?: string;
}

export interface Decision {
  included: boolean;
  reason: string | null;
  by: string;
  by_name: string | null;
  at: string;
}

export interface CompSetItem {
  id: string;
  sale_comp_id: string | null;
  lease_comp_id: string | null;
  included: boolean;
  exclusion_reason: string | null;
  decision_history: Decision[];
  adjustments: Record<string, number>;
  adjustment_notes: Record<string, string>;
  weight: number;
  base_metric: number | null;
  net_adjustment_pct: number | null;
  adjusted_metric: number | null;
  adjusted_value: number | null;
  distance_miles: number | null;
  sort_order: number;
  comp: Record<string, unknown> & { label?: string; city?: string | null; state?: string | null; date?: string | null; verification_status?: string; archived?: boolean };
}

export interface CompSetListItem {
  id: string;
  name: string;
  kind: CompKind;
  purpose: string | null;
  status: "draft" | "final";
  value_basis: string;
  subject_property_id: string | null;
  subject_label: string | null;
  indicated: Partial<Indicated>;
  included_count: number;
  excluded_count: number;
  updated_at: string;
  created_at: string;
}

export interface CompSet extends CompSetListItem {
  subject_quantity: number | null;
  subject_quantity_source: string | null;
  criteria: Record<string, unknown>;
  notes: string | null;
  owner_id: string | null;
  subject: Record<string, unknown> & { id?: string; name?: string | null; address_line?: string; city?: string | null; state?: string | null };
  items: CompSetItem[];
}

export interface SourcedValue {
  value: number | null;
  source?: string | null;
  comp_ids?: string[];
  document_id?: string | null;
}

export interface Valuation {
  id: string;
  property_id: string;
  property_label: string | null;
  method: string;
  value_low: number | null;
  value_high: number | null;
  value_point: number | null;
  as_of: string;
  analyst_id: string | null;
  analyst_name: string | null;
  comp_set_id: string | null;
  uw_model_id: string | null;
  is_mark: boolean;
  inputs: Record<string, unknown>;
  assumptions: Record<string, SourcedValue>;
  unsourced: string[];
  calculation: Record<string, unknown>;
  document_id: string | null;
  third_party: string | null;
  notes: string | null;
  prior_value_point: number | null;
  change_pct: number | null;
  created_at: string;
}

export interface ValuationInput {
  property_id: string;
  method: string;
  as_of: string;
  is_mark?: boolean;
  comp_set_id?: string | null;
  uw_model_id?: string | null;
  assumptions?: Record<string, SourcedValue>;
  value_low?: number | null;
  value_high?: number | null;
  value_point?: number | null;
  document_id?: string | null;
  third_party?: string | null;
  notes?: string | null;
}

export interface ValuationPreview {
  value_low: number | null;
  value_high: number | null;
  value_point: number | null;
  calculation: Record<string, unknown>;
  unsourced: string[];
}

export interface ValuationDocument {
  id: string;
  property_id: string;
  document_id: string;
  kind: "appraisal" | "bov" | "other";
  label: string | null;
  prepared_by: string | null;
  effective_date: string | null;
  value_conclusion: number | null;
  valuation_id: string | null;
  created_at: string;
}

export interface BovPayloadComp {
  id: string;
  comp: CompSetItem["comp"];
  adjustments: Record<string, number>;
  adjustment_notes: Record<string, string>;
  base_metric: number | null;
  net_adjustment_pct: number | null;
  adjusted_metric: number | null;
  adjusted_value: number | null;
  weight: number;
  distance_miles: number | null;
}

export interface BovPayload {
  generated_at: string;
  title: string;
  prepared_for: string | null;
  prepared_by: string | null;
  subject: Record<string, unknown>;
  comp_set: { id: string; name: string; kind: CompKind; value_basis: string; subject_quantity: number | null; subject_quantity_source: string | null };
  adjustment_factors: string[];
  comps: BovPayloadComp[];
  excluded: { id: string; label: string | null; reason: string | null }[];
  indicated: Indicated;
  valuation: { id: string; method: string; value_low: number | null; value_high: number | null; value_point: number | null; as_of: string } | null;
  recommended_list_price: number | null;
  narrative: string | null;
  evidence: { comp_ids: string[]; document_ids: string[] };
}

export interface Bov {
  id: string;
  property_id: string;
  property_label: string | null;
  comp_set_id: string;
  valuation_id: string | null;
  title: string;
  prepared_for: string | null;
  prepared_by_id: string | null;
  prepared_by_name: string | null;
  status: "draft" | "final" | "delivered";
  value_low: number | null;
  value_high: number | null;
  value_point: number | null;
  recommended_list_price: number | null;
  narrative: string | null;
  payload: Partial<BovPayload>;
  generated_at: string | null;
  document_id: string | null;
  created_at: string;
  updated_at: string;
}

export function compLabel(c: { name?: string | null; address_line?: string | null; tenant_name?: string | null }) {
  return c.name || c.address_line || c.tenant_name || "Unnamed comp";
}

/** Formats a comp-set metric for its basis. */
export function formatMetric(value: number | null | undefined, basis: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (basis === "cap_rate") return `${value.toFixed(2)}%`;
  if (basis === "price") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

/** Mirror of the server adjustment math so the grid can preview edits before saving. */
export function previewAdjusted(base: number | null, adjustments: Record<string, number | null | undefined>) {
  const net = ADJUSTMENT_FACTORS.reduce((s, f) => s + (Number(adjustments[f]) || 0), 0);
  return { net, adjusted: base === null ? null : base * (1 + net / 100) };
}

/* ---------------------------------------------------------------- hooks */

const compPath = (kind: CompKind) => (kind === "sale" ? "/sale-comps" : "/lease-comps");

export function useSaveComp(kind: CompKind, id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      id ? api.patch<SaleComp | LeaseComp>(`${compPath(kind)}/${id}`, data) : api.post<SaleComp | LeaseComp>(compPath(kind), data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comps"] });
      qc.invalidateQueries({ queryKey: ["comp-sets"] });
    },
  });
}

export function useVerifyComp(kind: CompKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; status: string; method?: string | null; notes?: string | null }) =>
      api.post(`${compPath(kind)}/${id}/verify`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comps"] }),
  });
}

export function useArchiveComp(kind: CompKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${compPath(kind)}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comps"] }),
  });
}

export function useCandidates(path: string, params: Params, enabled: boolean) {
  return useQuery({
    queryKey: ["comps", "candidates", path, params],
    queryFn: () => api.get<Candidate[]>(path, params),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useCompSet(id: string) {
  return useQuery({ queryKey: ["comp-sets", id], queryFn: () => api.get<CompSet>(`/comp-sets/${id}`) });
}

export function useCreateCompSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<CompSet>("/comp-sets", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comp-sets"] }),
  });
}

function useSetMutation<TBody>(id: string, fn: (body: TBody) => Promise<CompSet>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (cs) => {
      qc.setQueryData(["comp-sets", id], cs);
      qc.invalidateQueries({ queryKey: ["comp-sets", "list"] });
      qc.invalidateQueries({ queryKey: ["comps", "candidates"] });
      qc.invalidateQueries({ queryKey: ["timeline", "comp_set", id] });
    },
  });
}

export function useUpdateCompSet(id: string) {
  return useSetMutation(id, (body: Record<string, unknown>) => api.patch<CompSet>(`/comp-sets/${id}`, body));
}

export function useAddSetItems(id: string) {
  return useSetMutation(id, (comp_ids: string[]) => api.post<CompSet>(`/comp-sets/${id}/items`, { comp_ids }));
}

export function useUpdateSetItem(id: string) {
  return useSetMutation(id, ({ itemId, ...body }: { itemId: string; included?: boolean; exclusion_reason?: string | null; adjustments?: Record<string, number>; weight?: number }) =>
    api.patch<CompSet>(`/comp-sets/${id}/items/${itemId}`, body),
  );
}

export function useSaveGrid(id: string) {
  return useSetMutation(id, (body: { value_basis?: string; subject_quantity?: number | null; subject_quantity_source?: string | null; items: { id: string; adjustments: Record<string, number>; adjustment_notes: Record<string, string>; weight: number }[] }) =>
    api.put<CompSet>(`/comp-sets/${id}/grid`, body),
  );
}

export function useValuationFromSet(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { as_of: string; is_mark: boolean; notes?: string | null }) => api.post<Valuation>(`/comp-sets/${id}/valuation`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["valuations"] }),
  });
}

export function useGenerateBov(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; prepared_for?: string | null; narrative?: string | null; recommended_list_price?: number | null; valuation_id?: string | null }) =>
      api.post<Bov>(`/comp-sets/${id}/bov`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bovs"] }),
  });
}

export function useCreateValuation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ValuationInput) => api.post<Valuation>("/valuations", body),
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ["valuations"] });
      qc.invalidateQueries({ queryKey: ["timeline", "property", v.property_id] });
    },
  });
}

export function usePreviewValuation() {
  return useMutation({ mutationFn: (body: ValuationInput) => api.post<ValuationPreview>("/valuations/preview", body) });
}

export function useValuationDocuments(propertyId: string | null | undefined) {
  return useQuery({
    queryKey: ["valuations", "documents", propertyId],
    queryFn: () => api.get<ValuationDocument[]>("/valuations/documents", { property_id: propertyId }),
    enabled: !!propertyId,
  });
}

export function useLinkValuationDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<ValuationDocument, "id" | "created_at">) => api.post<ValuationDocument>("/valuations/documents", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["valuations", "documents"] }),
  });
}

export function useBov(id: string) {
  return useQuery({ queryKey: ["bovs", id], queryFn: () => api.get<Bov>(`/bovs/${id}`) });
}

export function useUpdateBov(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<Bov, "title" | "prepared_for" | "narrative" | "recommended_list_price" | "status" | "document_id">>) =>
      api.patch<Bov>(`/bovs/${id}`, body),
    onSuccess: (b) => {
      qc.setQueryData(["bovs", id], b);
      qc.invalidateQueries({ queryKey: ["bovs", "list"] });
    },
  });
}

export function useRegenerateBov(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Bov>(`/bovs/${id}/regenerate`),
    onSuccess: (b) => qc.setQueryData(["bovs", id], b),
  });
}

export function useBovs(params: Params) {
  return useQuery({ queryKey: ["bovs", "list", params], queryFn: () => api.get<Page<Bov>>("/bovs", params) });
}
