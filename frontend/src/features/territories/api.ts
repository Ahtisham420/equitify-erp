"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { GeoJson } from "@/features/parcels/api";

export const RULE_TYPES = ["explicit", "boundary", "radius", "corridor", "county", "city", "saved_query"] as const;
export const VISIBILITIES = ["private", "role", "company"] as const;
export const ROAD_CLASSES = ["interstate", "highway", "arterial", "collector", "local", "other"] as const;
export const GROWTH_KINDS = ["permit", "plat", "rooftops", "school", "utility", "project"] as const;
export const TRADE_AREA_MINUTES = [5, 10, 15] as const;
export const QUADRANTS = ["NE", "NW", "SE", "SW"] as const;

export const RULE_LABELS: Record<string, string> = {
  explicit: "Explicit assignment",
  boundary: "Drawn boundary",
  radius: "Radius",
  corridor: "Corridor buffer",
  county: "County",
  city: "City",
  saved_query: "Saved query",
};

export const VISIBILITY_LABELS: Record<string, string> = { private: "Private", role: "Role-restricted", company: "Company-wide" };

export interface TerritoryListItem {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;
  rule: Record<string, unknown>;
  has_geometry: boolean;
  parent_id: string | null;
  visibility: string;
  allowed_roles: string[];
  owner_id: string | null;
  assignee_id: string | null;
  member_count: number;
  last_computed_at: string | null;
  updated_at: string;
}

export interface Territory extends TerritoryListItem {
  parent_name: string | null;
  owner_name: string | null;
  assignee_name: string | null;
  children: TerritoryListItem[];
  geojson: GeoJson | null;
  can_edit: boolean;
  created_at: string;
}

export interface TerritoryInput {
  name?: string;
  description?: string | null;
  rule_type?: string;
  rule?: Record<string, unknown>;
  geometry?: GeoJson | null;
  parent_id?: string | null;
  visibility?: string;
  allowed_roles?: string[];
  owner_id?: string | null;
  assignee_id?: string | null;
}

export interface TerritoryMember {
  property_id: string;
  source: "rule" | "manual" | string;
  added_at: string;
  name: string | null;
  address_line: string;
  city: string | null;
  state: string | null;
  county: string | null;
  property_type: string;
  status: string;
}

export interface Overlap {
  id: string;
  name: string;
  rule_type: string;
  shared: number;
}

export interface Corridor {
  id: string;
  name: string;
  road_name: string | null;
  road_class: string;
  side_of_road: string | null;
  travel_direction: string | null;
  frontage_length_ft: number | null;
  city: string | null;
  county: string | null;
  state: string | null;
  has_geometry: boolean;
  length_ft: number | null;
  source: string | null;
  observed_on: string | null;
  notes: string | null;
  node_count: number;
  latest_count: number | null;
  latest_count_year: number | null;
  geojson: GeoJson | null;
  updated_at: string;
}

export interface Node {
  id: string;
  name: string;
  corridor_id: string | null;
  corridor_name: string | null;
  cross_street: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  approach_traffic: Record<string, number | string>;
  signalized: boolean | null;
  turn_restrictions: string | null;
  quadrants: Record<string, { tenancy?: string; vacancy?: string } | undefined>;
  nearby_development: string | null;
  source: string | null;
  observed_on: string | null;
  notes: string | null;
  updated_at: string;
}

export interface TrafficCount {
  id: string;
  corridor_id: string | null;
  corridor_name: string | null;
  node_id: string | null;
  node_name: string | null;
  segment: string | null;
  approach: string | null;
  count: number;
  count_year: number;
  count_type: string;
  latitude: number | null;
  longitude: number | null;
  source: string;
  observed_on: string | null;
  notes: string | null;
  change_pct: number | null;
  updated_at: string;
}

export interface TradeArea {
  id: string;
  name: string | null;
  node_id: string | null;
  node_name: string | null;
  property_id: string | null;
  property_label: string | null;
  minutes: number;
  has_geometry: boolean;
  demographics: Record<string, unknown>;
  competitors: unknown[];
  anchors: unknown[];
  source: string;
  observed_on: string | null;
  notes: string | null;
  geojson: GeoJson | null;
  updated_at: string;
}

export interface GrowthRecord {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  status: string | null;
  units: number | null;
  value: number | null;
  event_date: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
  source: string;
  observed_on: string | null;
  distance_miles: number | null;
  updated_at: string;
}

export interface PropertyRef {
  id: string;
  name: string | null;
  address_line: string;
  city: string | null;
  state: string | null;
  property_type: string;
  status: string;
  traffic_count: number | null;
  distance_miles: number | null;
}

export interface RoleLite {
  id: string;
  key: string;
  name: string;
}

/* ------------------------------------------------------------------ territories */

export function useTerritory(id: string) {
  return useQuery({ queryKey: ["territories", id], queryFn: () => api.get<Territory>(`/territories/${id}`) });
}

export function useTerritoryOptions(enabled = true) {
  return useQuery({
    queryKey: ["territories", "options"],
    queryFn: () => api.get<TerritoryListItem[]>("/territories/options"),
    enabled,
    staleTime: 60_000,
  });
}

export function useTerritoryOverlaps(id: string) {
  return useQuery({ queryKey: ["territories", id, "overlaps"], queryFn: () => api.get<Overlap[]>(`/territories/${id}/overlaps`) });
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleLite[]>("/roles"), enabled, staleTime: 5 * 60_000 });
}

export function useSaveTerritory(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: TerritoryInput) => (id ? api.patch<Territory>(`/territories/${id}`, data) : api.post<Territory>("/territories", data)),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["territories"] });
      qc.setQueryData(["territories", t.id], t);
      qc.invalidateQueries({ queryKey: ["timeline", "territory", t.id] });
    },
  });
}

export function useRecomputeTerritory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ added: number; removed: number; total: number }>(`/territories/${id}/recompute`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["territories"] });
      qc.invalidateQueries({ queryKey: ["timeline", "territory", id] });
    },
  });
}

export function useAddTerritoryMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ territoryId, property_ids = [], parcel_ids = [] }: { territoryId: string; property_ids?: string[]; parcel_ids?: string[] }) =>
      api.post<{ added: number }>(`/territories/${territoryId}/members`, { property_ids, parcel_ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["territories"] }),
  });
}

export function useRemoveTerritoryMember(territoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) => api.delete(`/territories/${territoryId}/members/${propertyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["territories"] }),
  });
}

/* ------------------------------------------------------------------ geography records */

type GeoResource = "corridors" | "nodes" | "traffic-counts" | "trade-areas" | "growth-records";

export function useSaveGeo<T>(resource: GeoResource, id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => (id ? api.patch<T>(`/${resource}/${id}`, data) : api.post<T>(`/${resource}`, data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [resource] });
      if (resource === "corridors" || resource === "nodes") qc.invalidateQueries({ queryKey: ["traffic-counts"] });
    },
  });
}

export function useArchiveGeo(resource: GeoResource) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/${resource}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [resource] }),
  });
}

export function useGeoRecord<T>(resource: GeoResource, id: string | null | undefined) {
  return useQuery({ queryKey: [resource, "detail", id], queryFn: () => api.get<T>(`/${resource}/${id}`), enabled: !!id });
}
