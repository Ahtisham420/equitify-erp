import { boolean, index, integer, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";

import { tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { organizations, people } from "../contacts/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { tasks } from "../tasks/schema";

export const CHANNELS = ["call", "email", "sms", "meeting", "tour", "letter", "note"] as const;
export const DIRECTIONS = ["outbound", "inbound", "internal"] as const;
export const DISPOSITIONS = [
  "connected", "voicemail", "no_answer", "wrong_number", "gatekeeper", "not_interested", "callback",
  "information_requested", "offer_requested",
] as const;
export const MEANINGFUL_DISPOSITIONS = new Set(["connected", "callback", "information_requested", "offer_requested"]);
export const MEANINGFUL_CHANNELS = new Set(["meeting", "tour"]);
// Any of these ends an automated sequence for the person (a human conversation has happened or must not continue).
export const EXIT_DISPOSITIONS = new Set([
  "connected", "callback", "information_requested", "offer_requested", "not_interested", "wrong_number",
]);
// Outreach channel -> compliance channel for send-time checks.
export const COMPLIANCE_CHANNEL: Record<string, string> = { call: "phone", sms: "sms", email: "email" };
export const SEQUENCE_STATUSES = ["active", "paused", "archived"] as const;
export const ENROLLMENT_STATUSES = ["active", "paused", "completed", "exited"] as const;

/** A relationship touchpoint. Meaningful ones must carry a next action or an explicit loop closure. */
export const interactions = pgTable(
  "interactions",
  {
    ...entity(),
    channel: varchar("channel", { length: 10 }).notNull(),
    direction: varchar("direction", { length: 10 }).notNull().$defaultFn(() => "outbound"),
    occurred_at: tz("occurred_at").notNull().$defaultFn(() => new Date()),
    person_id: fk("person_id", () => people.id),
    organization_id: fk("organization_id", () => organizations.id),
    property_id: fk("property_id", () => properties.id),
    opportunity_id: fk("opportunity_id", () => opportunities.id),
    contact_point_id: uuid("contact_point_id"),
    contact_value: varchar("contact_value", { length: 320 }),
    disposition: varchar("disposition", { length: 30 }),
    subject: varchar("subject", { length: 300 }),
    summary: text("summary"),
    duration_seconds: integer("duration_seconds"),
    is_meaningful: boolean("is_meaningful").notNull().$defaultFn(() => false),
    next_action: varchar("next_action", { length: 300 }),
    next_action_at: tz("next_action_at"),
    follow_up_task_id: fk("follow_up_task_id", () => tasks.id),
    loop_closed: boolean("loop_closed").notNull().$defaultFn(() => false),
    closed_reason: text("closed_reason"),
    logged_by_id: fk("logged_by_id", () => users.id),
    sequence_enrollment_id: uuid("sequence_enrollment_id"),
    compliance_reasons: jsonb("compliance_reasons").$type<any[]>().notNull().$defaultFn(() => []),
  },
  (t) => [
    index("ix_interactions_deleted_at").on(t.deleted_at),
    index("ix_interactions_channel").on(t.channel),
    index("ix_interactions_direction").on(t.direction),
    index("ix_interactions_occurred_at").on(t.occurred_at),
    index("ix_interactions_person_id").on(t.person_id),
    index("ix_interactions_organization_id").on(t.organization_id),
    index("ix_interactions_property_id").on(t.property_id),
    index("ix_interactions_opportunity_id").on(t.opportunity_id),
    index("ix_interactions_disposition").on(t.disposition),
    index("ix_interactions_is_meaningful").on(t.is_meaningful),
    index("ix_interactions_next_action_at").on(t.next_action_at),
    index("ix_interactions_follow_up_task_id").on(t.follow_up_task_id),
    index("ix_interactions_logged_by_id").on(t.logged_by_id),
    index("ix_interactions_sequence_enrollment_id").on(t.sequence_enrollment_id),
  ],
);
export type Interaction = typeof interactions.$inferSelect;

export interface SequenceStepData {
  channel: string;
  delay_days: number;
  template?: string | null;
}

/** Structured multi-step, multi-channel outreach plan. Steps: [{channel, delay_days, template}]. */
export const sequences = pgTable(
  "sequences",
  {
    ...entity(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 10 }).notNull().$defaultFn(() => "active"),
    steps: jsonb("steps").$type<SequenceStepData[]>().notNull().$defaultFn(() => []),
    enrollment_cap: integer("enrollment_cap"),
    exit_dispositions: varchar("exit_dispositions", { length: 30 }).array().notNull().$defaultFn(() => []),
    owner_id: fk("owner_id", () => users.id),
  },
  (t) => [
    index("ix_sequences_deleted_at").on(t.deleted_at),
    index("ix_sequences_status").on(t.status),
    index("ix_sequences_owner_id").on(t.owner_id),
  ],
);
export type Sequence = typeof sequences.$inferSelect;

export const sequenceEnrollments = pgTable(
  "sequence_enrollments",
  {
    ...entity(),
    sequence_id: fk("sequence_id", () => sequences.id, { notNull: true, onDelete: "cascade" }),
    person_id: fk("person_id", () => people.id, { notNull: true, onDelete: "cascade" }),
    owner_id: fk("owner_id", () => users.id),
    status: varchar("status", { length: 10 }).notNull().$defaultFn(() => "active"),
    current_step: integer("current_step").notNull().$defaultFn(() => 0),
    next_step_at: tz("next_step_at"),
    enrolled_at: tz("enrolled_at").notNull().$defaultFn(() => new Date()),
    exited_at: tz("exited_at"),
    exit_reason: varchar("exit_reason", { length: 200 }),
    last_step_at: tz("last_step_at"),
  },
  (t) => [
    index("ix_sequence_enrollments_deleted_at").on(t.deleted_at),
    index("ix_sequence_enrollments_sequence_id").on(t.sequence_id),
    index("ix_sequence_enrollments_person_id").on(t.person_id),
    index("ix_sequence_enrollments_owner_id").on(t.owner_id),
    index("ix_sequence_enrollments_status").on(t.status),
    index("ix_sequence_enrollments_next_step_at").on(t.next_step_at),
  ],
);
export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect;
