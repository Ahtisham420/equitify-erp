"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const PROPERTY_STATUSES = ["tracked", "pursued", "rejected", "owned", "managed", "listed", "sold"] as const;
export const PROPERTY_TYPES = [
  "retail", "stnl", "multi_tenant_retail", "gas_convenience", "medical", "office", "industrial",
  "multifamily", "hospitality", "ground_lease", "land", "mixed_use", "other",
] as const;

export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  retail: "Retail",
  stnl: "Single-tenant net lease",
  multi_tenant_retail: "Multi-tenant retail",
  gas_convenience: "Gas / convenience",
  medical: "Medical",
  office: "Office",
  industrial: "Industrial",
  multifamily: "Multifamily",
  hospitality: "Hospitality",
  ground_lease: "Ground lease",
  land: "Land",
  mixed_use: "Mixed use",
  other: "Other",
};

export interface Observation {
  id: string;
  field: string;
  value: unknown;
  source: string;
  observed_on: string | null;
  confidence: number;
  verification: "unverified" | "verified" | "rejected";
  ai_derived: boolean;
  is_current: boolean;
  recorded_at: string;
  recorded_by_id: string | null;
  verified_by_id: string | null;
  verified_at: string | null;
}

export interface PropertyListItem {
  id: string;
  name: string | null;
  address_line: string;
  city: string | null;
  state: string | null;
  county: string | null;
  property_type: string;
  status: string;
  building_area_sf: number | null;
  land_area_acres: number | null;
  asking_price: number | null;
  occupancy_pct: number | null;
  year_built: number | null;
  completeness_score: number;
  tags: string[];
  updated_at: string;
}

export interface Property extends Omit<PropertyListItem, "updated_at"> {
  postal_code: string | null;
  alternate_addresses: string[];
  latitude: number | null;
  longitude: number | null;
  property_subtype: string | null;
  year_renovated: number | null;
  parking_spaces: number | null;
  construction_class: string | null;
  last_sale_price: number | null;
  last_sale_date: string | null;
  wale_years: number | null;
  noi: number | null;
  zoning: string | null;
  future_land_use: string | null;
  flood_zone: string | null;
  traffic_count: number | null;
  corridor: string | null;
  notes: string | null;
  normalized_address: string;
  missing_fields: string[];
  provenance: Record<string, Observation>;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
}

export interface Provenance {
  source: string;
  observed_on: string | null;
  confidence: number;
  verified: boolean;
  ai_derived?: boolean;
}

export type PropertyInput = Partial<Omit<Property, "id" | "provenance" | "missing_fields" | "normalized_address" | "completeness_score" | "created_at" | "updated_at" | "created_by_id">> & {
  provenance?: Provenance;
};

export interface PropertyFacets {
  status: Record<string, number>;
  property_type: Record<string, number>;
  state: Record<string, number>;
}

export function propertyTitle(p: { name: string | null; address_line: string }) {
  return p.name || p.address_line;
}

export function useProperty(id: string) {
  return useQuery({ queryKey: ["properties", id], queryFn: () => api.get<Property>(`/properties/${id}`) });
}

export function usePropertyHistory(id: string, enabled = true) {
  return useQuery({
    queryKey: ["properties", id, "history"],
    queryFn: () => api.get<Observation[]>(`/properties/${id}/history`),
    enabled,
  });
}

export function useSaveProperty(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ data, force }: { data: PropertyInput; force?: boolean }) =>
      id ? api.patch<Property>(`/properties/${id}`, data) : api.post<Property>("/properties", data, force ? { force: true } : undefined),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.setQueryData(["properties", p.id], p);
      qc.invalidateQueries({ queryKey: ["timeline", "property", p.id] });
    },
  });
}

export function useVerifyObservation(propertyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, state }: { id: string; state: "verified" | "rejected" }) =>
      api.post<Observation>(`/properties/observations/${id}/verify`, { state }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties", propertyId] });
      qc.invalidateQueries({ queryKey: ["timeline", "property", propertyId] });
    },
  });
}

export function useBulkProperties() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: string[]; status?: string; add_tags?: string[]; remove_tags?: string[] }) =>
      api.post<{ updated: number }>("/properties/bulk", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["properties"] }),
  });
}
