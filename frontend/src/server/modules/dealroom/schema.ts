/** Tours, deal rooms & brokerage compliance (spec module 26). */
import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
} from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { brokerageDeals, listings, marketingItems, requirementProfiles } from "../brokerage/schema";
import { properties } from "../properties/schema";

export const TOUR_STATUSES = ["planned", "confirmed", "completed", "cancelled"] as const;
export const STOP_STATUSES = ["planned", "visited", "skipped"] as const;
export const INTEREST_LEVELS = ["none", "low", "medium", "high"] as const;
export const NDA_STATUSES = ["not_sent", "sent", "signed", "declined", "expired"] as const;
export const ROOM_STATUSES = ["draft", "open", "closed", "archived"] as const;
export const ACCESS_STATUSES = ["active", "revoked", "expired"] as const;
export const ACCESS_ACTIONS = ["view_room", "view_folder", "view", "download", "denied", "submit_offer"] as const;
export const OFFER_STATUSES = [
  "submitted", "under_review", "shortlisted", "countered", "accepted", "rejected", "withdrawn",
] as const;
export const FINANCING_TYPES = ["cash", "conventional", "sba", "seller_financing", "assumption", "other"] as const;
export const LICENSE_TYPES = ["salesperson", "broker", "broker_associate", "managing_broker", "firm"] as const;
export const LICENSE_STATUSES = ["active", "pending_renewal", "expired", "suspended", "inactive"] as const;
export const DISCLOSURE_TYPES = [
  "agency", "dual_agency", "intermediary", "seller_property_condition", "lead_paint",
  "environmental", "material_defect", "affiliated_business", "other",
] as const;
// Types that need a signed acknowledgement from the recipient, not just delivery.
export const ACK_REQUIRED_TYPES = new Set(["dual_agency", "intermediary"]);
export const DISCLOSURE_STATUSES = ["required", "delivered", "acknowledged", "waived"] as const;
export const DELIVERY_METHODS = ["email", "in_person", "portal", "mail", "e_sign"] as const;
export const AD_REVIEW_STATUSES = ["pending", "approved", "rejected", "changes_requested"] as const;
export const AD_CHECKLIST: ReadonlyArray<readonly [string, string]> = [
  ["broker_identified", "Brokerage name and license shown as required"],
  ["accurate_facts", "Property facts and price match the listing record"],
  ["fair_housing", "Fair housing / non-discrimination language reviewed"],
  ["seller_consent", "Seller consent to advertise on file"],
  ["no_misleading_claims", "No misleading or unverifiable claims"],
];
export const FILE_ITEM_STATUSES = ["missing", "provided", "approved", "waived", "rejected"] as const;
export const FILE_CATEGORIES = [
  "agreement", "disclosure", "contract", "compliance", "closing", "financial", "other",
] as const;

const bool = (name: string, def: boolean) => boolean(name).notNull().$defaultFn(() => def);

export const tours = pgTable(
  "tours",
  {
    ...entity(),
    title: varchar("title", { length: 255 }).notNull(),
    agent_id: fk("agent_id", () => users.id),
    client_person_id: uuid("client_person_id"),
    client_organization_id: uuid("client_organization_id"),
    brokerage_deal_id: fk("brokerage_deal_id", () => brokerageDeals.id),
    requirement_id: fk("requirement_id", () => requirementProfiles.id),
    scheduled_on: date("scheduled_on", { mode: "string" }).notNull(),
    start_time: varchar("start_time", { length: 5 }), // HH:MM local
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "planned"),
    start_label: varchar("start_label", { length: 255 }),
    start_lat: doublePrecision("start_lat"),
    start_lng: doublePrecision("start_lng"),
    total_distance_miles: doublePrecision("total_distance_miles"),
    optimized_at: tz("optimized_at"),
    // [{kind: user|person|organization|external, id, name, email, role}]
    participants: jsonb("participants").$type<any[]>().notNull().$defaultFn(() => []),
    notes: text("notes"),
  },
  (t) => [
    index("ix_tours_deleted_at").on(t.deleted_at),
    index("ix_tours_agent_id").on(t.agent_id),
    index("ix_tours_client_person_id").on(t.client_person_id),
    index("ix_tours_client_organization_id").on(t.client_organization_id),
    index("ix_tours_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_tours_requirement_id").on(t.requirement_id),
    index("ix_tours_scheduled_on").on(t.scheduled_on),
    index("ix_tours_status").on(t.status),
  ],
);
export type Tour = typeof tours.$inferSelect;

