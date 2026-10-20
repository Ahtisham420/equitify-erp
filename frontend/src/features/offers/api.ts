"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const OFFER_STATUSES = ["draft", "pending_approval", "approved", "sent", "countered", "accepted", "rejected", "expired", "withdrawn"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OPEN_STATUSES: OfferStatus[] = ["draft", "pending_approval", "approved", "sent", "countered"];
export const STRUCTURES = ["all_cash", "conventional_financing", "assumption", "seller_financing", "joint_venture", "other"] as const;

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  sent: "Sent",
  countered: "Countered",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

export const STRUCTURE_LABELS: Record<string, string> = {
  all_cash: "All cash",
  conventional_financing: "Conventional financing",
  assumption: "Loan assumption",
  seller_financing: "Seller financing",
  joint_venture: "Joint venture",
  other: "Other",
};

export const ORIGIN_LABELS: Record<string, string> = { buyer: "Our offer", seller: "Counterparty counter" };

/** Statuses missing from the shared StatusBadge tone map get an explicit tone. */
export function offerTone(status: string): "neutral" | "blue" | "green" | "amber" | "red" | "sky" {
  switch (status) {
    case "pending_approval":
      return "amber";
    case "sent":
      return "blue";
    case "countered":
      return "sky";
    case "accepted":
    case "approved":
      return "green";
    case "rejected":
      return "red";
    default:
      return "neutral";
  }
}

export interface OfferListItem {
  id: string;
  opportunity_id: string;
  opportunity_title: string | null;
  owner_id: string | null;
  owner_name: string | null;
  property_id: string | null;
  property_label: string | null;
  uw_model_id: string;
  uw_model_version: number | null;
  root_offer_id: string | null;
  parent_offer_id: string | null;
  version: number;
  is_latest: boolean;
  origin: "buyer" | "seller";
  status: OfferStatus;
  price: number;
  structure: string;
  model_price: number | null;
  deviation_pct: number | null;
  earnest_money: number | null;
  feasibility_days: number | null;
  closing_days: number | null;
  approval_required: boolean;
  sent_at: string | null;
  response_due_at: string | null;
  hours_to_due: number | null;
  overdue: boolean;
  winning_price: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface OfferTerms {
  price?: number | null;
  structure?: string | null;
  earnest_money?: number | null;
  earnest_money_hard_days?: number | null;
  feasibility_days?: number | null;
  closing_days?: number | null;
  extension_count?: number | null;
  extension_days?: number | null;
  extension_cost?: number | null;
  financing_contingency?: boolean | null;
  financing_days?: number | null;
  title_survey_days?: number | null;
  title_survey_terms?: string | null;
  assignment_allowed?: boolean | null;
  assignment_terms?: string | null;
  access_terms?: string | null;
  exclusivity_days?: number | null;
  expiration_at?: string | null;
  buyer_entity?: string | null;
  seller_name?: string | null;
  other_terms?: string | null;
  notes?: string | null;
  tags?: string[] | null;
}

export interface Offer extends OfferListItem {
  model_outputs: Record<string, unknown>;
  earnest_money_hard_days: number | null;
  extension_count: number | null;
  extension_days: number | null;
  extension_cost: number | null;
  financing_contingency: boolean;
  financing_days: number | null;
  title_survey_days: number | null;
  title_survey_terms: string | null;
  assignment_allowed: boolean;
  assignment_terms: string | null;
  access_terms: string | null;
  exclusivity_days: number | null;
  expiration_at: string | null;
  buyer_entity: string | null;
  seller_name: string | null;
  other_terms: string | null;
  notes: string | null;
  approvals_required: number;
  approval_reasons: string[];
  submission_no: number;
  submitted_at: string | null;
  submitted_by_id: string | null;
  approved_at: string | null;
  approvals_received: number;
  sent_by_id: string | null;
  sent_to: string | null;
  sent_via: string | null;
  critical_date_id: string | null;
  follow_up_task_id: string | null;
  escalation_task_id: string | null;
  responded_at: string | null;
  response_note: string | null;
  expired_at: string | null;
  winning_buyer: string | null;
  winning_price_source: string | null;
  winning_price_recorded_at: string | null;
  has_loi: boolean;
  can_edit: boolean;
  can_approve: boolean;
  created_by_id: string | null;
}

export interface OfferApproval {
  id: string;
  offer_id: string;
  submission_no: number;
  decision: "approved" | "rejected";
  approver_id: string | null;
  approver_name: string | null;
  decided_at: string;
  note: string | null;
  price: number | null;
  deviation_pct: number | null;
  reasons: string[];
}

export interface TermDelta {
  field: string;
  label: string;
  from_value: unknown;
  to_value: unknown;
  change: number | null;
  change_pct: number | null;
}

export interface OfferDelta {
  from_offer_id: string;
  from_version: number;
  to_offer_id: string;
  to_version: number;
  changes: TermDelta[];
  unchanged: string[];
}

export interface OfferFacets {
  status: Record<string, number>;
  origin: Record<string, number>;
  due: Record<string, number>;
}

export interface ApprovedModel {
  id: string;
  name: string | null;
  version: number | null;
  property_id: string | null;
  opportunity_id: string | null;
  approved_at: string | null;
  purchase_price: number | null;
  going_in_cap: number | null;
  irr: number | null;
}

export interface LoiParagraph {
  key: string;
  heading: string;
  text: string;
}

export interface LoiPayload {
  offer_id: string;
  version: number;
  status: string;
  generated_at: string;
  opportunity_title: string;
  buyer_entity: string | null;
  seller_name: string | null;
  property: { id: string; name: string | null; address_line: string; city: string | null; state: string | null; postal_code: string | null } | null;
  paragraphs: LoiParagraph[];
  underwriting: { uw_model_id: string; version: number | null; model_price: number | null; deviation_pct: number | null };
  approvals: { approver_name: string | null; decided_at: string }[];
}

export interface OfferSettings {
  price_threshold: number | null;
  deviation_threshold_pct: number;
  second_approval_deviation_pct: number;
  approval_structures: string[];
  max_feasibility_days: number | null;
  max_earnest_money_pct: number | null;
  require_approval_always: boolean;
  default_response_days: number;
  updated_at?: string | null;
}

/** Response clock label: "in 5h", "2d 3h left", "overdue 4h". */
export function clockLabel(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined) return null;
  const abs = Math.abs(hours);
  const text = abs >= 48 ? `${Math.floor(abs / 24)}d ${Math.round(abs % 24)}h` : `${Math.round(abs)}h`;
  return hours < 0 ? `overdue ${text}` : `${text} left`;
}

