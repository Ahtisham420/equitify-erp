"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Gauge, RefreshCw, ShieldCheck } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatRelative, titleCase } from "@/lib/utils";

import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS } from "@/features/properties/api";
import { BANDS, BAND_LABELS, useRescoreAll, type RankingFacets, type RankingItem } from "@/features/scoring/api";
import { ComponentStrip, ScoreDelta, ScoreExplanationSheet, ScorePill } from "@/features/scoring/components";
import { ConfigsTab } from "@/features/scoring/configs-tab";
import { OutcomesTab } from "@/features/scoring/outcomes-tab";

const TABS = ["rankings", "outcomes", "configuration"] as const;

interface TerritoryLite { id: string; name: string }

const CHIP_LABELS: Record<string, string> = {
  min_score: "Score ≥", max_score: "Score ≤", min_confidence: "Confidence ≥", needs_research: "Needs research", territory_id: "Territory",
};

const columns: Column<RankingItem>[] = [
  { id: "rank", header: "#", width: 48, align: "right", cell: (r) => <span className="text-xs text-ink-3">{r.position}</span> },
  {
    id: "property",
    header: "Property",
    cell: (r) => (
      <div className="min-w-[220px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{r.property_label ?? "Property"}</p>
        <p className="truncate text-xs text-ink-3">{[r.property_type ? PROPERTY_TYPE_LABELS[r.property_type] ?? titleCase(r.property_type) : null, r.property_city, r.property_state].filter(Boolean).join(" · ")}</p>
      </div>
    ),
  },
  {
    id: "score",
    header: "Score",
    sortKey: "score",
    align: "right",
    cell: (r) => (
      <div className="flex items-center justify-end gap-2">
        <ScoreDelta score={r.score} previous={r.previous_score} />
        <ScorePill score={r.score} />
      </div>
    ),
  },
  { id: "confidence", header: "Confidence", sortKey: "confidence", align: "right", hideable: true, cell: (r) => r.confidence.toFixed(2) },
  { id: "profile", header: "Components", hideable: true, cell: (r) => <ComponentStrip values={r.component_values} /> },
  {
    id: "drivers",
    header: "Key drivers",
    hideable: true,
    cell: (r) => (
      <div className="max-w-[320px] text-xs">
        {r.top_positive && <p className="truncate text-ink-2">+ {r.top_positive}</p>}
        {r.top_negative && <p className="truncate text-ink-3">− {r.top_negative}</p>}
      </div>
    ),
  },
  {
    id: "flags",
    header: "Flags",
    hideable: true,
    cell: (r) => (
      <div className="flex gap-1">
        {r.needs_research && (
          <Tooltip content="High score on weak evidence — research before acting">
            <span className="inline-flex">
              <Badge tone="amber">
                <AlertTriangle className="size-3" /> Research
              </Badge>
            </span>
          </Tooltip>
        )}
        {r.requires_human_approval && (
          <Tooltip content="High-dollar or unknown value: automation needs human approval">
            <span className="inline-flex">
              <Badge tone="outline">
                <ShieldCheck className="size-3" /> Approval
              </Badge>
            </span>
          </Tooltip>
        )}
      </div>
    ),
  },
  { id: "asking", header: "Asking", align: "right", hideable: true, cell: (r) => formatCurrency(r.asking_price, { compact: true }) },
  { id: "computed", header: "Scored", sortKey: "computed_at", hideable: true, defaultHidden: true, cell: (r) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(r.computed_at)}</span> },
  { id: "version", header: "Config", align: "right", hideable: true, defaultHidden: true, cell: (r) => `v${r.config_version}` },
];