export const tourStops = pgTable(
  "tour_stops",
  {
    ...entity(),
    tour_id: uuid("tour_id").notNull().references(() => tours.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "set null" }),
    listing_id: fk("listing_id", () => listings.id),
    sequence: integer("sequence").notNull().$defaultFn(() => 0),
    arrive_time: varchar("arrive_time", { length: 5 }),
    duration_minutes: integer("duration_minutes").notNull().$defaultFn(() => 30),
    distance_from_prev_miles: doublePrecision("distance_from_prev_miles"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "planned"),
    access_notes: text("access_notes"),
  },
  (t) => [
    index("ix_tour_stops_deleted_at").on(t.deleted_at),
    index("ix_tour_stops_tour_id").on(t.tour_id),
    index("ix_tour_stops_property_id").on(t.property_id),
    index("ix_tour_stops_listing_id").on(t.listing_id),
  ],
);
export type TourStop = typeof tourStops.$inferSelect;

export const tourFeedback = pgTable(
  "tour_feedback",
  {
    ...entity(),
    tour_id: uuid("tour_id").notNull().references(() => tours.id, { onDelete: "cascade" }),
    stop_id: fk("stop_id", () => tourStops.id),
    property_id: fk("property_id", () => properties.id),
    listing_id: uuid("listing_id"),
    person_id: uuid("person_id"),
    rating: integer("rating"),
    interest_level: varchar("interest_level", { length: 10 }),
    feedback: text("feedback"),
    objections: text("objections"),
    next_action: varchar("next_action", { length: 300 }),
    next_action_at: tz("next_action_at"),
    follow_up_task_id: uuid("follow_up_task_id"),
    showing_id: uuid("showing_id"),
  },
  (t) => [
    index("ix_tour_feedback_deleted_at").on(t.deleted_at),
    index("ix_tour_feedback_tour_id").on(t.tour_id),
    index("ix_tour_feedback_stop_id").on(t.stop_id),
    index("ix_tour_feedback_property_id").on(t.property_id),
  ],
);
export type TourFeedback = typeof tourFeedback.$inferSelect;

export const dealRooms = pgTable(
  "deal_rooms",
  {
    ...entity(),
    name: varchar("name", { length: 255 }).notNull(),
    listing_id: fk("listing_id", () => listings.id),
    brokerage_deal_id: fk("brokerage_deal_id", () => brokerageDeals.id),
    property_id: fk("property_id", () => properties.id),
    owner_id: fk("owner_id", () => users.id),
    status: varchar("status", { length: 15 }).notNull().$defaultFn(() => "draft"),
    requires_nda: bool("requires_nda", true),
    allow_offers: bool("allow_offers", true),
    offer_deadline: tz("offer_deadline"),
    description: text("description"),
    opened_at: tz("opened_at"),
    closed_at: tz("closed_at"),
  },
  (t) => [
    index("ix_deal_rooms_deleted_at").on(t.deleted_at),
    index("ix_deal_rooms_listing_id").on(t.listing_id),
    index("ix_deal_rooms_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_deal_rooms_property_id").on(t.property_id),
    index("ix_deal_rooms_owner_id").on(t.owner_id),
    index("ix_deal_rooms_status").on(t.status),
  ],
);
export type DealRoom = typeof dealRooms.$inferSelect;

/** Confidentiality agreement status per counterparty. */
export const ndas = pgTable(
  "ndas",
  {
    ...entity(),
    counterparty_kind: varchar("counterparty_kind", { length: 15 }).notNull().$defaultFn(() => "person"),
    person_id: uuid("person_id"),
    organization_id: uuid("organization_id"),
    deal_room_id: fk("deal_room_id", () => dealRooms.id),
    listing_id: fk("listing_id", () => listings.id),
    brokerage_deal_id: fk("brokerage_deal_id", () => brokerageDeals.id),
    status: varchar("status", { length: 15 }).notNull().$defaultFn(() => "not_sent"),
    sent_at: tz("sent_at"),
    signed_at: tz("signed_at"),
    expires_on: date("expires_on", { mode: "string" }),
    signer_name: varchar("signer_name", { length: 200 }),
    signer_email: varchar("signer_email", { length: 255 }),
    document_id: uuid("document_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_ndas_deleted_at").on(t.deleted_at),
    index("ix_ndas_person_id").on(t.person_id),
    index("ix_ndas_organization_id").on(t.organization_id),
    index("ix_ndas_deal_room_id").on(t.deal_room_id),
    index("ix_ndas_listing_id").on(t.listing_id),
    index("ix_ndas_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_ndas_status").on(t.status),
  ],
);
export type Nda = typeof ndas.$inferSelect;

