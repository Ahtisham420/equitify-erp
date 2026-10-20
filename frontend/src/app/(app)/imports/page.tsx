"use client";

import { useQuery } from "@tanstack/react-query";
import { Archive, Database, MoreHorizontal, Pencil, Plus, Upload } from "lucide-react";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { TabList, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatRelative } from "@/lib/utils";

import {
  CADENCE_LABELS,
  CADENCES,
  ENTITY_LABELS,
  ENTITY_TYPES,
  JOB_STATUS_LABELS,
  JOB_STATUSES,
  useArchiveDataSource,
  useDataSourceOptions,
  type DataSource,
  type ImportFacets,
  type ImportJob,
} from "@/features/imports/api";
import { DataSourceFormSheet } from "@/features/imports/data-source-form";

/* ------------------------------------------------------------------ jobs */

const jobColumns: Column<ImportJob>[] = [
  {
    id: "file",
    header: "File",
    sortKey: "filename",
    cell: (j) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{j.filename}</p>
        <p className="truncate text-xs text-ink-3">{j.data_source_name ?? "No source"}</p>
      </div>
    ),
  },
  { id: "entity", header: "Records", hideable: true, cell: (j) => <span className="text-ink-2">{ENTITY_LABELS[j.entity_type] ?? j.entity_type}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (j) => <StatusBadge status={j.status} label={JOB_STATUS_LABELS[j.status]} /> },
  { id: "rows", header: "Rows", sortKey: "row_count", align: "right", hideable: true, cell: (j) => formatNumber(j.row_count) },
  {
    id: "quality",
    header: "Valid / invalid / dup.",
    align: "right",
    hideable: true,
    cell: (j) =>
      j.validated_at ? (
        <span className="text-xs tabular">
          <span className="text-positive">{formatNumber(j.counts.valid ?? 0)}</span>
          <span className="text-ink-3"> / </span>
          <span className={cn((j.counts.invalid ?? 0) > 0 ? "text-negative" : "text-ink-3")}>{formatNumber(j.counts.invalid ?? 0)}</span>
          <span className="text-ink-3"> / </span>
          <span className={cn((j.counts.duplicate ?? 0) > 0 ? "text-caution" : "text-ink-3")}>{formatNumber(j.counts.duplicate ?? 0)}</span>
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  {
    id: "result",
    header: "Created / updated",
    align: "right",
    hideable: true,
    cell: (j) =>
      j.committed_at ? (
        <span className="text-xs tabular text-ink-2">
          {formatNumber(j.counts.created ?? 0)} / {formatNumber(j.counts.updated ?? 0)}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "committed", header: "Committed", sortKey: "committed_at", hideable: true, defaultHidden: true, cell: (j) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDate(j.committed_at)}</span> },
  { id: "created", header: "Uploaded", sortKey: "created_at", hideable: true, cell: (j) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(j.created_at)}</span> },
];

