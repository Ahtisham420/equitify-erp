"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type EntityKind = "person" | "organization";

export const ROLES = [
  "owner", "principal", "broker", "agent", "tenant_contact", "vendor_contact", "lender", "attorney",
  "title_officer", "capital_partner", "other",
] as const;
export const ORG_TYPES = [
  "owner_entity", "llc", "corporation", "partnership", "trust", "brokerage", "lender", "law_firm",
  "title_company", "tenant", "vendor", "capital_partner", "government", "other",
] as const;
export const PHONE_TYPES = ["mobile", "landline", "voip", "fax", "unknown"] as const;
export const STRENGTHS = ["none", "weak", "moderate", "strong"] as const;
export const RESPONSIVENESS = ["unknown", "low", "medium", "high"] as const;

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner", principal: "Principal", broker: "Broker", agent: "Agent", tenant_contact: "Tenant contact",
  vendor_contact: "Vendor contact", lender: "Lender", attorney: "Attorney", title_officer: "Title officer",
  capital_partner: "Capital partner", other: "Other",
};
export const ORG_TYPE_LABELS: Record<string, string> = {
  owner_entity: "Owner entity", llc: "LLC", corporation: "Corporation", partnership: "Partnership", trust: "Trust",
  brokerage: "Brokerage", lender: "Lender", law_firm: "Law firm", title_company: "Title company", tenant: "Tenant",
  vendor: "Vendor", capital_partner: "Capital partner", government: "Government", other: "Other",
};

export const STRENGTH_TONE: Record<string, "neutral" | "amber" | "blue" | "green"> = {
  none: "neutral", weak: "amber", moderate: "blue", strong: "green",
};
export const RESPONSIVENESS_TONE: Record<string, "neutral" | "red" | "amber" | "green"> = {
  unknown: "neutral", low: "red", medium: "amber", high: "green",
};

export interface ContactPoint {
  id: string;
  person_id: string | null;
  organization_id: string | null;
  kind: "phone" | "email";
  value: string;
  label: string | null;
  phone_type: string | null;
  is_primary: boolean;
  source: string | null;
  observed_on: string | null;
  masked: boolean;
  created_at: string;
}

export interface Affiliation {
  id: string;
  person_id: string;
  organization_id: string;
  person_name: string | null;
  organization_name: string | null;
  role: string;
  title: string | null;
  is_current: boolean;
  started_on: string | null;
  ended_on: string | null;
  source: string | null;
  notes: string | null;
}

export interface Enrichment {
  id: string;
  person_id: string | null;
  organization_id: string | null;
  provider: string;
  enriched_at: string;
  cost: number | null;
  reliability: number | null;
  fields: string[];
  restrictions: Record<string, unknown>;
  notes: string | null;
  created_by_id: string | null;
}

export interface ComplianceState {
  channel: string;
  value: string;
  allowed: boolean;
  reasons: string[];
}

interface RelationshipFields {
  owner_id: string | null;
  last_touch_at: string | null;
  next_action_at: string | null;
  next_action: string | null;
  responsiveness: string;
  relationship_strength: string;
  preferences: Record<string, unknown>;
  source: string | null;
  notes: string | null;
  tags: string[];
}

export interface PersonListItem {
  id: string;
  full_name: string;
  title: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  city: string | null;
  state: string | null;
  owner_id: string | null;
  last_touch_at: string | null;
  next_action_at: string | null;
  relationship_strength: string;
  responsiveness: string;
  tags: string[];
  organization_name: string | null;
  roles: string[];
  updated_at: string;
  masked: boolean;
}

export interface Person extends RelationshipFields {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  title: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  mailing_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  contact_preferences: Record<string, unknown>;
  contact_points: ContactPoint[];
  affiliations: Affiliation[];
  compliance: ComplianceState[];
  masked: boolean;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
}

export interface OrganizationListItem {
  id: string;
  name: string;
  legal_name: string | null;
  org_type: string;
  domain: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  owner_id: string | null;
  last_touch_at: string | null;
  next_action_at: string | null;
  relationship_strength: string;
  tags: string[];
  member_count: number;
  updated_at: string;
  masked: boolean;
}

