"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, Plus, Radar } from "lucide-react";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, titleCase } from "@/lib/utils";

import { CATEGORY_LABELS, SEVERITIES, SIGNAL_CATEGORIES, SIGNAL_STATUSES, signalTitle, useSignalTypes, type Signal, type SignalFacets } from "@/features/signals/api";
import { CategoryBadge, DecayBar, PriorityBadge, SensitiveBadge, SeverityBadge } from "@/features/signals/components";
import { SignalSheet } from "@/features/signals/signal-sheet";
import { SignalSubscriptionsTab } from "@/features/signals/subscriptions-tab";
import { SignalTypesTab } from "@/features/signals/signal-types-tab";

const TABS = ["signals", "types", "subscriptions"] as const;

const MORE: MoreFilterField[] = [
  { type: "date-range", label: "Observed", minKey: "observed_from", maxKey: "observed_to" },
  { type: "number", label: "Minimum confidence", key: "min_confidence", suffix: "0–1" },
  { type: "select", label: "Verification", key: "verification", options: [{ value: "verified", label: "Verified" }, { value: "unverified", label: "Unverified" }, { value: "rejected", label: "Rejected" }] },
  { type: "select", label: "Sensitivity", key: "sensitive", options: [{ value: "true", label: "Sensitive only" }, { value: "false", label: "Not sensitive" }] },
];

const CHIP_LABELS: Record<string, string> = {
  observed_from: "Observed from", observed_to: "Observed to", min_confidence: "Confidence ≥", verification: "Verification", sensitive: "Sensitive",
};

const columns: Column<Signal>[] = [
  {
    id: "signal",
    header: "Signal",
    cell: (s) => (
      <div className="min-w-[240px] max-w-[360px]">
        <p className="flex items-center gap-1.5 truncate font-medium text-ink">
          <span className="truncate">{signalTitle(s)}</span>
          {s.is_sensitive && <SensitiveBadge />}
        </p>
        <p className="truncate text-xs text-ink-3">
          {s.property_id ? (
            <Link href={`/properties/${s.property_id}`} className="hover:text-ink hover:underline">
              {s.property_label ?? "Property"}
            </Link>
          ) : null}
          {s.property_id && s.owner_id ? " · " : null}
          {s.owner_id ? `Owner: ${s.owner_label ?? "—"}` : null}
        </p>
      </div>
    ),
  },
  { id: "category", header: "Category", sortKey: "category", hideable: true, cell: (s) => <CategoryBadge category={s.category} /> },
  { id: "severity", header: "Severity", sortKey: "severity", hideable: true, cell: (s) => <SeverityBadge severity={s.severity} /> },
  { id: "priority", header: "Priority", hideable: true, cell: (s) => <PriorityBadge priority={s.priority} stacked={s.stacked} /> },
  { id: "observed", header: "Observed", sortKey: "observed_on", hideable: true, cell: (s) => <span className="whitespace-nowrap text-ink-2">{formatDate(s.observed_on)}</span> },
  { id: "source", header: "Source", hideable: true, cell: (s) => <span className="block max-w-[180px] truncate text-ink-2">{s.source}</span> },
  { id: "confidence", header: "Confidence", sortKey: "confidence", align: "right", hideable: true, cell: (s) => `${Math.round(s.confidence * 100)}%` },
  { id: "weight", header: "Current weight", hideable: true, width: 120, cell: (s) => <DecayBar signal={s} /> },
  { id: "expires", header: "Expires", sortKey: "expires_on", hideable: true, defaultHidden: true, cell: (s) => <span className="whitespace-nowrap text-ink-2">{formatDate(s.expires_on)}</span> },
  { id: "status", header: "Status", hideable: true, cell: (s) => <StatusBadge status={s.effective_status} /> },
  { id: "verification", header: "Verification", hideable: true, defaultHidden: true, cell: (s) => <StatusBadge status={s.verification} /> },
];

