"use client";

import { useQuery } from "@tanstack/react-query";
import { GitBranch, KanbanSquare, Plus, Table2 } from "lucide-react";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import {
  DEAD_REASON_LABELS,
  DEAD_REASONS,
  PRIORITIES,
  STAGES,
  stageLabel,
  useUserOptions,
  type OpportunityFacets,
  type OpportunityListItem,
} from "@/features/pipeline/api";
import { PipelineBoard } from "@/features/pipeline/board";
import { MetricsStrip } from "@/features/pipeline/metrics-strip";
import { OpportunityCreateSheet } from "@/features/pipeline/opportunity-form";

const MORE: MoreFilterField[] = [
  { type: "range", label: "Deal value", minKey: "min_value", maxKey: "max_value", suffix: "$" },
  { type: "select", label: "Stalled", key: "stalled", options: [{ value: "true", label: "Only stalled" }] },
  { type: "select", label: "Next action", key: "overdue", options: [{ value: "true", label: "Overdue only" }] },
];
const CHIP_LABELS: Record<string, string> = { min_value: "Min value", max_value: "Max value", stalled: "Stalled", overdue: "Overdue" };
const BOARD_KEYS = ["q", "owner_id", "priority", "source", "min_value", "max_value", "stalled", "overdue"];

const columns: Column<OpportunityListItem>[] = [
  {
    id: "title",
    header: "Opportunity",
    sortKey: "title",
    cell: (o) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{o.title}</p>
        <p className="truncate text-xs text-ink-3">{[o.property_label !== o.title ? o.property_label : null, o.property_city, o.property_state].filter(Boolean).join(", ") || "—"}</p>
      </div>
    ),
  },
  {
    id: "stage",
    header: "Stage",
    sortKey: "stage",
    cell: (o) => (
      <div className="flex items-center gap-1.5">
        <StatusBadge status={o.stage} label={stageLabel(o.stage)} />
        {o.stage === "dead" && o.dead_reason && <span className="text-xs text-ink-3">{DEAD_REASON_LABELS[o.dead_reason]}</span>}
      </div>
    ),
  },
  {
    id: "age",
    header: "In stage",
    sortKey: "stage_entered_at",
    align: "right",
    hideable: true,
    cell: (o) => <span className={cn(o.stalled && "font-medium text-caution")}>{formatNumber(Math.floor(o.stage_age_days))}d</span>,
  },
  { id: "value", header: "Value", sortKey: "value", align: "right", hideable: true, cell: (o) => formatCurrency(o.value, { compact: true }) },
  {
    id: "next",
    header: "Next action",
    sortKey: "next_action_at",
    hideable: true,
    cell: (o) =>
      o.next_action_at || o.next_action ? (
        <div className="max-w-[240px]">
          <p className="truncate text-ink-2">{o.next_action ?? "—"}</p>
          {o.next_action_at && <p className={cn("text-xs", isOverdue(o.next_action_at) ? "font-medium text-negative" : "text-ink-3")}>{formatDate(o.next_action_at)}</p>}
        </div>
      ) : o.stage === "nurture" && o.next_touch_on ? (
        <span className="text-xs text-ink-3">Touch {formatDate(o.next_touch_on)}</span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "priority", header: "Priority", sortKey: "priority", hideable: true, cell: (o) => <StatusBadge status={o.priority} /> },
  {
    id: "owner",
    header: "Owner",
    hideable: true,
    cell: (o) =>
      o.owner_name ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          <Avatar name={o.owner_name} size={20} />
          {o.owner_name}
        </span>
      ) : (
        <span className="text-ink-3">Unassigned</span>
      ),
  },
  { id: "source", header: "Source", hideable: true, defaultHidden: true, cell: (o) => <span className="text-ink-2">{o.source ?? "—"}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(o.updated_at)}</span> },
];

