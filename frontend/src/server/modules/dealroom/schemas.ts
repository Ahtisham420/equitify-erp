import { z } from "zod";

/** Same fields as `shape`, all optional + nullable (PATCH bodies). Unknown keys are rejected; only sent keys are kept. */
function partial<T extends z.ZodRawShape>(shape: T) {
  const fields = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, (v as z.ZodTypeAny).nullish()]));
  return z.object(fields as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> }).strict();
}

const uuid = z.string().uuid();
const dt = z.coerce.date();
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const dateStr = z.string().date();

// ------------------------------------------------------------------ tours

export const participant = z.object({
  kind: z.enum(["user", "person", "organization", "external"]).default("external"),
  id: uuid.nullable().default(null),
  name: z.string().min(1).max(200),
  email: z.string().max(255).nullable().default(null),
  role: z.string().max(80).nullable().default(null),
});
export type Participant = z.infer<typeof participant>;

const tourBaseShape = {
  title: z.string().max(255).nullish(),
  agent_id: uuid.nullish(),
  client_person_id: uuid.nullish(),
  client_organization_id: uuid.nullish(),
  brokerage_deal_id: uuid.nullish(),
  requirement_id: uuid.nullish(),
  scheduled_on: dateStr,
  start_time: hhmm.nullish(),
  status: z.enum(["planned", "confirmed", "completed", "cancelled"]).default("planned"),
  start_label: z.string().max(255).nullish(),
  start_lat: z.number().min(-90).max(90).nullish(),
  start_lng: z.number().min(-180).max(180).nullish(),
  participants: z.array(participant).default([]),
  notes: z.string().nullish(),
};

export const tourBase = z.object(tourBaseShape);
export type TourBase = z.infer<typeof tourBase>;

export const tourCreate = z.object({ ...tourBaseShape, property_ids: z.array(uuid).default([]) });
export type TourCreate = z.infer<typeof tourCreate>;

export const tourUpdate = partial(tourBaseShape);
export type TourUpdate = z.infer<typeof tourUpdate>;

export const stopIn = z.object({
  property_id: uuid,
  listing_id: uuid.nullish(),
  arrive_time: hhmm.nullish(),
  duration_minutes: z.number().int().min(5).max(480).default(30),
  access_notes: z.string().nullish(),
});
export type StopIn = z.infer<typeof stopIn>;

export const stopUpdate = z
  .object({
    arrive_time: hhmm.nullish(),
    duration_minutes: z.number().int().min(5).max(480).nullish(),
    status: z.enum(["planned", "visited", "skipped"]).nullish(),
    access_notes: z.string().nullish(),
    sequence: z.number().int().min(0).nullish(),
  })
  .strict();
export type StopUpdate = z.infer<typeof stopUpdate>;

export const feedbackIn = z.object({
  stop_id: uuid.nullish(),
  property_id: uuid.nullish(),
  person_id: uuid.nullish(),
  rating: z.number().int().min(1).max(5).nullish(),
  interest_level: z.enum(["none", "low", "medium", "high"]).nullish(),
  feedback: z.string().nullish(),
  objections: z.string().nullish(),
  next_action: z.string().max(300).nullish(),
  next_action_at: dt.nullish(),
});
export type FeedbackIn = z.infer<typeof feedbackIn>;

// ------------------------------------------------------------------ NDAs & deal rooms

const ndaBaseShape = {
  counterparty_kind: z.enum(["person", "organization"]).default("person"),
  person_id: uuid.nullish(),
  organization_id: uuid.nullish(),
  deal_room_id: uuid.nullish(),
  listing_id: uuid.nullish(),
  brokerage_deal_id: uuid.nullish(),
  status: z.enum(["not_sent", "sent", "signed", "declined", "expired"]).default("not_sent"),
  sent_at: dt.nullish(),
  signed_at: dt.nullish(),
  expires_on: dateStr.nullish(),
  signer_name: z.string().max(200).nullish(),
  signer_email: z.string().max(255).nullish(),
  document_id: uuid.nullish(),
  notes: z.string().nullish(),
};
export const ndaBase = z.object(ndaBaseShape);
export type NdaBase = z.infer<typeof ndaBase>;
export const ndaUpdate = partial(ndaBaseShape);
export type NdaUpdate = z.infer<typeof ndaUpdate>;

