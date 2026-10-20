"use client";

import { Plus, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, TabList, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { useAuth } from "@/lib/auth";
import { formatRelative, titleCase } from "@/lib/utils";

import { USER_STATUSES, useRoles, useTeams, type AdminUser } from "@/features/admin/api";
import { CredentialsPanel } from "@/features/admin/credentials";
import { TeamsPanel } from "@/features/admin/teams";
import { UserFormSheet } from "@/features/admin/user-form";

function UsersTab() {
  const list = useListQuery<AdminUser>("users", "/users");
  const { url } = list;
  const { data: roles = [] } = useRoles();
  const { data: teams = [] } = useTeams();
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "—";

  const columns: Column<AdminUser>[] = [
    {
      id: "name",
      header: "Name",
      sortKey: "full_name",
      cell: (u) => (
        <div className="flex min-w-[220px] items-center gap-2.5">
          <Avatar name={u.full_name} size={26} />
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{u.full_name}</p>
            <p className="truncate text-xs text-ink-3">{u.email}</p>
          </div>
        </div>
      ),
    },
    { id: "role", header: "Role", hideable: true, cell: (u) => <span className="text-ink-2">{u.role.name}</span> },
    { id: "team", header: "Team", hideable: true, cell: (u) => <span className="text-ink-2">{teamName(u.team_id)}</span> },
    { id: "title", header: "Job title", hideable: true, defaultHidden: true, cell: (u) => <span className="text-ink-2">{u.job_title ?? "—"}</span> },
    { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (u) => <StatusBadge status={u.status} /> },
    {
      id: "type",
      header: "Type",
      hideable: true,
      cell: (u) => (u.is_service ? <Badge tone="sky">Service</Badge> : <Badge tone="outline">Person</Badge>),
    },
    {
      id: "mfa",
      header: "MFA",
      hideable: true,
      cell: (u) => (u.is_service ? <span className="text-xs text-ink-3">n/a</span> : u.mfa_enabled ? <Badge tone="green">Enrolled</Badge> : <Badge tone="amber">Pending</Badge>),
    },
    { id: "login", header: "Last sign-in", sortKey: "last_login_at", hideable: true, cell: (u) => <span className="whitespace-nowrap text-xs text-ink-3">{u.last_login_at ? formatRelative(u.last_login_at) : "Never"}</span> },
    { id: "created", header: "Created", sortKey: "created_at", hideable: true, defaultHidden: true, cell: (u) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(u.created_at)}</span> },
  ];
  const cols = useColumnVisibility("admin-users", columns);

  const chips: FilterChip[] = [];
  const roleIds = url.getAll("role_id");
  if (roleIds.length) chips.push({ key: "role_id", label: "Role", value: roleIds.map((id) => roles.find((r) => r.id === id)?.name ?? "Role").join(", "), onRemove: () => url.set({ role_id: null }) });
  const teamIds = url.getAll("team_id");
  if (teamIds.length) chips.push({ key: "team_id", label: "Team", value: teamIds.map((id) => teams.find((t) => t.id === id)?.name ?? "Team").join(", "), onRemove: () => url.set({ team_id: null }) });
  const statuses = url.getAll("status");
  if (statuses.length) chips.push({ key: "status", label: "Status", value: statuses.map(titleCase).join(", "), onRemove: () => url.set({ status: null }) });
  const service = url.get("is_service");
  if (service) chips.push({ key: "is_service", label: "Type", value: service === "true" ? "Service" : "Person", onRemove: () => url.set({ is_service: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="users" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search name, email, title…" />
            <FacetFilter
              label="Role"
              options={roles.map((r) => ({ value: r.id, label: r.name, count: r.user_count }))}
              selected={roleIds}
              onChange={(v) => url.set({ role_id: v })}
            />
            <FacetFilter
              label="Team"
              options={teams.map((t) => ({ value: t.id, label: t.name, count: t.member_count }))}
              selected={teamIds}
              onChange={(v) => url.set({ team_id: v })}
            />
            <FacetFilter label="Status" options={USER_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} selected={statuses} onChange={(v) => url.set({ status: v })} />
            <FacetFilter
              label="Type"
              single
              options={[{ value: "false", label: "Person" }, { value: "true", label: "Service" }]}
              selected={service ? [service] : []}
              onChange={(v) => url.set({ is_service: v[0] ?? null })}
            />
          </Toolbar>
          <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
        </div>
      }
      footer={
        <TableFooter
          page={list.page}
          pageSize={list.pageSize}
          total={list.data?.total ?? 0}
          onPage={(page) => url.set({ page }, { resetPage: false })}
          onPageSize={(size) => url.set({ page_size: size })}
        />
      }
    >
      <DataTable
        columns={columns}
        data={list.data?.items}
        loading={list.isLoading}
        fetching={list.isFetching}
        sort={url.get("sort")}
        onSortChange={(sort) => url.set({ sort })}
        rowHref={(u) => `/admin/users/${u.id}`}
        hidden={cols.hidden}
        rowClassName={(u) => (u.status !== "active" ? "opacity-70" : undefined)}
        empty={
          <EmptyState
            icon={<Users />}
            title={filtered ? "No users match these filters" : "No users yet"}
            description={filtered ? "Try removing a filter." : "Create users and assign roles to give people access."}
          />
        }
      />
    </ListCard>
  );
}

function UsersView() {
  const router = useRouter();
  const { can } = useAuth();
  const url = useUrlState();
  const tab = url.get("tab") ?? "users";
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Users & access"
        description="Who can sign in, their role, team and manager, and the integrations allowed to call the API."
        actions={
          can("users", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New user
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "users" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "users", label: "Users" },
            { value: "teams", label: "Teams" },
            { value: "credentials", label: "Service credentials" },
          ]}
        />
      </Tabs>
      {tab === "users" && <UsersTab />}
      {tab === "teams" && <TeamsPanel />}
      {tab === "credentials" && <CredentialsPanel />}

      <UserFormSheet open={creating} onOpenChange={setCreating} onSaved={(u) => router.push(`/admin/users/${u.id}`)} />
    </>
  );
}

export default function AdminUsersPage() {
  return (
    <Suspense>
      <UsersView />
    </Suspense>
  );
}
