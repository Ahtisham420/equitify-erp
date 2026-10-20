"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page, type Params } from "@/lib/api";

/* ------------------------------------------------------------------ enums & labels */

export const PROSPECT_STAGES = ["prospect", "pitched", "engaged", "lost"] as const;
export const MARKET_STATUSES = ["not_listed", "competitor_listed", "expiring", "expired", "withdrawn", "off_market"] as const;
export const LOST_REASONS = ["chose_competitor", "not_selling", "price_expectation", "fee", "timing", "relationship", "other"] as const;
export const EXCLUSIVITY = ["exclusive_right", "exclusive_agency", "open", "non_exclusive"] as const;
export const COMMISSION_STRUCTURES = ["percent", "flat", "tiered"] as const;
export const AGREEMENT_STATUSES = ["draft", "active", "expired", "terminated"] as const;
export const LISTING_TYPES = ["sale", "lease"] as const;
export const LISTING_STATUSES = ["draft", "coming_soon", "active", "under_contract", "sold", "leased", "withdrawn", "expired"] as const;
export const REPORT_CADENCES = ["none", "weekly", "biweekly", "monthly"] as const;
export const MARKETING_KINDS = ["offering_memorandum", "flyer", "brochure", "email_campaign", "signage", "photography", "video", "website", "other"] as const;
export const MARKETING_STATUSES = ["draft", "in_review", "approved", "published", "retired"] as const;
export const SYNDICATION_CHANNELS = ["loopnet", "costar", "crexi", "company_website", "mls", "email", "social", "other"] as const;
export const SYNDICATION_STATUSES = ["not_syndicated", "pending", "live", "paused", "removed", "error"] as const;
export const INQUIRY_SOURCES = ["website", "loopnet", "costar", "crexi", "sign_call", "email_campaign", "referral", "cold_call", "broker", "other"] as const;
export const INQUIRY_STATUSES = ["new", "contacted", "qualified", "nda_sent", "toured", "offer", "dead"] as const;
export const SHOWING_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;
export const INTEREST_LEVELS = ["none", "low", "medium", "high"] as const;
export const REQUIREMENT_STATUSES = ["active", "paused", "fulfilled", "closed"] as const;
export const MATCH_STATUSES = ["suggested", "sent", "interested", "toured", "rejected", "offer"] as const;
export const PROPOSAL_KINDS = ["listing_proposal", "purchase_proposal", "lease_proposal", "buyer_proposal", "tenant_proposal"] as const;
export const PROPOSAL_STATUSES = ["draft", "sent", "countered", "accepted", "rejected", "withdrawn", "superseded"] as const;
export const DEAL_SIDES = ["listing", "buyer", "tenant", "landlord", "dual"] as const;
export const DEAL_STAGES = ["lead", "engaged", "marketing", "touring", "negotiation", "under_contract", "closing", "closed", "lost"] as const;
export const ACTIVE_DEAL_STAGES = DEAL_STAGES.slice(0, 7);
export const RECRUIT_STAGES = ["lead", "contacted", "interviewing", "offer", "hired", "onboarding", "active", "declined", "lost"] as const;

export const LABELS: Record<string, string> = {
  not_listed: "Not listed",
  competitor_listed: "Listed with competitor",
  expiring: "Competitor listing expiring",
  off_market: "Off market",
  exclusive_right: "Exclusive right to sell / lease",
  exclusive_agency: "Exclusive agency",
  non_exclusive: "Non-exclusive",
  coming_soon: "Coming soon",
  under_contract: "Under contract",
  offering_memorandum: "Offering memorandum",
  email_campaign: "Email campaign",
  company_website: "Company website",
  loopnet: "LoopNet",
  costar: "CoStar",
  crexi: "Crexi",
  mls: "MLS",
  not_syndicated: "Not syndicated",
  sign_call: "Sign call",
  cold_call: "Cold call",
  nda_sent: "NDA sent",
  no_show: "No show",
  listing_proposal: "Listing proposal",
  purchase_proposal: "Purchase proposal",
  lease_proposal: "Lease proposal",
  buyer_proposal: "Buyer proposal",
  tenant_proposal: "Tenant proposal",
  chose_competitor: "Chose competitor",
  price_expectation: "Price expectation",
};

export function label(v?: string | null): string {
  if (!v) return "—";
  return LABELS[v] ?? v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: label(v) }));

/* ------------------------------------------------------------------ types */

interface Labels {
  property_label: string | null;
  agent_name: string | null;
  person_label: string | null;
  organization_label: string | null;
}

export interface Prospect extends Labels {
  id: string;
  title: string;
  property_id: string | null;
  owner_person_id: string | null;
  owner_organization_id: string | null;
  opportunity_id: string | null;
  agent_id: string | null;
  source: string | null;
  stage: string;
  stage_entered_at: string;
  market_status: string;
  competitor_broker: string | null;
  competitor_list_price: number | null;
  competitor_listed_on: string | null;
  competitor_expires_on: string | null;
  estimated_value: number | null;
  next_action: string | null;
  next_action_at: string | null;
  lost_reason: string | null;
  listing_id: string | null;
  notes: string | null;
  tags: string[];
  pitch_count: number;
  last_pitched_on: string | null;
  days_to_competitor_expiry: number | null;
  created_at: string;
  updated_at: string;
}

