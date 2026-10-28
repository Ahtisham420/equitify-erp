import { z } from "zod";

const uuid = z.string().uuid();
const dateStr = z.string().date();
const datetime = z.coerce.date();

/** Same fields as `shape`, all optional + nullable (PATCH bodies). Unknown keys are rejected. */
function partial<T extends z.ZodRawShape>(shape: T) {
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(shape)) out[k] = v.nullish();
  return z.object(out as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> }).strict();
}

const prospectStage = z.enum(["prospect", "pitched", "engaged", "lost"]);
const marketStatus = z.enum(["not_listed", "competitor_listed", "expiring", "expired", "withdrawn", "off_market"]);
const exclusivity = z.enum(["exclusive_right", "exclusive_agency", "open", "non_exclusive"]);
const commissionStructure = z.enum(["percent", "flat", "tiered"]);
const agreementStatus = z.enum(["draft", "active", "expired", "terminated"]);
const listingType = z.enum(["sale", "lease"]);
const listingStatus = z.enum([
  "draft", "coming_soon", "active", "under_contract", "sold", "leased", "withdrawn", "expired",
]);
const cadence = z.enum(["none", "weekly", "biweekly", "monthly"]);
const dealSide = z.enum(["listing", "buyer", "tenant", "landlord", "dual"]);
export type ProspectStage = z.infer<typeof prospectStage>;

export const stageMoveIn = z.object({
  to_stage: z.string().min(1).max(30),
  reason: z.string().max(2000).nullish(),
  lost_reason: z.string().max(200).nullish(),
});
export type StageMoveIn = z.infer<typeof stageMoveIn>;

// ------------------------------------------------------------------ prospects & pitches

const prospectShape = {
  title: z.string().max(255).nullish(),
  property_id: uuid.nullish(),
  owner_person_id: uuid.nullish(),
  owner_organization_id: uuid.nullish(),
  opportunity_id: uuid.nullish(),
  agent_id: uuid.nullish(),
  source: z.string().max(80).nullish(),
  market_status: marketStatus.default("not_listed"),
  competitor_broker: z.string().max(200).nullish(),
  competitor_list_price: z.number().min(0).nullish(),
  competitor_listed_on: dateStr.nullish(),
  competitor_expires_on: dateStr.nullish(),
  estimated_value: z.number().min(0).nullish(),
  next_action: z.string().max(300).nullish(),
  next_action_at: datetime.nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};
export const prospectBase = z.object(prospectShape);
export type ProspectBase = z.infer<typeof prospectBase>;
export const prospectUpdate = partial(prospectShape);
export type ProspectUpdate = z.infer<typeof prospectUpdate>;

const pitchShape = {
  kind: z.enum(["pitch", "bov"]).default("pitch"),
  pitched_on: dateStr.nullish(),
  bov_id: uuid.nullish(),
  comp_set_id: uuid.nullish(),
  value_low: z.number().min(0).nullish(),
  value_point: z.number().min(0).nullish(),
  value_high: z.number().min(0).nullish(),
  recommended_price: z.number().min(0).nullish(),
  proposed_commission_rate: z.number().min(0).max(100).nullish(),
  outcome: z.enum(["pending", "won", "lost", "no_decision"]).default("pending"),
  document_id: uuid.nullish(),
  notes: z.string().nullish(),
};
export const pitchIn = z.object(pitchShape);
export type PitchIn = z.infer<typeof pitchIn>;
export const pitchUpdate = partial(pitchShape);
export type PitchUpdate = z.infer<typeof pitchUpdate>;

/** Convert an engaged prospect to a listing (creates the listing and links the engagement). */
export const convertIn = z.object({
  listing_type: listingType.default("sale"),
  asking_price: z.number().min(0).nullish(),
  asking_rent_psf: z.number().min(0).nullish(),
  listed_on: dateStr.nullish(),
  expires_on: dateStr.nullish(),
  engagement_agreement_id: uuid.nullish(),
});
export type ConvertIn = z.infer<typeof convertIn>;

// ------------------------------------------------------------------ agreements

