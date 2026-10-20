"use client";

import { useQuery } from "@tanstack/react-query";
import { Calculator, Lock, Plus } from "lucide-react";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatRelative, titleCase } from "@/lib/utils";

import { TEMPLATE_LABELS, TEMPLATES, UW_STATUSES, formatOutput, type UwListItem } from "@/features/underwriting/api";
import { UwModelCreateSheet } from "@/features/underwriting/model-form";

const columns: Column<UwListItem>[] = [
  {
    id: "name",
    header: "Model",
    sortKey: "name",
    cell: (m) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="flex items-center gap-1.5 truncate font-medium text-ink">
          {m.name}
          {m.is_locked && <Lock className="size-3.5 text-ink-3" aria-label="Locked" />}
        </p>
        {m.property_id ? (
          <Link href={`/properties/${m.property_id}?tab=underwriting`} onClick={(e) => e.stopPropagation()} className="truncate text-xs text-ink-3 hover:text-ink hover:underline">
            {m.property_label ?? "Property"}
          </Link>
        ) : (
          <p className="text-xs text-ink-3">No property</p>
        )}
      </div>
    ),
  },
  { id: "template", header: "Template", sortKey: "template", hideable: true, cell: (m) => <span className="text-ink-2">{TEMPLATE_LABELS[m.template] ?? titleCase(m.template)}</span> },
  { id: "version", header: "Version", sortKey: "version", align: "right", cell: (m) => `v${m.version}` },
  { id: "status", header: "Status", sortKey: "status", cell: (m) => <StatusBadge status={m.status} /> },
  { id: "price", header: "Price", align: "right", hideable: true, cell: (m) => formatCurrency(m.purchase_price, { compact: true }) },
  { id: "cap", header: "Going-in cap", align: "right", hideable: true, cell: (m) => formatOutput("going_in_cap", m.going_in_cap) },
  { id: "irr", header: "Levered IRR", align: "right", hideable: true, cell: (m) => formatOutput("irr", m.irr) },
  { id: "multiple", header: "Multiple", align: "right", hideable: true, cell: (m) => formatOutput("equity_multiple", m.equity_multiple) },
  {
    id: "sources",
    header: "Sources",
    hideable: true,
    cell: (m) => (m.unsourced_count ? <Badge tone="amber">{m.unsourced_count} unsourced</Badge> : <Badge tone="green">Sourced</Badge>),
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (m) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(m.updated_at)}</span> },
];

function UnderwritingView() {
  const { can } = useAuth();
  const list = useListQuery<UwListItem>("uw-models", "/uw-models");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const cols = useColumnVisibility("uw-models", columns);
  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["uw-models", "facets", filterParams],
    queryFn: () => api.get<{ status: Record<string, number>; template: Record<string, number> }>("/uw-models/facets", filterParams),
    placeholderData: (prev) => prev,
  });
  const allVersions = url.get("latest_only") === "false";

  const chips: FilterChip[] = [];
  for (const [key, label, labels] of [["status", "Status", {} as Record<string, string>], ["template", "Template", TEMPLATE_LABELS]] as const) {
    const v = url.getAll(key);
    if (v.length) chips.push({ key, label, value: v.map((x) => labels[x] ?? titleCase(x)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (allVersions) chips.push({ key: "latest_only", label: "Showing", value: "all versions", onRemove: () => url.set({ latest_only: null }) });

  return (
    <>
      <PageHeader
        title="Underwriting"
        description="Versioned, source-linked models. Approved versions are locked and feed offers."
        actions={
          can("underwriting", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New model
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
                  <SavedViewsMenu module="underwriting" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search models…" />
              <FacetFilter label="Status" options={UW_STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status?.[s] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Template" options={TEMPLATES.map((t) => ({ value: t, label: TEMPLATE_LABELS[t], count: facets?.template?.[t] ?? 0 }))} selected={url.getAll("template")} onChange={(v) => url.set({ template: v })} />
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <Checkbox checked={allVersions} onChange={(v) => url.set({ latest_only: v ? "false" : null })} />
                Show all versions
              </label>
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowHref={(m) => `/underwriting/${m.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Calculator />}
              title={chips.length || url.get("q") ? "No models match these filters" : "No underwriting models yet"}
              description="Start from a property-type template; tenant rows are seeded from the property."
              action={can("underwriting", "create") && !chips.length ? <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New model</Button> : undefined}
            />
          }
        />
      </ListCard>
      <UwModelCreateSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function UnderwritingPage() {
  return (
    <Suspense>
      <UnderwritingView />
    </Suspense>
  );
}
