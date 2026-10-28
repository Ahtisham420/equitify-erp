import { z } from "zod";

export const loginIn = z.object({
  // Plain string: sign-in only looks the address up, and seeded/internal accounts may use reserved domains.
  email: z.string().min(3).max(255),
  password: z.string().min(1).max(200),
});

export const mfaVerifyIn = z.object({
  mfa_token: z.string(),
  code: z.string().min(6).max(8),
});

export const userCreate = z.object({
  email: z.string().email(),
  full_name: z.string().min(1).max(200),
  password: z.string().min(8).max(200).nullish(),
  job_title: z.string().nullish(),
  phone: z.string().nullish(),
  role_id: z.string().uuid(),
  team_id: z.string().uuid().nullish(),
  manager_id: z.string().uuid().nullish(),
  is_service: z.boolean().default(false),
});
export type UserCreate = z.infer<typeof userCreate>;

export const userUpdate = z.object({
  full_name: z.string().min(1).max(200).nullish(),
  job_title: z.string().nullish(),
  phone: z.string().nullish(),
  role_id: z.string().uuid().nullish(),
  team_id: z.string().uuid().nullish(),
  manager_id: z.string().uuid().nullish(),
  password: z.string().min(8).max(200).nullish(),
});
export type UserUpdate = z.infer<typeof userUpdate>;

export const deactivateIn = z.object({
  reassign_to_id: z.string().uuid().nullish(),
  reason: z.string().nullish(),
});
export type DeactivateIn = z.infer<typeof deactivateIn>;

export const roleIn = z.object({
  key: z.string().min(2).max(60).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(120),
  description: z.string().nullish(),
  permissions: z.record(z.array(z.string())).default({}),
  approval_limits: z.record(z.any()).default({}),
});
export type RoleIn = z.infer<typeof roleIn>;

export const roleUpdate = z.object({
  name: z.string().optional(),
  description: z.string().nullish(),
  permissions: z.record(z.array(z.string())).optional(),
  approval_limits: z.record(z.any()).optional(),
});
export type RoleUpdate = z.infer<typeof roleUpdate>;

export const teamIn = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullish(),
});

export const credentialIn = z.object({
  name: z.string().min(1).max(120),
  user_id: z.string().uuid(),
  scopes: z.array(z.string()).default([]),
});
export type CredentialIn = z.infer<typeof credentialIn>;
