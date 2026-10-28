/**
 * Read-only column subsets of tables owned by other modules (maintenance, assets, leases, documents, tasks).
 * Python guarded these cross-module reads with `try: import ... except ImportError`; here they are plain
 * table projections of the same Postgres tables, so this module does not depend on the sibling ports' files.
 * Never used for DDL.
 */
import { date, doublePrecision, integer, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { numericFloat, tz } from "../../db/columns";

export const workOrders = pgTable("work_orders", {
  id: uuid("id").primaryKey(),
  number: integer("number"),
  title: varchar("title", { length: 200 }),
  status: varchar("status", { length: 20 }),
  vendor_id: uuid("vendor_id"),
  due_on: date("due_on", { mode: "string" }),
  assigned_at: tz("assigned_at"),
  actual_cost: numericFloat("actual_cost", 16, 2),
  completed_at: tz("completed_at"),
  satisfaction_rating: integer("satisfaction_rating"),
  created_at: tz("created_at"),
  deleted_at: tz("deleted_at"),
});

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey(),
  property_id: uuid("property_id"),
});

export const assetFinancials = pgTable("asset_financials", {
  id: uuid("id").primaryKey(),
  asset_id: uuid("asset_id"),
  period: date("period", { mode: "string" }),
  account: varchar("account", { length: 120 }),
  category: varchar("category", { length: 20 }),
  amount: numericFloat("amount", 16, 2),
  deleted_at: tz("deleted_at"),
});

export const leases = pgTable("leases", {
  id: uuid("id").primaryKey(),
  property_id: uuid("property_id"),
  status: varchar("status", { length: 20 }),
  lease_type: varchar("lease_type", { length: 30 }),
  tenant_name: varchar("tenant_name", { length: 200 }),
  rentable_sf: numericFloat("rentable_sf", 14, 2),
  deleted_at: tz("deleted_at"),
});

export const leaseRecoveries = pgTable("lease_recoveries", {
  id: uuid("id").primaryKey(),
  lease_id: uuid("lease_id"),
  category: varchar("category", { length: 20 }),
  pro_rata_share: doublePrecision("pro_rata_share"),
  notes: text("notes"),
  deleted_at: tz("deleted_at"),
});

export const leaseClauses = pgTable("lease_clauses", {
  id: uuid("id").primaryKey(),
  lease_id: uuid("lease_id"),
  summary: text("summary"),
  quoted_text: text("quoted_text"),
  deleted_at: tz("deleted_at"),
});

export const documentLinks = pgTable("document_links", {
  id: uuid("id").primaryKey(),
  document_id: uuid("document_id"),
  entity_type: varchar("entity_type", { length: 40 }),
  entity_id: uuid("entity_id"),
});

export const alertsRef = pgTable("alerts", {
  id: uuid("id").primaryKey(),
  idempotency_key: varchar("idempotency_key", { length: 200 }),
});
