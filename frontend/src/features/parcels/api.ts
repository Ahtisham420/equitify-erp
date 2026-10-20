"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Observation, PropertyInput } from "@/features/properties/api";

export const PARCEL_RELATIONSHIPS = ["primary", "assemblage", "excess_land", "outparcel", "other"] as const;
export const OCCUPANCY_STATES = ["vacant", "occupied", "pending", "owner_occupied", "unavailable"] as const;
export const SPACE_USE_TYPES = ["retail", "restaurant", "office", "medical", "industrial", "flex", "storage", "residential", "other"] as const;

export type GeoJson = { type: string; [key: string]: unknown };

export interface ParcelListItem {
  id: string;
  county: string;
  state: string | null;
  apn: string;
  apn_normalized: string;
  situs_address: string | null;
  legal_description: string | null;
  acreage: number | null;
  has_geometry: boolean;
  centroid_lat: number | null;
  centroid_lng: number | null;
  source: string | null;
  observed_on: string | null;
  property_count: number;
  updated_at: string;
}

export interface Parcel extends ParcelListItem {
  facts: Record<string, unknown>;
  notes: string | null;
  geojson: GeoJson | null;
  geometry_acreage: number | null;
  provenance: Record<string, Observation>;
  created_at: string;
  created_by_id: string | null;
}

export interface ParcelFacets {
  county: Record<string, number>;
  state: Record<string, number>;
}

export interface ParcelVersion {
  id: string;
  version: number;
  legal_description: string | null;
  acreage: number | null;
  changed_fields: string[];
  source: string | null;
  observed_on: string | null;
  recorded_at: string;
  recorded_by_id: string | null;
  geojson: GeoJson | null;
}

export interface OwnerRef {
  kind: "person" | "organization" | string;
  id: string;
  name: string | null;
}

export interface AdjacentParcel {
  id: string;
  county: string;
  apn: string;
  situs_address: string | null;
  acreage: number | null;
  distance_m: number;
  touches: boolean;
  shared_owners: OwnerRef[];
}

export interface Adjacency {
  items: AdjacentParcel[];
  owners: OwnerRef[];
  owners_hidden: boolean;
}

export interface Assemblage {
  owners: OwnerRef[];
  groups: { owner: OwnerRef; parcels: ParcelListItem[]; total_acreage: number }[];
  owners_hidden: boolean;
  ownership_available: boolean;
}

export interface LinkedProperty {
  link_id: string;
  relationship: string;
  property_id: string;
  name: string | null;
  address_line: string;
  city: string | null;
  state: string | null;
  status: string;
  property_type: string;
}

export interface PropertyParcel {
  link_id: string;
  relationship: string;
  notes: string | null;
  parcel: ParcelListItem;
}

export interface Building {
  id: string;
  property_id: string;
  parcel_id: string | null;
  name: string;
  building_area_sf: number | null;
  year_built: number | null;
  floors: number | null;
  construction_class: string | null;
  use_type: string | null;
  notes: string | null;
  space_count: number;
  updated_at: string;
}

export interface Space {
  id: string;
  property_id: string;
  building_id: string | null;
  suite: string;
  area_sf: number | null;
  floor: string | null;
  location_note: string | null;
  use_type: string | null;
  occupancy_status: string;
  tenant_name: string | null;
  tenant_organization_id: string | null;
  lease_id: string | null;
  notes: string | null;
  updated_at: string;
}

export interface ProvenanceInput {
  source: string;
  observed_on: string | null;
  confidence: number;
  verified: boolean;
}

export interface ParcelInput {
  county?: string;
  state?: string | null;
  apn?: string;
  situs_address?: string | null;
  legal_description?: string | null;
  acreage?: number | null;
  facts?: Record<string, unknown>;
  source?: string | null;
  observed_on?: string | null;
  notes?: string | null;
  geometry?: GeoJson | null;
  clear_geometry?: boolean;
  provenance?: ProvenanceInput;
}

export interface BulkAssociateInput {
  parcel_ids: string[];
  property_id?: string | null;
  new_property?: PropertyInput | null;
  relationship?: string | null;
  preview: boolean;
}

export interface BulkAssociateResult {
  preview: boolean;
  property_id: string | null;
  parcels: {
    id: string;
    apn: string;
    county: string;
    acreage: number | null;
    has_geometry: boolean;
    already_linked: boolean;
    relationship: string;
    linked_elsewhere: string[];
  }[];
  total_acreage: number;
  contiguous: boolean | null;
  missing_ids: string[];
  linked: number;
}

export function parcelTitle(p: { apn: string; county: string }) {
  return `${p.county} · ${p.apn}`;
}

/* ------------------------------------------------------------------ parcels */

export function useParcel(id: string) {
  return useQuery({ queryKey: ["parcels", id], queryFn: () => api.get<Parcel>(`/parcels/${id}`) });
}

