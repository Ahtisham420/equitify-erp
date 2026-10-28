import { boolean, date, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { leases } from "../leases/schema";
import { properties } from "../properties/schema";

export const CHARGE_TYPES = [
  "base_rent", "recovery", "cam", "tax", "insurance", "utilities", "fixed_cam", "late_fee", "recovery_true_up",
  "percentage_rent", "parking", "repair", "other",
] as const;
export const CHARGE_STATUSES = ["pending_approval", "open", "partial", "paid", "credit", "void"] as const;
export const CHARGE_SOURCES = ["schedule", "manual", "late_fee", "reconciliation"] as const;
export const PAYMENT_METHODS = ["ach", "check", "wire", "card", "cash", "other"] as const;
export const PAYMENT_STATUSES = ["received", "reversed"] as const;
export const NOTICE_STATUSES = ["draft", "sent", "cancelled"] as const;
export const PLAN_STATUSES = ["active", "completed", "breached", "cancelled"] as const;
export const COLLECTION_STATUSES = ["current", "delinquent", "payment_plan", "legal", "resolved"] as const;
export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;

/** Every charge traces to lease terms (schedule / late fee / reconciliation) or an approved manual entry. */
export const charges = pgTable(
  "charges",
  {
    ...entity(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    asset_id: uuid("asset_id"),
    tenant_name: varchar("tenant_name", { length: 200 }),
    charge_type: varchar("charge_type", { length: 30 }).notNull(),
    period_start: date("period_start", { mode: "string" }),
    period_end: date("period_end", { mode: "string" }),
    due_on: date("due_on", { mode: "string" }).notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    amount_paid: numericFloat("amount_paid", 16, 2).notNull().$defaultFn(() => 0),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    source: varchar("source", { length: 20 }).notNull(),
    source_ref: jsonb("source_ref").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    description: varchar("description", { length: 300 }),
    idempotency_key: varchar("idempotency_key", { length: 200 }),
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    voided_at: tz("voided_at"),
    voided_by_id: fk("voided_by_id", () => users.id),
    void_reason: varchar("void_reason", { length: 300 }),
    external_ref: varchar("external_ref", { length: 120 }),
    synced_at: tz("synced_at"),
  },
  (t) => [
    unique("uq_charges_idempotency_key").on(t.idempotency_key),
    index("ix_charges_deleted_at").on(t.deleted_at),
    index("ix_charges_lease_id").on(t.lease_id),
    index("ix_charges_property_id").on(t.property_id),
    index("ix_charges_asset_id").on(t.asset_id),
    index("ix_charges_charge_type").on(t.charge_type),
    index("ix_charges_period_start").on(t.period_start),
    index("ix_charges_due_on").on(t.due_on),
    index("ix_charges_status").on(t.status),
    index("ix_charges_source").on(t.source),
    index("ix_charges_external_ref").on(t.external_ref),
  ],
);

/** Payments are never edited or deleted: corrections are reversals with a reason. */
export const payments = pgTable(
  "payments",
  {
    ...entity(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    tenant_name: varchar("tenant_name", { length: 200 }),
    received_on: date("received_on", { mode: "string" }).notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    unapplied_amount: numericFloat("unapplied_amount", 16, 2).notNull().$defaultFn(() => 0),
    method: varchar("method", { length: 20 }).notNull().$defaultFn(() => "ach"),
    reference: varchar("reference", { length: 120 }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "received"),
    reversed_at: tz("reversed_at"),
    reversed_by_id: fk("reversed_by_id", () => users.id),
    reversal_reason: varchar("reversal_reason", { length: 300 }),
    notes: text("notes"),
    external_ref: varchar("external_ref", { length: 120 }),
    synced_at: tz("synced_at"),
  },
  (t) => [
    index("ix_payments_deleted_at").on(t.deleted_at),
    index("ix_payments_lease_id").on(t.lease_id),
    index("ix_payments_property_id").on(t.property_id),
    index("ix_payments_received_on").on(t.received_on),
    index("ix_payments_status").on(t.status),
    index("ix_payments_external_ref").on(t.external_ref),
  ],
);

export const paymentApplications = pgTable(
  "payment_applications",
  {
    ...entity(),
    payment_id: uuid("payment_id").notNull().references(() => payments.id, { onDelete: "cascade" }),
    charge_id: uuid("charge_id").notNull().references(() => charges.id, { onDelete: "cascade" }),
    amount: numericFloat("amount", 16, 2).notNull(),
    applied_on: date("applied_on", { mode: "string" }).notNull(),
    method: varchar("method", { length: 10 }).notNull().$defaultFn(() => "auto"), // auto | manual
    reversed_at: tz("reversed_at"),
    reversed_by_id: fk("reversed_by_id", () => users.id),
    reversal_reason: varchar("reversal_reason", { length: 300 }),
  },
  (t) => [
    index("ix_payment_applications_deleted_at").on(t.deleted_at),
    index("ix_payment_applications_payment_id").on(t.payment_id),
    index("ix_payment_applications_charge_id").on(t.charge_id),
  ],
);

/** Per-lease position on the delinquency escalation ladder. */
export const collectionStatuses = pgTable(
  "collection_statuses",
  {
    ...entity(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "current"),
    step_index: integer("step_index").notNull().$defaultFn(() => 0),
    step_key: varchar("step_key", { length: 40 }),
    past_due_balance: numericFloat("past_due_balance", 16, 2).notNull().$defaultFn(() => 0),
    days_past_due: integer("days_past_due").notNull().$defaultFn(() => 0),
    oldest_due_on: date("oldest_due_on", { mode: "string" }),
    on_hold: boolean("on_hold").notNull().$defaultFn(() => false),
    last_evaluated_at: tz("last_evaluated_at"),
  },
  (t) => [
    unique("uq_collection_lease").on(t.lease_id),
    index("ix_collection_statuses_deleted_at").on(t.deleted_at),
    index("ix_collection_statuses_lease_id").on(t.lease_id),
    index("ix_collection_statuses_status").on(t.status),
  ],
);

export const delinquencyNotices = pgTable(
  "delinquency_notices",
  {
    ...entity(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    step_key: varchar("step_key", { length: 40 }).notNull(),
    step_index: integer("step_index").notNull().$defaultFn(() => 0),
    label: varchar("label", { length: 160 }).notNull(),
    balance: numericFloat("balance", 16, 2).notNull(),
    days_past_due: integer("days_past_due").notNull().$defaultFn(() => 0),
    subject: varchar("subject", { length: 300 }).notNull(),
    body: text("body").notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "draft"),
    delivery_method: varchar("delivery_method", { length: 20 }),
    sent_at: tz("sent_at"),
    sent_by_id: fk("sent_by_id", () => users.id),
    task_id: uuid("task_id"),
    idempotency_key: varchar("idempotency_key", { length: 200 }),
  },
  (t) => [
    unique("uq_delinquency_notices_idempotency_key").on(t.idempotency_key),
    index("ix_delinquency_notices_deleted_at").on(t.deleted_at),
    index("ix_delinquency_notices_lease_id").on(t.lease_id),
    index("ix_delinquency_notices_property_id").on(t.property_id),
    index("ix_delinquency_notices_step_key").on(t.step_key),
    index("ix_delinquency_notices_status").on(t.status),
  ],
);

export const paymentPlans = pgTable(
  "payment_plans",
  {
    ...entity(),
    lease_id: uuid("lease_id").notNull().references(() => leases.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    total_amount: numericFloat("total_amount", 16, 2).notNull(),
    start_on: date("start_on", { mode: "string" }).notNull(),
    installment_count: integer("installment_count").notNull(),
    frequency_months: integer("frequency_months").notNull().$defaultFn(() => 1),
    grace_days: integer("grace_days").notNull().$defaultFn(() => 5),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "active"),
    paid_amount: numericFloat("paid_amount", 16, 2).notNull().$defaultFn(() => 0),
    breached_at: tz("breached_at"),
    approved_by_id: fk("approved_by_id", () => users.id),
    notes: text("notes"),
  },
  (t) => [
    index("ix_payment_plans_deleted_at").on(t.deleted_at),
    index("ix_payment_plans_lease_id").on(t.lease_id),
    index("ix_payment_plans_property_id").on(t.property_id),
    index("ix_payment_plans_status").on(t.status),
  ],
);

export const paymentPlanInstallments = pgTable(
  "payment_plan_installments",
  {
    ...entity(),
    plan_id: uuid("plan_id").notNull().references(() => paymentPlans.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    due_on: date("due_on", { mode: "string" }).notNull(),
    amount: numericFloat("amount", 16, 2).notNull(),
    paid_amount: numericFloat("paid_amount", 16, 2).notNull().$defaultFn(() => 0),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "scheduled"), // scheduled | partial | paid | missed
  },
  (t) => [
    index("ix_payment_plan_installments_deleted_at").on(t.deleted_at),
    index("ix_payment_plan_installments_plan_id").on(t.plan_id),
  ],
);

/** Configurable late-fee defaults, escalation ladder and aging automation thresholds. */
export const receivablesSettings = pgTable(
  "receivables_settings",
  {
    ...entity(),
    key: varchar("key", { length: 60 }).notNull(),
    value: jsonb("value").$type<any>().notNull(),
  },
  (t) => [
    unique("uq_receivables_settings_key").on(t.key),
    index("ix_receivables_settings_deleted_at").on(t.deleted_at),
  ],
);

/** Accounting / banking synchronisation batch (export or import). */
export const syncBatches = pgTable(
  "sync_batches",
  {
    ...entity(),
    direction: varchar("direction", { length: 10 }).notNull(), // export | import
    system: varchar("system", { length: 80 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().$defaultFn(() => "completed"),
    period_from: date("period_from", { mode: "string" }),
    period_to: date("period_to", { mode: "string" }),
    property_id: fk("property_id", () => properties.id),
    entry_count: integer("entry_count").notNull().$defaultFn(() => 0),
    matched_count: integer("matched_count").notNull().$defaultFn(() => 0),
    conflict_count: integer("conflict_count").notNull().$defaultFn(() => 0),
    external_batch_id: varchar("external_batch_id", { length: 120 }),
    payload: jsonb("payload").$type<any[]>().notNull().$defaultFn(() => []),
    summary: text("summary"),
  },
  (t) => [
    index("ix_sync_batches_deleted_at").on(t.deleted_at),
    index("ix_sync_batches_direction").on(t.direction),
    index("ix_sync_batches_status").on(t.status),
    index("ix_sync_batches_property_id").on(t.property_id),
  ],
);

/** External data that disagrees with ours. Never applied automatically; a human resolves it. */
export const syncConflicts = pgTable(
  "sync_conflicts",
  {
    ...entity(),
    batch_id: uuid("batch_id").notNull().references(() => syncBatches.id, { onDelete: "cascade" }),
    entity_type: varchar("entity_type", { length: 20 }).notNull(), // charge | payment
    entity_id: uuid("entity_id"),
    external_id: varchar("external_id", { length: 120 }),
    field: varchar("field", { length: 40 }).notNull(),
    local_value: jsonb("local_value").$type<any>().notNull(),
    external_value: jsonb("external_value").$type<any>().notNull(),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    resolved_by_id: fk("resolved_by_id", () => users.id),
    resolved_at: tz("resolved_at"),
    resolution_note: varchar("resolution_note", { length: 300 }),
  },
  (t) => [
    index("ix_sync_conflicts_deleted_at").on(t.deleted_at),
    index("ix_sync_conflicts_batch_id").on(t.batch_id),
    index("ix_sync_conflicts_entity_id").on(t.entity_id),
    index("ix_sync_conflicts_status").on(t.status),
  ],
);

export type Charge = typeof charges.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type PaymentApplication = typeof paymentApplications.$inferSelect;
export type CollectionStatus = typeof collectionStatuses.$inferSelect;
export type DelinquencyNotice = typeof delinquencyNotices.$inferSelect;
export type PaymentPlan = typeof paymentPlans.$inferSelect;
export type PaymentPlanInstallment = typeof paymentPlanInstallments.$inferSelect;
export type ReceivablesSetting = typeof receivablesSettings.$inferSelect;
export type SyncBatch = typeof syncBatches.$inferSelect;
export type SyncConflict = typeof syncConflicts.$inferSelect;
