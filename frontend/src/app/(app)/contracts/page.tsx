"use client";

import { useQuery } from "@tanstack/react-query";
import { FileSignature, Plus } from "lucide-react";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, Progress } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatRelative, titleCase } from "@/lib/utils";

import { CONTRACT_STATUSES, CONTRACT_TYPE_LABELS, CONTRACT_TYPES, useUserOptions, type ContractFacets, type ContractListItem } from "@/features/contracts/api";
import { ContractFormSheet } from "@/features/contracts/contract-form";

const STATUS_TONES = { draft: "neutral", executed: "green", closed: "sky", terminated: "red" } as const;

const MORE: MoreFilterField[] = [{ type: "date-range", label: "Effective date", minKey: "effective_from", maxKey: "effective_to" }];
const CHIP_LABELS: Record<string, string> = { effective_from: "Effective from", effective_to: "Effective to" };

const columns: Column<ContractListItem>[] = [
  {
    id: "contract",
    header: "Contract",
    sortKey: "title",
    cell: (c) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{c.title}</p>
        <p className="truncate text-xs text-ink-3">{[c.property_label, c.opportunity_label].filter(Boolean).join(" · ") || "—"}</p>
      </div>
    ),
  },
  {
    id: "status",
    header: "Status",
    sortKey: "status",
    hideable: true,
    cell: (c) => (
      <Badge tone={STATUS_TONES[c.status as keyof typeof STATUS_TONES] ?? "neutral"} dot>
        {titleCase(c.status)}
      </Badge>
    ),
  },
  { id: "type", header: "Type", hideable: true, defaultHidden: true, cell: (c) => <span className="text-ink-2">{CONTRACT_TYPE_LABELS[c.contract_type] ?? titleCase(c.contract_type)}</span> },
  { id: "effective", header: "Effective", sortKey: "effective_on", hideable: true, cell: (c) => <span className="whitespace-nowrap text-ink-2 tabular">{formatDate(c.effective_on)}</span> },
  {
    id: "feasibility",
    header: "Feasibility",
    hideable: true,
    cell: (c) =>
      c.feasibility_on ? (
        <span className={cn("whitespace-nowrap tabular", c.days_to_feasibility != null && c.days_to_feasibility < 0 ? "text-ink-3" : c.days_to_feasibility != null && c.days_to_feasibility <= 7 ? "font-medium text-caution" : "text-ink-2")}>
          {formatDate(c.feasibility_on)}
          {c.days_to_feasibility != null && c.days_to_feasibility >= 0 && <span className="ml-1.5 text-xs text-ink-3">{c.days_to_feasibility}d</span>}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "closing", header: "Closing", hideable: true, cell: (c) => <span className="whitespace-nowrap text-ink-2 tabular">{formatDate(c.closing_on)}</span> },
  {
    id: "dd",
    header: "DD",
    hideable: true,
    width: 120,
    cell: (c) =>
      c.dd_total ? (
        <div className="flex items-center gap-2">
          <Progress value={(100 * c.dd_done) / c.dd_total} className="w-12" tone="accent" />
          <span className="text-xs text-ink-3 tabular">
            {c.dd_done}/{c.dd_total}
          </span>
        </div>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  {
    id: "blockers",
    header: "Blockers",
    align: "right",
    hideable: true,
    cell: (c) => (c.open_blockers ? <span className="font-medium text-negative">{c.open_blockers}</span> : <span className="text-ink-3">0</span>),
  },
  { id: "price", header: "Price", sortKey: "purchase_price", align: "right", hideable: true, cell: (c) => formatCurrency(c.purchase_price, { compact: true }) },
  {
    id: "owner",
    header: "Coordinator",
    hideable: true,
    cell: (c) =>
      c.owner_name ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          <Avatar name={c.owner_name} size={20} /> {c.owner_name}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (c) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(c.updated_at)}</span> },
];

function ContractsView() {
  const { can } = useAuth();
  const list = useListQuery<ContractListItem>("contracts", "/contracts");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const cols = useColumnVisibility("contracts", columns);
  const { data: users } = useUserOptions();
  const userName = (id: string) => users?.find((u) => u.id === id)?.full_name ?? "Unknown user";

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["contracts", "facets", filterParams],
    queryFn: () => api.get<ContractFacets>("/contracts/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: formatDate(url.get(k)), onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label, fmt] of [
    ["status", "Status", titleCase],
    ["contract_type", "Type", (v: string) => CONTRACT_TYPE_LABELS[v] ?? v],
    ["owner_id", "Coordinator", userName],
  ] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => fmt(v)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const hasFilters = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="Contracts & due diligence"
        description="Executed agreements turned into accountable deadlines and a diligence command center."
        actions={
          <>
            <Link href="/critical-dates">
              <Button>Critical dates</Button>
            </Link>
            {can("contracts", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New contract
              </Button>
            )}
          </>
        }
      />
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="contracts" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search contracts…" />
              <FacetFilter
                label="Status"
                options={CONTRACT_STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status[s] ?? 0 }))}
                selected={url.getAll("status")}
                onChange={(v) => url.set({ status: v })}
              />
              <FacetFilter
                label="Type"
                options={CONTRACT_TYPES.map((t) => ({ value: t, label: CONTRACT_TYPE_LABELS[t], count: facets?.contract_type[t] ?? 0 }))}
                selected={url.getAll("contract_type")}
                onChange={(v) => url.set({ contract_type: v })}
              />
              <FacetFilter
                label="Coordinator"
                searchable
                options={Object.entries(facets?.owner_id ?? {}).map(([id, n]) => ({ value: id, label: userName(id), count: n }))}
                selected={url.getAll("owner_id")}
                onChange={(v) => url.set({ owner_id: v })}
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
          rowHref={(c) => `/contracts/${c.id}`}
          hidden={cols.hidden}
          rowClassName={(c) => (c.status === "terminated" ? "opacity-70" : undefined)}
          empty={
            <EmptyState
              icon={<FileSignature />}
              title={hasFilters ? "No contracts match these filters" : "No contracts yet"}
              description={hasFilters ? "Try removing a filter or broadening your search." : "Record an agreement to generate its critical dates and diligence checklist."}
              action={
                can("contracts", "create") && !hasFilters ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New contract
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>
      <ContractFormSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function ContractsPage() {
  return (
    <Suspense>
      <ContractsView />
    </Suspense>
  );
}