export interface Organization extends RelationshipFields {
  id: string;
  name: string;
  legal_name: string | null;
  org_type: string;
  website: string | null;
  domain: string | null;
  phone: string | null;
  mailing_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  state_of_formation: string | null;
  registered_agent: string | null;
  contact_points: ContactPoint[];
  members: Affiliation[];
  masked: boolean;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
}

export interface PeopleFacets {
  state: Record<string, number>;
  relationship_strength: Record<string, number>;
  responsiveness: Record<string, number>;
  role: Record<string, number>;
}

export interface OrganizationFacets {
  org_type: Record<string, number>;
  state: Record<string, number>;
  relationship_strength: Record<string, number>;
}

export interface DuplicateItem {
  id: string;
  entity_type: EntityKind;
  a_id: string;
  b_id: string;
  a_label: string | null;
  b_label: string | null;
  reasons: { type: string; value?: string }[];
  score: number;
  status: "open" | "merged" | "dismissed";
  reviewed_at: string | null;
  created_at: string;
}

export interface MergeItem {
  id: string;
  entity_type: EntityKind;
  survivor_id: string;
  merged_id: string;
  survivor_label: string | null;
  merged_label: string | null;
  repointed_count: number;
  reason: string | null;
  status: "merged" | "reversed";
  merged_at: string;
  created_by_id: string | null;
  reversed_at: string | null;
  reversed_by_id: string | null;
}

export interface ContextOut {
  properties: {
    interest_id: string;
    property_id: string;
    property_label: string;
    city: string | null;
    state: string | null;
    property_type: string | null;
    role: string | null;
    interest_pct: number | null;
    effective_from: string | null;
    effective_to: string | null;
    is_current: boolean;
    via_organization_id: string | null;
    via_organization_name: string | null;
  }[];
  opportunities: { id: string; title: string | null; stage: string | null; property_id: string | null; next_action_at: string | null; source: string | null }[];
  interactions: {
    id: string;
    channel: string | null;
    direction: string | null;
    occurred_at: string | null;
    summary: string | null;
    disposition: string | null;
    property_id: string | null;
    opportunity_id: string | null;
    next_action_at: string | null;
    loop_closed: boolean | null;
  }[];
  tasks: { id: string; title: string; status: string; priority: string; due_at: string | null; assignee_id: string | null }[];
  metrics: RelationshipMetrics;
}

export interface RelationshipMetrics {
  last_touch_at: string | null;
  next_action_at: string | null;
  interactions: number;
  meaningful_interactions: number;
  outbound: number;
  inbound: number;
  response_rate: number | null;
  opportunities: number;
  won: number;
  lost: number;
  close_rate: number | null;
  source_attribution: Record<string, number>;
}

export const kindPath = (kind: EntityKind) => (kind === "person" ? "people" : "organizations");

/* ---------------------------------------------------------------- queries */

export function usePerson(id: string) {
  return useQuery({ queryKey: ["people", id], queryFn: () => api.get<Person>(`/people/${id}`) });
}

export function useOrganization(id: string) {
  return useQuery({ queryKey: ["organizations", id], queryFn: () => api.get<Organization>(`/organizations/${id}`) });
}

export function useContactContext(kind: EntityKind, id: string) {
  return useQuery({ queryKey: [kindPath(kind), id, "context"], queryFn: () => api.get<ContextOut>(`/${kindPath(kind)}/${id}/context`) });
}

export function useEnrichments(kind: EntityKind, id: string) {
  return useQuery({ queryKey: [kindPath(kind), id, "enrichments"], queryFn: () => api.get<Enrichment[]>(`/${kindPath(kind)}/${id}/enrichments`) });
}

export function useDuplicates(entityType: EntityKind, status: string, enabled = true) {
  return useQuery({
    queryKey: ["contacts", "duplicates", entityType, status],
    queryFn: () => api.get<DuplicateItem[]>("/contacts/duplicates", { entity_type: entityType, status }),
    enabled,
  });
}

