import { z } from "zod";

/** ISO datetime (naive values are taken as UTC, like the Python `_aware` helpers) -> Date. */
export const dt = z.preprocess(
  (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v) ? `${v}Z` : v),
  z.coerce.date(),
);

const uuid = z.string().uuid();

export const taskStatus = z.enum(["open", "in_progress", "done", "cancelled"]);
export const taskPriority = z.enum(["low", "normal", "high", "urgent"]);
export const taskType = z.enum(["follow_up", "call", "research", "review", "approval", "due_diligence", "general"]);
export const severity = z.enum(["low", "medium", "high", "critical"]);
export const resolutionKind = z.enum(["actioned", "not_actionable", "duplicate", "false_positive"]);
export const subscriptionChannel = z.enum(["in_app", "email", "digest"]);

export const taskCreate = z.object({
  title: z.string().min(1).max(300),
  description: z.string().nullish(),
  task_type: taskType.default("general"),
  priority: taskPriority.default("normal"),
  due_at: dt.nullish(),
  assignee_id: uuid.nullish(),
  related_type: z.string().max(40).nullish(),
  related_id: uuid.nullish(),
  related_label: z.string().max(300).nullish(),
  depends_on: z.array(uuid).default([]),
});
export type TaskCreate = z.infer<typeof taskCreate>;

export const taskUpdate = z
  .object({
    title: z.string().min(1).max(300).nullish(),
    description: z.string().nullish(),
    task_type: taskType.nullish(),
    priority: taskPriority.nullish(),
    status: z.enum(["open", "in_progress"]).nullish(),
    due_at: dt.nullish(),
    assignee_id: uuid.nullish(),
    related_type: z.string().nullish(),
    related_id: uuid.nullish(),
    related_label: z.string().nullish(),
    depends_on: z.array(uuid).nullish(),
  })
  .strict();
export type TaskUpdate = z.infer<typeof taskUpdate>;

export const resolutionIn = z.object({ note: z.string().max(4000).nullish() });
export type ResolutionIn = z.infer<typeof resolutionIn>;

export const cancelIn = z.object({ note: z.string().min(3).max(4000) });
export type CancelIn = z.infer<typeof cancelIn>;

export const alertResolveIn = z.object({
  note: z.string().min(3).max(4000),
  kind: resolutionKind.default("actioned"),
});
export type AlertResolveIn = z.infer<typeof alertResolveIn>;

export const alertAckIn = z.object({ note: z.string().max(2000).nullish() });
export type AlertAckIn = z.infer<typeof alertAckIn>;

export const ruleUpdate = z
  .object({
    enabled: z.boolean().nullish(),
    thresholds: z.record(z.any()).nullish(),
  })
  .strict();
export type RuleUpdate = z.infer<typeof ruleUpdate>;

export const subscriptionIn = z.object({
  name: z.string().min(1).max(160),
  subscriber_id: uuid.nullish(),
  territory_id: uuid.nullish(),
  property_types: z.array(z.string()).default([]),
  tenant: z.string().max(200).nullish(),
  owner_id: uuid.nullish(),
  saved_view_id: uuid.nullish(),
  rule_keys: z.array(z.string()).default([]),
  min_severity: severity.default("low"),
  channel: subscriptionChannel.default("in_app"),
  is_active: z.boolean().default(true),
});
export type SubscriptionIn = z.infer<typeof subscriptionIn>;
