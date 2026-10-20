"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const APPROVAL_KINDS = [
  { key: "underwriting", label: "Underwriting" },
  { key: "offer", label: "Offers" },
  { key: "capital", label: "Capital actions" },
] as const;

export const USER_STATUSES = ["active", "inactive"] as const;

export interface RoleBrief {
  id: string;
  key: string;
  name: string;
}

export interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  job_title: string | null;
  phone: string | null;
  role: RoleBrief;
  team_id: string | null;
  manager_id: string | null;
  status: string;
  is_service: boolean;
  mfa_enabled: boolean;
  last_login_at: string | null;
  deactivated_at: string | null;
  created_at: string;
}

export interface UserInput {
  email?: string;
  full_name?: string;
  password?: string | null;
  job_title?: string | null;
  phone?: string | null;
  role_id?: string;
  team_id?: string | null;
  manager_id?: string | null;
  is_service?: boolean;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: Record<string, string[]>;
  approval_limits: Record<string, number | null>;
  is_system: boolean;
  user_count: number;
}

export interface RoleInput {
  key?: string;
  name?: string;
  description?: string | null;
  permissions?: Record<string, string[]>;
  approval_limits?: Record<string, number | null>;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  member_count: number;
}

export interface Credential {
  id: string;
  name: string;
  user_id: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CredentialCreated extends Credential {
  api_key: string;
}

export interface UserSession {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface PermissionCatalog {
  modules: Record<string, string>;
  actions: string[];
}

export const ACTION_LABELS: Record<string, string> = {
  view: "View", create: "Create", edit: "Edit", approve: "Approve", export: "Export", delete: "Delete", view_sensitive: "Sensitive",
};

/** True when a role/scope permission map grants `action` on `module` (wildcards included). */
export function grants(perms: Record<string, string[]>, module: string, action: string): boolean {
  if (perms["*"]?.includes("*")) return true;
  const granted = perms[module] ?? [];
  return granted.includes("*") || granted.includes(action);
}

/* ------------------------------------------------------------------ queries */

export function useRoles() {
  return useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles"), staleTime: 60_000 });
}

export function useTeams() {
  return useQuery({ queryKey: ["teams"], queryFn: () => api.get<Team[]>("/teams"), staleTime: 60_000 });
}

export function usePermissionCatalog() {
  return useQuery({ queryKey: ["permission-catalog"], queryFn: () => api.get<PermissionCatalog>("/auth/permissions"), staleTime: Infinity });
}

export function useAdminUser(id: string) {
  return useQuery({ queryKey: ["users", id], queryFn: () => api.get<AdminUser>(`/users/${id}`) });
}

export function useUserSessions(id: string, enabled = true) {
  return useQuery({ queryKey: ["users", id, "sessions"], queryFn: () => api.get<UserSession[]>(`/users/${id}/sessions`), enabled });
}

export function useCredentials(enabled = true) {
  return useQuery({ queryKey: ["service-credentials"], queryFn: () => api.get<Credential[]>("/service-credentials"), enabled });
}

/* ------------------------------------------------------------------ mutations */

function useUserMutation<TVars>(fn: (vars: TVars) => Promise<AdminUser>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (u) => {
      qc.setQueryData(["users", u.id], u);
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["roles"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["timeline", "user", u.id] });
      qc.invalidateQueries({ queryKey: ["picker"] });
    },
  });
}

export function useSaveUser(id?: string) {
  return useUserMutation((data: UserInput) => (id ? api.patch<AdminUser>(`/users/${id}`, data) : api.post<AdminUser>("/users", data)));
}

export function useDeactivateUser(id: string) {
  return useUserMutation((body: { reassign_to_id: string | null; reason: string | null }) =>
    api.post<AdminUser>(`/users/${id}/deactivate`, body),
  );
}

export function useReactivateUser(id: string) {
  return useUserMutation(() => api.post<AdminUser>(`/users/${id}/reactivate`));
}

export function useResetMfa(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>(`/users/${id}/reset-mfa`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users", id] });
      qc.invalidateQueries({ queryKey: ["timeline", "user", id] });
    },
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description: string | null }) => api.post<Team>("/teams", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}

export function useSaveRole(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RoleInput) => (id ? api.patch<Role>(`/roles/${id}`, body) : api.post<Role>("/roles", body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roles"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useCreateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; user_id: string; scopes: string[] }) => api.post<CredentialCreated>("/service-credentials", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["service-credentials"] }),
  });
}

export function useRevokeCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Credential>(`/service-credentials/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["service-credentials"] }),
  });
}
