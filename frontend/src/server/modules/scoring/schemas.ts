import { z } from "zod";

// Response (Out) shapes are built by plain mappers in service.ts / router.ts; only request bodies are validated here.

export const configIn = z.object({
  name: z.string().min(1).max(160),
  weights: z.record(z.string(), z.number()),
  band_thresholds: z.record(z.string(), z.number()).default({ high: 0.75, medium: 0.5 }),
  alert_threshold: z.number().min(0).max(100).default(75),
  high_dollar_threshold: z.number().min(0).default(5_000_000),
  notes: z.string().nullish(),
});
export type ConfigIn = z.infer<typeof configIn>;

export const rejectIn = z.object({ reason: z.string().min(3).max(2000) });
export type RejectIn = z.infer<typeof rejectIn>;

export const outcomeIn = z.object({
  property_id: z.string().uuid(),
  opportunity_id: z.string().uuid().nullish(),
  disposition: z.string().min(1).max(40),
  result: z.enum(["open", "won", "lost"]).default("open"),
  notes: z.string().nullish(),
});
export type OutcomeIn = z.infer<typeof outcomeIn>;
