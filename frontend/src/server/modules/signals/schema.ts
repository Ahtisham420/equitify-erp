import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const CATEGORIES = ["debt", "legal", "tax", "ownership", "physical", "tenancy", "behavioral", "market", "development"] as const;
export const STATUSES = ["active", "expired", "dismissed"] as const;
export const OWNER_KINDS = ["person", "organization"] as const;

// Lazily seeded signal type catalogue: (key, label, category, default severity, half-life days, expiry days, sensitive).
export const DEFAULT_TYPES: Array<[string, string, string, number, number | null, number | null, boolean]> = [
  ["loan_maturity", "Loan maturity approaching", "debt", 4, 180, 540, false],
  ["rate_reset", "Rate reset / cap expiry", "debt", 3, 120, 365, false],
  ["lien_filed", "Lien filed", "debt", 4, 180, 730, false],
  ["loan_default", "Loan default / notice of default", "debt", 5, 120, 365, false],
  ["lis_pendens", "Lis pendens / litigation", "legal", 4, 180, 730, false],
  ["foreclosure_filing", "Foreclosure filing", "legal", 5, 120, 365, false],
  ["probate_estate", "Probate / estate proceeding", "legal", 4, 365, 1095, true],
  ["divorce_filing", "Divorce / partnership dispute", "legal", 4, 365, 1095, true],
  ["tax_delinquent", "Property tax delinquency", "tax", 4, 180, 730, false],
  ["assessment_increase", "Assessment increase", "tax", 2, 120, 365, false],
  ["ownership_change", "Ownership / entity change", "ownership", 3, 180, 730, false],
  ["long_hold", "Long hold period", "ownership", 2, null, null, false],
  ["owner_age_succession", "Owner age / succession", "ownership", 3, 730, null, true],
  ["deferred_maintenance", "Deferred maintenance observed", "physical", 3, 365, null, false],
  ["code_violation", "Code violation", "physical", 3, 180, 730, false],
  ["casualty_event", "Casualty / damage event", "physical", 4, 180, 540, false],
  ["vacancy_observed", "Vacancy observed", "tenancy", 3, 180, 540, false],
  ["lease_expiration", "Major lease expiration", "tenancy", 3, 365, 730, false],
  ["tenant_bankruptcy", "Tenant bankruptcy / closure", "tenancy", 5, 180, 540, false],
  ["owner_inbound_inquiry", "Owner inbound inquiry", "behavioral", 4, 60, 180, false],
  ["listed_for_sale", "Listed for sale", "behavioral", 4, 90, 365, false],
  ["price_reduction", "Price reduction", "behavioral", 3, 90, 365, false],
  ["cap_rate_shift", "Cap rate shift", "market", 2, 180, 365, false],
  ["interest_rate_shift", "Interest rate shift", "market", 2, 120, 365, false],
  ["comp_sale_nearby", "Comparable sale nearby", "market", 2, 180, 365, false],
  ["rezoning", "Rezoning / entitlement", "development", 3, 365, 1095, false],
  ["infrastructure_project", "Infrastructure project", "development", 2, 365, 1095, false],
  ["new_development_nearby", "New development nearby", "development", 2, 365, 1095, false],
];

/** Configurable catalogue: decay (half-life), default severity/expiry and sensitivity per signal type. */
export const signalTypes = pgTable(
  "signal_types",
  {
    ...entity(),
    key: varchar("key", { length: 60 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    category: varchar("category", { length: 20 }).notNull(),
    description: text("description"),
    default_severity: integer("default_severity").notNull().$defaultFn(() => 3),
    half_life_days: integer("half_life_days"), // null = no decay
    default_expiry_days: integer("default_expiry_days"),
    is_sensitive: boolean("is_sensitive").notNull().$defaultFn(() => false),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [
    index("ix_signal_types_deleted_at").on(t.deleted_at),
    unique("uq_signal_types_key").on(t.key),
    index("ix_signal_types_category").on(t.category),
    index("ix_signal_types_is_active").on(t.is_active),
  ],
);
export type SignalType = typeof signalTypes.$inferSelect;

/** A sourced, dated event linked to a property and/or an owner (spec module 10). */
export const signals = pgTable(
  "signals",
  {
    ...entity(),
    property_id: fk("property_id", () => properties.id),
    owner_kind: varchar("owner_kind", { length: 20 }),
    owner_id: uuid("owner_id"),
    category: varchar("category", { length: 20 }).notNull(),
    signal_type: varchar("signal_type", { length: 60 }).notNull(),
    title: varchar("title", { length: 300 }),
    description: text("description"),
    observed_on: date("observed_on", { mode: "string" }).notNull(),
    severity: integer("severity").notNull().$defaultFn(() => 3),
    source: varchar("source", { length: 200 }).notNull(),
    source_reference: varchar("source_reference", { length: 300 }),
    confidence: doublePrecision("confidence").notNull().$defaultFn(() => 0.7),
    expires_on: date("expires_on", { mode: "string" }),
    half_life_days: integer("half_life_days"),
    is_sensitive: boolean("is_sensitive").notNull().$defaultFn(() => false),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    details: jsonb("details").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    verification: varchar("verification", { length: 20 }).notNull().$defaultFn(() => "unverified"),
    verified_by_id: fk("verified_by_id", () => users.id),
    verified_at: tz("verified_at"),
    dismissed_reason: text("dismissed_reason"),
    dismissed_by_id: fk("dismissed_by_id", () => users.id),
    dismissed_at: tz("dismissed_at"),
  },
  (t) => [
    index("ix_signals_deleted_at").on(t.deleted_at),
    index("ix_signals_property_id").on(t.property_id),
    index("ix_signals_owner_kind").on(t.owner_kind),
    index("ix_signals_owner_id").on(t.owner_id),
    index("ix_signals_category").on(t.category),
    index("ix_signals_signal_type").on(t.signal_type),
    index("ix_signals_observed_on").on(t.observed_on),
    index("ix_signals_severity").on(t.severity),
    index("ix_signals_expires_on").on(t.expires_on),
    index("ix_signals_is_sensitive").on(t.is_sensitive),
    index("ix_signals_status").on(t.status),
    index("ix_signals_verification").on(t.verification),
  ],
);
export type Signal = typeof signals.$inferSelect;

/** A user's standing interest in new signals (by category/type/severity/property/owner/territory). */
export const signalSubscriptions = pgTable(
  "signal_subscriptions",
  {
    ...entity(),
    subscriber_id: fk("subscriber_id", () => users.id, { notNull: true, onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    categories: varchar("categories", { length: 20 }).array().notNull().$defaultFn(() => []),
    signal_types: varchar("signal_types", { length: 60 }).array().notNull().$defaultFn(() => []),
    min_severity: integer("min_severity").notNull().$defaultFn(() => 1),
    property_id: uuid("property_id"),
    owner_kind: varchar("owner_kind", { length: 20 }),
    owner_id: uuid("owner_id"),
    territory_id: uuid("territory_id"),
    property_types: varchar("property_types", { length: 40 }).array().notNull().$defaultFn(() => []),
    stacked_only: boolean("stacked_only").notNull().$defaultFn(() => false),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [
    index("ix_signal_subscriptions_deleted_at").on(t.deleted_at),
    index("ix_signal_subscriptions_subscriber_id").on(t.subscriber_id),
    index("ix_signal_subscriptions_property_id").on(t.property_id),
    index("ix_signal_subscriptions_is_active").on(t.is_active),
  ],
);
export type SignalSubscription = typeof signalSubscriptions.$inferSelect;
