import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
} from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { organizations, people } from "../contacts/schema";
import { properties } from "../properties/schema";
import { spaces } from "../parcels/schema";

export const LEASE_STATUSES = ["draft", "active", "expired", "terminated"] as const;
export const LEASE_TYPES = ["nnn", "absolute_nnn", "modified_gross", "gross", "ground", "percentage"] as const;
export const ESCALATION_METHODS = ["flat", "fixed_pct", "fixed_amount", "cpi", "step_table"] as const;
export const RECOVERY_METHODS = ["nnn", "modified_gross", "base_year", "expense_stop", "fixed_cam"] as const;
export const RECOVERY_CATEGORIES = ["all", "cam", "tax", "insurance", "utilities"] as const;
export const CAP_TYPES = ["none", "cumulative", "non_cumulative"] as const;
export const OPTION_TYPES = ["renewal", "expansion", "termination", "purchase", "rofr", "rofo"] as const;
export const OPTION_STATUSES = ["open", "exercised", "waived", "expired"] as const;
export const PRICING_METHODS = [
  "fixed_rent", "fixed_increase", "fmv", "pct_of_fmv", "fixed_price", "fee", "matching", "none",
] as const;
export const CLAUSE_CATEGORIES = [
  "use", "exclusive", "cotenancy", "kickout", "assignment", "subletting", "maintenance", "replacement",
  "insurance", "holdover", "default", "remedies", "estoppel", "certificate", "reporting", "landlord_obligation",
  "radius", "relocation", "sna", "other",
] as const;
// Clause categories that carry a deliverable date and feed the critical-date engine once verified.
export const OBLIGATION_CATEGORIES = new Set(["estoppel", "certificate", "reporting", "landlord_obligation", "insurance"]);
export const AMENDMENT_KINDS = [
  "amendment", "assignment", "guaranty", "side_letter", "renewal", "commencement_letter", "other",
] as const;
export const GUARANTY_TYPES = ["full", "limited", "good_guy", "burn_down", "corporate", "personal"] as const;
export const RECON_STATUSES = ["draft", "final", "billed"] as const;

// Abstracted lease terms whose changes are historical facts (source, date, confidence, verification).
export const MATERIAL_FIELDS = new Set([
  "tenant_name", "tenant_organization_id", "space_id", "lease_type", "commencement_on", "expiration_on",
  "rentable_sf", "base_rent_annual", "pro_rata_share", "security_deposit", "status",
  "late_fee_grace_days", "late_fee_pct", "late_fee_flat",
]);
// Terms an amendment / assignment / side letter may override as of its effective date.
export const OVERRIDABLE_FIELDS = new Set([
  "tenant_name", "tenant_organization_id", "space_id", "lease_type", "commencement_on", "expiration_on",
  "rentable_sf", "base_rent_annual", "pro_rata_share", "security_deposit", "landlord_name", "premises_description",
  "late_fee_grace_days", "late_fee_pct", "late_fee_flat", "status",
]);

/** Clause-level source citation columns: the document, page and clause a term was abstracted from. */
const citation = () => ({
  document_id: uuid("document_id"),
  page: integer("page"),
  clause_ref: varchar("clause_ref", { length: 80 }),
  quoted_text: text("quoted_text"),
});

/** AI-extracted terms stay unverified until a named human verifies them. */
const verifiable = () => ({
  verified: boolean("verified").notNull().$defaultFn(() => false),
  ai_extracted: boolean("ai_extracted").notNull().$defaultFn(() => false),
  confidence: doublePrecision("confidence"),
  verified_at: tz("verified_at"),
  verified_by_id: uuid("verified_by_id").references(() => users.id, { onDelete: "set null" }),
});