const roomBaseShape = {
  name: z.string().max(255).nullish(),
  listing_id: uuid.nullish(),
  brokerage_deal_id: uuid.nullish(),
  property_id: uuid.nullish(),
  owner_id: uuid.nullish(),
  status: z.enum(["draft", "open", "closed", "archived"]).default("draft"),
  requires_nda: z.boolean().default(true),
  allow_offers: z.boolean().default(true),
  offer_deadline: dt.nullish(),
  description: z.string().nullish(),
};
export const roomBase = z.object(roomBaseShape);
export type RoomBase = z.infer<typeof roomBase>;
export const roomCreate = z.object({ ...roomBaseShape, default_folders: z.boolean().default(true) });
export type RoomCreate = z.infer<typeof roomCreate>;
export const roomUpdate = partial(roomBaseShape);
export type RoomUpdate = z.infer<typeof roomUpdate>;

const folderInShape = {
  name: z.string().min(1).max(200),
  sort_order: z.number().int().default(0),
  is_restricted: z.boolean().default(false),
  document_ids: z.array(uuid).default([]),
};
export const folderIn = z.object(folderInShape);
export type FolderIn = z.infer<typeof folderIn>;
export const folderUpdate = partial(folderInShape);
export type FolderUpdate = z.infer<typeof folderUpdate>;

export const accessIn = z.object({
  grantee_kind: z.enum(["person", "organization", "user"]).default("person"),
  person_id: uuid.nullish(),
  organization_id: uuid.nullish(),
  user_id: uuid.nullish(),
  email: z.string().max(255).nullish(),
  folder_ids: z.array(uuid).default([]),
  can_download: z.boolean().default(false),
  can_submit_offers: z.boolean().default(true),
  expires_at: dt.nullish(),
  nda_id: uuid.nullish(),
});
export type AccessIn = z.infer<typeof accessIn>;

export const accessUpdate = z
  .object({
    folder_ids: z.array(uuid).nullish(),
    can_download: z.boolean().nullish(),
    can_submit_offers: z.boolean().nullish(),
    expires_at: dt.nullish(),
    nda_id: uuid.nullish(),
  })
  .strict();
export type AccessUpdate = z.infer<typeof accessUpdate>;

// ------------------------------------------------------------------ offers

export const offerIn = z.object({
  submitter_person_id: uuid.nullish(),
  submitter_organization_id: uuid.nullish(),
  submitter_name: z.string().max(200).nullish(),
  submitter_email: z.string().max(255).nullish(),
  buyer_entity: z.string().max(255).nullish(),
  price: z.number().gt(0),
  earnest_money: z.number().min(0).nullish(),
  due_diligence_days: z.number().int().min(0).max(730).nullish(),
  closing_days: z.number().int().min(0).max(1095).nullish(),
  financing_type: z.enum(["cash", "conventional", "sba", "seller_financing", "assumption", "other"]).nullish(),
  contingencies: z.array(z.string()).default([]),
  terms: z.string().nullish(),
  expires_at: dt.nullish(),
  document_id: uuid.nullish(),
  parent_submission_id: uuid.nullish(),
});
export type OfferIn = z.infer<typeof offerIn>;

export const offerReviewIn = z.object({
  status: z.enum(["under_review", "shortlisted", "countered", "accepted", "rejected", "withdrawn"]),
  review_notes: z.string().nullish(),
});
export type OfferReviewIn = z.infer<typeof offerReviewIn>;

// ------------------------------------------------------------------ compliance