const engagementShape = {
  prospect_id: uuid.nullish(),
  listing_id: uuid.nullish(),
  property_id: uuid.nullish(),
  client_person_id: uuid.nullish(),
  client_organization_id: uuid.nullish(),
  agent_id: uuid.nullish(),
  status: agreementStatus.default("draft"),
  exclusivity: exclusivity.default("exclusive_right"),
  starts_on: dateStr.nullish(),
  expires_on: dateStr.nullish(),
  term_months: z.number().int().min(1).max(600).nullish(),
  commission_structure: commissionStructure.default("percent"),
  commission_rate: z.number().min(0).max(100).nullish(),
  commission_flat: z.number().min(0).nullish(),
  commission_tiers: z.array(z.record(z.string(), z.any())).default([]),
  cobroker_rate: z.number().min(0).max(100).nullish(),
  tail_days: z.number().int().min(0).max(3650).nullish(),
  signed_on: dateStr.nullish(),
  document_id: uuid.nullish(),
  notes: z.string().nullish(),
};
export const engagementBase = z.object(engagementShape);
export type EngagementBase = z.infer<typeof engagementBase>;
export const engagementUpdate = partial(engagementShape);
export type EngagementUpdate = z.infer<typeof engagementUpdate>;

const repAgreementShape = {
  kind: z.enum(["buyer", "tenant"]).default("buyer"),
  client_person_id: uuid.nullish(),
  client_organization_id: uuid.nullish(),
  agent_id: uuid.nullish(),
  status: agreementStatus.default("draft"),
  exclusivity: exclusivity.default("exclusive_right"),
  starts_on: dateStr.nullish(),
  expires_on: dateStr.nullish(),
  territory: z.string().max(200).nullish(),
  commission_structure: commissionStructure.default("percent"),
  commission_rate: z.number().min(0).max(100).nullish(),
  commission_flat: z.number().min(0).nullish(),
  signed_on: dateStr.nullish(),
  document_id: uuid.nullish(),
  notes: z.string().nullish(),
};
export const repAgreementBase = z.object(repAgreementShape);
export type RepAgreementBase = z.infer<typeof repAgreementBase>;
export const repAgreementUpdate = partial(repAgreementShape);
export type RepAgreementUpdate = z.infer<typeof repAgreementUpdate>;

// ------------------------------------------------------------------ listings

const listingBaseShape = {
  property_id: uuid,
  prospect_id: uuid.nullish(),
  engagement_agreement_id: uuid.nullish(),
  agent_id: uuid.nullish(),
  seller_person_id: uuid.nullish(),
  seller_organization_id: uuid.nullish(),
  listing_type: listingType.default("sale"),
  cap_rate: z.number().min(0).max(100).nullish(),
  listed_on: dateStr.nullish(),
  expires_on: dateStr.nullish(),
  headline: z.string().max(300).nullish(),
  description: z.string().nullish(),
  highlights: z.array(z.string()).default([]),
  reporting_cadence: cadence.default("biweekly"),
  next_report_on: dateStr.nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};
export const listingCreate = z.object({
  ...listingBaseShape,
  status: listingStatus.default("draft"),
  asking_price: z.number().min(0).nullish(),
  asking_rent_psf: z.number().min(0).nullish(),
});
export type ListingCreate = z.infer<typeof listingCreate>;

// Price and status are changed only through their dedicated endpoints so history is always written.
const listingEditableShape = {
  agent_id: uuid.nullish(),
  engagement_agreement_id: uuid.nullish(),
  seller_person_id: uuid.nullish(),
  seller_organization_id: uuid.nullish(),
  listing_type: listingType.default("sale"),
  cap_rate: z.number().min(0).max(100).nullish(),
  listed_on: dateStr.nullish(),
  expires_on: dateStr.nullish(),
  closed_on: dateStr.nullish(),
  closed_price: z.number().min(0).nullish(),
  headline: z.string().max(300).nullish(),
  description: z.string().nullish(),
  highlights: z.array(z.string()).default([]),
  reporting_cadence: cadence.default("biweekly"),
  next_report_on: dateStr.nullish(),
  deal_room_id: uuid.nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};
export const listingUpdate = partial(listingEditableShape);
export type ListingUpdate = z.infer<typeof listingUpdate>;

export const priceChangeIn = z.object({
  asking_price: z.number().min(0).nullish(),
  asking_rent_psf: z.number().min(0).nullish(),
  effective_on: dateStr.nullish(),
  reason: z.string().max(2000).nullish(),
  source: z.string().max(120).default("Manual entry"),
});
export type PriceChangeIn = z.infer<typeof priceChangeIn>;

export const statusChangeIn = z.object({
  status: listingStatus,
  reason: z.string().max(2000).nullish(),
  closed_on: dateStr.nullish(),
  closed_price: z.number().min(0).nullish(),
});
export type StatusChangeIn = z.infer<typeof statusChangeIn>;