export const leases = pgTable(
  "leases",
  {
    ...entity(),
    ...verifiable(),

    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    space_id: fk("space_id", () => spaces.id),
    // Plain references: assets and documents are owned by other modules.
    asset_id: uuid("asset_id"),
    document_id: uuid("document_id"),
    tenant_organization_id: fk("tenant_organization_id", () => organizations.id),
    tenant_name: varchar("tenant_name", { length: 200 }).notNull(),
    landlord_name: varchar("landlord_name", { length: 200 }),
    premises_description: text("premises_description"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    lease_type: varchar("lease_type", { length: 30 }).notNull().$defaultFn(() => "nnn"),
    execution_on: date("execution_on", { mode: "string" }),
    commencement_on: date("commencement_on", { mode: "string" }),
    rent_commencement_on: date("rent_commencement_on", { mode: "string" }),
    expiration_on: date("expiration_on", { mode: "string" }),
    rentable_sf: numericFloat("rentable_sf", 14, 2),
    pro_rata_share: doublePrecision("pro_rata_share"), // percent 0-100
    base_rent_annual: numericFloat("base_rent_annual", 16, 2),
    security_deposit: numericFloat("security_deposit", 16, 2),
    // Stored escalation parameters used by the rent-step generator.
    escalation: jsonb("escalation").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    // Late-fee terms (null -> receivables defaults).
    late_fee_grace_days: integer("late_fee_grace_days"),
    late_fee_pct: doublePrecision("late_fee_pct"),
    late_fee_flat: numericFloat("late_fee_flat", 16, 2),
    // Rollover / valuation assumptions.
    market_rent_psf: numericFloat("market_rent_psf", 12, 2),
    renewal_probability: doublePrecision("renewal_probability"), // 0-1
    downtime_months: integer("downtime_months"),
    releasing_cost_psf: numericFloat("releasing_cost_psf", 12, 2),
    // Field-level citations {field: {document_id, page, clause_ref, quoted_text}}.
    citations: jsonb("citations").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    manager_id: fk("manager_id", () => users.id),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_leases_deleted_at").on(t.deleted_at),
    index("ix_leases_verified").on(t.verified),
    index("ix_leases_property_id").on(t.property_id),
    index("ix_leases_space_id").on(t.space_id),
    index("ix_leases_asset_id").on(t.asset_id),
    index("ix_leases_document_id").on(t.document_id),
    index("ix_leases_tenant_organization_id").on(t.tenant_organization_id),
    index("ix_leases_tenant_name").on(t.tenant_name),
    index("ix_leases_status").on(t.status),
    index("ix_leases_lease_type").on(t.lease_type),
    index("ix_leases_commencement_on").on(t.commencement_on),
    index("ix_leases_expiration_on").on(t.expiration_on),
    index("ix_leases_manager_id").on(t.manager_id),
  ],
);

/** Amendment / assignment / guaranty / side-letter chain. Overrides apply from effective_on; nothing is deleted. */
export const leaseAmendments = pgTable(
  "lease_amendments",
  {
    ...entity(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 30 }).notNull().$defaultFn(() => "amendment"),
    sequence: integer("sequence").notNull().$defaultFn(() => 1),
    title: varchar("title", { length: 200 }).notNull(),
    executed_on: date("executed_on", { mode: "string" }),
    effective_on: date("effective_on", { mode: "string" }).notNull(),
    document_id: uuid("document_id"),
    page: integer("page"),
    clause_ref: varchar("clause_ref", { length: 80 }),
    overrides: jsonb("overrides").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    summary: text("summary"),
    verified: boolean("verified").notNull().$defaultFn(() => false),
    verified_by_id: fk("verified_by_id", () => users.id),
    verified_at: tz("verified_at"),
  },
  (t) => [
    index("ix_lease_amendments_deleted_at").on(t.deleted_at),
    index("ix_lease_amendments_lease_id").on(t.lease_id),
    index("ix_lease_amendments_effective_on").on(t.effective_on),
  ],
);