export interface Pitch {
  id: string;
  prospect_id: string;
  kind: "pitch" | "bov";
  pitched_on: string;
  bov_id: string | null;
  comp_set_id: string | null;
  value_low: number | null;
  value_point: number | null;
  value_high: number | null;
  valuation_method: string | null;
  valuation_as_of: string | null;
  recommended_price: number | null;
  proposed_commission_rate: number | null;
  outcome: string;
  document_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface Agreement extends Labels {
  id: string;
  kind?: "buyer" | "tenant";
  prospect_id?: string | null;
  listing_id?: string | null;
  property_id?: string | null;
  client_person_id: string | null;
  client_organization_id: string | null;
  agent_id: string | null;
  status: string;
  exclusivity: string;
  starts_on: string | null;
  expires_on: string | null;
  term_months?: number | null;
  territory?: string | null;
  commission_structure: string;
  commission_rate: number | null;
  commission_flat: number | null;
  signed_on: string | null;
  document_id: string | null;
  critical_date_id: string | null;
  days_to_expiry: number | null;
  notes: string | null;
  updated_at: string;
}

export interface Listing extends Labels {
  id: string;
  property_id: string;
  prospect_id: string | null;
  engagement_agreement_id: string | null;
  agent_id: string | null;
  seller_person_id: string | null;
  seller_organization_id: string | null;
  listing_type: string;
  status: string;
  status_changed_at: string;
  asking_price: number | null;
  asking_rent_psf: number | null;
  cap_rate: number | null;
  listed_on: string | null;
  expires_on: string | null;
  closed_on: string | null;
  closed_price: number | null;
  headline: string | null;
  description: string | null;
  highlights: string[];
  reporting_cadence: string;
  next_report_on: string | null;
  deal_room_id: string | null;
  notes: string | null;
  tags: string[];
  property_city: string | null;
  property_state: string | null;
  property_type: string | null;
  days_on_market: number | null;
  price_change_count: number;
  inquiry_count: number;
  showing_count: number;
  created_at: string;
  updated_at: string;
}

export interface PriceHistory {
  id: string;
  listing_id: string;
  price: number | null;
  previous_price: number | null;
  rent_psf: number | null;
  effective_on: string;
  reason: string | null;
  source: string;
  actor_name: string | null;
  at: string;
}

export interface StatusEvent {
  id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor_name: string | null;
  at: string;
}

export interface MarketingItem {
  id: string;
  listing_id: string;
  kind: string;
  title: string;
  status: string;
  channels: string[];
  syndication_status: string;
  syndicated_at: string | null;
  external_url: string | null;
  document_ids: string[];
  notes: string | null;
  ad_review_status: string | null;
  updated_at: string;
}

export interface Inquiry extends Labels {
  id: string;
  listing_id: string | null;
  property_id: string | null;
  person_id: string | null;
  organization_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string;
  received_at: string;
  status: string;
  message: string | null;
  assigned_to_id: string | null;
  assigned_name: string | null;
  follow_up_at: string | null;
  follow_up_task_id: string | null;
  notes: string | null;
}

export interface Showing extends Labels {
  id: string;
  listing_id: string | null;
  property_id: string | null;
  inquiry_id: string | null;
  tour_id: string | null;
  person_id: string | null;
  organization_id: string | null;
  contact_name: string | null;
  scheduled_at: string;
  shown_by_id: string | null;
  shown_by_name: string | null;
  status: string;
  interest_level: string | null;
  feedback: string | null;
  notes: string | null;
}

export interface SellerReport {
  id: string;
  listing_id: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  summary: {
    inquiries?: { count: number; by_source: Record<string, number>; by_status: Record<string, number> };
    showings?: { count: number; completed: number; by_interest: Record<string, number>; feedback: string[] };
    offers?: { count: number; high?: number | null; low?: number | null; by_status?: Record<string, number> };
    price_changes?: { effective_on: string; price: number | null; previous_price: number | null; reason: string | null }[];
    syndication_channels?: string[];
    asking_price?: number | null;
    days_on_market?: number | null;
    status?: string;
  };
  commentary: string | null;
  status: string;
  sent_at: string | null;
  sent_to: string | null;
}

export interface Requirement extends Labels {
  id: string;
  name: string;
  rep_agreement_id: string | null;
  client_person_id: string | null;
  client_organization_id: string | null;
  agent_id: string | null;
  side: string;
  status: string;
  property_types: string[];
  min_size_sf: number | null;
  max_size_sf: number | null;
  min_acres: number | null;
  max_acres: number | null;
  min_price: number | null;
  max_price: number | null;
  states: string[];
  cities: string[];
  counties: string[];
  territory_id: string | null;
  near_lat: number | null;
  near_lng: number | null;
  radius_miles: number | null;
  features: string[];
  notes: string | null;
  last_matched_at: string | null;
  match_count: number;
  updated_at: string;
}

export interface Match {
  id: string;
  requirement_id: string;
  property_id: string;
  listing_id: string | null;
  status: string;
  matched_at: string;
  criteria_met: string[];
  notes: string | null;
  property_label: string | null;
  property_city: string | null;
  property_state: string | null;
  property_type: string | null;
  building_area_sf: number | null;
  asking_price: number | null;
}

export interface Proposal extends Labels {
  id: string;
  kind: string;
  title: string;
  version: number;
  parent_proposal_id: string | null;
  brokerage_deal_id: string | null;
  prospect_id: string | null;
  listing_id: string | null;
  requirement_id: string | null;
  property_id: string | null;
  recipient_person_id: string | null;
  recipient_organization_id: string | null;
  agent_id: string | null;
  status: string;
  price: number | null;
  rent_psf: number | null;
  term_months: number | null;
  commission_rate: number | null;
  terms: string | null;
  sent_on: string | null;
  response_due_on: string | null;
  document_id: string | null;
  notes: string | null;
  updated_at: string;
}

export interface Deal extends Labels {
  id: string;
  title: string;
  agent_id: string | null;
  side: string;
  property_id: string | null;
  listing_id: string | null;
  rep_agreement_id: string | null;
  requirement_id: string | null;
  client_person_id: string | null;
  client_organization_id: string | null;
  counterparty_person_id: string | null;
  counterparty_organization_id: string | null;
  is_dual_rep: boolean;
  stage: string;
  stage_entered_at: string;
  expected_close_on: string | null;
  probability: number | null;
  effective_probability: number;
  deal_value: number | null;
  commission_rate: number | null;
  gross_commission_estimate: number | null;
  weighted_commission: number | null;
  closed_on: string | null;
  closed_price: number | null;
  lost_reason: string | null;
  next_action: string | null;
  next_action_at: string | null;
  notes: string | null;
  tags: string[];
  file_complete: boolean | null;
  updated_at: string;
}

export interface DealColumn {
  stage: string;
  count: number;
  gross_commission: number;
  weighted_commission: number;
  items: Deal[];
}

export interface Recruit {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  current_brokerage: string | null;
  specialty: string | null;
  years_experience: number | null;
  annual_production: number | null;
  license_number: string | null;
  license_state: string | null;
  source: string | null;
  stage: string;
  stage_entered_at: string;
  recruiter_id: string | null;
  recruiter_name: string | null;
  next_action_at: string | null;
  start_on: string | null;
  user_id: string | null;
  onboarding: { key: string; label: string; done: boolean; done_at: string | null; done_by: string | null; note: string | null }[];
  onboarding_pct: number;
  notes: string | null;
  updated_at: string;
}

export interface Workspace {
  prospects_by_stage: Record<string, number>;
  listings_by_status: Record<string, number>;
  deals_by_stage: Record<string, number>;
  pipeline_gross: number;
  pipeline_weighted: number;
  expected_close_90d: number;
  expiring_agreements: number;
  open_inquiries: number;
  upcoming_showings: number;
  overdue_actions: number;
}

export interface DocOption {
  id: string;
  title: string;
  filename: string | null;
  doc_class: string | null;
}

/* ------------------------------------------------------------------ hooks */

/** Mutation that invalidates the given query roots on success (defaults to everything brokerage). */
export function useMutate<TVars, TRes = unknown>(fn: (vars: TVars) => Promise<TRes>, roots: string[] = ["brokerage"]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const r of roots) qc.invalidateQueries({ queryKey: [r] });
    },
  });
}

export function useGet<T>(key: unknown[], path: string | null, params?: Params) {
  return useQuery({
    queryKey: ["brokerage", ...key, params ?? {}],
    queryFn: () => api.get<T>(path!, params),
    enabled: !!path,
  });
}

export function usePageOf<T>(key: string, path: string, params: Params, enabled = true) {
  return useQuery({
    queryKey: ["brokerage", key, params],
    queryFn: () => api.get<Page<T>>(path, params),
    enabled,
  });
}

export function useListing(id: string) {
  return useQuery({ queryKey: ["brokerage", "listing", id], queryFn: () => api.get<Listing>(`/listings/${id}`) });
}

export function useWorkspace(params: Params) {
  return useQuery({ queryKey: ["brokerage", "workspace", params], queryFn: () => api.get<Workspace>("/brokerage/workspace", params) });
}

/** Map of user id → name, used to label agent facets. */
export function useUserNames() {
  const { data } = useQuery({
    queryKey: ["users-options"],
    queryFn: () => api.get<{ id: string; full_name: string }[]>("/users/options"),
    staleTime: 5 * 60_000,
  });
  return Object.fromEntries((data ?? []).map((u) => [u.id, u.full_name])) as Record<string, string>;
}
