"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

import type { RelationshipMetrics } from "@/features/contacts/api";

export type OwnerKind = "person" | "organization";
export type NodeKind = OwnerKind | "property";

export const INTEREST_ROLES = [
  "fee_owner", "tenant_in_common", "general_partner", "limited_partner", "managing_member", "member",
  "beneficial_owner", "ground_lessor", "trustee", "other",
] as const;
export const FINANCING_TYPES = ["all_cash", "bank_loan", "cmbs", "life_company", "seller_financing", "assumed", "private", "unknown"] as const;
export const LINK_RELATIONSHIPS = ["manager", "member", "officer", "director", "registered_agent", "parent", "affiliate", "family", "advisor"] as const;
export const EVIDENCE_TYPES = [
  "shared_mailing_address", "shared_phone", "shared_email_domain", "registered_agent", "officer_director_record",
  "deed_signatory", "corroborated_name", "other",
] as const;
export const NOTE_CATEGORIES = ["preference", "financing", "hold_strategy", "prior_offer", "advisor", "family", "circumstance", "other"] as const;

export const EVIDENCE_LABELS: Record<string, string> = {
  shared_mailing_address: "Shared mailing address",
  shared_phone: "Shared phone",
  shared_email_domain: "Shared email domain",
  registered_agent: "Registered agent",
  officer_director_record: "Officer / director record",
  deed_signatory: "Deed signatory",
  corroborated_name: "Corroborated name",
  other: "Other",
};

export interface Evidence {
  type: string;
  detail?: string | null;
  source?: string | null;
  observed_on?: string | null;
  sensitive?: boolean;
}

export interface Interest {
  id: string;
  property_id: string;
  owner_kind: OwnerKind;
  owner_person_id: string | null;
  owner_organization_id: string | null;
  interest_pct: number | null;
  role: string;
  effective_from: string | null;
  effective_to: string | null;
  acquired_price: number | null;
  disposed_price: number | null;
  financing_type: string | null;
  deed_reference: string | null;
  end_reason: string | null;
  evidence: Evidence[];
  hidden_evidence: number;
  source: string;
  observed_on: string | null;
  confidence: number;
  verification: "unverified" | "verified" | "rejected";
  verified_by_id: string | null;
  verified_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  owner_id: string | null;
  owner_label: string | null;
  owner_state: string | null;
  property_label: string | null;
  property_city: string | null;
  property_state: string | null;
  is_current: boolean;
  hold_years: number | null;
  mismatch: boolean;
}

export interface InterestFacets {
  role: Record<string, number>;
  verification: Record<string, number>;
  owner_kind: Record<string, number>;
}

export interface Link {
  id: string;
  from_kind: OwnerKind;
  from_id: string;
  to_kind: OwnerKind;
  to_id: string;
  from_label: string | null;
  to_label: string | null;
  relationship: string;
  confidence: number;
  status: "suggested" | "confirmed" | "rejected";
  evidence: Evidence[];
  hidden_evidence: number;
  source: string;
  suggested_by: "user" | "engine";
  reviewed_by_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  effective_from: string | null;
  effective_to: string | null;
  notes: string | null;
  created_at: string;
}

export interface LinkFacets {
  status: Record<string, number>;
  relationship: Record<string, number>;
}

