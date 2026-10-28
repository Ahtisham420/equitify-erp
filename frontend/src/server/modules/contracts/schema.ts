import {
  boolean, date, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
} from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";

export const CONTRACT_STATUSES = ["draft", "executed", "closed", "terminated"] as const;
export const CONTRACT_TYPES = ["purchase_sale", "amendment", "assignment", "option", "other"] as const;
export const PARTY_ROLES = ["buyer", "seller", "escrow_agent", "title_company", "broker", "attorney", "lender", "other"] as const;

export const CRITICAL_DATE_STATUSES = ["proposed", "confirmed", "completed", "waived", "missed"] as const;
export const OPEN_DATE_STATUSES = ["proposed", "confirmed", "missed"] as const;
export const CRITICAL_DATE_SOURCES = ["manual", "rule", "ai"] as const;
export const DATE_TYPES = [
  "effective", "deposit", "additional_deposit", "feasibility_expiry", "title_objection", "title_cure", "survey",
  "financing", "estoppel", "snda", "closing", "extension", "post_close", "lease_expiration", "lease_option",
  "loan_maturity", "rate_cap_expiry", "covenant_test", "offer_response", "other",
] as const;

export const DD_STATUSES = ["not_started", "in_progress", "blocked", "complete", "waived"] as const;
export const DD_DONE = ["complete", "waived"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const HIGH_SEVERITIES = ["high", "critical"] as const;
export const DD_SOURCES = ["template", "manual", "third_party_report", "title", "estoppel", "ai"] as const;

export const REPORT_TYPES = ["survey", "phase_i", "phase_ii", "pca", "zoning", "appraisal", "title", "lease_audit"] as const;
export const REPORT_STATUSES = ["not_ordered", "ordered", "in_progress", "delivered", "reviewed", "cancelled"] as const;
export const REPORT_DONE = ["delivered", "reviewed", "cancelled"] as const;

export const EXCEPTION_KINDS = ["title_exception", "easement", "encroachment", "survey_matter", "lien", "restriction", "other"] as const;
export const EXCEPTION_SOURCES = ["title_commitment", "survey", "other"] as const;
export const EXCEPTION_STATUSES = ["open", "objected", "cure_pending", "cured", "accepted", "waived", "uncured"] as const;
export const EXCEPTION_OPEN = ["open", "objected", "cure_pending", "uncured"] as const;

export const ESTOPPEL_KINDS = ["estoppel", "snda"] as const;
export const ESTOPPEL_STATUSES = ["not_requested", "requested", "received", "approved", "waived"] as const;

export const RISK_CATEGORIES = ["title", "survey", "environmental", "physical", "zoning", "tenancy", "financial", "legal", "other"] as const;
export const RISK_STATUSES = ["open", "mitigating", "decided", "closed"] as const;
export const RISK_DECISIONS = ["proceed", "mitigate", "renegotiate", "terminate", "accept"] as const;

export const DECISION_KINDS = ["extend", "terminate", "proceed", "waive_contingency", "renegotiate", "other"] as const;

/** Business-day calendar. The US federal calendar is seeded lazily from computed rules. */
export const holidayCalendars = pgTable(
  "holiday_calendars",
  {
    ...entity(),
    code: varchar("code", { length: 40 }).notNull().unique("uq_holiday_calendars_code"),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    // Python weekday numbers (Mon=0 … Sun=6) treated as non-business days.
    weekend_days: integer("weekend_days").array().notNull().$defaultFn(() => [5, 6]),
    is_default: boolean("is_default").notNull().$defaultFn(() => false),
    rule_set: varchar("rule_set", { length: 40 }), // 'us_federal' -> holidays computed per year
    seeded_years: integer("seeded_years").array().notNull().$defaultFn(() => []),
  },
  (t) => [index("ix_holiday_calendars_deleted_at").on(t.deleted_at)],
);
export type HolidayCalendar = typeof holidayCalendars.$inferSelect;

export const holidays = pgTable(
  "holidays",
  {
    id: pk(),
    calendar_id: uuid("calendar_id").notNull().references(() => holidayCalendars.id, { onDelete: "cascade" }),
    holiday_on: date("holiday_on", { mode: "string" }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    source: varchar("source", { length: 20 }).notNull().$defaultFn(() => "rule"), // rule | manual
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    created_by_id: fk("created_by_id", () => users.id),
  },
  (t) => [
    unique("uq_holidays_calendar_on").on(t.calendar_id, t.holiday_on),
    index("ix_holidays_calendar_id").on(t.calendar_id),
    index("ix_holidays_holiday_on").on(t.holiday_on),
  ],
);
export type Holiday = typeof holidays.$inferSelect;

/** An agreement (PSA etc.) with its parties and key terms; the hub of dates and diligence (spec 16). */
export const contracts = pgTable(
  "contracts",
  {
    ...entity(),
    title: varchar("title", { length: 255 }).notNull(),
    contract_type: varchar("contract_type", { length: 30 }).notNull().$defaultFn(() => "purchase_sale"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    // Documents and offers modules own these tables; plain UUIDs keep this module independent of load order.
    document_id: uuid("document_id"),
    offer_id: uuid("offer_id"),
    opportunity_id: fk("opportunity_id", () => opportunities.id),
    property_id: fk("property_id", () => properties.id),
    owner_id: fk("owner_id", () => users.id),

    effective_on: date("effective_on", { mode: "string" }),
    executed_on: date("executed_on", { mode: "string" }),
    executed_at: tz("executed_at"),
    executed_by_id: fk("executed_by_id", () => users.id),
    purchase_price: numericFloat("purchase_price", 16, 2),
    earnest_money: numericFloat("earnest_money", 16, 2),
    additional_deposit: numericFloat("additional_deposit", 16, 2),

    // [{role, name, person_id, organization_id, notes}]
    parties: jsonb("parties").$type<any[]>().notNull().$defaultFn(() => []),
    // Day counts and options that drive the date engine (see service.TERM_KEYS) plus free-form terms.
    key_terms: jsonb("key_terms").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    calendar_id: fk("calendar_id", () => holidayCalendars.id),
    attorney_person_id: uuid("attorney_person_id"),
    attorney_organization_id: uuid("attorney_organization_id"),
    terminated_at: tz("terminated_at"),
    notes: text("notes"),
    tags: varchar("tags", { length: 60 }).array().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_contracts_deleted_at").on(t.deleted_at),
    index("ix_contracts_contract_type").on(t.contract_type),
    index("ix_contracts_status").on(t.status),
    index("ix_contracts_document_id").on(t.document_id),
    index("ix_contracts_offer_id").on(t.offer_id),
    index("ix_contracts_opportunity_id").on(t.opportunity_id),
    index("ix_contracts_property_id").on(t.property_id),
    index("ix_contracts_owner_id").on(t.owner_id),
    index("ix_contracts_effective_on").on(t.effective_on),
    index("ix_contracts_calendar_id").on(t.calendar_id),
  ],
);
export type Contract = typeof contracts.$inferSelect;

/** Shared accountable deadline for any record (contract, lease, loan, offer, disposition, ...). */
export const criticalDates = pgTable(
  "critical_dates",
  {
    ...entity(),
    related_type: varchar("related_type", { length: 40 }).notNull(),
    related_id: uuid("related_id").notNull(),
    related_label: varchar("related_label", { length: 300 }),
    key: varchar("key", { length: 80 }).notNull(),
    property_id: fk("property_id", () => properties.id),
    date_type: varchar("date_type", { length: 40 }).notNull(),
    label: varchar("label", { length: 300 }).notNull(),
    due_on: date("due_on", { mode: "string" }).notNull(),
    original_due_on: date("original_due_on", { mode: "string" }),
    // A newer computed/AI value that differs from a human-confirmed date; never applied automatically.
    proposed_due_on: date("proposed_due_on", { mode: "string" }),
    rule: jsonb("rule").$type<Record<string, any> | null>(),
    business_days: boolean("business_days").notNull().$defaultFn(() => false),
    calendar_id: fk("calendar_id", () => holidayCalendars.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "proposed"),
    source: varchar("source", { length: 20 }).notNull().$defaultFn(() => "rule"),
    citation: jsonb("citation").$type<Record<string, any> | null>(), // {document_id, page, clause, text, confidence}
    confirmed_by_id: fk("confirmed_by_id", () => users.id),
    confirmed_at: tz("confirmed_at"),
    confirm_note: text("confirm_note"),
    owner_id: fk("owner_id", () => users.id),
    lead_days: integer("lead_days").notNull().$defaultFn(() => 14),
    is_blocking: boolean("is_blocking").notNull().$defaultFn(() => false),
    completed_at: tz("completed_at"),
    completed_by_id: fk("completed_by_id", () => users.id),
    resolution_note: text("resolution_note"),
    escalation_level: integer("escalation_level").notNull().$defaultFn(() => 0),
    escalated_at: tz("escalated_at"),
    notes: text("notes"),
  },
  (t) => [
    unique("uq_critical_dates_related_key").on(t.related_type, t.related_id, t.key),
    index("ix_critical_dates_deleted_at").on(t.deleted_at),
    index("ix_critical_dates_related_type").on(t.related_type),
    index("ix_critical_dates_related_id").on(t.related_id),
    index("ix_critical_dates_property_id").on(t.property_id),
    index("ix_critical_dates_date_type").on(t.date_type),
    index("ix_critical_dates_due_on").on(t.due_on),
    index("ix_critical_dates_calendar_id").on(t.calendar_id),
    index("ix_critical_dates_status").on(t.status),
    index("ix_critical_dates_source").on(t.source),
    index("ix_critical_dates_owner_id").on(t.owner_id),
    index("ix_critical_dates_is_blocking").on(t.is_blocking),
  ],
);
export type CriticalDate = typeof criticalDates.$inferSelect;

/** Immutable history of every status change and reschedule of a critical date. */
export const criticalDateEvents = pgTable(
  "critical_date_events",
  {
    id: pk(),
    critical_date_id: uuid("critical_date_id").notNull().references(() => criticalDates.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 30 }).notNull(),
    from_status: varchar("from_status", { length: 20 }),
    to_status: varchar("to_status", { length: 20 }),
    from_due_on: date("from_due_on", { mode: "string" }),
    to_due_on: date("to_due_on", { mode: "string" }),
    reason: text("reason"),
    actor_id: fk("actor_id", () => users.id),
    actor_name: varchar("actor_name", { length: 200 }),
    at: tz("at").notNull().$defaultFn(() => new Date()),
    data: jsonb("data").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [
    index("ix_critical_date_events_critical_date_id").on(t.critical_date_id),
    index("ix_critical_date_events_at").on(t.at),
  ],
);
export type CriticalDateEvent = typeof criticalDateEvents.$inferSelect;

export const ddTemplates = pgTable(
  "dd_templates",
  {
    ...entity(),
    code: varchar("code", { length: 60 }).notNull().unique("uq_dd_templates_code"),
    name: varchar("name", { length: 160 }).notNull(),
    property_types: varchar("property_types", { length: 40 }).array().notNull().$defaultFn(() => []),
    is_generic: boolean("is_generic").notNull().$defaultFn(() => false),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    version: integer("version").notNull().$defaultFn(() => 1),
    // [{key, category, title, description, severity, due_days, depends_on:[key], report_type}]
    items: jsonb("items").$type<any[]>().notNull().$defaultFn(() => []),
  },
  (t) => [index("ix_dd_templates_deleted_at").on(t.deleted_at)],
);
export type DDTemplate = typeof ddTemplates.$inferSelect;

export const ddItems = pgTable(
  "dd_items",
  {
    ...entity(),
    contract_id: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    template_id: fk("template_id", () => ddTemplates.id),
    key: varchar("key", { length: 80 }),
    category: varchar("category", { length: 60 }).notNull().$defaultFn(() => "general"),
    title: varchar("title", { length: 300 }).notNull(),
    description: text("description"),
    owner_id: fk("owner_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "not_started"),
    due_on: date("due_on", { mode: "string" }),
    depends_on: jsonb("depends_on").$type<any[]>().notNull().$defaultFn(() => []), // [dd_item_id]
    source: varchar("source", { length: 30 }).notNull().$defaultFn(() => "manual"),
    findings: text("findings"),
    severity: varchar("severity", { length: 10 }),
    cost_impact: numericFloat("cost_impact", 16, 2),
    resolution: text("resolution"),
    escalation_level: integer("escalation_level").notNull().$defaultFn(() => 0),
    escalated_at: tz("escalated_at"),
    escalation_note: text("escalation_note"),
    report_id: uuid("report_id"),
    completed_at: tz("completed_at"),
    completed_by_id: fk("completed_by_id", () => users.id),
    sort_order: integer("sort_order").notNull().$defaultFn(() => 0),
  },
  (t) => [
    index("ix_dd_items_deleted_at").on(t.deleted_at),
    index("ix_dd_items_contract_id").on(t.contract_id),
    index("ix_dd_items_property_id").on(t.property_id),
    index("ix_dd_items_template_id").on(t.template_id),
    index("ix_dd_items_category").on(t.category),
    index("ix_dd_items_owner_id").on(t.owner_id),
    index("ix_dd_items_status").on(t.status),
    index("ix_dd_items_due_on").on(t.due_on),
    index("ix_dd_items_severity").on(t.severity),
  ],
);
export type DDItem = typeof ddItems.$inferSelect;

export const thirdPartyReports = pgTable(
  "third_party_reports",
  {
    ...entity(),
    contract_id: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    report_type: varchar("report_type", { length: 30 }).notNull(),
    vendor_organization_id: uuid("vendor_organization_id"),
    vendor_name: varchar("vendor_name", { length: 200 }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "not_ordered"),
    ordered_on: date("ordered_on", { mode: "string" }),
    expected_on: date("expected_on", { mode: "string" }),
    delivered_on: date("delivered_on", { mode: "string" }),
    cost: numericFloat("cost", 16, 2),
    findings: text("findings"),
    severity: varchar("severity", { length: 10 }),
    document_id: uuid("document_id"),
    owner_id: fk("owner_id", () => users.id),
    notes: text("notes"),
  },
  (t) => [
    index("ix_third_party_reports_deleted_at").on(t.deleted_at),
    index("ix_third_party_reports_contract_id").on(t.contract_id),
    index("ix_third_party_reports_property_id").on(t.property_id),
    index("ix_third_party_reports_report_type").on(t.report_type),
    index("ix_third_party_reports_vendor_organization_id").on(t.vendor_organization_id),
    index("ix_third_party_reports_status").on(t.status),
    index("ix_third_party_reports_expected_on").on(t.expected_on),
    index("ix_third_party_reports_owner_id").on(t.owner_id),
  ],
);
export type ThirdPartyReport = typeof thirdPartyReports.$inferSelect;

/** Title commitment / survey matter with objection and cure tracking. */
export const titleExceptions = pgTable(
  "title_exceptions",
  {
    ...entity(),
    contract_id: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    kind: varchar("kind", { length: 30 }).notNull().$defaultFn(() => "title_exception"),
    source: varchar("source", { length: 30 }).notNull().$defaultFn(() => "title_commitment"),
    schedule_ref: varchar("schedule_ref", { length: 80 }),
    description: text("description").notNull(),
    recording_ref: varchar("recording_ref", { length: 160 }),
    severity: varchar("severity", { length: 10 }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    objection_sent_on: date("objection_sent_on", { mode: "string" }),
    cure_due_on: date("cure_due_on", { mode: "string" }),
    cure_response: text("cure_response"),
    resolved_on: date("resolved_on", { mode: "string" }),
    attorney_person_id: uuid("attorney_person_id"),
    attorney_organization_id: uuid("attorney_organization_id"),
    document_id: uuid("document_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_title_exceptions_deleted_at").on(t.deleted_at),
    index("ix_title_exceptions_contract_id").on(t.contract_id),
    index("ix_title_exceptions_property_id").on(t.property_id),
    index("ix_title_exceptions_kind").on(t.kind),
    index("ix_title_exceptions_status").on(t.status),
  ],
);
export type TitleException = typeof titleExceptions.$inferSelect;

/** Estoppel / SNDA per tenant. Expected (lease / rent roll) and tenant-reported values are both kept. */
export const estoppels = pgTable(
  "estoppels",
  {
    ...entity(),
    contract_id: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    kind: varchar("kind", { length: 10 }).notNull().$defaultFn(() => "estoppel"),
    tenant_name: varchar("tenant_name", { length: 200 }).notNull(),
    lease_id: uuid("lease_id"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "not_requested"),
    requested_on: date("requested_on", { mode: "string" }),
    due_on: date("due_on", { mode: "string" }),
    received_on: date("received_on", { mode: "string" }),
    expected_monthly_rent: numericFloat("expected_monthly_rent", 16, 2),
    expected_expiration_on: date("expected_expiration_on", { mode: "string" }),
    expected_security_deposit: numericFloat("expected_security_deposit", 16, 2),
    reported_monthly_rent: numericFloat("reported_monthly_rent", 16, 2),
    reported_expiration_on: date("reported_expiration_on", { mode: "string" }),
    reported_security_deposit: numericFloat("reported_security_deposit", 16, 2),
    reported_landlord_default: boolean("reported_landlord_default"),
    reported_notes: text("reported_notes"),
    discrepancies: jsonb("discrepancies").$type<any[]>().notNull().$defaultFn(() => []),
    has_discrepancy: boolean("has_discrepancy").notNull().$defaultFn(() => false),
    discrepancy_resolution: text("discrepancy_resolution"),
    discrepancy_resolved_at: tz("discrepancy_resolved_at"),
    discrepancy_resolved_by_id: fk("discrepancy_resolved_by_id", () => users.id),
    document_id: uuid("document_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_estoppels_deleted_at").on(t.deleted_at),
    index("ix_estoppels_contract_id").on(t.contract_id),
    index("ix_estoppels_property_id").on(t.property_id),
    index("ix_estoppels_kind").on(t.kind),
    index("ix_estoppels_lease_id").on(t.lease_id),
    index("ix_estoppels_status").on(t.status),
    index("ix_estoppels_has_discrepancy").on(t.has_discrepancy),
  ],
);
export type Estoppel = typeof estoppels.$inferSelect;

/** Risk register entry. High-severity risks need a recorded decision before the feasibility deadline. */
export const riskItems = pgTable(
  "risk_items",
  {
    ...entity(),
    contract_id: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    property_id: fk("property_id", () => properties.id),
    title: varchar("title", { length: 300 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 30 }).notNull().$defaultFn(() => "other"),
    severity: varchar("severity", { length: 10 }).notNull().$defaultFn(() => "medium"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    source_type: varchar("source_type", { length: 40 }), // dd_item | third_party_report | title_exception | estoppel
    source_id: uuid("source_id"),
    owner_id: fk("owner_id", () => users.id),
    cost_impact: numericFloat("cost_impact", 16, 2),
    mitigation: text("mitigation"),
    decision_required: boolean("decision_required").notNull().$defaultFn(() => true),
    decision_due_on: date("decision_due_on", { mode: "string" }),
    decision: varchar("decision", { length: 20 }),
    decision_reason: text("decision_reason"),
    decided_by_id: fk("decided_by_id", () => users.id),
    decided_at: tz("decided_at"),
  },
  (t) => [
    index("ix_risk_items_deleted_at").on(t.deleted_at),
    index("ix_risk_items_contract_id").on(t.contract_id),
    index("ix_risk_items_property_id").on(t.property_id),
    index("ix_risk_items_category").on(t.category),
    index("ix_risk_items_severity").on(t.severity),
    index("ix_risk_items_status").on(t.status),
    index("ix_risk_items_owner_id").on(t.owner_id),
  ],
);
export type RiskItem = typeof riskItems.$inferSelect;

/** Immutable extension / termination / go-hard decisions with the reasoning given. */
export const contractDecisions = pgTable(
  "contract_decisions",
  {
    id: pk(),
    contract_id: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 30 }).notNull(),
    reasoning: text("reasoning").notNull(),
    critical_date_id: uuid("critical_date_id"),
    previous_due_on: date("previous_due_on", { mode: "string" }),
    new_due_on: date("new_due_on", { mode: "string" }),
    effective_on: date("effective_on", { mode: "string" }),
    decided_by_id: fk("decided_by_id", () => users.id),
    decided_by_name: varchar("decided_by_name", { length: 200 }),
    decided_at: tz("decided_at").notNull().$defaultFn(() => new Date()),
    data: jsonb("data").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
  },
  (t) => [
    index("ix_contract_decisions_contract_id").on(t.contract_id),
    index("ix_contract_decisions_decided_at").on(t.decided_at),
  ],
);
export type ContractDecision = typeof contractDecisions.$inferSelect;