const licenseBaseShape = {
  user_id: uuid.nullish(),
  holder_name: z.string().max(200).nullish(),
  license_type: z.enum(["salesperson", "broker", "broker_associate", "managing_broker", "firm"]).default("salesperson"),
  license_number: z.string().min(1).max(60),
  state: z.string().min(1).max(40),
  issued_on: dateStr.nullish(),
  expires_on: dateStr.nullish(),
  status: z.enum(["active", "pending_renewal", "expired", "suspended", "inactive"]).default("active"),
  ce_hours_required: z.number().min(0).nullish(),
  ce_hours_completed: z.number().min(0).nullish(),
  sponsoring_broker: z.string().max(200).nullish(),
  document_id: uuid.nullish(),
  notes: z.string().nullish(),
};
export const licenseBase = z.object(licenseBaseShape);
export type LicenseBase = z.infer<typeof licenseBase>;
export const licenseUpdate = partial(licenseBaseShape);
export type LicenseUpdate = z.infer<typeof licenseUpdate>;

const disclosureBaseShape = {
  brokerage_deal_id: uuid.nullish(),
  listing_id: uuid.nullish(),
  property_id: uuid.nullish(),
  disclosure_type: z
    .enum([
      "agency", "dual_agency", "intermediary", "seller_property_condition", "lead_paint",
      "environmental", "material_defect", "affiliated_business", "other",
    ])
    .default("agency"),
  title: z.string().max(255).nullish(),
  recipient_person_id: uuid.nullish(),
  recipient_organization_id: uuid.nullish(),
  recipient_name: z.string().max(200).nullish(),
  due_on: dateStr.nullish(),
  is_blocking: z.boolean().default(true),
  requires_acknowledgement: z.boolean().nullish(),
  owner_id: uuid.nullish(),
  evidence_note: z.string().nullish(),
};
export const disclosureBase = z.object(disclosureBaseShape);
export type DisclosureBase = z.infer<typeof disclosureBase>;
export const disclosureUpdate = partial(disclosureBaseShape);
export type DisclosureUpdate = z.infer<typeof disclosureUpdate>;

export const deliverIn = z.object({
  delivered_at: dt.nullish(),
  delivery_method: z.enum(["email", "in_person", "portal", "mail", "e_sign"]),
  evidence_document_id: uuid.nullish(),
  evidence_note: z.string().nullish(),
});
export type DeliverIn = z.infer<typeof deliverIn>;

export const acknowledgeIn = z.object({
  acknowledged_at: dt.nullish(),
  acknowledged_by_name: z.string().min(1).max(200),
  acknowledgement_document_id: uuid.nullish(),
});
export type AcknowledgeIn = z.infer<typeof acknowledgeIn>;

export const waiveIn = z.object({ reason: z.string().min(3).max(2000) });
export type WaiveIn = z.infer<typeof waiveIn>;

export const adReviewBase = z.object({
  title: z.string().min(1).max(255),
  listing_id: uuid.nullish(),
  marketing_item_id: uuid.nullish(),
  brokerage_deal_id: uuid.nullish(),
  channel: z.string().max(40).nullish(),
  content_summary: z.string().nullish(),
  document_id: uuid.nullish(),
});
export type AdReviewBase = z.infer<typeof adReviewBase>;

export const adDecisionIn = z.object({
  status: z.enum(["approved", "rejected", "changes_requested"]),
  review_notes: z.string().nullish(),
  checklist: z.array(z.record(z.any())).default([]),
});
export type AdDecisionIn = z.infer<typeof adDecisionIn>;

export const fileItemIn = z.object({
  label: z.string().min(1).max(255),
  category: z.enum(["agreement", "disclosure", "contract", "compliance", "closing", "financial", "other"]).default("other"),
  is_required: z.boolean().default(true),
});
export type FileItemIn = z.infer<typeof fileItemIn>;

export const fileItemUpdate = z
  .object({
    status: z.enum(["missing", "provided", "approved", "waived", "rejected"]).nullish(),
    document_id: uuid.nullish(),
    evidence_note: z.string().nullish(),
    waived_reason: z.string().nullish(),
    is_required: z.boolean().nullish(),
  })
  .strict();
export type FileItemUpdate = z.infer<typeof fileItemUpdate>;

export const fileStartIn = z.object({ brokerage_deal_id: uuid });
export type FileStartIn = z.infer<typeof fileStartIn>;
