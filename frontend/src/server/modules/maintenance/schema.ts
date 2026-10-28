import {
  boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid, varchar,
} from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { organizations } from "../contacts/schema";
import { users } from "../auth/schema";
import { vendors } from "../operations/schema";
import { spaces } from "../parcels/schema";
import { properties } from "../properties/schema";

export const WO_SOURCES = ["tenant", "staff", "inspection", "preventive"] as const;
export const WO_CATEGORIES = [
  "hvac", "plumbing", "electrical", "roof", "structural", "parking_lot", "landscaping", "life_safety",
  "janitorial", "pest_control", "doors_locks", "signage", "elevator", "general", "other",
] as const;
export const WO_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
// Ordered workflow; `cancelled` is a terminal side exit.
export const WO_STATUSES = ["open", "assigned", "in_progress", "completed", "verified", "cancelled"] as const;
export const WO_TRANSITIONS: Record<string, Set<string>> = {
  open: new Set(["assigned", "cancelled"]),
  assigned: new Set(["in_progress", "open", "cancelled"]),
  in_progress: new Set(["completed", "assigned", "cancelled"]),
  completed: new Set(["verified", "in_progress"]),
  verified: new Set(),
  cancelled: new Set(["open"]),
};
export const APPROVAL_STATES = ["not_required", "pending", "approved", "rejected"] as const;
export const RESPONSIBILITY = ["undetermined", "tenant", "landlord", "shared"] as const;
export const CHARGEBACK_STATES = ["none", "created", "pending_manual"] as const;