const marketingShape = {
  kind: z
    .enum(["offering_memorandum", "flyer", "brochure", "email_campaign", "signage", "photography", "video", "website", "other"])
    .default("flyer"),
  title: z.string().min(1).max(255),
  status: z.enum(["draft", "in_review", "approved", "published", "retired"]).default("draft"),
  channels: z.array(z.string()).default([]),
  syndication_status: z.enum(["not_syndicated", "pending", "live", "paused", "removed", "error"]).default("not_syndicated"),
  external_url: z.string().max(500).nullish(),
  document_ids: z.array(uuid).default([]),
  notes: z.string().nullish(),
};
export const marketingBase = z.object(marketingShape);
export type MarketingBase = z.infer<typeof marketingBase>;
export const marketingUpdate = partial(marketingShape);
export type MarketingUpdate = z.infer<typeof marketingUpdate>;

const inquiryShape = {
  listing_id: uuid.nullish(),
  property_id: uuid.nullish(),
  person_id: uuid.nullish(),
  organization_id: uuid.nullish(),
  contact_name: z.string().max(200).nullish(),
  contact_email: z.string().max(255).nullish(),
  contact_phone: z.string().max(40).nullish(),
  source: z.string().max(30).default("other"),
  received_at: datetime.nullish(),
  status: z.enum(["new", "contacted", "qualified", "nda_sent", "toured", "offer", "dead"]).default("new"),
  message: z.string().nullish(),
  assigned_to_id: uuid.nullish(),
  follow_up_at: datetime.nullish(),
  notes: z.string().nullish(),
};
export const inquiryBase = z.object(inquiryShape);
export type InquiryBase = z.infer<typeof inquiryBase>;
export const inquiryUpdate = partial(inquiryShape);
export type InquiryUpdate = z.infer<typeof inquiryUpdate>;

const showingShape = {
  listing_id: uuid.nullish(),
  property_id: uuid.nullish(),
  inquiry_id: uuid.nullish(),
  tour_id: uuid.nullish(),
  person_id: uuid.nullish(),
  organization_id: uuid.nullish(),
  contact_name: z.string().max(200).nullish(),
  scheduled_at: datetime,
  shown_by_id: uuid.nullish(),
  status: z.enum(["scheduled", "completed", "cancelled", "no_show"]).default("scheduled"),
  interest_level: z.enum(["none", "low", "medium", "high"]).nullish(),
  feedback: z.string().nullish(),
  notes: z.string().nullish(),
};
export const showingBase = z.object(showingShape);
export type ShowingBase = z.infer<typeof showingBase>;
export const showingUpdate = partial(showingShape);
export type ShowingUpdate = z.infer<typeof showingUpdate>;

export const sellerReportGenerateIn = z.object({
  period_start: dateStr.nullish(),
  period_end: dateStr.nullish(),
  commentary: z.string().nullish(),
});
export type SellerReportGenerateIn = z.infer<typeof sellerReportGenerateIn>;

export const sellerReportUpdate = z
  .object({
    commentary: z.string().nullish(),
    status: z.enum(["draft", "sent"]).nullish(),
    sent_to: z.string().max(300).nullish(),
  })
  .strict();
export type SellerReportUpdate = z.infer<typeof sellerReportUpdate>;

// ------------------------------------------------------------------ requirements, proposals

const requirementShape = {
  name: z.string().min(1).max(200),
  rep_agreement_id: uuid.nullish(),
  client_person_id: uuid.nullish(),
  client_organization_id: uuid.nullish(),
  agent_id: uuid.nullish(),
  side: z.enum(["buyer", "tenant"]).default("buyer"),
  status: z.enum(["active", "paused", "fulfilled", "closed"]).default("active"),
  property_types: z.array(z.string()).default([]),
  min_size_sf: z.number().min(0).nullish(),
  max_size_sf: z.number().min(0).nullish(),
  min_acres: z.number().min(0).nullish(),
  max_acres: z.number().min(0).nullish(),
  min_price: z.number().min(0).nullish(),
  max_price: z.number().min(0).nullish(),
  states: z.array(z.string()).default([]),
  cities: z.array(z.string()).default([]),
  counties: z.array(z.string()).default([]),
  territory_id: uuid.nullish(),
  near_lat: z.number().min(-90).max(90).nullish(),
  near_lng: z.number().min(-180).max(180).nullish(),
  radius_miles: z.number().gt(0).max(200).nullish(),
  features: z.array(z.string()).default([]),
  notes: z.string().nullish(),
};
export const requirementBase = z.object(requirementShape);
export type RequirementBase = z.infer<typeof requirementBase>;
export const requirementUpdate = partial(requirementShape);
export type RequirementUpdate = z.infer<typeof requirementUpdate>;

