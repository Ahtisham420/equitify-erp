import { z } from "zod";

// Response (Out) shapes are built by plain mappers in service.ts; only request bodies are validated here.

export const triggerUpdate = z.object({ params: z.record(z.string(), z.any()) });
export type TriggerUpdate = z.infer<typeof triggerUpdate>;

export const cancelIn = z.object({ reason: z.string().min(3).max(2000) });
export type CancelIn = z.infer<typeof cancelIn>;

export const armIn = z.object({
  trigger_type: z.string().nullish(),
  params: z.record(z.string(), z.any()).nullish(),
});
export type ArmIn = z.infer<typeof armIn>;

export const reactivateIn = z.object({
  to_stage: z.string(),
  override_reason: z.string().max(2000).nullish(),
  note: z.string().max(2000).nullish(),
  fields: z.record(z.string(), z.any()).default({}),
});
export type ReactivateIn = z.infer<typeof reactivateIn>;

export const snoozeIn = z.object({
  until: z.string().date(),
  reason: z.string().max(2000).nullish(),
});
export type SnoozeIn = z.infer<typeof snoozeIn>;

export const dismissIn = z.object({
  reason: z.string().min(3).max(2000),
  rearm: z.boolean().default(true),
});
export type DismissIn = z.infer<typeof dismissIn>;
