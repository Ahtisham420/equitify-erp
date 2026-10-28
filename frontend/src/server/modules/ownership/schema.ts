import { boolean, date, doublePrecision, index, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { organizations, people } from "../contacts/schema";
import { properties } from "../properties/schema";

export const INTEREST_ROLES = [
  "fee_owner", "tenant_in_common", "general_partner", "limited_partner", "managing_member", "member",
  "beneficial_owner", "ground_lessor", "trustee", "other",
] as const;
export const FINANCING_TYPES = ["all_cash", "bank_loan", "cmbs", "life_company", "seller_financing", "assumed", "private", "unknown"] as const;
export const LINK_RELATIONSHIPS = [
  "manager", "member", "officer", "director", "registered_agent", "parent", "affiliate", "family", "advisor",
] as const;
// Relationships where `from` controls `to`.
export const CONTROL_RELATIONSHIPS = new Set(["manager", "member", "officer", "director", "parent"]);
export const EVIDENCE_TYPES = [
  "shared_mailing_address", "shared_phone", "shared_email_domain", "registered_agent", "officer_director_record",
  "deed_signatory", "corroborated_name", "other",
] as const;
export const NOTE_CATEGORIES = ["preference", "financing", "hold_strategy", "prior_offer", "advisor", "family", "circumstance", "other"] as const;
export const VERIFICATION = ["unverified", "verified", "rejected"] as const;

/** Owner -> property interest. Time-bound: ending an interest sets effective_to; rows are never deleted. */
export const ownershipInterests = pgTable(
  "ownership_interests",
  {
    ...entity(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    owner_kind: varchar("owner_kind", { length: 20 }).notNull(), // person | organization
    owner_person_id: fk("owner_person_id", () => people.id),
    owner_organization_id: fk("owner_organization_id", () => organizations.id),
    interest_pct: numericFloat("interest_pct", 7, 3),
    role: varchar("role", { length: 40 }).notNull().$defaultFn(() => "fee_owner"),
    effective_from: date("effective_from", { mode: "string" }),
    effective_to: date("effective_to", { mode: "string" }),
    acquired_price: numericFloat("acquired_price", 16, 2),
    disposed_price: numericFloat("disposed_price", 16, 2),
    financing_type: varchar("financing_type", { length: 40 }),
    deed_reference: varchar("deed_reference", { length: 120 }),
    end_reason: varchar("end_reason", { length: 200 }),
    evidence: jsonb("evidence").$type<any[]>().notNull().$defaultFn(() => []),
    source: varchar("source", { length: 200 }).notNull().$defaultFn(() => "Manual entry"),
    observed_on: date("observed_on", { mode: "string" }),
    confidence: doublePrecision("confidence").notNull().$defaultFn(() => 0.8),
    verification: varchar("verification", { length: 20 }).notNull().$defaultFn(() => "unverified"),
    verified_by_id: uuid("verified_by_id").references(() => users.id, { onDelete: "set null" }),
    verified_at: tz("verified_at"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_ownership_interests_deleted_at").on(t.deleted_at),
    index("ix_ownership_interests_property_id").on(t.property_id),
    index("ix_ownership_interests_owner_kind").on(t.owner_kind),
    index("ix_ownership_interests_owner_person_id").on(t.owner_person_id),
    index("ix_ownership_interests_owner_organization_id").on(t.owner_organization_id),
    index("ix_ownership_interests_role").on(t.role),
    index("ix_ownership_interests_effective_from").on(t.effective_from),
    index("ix_ownership_interests_effective_to").on(t.effective_to),
    index("ix_ownership_interests_verification").on(t.verification),
  ],
);
export type OwnershipInterest = typeof ownershipInterests.$inferSelect;

/** Entity<->entity / person<->entity relationship with evidence and confidence. Suggestions need human review. */
export const entityLinks = pgTable(
  "entity_links",
  {
    ...entity(),
    from_kind: varchar("from_kind", { length: 20 }).notNull(),
    from_id: uuid("from_id").notNull(),
    to_kind: varchar("to_kind", { length: 20 }).notNull(),
    to_id: uuid("to_id").notNull(),
    relationship: varchar("relationship", { length: 30 }).notNull(),
    confidence: doublePrecision("confidence").notNull().$defaultFn(() => 0.5),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "suggested"), // suggested|confirmed|rejected
    evidence: jsonb("evidence").$type<any[]>().notNull().$defaultFn(() => []),
    source: varchar("source", { length: 200 }).notNull().$defaultFn(() => "Manual entry"),
    suggested_by: varchar("suggested_by", { length: 20 }).notNull().$defaultFn(() => "user"), // user | engine
    signature: varchar("signature", { length: 120 }).notNull(),
    reviewed_by_id: uuid("reviewed_by_id").references(() => users.id, { onDelete: "set null" }),
    reviewed_at: tz("reviewed_at"),
    review_note: text("review_note"),
    effective_from: date("effective_from", { mode: "string" }),
    effective_to: date("effective_to", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_entity_links_deleted_at").on(t.deleted_at),
    index("ix_entity_links_from_kind").on(t.from_kind),
    index("ix_entity_links_from_id").on(t.from_id),
    index("ix_entity_links_to_kind").on(t.to_kind),
    index("ix_entity_links_to_id").on(t.to_id),
    index("ix_entity_links_relationship").on(t.relationship),
    index("ix_entity_links_status").on(t.status),
    index("ix_entity_links_signature").on(t.signature),
  ],
);
export type EntityLink = typeof entityLinks.$inferSelect;

/** Owner preferences, financing patterns, advisors/family (where lawful). `sensitive` notes never leave the system. */
export const ownerNotes = pgTable(
  "owner_notes",
  {
    ...entity(),
    owner_kind: varchar("owner_kind", { length: 20 }).notNull(),
    owner_id: uuid("owner_id").notNull(),
    category: varchar("category", { length: 30 }).notNull().$defaultFn(() => "other"),
    body: text("body").notNull(),
    sensitive: boolean("sensitive").notNull().$defaultFn(() => false),
    source: varchar("source", { length: 200 }),
    observed_on: date("observed_on", { mode: "string" }),
  },
  (t) => [
    index("ix_owner_notes_deleted_at").on(t.deleted_at),
    index("ix_owner_notes_owner_kind").on(t.owner_kind),
    index("ix_owner_notes_owner_id").on(t.owner_id),
    index("ix_owner_notes_sensitive").on(t.sensitive),
  ],
);
export type OwnerNote = typeof ownerNotes.$inferSelect;
