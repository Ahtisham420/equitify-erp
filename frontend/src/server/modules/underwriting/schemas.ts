import { z } from "zod";

export const TEMPLATE_KEYS = ["stnl", "multi_tenant_retail", "gas_convenience", "medical", "ground_lease", "land"] as const;
const template = z.enum(TEMPLATE_KEYS);

export const modelCreate = z.object({
  name: z.string().min(1).max(200),
  template,
  property_id: z.string().uuid().nullish(),
  opportunity_id: z.string().uuid().nullish(),
  comp_set_id: z.string().uuid().nullish(),
  analysis_start: z.string().date().nullish(),
  seed_tenants: z.enum(["auto", "spaces", "leases", "none"]).default("auto"),
});
export type ModelCreate = z.infer<typeof modelCreate>;

export const modelUpdate = z
  .object({
    name: z.string().min(1).max(200).nullish(),
    opportunity_id: z.string().uuid().nullish(),
  })
  .strict();
export type ModelUpdate = z.infer<typeof modelUpdate>;

export const assumptionsIn = z.object({
  assumptions: z.record(z.string(), z.any()),
  change_note: z.string().max(2000).nullish(),
});
export type AssumptionsIn = z.infer<typeof assumptionsIn>;

export const scenarioIn = z.object({
  key: z.string().max(60).nullish(),
  name: z.string().min(1).max(120),
  kind: z.enum(["base", "downside", "upside", "named"]).default("named"),
  overrides: z.record(z.string(), z.any()).default({}),
});
export type ScenarioIn = z.infer<typeof scenarioIn>;

export const scenariosIn = z.object({
  scenarios: z.array(scenarioIn).max(20),
  change_note: z.string().nullish(),
});
export type ScenariosIn = z.infer<typeof scenariosIn>;

export const newVersionIn = z.object({
  change_note: z.string().max(2000).nullish(),
});
export type NewVersionIn = z.infer<typeof newVersionIn>;

export const decisionIn = z.object({
  note: z.string().max(4000).nullish(),
  acknowledge_unsourced: z.boolean().default(false),
});
export type DecisionIn = z.infer<typeof decisionIn>;

export const simulationRange = z.object({
  path: z.string().min(1).max(200),
  label: z.string().nullish(),
  min: z.number(),
  max: z.number(),
  mode: z.number().nullish(),
});
export type SimulationRange = z.infer<typeof simulationRange>;

export const simulateIn = z.object({
  iterations: z.number().int().min(10).max(2000).default(500),
  seed: z.number().int().default(1),
  ranges: z.array(simulationRange).min(1).max(12),
  target_irr: z.number().nullish(),
  scenario_key: z.string().nullish(),
});
export type SimulateIn = z.infer<typeof simulateIn>;