function TableView() {
  const list = useListQuery<OpportunityListItem>("opportunities", "/opportunities");
  const { url } = list;
  const cols = useColumnVisibility("pipeline", columns);
  const { data: users } = useUserOptions();
  const userName = (id: string) => users?.find((u) => u.id === id)?.full_name ?? "Unknown user";

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, view: _v, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["opportunities", "facets", filterParams],
    queryFn: () => api.get<OpportunityFacets>("/opportunities/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: k === "stalled" || k === "overdue" ? "Yes" : url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  const multi: [string, string, (v: string) => string][] = [
    ["stage", "Stage", stageLabel],
    ["priority", "Priority", titleCase],
    ["owner_id", "Owner", userName],
    ["source", "Source", (v) => v],
    ["dead_reason", "Dead reason", (v) => DEAD_REASON_LABELS[v] ?? v],
  ];
  for (const [key, label, fmt] of multi) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map(fmt).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="pipeline" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search opportunity, property, city…" />
            <FacetFilter label="Stage" options={STAGES.map((s) => ({ value: s, label: stageLabel(s), count: facets?.stage[s] ?? 0 }))} selected={url.getAll("stage")} onChange={(v) => url.set({ stage: v })} />
            <FacetFilter label="Priority" options={PRIORITIES.map((p) => ({ value: p, label: titleCase(p), count: facets?.priority[p] ?? 0 }))} selected={url.getAll("priority")} onChange={(v) => url.set({ priority: v })} />
            <FacetFilter
              label="Owner"
              searchable
              options={Object.entries(facets?.owner_id ?? {}).map(([v, c]) => ({ value: v, label: userName(v), count: c }))}
              selected={url.getAll("owner_id")}
              onChange={(v) => url.set({ owner_id: v })}
            />
            <FacetFilter label="Source" options={Object.entries(facets?.source ?? {}).sort().map(([v, c]) => ({ value: v, label: v, count: c }))} selected={url.getAll("source")} onChange={(v) => url.set({ source: v })} />
            <FacetFilter
              label="Dead reason"
              options={DEAD_REASONS.map((r) => ({ value: r, label: DEAD_REASON_LABELS[r], count: facets?.dead_reason[r] ?? 0 }))}
              selected={url.getAll("dead_reason")}
              onChange={(v) => url.set({ dead_reason: v })}
            />
            <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
          </Toolbar>
          <FilterChips chips={chips} onClear={() => url.replaceAll({ view: "table", q: url.get("q"), sort: url.get("sort") })} />
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
        rowHref={(o) => `/pipeline/${o.id}`}
        hidden={cols.hidden}
        rowClassName={(o) => (o.stage === "dead" ? "text-ink-2" : undefined)}
        empty={
          <EmptyState
            icon={<GitBranch />}
            title={filtered ? "No opportunities match these filters" : "No opportunities yet"}
            description={filtered ? "Try removing a filter or broadening your search." : "Create an opportunity from a property to start a pursuit."}
          />
        }
      />
    </ListCard>
  );
}

function BoardView() {
  const url = useUrlState();
  const { data: users } = useUserOptions();
  const params = useMemo(() => Object.fromEntries(BOARD_KEYS.filter((k) => url.getAll(k).length).map((k) => [k, url.getAll(k).length > 1 ? url.getAll(k) : url.get(k)])), [url]);
  const owners = url.getAll("owner_id");

  return (
    <div className="space-y-3">
      <Toolbar right={<SavedViewsMenu module="pipeline" />}>
        <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search opportunity, property, city…" />
        <FacetFilter
          label="Owner"
          searchable
          options={(users ?? []).map((u) => ({ value: u.id, label: u.full_name }))}
          selected={owners}
          onChange={(v) => url.set({ owner_id: v })}
        />
        <FacetFilter label="Priority" options={PRIORITIES.map((p) => ({ value: p, label: titleCase(p) }))} selected={url.getAll("priority")} onChange={(v) => url.set({ priority: v })} />
        <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
        {(url.get("stalled") || url.get("overdue") || url.get("min_value") || url.get("max_value")) && (
          <Badge tone="blue">Filtered</Badge>
        )}
      </Toolbar>
      <PipelineBoard params={params} />
    </div>
  );
}

function PipelineView() {
  const { can } = useAuth();
  const url = useUrlState();
  const view = url.get("view") === "table" ? "table" : "board";
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Acquisition pursuits from sourcing to close, with enforced stage requirements."
        actions={
          <>
            <div className="flex rounded-md border border-line-strong/80 bg-surface p-0.5 shadow-card">
              {(
                [
                  ["board", "Board", KanbanSquare],
                  ["table", "Table", Table2],
                ] as const
              ).map(([v, label, Icon]) => (
                <button
                  key={v}
                  onClick={() => url.set({ view: v === "board" ? null : v, page: null, stage: null, dead_reason: null, sort: null })}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded px-2.5 text-sm font-medium transition-colors",
                    view === v ? "bg-muted text-ink" : "text-ink-3 hover:text-ink",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>
            {can("pipeline", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus />
                New opportunity
              </Button>
            )}
          </>
        }
      />
      <MetricsStrip ownerIds={url.getAll("owner_id")} />
      {view === "table" ? <TableView /> : <BoardView />}
      <OpportunityCreateSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function PipelinePage() {
  return (
    <Suspense>
      <PipelineView />
    </Suspense>
  );
}
