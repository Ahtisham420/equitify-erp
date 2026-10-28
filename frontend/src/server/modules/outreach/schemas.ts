import { z } from "zod";

import { dt } from "../tasks/schemas";

const uuid = z.string().uuid();

export const channel = z.enum(["call", "email", "sms", "meeting", "tour", "letter", "note"]);
export const direction = z.enum(["outbound", "inbound", "internal"]);
export const disposition = z.enum([
  "connected", "voicemail", "no_answer", "wrong_number", "gatekeeper", "not_interested", "callback",
  "information_requested", "offer_requested",
]);

export const interactionCreate = z.object({
  channel,
  direction: direction.default("outbound"),
  occurred_at: dt.nullish(),
  person_id: uuid.nullish(),
  organization_id: uuid.nullish(),
  property_id: uuid.nullish(),
  opportunity_id: uuid.nullish(),
  contact_point_id: uuid.nullish(),
  contact_value: z.string().max(320).nullish(),
  disposition: disposition.nullish(),
  subject: z.string().max(300).nullish(),
  summary: z.string().max(20000).nullish(),
  duration_seconds: z.number().int().min(0).nullish(),
  next_action: z.string().max(300).nullish(),
  next_action_at: dt.nullish(),
  loop_closed: z.boolean().default(false),
  closed_reason: z.string().max(4000).nullish(),
  sequence_enrollment_id: uuid.nullish(),
  // Queue flow: completes this task as part of logging (skipped while it has open dependencies).
  complete_task_id: uuid.nullish(),
});
export type InteractionCreate = z.infer<typeof interactionCreate>;

/** Interactions are history; only narrative and follow-up fields may change afterwards. */
export const interactionUpdate = z
  .object({
    subject: z.string().max(300).nullish(),
    summary: z.string().max(20000).nullish(),
    next_action: z.string().max(300).nullish(),
    next_action_at: dt.nullish(),
    loop_closed: z.boolean().nullish(),
    closed_reason: z.string().max(4000).nullish(),
  })
  .strict();
export type InteractionUpdate = z.infer<typeof interactionUpdate>;

export const sequenceStep = z.object({
  channel: z.enum(["call", "email", "sms", "letter"]),
  delay_days: z.number().int().min(0).max(365),
  template: z.string().max(10000).nullish(),
});
export type SequenceStep = z.infer<typeof sequenceStep>;

export const sequenceIn = z.object({
  name: z.string().min(1).max(160),
  description: z.string().nullish(),
  status: z.enum(["active", "paused", "archived"]).default("active"),
  steps: z.array(sequenceStep).max(30).default([]),
  enrollment_cap: z.number().int().min(1).max(100000).nullish(),
  exit_dispositions: z.array(disposition).default([]),
});
export type SequenceIn = z.infer<typeof sequenceIn>;

export const enrollIn = z.object({
  person_ids: z.array(uuid).min(1).max(500),
  owner_id: uuid.nullish(),
});
export type EnrollIn = z.infer<typeof enrollIn>;

export const exitIn = z.object({ reason: z.string().min(2).max(200) });
export type ExitIn = z.infer<typeof exitIn>;
