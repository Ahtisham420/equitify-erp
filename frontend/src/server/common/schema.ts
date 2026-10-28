/** Cross-module tables: immutable audit trail and field-level provenance. */
import { boolean, date, index, jsonb, pgTable, real, text, uuid, varchar } from "drizzle-orm/pg-core";

import { pk, tz } from "../db/columns";
import { users } from "../modules/auth/schema";

/** Immutable audit trail. There is intentionally no update/delete path for this table. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: pk(),
    occurred_at: tz("occurred_at").notNull().$defaultFn(() => new Date()),
    actor_id: uuid("actor_id"),
    actor_name: varchar("actor_name", { length: 200 }),
    action: varchar("action", { length: 80 }).notNull(),
    entity_type: varchar("entity_type", { length: 60 }).notNull(),
    entity_id: uuid("entity_id"),
    summary: text("summary"),
    changes: jsonb("changes"),
    ip_address: varchar("ip_address", { length: 64 }),
  },
  (t) => [
    index("ix_audit_events_occurred_at").on(t.occurred_at),
    index("ix_audit_events_actor_id").on(t.actor_id),
    index("ix_audit_events_action").on(t.action),
    index("ix_audit_events_entity_type").on(t.entity_type),
    index("ix_audit_events_entity_id").on(t.entity_id),
  ],
);

export const fieldObservations = pgTable(
  "field_observations",
  {
    id: pk(),
    entity_type: varchar("entity_type", { length: 60 }).notNull(),
    entity_id: uuid("entity_id").notNull(),
    field: varchar("field", { length: 80 }).notNull(),
    value: jsonb("value"),
    source: varchar("source", { length: 200 }).notNull(),
    observed_on: date("observed_on", { mode: "string" }),
    confidence: real("confidence").notNull().$defaultFn(() => 0.5),
    verification: varchar("verification", { length: 20 }).notNull().$defaultFn(() => "unverified"),
    ai_derived: boolean("ai_derived").notNull().$defaultFn(() => false),
    is_current: boolean("is_current").notNull().$defaultFn(() => true),
    recorded_at: tz("recorded_at").notNull().$defaultFn(() => new Date()),
    recorded_by_id: uuid("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
    verified_by_id: uuid("verified_by_id").references(() => users.id, { onDelete: "set null" }),
    verified_at: tz("verified_at"),
  },
  (t) => [
    index("ix_field_observations_entity_type").on(t.entity_type),
    index("ix_field_observations_entity_id").on(t.entity_id),
    index("ix_field_observations_field").on(t.field),
    index("ix_field_observations_verification").on(t.verification),
    index("ix_field_observations_is_current").on(t.is_current),
  ],
);