export const matchUpdate = z
  .object({
    status: z.enum(["suggested", "sent", "interested", "toured", "rejected", "offer"]).nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type MatchUpdate = z.infer<typeof matchUpdate>;

const proposalShape = {
  kind: z
    .enum(["listing_proposal", "purchase_proposal", "lease_proposal", "buyer_proposal", "tenant_proposal"])
    .default("listing_proposal"),
  title: z.string().min(1).max(255),
  brokerage_deal_id: uuid.nullish(),
  prospect_id: uuid.nullish(),
  listing_id: uuid.nullish(),
  requirement_id: uuid.nullish(),
  property_id: uuid.nullish(),
  recipient_person_id: uuid.nullish(),
  recipient_organization_id: uuid.nullish(),
  agent_id: uuid.nullish(),
  status: z.enum(["draft", "sent", "countered", "accepted", "rejected", "withdrawn", "superseded"]).default("draft"),
  price: z.number().min(0).nullish(),
  rent_psf: z.number().min(0).nullish(),
  term_months: z.number().int().min(1).max(600).nullish(),
  commission_rate: z.number().min(0).max(100).nullish(),
  terms: z.string().nullish(),
  sent_on: dateStr.nullish(),
  response_due_on: dateStr.nullish(),
  document_id: uuid.nullish(),
  notes: z.string().nullish(),
};
export const proposalBase = z.object(proposalShape);
export type ProposalBase = z.infer<typeof proposalBase>;
export const proposalUpdate = partial(proposalShape);
export type ProposalUpdate = z.infer<typeof proposalUpdate>;

// ------------------------------------------------------------------ deals

const dealShape = {
  title: z.string().max(255).nullish(),
  agent_id: uuid.nullish(),
  side: dealSide.default("listing"),
  property_id: uuid.nullish(),
  listing_id: uuid.nullish(),
  rep_agreement_id: uuid.nullish(),
  requirement_id: uuid.nullish(),
  client_person_id: uuid.nullish(),
  client_organization_id: uuid.nullish(),
  counterparty_person_id: uuid.nullish(),
  counterparty_organization_id: uuid.nullish(),
  is_dual_rep: z.boolean().default(false),
  expected_close_on: dateStr.nullish(),
  probability: z.number().min(0).max(100).nullish(),
  deal_value: z.number().min(0).nullish(),
  commission_rate: z.number().min(0).max(100).nullish(),
  gross_commission_estimate: z.number().min(0).nullish(),
  next_action: z.string().max(300).nullish(),
  next_action_at: datetime.nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};
export const dealBase = z.object(dealShape);
export type DealBase = z.infer<typeof dealBase>;
export const dealUpdate = partial({
  ...dealShape,
  closed_on: dateStr.nullish(),
  closed_price: z.number().min(0).nullish(),
});
export type DealUpdate = z.infer<typeof dealUpdate>;

// ------------------------------------------------------------------ recruits

const recruitShape = {
  full_name: z.string().min(1).max(200),
  email: z.string().max(255).nullish(),
  phone: z.string().max(40).nullish(),
  person_id: uuid.nullish(),
  current_brokerage: z.string().max(200).nullish(),
  specialty: z.string().max(120).nullish(),
  years_experience: z.number().min(0).max(80).nullish(),
  annual_production: z.number().min(0).nullish(),
  license_number: z.string().max(60).nullish(),
  license_state: z.string().max(40).nullish(),
  source: z.string().max(80).nullish(),
  recruiter_id: uuid.nullish(),
  next_action_at: datetime.nullish(),
  start_on: dateStr.nullish(),
  user_id: uuid.nullish(),
  notes: z.string().nullish(),
};
export const recruitBase = z.object(recruitShape);
export type RecruitBase = z.infer<typeof recruitBase>;
export const recruitUpdate = partial(recruitShape);
export type RecruitUpdate = z.infer<typeof recruitUpdate>;

export const checklistToggleIn = z.object({
  done: z.boolean(),
  note: z.string().max(500).nullish(),
});
export type ChecklistToggleIn = z.infer<typeof checklistToggleIn>;