export const rentSteps = pgTable(
  "rent_steps",
  {
    ...entity(),
    ...citation(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    amendment_id: fk("amendment_id", () => leaseAmendments.id),
    start_on: date("start_on", { mode: "string" }).notNull(),
    end_on: date("end_on", { mode: "string" }).notNull(),
    annual_rent: numericFloat("annual_rent", 16, 2).notNull(),
    monthly_rent: numericFloat("monthly_rent", 16, 2).notNull(),
    rent_psf: numericFloat("rent_psf", 12, 4),
    charge_type: varchar("charge_type", { length: 30 }).notNull().$defaultFn(() => "base_rent"),
    source: varchar("source", { length: 20 }).notNull().$defaultFn(() => "manual"), // manual | generated | amendment
    note: varchar("note", { length: 300 }),
  },
  (t) => [
    index("ix_rent_steps_deleted_at").on(t.deleted_at),
    index("ix_rent_steps_document_id").on(t.document_id),
    index("ix_rent_steps_lease_id").on(t.lease_id),
    index("ix_rent_steps_amendment_id").on(t.amendment_id),
    index("ix_rent_steps_start_on").on(t.start_on),
  ],
);

export const leaseRecoveries = pgTable(
  "lease_recoveries",
  {
    ...entity(),
    ...citation(),
    ...verifiable(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    method: varchar("method", { length: 30 }).notNull().$defaultFn(() => "nnn"),
    category: varchar("category", { length: 20 }).notNull().$defaultFn(() => "all"),
    pro_rata_share: doublePrecision("pro_rata_share"), // percent; null -> lease share or SF ratio
    base_year: integer("base_year"),
    base_amount: numericFloat("base_amount", 16, 2), // base-year / stop pool total
    expense_stop_psf: numericFloat("expense_stop_psf", 12, 4),
    fixed_amount_annual: numericFloat("fixed_amount_annual", 16, 2),
    estimated_monthly: numericFloat("estimated_monthly", 16, 2),
    cap_type: varchar("cap_type", { length: 20 }).notNull().$defaultFn(() => "none"),
    cap_pct: doublePrecision("cap_pct"),
    cap_base_amount: numericFloat("cap_base_amount", 16, 2),
    cap_base_year: integer("cap_base_year"),
    admin_fee_pct: doublePrecision("admin_fee_pct"),
    gross_up_pct: doublePrecision("gross_up_pct"),
    exclusions: varchar("exclusions", { length: 80 }).array().notNull().$defaultFn(() => []),
    notes: text("notes"),
  },
  (t) => [
    index("ix_lease_recoveries_deleted_at").on(t.deleted_at),
    index("ix_lease_recoveries_document_id").on(t.document_id),
    index("ix_lease_recoveries_verified").on(t.verified),
    index("ix_lease_recoveries_lease_id").on(t.lease_id),
  ],
);

export const leaseOptions = pgTable(
  "lease_options",
  {
    ...entity(),
    ...citation(),
    ...verifiable(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    option_type: varchar("option_type", { length: 20 }).notNull(),
    sequence: integer("sequence").notNull().$defaultFn(() => 1),
    term_months: integer("term_months"),
    notice_start_on: date("notice_start_on", { mode: "string" }),
    notice_end_on: date("notice_end_on", { mode: "string" }),
    effective_on: date("effective_on", { mode: "string" }),
    pricing_method: varchar("pricing_method", { length: 20 }).notNull().$defaultFn(() => "none"),
    pricing_params: jsonb("pricing_params").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    option_rent_psf: numericFloat("option_rent_psf", 12, 2),
    increase_pct: doublePrecision("increase_pct"),
    fmv_pct: doublePrecision("fmv_pct"),
    fee_amount: numericFloat("fee_amount", 16, 2),
    purchase_price: numericFloat("purchase_price", 16, 2),
    market_rent_psf: numericFloat("market_rent_psf", 12, 2),
    space_description: varchar("space_description", { length: 300 }),
    conditions: text("conditions"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    exercised_on: date("exercised_on", { mode: "string" }),
  },
  (t) => [
    index("ix_lease_options_deleted_at").on(t.deleted_at),
    index("ix_lease_options_document_id").on(t.document_id),
    index("ix_lease_options_verified").on(t.verified),
    index("ix_lease_options_lease_id").on(t.lease_id),
    index("ix_lease_options_option_type").on(t.option_type),
    index("ix_lease_options_notice_end_on").on(t.notice_end_on),
    index("ix_lease_options_status").on(t.status),
  ],
);

/** Structured clause (use, exclusive, cotenancy, assignment, maintenance, holdover...) with its citation. */
export const leaseClauses = pgTable(
  "lease_clauses",
  {
    ...entity(),
    ...citation(),
    ...verifiable(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    amendment_id: fk("amendment_id", () => leaseAmendments.id),
    category: varchar("category", { length: 30 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    summary: text("summary"),
    terms: jsonb("terms").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    obligated_party: varchar("obligated_party", { length: 20 }), // landlord | tenant | guarantor
    due_on: date("due_on", { mode: "string" }),
    recurrence: varchar("recurrence", { length: 20 }), // once | monthly | quarterly | annual
    response_days: integer("response_days"),
  },
  (t) => [
    index("ix_lease_clauses_deleted_at").on(t.deleted_at),
    index("ix_lease_clauses_document_id").on(t.document_id),
    index("ix_lease_clauses_verified").on(t.verified),
    index("ix_lease_clauses_lease_id").on(t.lease_id),
    index("ix_lease_clauses_amendment_id").on(t.amendment_id),
    index("ix_lease_clauses_category").on(t.category),
  ],
);

export const guaranties = pgTable(
  "guaranties",
  {
    ...entity(),
    ...citation(),
    ...verifiable(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    guarantor_name: varchar("guarantor_name", { length: 200 }).notNull(),
    guarantor_organization_id: fk("guarantor_organization_id", () => organizations.id),
    guarantor_person_id: fk("guarantor_person_id", () => people.id),
    guaranty_type: varchar("guaranty_type", { length: 20 }).notNull().$defaultFn(() => "full"),
    cap_amount: numericFloat("cap_amount", 16, 2),
    effective_on: date("effective_on", { mode: "string" }),
    expires_on: date("expires_on", { mode: "string" }),
    burn_down: jsonb("burn_down").$type<any[]>().notNull().$defaultFn(() => []), // [{on, cap_amount}]
    financials_required: boolean("financials_required").notNull().$defaultFn(() => false),
    financials_due_on: date("financials_due_on", { mode: "string" }),
    estoppel_days: integer("estoppel_days"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_guaranties_deleted_at").on(t.deleted_at),
    index("ix_guaranties_document_id").on(t.document_id),
    index("ix_guaranties_verified").on(t.verified),
    index("ix_guaranties_lease_id").on(t.lease_id),
    index("ix_guaranties_guarantor_organization_id").on(t.guarantor_organization_id),
    index("ix_guaranties_guarantor_person_id").on(t.guarantor_person_id),
  ],
);

/** Annual recovery reconciliation for one lease: recoverable pool -> tenant share (caps applied) -> true-up. */
export const recoveryReconciliations = pgTable(
  "recovery_reconciliations",
  {
    ...entity(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    budgeted_pool: jsonb("budgeted_pool").$type<Record<string, number>>().notNull().$defaultFn(() => ({})),
    actual_pool: jsonb("actual_pool").$type<Record<string, number>>().notNull().$defaultFn(() => ({})),
    share_pct: doublePrecision("share_pct"),
    budgeted_share: numericFloat("budgeted_share", 16, 2).notNull().$defaultFn(() => 0),
    actual_share: numericFloat("actual_share", 16, 2).notNull().$defaultFn(() => 0),
    cap_reduction: numericFloat("cap_reduction", 16, 2).notNull().$defaultFn(() => 0),
    estimates_billed: numericFloat("estimates_billed", 16, 2).notNull().$defaultFn(() => 0),
    true_up_amount: numericFloat("true_up_amount", 16, 2).notNull().$defaultFn(() => 0),
    details: jsonb("details").$type<any[]>().notNull().$defaultFn(() => []),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    finalized_by_id: fk("finalized_by_id", () => users.id),
    finalized_at: tz("finalized_at"),
    billed_charge_id: uuid("billed_charge_id"),
  },
  (t) => [
    unique("uq_recon_lease_year").on(t.lease_id, t.year),
    index("ix_recovery_reconciliations_deleted_at").on(t.deleted_at),
    index("ix_recovery_reconciliations_lease_id").on(t.lease_id),
    index("ix_recovery_reconciliations_property_id").on(t.property_id),
    index("ix_recovery_reconciliations_year").on(t.year),
    index("ix_recovery_reconciliations_status").on(t.status),
  ],
);

export type Lease = typeof leases.$inferSelect;
export type RentStep = typeof rentSteps.$inferSelect;
export type LeaseRecovery = typeof leaseRecoveries.$inferSelect;
export type LeaseOption = typeof leaseOptions.$inferSelect;
export type LeaseClause = typeof leaseClauses.$inferSelect;
export type LeaseAmendment = typeof leaseAmendments.$inferSelect;
export type Guaranty = typeof guaranties.$inferSelect;
export type RecoveryReconciliation = typeof recoveryReconciliations.$inferSelect;
