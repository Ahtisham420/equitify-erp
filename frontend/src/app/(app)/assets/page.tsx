"use client";

import { ArrowUpRight, Briefcase, Plus, Radar, Settings2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader, StatCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Avatar, Skeleton, Tooltip } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import {
  ASSET_STATUSES,
  DIMENSIONS,
  GROUP_BY_LABELS,
  TRIGGER_LABELS,
  useAssetFacets,
  useCheckConcentration,
  useConcentration,
  useConcentrationLimits,
  usePortfolio,
  usePortfolioCashFlow,
  useScanWatchlist,
  useVariances,
  useWatchlist,
  type AssetListItem,
  type CashFlowRow,
  type ConcentrationLimit,
  type Dimension,
  type WatchEntry,
} from "@/features/assets/api";
import {
  AssetFormSheet,
  AssetSettingsSheet,
  AssetStatusBadge,
  LimitSheet,
  ResolveWatchDialog,
  STATUS_LABELS,
  VarianceStatusBadge,
  coverageTone,
  formatMetric,
} from "@/features/assets/asset-forms";
import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

const PORTFOLIO_KPIS: { key: string; label: string }[] = [
  { key: "value", label: "Value" },
  { key: "noi", label: "NOI (TTM)" },
  { key: "occupancy", label: "Occupancy" },
  { key: "wale", label: "WALE" },
  { key: "yield_on_cost", label: "Yield on cost" },
  { key: "leverage", label: "Leverage" },
  { key: "coverage", label: "Coverage" },
];

const MORE: MoreFilterField[] = [
  { type: "select", label: "Watchlist", key: "watchlist", options: [{ value: "true", label: "On watchlist" }, { value: "false", label: "Not on watchlist" }] },
];

const typeLabel = (t: string | null) => (t ? PROPERTY_TYPE_LABELS[t] ?? titleCase(t) : "—");

const columns: Column<AssetListItem>[] = [
  {
    id: "property",
    header: "Property",
    sortKey: "property",
    cell: (a) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{a.property_label}</p>
        <p className="truncate text-xs text-ink-3">{[a.city, a.state].filter(Boolean).join(", ") || "—"}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", sortKey: "property_type", hideable: true, cell: (a) => <span className="whitespace-nowrap text-ink-2">{typeLabel(a.property_type)}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (a) => <AssetStatusBadge status={a.status} /> },
  { id: "acquired", header: "Acquired", sortKey: "acquired_on", hideable: true, cell: (a) => <span className="whitespace-nowrap text-ink-2">{formatDate(a.acquired_on)}</span> },
  { id: "basis", header: "Basis", sortKey: "basis", align: "right", hideable: true, cell: (a) => formatCurrency(a.basis, { compact: true }) },
  { id: "value", header: "Value", sortKey: "current_value", align: "right", hideable: true, cell: (a) => formatCurrency(a.current_value, { compact: true }) },
  { id: "noi", header: "NOI TTM", align: "right", hideable: true, cell: (a) => formatCurrency(a.noi_ttm, { compact: true }) },
  { id: "occupancy", header: "Occupancy", align: "right", hideable: true, cell: (a) => formatPercent(a.occupancy, 0) },
  { id: "leverage", header: "LTV", align: "right", hideable: true, cell: (a) => formatPercent(a.leverage, 0) },
  { id: "dscr", header: "DSCR", align: "right", hideable: true, cell: (a) => <span className={cn(coverageTone(a.coverage) && `font-medium ${coverageTone(a.coverage)}`)}>{a.coverage === null ? "—" : `${formatNumber(a.coverage, 2)}x`}</span> },
  { id: "yoc", header: "Yield on cost", align: "right", hideable: true, cell: (a) => formatPercent(a.yield_on_cost, 2) },
  { id: "watch", header: "Watch", align: "right", hideable: true, cell: (a) => (a.open_watch ? <Badge tone="amber">{a.open_watch}</Badge> : <span className="text-ink-3">—</span>) },
  {
    id: "manager",
    header: "Manager",
    hideable: true,
    cell: (a) =>
      a.manager_name ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          <Avatar name={a.manager_name} size={20} />
          {a.manager_name}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (a) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(a.updated_at)}</span> },
];

/* ------------------------------------------------------------------ concentration */

