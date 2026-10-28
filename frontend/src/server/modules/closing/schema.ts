import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";

export const CLOSING_STATUSES = ["open", "completed", "cancelled"];
export const CHECKLIST_CATEGORIES = [
  "settlement_statement", "prorations", "insurance", "entity_standing", "lender_conditions", "tenant_notices",
  "vendors", "utilities", "other",
];
export const ITEM_STATUSES = ["open", "in_progress", "done", "waived", "not_applicable"];
export const SATISFIED_STATUSES = ["done", "waived", "not_applicable"];
export const WIRE_RESULTS = ["pending", "passed", "failed", "superseded"];
export const SOURCE_KINDS = ["equity", "senior_debt", "mezzanine", "seller_financing", "deposit_credit", "other"];
export const USE_KINDS = [
  "purchase_price", "closing_costs", "acquisition_fee", "financing_costs", "reserves", "capex", "other",
];

// Default checklist (spec 17): category, title, blocking.
export const CHECKLIST_TEMPLATE: Array<{ key: string; category: string; title: string; blocking: boolean }> = [
  { key: "ss_review", category: "settlement_statement", title: "Review settlement statement draft", blocking: true },
  { key: "ss_approve", category: "settlement_statement", title: "Approve and sign final settlement statement", blocking: true },
  { key: "pr_rent", category: "prorations", title: "Verify rent, CAM and reimbursement prorations", blocking: true },
  { key: "pr_tax", category: "prorations", title: "Verify property tax prorations", blocking: true },
  { key: "pr_deposits", category: "prorations", title: "Confirm tenant security deposit credits", blocking: true },
  { key: "ins_bind", category: "insurance", title: "Bind property and liability insurance effective at closing", blocking: true },
  { key: "ins_cert", category: "insurance", title: "Deliver insurance certificates to lender", blocking: false },
  { key: "ent_good_standing", category: "entity_standing", title: "Certificate of good standing for buyer entity", blocking: true },
  { key: "ent_authority", category: "entity_standing", title: "Authority resolutions and incumbency certificate", blocking: true },
  { key: "lend_conditions", category: "lender_conditions", title: "Satisfy lender closing conditions", blocking: true },
  { key: "lend_docs", category: "lender_conditions", title: "Loan documents executed and funding authorized", blocking: true },
  { key: "ten_letters", category: "tenant_notices", title: "Prepare tenant notice / rent direction letters", blocking: false },
  { key: "ten_send", category: "tenant_notices", title: "Send tenant notices after closing", blocking: false },
  { key: "ven_contracts", category: "vendors", title: "Decide assumption or termination of service contracts", blocking: false },
  { key: "ven_notices", category: "vendors", title: "Notify vendors of ownership change", blocking: false },
  { key: "util_transfer", category: "utilities", title: "Transfer utility accounts to new owner", blocking: false },
];

export const HANDOFF_SECTIONS: Record<string, string> = {
  rent_roll: "Rent roll",
  leases: "Leases",
  service_contracts: "Service contracts",
  warranties: "Warranties",
  keys_access: "Keys & access",
  utilities: "Utilities",
  tax_insurance: "Tax & insurance",
  open_dd_items: "Open DD items",
};

