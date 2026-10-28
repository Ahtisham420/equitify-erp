/**
 * Brokerage CRM & listing management (spec module 25).
 *
 * Brokerage shares master data (properties, people, organizations, comps) with acquisitions but keeps its
 * own workflow tables and permission key (`brokerage`). Cross-module ids are plain UUID columns.
 */
import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
} from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const PROSPECT_STAGES = ["prospect", "pitched", "engaged", "lost"] as const;
export const MARKET_STATUSES = ["not_listed", "competitor_listed", "expiring", "expired", "withdrawn", "off_market"] as const;
export const LOST_REASONS = ["chose_competitor", "not_selling", "price_expectation", "fee", "timing", "relationship", "other"] as const;
export const PITCH_KINDS = ["pitch", "bov"] as const;
export const PITCH_OUTCOMES = ["pending", "won", "lost", "no_decision"] as const;

export const EXCLUSIVITY = ["exclusive_right", "exclusive_agency", "open", "non_exclusive"] as const;
export const COMMISSION_STRUCTURES = ["percent", "flat", "tiered"] as const;
export const AGREEMENT_STATUSES = ["draft", "active", "expired", "terminated"] as const;

export const LISTING_TYPES = ["sale", "lease"] as const;
export const LISTING_STATUSES = [
  "draft", "coming_soon", "active", "under_contract", "sold", "leased", "withdrawn", "expired",
] as const;
export const LIVE_LISTING_STATUSES = ["coming_soon", "active", "under_contract"] as const;
export const REPORT_CADENCES = ["none", "weekly", "biweekly", "monthly"] as const;
export const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 30 };

export const MARKETING_KINDS = [
  "offering_memorandum", "flyer", "brochure", "email_campaign", "signage", "photography", "video", "website", "other",
] as const;
export const MARKETING_STATUSES = ["draft", "in_review", "approved", "published", "retired"] as const;
export const SYNDICATION_CHANNELS = ["loopnet", "costar", "crexi", "company_website", "mls", "email", "social", "other"] as const;
export const SYNDICATION_STATUSES = ["not_syndicated", "pending", "live", "paused", "removed", "error"] as const;

export const INQUIRY_SOURCES = [
  "website", "loopnet", "costar", "crexi", "sign_call", "email_campaign", "referral", "cold_call", "broker", "other",
] as const;
export const INQUIRY_STATUSES = ["new", "contacted", "qualified", "nda_sent", "toured", "offer", "dead"] as const;
export const SHOWING_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;
export const INTEREST_LEVELS = ["none", "low", "medium", "high"] as const;

export const REP_KINDS = ["buyer", "tenant"] as const;
export const REQUIREMENT_STATUSES = ["active", "paused", "fulfilled", "closed"] as const;
export const MATCH_STATUSES = ["suggested", "sent", "interested", "toured", "rejected", "offer"] as const;

export const PROPOSAL_KINDS = [
  "listing_proposal", "purchase_proposal", "lease_proposal", "buyer_proposal", "tenant_proposal",
] as const;
export const PROPOSAL_STATUSES = ["draft", "sent", "countered", "accepted", "rejected", "withdrawn", "superseded"] as const;

export const DEAL_SIDES = ["listing", "buyer", "tenant", "landlord", "dual"] as const;
export const DEAL_STAGES = [
  "lead", "engaged", "marketing", "touring", "negotiation", "under_contract", "closing", "closed", "lost",
] as const;
export const ACTIVE_DEAL_STAGES = DEAL_STAGES.slice(0, 7);
// Default win probability per stage; agents can override on the deal.
export const STAGE_PROBABILITY: Record<string, number> = {
  lead: 10, engaged: 25, marketing: 35, touring: 40, negotiation: 55, under_contract: 80, closing: 90, closed: 100, lost: 0,
};

export const RECRUIT_STAGES = [
  "lead", "contacted", "interviewing", "offer", "hired", "onboarding", "active", "declined", "lost",
] as const;
export const ONBOARDING_TEMPLATE: ReadonlyArray<readonly [string, string]> = [
  ["license_verified", "License verified with state"],
  ["agreement_signed", "Independent contractor / employment agreement signed"],
  ["w9", "W-9 / tax documents collected"],
  ["eo_insurance", "E&O insurance confirmed"],
  ["system_access", "System account created"],
  ["compliance_training", "Brokerage compliance training completed"],
  ["mls_access", "MLS / listing platform access"],
  ["marketing_profile", "Marketing bio and photo"],
];

