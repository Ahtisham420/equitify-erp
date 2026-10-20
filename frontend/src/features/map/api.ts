"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page, type Params } from "@/lib/api";

export type LayerKey = "properties" | "parcels" | "opportunities" | "assets" | "listings" | "comps" | "territories" | "signals" | "observations";
export type FeatureKind = "property" | "parcel" | "opportunity" | "asset" | "listing" | "comp" | "territory" | "signal" | "observation";

export const LAYER_ORDER: LayerKey[] = ["territories", "parcels", "properties", "comps", "listings", "assets", "opportunities", "signals", "observations"];
export const DEFAULT_LAYERS: LayerKey[] = ["properties", "parcels", "opportunities", "territories"];
export const SIGNAL_CATEGORIES = ["debt", "legal", "tax", "ownership", "physical", "tenancy", "behavioral", "market", "development"] as const;
export const OPPORTUNITY_STAGES = [
  "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
  "under_contract", "due_diligence", "closing", "closed", "dead", "nurture",
] as const;

export interface FeatureProps {
  id: string;
  kind: FeatureKind;
  label: string;
  status?: string | null;
  property_id?: string | null;
  [key: string]: unknown;
}

export interface MapFeature {
  type: "Feature";
  id: string;
  geometry: GeoJSON.Geometry | null;
  properties: FeatureProps;
}

export interface MapFeatureCollection {
  type: "FeatureCollection";
  features: MapFeature[];
  truncated: boolean;
  count: number;
}

export interface LayersResponse {
  layers: Partial<Record<LayerKey, MapFeatureCollection>>;
  hidden: LayerKey[];
  facets: { status?: Record<string, number>; property_type?: Record<string, number>; stage?: Record<string, number> };
}

export interface MapConfig {
  layers: { key: LayerKey; label: string; module: string; allowed: boolean }[];
  viewers: { label: string; url_template: string }[];
  observation_categories: string[];
}

/** A shape drawn on the map: polygons/rectangles as GeoJSON, circles as center + radius. */
export type DrawnShape =
  | { type: "polygon"; geometry: GeoJSON.Polygon }
  | { type: "circle"; lat: number; lng: number; radius_m: number };

export interface SelectedProperty {
  id: string;
  label: string;
  address_line: string;
  city: string | null;
  state: string | null;
  status: string;
  property_type: string;
  opportunity_stage: string | null;
}

export interface SelectedParcel {
  id: string;
  apn: string;
  county: string;
  acreage: number | null;
  situs_address: string | null;
  property_ids: string[];
}

export interface Selection {
  properties: SelectedProperty[];
  parcels: SelectedParcel[];
  truncated: boolean;
  parcels_hidden: boolean;
}

export type BulkAction = "opportunities" | "territory" | "sequence" | "export";

export interface BulkResult {
  action: string;
  applied: boolean;
  properties: number;
  eligible: number;
  done: number;
  skipped: { id: string; label: string | null; reason: string }[];
  warnings: string[];
  blocked: boolean;
  details: Record<string, unknown>;
  filename?: string | null;
  csv?: string | null;
  masked?: boolean;
}

export interface CardOwner {
  kind: "person" | "organization";
  id: string;
  name: string | null;
  role: string | null;
  interest_pct: number | null;
}

export interface RecordCard {
  kind: FeatureKind;
  property: {
    id: string;
    label: string;
    address_line: string;
    city: string | null;
    state: string | null;
    county: string | null;
    status: string;
    property_type: string;
    building_area_sf: number | null;
    land_area_acres: number | null;
    asking_price: number | null;
    year_built: number | null;
    occupancy_pct: number | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  parcel: { id: string; apn: string; county: string; state: string | null; acreage: number | null; situs_address: string | null; property_ids: string[]; source: string | null } | null;
  comp: { id: string; label: string; address_line: string | null; city: string | null; state: string | null; property_type: string | null; sale_date: string | null; sale_price: number | null; price_psf: number | null; cap_rate: number | null; verification_status: string; source: string | null; property_id: string | null } | null;
  observation: FieldObservation | null;
  owners: CardOwner[] | null;
  opportunity: { id: string; title: string; stage: string; priority: string; next_action: string | null; next_action_at: string | null } | null;
  signals: { id: string; category: string; signal_type: string; title: string | null; severity: number; observed_on: string | null }[] | null;
  motivation_index: number | null;
  parcels: { id: string; apn: string; county: string; acreage: number | null }[];
  viewer_links: { label: string; url: string }[];
}

export interface AssemblageResult {
  result: {
    owners: { kind: string; id: string; name: string | null }[];
    groups: { owner: { kind: string; id: string; name: string | null }; parcels: { id: string; apn: string; county: string; acreage: number | null }[]; total_acreage: number }[];
    owners_hidden: boolean;
    ownership_available: boolean;
  };
  geometry: GeoJSON.Geometry | null;
}

export interface FieldObservation {
  id: string;
  client_uuid: string;
  property_id: string | null;
  property_label: string | null;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  observed_at: string;
  category: string;
  note: string | null;
  photo_document_ids: string[];
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface ObservationInput {
  client_uuid: string;
  property_id?: string | null;
  lat: number;
  lng: number;
  accuracy_m?: number | null;
  observed_at?: string;
  category: string;
  note?: string | null;
  photo_document_ids?: string[];
}

export function useMapConfig() {
  return useQuery({ queryKey: ["map", "config"], queryFn: () => api.get<MapConfig>("/map/config"), staleTime: 10 * 60_000 });
}

export function useMapLayers(params: Params | null) {
  return useQuery({
    queryKey: ["map", "layers", params],
    queryFn: () => api.get<LayersResponse>("/map/layers", params ?? undefined),
    enabled: !!params,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useRecordCard(target: { kind: FeatureKind; id: string } | null) {
  return useQuery({
    queryKey: ["map", "card", target?.kind, target?.id],
    queryFn: () => api.get<RecordCard>("/map/card", { kind: target!.kind, id: target!.id }),
    enabled: !!target && target.kind !== "territory",
  });
}

export function useSelectRecords() {
  return useMutation({
    mutationFn: (body: { polygon?: GeoJSON.Polygon; circle?: { lat: number; lng: number; radius_m: number }; property_ids?: string[]; parcel_ids?: string[] }) =>
      api.post<Selection>("/map/select", body),
  });
}

export function useSaveTerritory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string | null; visibility: string; polygon?: GeoJSON.Polygon; circle?: { lat: number; lng: number; radius_m: number } }) =>
      api.post<{ id: string; name: string; rule_type: string; member_count: number }>("/map/territories", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["map", "layers"] });
      qc.invalidateQueries({ queryKey: ["territories"] });
    },
  });
}

export function useAssemblage() {
  return useMutation({ mutationFn: (parcelId: string) => api.get<AssemblageResult>("/map/assemblage", { parcel_id: parcelId }) });
}

export function bulkPath(action: BulkAction) {
  return `/map/bulk/${action}`;
}

export function useObservations(params: Params) {
  return useQuery({
    queryKey: ["map", "observations", params],
    queryFn: () => api.get<Page<FieldObservation>>("/map/observations", params),
  });
}

/** Uploads one field photo through the documents module; returns the document id. */
export async function uploadPhoto(file: Blob, filename: string, propertyId?: string | null): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("title", `Field photo ${new Date().toLocaleString()}`);
  form.append("doc_class", "other");
  form.append("auto_extract", "false");
  if (propertyId) {
    form.append("entity_type", "property");
    form.append("entity_id", propertyId);
  }
  const doc = await api.post<{ id: string }>("/documents", form);
  return doc.id;
}
