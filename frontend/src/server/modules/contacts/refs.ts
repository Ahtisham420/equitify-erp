/**
 * Minimal column maps of tables owned by sibling modules (outreach, pipeline, tasks). The contact context view
 * only reads a handful of their columns; declaring them here keeps contacts independent of those modules' schema
 * files. They are never created from here (this file is not part of the schema glob).
 */
import { boolean, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { tz } from "../../db/columns";

export const interactionsRef = pgTable("interactions", {
  id: uuid("id").primaryKey(),
  channel: varchar("channel", { length: 10 }),
  direction: varchar("direction", { length: 10 }),
  occurred_at: tz("occurred_at"),
  person_id: uuid("person_id"),
  organization_id: uuid("organization_id"),
  property_id: uuid("property_id"),
  opportunity_id: uuid("opportunity_id"),
  disposition: varchar("disposition", { length: 30 }),
  summary: text("summary"),
  is_meaningful: boolean("is_meaningful"),
  next_action_at: tz("next_action_at"),
  loop_closed: boolean("loop_closed"),
  deleted_at: tz("deleted_at"),
});

export const opportunitiesRef = pgTable("opportunities", {
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 255 }),
  property_id: uuid("property_id"),
  stage: varchar("stage", { length: 30 }),
  primary_person_id: uuid("primary_person_id"),
  primary_organization_id: uuid("primary_organization_id"),
  source: varchar("source", { length: 80 }),
  next_action_at: tz("next_action_at"),
  deleted_at: tz("deleted_at"),
});

export const tasksRef = pgTable("tasks", {
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 300 }),
  status: varchar("status", { length: 20 }),
  priority: varchar("priority", { length: 10 }),
  due_at: tz("due_at"),
  assignee_id: uuid("assignee_id"),
  related_type: varchar("related_type", { length: 40 }),
  related_id: uuid("related_id"),
  deleted_at: tz("deleted_at"),
});