function invalidate(qc: ReturnType<typeof useQueryClient>, o?: { id: string; opportunity_id: string }) {
  qc.invalidateQueries({ queryKey: ["offers"] });
  if (o) {
    qc.invalidateQueries({ queryKey: ["timeline", "offer", o.id] });
    qc.invalidateQueries({ queryKey: ["opportunities"] });
  }
  qc.invalidateQueries({ queryKey: ["tasks"] });
}

export function useOffer(id: string) {
  return useQuery({ queryKey: ["offers", id], queryFn: () => api.get<Offer>(`/offers/${id}`) });
}

export function useOfferVersions(id: string) {
  return useQuery({ queryKey: ["offers", id, "versions"], queryFn: () => api.get<OfferListItem[]>(`/offers/${id}/versions`) });
}

export function useOfferApprovals(id: string) {
  return useQuery({ queryKey: ["offers", id, "approvals"], queryFn: () => api.get<OfferApproval[]>(`/offers/${id}/approvals`) });
}

export function useOfferDelta(id: string, against: string | null, enabled = true) {
  return useQuery({
    queryKey: ["offers", id, "delta", against],
    queryFn: () => api.get<OfferDelta>(`/offers/${id}/delta`, against ? { against } : undefined),
    enabled,
    retry: false,
  });
}

export function useLoi(id: string, enabled = true) {
  return useQuery({ queryKey: ["offers", id, "loi"], queryFn: () => api.get<LoiPayload>(`/offers/${id}/loi`), enabled, retry: false });
}

export function useApprovedModels(opportunityId: string | null) {
  return useQuery({
    queryKey: ["offers", "approved-models", opportunityId],
    queryFn: () => api.get<ApprovedModel[]>("/offers/approved-models", { opportunity_id: opportunityId }),
    enabled: !!opportunityId,
  });
}

export function useOfferSettings() {
  return useQuery({ queryKey: ["offers", "settings"], queryFn: () => api.get<OfferSettings>("/offers/settings") });
}

export function useSaveOfferSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OfferSettings) => api.put<OfferSettings>("/offers/settings", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offers", "settings"] }),
  });
}

export function useCreateOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OfferTerms & { opportunity_id: string; uw_model_id: string; price: number }) => api.post<Offer>("/offers", body),
    onSuccess: (o) => invalidate(qc, o),
  });
}

export function useUpdateOffer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OfferTerms) => api.patch<Offer>(`/offers/${id}`, body),
    onSuccess: (o) => invalidate(qc, o),
  });
}

export function useCounterOffer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OfferTerms & { origin: "buyer" | "seller"; response_note?: string | null; responded_at?: string | null }) =>
      api.post<Offer>(`/offers/${id}/counter`, body),
    onSuccess: (o) => invalidate(qc, o),
  });
}

/** Generic POST action on an offer (submit / approve / send / respond / winning-price). */
export function useOfferAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: "submit" | "approve" | "send" | "respond" | "winning-price"; body?: unknown }) =>
      api.post<Offer>(`/offers/${id}/${action}`, body),
    onSuccess: (o) => invalidate(qc, o),
  });
}

export function useDeleteOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/offers/${id}`),
    onSuccess: () => invalidate(qc),
  });
}