/** One closing per opportunity (spec 17). */
export const closings = pgTable(
  "closings",
  {
    ...entity(),
    opportunity_id: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "restrict" }),
    property_id: fk("property_id", () => properties.id),
    // Other Release-3/4 modules: plain UUIDs keep this table independent of their load order.
    offer_id: uuid("offer_id"),
    uw_model_id: uuid("uw_model_id"),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    coordinator_id: fk("coordinator_id", () => users.id),
    manager_id: fk("manager_id", () => users.id), // responsible asset manager after closing
    scheduled_closing_on: date("scheduled_closing_on", { mode: "string" }),

    purchase_price: numericFloat("purchase_price", 16, 2),
    sources: jsonb("sources").$type<any[]>().notNull().$defaultFn(() => []), // [{label, kind, amount}]
    uses: jsonb("uses").$type<any[]>().notNull().$defaultFn(() => []), // [{label, kind, amount, capitalized}]
    total_sources: numericFloat("total_sources", 16, 2),
    total_uses: numericFloat("total_uses", 16, 2),
    basis: numericFloat("basis", 16, 2),
    capital_structure: jsonb("capital_structure").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),

    hold_thesis: text("hold_thesis"),
    business_plan: text("business_plan"),
    target_hold_years: doublePrecision("target_hold_years"),
    notes: text("notes"),

    closed_on: date("closed_on", { mode: "string" }),
    completed_at: tz("completed_at"),
    completed_by_id: fk("completed_by_id", () => users.id),
    asset_id: uuid("asset_id"),
    asset_pending: boolean("asset_pending").notNull().$defaultFn(() => false),
    asset_error: text("asset_error"),

    audit_task_id: uuid("audit_task_id"),
    audit_due_on: date("audit_due_on", { mode: "string" }),
    audit_result: jsonb("audit_result").$type<Record<string, any> | null>(),
    audit_completed_at: tz("audit_completed_at"),
    audit_completed_by_id: fk("audit_completed_by_id", () => users.id),
  },
  (t) => [
    index("ix_closings_deleted_at").on(t.deleted_at),
    index("ix_closings_opportunity_id").on(t.opportunity_id),
    index("ix_closings_property_id").on(t.property_id),
    index("ix_closings_offer_id").on(t.offer_id),
    index("ix_closings_uw_model_id").on(t.uw_model_id),
    index("ix_closings_status").on(t.status),
    index("ix_closings_coordinator_id").on(t.coordinator_id),
    index("ix_closings_manager_id").on(t.manager_id),
    index("ix_closings_scheduled_closing_on").on(t.scheduled_closing_on),
    index("ix_closings_asset_id").on(t.asset_id),
    index("ix_closings_asset_pending").on(t.asset_pending),
  ],
);
export type Closing = typeof closings.$inferSelect;

export const closingChecklistItems = pgTable(
  "closing_checklist_items",
  {
    ...entity(),
    closing_id: uuid("closing_id").notNull().references(() => closings.id, { onDelete: "cascade" }),
    template_key: varchar("template_key", { length: 40 }),
    category: varchar("category", { length: 30 }).notNull().$defaultFn(() => "other"),
    title: varchar("title", { length: 300 }).notNull(),
    owner_id: fk("owner_id", () => users.id),
    due_on: date("due_on", { mode: "string" }),
    status: varchar("status", { length: 20 }).notNull().$defaultFn(() => "open"),
    is_blocking: boolean("is_blocking").notNull().$defaultFn(() => false),
    document_id: uuid("document_id"),
    notes: text("notes"),
    waived_reason: text("waived_reason"),
    completed_at: tz("completed_at"),
    completed_by_id: fk("completed_by_id", () => users.id),
    sort_order: integer("sort_order").notNull().$defaultFn(() => 0),
  },
  (t) => [
    index("ix_closing_checklist_items_deleted_at").on(t.deleted_at),
    index("ix_closing_checklist_items_closing_id").on(t.closing_id),
    index("ix_closing_checklist_items_category").on(t.category),
    index("ix_closing_checklist_items_owner_id").on(t.owner_id),
    index("ix_closing_checklist_items_status").on(t.status),
  ],
);
export type ClosingChecklistItem = typeof closingChecklistItems.$inferSelect;

