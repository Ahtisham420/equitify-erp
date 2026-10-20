"use client";

export const TOUR_STATUSES = ["planned", "confirmed", "completed", "cancelled"] as const;
export const NDA_STATUSES = ["not_sent", "sent", "signed", "declined", "expired"] as const;
export const ROOM_STATUSES = ["draft", "open", "closed", "archived"] as const;
export const OFFER_STATUSES = ["submitted", "under_review", "shortlisted", "countered", "accepted", "rejected", "withdrawn"] as const;
export const FINANCING_TYPES = ["cash", "conventional", "sba", "seller_financing", "assumption", "other"] as const;
export const LICENSE_TYPES = ["salesperson", "broker", "broker_associate", "managing_broker", "firm"] as const;
export const LICENSE_STATUSES = ["active", "pending_renewal", "expired", "suspended", "inactive"] as const;
export const DISCLOSURE_TYPES = ["agency", "dual_agency", "intermediary", "seller_property_condition", "lead_paint", "environmental", "material_defect", "affiliated_business", "other"] as const;
export const DISCLOSURE_STATUSES = ["required", "delivered", "acknowledged", "waived"] as const;
export const DELIVERY_METHODS = ["email", "in_person", "portal", "mail", "e_sign"] as const;
export const AD_REVIEW_STATUSES = ["pending", "approved", "rejected", "changes_requested"] as const;
export const FILE_ITEM_STATUSES = ["missing", "provided", "approved", "waived", "rejected"] as const;

export const DR_KEY = "dealroom";

interface Labels {
  property_label: string | null;
  agent_name: string | null;
  person_label: string | null;
  organization_label: string | null;
}

export interface Participant {
  kind: "user" | "person" | "organization" | "external";
  id: string | null;
  name: string;
  email: string | null;
  role: string | null;
}

export interface Tour extends Labels {
  id: string;
  title: string;
  agent_id: string | null;
  client_person_id: string | null;
  client_organization_id: string | null;
  brokerage_deal_id: string | null;
  requirement_id: string | null;
  scheduled_on: string;
  start_time: string | null;
  status: string;
  start_label: string | null;
  start_lat: number | null;
  start_lng: number | null;
  total_distance_miles: number | null;
  optimized_at: string | null;
  participants: Participant[];
  notes: string | null;
  stop_count: number;
  feedback_count: number;
  updated_at: string;
}

export interface Stop {
  id: string;
  tour_id: string;
  property_id: string;
  listing_id: string | null;
  sequence: number;
  arrive_time: string | null;
  duration_minutes: number;
  distance_from_prev_miles: number | null;
  status: string;
  access_notes: string | null;
  property_label: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  has_location: boolean;
}

export interface Feedback extends Labels {
  id: string;
  tour_id: string;
  stop_id: string | null;
  property_id: string | null;
  listing_id: string | null;
  person_id: string | null;
  rating: number | null;
  interest_level: string | null;
  feedback: string | null;
  objections: string | null;
  next_action: string | null;
  next_action_at: string | null;
  follow_up_task_id: string | null;
  showing_id: string | null;
  created_at: string;
}

export interface Nda extends Labels {
  id: string;
  counterparty_kind: string;
  person_id: string | null;
  organization_id: string | null;
  deal_room_id: string | null;
  listing_id: string | null;
  brokerage_deal_id: string | null;
  status: string;
  sent_at: string | null;
  signed_at: string | null;
  expires_on: string | null;
  signer_name: string | null;
  signer_email: string | null;
  document_id: string | null;
  notes: string | null;
  is_effective: boolean;
}

export interface Room {
  id: string;
  name: string;
  listing_id: string | null;
  brokerage_deal_id: string | null;
  property_id: string | null;
  owner_id: string | null;
  status: string;
  requires_nda: boolean;
  allow_offers: boolean;
  offer_deadline: string | null;
  description: string | null;
  opened_at: string | null;
  closed_at: string | null;
  property_label: string | null;
  owner_name: string | null;
  grant_count: number;
  document_count: number;
  view_count: number;
  offer_count: number;
  last_activity_at: string | null;
  updated_at: string;
}

