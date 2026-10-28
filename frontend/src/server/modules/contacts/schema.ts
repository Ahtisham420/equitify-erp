import { boolean, date, doublePrecision, index, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";

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

export const people = pgTable(
  "people",
  {
    ...entity(),
    first_name: varchar("first_name", { length: 120 }),
    last_name: varchar("last_name", { length: 120 }),
    full_name: varchar("full_name", { length: 240 }).notNull(),
    normalized_name: varchar("normalized_name", { length: 240 }).notNull().$defaultFn(() => ""),
    title: varchar("title", { length: 160 }),
    primary_email: varchar("primary_email", { length: 255 }),
    primary_phone: varchar("primary_phone", { length: 40 }),
    mailing_address: varchar("mailing_address", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 40 }),
    postal_code: varchar("postal_code", { length: 20 }),
    contact_preferences: jsonb("contact_preferences").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    owner_id: fk("owner_id", () => users.id),
    // Relationship intelligence. last_touch_at / next_action_at are maintained by the outreach module.
    last_touch_at: tz("last_touch_at"),
    next_action_at: tz("next_action_at"),
    next_action: varchar("next_action", { length: 300 }),
    responsiveness: varchar("responsiveness", { length: 20 }).notNull().$defaultFn(() => "unknown"),
    relationship_strength: varchar("relationship_strength", { length: 20 }).notNull().$defaultFn(() => "none"),
    preferences: jsonb("preferences").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    source: varchar("source", { length: 200 }),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
    merged_into_id: uuid("merged_into_id").references((): any => people.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_people_deleted_at").on(t.deleted_at),
    index("ix_people_full_name").on(t.full_name),
    index("ix_people_normalized_name").on(t.normalized_name),
    index("ix_people_primary_email").on(t.primary_email),
    index("ix_people_state").on(t.state),
    index("ix_people_owner_id").on(t.owner_id),
    index("ix_people_last_touch_at").on(t.last_touch_at),
    index("ix_people_next_action_at").on(t.next_action_at),
    index("ix_people_responsiveness").on(t.responsiveness),
    index("ix_people_relationship_strength").on(t.relationship_strength),
    index("ix_people_merged_into_id").on(t.merged_into_id),
  ],
);
export type Person = typeof people.$inferSelect;

export const organizations = pgTable(
  "organizations",
  {
    ...entity(),
    name: varchar("name", { length: 240 }).notNull(),
    legal_name: varchar("legal_name", { length: 240 }),
    normalized_name: varchar("normalized_name", { length: 240 }).notNull().$defaultFn(() => ""),
    org_type: varchar("org_type", { length: 40 }).notNull().$defaultFn(() => "other"),
    website: varchar("website", { length: 255 }),
    domain: varchar("domain", { length: 160 }),
    phone: varchar("phone", { length: 40 }),
    mailing_address: varchar("mailing_address", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 40 }),
    postal_code: varchar("postal_code", { length: 20 }),
    state_of_formation: varchar("state_of_formation", { length: 40 }),
    registered_agent: varchar("registered_agent", { length: 240 }),
    owner_id: fk("owner_id", () => users.id),
    last_touch_at: tz("last_touch_at"),
    next_action_at: tz("next_action_at"),
    next_action: varchar("next_action", { length: 300 }),
    responsiveness: varchar("responsiveness", { length: 20 }).notNull().$defaultFn(() => "unknown"),
    relationship_strength: varchar("relationship_strength", { length: 20 }).notNull().$defaultFn(() => "none"),
    preferences: jsonb("preferences").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    source: varchar("source", { length: 200 }),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
    merged_into_id: uuid("merged_into_id").references((): any => organizations.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_organizations_deleted_at").on(t.deleted_at),
    index("ix_organizations_name").on(t.name),
    index("ix_organizations_normalized_name").on(t.normalized_name),
    index("ix_organizations_org_type").on(t.org_type),
    index("ix_organizations_domain").on(t.domain),
    index("ix_organizations_state").on(t.state),
    index("ix_organizations_owner_id").on(t.owner_id),
    index("ix_organizations_last_touch_at").on(t.last_touch_at),
    index("ix_organizations_next_action_at").on(t.next_action_at),
    index("ix_organizations_merged_into_id").on(t.merged_into_id),
  ],
);
export type Organization = typeof organizations.$inferSelect;

export const contactPoints = pgTable(
  "contact_points",
  {
    ...entity(),
    person_id: fk("person_id", () => people.id, { onDelete: "cascade" }),
    organization_id: fk("organization_id", () => organizations.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 10 }).notNull(), // phone | email
    value: varchar("value", { length: 255 }).notNull(),
    normalized_value: varchar("normalized_value", { length: 255 }).notNull(),
    label: varchar("label", { length: 60 }),
    phone_type: varchar("phone_type", { length: 20 }),
    is_primary: boolean("is_primary").notNull().$defaultFn(() => false),
    source: varchar("source", { length: 200 }),
    observed_on: date("observed_on", { mode: "string" }),
    // Set by outreach on a wrong-number disposition; the value is kept for history.
    is_valid: boolean("is_valid").notNull().$defaultFn(() => true),
    invalid_reason: varchar("invalid_reason", { length: 200 }),
    invalid_at: tz("invalid_at"),
  },
  (t) => [
    index("ix_contact_points_deleted_at").on(t.deleted_at),
    index("ix_contact_points_person_id").on(t.person_id),
    index("ix_contact_points_organization_id").on(t.organization_id),
    index("ix_contact_points_kind").on(t.kind),
    index("ix_contact_points_normalized_value").on(t.normalized_value),
  ],
);
export type ContactPoint = typeof contactPoints.$inferSelect;