export interface OwnerNote {
  id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  category: string;
  body: string;
  sensitive: boolean;
  source: string | null;
  observed_on: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface PortfolioItem {
  interest_id: string;
  property_id: string;
  property_label: string;
  city: string | null;
  state: string | null;
  property_type: string | null;
  role: string;
  interest_pct: number | null;
  effective_from: string | null;
  effective_to: string | null;
  acquired_price: number | null;
  disposed_price: number | null;
  financing_type: string | null;
  hold_years: number | null;
  is_current: boolean;
  verification: string;
  via_label: string | null;
  via_kind: OwnerKind | null;
  via_id: string | null;
}

export interface OwnerProfile {
  kind: OwnerKind;
  id: string;
  label: string;
  subtitle: string | null;
  city: string | null;
  state: string | null;
  mailing_address: string | null;
  masked: boolean;
  relationship_strength: string | null;
  preferences: Record<string, unknown>;
  current: PortfolioItem[];
  prior: PortfolioItem[];
  controlled: PortfolioItem[];
  typical_hold_years: number | null;
  average_current_hold_years: number | null;
  total_acquired_value: number | null;
  financing_patterns: Record<string, number>;
  links: Link[];
  notes: OwnerNote[];
  hidden_notes: number;
  performance: RelationshipMetrics;
  opportunities: { id: string; title: string | null; stage: string | null; property_id: string | null; source: string | null }[];
  recent_interactions: { id: string; channel: string | null; direction: string | null; occurred_at: string | null; summary: string | null }[];
}

export interface PathStep {
  kind: NodeKind;
  id: string;
  label: string;
  relation_to_next: string | null;
}

export interface WarmPath {
  steps: PathStep[];
  length: number;
  start_reason: string | null;
}

export interface ControlRelationship {
  link_id: string;
  controller_kind: OwnerKind;
  controller_id: string;
  controller_label: string | null;
  relationship: string;
  confidence: number;
  status: string;
}

export interface Panel {
  property_id: string;
  property_state: string | null;
  current_owners: {
    interest: Interest;
    mailing_address: string | null;
    mailing_city: string | null;
    mailing_state: string | null;
    controllers: ControlRelationship[];
  }[];
  history: Interest[];
  hold_years: number | null;
  acquired_on: string | null;
  acquired_price: number | null;
  mismatch: boolean;
  controlling_confidence: number | null;
  pending_suggestions: number;
  masked: boolean;
}

export function nodeHref(kind: NodeKind, id: string) {
  return kind === "person" ? `/people/${id}` : kind === "organization" ? `/organizations/${id}` : `/properties/${id}`;
}

/* ---------------------------------------------------------------- queries */

export function usePropertyPanel(propertyId: string) {
  return useQuery({
    queryKey: ["ownership", "panel", propertyId],
    queryFn: () => api.get<Panel>(`/ownership/properties/${propertyId}/panel`),
  });
}

export function useOwnerProfile(kind: OwnerKind | null, id: string | null) {
  return useQuery({
    queryKey: ["ownership", "owner", kind, id],
    queryFn: () => api.get<OwnerProfile>(`/ownership/owners/${kind}/${id}`),
    enabled: !!kind && !!id,
  });
}

export function useWarmPaths(params: { target_kind: NodeKind; target_id: string; from_kind?: OwnerKind; from_id?: string; max_depth?: number } | null) {
  return useQuery({
    queryKey: ["ownership", "paths", params],
    queryFn: () => api.get<WarmPath[]>("/ownership/paths", params ?? undefined),
    enabled: !!params?.target_id,
  });
}

/* ---------------------------------------------------------------- mutations */

function useInvalidateOwnership() {
  const qc = useQueryClient();
  return (propertyId?: string) => {
    qc.invalidateQueries({ queryKey: ["ownership"] });
    qc.invalidateQueries({ queryKey: ["ownership-links"] });
    qc.invalidateQueries({ queryKey: ["people"] });
    qc.invalidateQueries({ queryKey: ["organizations"] });
    if (propertyId) qc.invalidateQueries({ queryKey: ["timeline", "property", propertyId] });
  };
}

export function useInterestMutations() {
  const invalidate = useInvalidateOwnership();
  const done = (i: Interest) => invalidate(i.property_id);
  return {
    create: useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<Interest>("/ownership/interests", body), onSuccess: done }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<Interest>(`/ownership/interests/${id}`, body),
      onSuccess: done,
    }),
    end: useMutation({
      mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.post<Interest>(`/ownership/interests/${id}/end`, body),
      onSuccess: done,
    }),
    verify: useMutation({
      mutationFn: ({ id, state }: { id: string; state: "verified" | "rejected" | "unverified" }) =>
        api.post<Interest>(`/ownership/interests/${id}/verify`, { state }),
      onSuccess: done,
    }),
  };
}

export function useLinkMutations() {
  const invalidate = useInvalidateOwnership();
  const done = () => invalidate();
  return {
    create: useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<Link>("/ownership/links", body), onSuccess: done }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<Link>(`/ownership/links/${id}`, body),
      onSuccess: done,
    }),
    confirm: useMutation({
      mutationFn: ({ id, body }: { id: string; body: { relationship?: string; reverse?: boolean; note?: string } }) =>
        api.post<Link>(`/ownership/links/${id}/confirm`, body),
      onSuccess: done,
    }),
    reject: useMutation({
      mutationFn: ({ id, note }: { id: string; note?: string }) => api.post<Link>(`/ownership/links/${id}/reject`, { note }),
      onSuccess: done,
    }),
    suggest: useMutation({ mutationFn: () => api.post<{ created: number; updated: number }>("/ownership/links/suggest"), onSuccess: done }),
  };
}

export function useNoteMutations(kind: OwnerKind, ownerId: string) {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: ["ownership", "owner", kind, ownerId] });
    qc.invalidateQueries({ queryKey: ["timeline", kind, ownerId] });
  };
  return {
    add: useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<OwnerNote>(`/ownership/owners/${kind}/${ownerId}/notes`, body), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`/ownership/notes/${id}`), onSuccess: done }),
  };
}