function JobsTab() {
  const { can } = useAuth();
  const list = useListQuery<ImportJob>("imports", "/imports");
  const { url } = list;
  const cols = useColumnVisibility("imports", jobColumns);
  const { data: sources = [] } = useDataSourceOptions();
  const more: MoreFilterField[] = [
    { type: "select", label: "Data source", key: "data_source_id", options: sources.map((s) => ({ value: s.id, label: s.provider })) },
  ];

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["imports", "facets", filterParams],
    queryFn: () => api.get<ImportFacets>("/imports/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  for (const [key, label, labels] of [["status", "Status", JOB_STATUS_LABELS], ["entity_type", "Records", ENTITY_LABELS]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map((v) => labels[v] ?? v).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  const sourceId = url.get("data_source_id");
  if (sourceId) {
    chips.push({ key: "data_source_id", label: "Source", value: sources.find((s) => s.id === sourceId)?.provider ?? "Selected source", onRemove: () => url.set({ data_source_id: null }) });
  }
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="imports" />
                <ColumnsMenu columns={jobColumns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search file name…" />
            <FacetFilter
              label="Status"
              options={JOB_STATUSES.map((s) => ({ value: s, label: JOB_STATUS_LABELS[s], count: facets?.status[s] ?? 0 }))}
              selected={url.getAll("status")}
              onChange={(v) => url.set({ status: v })}
            />
            <FacetFilter
              label="Records"
              options={ENTITY_TYPES.map((e) => ({ value: e, label: ENTITY_LABELS[e], count: facets?.entity_type[e] ?? 0 }))}
              selected={url.getAll("entity_type")}
              onChange={(v) => url.set({ entity_type: v })}
            />
            <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
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
        columns={jobColumns}
        data={list.data?.items}
        loading={list.isLoading}
        fetching={list.isFetching}
        sort={url.get("sort")}
        onSortChange={(sort) => url.set({ sort })}
        rowHref={(j) => `/imports/${j.id}`}
        hidden={cols.hidden}
        empty={
          <EmptyState
            icon={<Upload />}
            title={filtered ? "No imports match these filters" : "No imports yet"}
            description={filtered ? "Try removing a filter." : "Upload a CSV of properties, people or organizations. Rows are validated and previewed before anything is written."}
            action={
              can("imports", "create") && !filtered ? (
                <Link href="/imports/new">
                  <Button variant="primary">
                    <Plus /> New import
                  </Button>
                </Link>
              ) : undefined
            }
          />
        }
      />
    </ListCard>
  );
}

/* ------------------------------------------------------------------ sources */

function renewalTone(date: string | null): string {
  if (!date) return "text-ink-3";
  const days = (new Date(date).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return "text-negative";
  if (days <= 30) return "text-caution";
  return "text-ink-2";
}

function SourcesTab({ onEdit }: { onEdit: (s: DataSource) => void }) {
  const { can } = useAuth();
  const list = useListQuery<DataSource>("data-sources", "/data-sources");
  const { url } = list;
  const archive = useArchiveDataSource();
  const [archiving, setArchiving] = useState<DataSource | null>(null);

  const columns: Column<DataSource>[] = [
    {
      id: "provider",
      header: "Provider",
      sortKey: "provider",
      cell: (s) => (
        <div className="min-w-[200px] max-w-[300px]">
          <p className="truncate font-medium text-ink">{s.provider}</p>
          <p className="truncate text-xs text-ink-3">{s.description ?? s.contact_name ?? "—"}</p>
        </div>
      ),
    },
    { id: "status", header: "Status", cell: (s) => <StatusBadge status={s.is_active ? "active" : "inactive"} /> },
    { id: "cadence", header: "Cadence", sortKey: "cadence", cell: (s) => <span className="text-ink-2">{CADENCE_LABELS[s.cadence] ?? s.cadence}</span> },
    {
      id: "use",
      header: "Permitted use",
      cell: (s) => (
        <div className="max-w-[260px]">
          <p className="truncate text-ink-2" title={s.permitted_use ?? undefined}>{s.permitted_use ?? "—"}</p>
          {!s.license_terms && <p className="text-xs text-caution">No license terms recorded</p>}
        </div>
      ),
    },
    {
      id: "redistribution",
      header: "Redistribution",
      cell: (s) => (s.redistribution_allowed ? <Badge tone="green">Allowed</Badge> : <Badge tone="outline">Not allowed</Badge>),
    },
    {
      id: "cost",
      header: "Cost",
      sortKey: "cost",
      align: "right",
      cell: (s) => (
        <span>
          {formatCurrency(s.cost)}
          {s.cost_notes && <span className="ml-1 text-xs text-ink-3">{s.cost_notes}</span>}
        </span>
      ),
    },
    { id: "renewal", header: "Renewal", sortKey: "renewal_date", cell: (s) => <span className={cn("whitespace-nowrap text-xs", renewalTone(s.renewal_date))}>{formatDate(s.renewal_date)}</span> },
    { id: "imports", header: "Imports", align: "right", cell: (s) => formatNumber(s.import_count) },
    {
      id: "actions",
      header: "",
      align: "right",
      width: 48,
      cell: (s) =>
        can("imports", "edit") || can("imports", "delete") ? (
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Source actions">
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent>
              {can("imports", "edit") && (
                <MenuItem icon={<Pencil />} onSelect={() => onEdit(s)}>
                  Edit
                </MenuItem>
              )}
              {can("imports", "delete") && (
                <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(s)}>
                  Archive
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        ) : null,
    },
  ];

  const active = url.get("is_active");
  const chips: FilterChip[] = [];
  if (active) chips.push({ key: "is_active", label: "Status", value: active === "true" ? "Active" : "Inactive", onRemove: () => url.set({ is_active: null }) });
  const cadence = url.getAll("cadence");
  if (cadence.length) chips.push({ key: "cadence", label: "Cadence", value: cadence.map((c) => CADENCE_LABELS[c] ?? c).join(", "), onRemove: () => url.set({ cadence: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar right={<SavedViewsMenu module="imports" />}>
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search provider, contact, permitted use…" />
              <FacetFilter
                label="Status"
                single
                options={[{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }]}
                selected={active ? [active] : []}
                onChange={(v) => url.set({ is_active: v[0] ?? null })}
              />
              <FacetFilter
                label="Cadence"
                options={CADENCES.map((c) => ({ value: c, label: CADENCE_LABELS[c] }))}
                selected={cadence}
                onChange={(v) => url.set({ cadence: v })}
              />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: "sources", q: url.get("q") })} />
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
          onRowClick={can("imports", "edit") ? onEdit : undefined}
          empty={
            <EmptyState
              icon={<Database />}
              title={filtered ? "No sources match these filters" : "No data sources registered"}
              description={filtered ? "Try removing a filter." : "Register each provider with its license terms and permitted use before importing its data."}
            />
          }
        />
      </ListCard>

      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this data source?"
        description="Past imports keep their source attribution. No new imports can be committed against it."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() =>
          archiving &&
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast.success("Data source archived");
              setArchiving(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ page */

function ImportsView() {
  const { can } = useAuth();
  const url = useUrlState();
  const tab = url.get("tab") === "sources" ? "sources" : "jobs";
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Imports"
        description="Bring external and internal data in through staging, validation and a duplicate preview. Every import can be rolled back."
        actions={
          tab === "sources" ? (
            can("imports", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus />
                New source
              </Button>
            )
          ) : (
            can("imports", "create") && (
              <Link href="/imports/new">
                <Button variant="primary">
                  <Plus />
                  New import
                </Button>
              </Link>
            )
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "jobs" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "jobs", label: "Import jobs" },
            { value: "sources", label: "Sources & licenses" },
          ]}
        />
      </Tabs>
      {tab === "jobs" ? <JobsTab /> : <SourcesTab onEdit={setEditing} />}

      <DataSourceFormSheet
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        source={editing}
      />
    </>
  );
}

export default function ImportsPage() {
  return (
    <Suspense>
      <ImportsView />
    </Suspense>
  );
}