function SignalsList({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const list = useListQuery<Signal>("signals", "/signals");
  const { url } = list;
  const cols = useColumnVisibility("signals", columns);
  const { data: types = [] } = useSignalTypes();
  const [openId, setOpenId] = useState<string | null>(null);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["signals", "facets", filterParams],
    queryFn: () => api.get<SignalFacets>("/signals/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const typeLabel = (k: string) => types.find((t) => t.key === k)?.label ?? titleCase(k);
  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: titleCase(url.get(k)!), onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label, fmt] of [
    ["category", "Category", (v: string) => CATEGORY_LABELS[v] ?? v],
    ["severity", "Severity", (v: string) => v],
    ["status", "Status", titleCase],
    ["signal_type", "Type", typeLabel],
  ] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => fmt(v)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const exportCsv = async () => {
    try {
      await api.download("/signals/export", filterParams, "signals.csv");
      toast.success("Export excludes sensitive signals");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  {can("signals", "export") && (
                    <Button onClick={exportCsv}>
                      <Download /> Export
                    </Button>
                  )}
                  <SavedViewsMenu module="signals" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search title, source, type, property…" />
              <FacetFilter label="Category" options={SIGNAL_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c], count: facets?.category?.[c] ?? 0 }))} selected={url.getAll("category")} onChange={(v) => url.set({ category: v })} />
              <FacetFilter label="Severity" options={SEVERITIES.map((s) => ({ value: String(s), label: `Severity ${s}`, count: facets?.severity?.[String(s)] ?? 0 }))} selected={url.getAll("severity")} onChange={(v) => url.set({ severity: v })} />
              <FacetFilter label="Status" options={SIGNAL_STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status?.[s] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter
                label="Type"
                searchable
                options={Object.entries(facets?.signal_type ?? {}).map(([k, c]) => ({ value: k, label: typeLabel(k), count: c }))}
                selected={url.getAll("signal_type")}
                onChange={(v) => url.set({ signal_type: v })}
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
          onRowClick={(s) => setOpenId(s.id)}
          hidden={cols.hidden}
          rowClassName={(s) => (s.effective_status !== "active" ? "opacity-60" : undefined)}
          empty={
            <EmptyState
              icon={<Radar />}
              title={filtered ? "No signals match these filters" : "No signals yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Record dated, sourced events such as liens, maturities, vacancies or rezonings."}
              action={
                can("signals", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => onCreatingChange(true)}>
                    <Plus /> Record signal
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>
      <SignalSheet open={creating} onOpenChange={onCreatingChange} />
      <SignalSheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)} signalId={openId} />
    </>
  );
}

function SignalsView() {
  const { can } = useAuth();
  const url = useUrlState();
  const raw = url.get("tab");
  const tab = TABS.includes(raw as (typeof TABS)[number]) ? (raw as string) : "signals";
  const [creatingSignal, setCreatingSignal] = useState(false);
  const [creatingType, setCreatingType] = useState(false);
  const [creatingSub, setCreatingSub] = useState(false);

  return (
    <>
      <PageHeader
        title="Signals"
        description="Dated, sourced events that change owner motivation, property risk, market attractiveness or reactivation probability."
        actions={
          tab === "signals" && can("signals", "create") ? (
            <Button variant="primary" onClick={() => setCreatingSignal(true)}>
              <Plus /> Record signal
            </Button>
          ) : tab === "types" && can("signals", "approve") ? (
            <Button variant="primary" onClick={() => setCreatingType(true)}>
              <Plus /> New type
            </Button>
          ) : tab === "subscriptions" ? (
            <Button variant="primary" onClick={() => setCreatingSub(true)}>
              <Plus /> New subscription
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "signals" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "signals", label: "Signals" },
            { value: "types", label: "Types & decay" },
            { value: "subscriptions", label: "Subscriptions" },
          ]}
        />
        <TabPanel value="signals">{tab === "signals" && <SignalsList creating={creatingSignal} onCreatingChange={setCreatingSignal} />}</TabPanel>
        <TabPanel value="types">{tab === "types" && <SignalTypesTab creating={creatingType} onCreatingChange={setCreatingType} />}</TabPanel>
        <TabPanel value="subscriptions">{tab === "subscriptions" && <SignalSubscriptionsTab creating={creatingSub} onCreatingChange={setCreatingSub} />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function SignalsPage() {
  return (
    <Suspense>
      <SignalsView />
    </Suspense>
  );
}
