import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { geometry, numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const VERIFICATION_STATUSES = ["unverified", "verified", "disputed"] as const;
export const VERIFICATION_METHODS = [
  "buyer", "seller", "broker", "recorded_deed", "public_record", "lease_document",
  "landlord", "tenant", "third_party_data", "appraisal", "other",
] as const;
export const TENANT_CREDIT = ["investment_grade", "national", "regional", "local", "none"] as const;
export const RECOVERY_TYPES = ["nnn", "modified_gross", "gross", "base_year", "absolute_net"] as const;
export const VALUATION_METHODS = ["direct_cap", "dcf", "sales_comparison", "land_residual", "appraisal", "bov"] as const;
export const ADJUSTMENT_FACTORS = ["location", "size", "age", "condition", "lease_term", "tenant_credit", "timing"] as const;
export const SALE_BASES = ["price_psf", "price_per_acre", "cap_rate", "price"] as const;
export const LEASE_BASES = ["effective_rent_psf", "base_rent_psf"] as const;

/** Shared location/verification columns for sale and lease comps (mixin in Python). */
const compLocation = () => ({
  name: varchar("name", { length: 200 }),
  address_line: varchar("address_line", { length: 255 }),
  city: varchar("city", { length: 120 }),
  state: varchar("state", { length: 40 }),
  county: varchar("county", { length: 120 }),
  corridor: varchar("corridor", { length: 160 }),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  property_type: varchar("property_type", { length: 40 }),
  tenant_name: varchar("tenant_name", { length: 200 }),
  tenant_organization_id: uuid("tenant_organization_id"),
  tenant_credit: varchar("tenant_credit", { length: 30 }),
  building_area_sf: numericFloat("building_area_sf", 14, 2),
  land_area_acres: numericFloat("land_area_acres", 12, 4),
  year_built: integer("year_built"),
  condition: varchar("condition", { length: 30 }),

  source: varchar("source", { length: 200 }),
  document_id: uuid("document_id"),
  verification_status: varchar("verification_status", { length: 20 }).notNull().$defaultFn(() => "unverified"),
  verification_method: varchar("verification_method", { length: 40 }),
  verification_notes: text("verification_notes"),
  verified_by_id: uuid("verified_by_id"),
  verified_at: tz("verified_at"),
  notes: text("notes"),
  tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
});

/** A verified-or-not sale transaction used as valuation evidence (spec module 13). */
export const saleComps = pgTable(
  "sale_comps",
  {
    ...entity(),
    ...compLocation(),
    property_id: fk("property_id", () => properties.id),
    location: geometry("location", "POINT", 4326),
    sale_date: date("sale_date", { mode: "string" }),
    sale_price: numericFloat("sale_price", 16, 2),
    price_psf: numericFloat("price_psf", 12, 2),
    price_per_acre: numericFloat("price_per_acre", 16, 2),
    cap_rate: doublePrecision("cap_rate"),
    noi: numericFloat("noi", 16, 2),
    buyer_name: varchar("buyer_name", { length: 200 }),
    buyer_organization_id: uuid("buyer_organization_id"),
    seller_name: varchar("seller_name", { length: 200 }),
    seller_organization_id: uuid("seller_organization_id"),
    financing: varchar("financing", { length: 200 }),
    lease_term_remaining_years: doublePrecision("lease_term_remaining_years"),
    occupancy_pct: doublePrecision("occupancy_pct"),
  },
  (t) => [
    index("ix_sale_comps_deleted_at").on(t.deleted_at),
    index("ix_sale_comps_city").on(t.city),
    index("ix_sale_comps_state").on(t.state),
    index("ix_sale_comps_county").on(t.county),
    index("ix_sale_comps_corridor").on(t.corridor),
    index("ix_sale_comps_property_type").on(t.property_type),
    index("ix_sale_comps_tenant_organization_id").on(t.tenant_organization_id),
    index("ix_sale_comps_tenant_credit").on(t.tenant_credit),
    index("ix_sale_comps_verification_status").on(t.verification_status),
    index("ix_sale_comps_property_id").on(t.property_id),
    index("idx_sale_comps_location").using("gist", t.location),
    index("ix_sale_comps_sale_date").on(t.sale_date),
  ],
);
export type SaleComp = typeof saleComps.$inferSelect;

export const leaseComps = pgTable(
  "lease_comps",
  {
    ...entity(),
    ...compLocation(),
    property_id: fk("property_id", () => properties.id),
    location: geometry("location", "POINT", 4326),
    space_id: uuid("space_id"),
    suite: varchar("suite", { length: 60 }),
    lease_type: varchar("lease_type", { length: 30 }), // new | renewal | expansion | sublease
    commencement_on: date("commencement_on", { mode: "string" }),
    term_months: integer("term_months"),
    area_sf: numericFloat("area_sf", 14, 2),
    base_rent_psf: numericFloat("base_rent_psf", 10, 2), // annual $/SF
    escalation_pct: doublePrecision("escalation_pct"),
    escalation_structure: varchar("escalation_structure", { length: 120 }),
    recovery_type: varchar("recovery_type", { length: 30 }),
    recoveries_psf: numericFloat("recoveries_psf", 10, 2),
    free_rent_months: doublePrecision("free_rent_months"),
    concessions: text("concessions"),
    ti_psf: numericFloat("ti_psf", 10, 2),
    effective_rent_psf: numericFloat("effective_rent_psf", 10, 2),
  },
  (t) => [
    index("ix_lease_comps_deleted_at").on(t.deleted_at),
    index("ix_lease_comps_city").on(t.city),
    index("ix_lease_comps_state").on(t.state),
    index("ix_lease_comps_county").on(t.county),
    index("ix_lease_comps_corridor").on(t.corridor),
    index("ix_lease_comps_property_type").on(t.property_type),
    index("ix_lease_comps_tenant_organization_id").on(t.tenant_organization_id),
    index("ix_lease_comps_tenant_credit").on(t.tenant_credit),
    index("ix_lease_comps_verification_status").on(t.verification_status),
    index("ix_lease_comps_property_id").on(t.property_id),
    index("idx_lease_comps_location").using("gist", t.location),
    index("ix_lease_comps_space_id").on(t.space_id),
    index("ix_lease_comps_commencement_on").on(t.commencement_on),
  ],
);
export type LeaseComp = typeof leaseComps.$inferSelect;

/** Comps selected for one subject property with a structured adjustment grid and indicated value range. */
export const compSets = pgTable(
  "comp_sets",
  {
    ...entity(),
    subject_property_id: fk("subject_property_id", () => properties.id),
    name: varchar("name", { length: 200 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(), // sale | lease
    purpose: varchar("purpose", { length: 30 }), // valuation | underwriting | bov | mark
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"), // draft | final
    value_basis: varchar("value_basis", { length: 30 }).notNull(),
    subject_quantity: doublePrecision("subject_quantity"), // SF, acres, NOI or 1 depending on basis
    subject_quantity_source: varchar("subject_quantity_source", { length: 200 }),
    criteria: jsonb("criteria").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    indicated: jsonb("indicated").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    notes: text("notes"),
    owner_id: fk("owner_id", () => users.id),
  },
  (t) => [
    index("ix_comp_sets_deleted_at").on(t.deleted_at),
    index("ix_comp_sets_subject_property_id").on(t.subject_property_id),
    index("ix_comp_sets_kind").on(t.kind),
    index("ix_comp_sets_status").on(t.status),
    index("ix_comp_sets_owner_id").on(t.owner_id),
  ],
);
export type CompSet = typeof compSets.$inferSelect;

export const compSetItems = pgTable(
  "comp_set_items",
  {
    ...entity(),
    comp_set_id: uuid("comp_set_id").notNull().references(() => compSets.id, { onDelete: "cascade" }),
    sale_comp_id: fk("sale_comp_id", () => saleComps.id),
    lease_comp_id: fk("lease_comp_id", () => leaseComps.id),
    included: boolean("included").notNull().$defaultFn(() => true),
    exclusion_reason: text("exclusion_reason"),
    decision_history: jsonb("decision_history").$type<Array<Record<string, any>>>().notNull().$defaultFn(() => []), // [{included, reason, by, by_name, at}]
    adjustments: jsonb("adjustments").$type<Record<string, number>>().notNull().$defaultFn(() => ({})), // factor -> percent
    adjustment_notes: jsonb("adjustment_notes").$type<Record<string, string>>().notNull().$defaultFn(() => ({})), // factor -> rationale
    weight: doublePrecision("weight").notNull().$defaultFn(() => 1.0),
    base_metric: doublePrecision("base_metric"),
    net_adjustment_pct: doublePrecision("net_adjustment_pct"),
    adjusted_metric: doublePrecision("adjusted_metric"),
    adjusted_value: doublePrecision("adjusted_value"),
    distance_miles: doublePrecision("distance_miles"),
    sort_order: integer("sort_order").notNull().$defaultFn(() => 0),
  },
  (t) => [
    index("ix_comp_set_items_deleted_at").on(t.deleted_at),
    index("ix_comp_set_items_comp_set_id").on(t.comp_set_id),
    index("ix_comp_set_items_sale_comp_id").on(t.sale_comp_id),
    index("ix_comp_set_items_lease_comp_id").on(t.lease_comp_id),
    index("ix_comp_set_items_included").on(t.included),
  ],
);
export type CompSetItem = typeof compSetItems.$inferSelect;

/** A dated value conclusion. Never updated in place: marks and valuations are historical records. */
export const valuations = pgTable(
  "valuations",
  {
    ...entity(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "set null" }),
    method: varchar("method", { length: 30 }).notNull(),
    value_low: numericFloat("value_low", 16, 2),
    value_high: numericFloat("value_high", 16, 2),
    value_point: numericFloat("value_point", 16, 2),
    as_of: date("as_of", { mode: "string" }).notNull(),
    analyst_id: fk("analyst_id", () => users.id),
    comp_set_id: fk("comp_set_id", () => compSets.id),
    uw_model_id: uuid("uw_model_id"),
    is_mark: boolean("is_mark").notNull().$defaultFn(() => false),
    inputs: jsonb("inputs").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    assumptions: jsonb("assumptions").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // key -> {value, source, comp_ids, document_id}
    unsourced: jsonb("unsourced").$type<any[]>().notNull().$defaultFn(() => []),
    calculation: jsonb("calculation").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    document_id: uuid("document_id"),
    third_party: varchar("third_party", { length: 200 }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_valuations_deleted_at").on(t.deleted_at),
    index("ix_valuations_property_id").on(t.property_id),
    index("ix_valuations_method").on(t.method),
    index("ix_valuations_as_of").on(t.as_of),
    index("ix_valuations_analyst_id").on(t.analyst_id),
    index("ix_valuations_comp_set_id").on(t.comp_set_id),
    index("ix_valuations_uw_model_id").on(t.uw_model_id),
    index("ix_valuations_is_mark").on(t.is_mark),
    index("ix_valuations_document_id").on(t.document_id),
  ],
);
export type Valuation = typeof valuations.$inferSelect;

/** Third-party appraisal / BOV document linkage (document ids from the documents module). */
export const valuationDocuments = pgTable(
  "valuation_documents",
  {
    ...entity(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "set null" }),
    valuation_id: fk("valuation_id", () => valuations.id),
    document_id: uuid("document_id").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(), // appraisal | bov | other
    label: varchar("label", { length: 200 }),
    prepared_by: varchar("prepared_by", { length: 200 }),
    effective_date: date("effective_date", { mode: "string" }),
    value_conclusion: numericFloat("value_conclusion", 16, 2),
  },
  (t) => [
    index("ix_valuation_documents_deleted_at").on(t.deleted_at),
    index("ix_valuation_documents_property_id").on(t.property_id),
    index("ix_valuation_documents_valuation_id").on(t.valuation_id),
    index("ix_valuation_documents_document_id").on(t.document_id),
  ],
);
export type ValuationDocument = typeof valuationDocuments.$inferSelect;

/** Broker Opinion of Value generated from a comp set and its adjustment grid. */
export const bovs = pgTable(
  "bovs",
  {
    ...entity(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "set null" }),
    comp_set_id: uuid("comp_set_id").notNull().references(() => compSets.id, { onDelete: "set null" }),
    valuation_id: fk("valuation_id", () => valuations.id),
    title: varchar("title", { length: 200 }).notNull(),
    prepared_for: varchar("prepared_for", { length: 200 }),
    prepared_by_id: fk("prepared_by_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"), // draft | final | delivered
    value_low: numericFloat("value_low", 16, 2),
    value_high: numericFloat("value_high", 16, 2),
    value_point: numericFloat("value_point", 16, 2),
    recommended_list_price: numericFloat("recommended_list_price", 16, 2),
    narrative: text("narrative"),
    payload: jsonb("payload").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    generated_at: tz("generated_at"),
    document_id: uuid("document_id"),
  },
  (t) => [
    index("ix_bovs_deleted_at").on(t.deleted_at),
    index("ix_bovs_property_id").on(t.property_id),
    index("ix_bovs_comp_set_id").on(t.comp_set_id),
    index("ix_bovs_valuation_id").on(t.valuation_id),
    index("ix_bovs_prepared_by_id").on(t.prepared_by_id),
    index("ix_bovs_status").on(t.status),
  ],
);
export type Bov = typeof bovs.$inferSelect;
