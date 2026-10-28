import { z } from "zod";

const operator = z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "contains", "is_set"]);
const requirement = z.enum(["mandatory", "preferred", "disqualifying"]);

const isBlank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
/** Python `bool(v)` */
const truthy = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v);

export const criterionIn = z
  .object({
    field: z.string().min(1).max(60),
    operator,
    value: z.any().optional(),
    requirement: requirement.default("mandatory"),
    note: z.string().max(300).nullish(),
  })
  .superRefine((c, ctx) => {
    const op = c.operator;
    const v = c.value;
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if ((op === "in" || op === "not_in") && !(Array.isArray(v) && v.length)) {
      bad(`'${op}' needs a non-empty list of values`);
    } else if (
      op === "between" &&
      !(Array.isArray(v) && v.length === 2 && v.every((x) => x !== null && x !== undefined && x !== ""))
    ) {
      bad("'between' needs [min, max]");
    } else if (op !== "is_set" && op !== "in" && op !== "not_in" && op !== "between" && isBlank(v)) {
      bad(`'${op}' needs a value`);
    }
  })
  .transform((c) => ({
    field: c.field,
    operator: c.operator,
    value: c.operator === "is_set" ? (c.value === null || c.value === undefined ? true : truthy(c.value)) : (c.value ?? null),
    requirement: c.requirement,
    note: c.note ?? null,
  }));
export type CriterionIn = z.infer<typeof criterionIn>;

export const criteriaReplace = z.object({
  criteria: z.array(criterionIn).max(100),
  change_note: z.string().nullish(),
});
export type CriteriaReplace = z.infer<typeof criteriaReplace>;

export const buyBoxCreate = z
  .object({
    name: z.string().min(1).max(160),
    description: z.string().nullish(),
    strategy: z.string().min(1).max(60).default("other"),
    owner_id: z.string().uuid().nullish(),
    active_from: z.string().date().nullish(),
    active_to: z.string().date().nullish(),
    is_active: z.boolean().default(true),
    criteria: z.array(criterionIn).max(100).default([]),
  })
  .superRefine((b, ctx) => {
    if (b.active_from && b.active_to && b.active_to < b.active_from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "active_to must be on or after active_from" });
    }
  });
export type BuyBoxCreate = z.infer<typeof buyBoxCreate>;

export const buyBoxUpdate = z
  .object({
    name: z.string().min(1).max(160).nullish(),
    description: z.string().nullish(),
    strategy: z.string().min(1).max(60).nullish(),
    owner_id: z.string().uuid().nullish(),
    active_from: z.string().date().nullish(),
    active_to: z.string().date().nullish(),
    is_active: z.boolean().nullish(),
  })
  .strict();
export type BuyBoxUpdate = z.infer<typeof buyBoxUpdate>;

export const exceptionRequestIn = z.object({ reason: z.string().min(3).max(2000) });
export const exceptionDecisionIn = z.object({ approve: z.boolean(), reason: z.string().min(3).max(2000) });
