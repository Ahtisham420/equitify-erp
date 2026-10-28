import { z } from "zod";

export const savedViewIn = z.object({
  name: z.string().min(1).max(160),
  module: z.string().min(1).max(60),
  params: z.record(z.any()).default({}),
  visibility: z.string().regex(/^(private|team|company)$/).default("private"),
  is_default: z.boolean().default(false),
});
export type SavedViewIn = z.infer<typeof savedViewIn>;