export const dealRoomFolders = pgTable(
  "deal_room_folders",
  {
    ...entity(),
    room_id: uuid("room_id").notNull().references(() => dealRooms.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    sort_order: integer("sort_order").notNull().$defaultFn(() => 0),
    is_restricted: bool("is_restricted", false),
    document_ids: uuid("document_ids").array().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_deal_room_folders_deleted_at").on(t.deleted_at),
    index("ix_deal_room_folders_room_id").on(t.room_id),
  ],
);
export type DealRoomFolder = typeof dealRoomFolders.$inferSelect;

/** Counterparty access grant. Empty folder_ids = every non-restricted folder. */
export const dealRoomAccess = pgTable(
  "deal_room_access",
  {
    ...entity(),
    room_id: uuid("room_id").notNull().references(() => dealRooms.id, { onDelete: "cascade" }),
    grantee_kind: varchar("grantee_kind", { length: 15 }).notNull().$defaultFn(() => "person"),
    person_id: uuid("person_id"),
    organization_id: uuid("organization_id"),
    user_id: fk("user_id", () => users.id),
    email: varchar("email", { length: 255 }),
    folder_ids: uuid("folder_ids").array().notNull().$defaultFn(() => []),
    can_download: bool("can_download", false),
    can_submit_offers: bool("can_submit_offers", true),
    expires_at: tz("expires_at"),
    status: varchar("status", { length: 10 }).notNull().$defaultFn(() => "active"),
    nda_id: fk("nda_id", () => ndas.id),
    revoked_at: tz("revoked_at"),
    revoked_by_id: fk("revoked_by_id", () => users.id),
    last_accessed_at: tz("last_accessed_at"),
  },
  (t) => [
    index("ix_deal_room_access_deleted_at").on(t.deleted_at),
    index("ix_deal_room_access_room_id").on(t.room_id),
    index("ix_deal_room_access_person_id").on(t.person_id),
    index("ix_deal_room_access_organization_id").on(t.organization_id),
    index("ix_deal_room_access_user_id").on(t.user_id),
    index("ix_deal_room_access_status").on(t.status),
    index("ix_deal_room_access_nda_id").on(t.nda_id),
  ],
);
export type DealRoomAccess = typeof dealRoomAccess.$inferSelect;

/** Every view/download (and denial) in a deal room. Append-only. */
export const dealRoomAccessLog = pgTable(
  "deal_room_access_log",
  {
    id: pk(),
    room_id: uuid("room_id").notNull().references(() => dealRooms.id, { onDelete: "cascade" }),
    access_id: uuid("access_id"),
    folder_id: uuid("folder_id"),
    document_id: uuid("document_id"),
    action: varchar("action", { length: 20 }).notNull(),
    user_id: uuid("user_id"),
    person_id: uuid("person_id"),
    organization_id: uuid("organization_id"),
    actor_name: varchar("actor_name", { length: 200 }),
    is_internal: bool("is_internal", false),
    detail: text("detail"),
    ip_address: varchar("ip_address", { length: 64 }),
    at: tz("at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    index("ix_deal_room_access_log_room_id").on(t.room_id),
    index("ix_deal_room_access_log_access_id").on(t.access_id),
    index("ix_deal_room_access_log_document_id").on(t.document_id),
    index("ix_deal_room_access_log_action").on(t.action),
    index("ix_deal_room_access_log_user_id").on(t.user_id),
    index("ix_deal_room_access_log_at").on(t.at),
  ],
);
export type DealRoomAccessLog = typeof dealRoomAccessLog.$inferSelect;

/** Structured offer submitted through a deal room; internal users review it. */
export const offerSubmissions = pgTable(
  "offer_submissions",
  {
    ...entity(),
    room_id: fk("room_id", () => dealRooms.id),
    listing_id: fk("listing_id", () => listings.id),
    brokerage_deal_id: fk("brokerage_deal_id", () => brokerageDeals.id),
    property_id: fk("property_id", () => properties.id),
    access_id: fk("access_id", () => dealRoomAccess.id),
    submitter_user_id: fk("submitter_user_id", () => users.id),
    submitter_person_id: uuid("submitter_person_id"),
    submitter_organization_id: uuid("submitter_organization_id"),
    submitter_name: varchar("submitter_name", { length: 200 }),
    submitter_email: varchar("submitter_email", { length: 255 }),
    buyer_entity: varchar("buyer_entity", { length: 255 }),
    version: integer("version").notNull().$defaultFn(() => 1),
    parent_submission_id: fk("parent_submission_id", (): any => offerSubmissions.id),
    price: numericFloat("price", 16, 2),
    earnest_money: numericFloat("earnest_money", 16, 2),
    due_diligence_days: integer("due_diligence_days"),
    closing_days: integer("closing_days"),
    financing_type: varchar("financing_type", { length: 30 }),
    contingencies: varchar("contingencies", { length: 120 }).array().notNull().$defaultFn(() => []),
    terms: text("terms"),
    expires_at: tz("expires_at"),
    document_id: uuid("document_id"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "submitted"),
    submitted_at: tz("submitted_at").notNull().$defaultFn(() => new Date()),
    reviewed_by_id: fk("reviewed_by_id", () => users.id),
    reviewed_at: tz("reviewed_at"),
    review_notes: text("review_notes"),
  },
  (t) => [
    index("ix_offer_submissions_deleted_at").on(t.deleted_at),
    index("ix_offer_submissions_room_id").on(t.room_id),
    index("ix_offer_submissions_listing_id").on(t.listing_id),
    index("ix_offer_submissions_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_offer_submissions_property_id").on(t.property_id),
    index("ix_offer_submissions_access_id").on(t.access_id),
    index("ix_offer_submissions_submitter_user_id").on(t.submitter_user_id),
    index("ix_offer_submissions_parent_submission_id").on(t.parent_submission_id),
    index("ix_offer_submissions_status").on(t.status),
    index("ix_offer_submissions_submitted_at").on(t.submitted_at),
  ],
);
export type OfferSubmission = typeof offerSubmissions.$inferSelect;

export const agentLicenses = pgTable(
  "agent_licenses",
  {
    ...entity(),
    user_id: fk("user_id", () => users.id),
    holder_name: varchar("holder_name", { length: 200 }).notNull(),
    license_type: varchar("license_type", { length: 20 }).notNull().$defaultFn(() => "salesperson"),
    license_number: varchar("license_number", { length: 60 }).notNull(),
    state: varchar("state", { length: 40 }).notNull(),
    issued_on: date("issued_on", { mode: "string" }),
    expires_on: date("expires_on", { mode: "string" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    ce_hours_required: doublePrecision("ce_hours_required"),
    ce_hours_completed: doublePrecision("ce_hours_completed"),
    sponsoring_broker: varchar("sponsoring_broker", { length: 200 }),
    document_id: uuid("document_id"),
    critical_date_id: uuid("critical_date_id"),
    last_alerted_at: tz("last_alerted_at"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_agent_licenses_deleted_at").on(t.deleted_at),
    index("ix_agent_licenses_user_id").on(t.user_id),
    index("ix_agent_licenses_license_number").on(t.license_number),
    index("ix_agent_licenses_state").on(t.state),
    index("ix_agent_licenses_expires_on").on(t.expires_on),
    index("ix_agent_licenses_status").on(t.status),
  ],
);
export type AgentLicense = typeof agentLicenses.$inferSelect;

/** Required disclosure with delivery evidence; dual-agency / intermediary also need acknowledgement. */
export const disclosures = pgTable(
  "disclosures",
  {
    ...entity(),
    brokerage_deal_id: fk("brokerage_deal_id", () => brokerageDeals.id),
    listing_id: fk("listing_id", () => listings.id),
    property_id: fk("property_id", () => properties.id),
    disclosure_type: varchar("disclosure_type", { length: 40 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    recipient_person_id: uuid("recipient_person_id"),
    recipient_organization_id: uuid("recipient_organization_id"),
    recipient_name: varchar("recipient_name", { length: 200 }),
    due_on: date("due_on", { mode: "string" }),
    status: varchar("status", { length: 15 }).notNull().$defaultFn(() => "required"),
    is_blocking: bool("is_blocking", true),
    requires_acknowledgement: bool("requires_acknowledgement", false),
    delivered_at: tz("delivered_at"),
    delivery_method: varchar("delivery_method", { length: 15 }),
    evidence_document_id: uuid("evidence_document_id"),
    evidence_note: text("evidence_note"),
    acknowledged_at: tz("acknowledged_at"),
    acknowledged_by_name: varchar("acknowledged_by_name", { length: 200 }),
    acknowledgement_document_id: uuid("acknowledgement_document_id"),
    waived_reason: text("waived_reason"),
    owner_id: fk("owner_id", () => users.id),
    critical_date_id: uuid("critical_date_id"),
  },
  (t) => [
    index("ix_disclosures_deleted_at").on(t.deleted_at),
    index("ix_disclosures_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_disclosures_listing_id").on(t.listing_id),
    index("ix_disclosures_property_id").on(t.property_id),
    index("ix_disclosures_disclosure_type").on(t.disclosure_type),
    index("ix_disclosures_due_on").on(t.due_on),
    index("ix_disclosures_status").on(t.status),
    index("ix_disclosures_owner_id").on(t.owner_id),
  ],
);
export type Disclosure = typeof disclosures.$inferSelect;

export const adReviews = pgTable(
  "ad_reviews",
  {
    ...entity(),
    title: varchar("title", { length: 255 }).notNull(),
    listing_id: fk("listing_id", () => listings.id),
    marketing_item_id: fk("marketing_item_id", () => marketingItems.id),
    brokerage_deal_id: fk("brokerage_deal_id", () => brokerageDeals.id),
    channel: varchar("channel", { length: 40 }),
    content_summary: text("content_summary"),
    document_id: uuid("document_id"),
    submitted_by_id: fk("submitted_by_id", () => users.id),
    submitted_at: tz("submitted_at").notNull().$defaultFn(() => new Date()),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "pending"),
    checklist: jsonb("checklist").$type<any[]>().notNull().$defaultFn(() => []),
    reviewer_id: fk("reviewer_id", () => users.id),
    reviewed_at: tz("reviewed_at"),
    review_notes: text("review_notes"),
  },
  (t) => [
    index("ix_ad_reviews_deleted_at").on(t.deleted_at),
    index("ix_ad_reviews_listing_id").on(t.listing_id),
    index("ix_ad_reviews_marketing_item_id").on(t.marketing_item_id),
    index("ix_ad_reviews_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_ad_reviews_submitted_by_id").on(t.submitted_by_id),
    index("ix_ad_reviews_status").on(t.status),
    index("ix_ad_reviews_reviewer_id").on(t.reviewer_id),
  ],
);
export type AdReview = typeof adReviews.$inferSelect;

export const transactionFiles = pgTable(
  "transaction_files",
  {
    ...entity(),
    brokerage_deal_id: uuid("brokerage_deal_id").notNull().references(() => brokerageDeals.id, { onDelete: "set null" }),
    template_key: varchar("template_key", { length: 30 }).notNull(),
    status: varchar("status", { length: 15 }).notNull().$defaultFn(() => "open"), // open | complete | approved
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_transaction_files_deleted_at").on(t.deleted_at),
    index("ix_transaction_files_brokerage_deal_id").on(t.brokerage_deal_id),
    index("ix_transaction_files_status").on(t.status),
    unique("uq_transaction_file_deal").on(t.brokerage_deal_id),
  ],
);
export type TransactionFile = typeof transactionFiles.$inferSelect;

export const transactionFileItems = pgTable(
  "transaction_file_items",
  {
    ...entity(),
    file_id: uuid("file_id").notNull().references(() => transactionFiles.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 60 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    category: varchar("category", { length: 20 }).notNull().$defaultFn(() => "other"),
    is_required: bool("is_required", true),
    sort_order: integer("sort_order").notNull().$defaultFn(() => 0),
    status: varchar("status", { length: 15 }).notNull().$defaultFn(() => "missing"),
    document_id: uuid("document_id"),
    evidence_note: text("evidence_note"),
    linked_type: varchar("linked_type", { length: 40 }),
    linked_id: uuid("linked_id"),
    reviewed_by_id: fk("reviewed_by_id", () => users.id),
    reviewed_at: tz("reviewed_at"),
    waived_reason: text("waived_reason"),
  },
  (t) => [
    index("ix_transaction_file_items_deleted_at").on(t.deleted_at),
    index("ix_transaction_file_items_file_id").on(t.file_id),
    index("ix_transaction_file_items_status").on(t.status),
  ],
);
export type TransactionFileItem = typeof transactionFileItems.$inferSelect;