export function useMerges(entityType: EntityKind, recordId?: string, enabled = true) {
  return useQuery({
    queryKey: ["contacts", "merges", entityType, recordId ?? null],
    queryFn: () => api.get<MergeItem[]>("/contacts/merges", { entity_type: entityType, record_id: recordId }),
    enabled,
  });
}

/* ---------------------------------------------------------------- mutations */

function useInvalidate(kind: EntityKind) {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: [kindPath(kind)] });
    qc.invalidateQueries({ queryKey: ["contacts"] });
    if (id) qc.invalidateQueries({ queryKey: ["timeline", kind, id] });
  };
}

export function useSavePerson(id?: string) {
  const invalidate = useInvalidate("person");
  return useMutation({
    mutationFn: ({ data, force }: { data: Record<string, unknown>; force?: boolean }) =>
      id ? api.patch<Person>(`/people/${id}`, data) : api.post<Person>("/people", data, force ? { force: true } : undefined),
    onSuccess: (p) => invalidate(p.id),
  });
}

export function useSaveOrganization(id?: string) {
  const invalidate = useInvalidate("organization");
  return useMutation({
    mutationFn: ({ data, force }: { data: Record<string, unknown>; force?: boolean }) =>
      id ? api.patch<Organization>(`/organizations/${id}`, data) : api.post<Organization>("/organizations", data, force ? { force: true } : undefined),
    onSuccess: (o) => invalidate(o.id),
  });
}

export function useContactPointMutations(kind: EntityKind, ownerId: string) {
  const invalidate = useInvalidate(kind);
  const done = () => invalidate(ownerId);
  return {
    add: useMutation({
      mutationFn: (body: Record<string, unknown>) => api.post<ContactPoint>(`/${kindPath(kind)}/${ownerId}/contact-points`, body),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<ContactPoint>(`/contact-points/${id}`, body),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`/contact-points/${id}`), onSuccess: done }),
  };
}

export function useAffiliationMutations() {
  const qc = useQueryClient();
  const done = (a: Affiliation) => {
    qc.invalidateQueries({ queryKey: ["people"] });
    qc.invalidateQueries({ queryKey: ["organizations"] });
    qc.invalidateQueries({ queryKey: ["timeline", "person", a.person_id] });
    qc.invalidateQueries({ queryKey: ["timeline", "organization", a.organization_id] });
  };
  return {
    create: useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<Affiliation>("/affiliations", body), onSuccess: done }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<Affiliation>(`/affiliations/${id}`, body),
      onSuccess: done,
    }),
  };
}

export function useAddEnrichment(kind: EntityKind, id: string) {
  const invalidate = useInvalidate(kind);
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Enrichment>(`/${kindPath(kind)}/${id}/enrichments`, body),
    onSuccess: () => invalidate(id),
  });
}

export function useBulkContacts(kind: EntityKind) {
  const invalidate = useInvalidate(kind);
  return useMutation({
    mutationFn: (body: { ids: string[]; owner_id?: string; relationship_strength?: string; add_tags?: string[] }) =>
      api.post<{ updated: number }>(`/${kindPath(kind)}/bulk`, body),
    onSuccess: () => invalidate(),
  });
}

export function useDuplicateMutations(kind: EntityKind) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(kind);
  const all = () => {
    invalidate();
    qc.invalidateQueries({ queryKey: ["ownership"] });
  };
  return {
    scan: useMutation({
      mutationFn: () => api.post<{ scanned: number; new_candidates: number }>("/contacts/duplicates/scan", undefined, { entity_type: kind }),
      onSuccess: all,
    }),
    dismiss: useMutation({ mutationFn: (id: string) => api.post<DuplicateItem>(`/contacts/duplicates/${id}/dismiss`), onSuccess: all }),
    merge: useMutation({
      mutationFn: (body: { survivor_id: string; merged_id: string; take_from_merged: string[]; review_id?: string; reason?: string }) =>
        api.post<MergeItem>("/contacts/merge", { entity_type: kind, ...body }),
      onSuccess: all,
    }),
    unmerge: useMutation({ mutationFn: (id: string) => api.post<MergeItem>(`/contacts/merges/${id}/unmerge`), onSuccess: all }),
  };
}