export function useParcelProperties(id: string) {
  return useQuery({ queryKey: ["parcels", id, "properties"], queryFn: () => api.get<LinkedProperty[]>(`/parcels/${id}/properties`) });
}

export function useAdjacentParcels(id: string, enabled = true) {
  return useQuery({ queryKey: ["parcels", id, "adjacent"], queryFn: () => api.get<Adjacency>(`/parcels/${id}/adjacent`), enabled });
}

export function useAssemblage(id: string, enabled = true) {
  return useQuery({ queryKey: ["parcels", id, "assemblage"], queryFn: () => api.get<Assemblage>(`/parcels/${id}/assemblage`), enabled });
}

export function useParcelVersions(id: string, enabled = true) {
  return useQuery({ queryKey: ["parcels", id, "versions"], queryFn: () => api.get<ParcelVersion[]>(`/parcels/${id}/versions`), enabled });
}

export function useParcelHistory(id: string, enabled = true) {
  return useQuery({ queryKey: ["parcels", id, "history"], queryFn: () => api.get<Observation[]>(`/parcels/${id}/history`), enabled });
}

export function useSaveParcel(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ data, force }: { data: ParcelInput; force?: boolean }) =>
      id ? api.patch<Parcel>(`/parcels/${id}`, data) : api.post<Parcel>("/parcels", data, force ? { force: true } : undefined),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["parcels"] });
      qc.setQueryData(["parcels", p.id], p);
      qc.invalidateQueries({ queryKey: ["timeline", "parcel", p.id] });
    },
  });
}

export function useMergeParcel(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (intoId: string) => api.post<Parcel>(`/parcels/${id}/merge`, { into_id: intoId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["parcels"] }),
  });
}

export function useBulkAssociate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkAssociateInput) => api.post<BulkAssociateResult>("/parcels/bulk-associate", body),
    onSuccess: (r) => {
      if (!r.preview) {
        qc.invalidateQueries({ queryKey: ["parcels"] });
        qc.invalidateQueries({ queryKey: ["properties"] });
      }
    },
  });
}

/* ------------------------------------------------------------------ property hierarchy */

export function usePropertyParcels(propertyId: string) {
  return useQuery({
    queryKey: ["properties", propertyId, "parcels"],
    queryFn: () => api.get<PropertyParcel[]>(`/properties/${propertyId}/parcels`),
  });
}

export function useBuildings(propertyId: string) {
  return useQuery({
    queryKey: ["properties", propertyId, "buildings"],
    queryFn: () => api.get<Building[]>(`/properties/${propertyId}/buildings`),
  });
}

export function useSpaces(propertyId: string) {
  return useQuery({
    queryKey: ["properties", propertyId, "spaces"],
    queryFn: () => api.get<Space[]>(`/properties/${propertyId}/spaces`),
  });
}

function useHierarchyMutation<TVars, TResult = unknown>(propertyId: string, fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties", propertyId] });
      qc.invalidateQueries({ queryKey: ["parcels"] });
      qc.invalidateQueries({ queryKey: ["timeline", "property", propertyId] });
    },
  });
}

export function useLinkParcel(propertyId: string) {
  return useHierarchyMutation(propertyId, (body: { parcel_id: string; relationship: string; notes?: string | null }) =>
    api.post<{ link_id: string }>(`/properties/${propertyId}/parcels`, body),
  );
}

export function useUpdateParcelLink(propertyId: string) {
  return useHierarchyMutation(propertyId, ({ linkId, relationship }: { linkId: string; relationship: string }) =>
    api.patch(`/properties/${propertyId}/parcels/${linkId}`, { relationship }),
  );
}

export function useUnlinkParcel(propertyId: string) {
  return useHierarchyMutation(propertyId, (linkId: string) => api.delete(`/properties/${propertyId}/parcels/${linkId}`));
}

export function useSaveBuilding(propertyId: string, id?: string) {
  return useHierarchyMutation(propertyId, (data: Record<string, unknown>) =>
    id ? api.patch<Building>(`/properties/${propertyId}/buildings/${id}`, data) : api.post<Building>(`/properties/${propertyId}/buildings`, data),
  );
}

export function useDeleteBuilding(propertyId: string) {
  return useHierarchyMutation(propertyId, (id: string) => api.delete(`/properties/${propertyId}/buildings/${id}`));
}

export function useSaveSpace(propertyId: string, id?: string) {
  return useHierarchyMutation(propertyId, (data: Record<string, unknown>) =>
    id ? api.patch<Space>(`/properties/${propertyId}/spaces/${id}`, data) : api.post<Space>(`/properties/${propertyId}/spaces`, data),
  );
}

export function useDeleteSpace(propertyId: string) {
  return useHierarchyMutation(propertyId, (id: string) => api.delete(`/properties/${propertyId}/spaces/${id}`));
}