export interface DocRef {
  id: string;
  title: string | null;
  filename: string | null;
  doc_class: string | null;
  mime_type: string | null;
}

export interface Folder {
  id: string;
  room_id: string;
  name: string;
  sort_order: number;
  is_restricted: boolean;
  document_ids: string[];
  documents: DocRef[];
}

export interface Access extends Labels {
  id: string;
  room_id: string;
  grantee_kind: string;
  person_id: string | null;
  organization_id: string | null;
  user_id: string | null;
  user_name: string | null;
  email: string | null;
  folder_ids: string[];
  can_download: boolean;
  can_submit_offers: boolean;
  expires_at: string | null;
  nda_id: string | null;
  nda_status: string | null;
  status: string;
  effective_status: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
  created_at: string;
}

export interface AccessLog {
  id: string;
  document_id: string | null;
  document_title: string | null;
  folder_id: string | null;
  action: string;
  actor_name: string | null;
  is_internal: boolean;
  detail: string | null;
  at: string;
}

export interface Analytics {
  total_views: number;
  total_downloads: number;
  denied: number;
  unique_viewers: number;
  by_viewer: { viewer: string; internal: boolean; views: number; downloads: number; denied: number; documents: number; last_at: string }[];
  by_document: { document_id: string; title: string | null; views: number; downloads: number; unique_viewers: number; last_at: string }[];
  recent: AccessLog[];
}

export interface License {
  id: string;
  user_id: string | null;
  user_name: string | null;
  holder_name: string;
  license_type: string;
  license_number: string;
  state: string;
  issued_on: string | null;
  expires_on: string | null;
  status: string;
  ce_hours_required: number | null;
  ce_hours_completed: number | null;
  sponsoring_broker: string | null;
  document_id: string | null;
  notes: string | null;
  days_to_expiry: number | null;
  alert_level: string | null;
}

export interface Disclosure extends Labels {
  id: string;
  brokerage_deal_id: string | null;
  listing_id: string | null;
  property_id: string | null;
  disclosure_type: string;
  title: string;
  recipient_person_id: string | null;
  recipient_organization_id: string | null;
  recipient_name: string | null;
  due_on: string | null;
  status: string;
  is_blocking: boolean;
  requires_acknowledgement: boolean;
  delivered_at: string | null;
  delivery_method: string | null;
  evidence_document_id: string | null;
  evidence_note: string | null;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
  waived_reason: string | null;
  is_overdue: boolean;
  is_satisfied: boolean;
  owner_id: string | null;
}

export interface AdReview {
  id: string;
  title: string;
  listing_id: string | null;
  marketing_item_id: string | null;
  brokerage_deal_id: string | null;
  channel: string | null;
  content_summary: string | null;
  document_id: string | null;
  submitted_by_id: string | null;
  submitted_by_name: string | null;
  submitted_at: string;
  status: string;
  checklist: { key: string; label: string; checked: boolean }[];
  reviewer_id: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
}

export interface FileItem {
  id: string;
  file_id: string;
  key: string;
  label: string;
  category: string;
  is_required: boolean;
  status: string;
  document_id: string | null;
  document_title: string | null;
  evidence_note: string | null;
  waived_reason: string | null;
  reviewed_at: string | null;
  is_satisfied: boolean;
}

export interface TxFile {
  id: string;
  brokerage_deal_id: string;
  template_key: string;
  status: string;
  deal_title: string | null;
  deal_stage: string | null;
  agent_name: string | null;
  completeness_pct: number;
  required_total: number;
  required_done: number;
  complete: boolean;
  blockers: string[];
  items: FileItem[];
  approved_at: string | null;
  updated_at: string;
}

export interface ComplianceSummary {
  licenses_expiring: number;
  licenses_expired: number;
  disclosures_open: number;
  disclosures_overdue: number;
  ad_reviews_pending: number;
  files_incomplete: number;
}