/** Wire instructions plus an independent callback. Rows are never edited: new instructions supersede. */
export const wireVerifications = pgTable(
  "wire_verifications",
  {
    ...entity(),
    closing_id: uuid("closing_id").notNull().references(() => closings.id, { onDelete: "cascade" }),
    is_current: boolean("is_current").notNull().$defaultFn(() => true),
    // Instructions as received
    beneficiary_name: varchar("beneficiary_name", { length: 200 }).notNull(),
    bank_name: varchar("bank_name", { length: 200 }).notNull(),
    routing_number: varchar("routing_number", { length: 20 }).notNull(),
    account_number: varchar("account_number", { length: 40 }).notNull(),
    amount: numericFloat("amount", 16, 2),
    instruction_source: varchar("instruction_source", { length: 200 }).notNull(), // how / from where the instructions arrived
    instruction_received_from: varchar("instruction_received_from", { length: 200 }),
    instruction_contact_phone: varchar("instruction_contact_phone", { length: 40 }),
    received_at: tz("received_at").notNull().$defaultFn(() => new Date()),
    // Independent callback
    callback_phone: varchar("callback_phone", { length: 40 }),
    callback_phone_source: varchar("callback_phone_source", { length: 200 }),
    callback_contact_name: varchar("callback_contact_name", { length: 200 }),
    verified_by_id: fk("verified_by_id", () => users.id),
    verified_by_name: varchar("verified_by_name", { length: 200 }),
    verified_at: tz("verified_at"),
    result: varchar("result", { length: 20 }).notNull().$defaultFn(() => "pending"),
    result_notes: text("result_notes"),
  },
  (t) => [
    index("ix_wire_verifications_deleted_at").on(t.deleted_at),
    index("ix_wire_verifications_closing_id").on(t.closing_id),
    index("ix_wire_verifications_is_current").on(t.is_current),
    index("ix_wire_verifications_result").on(t.result),
  ],
);
export type WireVerification = typeof wireVerifications.$inferSelect;

/** Immutable final transaction state. There is intentionally no update or delete path. */
export const closingSnapshots = pgTable(
  "closing_snapshots",
  {
    id: pk(),
    closing_id: uuid("closing_id").notNull().references(() => closings.id, { onDelete: "restrict" }),
    created_at: tz("created_at").notNull().$defaultFn(() => new Date()),
    created_by_id: fk("created_by_id", () => users.id),
    created_by_name: varchar("created_by_name", { length: 200 }),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    data: jsonb("data").$type<Record<string, any>>().notNull(),
  },
  (t) => [uniqueIndex("ix_closing_snapshots_closing_id").on(t.closing_id)],
);
export type ClosingSnapshot = typeof closingSnapshots.$inferSelect;

/** Operations handoff: what the operating team receives instead of re-entering acquisition knowledge. */
export const handoffPackages = pgTable(
  "handoff_packages",
  {
    ...entity(),
    closing_id: uuid("closing_id").notNull().references(() => closings.id, { onDelete: "cascade" }),
    asset_id: uuid("asset_id"),
    property_id: fk("property_id", () => properties.id),
    // {section_key: {"items": [{label, detail, document_id, status}], "notes": str}}
    sections: jsonb("sections").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    open_dd_items: jsonb("open_dd_items").$type<any[]>().notNull().$defaultFn(() => []),
    carry_forward: jsonb("carry_forward").$type<Record<string, any>>().notNull().$defaultFn(() => ({})),
    generated_at: tz("generated_at").notNull().$defaultFn(() => new Date()),
    recipient_id: fk("recipient_id", () => users.id),
    acknowledged_at: tz("acknowledged_at"),
    acknowledged_by_id: fk("acknowledged_by_id", () => users.id),
  },
  (t) => [
    index("ix_handoff_packages_deleted_at").on(t.deleted_at),
    uniqueIndex("ix_handoff_packages_closing_id").on(t.closing_id),
    index("ix_handoff_packages_asset_id").on(t.asset_id),
    index("ix_handoff_packages_property_id").on(t.property_id),
    index("ix_handoff_packages_recipient_id").on(t.recipient_id),
  ],
);
export type HandoffPackage = typeof handoffPackages.$inferSelect;
