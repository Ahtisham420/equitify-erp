import {
  type AnyPgColumn, boolean, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar, date,
} from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { organizations } from "../contacts/schema";
import { parcels } from "../parcels/schema";
import { properties } from "../properties/schema";

export const VENDOR_STATUSES = ["active", "pending", "inactive", "suspended"];
export const CREDENTIAL_KINDS = ["license", "insurance_coi", "w9", "other"];
export const CREDENTIAL_STATUSES = ["valid", "expiring", "expired", "pending", "rejected"];
export const PROJECT_STATUSES = [
  "draft", "pending_approval", "approved", "bidding", "awarded", "in_progress", "completed", "closed", "cancelled",
];
export const BID_STATUSES = ["submitted", "shortlisted", "awarded", "rejected", "withdrawn"];
export const DRAW_STATUSES = ["requested", "approved", "paid", "rejected"];
export const CHANGE_ORDER_STATUSES = ["pending", "approved", "rejected"];
export const COVERAGE_TYPES = [
  "property", "general_liability", "umbrella", "flood", "earthquake", "wind", "builders_risk", "environmental",
  "terrorism", "workers_comp", "auto", "other",
];
export const POLICY_STATUSES = ["active", "pending_renewal", "expired", "cancelled"];
export const CERTIFICATE_STATUSES = ["requested", "compliant", "deficient", "expired"];
export const CLAIM_STATUSES = ["reported", "open", "under_review", "approved", "denied", "paid", "closed"];
export const PROTEST_STATUSES = [
  "considering", "filed", "evidence_submitted", "hearing_scheduled", "settled", "won", "lost", "withdrawn",
];
export const PAYMENT_STATUSES = ["scheduled", "paid", "confirmed", "late"];
export const BUDGET_STATUSES = ["draft", "submitted", "approved", "superseded"];
export const BUDGET_CATEGORIES = ["income", "expense", "capex"];

/** NOT NULL foreign key (the shared `fk()` helper types its notNull result as a union with the nullable column). */
const fkNN = (column: string, ref: () => AnyPgColumn, onDelete: "cascade" | "restrict" = "restrict") =>
  uuid(column).references(ref, { onDelete }).notNull();

const money = (name: string) => numericFloat(name, 16, 2);

// ======================================================================= vendors

export const vendors = pgTable(
  "vendors",
  {
    ...entity(),
    organization_id: fk("organization_id", () => organizations.id),
    name: varchar("name", { length: 200 }).notNull(),
    services: varchar("services", { length: 60 }).array().notNull().$defaultFn(() => []),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    primary_contact_name: varchar("primary_contact_name", { length: 200 }),
    email: varchar("email", { length: 200 }),
    phone: varchar("phone", { length: 60 }),
    address: varchar("address", { length: 300 }),
    contacts: jsonb("contacts").$type<any[]>().notNull().$defaultFn(() => []), // [{name, role, email, phone}]
    rates: jsonb("rates").$type<any[]>().notNull().$defaultFn(() => []), // [{service, unit, rate, notes}]
    contracts: jsonb("contracts").$type<any[]>().notNull().$defaultFn(() => []), // [{title, start_on, end_on, value, document_id}]
    service_area: varchar("service_area", { length: 200 }),
    requires_insurance: boolean("requires_insurance").notNull().$defaultFn(() => true),
    requires_license: boolean("requires_license").notNull().$defaultFn(() => false),
    performance_rating: doublePrecision("performance_rating"), // manual 1-5 review score
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_vendors_organization_id").on(t.organization_id),
    index("ix_vendors_name").on(t.name),
    index("ix_vendors_status").on(t.status),
  ],
);
export type Vendor = typeof vendors.$inferSelect;