/** `ix_<table>_<col>` indexes for the named columns (SQLAlchemy `index=True` naming convention). */
const ix = (table: string, t: Record<string, any>, cols: string[]) =>
  cols.map((c) => index(`ix_${table}_${c}`).on(t[c]));

const now = () => new Date();
const emptyList = () => [];

/** An owner relationship being pursued for a listing (prospect -> pitched -> engaged | lost). */
export const listingProspects = pgTable(
  "listing_prospects",
  {
    ...entity(),
    title: varchar("title", { length: 255 }).notNull(),
    property_id: fk("property_id", () => properties.id),
    owner_person_id: uuid("owner_person_id"),
    owner_organization_id: uuid("owner_organization_id"),
    opportunity_id: uuid("opportunity_id"),
    agent_id: fk("agent_id", () => users.id),
    stage: varchar("stage", { length: 20 }).notNull().$defaultFn(() => "prospect"),
    stage_entered_at: tz("stage_entered_at").notNull().$defaultFn(now),
    source: varchar("source", { length: 80 }),
    // Expiring / competitor listing tracking
    market_status: varchar("market_status", { length: 30 }).notNull().$defaultFn(() => "not_listed"),
    competitor_broker: varchar("competitor_broker", { length: 200 }),
    competitor_list_price: numericFloat("competitor_list_price", 16, 2),
    competitor_listed_on: date("competitor_listed_on", { mode: "string" }),
    competitor_expires_on: date("competitor_expires_on", { mode: "string" }),
    estimated_value: numericFloat("estimated_value", 16, 2),
    next_action: varchar("next_action", { length: 300 }),
    next_action_at: tz("next_action_at"),
    lost_reason: varchar("lost_reason", { length: 40 }),
    listing_id: uuid("listing_id"),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(emptyList),
  },
  (t) =>
    ix("listing_prospects", t, [
      "deleted_at", "property_id", "owner_person_id", "owner_organization_id", "opportunity_id", "agent_id", "stage",
      "source", "market_status", "competitor_expires_on", "next_action_at", "listing_id",
    ]),
);
export type ListingProspect = typeof listingProspects.$inferSelect;

/** Pitch history. A BOV pitch references a comps valuation (`bov_id`) built from verified comparables. */
export const prospectPitches = pgTable(
  "prospect_pitches",
  {
    ...entity(),
    prospect_id: fk("prospect_id", () => listingProspects.id, { notNull: true, onDelete: "cascade" }),
    kind: varchar("kind", { length: 10 }).notNull().$defaultFn(() => "pitch"),
    pitched_on: date("pitched_on", { mode: "string" }).notNull(),
    bov_id: uuid("bov_id"),
    comp_set_id: uuid("comp_set_id"),
    value_low: numericFloat("value_low", 16, 2),
    value_point: numericFloat("value_point", 16, 2),
    value_high: numericFloat("value_high", 16, 2),
    valuation_method: varchar("valuation_method", { length: 40 }),
    valuation_as_of: date("valuation_as_of", { mode: "string" }),
    recommended_price: numericFloat("recommended_price", 16, 2),
    proposed_commission_rate: doublePrecision("proposed_commission_rate"),
    outcome: varchar("outcome", { length: 20 }).notNull().$defaultFn(() => "pending"),
    document_id: uuid("document_id"),
    notes: text("notes"),
  },
  (t) => ix("prospect_pitches", t, ["deleted_at", "prospect_id", "bov_id"]),
);
export type ProspectPitch = typeof prospectPitches.$inferSelect;

/** Immutable stage/status history for prospects, listings, deals and recruits. */
export const brokerageStatusHistory = pgTable(
  "brokerage_status_history",
  {
    id: pk(),
    entity_type: varchar("entity_type", { length: 30 }).notNull(),
    entity_id: uuid("entity_id").notNull(),
    from_status: varchar("from_status", { length: 30 }),
    to_status: varchar("to_status", { length: 30 }).notNull(),
    reason: text("reason"),
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
    at: tz("at").notNull().$defaultFn(now),
  },
  (t) => ix("brokerage_status_history", t, ["entity_type", "entity_id", "at"]),
);
export type BrokerageStatusEvent = typeof brokerageStatusHistory.$inferSelect;

