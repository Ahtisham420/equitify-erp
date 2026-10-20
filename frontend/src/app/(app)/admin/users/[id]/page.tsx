"use client";

import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, ShieldAlert, ShieldCheck, UserCheck, UserX } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils";

import {
  ACTION_LABELS,
  APPROVAL_KINDS,
  useAdminUser,
  usePermissionCatalog,
  useReactivateUser,
  useResetMfa,
  useRoles,
  useSaveUser,
  useTeams,
  useUserSessions,
  type AdminUser,
  type UserSession,
} from "@/features/admin/api";
import { AuditTable } from "@/features/admin/audit-table";
import { CredentialsPanel } from "@/features/admin/credentials";
import { DeactivateDialog } from "@/features/admin/deactivate-dialog";
import { UserFormSheet } from "@/features/admin/user-form";

function UserName({ id }: { id: string | null }) {
  const { data } = useQuery({ queryKey: ["users", id], queryFn: () => api.get<AdminUser>(`/users/${id}`), enabled: !!id, staleTime: 60_000 });
  if (!id) return null;
  return data ? (
    <Link href={`/admin/users/${id}`} className="text-ink hover:underline">
      {data.full_name}
    </Link>
  ) : (
    <span className="text-ink-3">Loading…</span>
  );
}

function AccessCard({ user }: { user: AdminUser }) {
  const { data: roles = [] } = useRoles();
  const { data: catalog } = usePermissionCatalog();
  const role = roles.find((r) => r.id === user.role.id);
  const perms = role?.permissions ?? {};
  const isAdmin = perms["*"]?.includes("*");

  return (
    <Card>
      <CardHeader
        title="Access"
        description={role?.description ?? undefined}
        actions={
          <Link href={`/admin/roles?role=${user.role.id}`} className="text-xs font-medium text-accent hover:underline">
            {user.role.name}
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {isAdmin ? (
          <p className="text-sm text-ink-2">Full access to every module, including administration and audit.</p>
        ) : (
          <ul className="space-y-1.5">
            {Object.entries(catalog?.modules ?? {})
              .filter(([m]) => (perms[m] ?? []).length > 0)
              .map(([m, label]) => (
                <li key={m} className="flex items-start justify-between gap-3 text-sm">
                  <span className="text-ink-2">{label}</span>
                  <span className="flex flex-wrap justify-end gap-1">
                    {(perms[m].includes("*") ? catalog?.actions ?? [] : perms[m]).map((a) => (
                      <Badge key={a} tone="outline">{ACTION_LABELS[a] ?? a}</Badge>
                    ))}
                  </span>
                </li>
              ))}
            {Object.values(perms).every((a) => a.length === 0) && <li className="text-sm text-ink-3">This role grants no module access.</li>}
          </ul>
        )}
        <div className="border-t border-line pt-3">
          <p className="mb-1.5 text-xs font-medium text-ink-3">Approval authority</p>
          <FieldGrid cols={3}>
            {APPROVAL_KINDS.map((k) => {
              const limits = role?.approval_limits ?? {};
              const has = isAdmin || k.key in limits;
              const value = limits[k.key];
              return (
                <FieldItem key={k.key} label={k.label}>
                  {!has ? "None" : isAdmin || value === null || value === undefined ? "Unlimited" : `Up to ${formatCurrency(value, { compact: true })}`}
                </FieldItem>
              );
            })}
          </FieldGrid>
        </div>
      </CardBody>
    </Card>
  );
}

function SessionsCard({ userId }: { userId: string }) {
  const { data, isLoading } = useUserSessions(userId);
  const now = Date.now();
  const columns: Column<UserSession>[] = [
    { id: "started", header: "Signed in", cell: (s) => <span className="whitespace-nowrap text-ink">{formatDateTime(s.created_at)}</span> },
    {
      id: "state",
      header: "State",
      cell: (s) =>
        s.revoked_at ? (
          <Badge tone="neutral" dot>Ended {formatRelative(s.revoked_at)}</Badge>
        ) : new Date(s.expires_at).getTime() < now ? (
          <Badge tone="neutral" dot>Expired</Badge>
        ) : (
          <Badge tone="green" dot>Active</Badge>
        ),
    },
    { id: "expires", header: "Expires", cell: (s) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(s.expires_at)}</span> },
    { id: "ip", header: "IP address", cell: (s) => <span className="font-mono text-xs text-ink-2">{s.ip_address ?? "—"}</span> },
    { id: "agent", header: "Device", cell: (s) => <span className="block max-w-[360px] truncate text-xs text-ink-3" title={s.user_agent ?? undefined}>{s.user_agent || "—"}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Sessions" description="Last 50 sign-in sessions. Deactivation, password reset and MFA reset end all active sessions." />
      <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No sessions" description="This user has not signed in yet." />} />
    </Card>
  );
}

function UserDetail({ id }: { id: string }) {
  const { can, user: me } = useAuth();
  const url = useUrlState();
  const tab = url.get("tab") ?? "overview";
  const { data: user, isLoading, error } = useAdminUser(id);
  const { data: roles = [] } = useRoles();
  const { data: teams = [] } = useTeams();
  const save = useSaveUser(id);
  const reactivate = useReactivateUser(id);
  const resetMfa = useResetMfa(id);
  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [resetting, setResetting] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !user) {
    return (
      <EmptyState
        title="User not found"
        description={errorMessage(error)}
        action={
          <Link href="/admin/users">
            <Button>Back to users</Button>
          </Link>
        }
      />
    );
  }

  const active = user.status === "active";
  const canEdit = can("users", "edit");
  const isSelf = me?.id === user.id;

  const changeRole = (roleId: string, name: string) =>
    save.mutate(
      { role_id: roleId },
      { onSuccess: () => toast.success(`Role changed to ${name}`), onError: (e) => toast.error(errorMessage(e)) },
    );

  const tabs = [
    { value: "overview", label: "Overview" },
    ...(user.is_service ? [{ value: "credentials", label: "Credentials" }] : [{ value: "sessions", label: "Sessions" }]),
    { value: "activity", label: "Account history" },
    ...(can("audit", "view") ? [{ value: "actions", label: "Actions by user" }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Users", href: "/admin/users" }, { label: user.full_name }]}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={user.full_name} size={32} />
            {user.full_name}
          </span>
        }
        description={user.email}
        meta={
          <>
            <StatusBadge status={user.status} />
            <Badge tone="outline">{user.role.name}</Badge>
            {user.is_service ? (
              <Badge tone="sky">Service integration</Badge>
            ) : user.mfa_enabled ? (
              <Badge tone="green">MFA enrolled</Badge>
            ) : (
              <Badge tone="amber">MFA pending</Badge>
            )}
            {user.deactivated_at && <span className="text-xs text-ink-3">Deactivated {formatDateTime(user.deactivated_at)}</span>}
          </>
        }
        actions={
          canEdit && (
            <>
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent width={220}>
                  <MenuLabel>Change role</MenuLabel>
                  {roles
                    .filter((r) => r.id !== user.role.id)
                    .map((r) => (
                      <MenuItem key={r.id} onSelect={() => changeRole(r.id, r.name)} disabled={isSelf}>
                        {r.name}
                      </MenuItem>
                    ))}
                  <MenuSeparator />
                  {!user.is_service && (
                    <MenuItem icon={<ShieldAlert />} onSelect={() => setResetting(true)}>
                      Reset MFA
                    </MenuItem>
                  )}
                  {active ? (
                    <MenuItem icon={<UserX />} destructive disabled={isSelf} onSelect={() => setDeactivating(true)}>
                      Deactivate…
                    </MenuItem>
                  ) : (
                    <MenuItem
                      icon={<UserCheck />}
                      onSelect={() =>
                        reactivate.mutate(undefined, {
                          onSuccess: () => toast.success(`${user.full_name} reactivated`),
                          onError: (e) => toast.error(errorMessage(e)),
                        })
                      }
                    >
                      Reactivate
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            </>
          )
        }
      />

      {!active && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-line bg-subtle/60 px-3 py-2 text-sm text-ink-2">
          <ShieldCheck className="size-4 text-ink-3" />
          This account cannot sign in. Sessions and service credentials were revoked at deactivation.
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "overview" ? null : v })}>
        <TabList className="mb-5" tabs={tabs} />
        <TabPanel value="overview">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Profile" />
              <CardBody>
                <FieldGrid>
                  <FieldItem label="Email">{user.email}</FieldItem>
                  <FieldItem label="Job title">{user.job_title}</FieldItem>
                  <FieldItem label="Phone">{user.phone}</FieldItem>
                  <FieldItem label="Team">{teams.find((t) => t.id === user.team_id)?.name}</FieldItem>
                  <FieldItem label="Manager">{user.manager_id ? <UserName id={user.manager_id} /> : null}</FieldItem>
                  <FieldItem label="Last sign-in">{user.last_login_at ? formatDateTime(user.last_login_at) : user.is_service ? "API only" : "Never"}</FieldItem>
                  <FieldItem label="Created">{formatDateTime(user.created_at)}</FieldItem>
                  <FieldItem label="Deactivated">{user.deactivated_at ? formatDateTime(user.deactivated_at) : null}</FieldItem>
                </FieldGrid>
              </CardBody>
            </Card>
            <AccessCard user={user} />
          </div>
        </TabPanel>
        {user.is_service ? (
          <TabPanel value="credentials">
            <CredentialsPanel userId={user.id} userActive={active} />
          </TabPanel>
        ) : (
          <TabPanel value="sessions">
            <SessionsCard userId={user.id} />
          </TabPanel>
        )}
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="user" entityId={user.id} />
            </CardBody>
          </Card>
        </TabPanel>
        {can("audit", "view") && (
          <TabPanel value="actions">
            <AuditTable actorId={user.id} savedViews={false} />
          </TabPanel>
        )}
      </Tabs>

      <UserFormSheet open={editing} onOpenChange={setEditing} user={user} />
      <DeactivateDialog user={user} open={deactivating} onOpenChange={setDeactivating} />
      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset MFA?"
        description={`${user.full_name} is signed out everywhere and must enroll a new authenticator at next sign-in.`}
        confirmLabel="Reset MFA"
        destructive
        loading={resetMfa.isPending}
        onConfirm={() =>
          resetMfa.mutate(undefined, {
            onSuccess: () => {
              toast.success("MFA reset");
              setResetting(false);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

export default function AdminUserPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <UserDetail id={params.id} />
    </Suspense>
  );
}