export const vendorCredentials = pgTable(
  "vendor_credentials",
  {
    ...entity(),
    vendor_id: fkNN("vendor_id", () => vendors.id, "cascade"),
    kind: varchar("kind", { length: 20 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    number: varchar("number", { length: 120 }),
    issuer: varchar("issuer", { length: 200 }),
    coverage_amount: money("coverage_amount"),
    effective_on: date("effective_on", { mode: "string" }),
    expires_on: date("expires_on", { mode: "string" }),
    is_required: boolean("is_required").notNull().$defaultFn(() => true),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "valid"),
    document_id: uuid("document_id"),
    verified_by_id: fk("verified_by_id", () => users.id),
    verified_at: tz("verified_at"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_vendor_credentials_vendor_id").on(t.vendor_id),
    index("ix_vendor_credentials_kind").on(t.kind),
    index("ix_vendor_credentials_expires_on").on(t.expires_on),
    index("ix_vendor_credentials_status").on(t.status),
  ],
);
export type VendorCredential = typeof vendorCredentials.$inferSelect;

/** Performance review history; the vendor's rating is the mean of reviews. */
export const vendorReviews = pgTable(
  "vendor_reviews",
  {
    ...entity(),
    vendor_id: fkNN("vendor_id", () => vendors.id, "cascade"),
    rating: integer("rating").notNull(),
    quality: integer("quality"),
    timeliness: integer("timeliness"),
    communication: integer("communication"),
    comment: text("comment"),
    work_order_id: uuid("work_order_id"),
    project_id: uuid("project_id"),
  },
  (t) => [index("ix_vendor_reviews_vendor_id").on(t.vendor_id)],
);
export type VendorReview = typeof vendorReviews.$inferSelect;

// ======================================================================= capital projects

export const capitalProjects = pgTable(
  "capital_projects",
  {
    ...entity(),
    property_id: fkNN("property_id", () => properties.id, "cascade"),
    asset_id: uuid("asset_id"),
    name: varchar("name", { length: 200 }).notNull(),
    category: varchar("category", { length: 40 }).notNull().$defaultFn(() => "other"),
    scope: text("scope"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    manager_id: fk("manager_id", () => users.id),
    original_budget: money("original_budget").notNull().$defaultFn(() => 0),
    current_budget: money("current_budget").notNull().$defaultFn(() => 0),
    contingency: money("contingency"),
    budget_approved_by_id: fk("budget_approved_by_id", () => users.id),
    budget_approved_at: tz("budget_approved_at"),
    contractor_vendor_id: fk("contractor_vendor_id", () => vendors.id),
    awarded_bid_id: uuid("awarded_bid_id"),
    contract_amount: money("contract_amount"),
    start_on: date("start_on", { mode: "string" }),
    target_completion_on: date("target_completion_on", { mode: "string" }),
    actual_completion_on: date("actual_completion_on", { mode: "string" }),
    milestones: jsonb("milestones").$type<any[]>().notNull().$defaultFn(() => []), // [{key, label, due_on, completed_on}]
    warranty_expires_on: date("warranty_expires_on", { mode: "string" }),
    warranty_terms: text("warranty_terms"),
    useful_life_years: integer("useful_life_years"),
    recoverability: jsonb("recoverability").$type<Record<string, any> | null>(),
    recoverability_analyzed_at: tz("recoverability_analyzed_at"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_capital_projects_property_id").on(t.property_id),
    index("ix_capital_projects_asset_id").on(t.asset_id),
    index("ix_capital_projects_status").on(t.status),
    index("ix_capital_projects_manager_id").on(t.manager_id),
    index("ix_capital_projects_contractor_vendor_id").on(t.contractor_vendor_id),
    index("ix_capital_projects_target_completion_on").on(t.target_completion_on),
  ],
);
export type CapitalProject = typeof capitalProjects.$inferSelect;

/** Append-only budget history: original, approved change orders and revisions. */
export const projectBudgetEntries = pgTable(
  "project_budget_entries",
  {
    ...entity(),
    project_id: fkNN("project_id", () => capitalProjects.id, "cascade"),
    kind: varchar("kind", { length: 20 }).notNull(), // original | change_order | revision
    amount_before: money("amount_before").notNull(),
    amount_after: money("amount_after").notNull(),
    delta: money("delta").notNull(),
    reason: text("reason"),
    change_order_id: uuid("change_order_id"),
    recorded_at: tz("recorded_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("ix_project_budget_entries_project_id").on(t.project_id)],
);
export type ProjectBudgetEntry = typeof projectBudgetEntries.$inferSelect;

export const projectApprovals = pgTable(
  "project_approvals",
  {
    ...entity(),
    project_id: fkNN("project_id", () => capitalProjects.id, "cascade"),
    stage: varchar("stage", { length: 20 }).notNull(), // budget | award | change_order | draw | completion
    decision: varchar("decision", { length: 10 }).notNull(), // approved | rejected
    amount: money("amount"),
    reference_id: uuid("reference_id"),
    note: text("note"),
    decided_by_id: fk("decided_by_id", () => users.id),
    decided_at: tz("decided_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("ix_project_approvals_project_id").on(t.project_id)],
);
export type ProjectApproval = typeof projectApprovals.$inferSelect;

export const projectBids = pgTable(
  "project_bids",
  {
    ...entity(),
    project_id: fkNN("project_id", () => capitalProjects.id, "cascade"),
    vendor_id: fkNN("vendor_id", () => vendors.id),
    amount: money("amount").notNull(),
    submitted_on: date("submitted_on", { mode: "string" }),
    valid_until: date("valid_until", { mode: "string" }),
    duration_days: integer("duration_days"),
    scope_notes: text("scope_notes"),
    document_id: uuid("document_id"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "submitted"),
    decision_note: text("decision_note"),
  },
  (t) => [
    index("ix_project_bids_project_id").on(t.project_id),
    index("ix_project_bids_vendor_id").on(t.vendor_id),
    index("ix_project_bids_status").on(t.status),
  ],
);
export type ProjectBid = typeof projectBids.$inferSelect;

export const projectDraws = pgTable(
  "project_draws",
  {
    ...entity(),
    project_id: fkNN("project_id", () => capitalProjects.id, "cascade"),
    number: integer("number").notNull(),
    amount: money("amount").notNull(),
    requested_on: date("requested_on", { mode: "string" }).notNull(),
    period_end_on: date("period_end_on", { mode: "string" }),
    percent_complete: doublePrecision("percent_complete"),
    retainage: money("retainage"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "requested"),
    lien_waiver_document_id: uuid("lien_waiver_document_id"),
    lien_waiver_type: varchar("lien_waiver_type", { length: 20 }), // conditional | unconditional
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    paid_on: date("paid_on", { mode: "string" }),
    payment_reference: varchar("payment_reference", { length: 120 }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_project_draws_project_id").on(t.project_id),
    index("ix_project_draws_status").on(t.status),
  ],
);
export type ProjectDraw = typeof projectDraws.$inferSelect;

export const changeOrders = pgTable(
  "change_orders",
  {
    ...entity(),
    project_id: fkNN("project_id", () => capitalProjects.id, "cascade"),
    number: integer("number").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    reason: varchar("reason", { length: 40 }), // owner_request | unforeseen | design | code | other
    amount: money("amount").notNull(),
    days_impact: integer("days_impact"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "pending"),
    document_id: uuid("document_id"),
    decided_by_id: fk("decided_by_id", () => users.id),
    decided_at: tz("decided_at"),
    decision_note: text("decision_note"),
  },
  (t) => [
    index("ix_change_orders_project_id").on(t.project_id),
    index("ix_change_orders_status").on(t.status),
  ],
);
export type ChangeOrder = typeof changeOrders.$inferSelect;

// ======================================================================= insurance

export const insurancePolicies = pgTable(
  "insurance_policies",
  {
    ...entity(),
    property_id: fk("property_id", () => properties.id),
    asset_id: uuid("asset_id"),
    policy_number: varchar("policy_number", { length: 120 }).notNull(),
    coverage_type: varchar("coverage_type", { length: 30 }).notNull(),
    carrier: varchar("carrier", { length: 200 }).notNull(),
    broker: varchar("broker", { length: 200 }),
    named_insured: varchar("named_insured", { length: 200 }),
    limit_amount: money("limit_amount"),
    aggregate_limit: money("aggregate_limit"),
    deductible: money("deductible"),
    premium: money("premium"),
    effective_on: date("effective_on", { mode: "string" }).notNull(),
    expires_on: date("expires_on", { mode: "string" }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    document_id: uuid("document_id"),
    renewal_of_id: uuid("renewal_of_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_insurance_policies_property_id").on(t.property_id),
    index("ix_insurance_policies_asset_id").on(t.asset_id),
    index("ix_insurance_policies_coverage_type").on(t.coverage_type),
    index("ix_insurance_policies_expires_on").on(t.expires_on),
    index("ix_insurance_policies_status").on(t.status),
  ],
);
export type InsurancePolicy = typeof insurancePolicies.$inferSelect;

export const insuranceCertificates = pgTable(
  "insurance_certificates",
  {
    ...entity(),
    holder_kind: varchar("holder_kind", { length: 10 }).notNull(), // tenant | vendor
    vendor_id: fk("vendor_id", () => vendors.id),
    tenant_organization_id: fk("tenant_organization_id", () => organizations.id),
    tenant_name: varchar("tenant_name", { length: 200 }),
    lease_id: uuid("lease_id"),
    property_id: fk("property_id", () => properties.id),
    coverage_type: varchar("coverage_type", { length: 30 }).notNull().$defaultFn(() => "general_liability"),
    carrier: varchar("carrier", { length: 200 }),
    policy_number: varchar("policy_number", { length: 120 }),
    limit_amount: money("limit_amount"),
    required_limit: money("required_limit"),
    additional_insured: boolean("additional_insured").notNull().$defaultFn(() => false),
    additional_insured_required: boolean("additional_insured_required").notNull().$defaultFn(() => true),
    effective_on: date("effective_on", { mode: "string" }),
    expires_on: date("expires_on", { mode: "string" }),
    received_on: date("received_on", { mode: "string" }),
    requested_on: date("requested_on", { mode: "string" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "requested"),
    deficiencies: jsonb("deficiencies").$type<any[]>().notNull().$defaultFn(() => []),
    document_id: uuid("document_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_insurance_certificates_holder_kind").on(t.holder_kind),
    index("ix_insurance_certificates_vendor_id").on(t.vendor_id),
    index("ix_insurance_certificates_tenant_organization_id").on(t.tenant_organization_id),
    index("ix_insurance_certificates_lease_id").on(t.lease_id),
    index("ix_insurance_certificates_property_id").on(t.property_id),
    index("ix_insurance_certificates_expires_on").on(t.expires_on),
    index("ix_insurance_certificates_status").on(t.status),
  ],
);
export type InsuranceCertificate = typeof insuranceCertificates.$inferSelect;

export const insuranceClaims = pgTable(
  "insurance_claims",
  {
    ...entity(),
    policy_id: fk("policy_id", () => insurancePolicies.id),
    property_id: fk("property_id", () => properties.id),
    claim_number: varchar("claim_number", { length: 120 }),
    incident_on: date("incident_on", { mode: "string" }).notNull(),
    reported_on: date("reported_on", { mode: "string" }),
    cause: varchar("cause", { length: 60 }),
    description: text("description"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "reported"),
    status_history: jsonb("status_history").$type<any[]>().notNull().$defaultFn(() => []),
    claimed_amount: money("claimed_amount"),
    reserve_amount: money("reserve_amount"),
    paid_amount: money("paid_amount"),
    deductible_applied: money("deductible_applied"),
    adjuster_name: varchar("adjuster_name", { length: 200 }),
    adjuster_contact: varchar("adjuster_contact", { length: 200 }),
    work_order_id: uuid("work_order_id"),
    closed_on: date("closed_on", { mode: "string" }),
  },
  (t) => [
    index("ix_insurance_claims_policy_id").on(t.policy_id),
    index("ix_insurance_claims_property_id").on(t.property_id),
    index("ix_insurance_claims_status").on(t.status),
  ],
);
export type InsuranceClaim = typeof insuranceClaims.$inferSelect;

// ======================================================================= property tax

export const taxAssessments = pgTable(
  "tax_assessments",
  {
    ...entity(),
    property_id: fkNN("property_id", () => properties.id, "cascade"),
    parcel_id: fk("parcel_id", () => parcels.id),
    tax_year: integer("tax_year").notNull(),
    jurisdiction: varchar("jurisdiction", { length: 160 }),
    account_number: varchar("account_number", { length: 120 }),
    assessed_land: money("assessed_land"),
    assessed_improvements: money("assessed_improvements"),
    assessed_total: money("assessed_total").notNull(),
    market_value: money("market_value"),
    taxable_value: money("taxable_value"),
    tax_rate: doublePrecision("tax_rate"), // % of taxable value
    estimated_tax: money("estimated_tax"),
    notice_received_on: date("notice_received_on", { mode: "string" }),
    protest_deadline_on: date("protest_deadline_on", { mode: "string" }),
    source: varchar("source", { length: 200 }),
    observed_on: date("observed_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    unique("uq_tax_assessments_year").on(t.property_id, t.parcel_id, t.tax_year),
    index("ix_tax_assessments_property_id").on(t.property_id),
    index("ix_tax_assessments_parcel_id").on(t.parcel_id),
    index("ix_tax_assessments_tax_year").on(t.tax_year),
  ],
);
export type TaxAssessment = typeof taxAssessments.$inferSelect;

export const taxProtests = pgTable(
  "tax_protests",
  {
    ...entity(),
    assessment_id: fkNN("assessment_id", () => taxAssessments.id, "cascade"),
    property_id: fkNN("property_id", () => properties.id, "cascade"),
    tax_year: integer("tax_year").notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "considering"),
    deadline_on: date("deadline_on", { mode: "string" }),
    filed_on: date("filed_on", { mode: "string" }),
    consultant_organization_id: fk("consultant_organization_id", () => organizations.id),
    consultant_name: varchar("consultant_name", { length: 200 }),
    consultant_fee_pct: doublePrecision("consultant_fee_pct"), // contingency % of savings
    consultant_fee_flat: money("consultant_fee_flat"),
    owner_opinion_value: money("owner_opinion_value"),
    evidence_document_ids: uuid("evidence_document_ids").array().notNull().$defaultFn(() => []),
    evidence_notes: text("evidence_notes"),
    hearing_on: date("hearing_on", { mode: "string" }),
    hearing_result: varchar("hearing_result", { length: 20 }), // reduced | no_change | increased | settled | withdrawn
    final_value: money("final_value"),
    value_reduction: money("value_reduction"),
    tax_savings: money("tax_savings"),
    consultant_fee: money("consultant_fee"),
    net_savings: money("net_savings"),
    resolved_on: date("resolved_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_tax_protests_assessment_id").on(t.assessment_id),
    index("ix_tax_protests_property_id").on(t.property_id),
    index("ix_tax_protests_tax_year").on(t.tax_year),
    index("ix_tax_protests_status").on(t.status),
    index("ix_tax_protests_deadline_on").on(t.deadline_on),
    index("ix_tax_protests_consultant_organization_id").on(t.consultant_organization_id),
  ],
);
export type TaxProtest = typeof taxProtests.$inferSelect;

export const taxPayments = pgTable(
  "tax_payments",
  {
    ...entity(),
    property_id: fkNN("property_id", () => properties.id, "cascade"),
    assessment_id: fk("assessment_id", () => taxAssessments.id),
    tax_year: integer("tax_year").notNull(),
    installment: varchar("installment", { length: 40 }),
    amount_due: money("amount_due").notNull(),
    due_on: date("due_on", { mode: "string" }).notNull(),
    amount_paid: money("amount_paid"),
    paid_on: date("paid_on", { mode: "string" }),
    method: varchar("method", { length: 40 }),
    confirmation_number: varchar("confirmation_number", { length: 120 }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "scheduled"),
    confirmed_by_id: fk("confirmed_by_id", () => users.id),
    confirmed_at: tz("confirmed_at"),
    document_id: uuid("document_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_tax_payments_property_id").on(t.property_id),
    index("ix_tax_payments_assessment_id").on(t.assessment_id),
    index("ix_tax_payments_tax_year").on(t.tax_year),
    index("ix_tax_payments_due_on").on(t.due_on),
    index("ix_tax_payments_status").on(t.status),
  ],
);
export type TaxPayment = typeof taxPayments.$inferSelect;

// ======================================================================= budgets

export const budgets = pgTable(
  "budgets",
  {
    ...entity(),
    asset_id: uuid("asset_id"),
    property_id: fkNN("property_id", () => properties.id, "cascade"),
    fiscal_year: integer("fiscal_year").notNull(),
    version: integer("version").notNull().$defaultFn(() => 1),
    kind: varchar("kind", { length: 20 }).notNull().$defaultFn(() => "original"), // original | reforecast
    name: varchar("name", { length: 200 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    parent_budget_id: uuid("parent_budget_id"),
    submitted_at: tz("submitted_at"),
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    approval_note: text("approval_note"),
    superseded_at: tz("superseded_at"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_budgets_asset_id").on(t.asset_id),
    index("ix_budgets_property_id").on(t.property_id),
    index("ix_budgets_fiscal_year").on(t.fiscal_year),
    index("ix_budgets_status").on(t.status),
  ],
);
export type Budget = typeof budgets.$inferSelect;

export const budgetLines = pgTable(
  "budget_lines",
  {
    ...entity(),
    budget_id: fkNN("budget_id", () => budgets.id, "cascade"),
    account: varchar("account", { length: 120 }).notNull(),
    category: varchar("category", { length: 20 }).notNull().$defaultFn(() => "expense"),
    month: integer("month").notNull(), // 1-12
    amount: money("amount").notNull().$defaultFn(() => 0),
    reforecast_amount: money("reforecast_amount"),
    prior_actual: money("prior_actual"),
    notes: text("notes"),
  },
  (t) => [
    unique("uq_budget_lines_cell").on(t.budget_id, t.account, t.month),
    index("ix_budget_lines_budget_id").on(t.budget_id),
  ],
);
export type BudgetLine = typeof budgetLines.$inferSelect;