export const affiliations = pgTable(
  "affiliations",
  {
    ...entity(),
    person_id: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 30 }).notNull(),
    title: varchar("title", { length: 160 }),
    is_current: boolean("is_current").notNull().$defaultFn(() => true),
    started_on: date("started_on", { mode: "string" }),
    ended_on: date("ended_on", { mode: "string" }),
    source: varchar("source", { length: 200 }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_affiliations_deleted_at").on(t.deleted_at),
    index("ix_affiliations_person_id").on(t.person_id),
    index("ix_affiliations_organization_id").on(t.organization_id),
    index("ix_affiliations_role").on(t.role),
    index("ix_affiliations_is_current").on(t.is_current),
  ],
);
export type Affiliation = typeof affiliations.$inferSelect;

/** One enrichment pull: provider, date, cost, reliability and usage restrictions. */
export const contactEnrichments = pgTable(
  "contact_enrichments",
  {
    ...entity(),
    person_id: fk("person_id", () => people.id, { onDelete: "cascade" }),
    organization_id: fk("organization_id", () => organizations.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 120 }).notNull(),
    enriched_at: tz("enriched_at").notNull(),
    cost: numericFloat("cost", 16, 2),
    reliability: doublePrecision("reliability"), // 0..1
    fields: jsonb("fields").$type<any[]>().notNull().$defaultFn(() => []),
    restrictions: jsonb("restrictions").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    notes: text("notes"),
  },
  (t) => [
    index("ix_contact_enrichments_deleted_at").on(t.deleted_at),
    index("ix_contact_enrichments_person_id").on(t.person_id),
    index("ix_contact_enrichments_organization_id").on(t.organization_id),
  ],
);
export type ContactEnrichment = typeof contactEnrichments.$inferSelect;

/** Review-queue item for a likely duplicate pair. Never merged automatically. */
export const contactDuplicateReviews = pgTable(
  "contact_duplicate_reviews",
  {
    ...entity(),
    entity_type: varchar("entity_type", { length: 20 }).notNull(), // person | organization
    a_id: uuid("a_id").notNull(),
    b_id: uuid("b_id").notNull(),
    reasons: jsonb("reasons").$type<any[]>().notNull().$defaultFn(() => []),
    score: doublePrecision("score").notNull().$defaultFn(() => 0),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"), // open | merged | dismissed
    reviewed_by_id: uuid("reviewed_by_id").references(() => users.id, { onDelete: "set null" }),
    reviewed_at: tz("reviewed_at"),
  },
  (t) => [
    unique("uq_contact_dup_pair").on(t.entity_type, t.a_id, t.b_id),
    index("ix_contact_duplicate_reviews_deleted_at").on(t.deleted_at),
    index("ix_contact_duplicate_reviews_entity_type").on(t.entity_type),
    index("ix_contact_duplicate_reviews_a_id").on(t.a_id),
    index("ix_contact_duplicate_reviews_b_id").on(t.b_id),
    index("ix_contact_duplicate_reviews_status").on(t.status),
  ],
);
export type DuplicateReview = typeof contactDuplicateReviews.$inferSelect;

/** Reversible merge: full snapshot of the merged record and every repointed FK row. */
export const contactMerges = pgTable(
  "contact_merges",
  {
    ...entity(),
    entity_type: varchar("entity_type", { length: 20 }).notNull(),
    survivor_id: uuid("survivor_id").notNull(),
    merged_id: uuid("merged_id").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    survivor_before: jsonb("survivor_before").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    repointed: jsonb("repointed").$type<any[]>().notNull().$defaultFn(() => []),
    review_id: uuid("review_id"),
    reason: text("reason"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "merged"), // merged | reversed
    merged_at: tz("merged_at").notNull(),
    reversed_at: tz("reversed_at"),
    reversed_by_id: uuid("reversed_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_contact_merges_deleted_at").on(t.deleted_at),
    index("ix_contact_merges_entity_type").on(t.entity_type),
    index("ix_contact_merges_survivor_id").on(t.survivor_id),
    index("ix_contact_merges_merged_id").on(t.merged_id),
    index("ix_contact_merges_status").on(t.status),
  ],
);
export type MergeRecord = typeof contactMerges.$inferSelect;
