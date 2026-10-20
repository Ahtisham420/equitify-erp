"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HandCoins, Plus, RefreshCw } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber, formatRelative, titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";
import { COMMISSION_STATUSES, RECONCILIATION_STATES, SIDES, type CommissionListItem, type Facets } from "@/features/commissions/api";
import { CommissionFormSheet } from "@/features/commissions/commission-form";
import { CStatus, CommissionSheet } from "@/features/commissions/commission-sheet";
import { ForecastTab } from "@/features/commissions/forecast-tab";
import { InvoicesTab } from "@/features/commissions/invoices-tab";
import { ProductionTab } from "@/features/commissions/production-tab";
import { SplitPlansTab } from "@/features/commissions/split-plans-tab";

const MORE: MoreFilterField[] = [
  { type: "range", label: "Gross commission", minKey: "min_gross", maxKey: "max_gross", suffix: "$" },
  { type: "date-range", label: "Expected payment", minKey: "expected_from", maxKey: "expected_to" },
  { type: "text", label: "Source", key: "source" },
];
const CHIP_LABELS: Record<string, string> = { min_gross: "Min gross", max_gross: "Max gross", expected_from: "Expected from", expected_to: "Expected to", source: "Source" };

function columnsFor(restricted: boolean): Column<CommissionListItem>[] {
  return [
    {
      id: "title",
      header: "Commission",
      sortKey: "title",
      cell: (c) => (
        <div className="min-w-[220px] max-w-[340px]">
          <p className="truncate font-medium text-ink">{c.title}</p>
          <p className="truncate text-xs text-ink-3">{[c.agent_name, c.side ? titleCase(c.side) : null, c.property_type ? PROPERTY_TYPE_LABELS[c.property_type] ?? titleCase(c.property_type) : null].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortKey: "status",
      cell: (c) => (
        <div className="flex items-center gap-1">
          <CStatus status={c.status} />
          {c.approved_at && c.status !== "paid" && <Badge tone="outline">Approved</Badge>}
        </div>
      ),
    },
    { id: "gross", header: "Gross", sortKey: "gross", align: "right", cell: (c) => formatCurrency(c.gross) },
    restricted
      ? { id: "my_net", header: "My net", align: "right", cell: (c) => <span className="font-medium">{formatCurrency(c.my_net)}</span> }
      : { id: "house", header: "House", align: "right", hideable: true, cell: (c) => formatCurrency(c.house_amount) },
    { id: "prob", header: "Probability", sortKey: "probability", align: "right", hideable: true, cell: (c) => (c.status === "forecast" && c.probability != null ? `${formatNumber(c.probability, 0)}%` : "—") },
    { id: "expected", header: "Expected payment", sortKey: "expected_on", hideable: true, cell: (c) => <span className="whitespace-nowrap text-ink-2">{formatDate(c.expected_on)}</span> },
    { id: "paid", header: "Paid", align: "right", hideable: true, cell: (c) => (c.paid_total ? formatCurrency(c.paid_total) : "—") },
    {
      id: "recon",
      header: "Reconciliation",
      hideable: true,
      cell: (c) => (c.reconciliation_status === "unpaid" ? <span className="text-ink-3">—</span> : <CStatus status={c.reconciliation_status} />),
    },
    { id: "volume", header: "Volume", sortKey: "deal_volume", align: "right", hideable: true, defaultHidden: true, cell: (c) => formatCurrency(c.deal_volume, { compact: true }) },
    { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (c) => <span className="text-xs text-ink-3">{formatRelative(c.updated_at)}</span> },
  ];
}

function CommissionsList({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useAuth();
  const restricted = !can("commissions", "view_sensitive");
  const columns = useMemo(() => columnsFor(restricted), [restricted]);
  const list = useListQuery<CommissionListItem>("commissions", "/commissions");
  const { url } = list;
  const cols = useColumnVisibility("commissions", columns);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, open: _c, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["commissions", "facets", filterParams],
    queryFn: () => api.get<Facets>("/commissions/facets", filterParams),
    placeholderData: (p) => p,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label] of [["status", "Status"], ["side", "Side"], ["property_type", "Property type"], ["reconciliation_status", "Reconciliation"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => (key === "property_type" ? PROPERTY_TYPE_LABELS[v] ?? v : titleCase(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="commissions" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search commissions…" />
            <FacetFilter label="Status" options={COMMISSION_STATUSES.map((v) => ({ value: v, label: titleCase(v), count: facets?.status?.[v] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Side" options={SIDES.map((v) => ({ value: v, label: titleCase(v), count: facets?.side?.[v] ?? 0 }))} selected={url.getAll("side")} onChange={(v) => url.set({ side: v })} />
            <FacetFilter
              label="Property type"
              options={Object.entries(facets?.property_type ?? {}).map(([v, c]) => ({ value: v, label: PROPERTY_TYPE_LABELS[v] ?? titleCase(v), count: c }))}
              selected={url.getAll("property_type")}
              onChange={(v) => url.set({ property_type: v })}
            />
            <FacetFilter label="Reconciliation" options={RECONCILIATION_STATES.map((v) => ({ value: v, label: titleCase(v), count: facets?.reconciliation_status?.[v] ?? 0 }))} selected={url.getAll("reconciliation_status")} onChange={(v) => url.set({ reconciliation_status: v })} />
            <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
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
        onRowClick={(c) => onOpen(c.id)}
        hidden={cols.hidden}
        empty={
          <EmptyState
            icon={<HandCoins />}
            title={chips.length || url.get("q") ? "No commissions match these filters" : "No commission records yet"}
            description={chips.length || url.get("q") ? "Try removing a filter." : "Records are created from brokerage transactions or added manually."}
          />
        }
      />
    </ListCard>
  );
}

function CommissionsView() {
  const url = useUrlState();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const tab = url.get("tab") ?? "list";
  const openId = url.get("open");
  const openCommission = (id: string) => url.set({ open: id }, { resetPage: false });

  const sync = useMutation({
    mutationFn: () => api.post<{ available: boolean; created: number; updated: number; earned: number; cancelled: number; message: string | null }>("/commissions/sync"),
    onSuccess: (r) => {
      if (!r.available) toast.error(r.message ?? "Brokerage module unavailable");
      else toast.success(`Synced: ${r.created} created, ${r.updated} updated, ${r.earned} earned, ${r.cancelled} cancelled`);
      qc.invalidateQueries({ queryKey: ["commissions"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const tabs = [
    { value: "list", label: "Commissions" },
    { value: "forecast", label: "Forecast" },
    { value: "production", label: "Production" },
    { value: "invoices", label: "Invoices" },
    ...(can("commissions", "view_sensitive") ? [{ value: "plans", label: "Split plans" }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Commissions"
        description="Commission records, forecast, invoicing, reconciliation and production — one system, no side spreadsheets."
        actions={
          <>
            {can("commissions", "edit") && (
              <Button loading={sync.isPending} onClick={() => sync.mutate()}>
                <RefreshCw /> Sync from transactions
              </Button>
            )}
            {can("commissions", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New commission
              </Button>
            )}
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "list" ? null : v })}>
        <TabList className="mb-5" tabs={tabs} />
        <TabPanel value="list">{tab === "list" && <CommissionsList onOpen={openCommission} />}</TabPanel>
        <TabPanel value="forecast">{tab === "forecast" && <ForecastTab />}</TabPanel>
        <TabPanel value="production">{tab === "production" && <ProductionTab />}</TabPanel>
        <TabPanel value="invoices">{tab === "invoices" && <InvoicesTab onOpenCommission={openCommission} />}</TabPanel>
        <TabPanel value="plans">{tab === "plans" && <SplitPlansTab />}</TabPanel>
      </Tabs>
      <CommissionFormSheet open={creating} onOpenChange={setCreating} onSaved={openCommission} />
      <CommissionSheet id={openId} onClose={() => url.set({ open: null }, { resetPage: false })} />
    </>
  );
}

export default function CommissionsPage() {
  return (
    <Suspense>
      <CommissionsView />
    </Suspense>
  );
}
