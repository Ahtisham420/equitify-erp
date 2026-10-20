"use client";

import { ArrowRight, ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker, UserPicker } from "@/components/data/entity-picker";
import { FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import type { AuditEvent } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatDateTime, titleCase } from "@/lib/utils";

const ENTITY_TYPES = [
  "user", "role", "team", "service_credential", "property", "parcel", "person", "organization", "ownership_interest",
  "territory", "buy_box", "opportunity", "interaction", "compliance_record", "task", "alert", "import_job", "data_source",
  "data_quality", "saved_view",
];

const ACTIONS = [
  "auth.login", "auth.login_failed", "auth.logout", "auth.mfa_enrolled", "auth.mfa_failed",
  "user.created", "user.updated", "user.permissions_changed", "user.deactivated", "user.reactivated", "user.mfa_reset",
  "role.created", "role.permissions_changed", "team.created", "credential.created", "credential.revoked",
  "property.exported", "person.exported", "organization.exported", "task.exported", "property.archived",
  "import.committed", "import.rolled_back",
];

const ENTITY_ROUTES: Record<string, string> = {
  user: "/admin/users", property: "/properties", person: "/people", organization: "/organizations", import_job: "/imports",
};

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ") : "empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ChangesDiff({ changes }: { changes: NonNullable<AuditEvent["changes"]> }) {
  return (
    <div className="mt-2 space-y-1 rounded-md border border-line bg-subtle/60 px-3 py-2">
      {Object.entries(changes).map(([field, c]) => {
        const change = c as { from?: unknown; to?: unknown };
        const isDiff = change && typeof change === "object" && !Array.isArray(change) && "to" in change;
        return (
          <div key={field} className="grid grid-cols-[160px_1fr] gap-2 text-xs">
            <span className="font-medium text-ink-2">{titleCase(field)}</span>
            {isDiff ? (
              <span className="flex flex-wrap items-start gap-1.5">
                <span className="break-all text-ink-3 line-through decoration-ink-3/50">{show(change.from)}</span>
                <ArrowRight className="mt-0.5 size-3 shrink-0 text-ink-3" />
                <span className="break-all text-ink">{show(change.to)}</span>
              </span>
            ) : (
              <span className="break-all text-ink">{show(c)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface UserLite {
  id: string;
  full_name: string;
  email: string;
}

/** Immutable audit log with search, facets, actor and date filters, and per-row change diffs. */
export function AuditTable({ actorId, savedViews = true }: { actorId?: string; savedViews?: boolean }) {
  const { can } = useAuth();
  const url = useUrlState();
  const dateFrom = url.get("date_from");
  const dateTo = url.get("date_to");
  const list = useListQuery<AuditEvent>("audit", "/audit", {
    actor_id: actorId ?? url.get("actor_id"),
    date_from: dateFrom ? `${dateFrom}T00:00:00Z` : undefined,
    date_to: dateTo ? `${dateTo}T23:59:59Z` : undefined,
    tab: undefined,
  });
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (id: string) => setExpanded((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]));

  const items = list.data?.items;
  const entityOptions = useMemo(
    () => Array.from(new Set([...ENTITY_TYPES, ...(items ?? []).map((e) => e.entity_type), ...url.getAll("entity_type")])).sort(),
    [items, url],
  );
  const actionOptions = useMemo(
    () => Array.from(new Set([...ACTIONS, ...(items ?? []).map((e) => e.action), ...url.getAll("action")])).sort(),
    [items, url],
  );

  const columns: Column<AuditEvent>[] = [
    {
      id: "expand",
      header: "",
      width: 32,
      cell: (e) =>
        e.changes && Object.keys(e.changes).length ? (
          expanded.includes(e.id) ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />
        ) : null,
    },
    { id: "when", header: "When", sortKey: "occurred_at", cell: (e) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(e.occurred_at)}</span> },
    {
      id: "actor",
      header: "Actor",
      cell: (e) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Avatar name={e.actor_name ?? "System"} size={20} />
          {e.actor_id && can("users", "view") ? (
            <Link href={`/admin/users/${e.actor_id}`} className="text-ink hover:underline">{e.actor_name ?? "Unknown"}</Link>
          ) : (
            <span className="text-ink">{e.actor_name ?? "System"}</span>
          )}
        </div>
      ),
    },
    {
      id: "action",
      header: "Action",
      sortKey: "action",
      cell: (e) => (
        <Badge tone={/failed|deactivated|revoked|archived|rolled_back|reset/.test(e.action) ? "amber" : /exported/.test(e.action) ? "sky" : "neutral"} className="font-mono">
          {e.action}
        </Badge>
      ),
    },
    {
      id: "entity",
      header: "Record",
      cell: (e) => {
        const route = ENTITY_ROUTES[e.entity_type];
        return (
          <span className="whitespace-nowrap text-xs">
            <span className="text-ink-3">{titleCase(e.entity_type)}</span>
            {e.entity_id && route && (
              <Link href={`${route}/${e.entity_id}`} className="ml-1.5 text-accent hover:underline">
                Open
              </Link>
            )}
          </span>
        );
      },
    },
    {
      id: "summary",
      header: "Details",
      cell: (e) => (
        <div className="min-w-[240px] max-w-[520px]">
          <p className={cn("text-sm", e.summary ? "text-ink-2" : "text-ink-3")}>
            {e.summary ?? (e.changes ? `${Object.keys(e.changes).length} field(s) changed` : "—")}
          </p>
          {expanded.includes(e.id) && e.changes && <ChangesDiff changes={e.changes} />}
        </div>
      ),
    },
    { id: "ip", header: "IP", cell: (e) => <span className="font-mono text-xs text-ink-3">{e.ip_address ?? "—"}</span> },
  ];

  const more: MoreFilterField[] = [{ type: "date-range", label: "Date", minKey: "date_from", maxKey: "date_to" }];
  const chips: FilterChip[] = [];
  const entityTypes = url.getAll("entity_type");
  if (entityTypes.length) chips.push({ key: "entity_type", label: "Record", value: entityTypes.map(titleCase).join(", "), onRemove: () => url.set({ entity_type: null }) });
  const actions = url.getAll("action");
  if (actions.length) chips.push({ key: "action", label: "Action", value: actions.join(", "), onRemove: () => url.set({ action: null }) });
  if (dateFrom || dateTo) {
    chips.push({ key: "date", label: "Date", value: `${dateFrom ? formatDate(dateFrom) : "…"} – ${dateTo ? formatDate(dateTo) : "…"}`, onRemove: () => url.set({ date_from: null, date_to: null }) });
  }
  if (!actorId && url.get("actor_id")) chips.push({ key: "actor_id", label: "Actor", value: "Selected user", onRemove: () => url.set({ actor_id: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar right={savedViews ? <SavedViewsMenu module="audit" /> : undefined}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search summary, action, actor…" />
            <FacetFilter label="Record" searchable options={entityOptions.map((v) => ({ value: v, label: titleCase(v) }))} selected={entityTypes} onChange={(v) => url.set({ entity_type: v })} />
            <FacetFilter label="Action" searchable options={actionOptions.map((v) => ({ value: v, label: v }))} selected={actions} onChange={(v) => url.set({ action: v })} />
            {!actorId && (
              <div className="w-56">
                {can("users", "view") ? (
                  <EntityPicker<UserLite>
                    endpoint="/users"
                    value={url.get("actor_id")}
                    onChange={(id) => url.set({ actor_id: id })}
                    placeholder="Any actor"
                    toOption={(u) => ({ id: u.id, label: u.full_name, sublabel: u.email })}
                  />
                ) : (
                  <UserPicker value={url.get("actor_id")} onChange={(id) => url.set({ actor_id: id })} placeholder="Any actor" />
                )}
              </div>
            )}
            <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
          </Toolbar>
          <FilterChips
            chips={chips}
            onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q"), sort: url.get("sort") })}
          />
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
        data={items}
        loading={list.isLoading}
        fetching={list.isFetching}
        sort={url.get("sort")}
        onSortChange={(sort) => url.set({ sort })}
        onRowClick={(e) => e.changes && toggle(e.id)}
        dense
        empty={
          <EmptyState
            icon={<ScrollText />}
            title={filtered ? "No events match these filters" : "No audit events yet"}
            description={filtered ? "Try widening the date range or removing a filter." : "Sign-ins, permission changes, exports and record changes appear here."}
          />
        }
      />
    </ListCard>
  );
}
