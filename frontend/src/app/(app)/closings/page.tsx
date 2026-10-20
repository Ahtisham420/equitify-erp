"use client";

import { useQuery } from "@tanstack/react-query";
import { KeyRound, Lock, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, isOverdue, titleCase } from "@/lib/utils";

import { CLOSING_STATUSES, wireTone, type ClosingFacets, type ClosingListItem } from "@/features/closing/api";
import { ClosingCreateSheet } from "@/features/closing/closing-form";

const MORE: MoreFilterField[] = [
  { type: "date-range", label: "Scheduled closing", minKey: "scheduled_from", maxKey: "scheduled_to" },
  { type: "select", label: "Asset conversion", key: "asset_pending", options: [{ value: "true", label: "Pending retry" }, { value: "false", label: "Converted / not due" }] },
];
const CHIP_LABELS: Record<string, string> = { scheduled_from: "Closing from", scheduled_to: "Closing to", asset_pending: "Asset pending" };

const columns: Column<ClosingListItem>[] = [
  {
    id: "deal",
    header: "Closing",
    cell: (c) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{c.opportunity_title ?? "Closing"}</p>
        <p className="truncate text-xs text-ink-3">{c.property_label ?? "—"}</p>
      </div>
    ),
  },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (c) => <StatusBadge status={c.status} /> },
  {
    id: "scheduled",
    header: "Scheduled",
    sortKey: "scheduled_closing_on",
    hideable: true,
    cell: (c) => (
      <span className={cn("whitespace-nowrap text-xs", c.status === "open" && isOverdue(c.scheduled_closing_on) ? "font-medium text-negative" : "text-ink-2")}>
        {formatDate(c.closed_on ?? c.scheduled_closing_on)}
      </span>
    ),
  },
  {
    id: "readiness",
    header: "Checklist",
    hideable: true,
    width: 150,
    cell: (c) => (
      <div className="flex items-center gap-2">
        <Progress value={c.items_total ? (c.items_done / c.items_total) * 100 : 0} className="w-14" />
        <span className="text-xs text-ink-3 tabular">{c.items_done}/{c.items_total}</span>
      </div>
    ),
  },
  {
    id: "blocking",
    header: "Blocking",
    align: "right",
    hideable: true,
    cell: (c) =>
      c.status !== "open" ? <span className="text-ink-3">—</span> : c.blocking_open ? (
        <Badge tone="red"><Lock className="size-3" />{c.blocking_open} open</Badge>
      ) : (
        <Badge tone="green">Clear</Badge>
      ),
  },
  { id: "wire", header: "Wire", hideable: true, cell: (c) => <Badge tone={wireTone(c.wire_status)} dot>{c.wire_status === "missing" ? "Not recorded" : titleCase(c.wire_status)}</Badge> },
  { id: "price", header: "Price", sortKey: "purchase_price", align: "right", hideable: true, cell: (c) => formatCurrency(c.purchase_price) },
  { id: "basis", header: "Basis", sortKey: "basis", align: "right", hideable: true, defaultHidden: true, cell: (c) => formatCurrency(c.basis) },
  { id: "coordinator", header: "Coordinator", hideable: true, cell: (c) => <span className="whitespace-nowrap text-ink-2">{c.coordinator_name ?? "—"}</span> },
  { id: "manager", header: "Asset manager", hideable: true, defaultHidden: true, cell: (c) => <span className="whitespace-nowrap text-ink-2">{c.manager_name ?? "—"}</span> },
  {
    id: "asset",
    header: "Asset",
    hideable: true,
    cell: (c) => (c.asset_pending ? <Badge tone="amber">Pending</Badge> : c.asset_id ? <Badge tone="green">Created</Badge> : <span className="text-ink-3">—</span>),
  },
];

function ClosingsView() {
  const { can } = useAuth();
  const router = useRouter();
  const list = useListQuery<ClosingListItem>("closings", "/closings");
  const { url } = list;
  const cols = useColumnVisibility("closings", columns);
  const [creating, setCreating] = useState(false);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["closings", "facets", filterParams],
    queryFn: () => api.get<ClosingFacets>("/closings/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  if (url.getAll("status").length)
    chips.unshift({ key: "status", label: "Status", value: url.getAll("status").map(titleCase).join(", "), onRemove: () => url.set({ status: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="Closings"
        description="Blocking checklist, independent wire verification, final sources and uses, and the handoff to operations."
        actions={
          can("closing", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> Open closing
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
                  <SavedViewsMenu module="closing" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search opportunity or property…" />
              <FacetFilter
                label="Status"
                options={CLOSING_STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status?.[s] ?? 0 }))}
                selected={url.getAll("status")}
                onChange={(v) => url.set({ status: v })}
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
          rowHref={(c) => `/closings/${c.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<KeyRound />}
              title={filtered ? "No closings match these filters" : "No closings yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "A closing opens when an opportunity reaches the closing stage."}
              action={
                can("closing", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> Open closing
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>
      <ClosingCreateSheet open={creating} onOpenChange={setCreating} onCreated={(c) => router.push(`/closings/${c.id}`)} />
    </>
  );
}

export default function ClosingsPage() {
  return (
    <Suspense>
      <ClosingsView />
    </Suspense>
  );
}