/** Listing engagement: term, exclusivity, commission and expiration (expiration -> critical date). */
export const engagementAgreements = pgTable(
  "engagement_agreements",
  {
    ...entity(),
    prospect_id: fk("prospect_id", () => listingProspects.id),
    listing_id: uuid("listing_id"),
    property_id: fk("property_id", () => properties.id),
    client_person_id: uuid("client_person_id"),
    client_organization_id: uuid("client_organization_id"),
    agent_id: fk("agent_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    exclusivity: varchar("exclusivity", { length: 30 }).notNull().$defaultFn(() => "exclusive_right"),
    starts_on: date("starts_on", { mode: "string" }),
    expires_on: date("expires_on", { mode: "string" }),
    term_months: integer("term_months"),
    commission_structure: varchar("commission_structure", { length: 20 }).notNull().$defaultFn(() => "percent"),
    commission_rate: doublePrecision("commission_rate"),
    commission_flat: numericFloat("commission_flat", 16, 2),
    commission_tiers: jsonb("commission_tiers").$type<any[]>().notNull().$defaultFn(emptyList),
    cobroker_rate: doublePrecision("cobroker_rate"),
    tail_days: integer("tail_days"),
    signed_on: date("signed_on", { mode: "string" }),
    document_id: uuid("document_id"),
    critical_date_id: uuid("critical_date_id"),
    notes: text("notes"),
  },
  (t) =>
    ix("engagement_agreements", t, [
      "deleted_at", "prospect_id", "listing_id", "property_id", "client_person_id", "client_organization_id", "agent_id",
      "status", "expires_on",
    ]),
);
export type EngagementAgreement = typeof engagementAgreements.$inferSelect;

export const listings = pgTable(
  "listings",
  {
    ...entity(),
    property_id: fk("property_id", () => properties.id, { notNull: true, onDelete: "set null" }),
    prospect_id: fk("prospect_id", () => listingProspects.id),
    engagement_agreement_id: fk("engagement_agreement_id", () => engagementAgreements.id),
    agent_id: fk("agent_id", () => users.id),
    seller_person_id: uuid("seller_person_id"),
    seller_organization_id: uuid("seller_organization_id"),
    listing_type: varchar("listing_type", { length: 10 }).notNull().$defaultFn(() => "sale"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    status_changed_at: tz("status_changed_at").notNull().$defaultFn(now),
    asking_price: numericFloat("asking_price", 16, 2),
    asking_rent_psf: numericFloat("asking_rent_psf", 10, 2),
    cap_rate: doublePrecision("cap_rate"),
    listed_on: date("listed_on", { mode: "string" }),
    expires_on: date("expires_on", { mode: "string" }),
    closed_on: date("closed_on", { mode: "string" }),
    closed_price: numericFloat("closed_price", 16, 2),
    headline: varchar("headline", { length: 300 }),
    description: text("description"),
    highlights: varchar("highlights", { length: 300 }).array().notNull().$defaultFn(emptyList),
    reporting_cadence: varchar("reporting_cadence", { length: 10 }).notNull().$defaultFn(() => "biweekly"),
    next_report_on: date("next_report_on", { mode: "string" }),
    deal_room_id: uuid("deal_room_id"),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(emptyList),
  },
  (t) =>
    ix("listings", t, [
      "deleted_at", "property_id", "prospect_id", "engagement_agreement_id", "agent_id", "seller_person_id",
      "seller_organization_id", "listing_type", "status", "listed_on", "expires_on", "next_report_on",
    ]),
);
export type Listing = typeof listings.$inferSelect;

/** Asking-price history. Rows are appended, never overwritten. */
export const listingPriceHistory = pgTable(
  "listing_price_history",
  {
    id: pk(),
    listing_id: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
    price: numericFloat("price", 16, 2),
    previous_price: numericFloat("previous_price", 16, 2),
    rent_psf: numericFloat("rent_psf", 10, 2),
    effective_on: date("effective_on", { mode: "string" }).notNull(),
    reason: text("reason"),
    source: varchar("source", { length: 120 }).notNull().$defaultFn(() => "Manual entry"),
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
    at: tz("at").notNull().$defaultFn(now),
  },
  (t) => ix("listing_price_history", t, ["listing_id", "at"]),
);
export type ListingPriceHistory = typeof listingPriceHistory.$inferSelect;

/** Marketing material and its syndication status per channel. */
export const marketingItems = pgTable(
  "marketing_items",
  {
    ...entity(),
    listing_id: fk("listing_id", () => listings.id, { notNull: true, onDelete: "cascade" }),
    kind: varchar("kind", { length: 30 }).notNull().$defaultFn(() => "flyer"),
    title: varchar("title", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    channels: varchar("channels", { length: 40 }).array().notNull().$defaultFn(emptyList),
    syndication_status: varchar("syndication_status", { length: 20 }).notNull().$defaultFn(() => "not_syndicated"),
    syndicated_at: tz("syndicated_at"),
    external_url: varchar("external_url", { length: 500 }),
    document_ids: uuid("document_ids").array().notNull().$defaultFn(emptyList),
    notes: text("notes"),
  },
  (t) => ix("marketing_items", t, ["deleted_at", "listing_id", "status", "syndication_status"]),
);
export type MarketingItem = typeof marketingItems.$inferSelect;

export const inquiries = pgTable(
  "inquiries",
  {
    ...entity(),
    listing_id: fk("listing_id", () => listings.id),
    property_id: fk("property_id", () => properties.id),
    person_id: uuid("person_id"),
    organization_id: uuid("organization_id"),
    contact_name: varchar("contact_name", { length: 200 }),
    contact_email: varchar("contact_email", { length: 255 }),
    contact_phone: varchar("contact_phone", { length: 40 }),
    source: varchar("source", { length: 30 }).notNull().$defaultFn(() => "other"),
    received_at: tz("received_at").notNull().$defaultFn(now),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "new"),
    message: text("message"),
    assigned_to_id: fk("assigned_to_id", () => users.id),
    follow_up_at: tz("follow_up_at"),
    follow_up_task_id: uuid("follow_up_task_id"),
    notes: text("notes"),
  },
  (t) =>
    ix("inquiries", t, [
      "deleted_at", "listing_id", "property_id", "person_id", "organization_id", "source", "received_at", "status",
      "assigned_to_id",
    ]),
);
export type Inquiry = typeof inquiries.$inferSelect;

export const showings = pgTable(
  "showings",
  {
    ...entity(),
    listing_id: fk("listing_id", () => listings.id),
    property_id: fk("property_id", () => properties.id),
    inquiry_id: fk("inquiry_id", () => inquiries.id),
    tour_id: uuid("tour_id"),
    person_id: uuid("person_id"),
    organization_id: uuid("organization_id"),
    contact_name: varchar("contact_name", { length: 200 }),
    scheduled_at: tz("scheduled_at").notNull(),
    shown_by_id: fk("shown_by_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "scheduled"),
    interest_level: varchar("interest_level", { length: 10 }),
    feedback: text("feedback"),
    notes: text("notes"),
  },
  (t) =>
    ix("showings", t, [
      "deleted_at", "listing_id", "property_id", "inquiry_id", "tour_id", "person_id", "organization_id", "scheduled_at",
      "shown_by_id", "status",
    ]),
);
export type Showing = typeof showings.$inferSelect;

/** Generated seller activity report; the summary is a frozen snapshot at generation time. */
export const sellerReports = pgTable(
  "seller_reports",
  {
    ...entity(),
    listing_id: fk("listing_id", () => listings.id, { notNull: true, onDelete: "cascade" }),
    period_start: date("period_start", { mode: "string" }).notNull(),
    period_end: date("period_end", { mode: "string" }).notNull(),
    generated_at: tz("generated_at").notNull().$defaultFn(now),
    summary: jsonb("summary").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    commentary: text("commentary"),
    status: varchar("status", { length: 10 }).notNull().$defaultFn(() => "draft"),
    sent_at: tz("sent_at"),
    sent_to: varchar("sent_to", { length: 300 }),
  },
  (t) => ix("seller_reports", t, ["deleted_at", "listing_id", "status"]),
);
export type SellerReport = typeof sellerReports.$inferSelect;

/** Buyer / tenant representation agreement. */
export const repAgreements = pgTable(
  "rep_agreements",
  {
    ...entity(),
    kind: varchar("kind", { length: 10 }).notNull().$defaultFn(() => "buyer"),
    client_person_id: uuid("client_person_id"),
    client_organization_id: uuid("client_organization_id"),
    agent_id: fk("agent_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    exclusivity: varchar("exclusivity", { length: 30 }).notNull().$defaultFn(() => "exclusive_right"),
    starts_on: date("starts_on", { mode: "string" }),
    expires_on: date("expires_on", { mode: "string" }),
    territory: varchar("territory", { length: 200 }),
    commission_structure: varchar("commission_structure", { length: 20 }).notNull().$defaultFn(() => "percent"),
    commission_rate: doublePrecision("commission_rate"),
    commission_flat: numericFloat("commission_flat", 16, 2),
    signed_on: date("signed_on", { mode: "string" }),
    document_id: uuid("document_id"),
    critical_date_id: uuid("critical_date_id"),
    notes: text("notes"),
  },
  (t) =>
    ix("rep_agreements", t, [
      "deleted_at", "kind", "client_person_id", "client_organization_id", "agent_id", "status", "expires_on",
    ]),
);
export type RepAgreement = typeof repAgreements.$inferSelect;

export const requirementProfiles = pgTable(
  "requirement_profiles",
  {
    ...entity(),
    name: varchar("name", { length: 200 }).notNull(),
    rep_agreement_id: fk("rep_agreement_id", () => repAgreements.id),
    client_person_id: uuid("client_person_id"),
    client_organization_id: uuid("client_organization_id"),
    agent_id: fk("agent_id", () => users.id),
    side: varchar("side", { length: 10 }).notNull().$defaultFn(() => "buyer"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    property_types: varchar("property_types", { length: 40 }).array().notNull().$defaultFn(emptyList),
    min_size_sf: numericFloat("min_size_sf", 14, 2),
    max_size_sf: numericFloat("max_size_sf", 14, 2),
    min_acres: numericFloat("min_acres", 12, 4),
    max_acres: numericFloat("max_acres", 12, 4),
    min_price: numericFloat("min_price", 16, 2),
    max_price: numericFloat("max_price", 16, 2),
    states: varchar("states", { length: 40 }).array().notNull().$defaultFn(emptyList),
    cities: varchar("cities", { length: 120 }).array().notNull().$defaultFn(emptyList),
    counties: varchar("counties", { length: 120 }).array().notNull().$defaultFn(emptyList),
    territory_id: uuid("territory_id"),
    near_lat: doublePrecision("near_lat"),
    near_lng: doublePrecision("near_lng"),
    radius_miles: doublePrecision("radius_miles"),
    features: varchar("features", { length: 80 }).array().notNull().$defaultFn(emptyList),
    last_matched_at: tz("last_matched_at"),
    notes: text("notes"),
  },
  (t) =>
    ix("requirement_profiles", t, [
      "deleted_at", "rep_agreement_id", "client_person_id", "client_organization_id", "agent_id", "status",
    ]),
);
export type RequirementProfile = typeof requirementProfiles.$inferSelect;

export const requirementMatches = pgTable(
  "requirement_matches",
  {
    ...entity(),
    requirement_id: fk("requirement_id", () => requirementProfiles.id, { notNull: true, onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id, { notNull: true, onDelete: "set null" }),
    listing_id: uuid("listing_id"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "suggested"),
    matched_at: tz("matched_at").notNull().$defaultFn(now),
    criteria_met: jsonb("criteria_met").$type<any[]>().notNull().$defaultFn(emptyList),
    notes: text("notes"),
  },
  (t) => [
    ...ix("requirement_matches", t, ["deleted_at", "requirement_id", "property_id", "status"]),
    unique("uq_requirement_match").on(t.requirement_id, t.property_id),
  ],
);
export type RequirementMatch = typeof requirementMatches.$inferSelect;

/** Brokerage transaction workflow and the agent's personal pipeline. */
export const brokerageDeals = pgTable(
  "brokerage_deals",
  {
    ...entity(),
    title: varchar("title", { length: 255 }).notNull(),
    agent_id: fk("agent_id", () => users.id),
    side: varchar("side", { length: 10 }).notNull().$defaultFn(() => "listing"),
    property_id: fk("property_id", () => properties.id),
    listing_id: fk("listing_id", () => listings.id),
    rep_agreement_id: fk("rep_agreement_id", () => repAgreements.id),
    requirement_id: fk("requirement_id", () => requirementProfiles.id),
    client_person_id: uuid("client_person_id"),
    client_organization_id: uuid("client_organization_id"),
    counterparty_person_id: uuid("counterparty_person_id"),
    counterparty_organization_id: uuid("counterparty_organization_id"),
    is_dual_rep: boolean("is_dual_rep").notNull().$defaultFn(() => false),
    stage: varchar("stage", { length: 20 }).notNull().$defaultFn(() => "lead"),
    stage_entered_at: tz("stage_entered_at").notNull().$defaultFn(now),
    expected_close_on: date("expected_close_on", { mode: "string" }),
    probability: doublePrecision("probability"),
    deal_value: numericFloat("deal_value", 16, 2),
    commission_rate: doublePrecision("commission_rate"),
    gross_commission_estimate: numericFloat("gross_commission_estimate", 16, 2),
    closed_on: date("closed_on", { mode: "string" }),
    closed_price: numericFloat("closed_price", 16, 2),
    lost_reason: varchar("lost_reason", { length: 200 }),
    next_action: varchar("next_action", { length: 300 }),
    next_action_at: tz("next_action_at"),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(emptyList),
  },
  (t) =>
    ix("brokerage_deals", t, [
      "deleted_at", "agent_id", "side", "property_id", "listing_id", "rep_agreement_id", "requirement_id",
      "client_person_id", "client_organization_id", "stage", "expected_close_on", "next_action_at",
    ]),
);
export type BrokerageDeal = typeof brokerageDeals.$inferSelect;

/** Proposal history: revisions create a new version and supersede the previous one. */
export const proposals = pgTable(
  "proposals",
  {
    ...entity(),
    kind: varchar("kind", { length: 30 }).notNull().$defaultFn(() => "listing_proposal"),
    title: varchar("title", { length: 255 }).notNull(),
    version: integer("version").notNull().$defaultFn(() => 1),
    parent_proposal_id: fk("parent_proposal_id", (): any => proposals.id),
    brokerage_deal_id: fk("brokerage_deal_id", () => brokerageDeals.id),
    prospect_id: fk("prospect_id", () => listingProspects.id),
    listing_id: fk("listing_id", () => listings.id),
    requirement_id: fk("requirement_id", () => requirementProfiles.id),
    property_id: fk("property_id", () => properties.id),
    recipient_person_id: uuid("recipient_person_id"),
    recipient_organization_id: uuid("recipient_organization_id"),
    agent_id: fk("agent_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    price: numericFloat("price", 16, 2),
    rent_psf: numericFloat("rent_psf", 10, 2),
    term_months: integer("term_months"),
    commission_rate: doublePrecision("commission_rate"),
    terms: text("terms"),
    sent_on: date("sent_on", { mode: "string" }),
    response_due_on: date("response_due_on", { mode: "string" }),
    document_id: uuid("document_id"),
    notes: text("notes"),
  },
  (t) =>
    ix("proposals", t, [
      "deleted_at", "kind", "parent_proposal_id", "brokerage_deal_id", "prospect_id", "listing_id", "requirement_id",
      "property_id", "agent_id", "status",
    ]),
);
export type Proposal = typeof proposals.$inferSelect;

/** Agent recruiting pipeline with an onboarding checklist once hired. */
export const recruits = pgTable(
  "recruits",
  {
    ...entity(),
    full_name: varchar("full_name", { length: 200 }).notNull(),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 40 }),
    person_id: uuid("person_id"),
    current_brokerage: varchar("current_brokerage", { length: 200 }),
    specialty: varchar("specialty", { length: 120 }),
    years_experience: doublePrecision("years_experience"),
    annual_production: numericFloat("annual_production", 16, 2),
    license_number: varchar("license_number", { length: 60 }),
    license_state: varchar("license_state", { length: 40 }),
    source: varchar("source", { length: 80 }),
    stage: varchar("stage", { length: 20 }).notNull().$defaultFn(() => "lead"),
    stage_entered_at: tz("stage_entered_at").notNull().$defaultFn(now),
    recruiter_id: fk("recruiter_id", () => users.id),
    next_action_at: tz("next_action_at"),
    start_on: date("start_on", { mode: "string" }),
    user_id: fk("user_id", () => users.id),
    onboarding: jsonb("onboarding").$type<any[]>().notNull().$defaultFn(emptyList),
    notes: text("notes"),
  },
  (t) => ix("recruits", t, ["deleted_at", "recruiter_id", "user_id", "stage"]),
);
export type Recruit = typeof recruits.$inferSelect;
