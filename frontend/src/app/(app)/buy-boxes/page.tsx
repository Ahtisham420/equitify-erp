"use client";

import { useQuery } from "@tanstack/react-query";
import { Filter, Plus } from "lucide-react";
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
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber, formatRelative, titleCase } from "@/lib/utils";

import { RESULT_LABELS, RESULTS, type BuyBoxFacets, type BuyBoxListItem } from "@/features/buybox/api";
import { BuyBoxFormSheet } from "@/features/buybox/buybox-form";

const MORE: MoreFilterField[] = [
  { type: "select", label: "Status", key: "is_active", options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] },
];

function activeWindow(b: BuyBoxListItem) {
  if (!b.active_from && !b.active_to) return "Open-ended";
  return `${b.active_from ? formatDate(b.active_from) : "…"} – ${b.active_to ? formatDate(b.active_to) : "…"}`;
}

const columns: Column<BuyBoxListItem>[] = [
  {
    id: "name",
    header: "Buy box",
    sortKey: "name",
    cell: (b) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{b.name}</p>
        <p className="truncate text-xs text-ink-3">{activeWindow(b)}</p>
      </div>
    ),
  },
  { id: "strategy", header: "Strategy", sortKey: "strategy", hideable: true, cell: (b) => <Badge tone="outline">{titleCase(b.strategy)}</Badge> },
  { id: "status", header: "Status", sortKey: "is_active", hideable: true, cell: (b) => <StatusBadge status={b.is_active ? "active" : "inactive"} /> },
  { id: "version", header: "Version", sortKey: "version", align: "right", hideable: true, cell: (b) => `v${b.version}` },
  { id: "criteria", header: "Criteria", align: "right", hideable: true, cell: (b) => formatNumber(b.criteria_count) },
  ...RESULTS.map<Column<BuyBoxListItem>>((r) => ({
    id: r,
    header: RESULT_LABELS[r],
    align: "right",
    hideable: true,
    defaultHidden: r === "pass_with_exception",
    cell: (b) => <span className={b.result_counts[r] ? "text-ink" : "text-ink-3"}>{formatNumber(b.result_counts[r] ?? 0)}</span>,
  })),
  {
    id: "owner",
    header: "Owner",
    hideable: true,
    cell: (b) =>
      b.owner_name ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          <Avatar name={b.owner_name} size={20} />
          {b.owner_name}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (b) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(b.updated_at)}</span> },
];

function BuyBoxesView() {
  const { can } = useAuth();
  const list = useListQuery<BuyBoxListItem>("buy-boxes", "/buy-boxes");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const cols = useColumnVisibility("buy-boxes", columns);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["buy-boxes", "facets", filterParams],
    queryFn: () => api.get<BuyBoxFacets>("/buy-boxes/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  if (url.get("is_active")) chips.push({ key: "is_active", label: "Status", value: url.get("is_active") === "true" ? "Active" : "Inactive", onRemove: () => url.set({ is_active: null }) });
  for (const [key, label, fmt] of [
    ["strategy", "Strategy", titleCase],
    ["result", "Has result", (v: string) => RESULT_LABELS[v] ?? v],
  ] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map((v) => fmt(v)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="Buy boxes"
        description="Investment criteria that decide whether a property fits a strategy before it is scored."
        actions={
          can("buybox", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New buy box
            </Button>
          )
        }
      />

      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="buybox" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search buy boxes…" />
              <FacetFilter
                label="Strategy"
                options={Object.entries(facets?.strategy ?? {}).sort().map(([v, c]) => ({ value: v, label: titleCase(v), count: c }))}
                selected={url.getAll("strategy")}
                onChange={(v) => url.set({ strategy: v })}
              />
              <FacetFilter
                label="Active"
                single
                options={[
                  { value: "true", label: "Active", count: facets?.is_active.true ?? 0 },
                  { value: "false", label: "Inactive", count: facets?.is_active.false ?? 0 },
                ]}
                selected={url.getAll("is_active")}
                onChange={(v) => url.set({ is_active: v[0] ?? null })}
              />
              <FacetFilter
                label="Result"
                options={RESULTS.map((r) => ({ value: r, label: RESULT_LABELS[r], count: facets?.result[r] ?? 0 }))}
                selected={url.getAll("result")}
                onChange={(v) => url.set({ result: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
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
          rowHref={(b) => `/buy-boxes/${b.id}${url.getAll("result").length === 1 ? `?result=${url.get("result")}` : ""}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Filter />}
              title={filtered ? "No buy boxes match these filters" : "No buy boxes yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Define a strategy's criteria so new properties are evaluated automatically."}
              action={
                can("buybox", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New buy box
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <BuyBoxFormSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function BuyBoxesPage() {
  return (
    <Suspense>
      <BuyBoxesView />
    </Suspense>
  );
}