function ConcentrationCard() {
  const { can } = useAuth();
  const [dim, setDim] = useState<Dimension>("tenant");
  const [limitsOpen, setLimitsOpen] = useState(false);
  const { data, isLoading } = useConcentration();
  const check = useCheckConcentration();
  const d = data?.dimensions[dim];

  const runCheck = () =>
    check.mutate(undefined, {
      onSuccess: (r) => toast.success(r.breaches.length ? `${r.breaches.length} limit breaches — alerts raised` : "All exposures are within limits"),
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <Card>
      <CardHeader
        title="Concentration"
        description={d ? `Share of ${d.measure.toLowerCase()}${d.total ? ` · ${formatCurrency(d.total, { compact: true })}` : ""}` : "Exposure by dimension"}
        actions={
          <>
            {can("assets", "approve") && (
              <Button size="xs" variant="ghost" onClick={() => setLimitsOpen(true)}>
                Limits
              </Button>
            )}
            {can("assets", "edit") && (
              <Button size="xs" loading={check.isPending} onClick={runCheck}>
                <ShieldCheck /> Check limits
              </Button>
            )}
          </>
        }
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {DIMENSIONS.map((x) => {
            const breaches = data?.breaches.filter((b) => b.dimension === x).length ?? 0;
            return (
              <button
                key={x}
                onClick={() => setDim(x)}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
                  dim === x ? "bg-ink text-white" : "text-ink-2 hover:bg-muted hover:text-ink",
                )}
              >
                {titleCase(x)}
                {breaches > 0 && <span className={cn("rounded px-1 text-2xs tabular", dim === x ? "bg-white/20" : "bg-negative-soft text-negative")}>{breaches}</span>}
              </button>
            );
          })}
        </div>
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : d?.unavailable ? (
          <p className="py-6 text-center text-sm text-ink-3">{d.unavailable}</p>
        ) : !d?.items.length ? (
          <p className="py-6 text-center text-sm text-ink-3">No exposure recorded for this dimension.</p>
        ) : (
          <ul className="max-h-80 space-y-0.5 overflow-y-auto scrollbar-thin">
            {d.items.slice(0, 25).map((i) => (
              <li key={i.key}>
                <Link href={i.drill} className="group grid grid-cols-[minmax(0,120px)_1fr_52px] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-subtle">
                  <span className={cn("truncate text-sm", i.breached ? "font-medium text-negative" : "text-ink-2 group-hover:text-ink")} title={i.label}>
                    {i.label}
                  </span>
                  <span className="relative h-2 rounded-full bg-muted">
                    <span className={cn("absolute inset-y-0 left-0 rounded-full", i.breached ? "bg-negative" : "bg-accent")} style={{ width: `${Math.min(100, i.pct)}%` }} />
                    {i.limit_pct !== null && (
                      <Tooltip content={`Limit ${formatPercent(i.limit_pct, 1)}${i.severity ? ` · ${i.severity} severity` : ""}`}>
                        <span className="absolute -top-1 h-4 w-px bg-ink" style={{ left: `${Math.min(100, i.limit_pct)}%` }} />
                      </Tooltip>
                    )}
                  </span>
                  <span className={cn("text-right text-sm tabular", i.breached ? "font-medium text-negative" : "text-ink")}>{formatPercent(i.pct, 1)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <LimitsDialog open={limitsOpen} onOpenChange={setLimitsOpen} dimension={dim} />
    </Card>
  );
}

function LimitsDialog({ open, onOpenChange, dimension }: { open: boolean; onOpenChange: (o: boolean) => void; dimension: Dimension }) {
  const { data, isLoading } = useConcentrationLimits();
  const [editing, setEditing] = useState<ConcentrationLimit | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const openSheet = (l: ConcentrationLimit | null) => {
    setEditing(l);
    setSheetOpen(true);
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Concentration limits"
        description="Maximum share of portfolio exposure per dimension or item."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
            <Button variant="primary" onClick={() => openSheet(null)}>
              <Plus /> New limit
            </Button>
          </>
        }
      >
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !data?.length ? (
          <p className="py-6 text-center text-sm text-ink-3">No limits defined.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.map((l) => (
              <li key={l.id}>
                <button onClick={() => openSheet(l)} className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-subtle">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {titleCase(l.dimension)} · {l.key ?? "Any item"}
                    </span>
                    {l.notes && <span className="block truncate text-xs text-ink-3">{l.notes}</span>}
                  </span>
                  <StatusBadge status={l.severity} />
                  {!l.is_active && <Badge tone="outline">Inactive</Badge>}
                  <span className="w-14 text-right text-sm font-medium tabular">{formatPercent(l.max_pct, 1)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <LimitSheet open={sheetOpen} onOpenChange={setSheetOpen} limit={editing} defaultDimension={dimension} />
    </>
  );
}

/* ------------------------------------------------------------------ watchlist / variances / cash flow */

function WatchlistPanel() {
  const { can } = useAuth();
  const { data, isLoading } = useWatchlist({ status: ["open"] });
  const [resolving, setResolving] = useState<WatchEntry | null>(null);
  return (
    <Card>
      <CardHeader title="Watchlist" description={data ? `${data.length} open ${data.length === 1 ? "entry" : "entries"}` : "Open entries"} />
      <CardBody className="p-0">
        {isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : !data?.length ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">No assets on the watchlist. Run a scan to evaluate triggers.</p>
        ) : (
          <ul className="max-h-[420px] divide-y divide-line overflow-y-auto scrollbar-thin">
            {data.map((e) => (
              <li key={e.id} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <StatusBadge status={e.severity} />
                  <span className="text-sm font-medium text-ink">{TRIGGER_LABELS[e.trigger] ?? titleCase(e.trigger)}</span>
                  <span className="ml-auto whitespace-nowrap text-xs text-ink-3">{formatRelative(e.first_detected_at)}</span>
                </div>
                <Link href={`/assets/${e.asset_id}`} className="mt-0.5 block truncate text-sm text-ink-2 hover:text-ink hover:underline">
                  {e.asset_label ?? "Asset"}
                </Link>
                {e.detail && <p className="mt-0.5 text-xs text-ink-3">{e.detail}</p>}
                <div className="mt-1 flex items-center gap-3">
                  {e.source_href && (
                    <Link href={e.source_href} className="inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline">
                      Source <ArrowUpRight className="size-3" />
                    </Link>
                  )}
                  {can("assets", "edit") && (
                    <button onClick={() => setResolving(e)} className="text-xs font-medium text-ink-2 hover:text-ink">
                      Resolve
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <ResolveWatchDialog open={!!resolving} onOpenChange={(o) => !o && setResolving(null)} entry={resolving} />
    </Card>
  );
}

function UnexplainedVariances() {
  const { data, isLoading } = useVariances({ unexplained: true, limit: 50 });
  return (
    <Card>
      <CardHeader title="Unexplained variances" description="Flagged lines awaiting an explanation" />
      <CardBody className="p-0">
        {isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : !data?.length ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">Every flagged variance has an explanation.</p>
        ) : (
          <ul className="max-h-[360px] divide-y divide-line overflow-y-auto scrollbar-thin">
            {data.map((v) => (
              <li key={v.id}>
                <Link href={`/assets/${v.asset_id}?tab=financials`} className="block px-4 py-2 hover:bg-subtle">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{v.account}</span>
                    <span className={cn("text-sm tabular", (v.variance ?? 0) < 0 ? "text-negative" : "text-ink")}>{formatCurrency(v.variance)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
                    <span className="min-w-0 flex-1 truncate">
                      {v.asset_label ?? "Asset"} · {formatDate(v.period, "MMM yyyy")} · {v.window === "ttm" ? "TTM" : "Month"} vs {v.basis}
                    </span>
                    <VarianceStatusBadge status={v.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function CashFlowCard({ params }: { params: Record<string, string | string[]> }) {
  const { data, isLoading } = usePortfolioCashFlow(12, params);
  const rows = data?.rows ?? [];
  return (
    <Card>
      <CardHeader
        title="Portfolio cash flow"
        description={data ? `Net cash flow, last 12 months · ${formatCurrency(data.totals.net_cash_flow, { compact: true })} total` : "Net cash flow, last 12 months"}
        actions={data?.drill[0] && <Link href={data.drill[0].href} className="text-xs font-medium text-accent hover:underline">{data.drill[0].label}</Link>}
      />
      <CardBody>
        {isLoading ? (
          <Skeleton className="h-44 w-full" />
        ) : !rows.some((r) => r.net_cash_flow !== 0) ? (
          <p className="py-10 text-center text-sm text-ink-3">No financials recorded for this period.</p>
        ) : (
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={4}>
                <XAxis dataKey="period" tickFormatter={(p: string) => formatDate(p, "MMM")} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} />
                <YAxis width={52} tickFormatter={(v: number) => formatCurrency(v, { compact: true })} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} />
                <ChartTooltip
                  cursor={{ fill: "rgb(var(--muted))" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const r = payload[0].payload as CashFlowRow;
                    return (
                      <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                        <p className="text-ink-3">{formatDate(r.period, "MMM yyyy")}</p>
                        <p className="font-medium text-ink tabular">Net {formatCurrency(r.net_cash_flow)}</p>
                        <p className="text-ink-3 tabular">
                          NOI {formatCurrency(r.noi)} · debt service {formatCurrency(r.debt_service)}
                          {r.debt_service_estimated ? " (est.)" : ""}
                        </p>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="net_cash_flow" radius={[3, 3, 0, 0]} maxBarSize={28}>
                  {rows.map((r) => (
                    <Cell key={r.period} fill={r.net_cash_flow < 0 ? "rgb(var(--negative))" : "rgb(var(--accent))"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {data?.note && <p className="mt-2 text-xs text-ink-3">{data.note}</p>}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

function AssetsView() {
  const { can } = useAuth();
  const list = useListQuery<AssetListItem>("assets", "/assets");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const cols = useColumnVisibility("assets", columns);
  const scan = useScanWatchlist();
  const groupBy = url.get("group_by") ?? "property_type";

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, group_by: _g, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useAssetFacets(filterParams);
  const { data: portfolio, isLoading: loadingPortfolio } = usePortfolio(groupBy, filterParams);

  const chips: FilterChip[] = [];
  for (const [key, label] of [["status", "Status"], ["property_type", "Type"], ["state", "State"]] as const) {
    const values = url.getAll(key);
    if (values.length)
      chips.push({
        key,
        label,
        value: values.map((v) => (key === "property_type" ? typeLabel(v) : key === "status" ? STATUS_LABELS[v] ?? titleCase(v) : v)).join(", "),
        onRemove: () => url.set({ [key]: null }),
      });
  }
  if (url.get("watchlist")) chips.push({ key: "watchlist", label: "Watchlist", value: url.get("watchlist") === "true" ? "On watchlist" : "Not on watchlist", onRemove: () => url.set({ watchlist: null }) });
  const ids = url.getAll("ids");
  if (ids.length) chips.push({ key: "ids", label: "Selection", value: `${ids.length} assets`, onRemove: () => url.set({ ids: null }) });
  if (url.get("manager_id")) chips.push({ key: "manager_id", label: "Manager", value: "Selected", onRemove: () => url.set({ manager_id: null }) });

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (r) =>
        toast.success(`Scanned ${r.assets} assets: ${r.opened} opened, ${r.refreshed} refreshed, ${r.cleared} cleared`, {
          description: r.concentration_breaches ? `${r.concentration_breaches} concentration limit breaches` : undefined,
        }),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const metrics = portfolio?.metrics ?? {};
  const facetOptions = (counts: Record<string, number> | undefined, label: (v: string) => string, values?: readonly string[]) =>
    (values ?? Object.keys(counts ?? {})).map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

  return (
    <>
      <PageHeader
        title="Assets"
        description="Owned properties measured against budget and acquisition underwriting."
        actions={
          <>
            {can("assets", "edit") && (
              <Button loading={scan.isPending} onClick={runScan}>
                <Radar /> Run watchlist scan
              </Button>
            )}
            {can("assets", "approve") && (
              <Button size="icon" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
                <Settings2 />
              </Button>
            )}
            {can("assets", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New asset
              </Button>
            )}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-3">Group by</span>
        <div className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-0.5 shadow-card">
          {Object.entries(GROUP_BY_LABELS).map(([k, label]) => (
            <button
              key={k}
              onClick={() => url.set({ group_by: k === "property_type" ? null : k }, { resetPage: false })}
              className={cn("h-6 rounded px-2 text-xs font-medium transition-colors", groupBy === k ? "bg-ink text-white" : "text-ink-2 hover:bg-muted hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        {portfolio && <span className="text-xs text-ink-3">{formatNumber(portfolio.totals.asset_count)} active and held-for-sale assets{chips.length ? " matching filters" : ""}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {loadingPortfolio && !portfolio
          ? PORTFOLIO_KPIS.map((k) => <Skeleton key={k.key} className="h-[92px] rounded-lg" />)
          : PORTFOLIO_KPIS.map(({ key, label }) => {
              const m = metrics[key];
              const v = m?.value ?? null;
              return (
                <StatCard
                  key={key}
                  label={label}
                  value={formatMetric(key, v)}
                  href={m?.drill[0]?.href}
                  hint={m ? `Source: ${m.source ?? m.drill[0]?.label ?? "asset records"}` : undefined}
                  tone={key === "coverage" && v !== null ? (v < 1 ? "negative" : v < 1.25 ? "caution" : "default") : "default"}
                />
              );
            })}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={`By ${(GROUP_BY_LABELS[groupBy] ?? titleCase(groupBy)).toLowerCase()}`}
            description={portfolio ? `Share of ${portfolio.measure_label.toLowerCase()}` : undefined}
          />
          {portfolio?.unavailable ? (
            <p className="px-4 py-8 text-center text-sm text-ink-3">{portfolio.unavailable}</p>
          ) : !portfolio ? (
            <div className="p-4">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : !portfolio.groups.length ? (
            <p className="px-4 py-8 text-center text-sm text-ink-3">No assets to group.</p>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-sm">
                <thead className="bg-subtle text-xs text-ink-3">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Group</th>
                    <th className="w-40 px-3 py-2 text-left font-medium">Share</th>
                    <th className="px-3 py-2 text-right font-medium">{portfolio.measure_label}</th>
                    <th className="px-3 py-2 text-right font-medium">Assets</th>
                    <th className="px-3 py-2 text-right font-medium">Value</th>
                    <th className="px-3 py-2 text-right font-medium">NOI</th>
                    <th className="px-3 py-2 text-right font-medium">Occ.</th>
                    <th className="px-3 py-2 text-right font-medium">LTV</th>
                    <th className="px-3 py-2 text-right font-medium">DSCR</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.groups.map((g) => (
                    <tr key={g.key} className="border-t border-line hover:bg-subtle/60">
                      <td className="max-w-[220px] px-3 py-2">
                        <Link href={g.drill} className="block truncate font-medium text-ink hover:underline">
                          {groupBy === "property_type" ? typeLabel(g.label) : g.label}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, g.share_pct ?? 0)}%` }} />
                          </span>
                          <span className="w-11 text-right text-xs text-ink-2 tabular">{formatPercent(g.share_pct, 1)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular">{formatCurrency(g.measure, { compact: true })}</td>
                      <td className="px-3 py-2 text-right tabular">{formatNumber(g.asset_count)}</td>
                      <td className="px-3 py-2 text-right tabular">{formatCurrency(g.value, { compact: true })}</td>
                      <td className="px-3 py-2 text-right tabular">{formatCurrency(g.noi_ttm, { compact: true })}</td>
                      <td className="px-3 py-2 text-right tabular">{formatPercent(g.occupancy, 0)}</td>
                      <td className="px-3 py-2 text-right tabular">{formatPercent(g.leverage, 0)}</td>
                      <td className={cn("px-3 py-2 text-right tabular", coverageTone(g.coverage))}>{g.coverage === null ? "—" : `${formatNumber(g.coverage, 2)}x`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <WatchlistPanel />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <ConcentrationCard />
        <CashFlowCard params={filterParams} />
        <UnexplainedVariances />
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-ink">All assets</h2>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="assets" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property, address, city…" />
              <FacetFilter label="Status" options={facetOptions(facets?.status, (v) => STATUS_LABELS[v] ?? titleCase(v), ASSET_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Type" options={facetOptions(facets?.property_type, typeLabel)} selected={url.getAll("property_type")} onChange={(v) => url.set({ property_type: v })} />
              <FacetFilter label="State" searchable options={facetOptions(facets?.state, (v) => v).sort((a, b) => a.label.localeCompare(b.label))} selected={url.getAll("state")} onChange={(v) => url.set({ state: v })} />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort"), group_by: url.get("group_by") })} />
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
          rowHref={(a) => `/assets/${a.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Briefcase />}
              title={chips.length || url.get("q") ? "No assets match these filters" : "No assets yet"}
              description={chips.length || url.get("q") ? "Try removing a filter or broadening your search." : "Asset records are created when a closing completes, or manually for properties already owned."}
              action={
                can("assets", "create") && !chips.length ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New asset
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <AssetFormSheet open={creating} onOpenChange={setCreating} />
      <AssetSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default function AssetsPage() {
  return (
    <Suspense>
      <AssetsView />
    </Suspense>
  );
}