export const PM_FREQUENCIES: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 91, semiannual: 182, annual: 365 };
export const INSPECTION_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
export const ITEM_RESULTS = ["pass", "fail", "na"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const FINDING_STATUSES = ["open", "work_order_created", "resolved", "deferred"] as const;

export const workOrders = pgTable(
  "work_orders",
  {
    ...entity(),

    number: integer("number").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    source: varchar("source", { length: 20 }).notNull().$defaultFn(() => "staff"),
    category: varchar("category", { length: 30 }).notNull().$defaultFn(() => "general"),
    priority: varchar("priority", { length: 10 }).notNull().$defaultFn(() => "normal"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    status_history: jsonb("status_history").$type<any[]>().notNull().$defaultFn(() => []),

    // Location: property / asset / space / free-text detail. assets + leases are owned by other modules -> plain UUIDs.
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    asset_id: uuid("asset_id"),
    space_id: fk("space_id", () => spaces.id),
    lease_id: uuid("lease_id"),
    system: varchar("system", { length: 120 }),
    location_detail: varchar("location_detail", { length: 200 }),

    requested_by_name: varchar("requested_by_name", { length: 200 }),
    requester_contact: varchar("requester_contact", { length: 200 }),
    tenant_organization_id: fk("tenant_organization_id", () => organizations.id),
    reported_at: tz("reported_at"),
    due_on: date("due_on", { mode: "string" }),
    photo_document_ids: uuid("photo_document_ids").array().notNull().$defaultFn(() => []),

    // Assignment
    assignee_type: varchar("assignee_type", { length: 10 }), // vendor | staff
    vendor_id: fk("vendor_id", () => vendors.id),
    assigned_user_id: fk("assigned_user_id", () => users.id),
    assigned_at: tz("assigned_at"),
    started_at: tz("started_at"),

    // Cost & approval
    estimate_amount: numericFloat("estimate_amount", 16, 2),
    approval_status: varchar("approval_status", { length: 20 }).notNull().$defaultFn(() => "not_required"),
    approval_threshold: numericFloat("approval_threshold", 16, 2),
    approved_by_id: fk("approved_by_id", () => users.id),
    approved_at: tz("approved_at"),
    approval_note: text("approval_note"),
    actual_cost: numericFloat("actual_cost", 16, 2),

    // Completion & verification
    completed_at: tz("completed_at"),
    completed_by_id: fk("completed_by_id", () => users.id),
    completion_notes: text("completion_notes"),
    evidence_document_ids: uuid("evidence_document_ids").array().notNull().$defaultFn(() => []),
    verified_at: tz("verified_at"),
    verified_by_id: fk("verified_by_id", () => users.id),
    cancelled_reason: text("cancelled_reason"),
    satisfaction_rating: integer("satisfaction_rating"),
    satisfaction_comment: text("satisfaction_comment"),

    // Tenant responsibility (from lease obligations)
    tenant_responsibility: varchar("tenant_responsibility", { length: 20 }).notNull().$defaultFn(() => "undetermined"),
    tenant_share_pct: doublePrecision("tenant_share_pct"),
    responsibility_reason: text("responsibility_reason"),
    responsibility_basis: jsonb("responsibility_basis").$type<any[]>().notNull().$defaultFn(() => []),
    responsibility_method: varchar("responsibility_method", { length: 20 }), // lease_rules | manual
    responsibility_determined_at: tz("responsibility_determined_at"),
    responsibility_determined_by_id: fk("responsibility_determined_by_id", () => users.id),
    chargeback_status: varchar("chargeback_status", { length: 20 }).notNull().$defaultFn(() => "none"),
    chargeback_amount: numericFloat("chargeback_amount", 16, 2),
    chargeback_charge_id: uuid("chargeback_charge_id"),

    // Origin links
    pm_schedule_id: fk("pm_schedule_id", (): any => pmSchedules.id),
    inspection_id: fk("inspection_id", (): any => inspections.id),
    finding_id: fk("finding_id", (): any => inspectionFindings.id),
    idempotency_key: varchar("idempotency_key", { length: 200 }),
  },
  (t) => [
    index("ix_work_orders_deleted_at").on(t.deleted_at),
    index("ix_work_orders_number").on(t.number),
    index("ix_work_orders_source").on(t.source),
    index("ix_work_orders_category").on(t.category),
    index("ix_work_orders_priority").on(t.priority),
    index("ix_work_orders_status").on(t.status),
    index("ix_work_orders_property_id").on(t.property_id),
    index("ix_work_orders_asset_id").on(t.asset_id),
    index("ix_work_orders_space_id").on(t.space_id),
    index("ix_work_orders_lease_id").on(t.lease_id),
    index("ix_work_orders_tenant_organization_id").on(t.tenant_organization_id),
    index("ix_work_orders_due_on").on(t.due_on),
    index("ix_work_orders_vendor_id").on(t.vendor_id),
    index("ix_work_orders_assigned_user_id").on(t.assigned_user_id),
    index("ix_work_orders_approval_status").on(t.approval_status),
    index("ix_work_orders_tenant_responsibility").on(t.tenant_responsibility),
    index("ix_work_orders_pm_schedule_id").on(t.pm_schedule_id),
    index("ix_work_orders_inspection_id").on(t.inspection_id),
    index("ix_work_orders_finding_id").on(t.finding_id),
    unique("uq_work_orders_idempotency_key").on(t.idempotency_key),
  ],
);

/** Single-row configuration for maintenance automations and approval thresholds. */
export const maintenanceSettings = pgTable(
  "maintenance_settings",
  {
    ...entity(),
    approval_threshold: numericFloat("approval_threshold", 16, 2).notNull().$defaultFn(() => 5000),
    finding_auto_wo_severity: varchar("finding_auto_wo_severity", { length: 10 }).notNull().$defaultFn(() => "high"),
    pm_default_lead_days: integer("pm_default_lead_days").notNull().$defaultFn(() => 14),
  },
  (t) => [index("ix_maintenance_settings_deleted_at").on(t.deleted_at)],
);

export const pmSchedules = pgTable(
  "pm_schedules",
  {
    ...entity(),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    asset_id: uuid("asset_id"),
    system: varchar("system", { length: 120 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 30 }).notNull().$defaultFn(() => "general"),
    priority: varchar("priority", { length: 10 }).notNull().$defaultFn(() => "normal"),
    frequency: varchar("frequency", { length: 20 }).notNull().$defaultFn(() => "quarterly"),
    interval_days: integer("interval_days"), // for frequency=custom
    lead_days: integer("lead_days").notNull().$defaultFn(() => 14),
    last_service_on: date("last_service_on", { mode: "string" }),
    next_service_on: date("next_service_on", { mode: "string" }).notNull(),
    default_vendor_id: fk("default_vendor_id", () => vendors.id),
    default_assignee_id: fk("default_assignee_id", () => users.id),
    estimate_amount: numericFloat("estimate_amount", 16, 2),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
    last_generated_on: date("last_generated_on", { mode: "string" }),
    last_work_order_id: uuid("last_work_order_id"),
  },
  (t) => [
    index("ix_pm_schedules_deleted_at").on(t.deleted_at),
    index("ix_pm_schedules_property_id").on(t.property_id),
    index("ix_pm_schedules_asset_id").on(t.asset_id),
    index("ix_pm_schedules_next_service_on").on(t.next_service_on),
    index("ix_pm_schedules_default_vendor_id").on(t.default_vendor_id),
    index("ix_pm_schedules_default_assignee_id").on(t.default_assignee_id),
    index("ix_pm_schedules_is_active").on(t.is_active),
  ],
);

/** sections: [{key, title, items: [{key, label, guidance?}]}] */
export const inspectionTemplates = pgTable(
  "inspection_templates",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(),
    property_type: varchar("property_type", { length: 40 }), // null = any type
    description: text("description"),
    sections: jsonb("sections").$type<any[]>().notNull().$defaultFn(() => []),
    version: integer("version").notNull().$defaultFn(() => 1),
    is_active: boolean("is_active").notNull().$defaultFn(() => true),
  },
  (t) => [
    index("ix_inspection_templates_deleted_at").on(t.deleted_at),
    index("ix_inspection_templates_property_type").on(t.property_type),
    index("ix_inspection_templates_is_active").on(t.is_active),
  ],
);

export const inspections = pgTable(
  "inspections",
  {
    ...entity(),
    template_id: fk("template_id", () => inspectionTemplates.id),
    template_name: varchar("template_name", { length: 160 }),
    template_version: integer("template_version"),
    sections: jsonb("sections").$type<any[]>().notNull().$defaultFn(() => []), // snapshot of the template at creation
    responses: jsonb("responses").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // {item_key: {result, note, answered_at}}
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    asset_id: uuid("asset_id"),
    inspector_id: fk("inspector_id", () => users.id),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "scheduled"),
    scheduled_on: date("scheduled_on", { mode: "string" }),
    started_at: tz("started_at"),
    completed_at: tz("completed_at"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    summary: text("summary"),
    score: doublePrecision("score"), // pass rate % over answered pass/fail items
  },
  (t) => [
    index("ix_inspections_deleted_at").on(t.deleted_at),
    index("ix_inspections_template_id").on(t.template_id),
    index("ix_inspections_property_id").on(t.property_id),
    index("ix_inspections_asset_id").on(t.asset_id),
    index("ix_inspections_inspector_id").on(t.inspector_id),
    index("ix_inspections_status").on(t.status),
    index("ix_inspections_scheduled_on").on(t.scheduled_on),
  ],
);

export const inspectionFindings = pgTable(
  "inspection_findings",
  {
    ...entity(),
    inspection_id: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
    property_id: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    item_key: varchar("item_key", { length: 80 }),
    item_label: varchar("item_label", { length: 200 }),
    section_title: varchar("section_title", { length: 160 }),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 30 }).notNull().$defaultFn(() => "general"),
    severity: varchar("severity", { length: 10 }).notNull().$defaultFn(() => "medium"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    location_accuracy_m: doublePrecision("location_accuracy_m"),
    captured_at: tz("captured_at"),
    photo_document_ids: uuid("photo_document_ids").array().notNull().$defaultFn(() => []),
    // Plain UUID (work_orders already references inspection_findings; avoids an FK cycle).
    work_order_id: uuid("work_order_id"),
  },
  (t) => [
    index("ix_inspection_findings_deleted_at").on(t.deleted_at),
    index("ix_inspection_findings_inspection_id").on(t.inspection_id),
    index("ix_inspection_findings_property_id").on(t.property_id),
    index("ix_inspection_findings_severity").on(t.severity),
    index("ix_inspection_findings_status").on(t.status),
    index("ix_inspection_findings_work_order_id").on(t.work_order_id),
  ],
);

export type WorkOrder = typeof workOrders.$inferSelect;
export type MaintenanceSettings = typeof maintenanceSettings.$inferSelect;
export type PMSchedule = typeof pmSchedules.$inferSelect;
export type InspectionTemplate = typeof inspectionTemplates.$inferSelect;
export type Inspection = typeof inspections.$inferSelect;
export type InspectionFinding = typeof inspectionFindings.$inferSelect;