function Rankings() {
  const url = useUrlState();
  const band = url.get("band") ?? "high";
  const page = url.getNumber("page", 1);
  const pageSize = url.getNumber("page_size", 50);
  const cols = useColumnVisibility("scoring-rankings", columns);
  const [open, setOpen] = useState<RankingItem | null>(null);

  const { data: territories = [] } = useQuery({
    queryKey: ["territories", "options"],
    queryFn: () => api.get<TerritoryLite[]>("/territories/options"),
    staleTime: 5 * 60_000,
  });

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, band: _b, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["scoring", "rankings", "facets", filterParams, band],
    queryFn: () => api.get<RankingFacets>("/scoring/rankings/facets", { ...filterParams, band }),
    placeholderData: (prev) => prev,
  });

  const more: MoreFilterField[] = [
    { type: "range", label: "Score", minKey: "min_score", maxKey: "max_score" },
    { type: "number", label: "Minimum confidence", key: "min_confidence", suffix: "0–1" },
    { type: "select", label: "Needs research", key: "needs_research", options: [{ value: "true", label: "Only flagged for research" }, { value: "false", label: "Not flagged" }] },
    { type: "select", label: "Territory", key: "territory_id", options: territories.map((t) => ({ value: t.id, label: t.name })) },
  ];

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({
      key: k,
      label,
      value: k === "territory_id" ? territories.find((t) => t.id === url.get(k))?.name ?? "Territory" : titleCase(url.get(k)!),
      onRemove: () => url.set({ [k]: null }),
    }));
  const types = url.getAll("property_type");
  if (types.length) chips.unshift({ key: "property_type", label: "Type", value: types.map((t) => PROPERTY_TYPE_LABELS[t] ?? t).join(", "), onRemove: () => url.set({ property_type: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  // `band` is always sent: rankings are ordered by score within one confidence band.
  const list = useQuery({
    queryKey: ["scoring", "rankings", "list", url.params, band, page, pageSize],
    queryFn: () => api.get<Page<RankingItem>>("/scoring/rankings", { ...url.params, band, page, page_size: pageSize }),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <Tabs value={band} onValueChange={(v) => url.set({ band: v === "high" ? null : v })}>
        <TabList className="mb-4" tabs={BANDS.map((b) => ({ value: b, label: BAND_LABELS[b], count: facets?.band?.[b] ?? 0 }))} />
      </Tabs>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="scoring" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property, city, county…" />
              <FacetFilter
                label="Type"
                options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t], count: facets?.property_type?.[t] ?? 0 }))}
                selected={types}
                onChange={(v) => url.set({ property_type: v })}
              />
              <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort"), band: url.get("band") })} />
          </div>
        }
        footer={
          <TableFooter page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPage={(p) => url.set({ page: p }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={setOpen}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Gauge />}
              title={filtered ? "No ranked properties match these filters" : `No ${band}-confidence properties`}
              description={
                filtered
                  ? "Try removing a filter."
                  : "Only properties that pass a buy box (or have an approved exception) are scored. Confidence bands follow data completeness, source quality, age and verification."
              }
            />
          }
        />
      </ListCard>
      <ScoreExplanationSheet propertyId={open?.property_id ?? null} title={open?.property_label} onOpenChange={(o) => !o && setOpen(null)} />
    </>
  );
}

function ScoringView() {
  const { can } = useAuth();
  const url = useUrlState();
  const raw = url.get("tab");
  const tab = TABS.includes(raw as (typeof TABS)[number]) ? (raw as string) : "rankings";
  const [logging, setLogging] = useState(false);
  const rescoreAll = useRescoreAll();

  return (
    <>
      <PageHeader
        title="Scoring"
        description="Eligible opportunities ranked by value score within confidence band. Confidence measures certainty; it never adds value."
        actions={
          tab === "rankings" && can("scoring", "approve") ? (
            <Button
              loading={rescoreAll.isPending}
              onClick={() =>
                rescoreAll.mutate(undefined, {
                  onSuccess: (r) => toast.success(`${r.rescored} properties rescored`),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              <RefreshCw /> Rescore all
            </Button>
          ) : tab === "outcomes" && can("scoring", "edit") ? (
            <Button variant="primary" onClick={() => setLogging(true)}>
              Log outcome
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "rankings" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "rankings", label: "Rankings" },
            { value: "outcomes", label: "Outcomes" },
            { value: "configuration", label: "Weights & versions" },
          ]}
        />
        <TabPanel value="rankings">{tab === "rankings" && <Rankings />}</TabPanel>
        <TabPanel value="outcomes">{tab === "outcomes" && <OutcomesTab logging={logging} onLoggingChange={setLogging} />}</TabPanel>
        <TabPanel value="configuration">{tab === "configuration" && <ConfigsTab />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function ScoringPage() {
  return (
    <Suspense>
      <ScoringView />
    </Suspense>
  );
}
