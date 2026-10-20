"use client";

import { useQuery } from "@tanstack/react-query";
import { Archive, Building2, LineChart, MoreHorizontal, Pencil, Plus, Route, TrafficCone } from "lucide-react";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, titleCase } from "@/lib/utils";

import {
  GROWTH_KINDS,
  ROAD_CLASSES,
  TRADE_AREA_MINUTES,
  useArchiveGeo,
  type Corridor,
  type GrowthRecord,
  type Node,
  type TradeArea,
  type TrafficCount,
} from "@/features/territories/api";
import { CorridorFormSheet, GrowthFormSheet, NodeFormSheet, TradeAreaFormSheet, TrafficCountFormSheet } from "@/features/territories/geography-forms";
import { NearbyPropertiesDialog, TrafficTrendDialog, type NearbyTarget } from "@/features/territories/nearby-properties-dialog";

type Resource = "corridors" | "nodes" | "traffic-counts" | "trade-areas" | "growth-records";
type UrlState = ReturnType<typeof useUrlState>;

/* ------------------------------------------------------------------ shared bits */

function chipsFor(url: UrlState, labels: Record<string, string>, format?: (k: string, v: string) => string): FilterChip[] {
  return Object.entries(labels)
    .filter(([k]) => url.getAll(k).length)
    .map(([k, label]) => ({
      key: k,
      label,
      value: url.getAll(k).map((v) => (format ? format(k, v) : v)).join(", "),
      onRemove: () => url.set({ [k]: null }),
    }));
}

function RowMenu({ children }: { children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Row actions">
          <MoreHorizontal />
        </Button>
      </MenuTrigger>
      <MenuContent>{children}</MenuContent>
    </Menu>
  );
}

function useArchive(resource: Resource, label: string) {
  const archive = useArchiveGeo(resource);
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const dialog = (
    <ConfirmDialog
      open={!!target}
      onOpenChange={(o) => !o && setTarget(null)}
      title={`Archive ${label}?`}
      description={`${target?.name ?? ""} will be hidden from lists. History is retained.`}
      confirmLabel="Archive"
      destructive
      loading={archive.isPending}
      onConfirm={() =>
        target &&
        archive.mutate(target.id, {
          onSuccess: () => {
            toast.success(`${titleCase(label)} archived`);
            setTarget(null);
          },
          onError: (e) => toast.error(errorMessage(e)),
        })
      }
    />
  );
  return { ask: setTarget, dialog };
}

function ListShell({
  url,
  total,
  page,
  pageSize,
  toolbar,
  chips,
  children,
}: {
  url: UrlState;
  total: number;
  page: number;
  pageSize: number;
  toolbar: ReactNode;
  chips: FilterChip[];
  children: ReactNode;
}) {
  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          {toolbar}
          <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), view: url.get("view"), q: url.get("q"), sort: url.get("sort") })} />
        </div>
      }
      footer={<TableFooter page={page} pageSize={pageSize} total={total} onPage={(p) => url.set({ page: p }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
    >
      {children}
    </ListCard>
  );
}

/* ------------------------------------------------------------------ corridors */

function CorridorsTab({ onNearby, onTraffic }: { onNearby: (t: NearbyTarget) => void; onTraffic: (corridorId: string) => void }) {
  const { can } = useAuth();
  const list = useListQuery<Corridor>("corridors", "/corridors");
  const { url } = list;
  const [sheet, setSheet] = useState<{ open: boolean; item: Corridor | null }>({ open: false, item: null });
  const archive = useArchive("corridors", "corridor");
  const { tab: _t, view: _v, page: _p, page_size: _s, sort: _o, ...filterParams } = url.params;
  const { data: facets } = useQuery({
    queryKey: ["corridors", "facets", filterParams],
    queryFn: () => api.get<{ road_class: Record<string, number> }>("/corridors/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const columns: Column<Corridor>[] = [
    {
      id: "name",
      header: "Corridor",
      sortKey: "name",
      cell: (c) => (
        <div className="min-w-[200px]">
          <p className="truncate font-medium">{c.name}</p>
          <p className="truncate text-xs text-ink-3">{[c.road_name, c.city, c.county].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    { id: "class", header: "Class", sortKey: "road_class", hideable: true, cell: (c) => <Badge tone="outline">{titleCase(c.road_class)}</Badge> },
    { id: "side", header: "Side / direction", hideable: true, cell: (c) => <span className="text-ink-2">{[c.side_of_road, c.travel_direction].filter(Boolean).map(titleCase).join(" · ") || "—"}</span> },
    { id: "frontage", header: "Frontage (ft)", sortKey: "frontage_length_ft", align: "right", hideable: true, cell: (c) => formatNumber(c.frontage_length_ft) },
    { id: "nodes", header: "Nodes", align: "right", hideable: true, cell: (c) => formatNumber(c.node_count) },
    {
      id: "traffic",
      header: "Latest count",
      align: "right",
      hideable: true,
      cell: (c) => (c.latest_count != null ? <span>{formatNumber(c.latest_count)} <span className="text-xs text-ink-3">({c.latest_count_year})</span></span> : "—"),
    },
    { id: "geometry", header: "Line", hideable: true, cell: (c) => (c.has_geometry ? <Badge tone="green" dot>{formatNumber(c.length_ft)} ft</Badge> : <Badge tone="amber" dot>Missing</Badge>) },
    { id: "source", header: "Source", hideable: true, defaultHidden: true, cell: (c) => <span className="text-xs text-ink-2">{c.source ?? "—"}{c.observed_on ? ` · ${formatDate(c.observed_on)}` : ""}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) => (
        <RowMenu>
          {can("territories", "edit") && <MenuItem icon={<Pencil />} onSelect={() => setSheet({ open: true, item: c })}>Edit</MenuItem>}
          {c.has_geometry && <MenuItem icon={<Building2 />} onSelect={() => onNearby({ kind: "corridor", id: c.id, name: c.name })}>Properties along corridor</MenuItem>}
          <MenuItem icon={<TrafficCone />} onSelect={() => onTraffic(c.id)}>Traffic counts</MenuItem>
          {can("territories", "delete") && <MenuItem icon={<Archive />} destructive onSelect={() => archive.ask({ id: c.id, name: c.name })}>Archive</MenuItem>}
        </RowMenu>
      ),
    },
  ];
  const cols = useColumnVisibility("geo-corridors", columns);
  const more: MoreFilterField[] = [
    { type: "text", label: "County", key: "county" },
    { type: "text", label: "City", key: "city" },
    { type: "select", label: "Line geometry", key: "has_geometry", options: [{ value: "true", label: "Has line" }, { value: "false", label: "Missing line" }] },
  ];
  const chips = chipsFor(url, { road_class: "Class", county: "County", city: "City", has_geometry: "Line" }, (k, v) => (k === "has_geometry" ? (v === "true" ? "Present" : "Missing") : titleCase(v)));

  return (
    <>
      <ListShell
        url={url}
        total={list.data?.total ?? 0}
        page={list.page}
        pageSize={list.pageSize}
        chips={chips}
        toolbar={
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="territories" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {can("territories", "create") && (
                  <Button variant="primary" onClick={() => setSheet({ open: true, item: null })}>
                    <Plus /> New corridor
                  </Button>
                )}
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search corridors…" />
            <FacetFilter
              label="Class"
              options={ROAD_CLASSES.map((r) => ({ value: r, label: titleCase(r), count: facets?.road_class[r] ?? 0 }))}
              selected={url.getAll("road_class")}
              onChange={(v) => url.set({ road_class: v })}
            />
            <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
          </Toolbar>
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          hidden={cols.hidden}
          onRowClick={(c) => can("territories", "edit") && setSheet({ open: true, item: c })}
          empty={<EmptyState icon={<Route />} title="No corridors" description="Record named highways and arterials with side of road, travel direction and frontage." />}
        />
      </ListShell>
      <CorridorFormSheet open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))} corridor={sheet.item} />
      {archive.dialog}
    </>
  );
}

/* ------------------------------------------------------------------ nodes */

function NodesTab({ onNearby, onTraffic }: { onNearby: (t: NearbyTarget) => void; onTraffic: (nodeId: string) => void }) {
  const { can } = useAuth();
  const list = useListQuery<Node>("nodes", "/nodes");
  const { url } = list;
  const [sheet, setSheet] = useState<{ open: boolean; item: Node | null }>({ open: false, item: null });
  const archive = useArchive("nodes", "node");

  const columns: Column<Node>[] = [
    {
      id: "name",
      header: "Intersection",
      sortKey: "name",
      cell: (n) => (
        <div className="min-w-[200px]">
          <p className="truncate font-medium">{n.name}</p>
          <p className="truncate text-xs text-ink-3">{[n.corridor_name, n.city, n.county].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    {
      id: "signal",
      header: "Signal",
      hideable: true,
      cell: (n) => (n.signalized == null ? <span className="text-ink-3">—</span> : n.signalized ? <Badge tone="green">Signalized</Badge> : <Badge tone="outline">Unsignalized</Badge>),
    },
    {
      id: "approach",
      header: "Approach traffic",
      align: "right",
      hideable: true,
      cell: (n) => {
        const values = Object.values(n.approach_traffic ?? {}).map(Number).filter((v) => Number.isFinite(v));
        return values.length ? `${formatNumber(values.reduce((a, b) => a + b, 0))} VPD` : "—";
      },
    },
    {
      id: "quadrants",
      header: "Quadrants",
      hideable: true,
      cell: (n) => {
        const filled = Object.entries(n.quadrants ?? {}).filter(([, q]) => q && (q.tenancy || q.vacancy));
        return filled.length ? (
          <span className="flex gap-1">
            {filled.map(([k, q]) => (
              <Badge key={k} tone={q?.vacancy ? "amber" : "outline"}>
                {k}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        );
      },
    },
    { id: "turns", header: "Turn restrictions", hideable: true, defaultHidden: true, cell: (n) => <span className="block max-w-[220px] truncate text-xs text-ink-2">{n.turn_restrictions ?? "—"}</span> },
    { id: "coords", header: "Coordinates", hideable: true, defaultHidden: true, cell: (n) => <span className="text-xs tabular text-ink-2">{n.latitude != null && n.longitude != null ? `${n.latitude.toFixed(5)}, ${n.longitude.toFixed(5)}` : "—"}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (n) => (
        <RowMenu>
          {can("territories", "edit") && <MenuItem icon={<Pencil />} onSelect={() => setSheet({ open: true, item: n })}>Edit</MenuItem>}
          {n.latitude != null && <MenuItem icon={<Building2 />} onSelect={() => onNearby({ kind: "node", id: n.id, name: n.name })}>Nearby properties</MenuItem>}
          <MenuItem icon={<TrafficCone />} onSelect={() => onTraffic(n.id)}>Traffic counts</MenuItem>
          {can("territories", "delete") && <MenuItem icon={<Archive />} destructive onSelect={() => archive.ask({ id: n.id, name: n.name })}>Archive</MenuItem>}
        </RowMenu>
      ),
    },
  ];
  const cols = useColumnVisibility("geo-nodes", columns);
  const more: MoreFilterField[] = [
    { type: "text", label: "County", key: "county" },
    { type: "text", label: "City", key: "city" },
    { type: "select", label: "Signalized", key: "signalized", options: [{ value: "true", label: "Signalized" }, { value: "false", label: "Unsignalized" }] },
  ];
  const chips = chipsFor(url, { corridor_id: "Corridor", county: "County", city: "City", signalized: "Signalized" }, (k, v) =>
    k === "signalized" ? (v === "true" ? "Yes" : "No") : k === "corridor_id" ? "Selected corridor" : v,
  );

  return (
    <>
      <ListShell
        url={url}
        total={list.data?.total ?? 0}
        page={list.page}
        pageSize={list.pageSize}
        chips={chips}
        toolbar={
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="territories" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {can("territories", "create") && (
                  <Button variant="primary" onClick={() => setSheet({ open: true, item: null })}>
                    <Plus /> New node
                  </Button>
                )}
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search intersections…" />
            <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
          </Toolbar>
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          hidden={cols.hidden}
          onRowClick={(n) => can("territories", "edit") && setSheet({ open: true, item: n })}
          empty={<EmptyState title="No nodes" description="Record major intersections with approach traffic, signalization and quadrant tenancy." />}
        />
      </ListShell>
      <NodeFormSheet open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))} node={sheet.item} />
      {archive.dialog}
    </>
  );
}

/* ------------------------------------------------------------------ traffic counts */

function TrafficTab() {
  const { can } = useAuth();
  const list = useListQuery<TrafficCount>("traffic-counts", "/traffic-counts");
  const { url } = list;
  const [sheet, setSheet] = useState<{ open: boolean; item: TrafficCount | null }>({ open: false, item: null });
  const [trend, setTrend] = useState<TrafficCount | null>(null);
  const archive = useArchive("traffic-counts", "traffic count");

  const columns: Column<TrafficCount>[] = [
    {
      id: "segment",
      header: "Segment / approach",
      sortKey: "segment",
      cell: (t) => (
        <div className="min-w-[200px]">
          <p className="truncate font-medium">{[t.segment, t.approach].filter(Boolean).join(" · ") || "Unnamed segment"}</p>
          <p className="truncate text-xs text-ink-3">{[t.corridor_name, t.node_name].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    { id: "count", header: "Count (VPD)", sortKey: "count", align: "right", cell: (t) => formatNumber(t.count) },
    { id: "year", header: "Year", sortKey: "count_year", align: "right", cell: (t) => t.count_year },
    {
      id: "change",
      header: "vs prior",
      align: "right",
      hideable: true,
      cell: (t) =>
        t.change_pct == null ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className={cn("text-xs", t.change_pct >= 0 ? "text-positive" : "text-negative")}>
            {t.change_pct >= 0 ? "+" : ""}
            {formatNumber(t.change_pct, 1)}%
          </span>
        ),
    },
    { id: "type", header: "Type", hideable: true, cell: (t) => <span className="text-ink-2">{t.count_type === "aadt" || t.count_type === "adt" ? t.count_type.toUpperCase() : titleCase(t.count_type)}</span> },
    { id: "source", header: "Source", sortKey: "source", hideable: true, cell: (t) => <span className="text-xs text-ink-2">{t.source}</span> },
    { id: "observed", header: "Observed", sortKey: "observed_on", hideable: true, cell: (t) => <span className="text-xs text-ink-3">{formatDate(t.observed_on)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (t) => (
        <RowMenu>
          <MenuItem icon={<LineChart />} onSelect={() => setTrend(t)}>History by year</MenuItem>
          {can("territories", "edit") && <MenuItem icon={<Pencil />} onSelect={() => setSheet({ open: true, item: t })}>Edit</MenuItem>}
          {can("territories", "delete") && <MenuItem icon={<Archive />} destructive onSelect={() => archive.ask({ id: t.id, name: `${formatNumber(t.count)} (${t.count_year})` })}>Archive</MenuItem>}
        </RowMenu>
      ),
    },
  ];
  const cols = useColumnVisibility("geo-traffic", columns);
  const more: MoreFilterField[] = [
    { type: "range", label: "Count year", minKey: "min_year", maxKey: "max_year" },
    { type: "range", label: "Vehicles per day", minKey: "min_count", maxKey: "max_count" },
    { type: "text", label: "Source", key: "source" },
  ];
  const chips = chipsFor(
    url,
    { corridor_id: "Corridor", node_id: "Node", min_year: "From", max_year: "To", min_count: "Min VPD", max_count: "Max VPD", source: "Source" },
    (k, v) => (k === "corridor_id" || k === "node_id" ? "Selected" : v),
  );

  return (
    <>
      <ListShell
        url={url}
        total={list.data?.total ?? 0}
        page={list.page}
        pageSize={list.pageSize}
        chips={chips}
        toolbar={
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="territories" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {can("territories", "create") && (
                  <Button variant="primary" onClick={() => setSheet({ open: true, item: null })}>
                    <Plus /> New count
                  </Button>
                )}
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search segment, approach, source…" />
            <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
          </Toolbar>
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          hidden={cols.hidden}
          onRowClick={(t) => setTrend(t)}
          empty={<EmptyState icon={<TrafficCone />} title="No traffic counts" description="Each count keeps its year, source and date so the trend is preserved." />}
        />
      </ListShell>
      <TrafficCountFormSheet open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))} count={sheet.item} />
      <TrafficTrendDialog row={trend} onClose={() => setTrend(null)} />
      {archive.dialog}
    </>
  );
}

/* ------------------------------------------------------------------ trade areas */

function TradeAreasList() {
  const { can } = useAuth();
  const list = useListQuery<TradeArea>("trade-areas", "/trade-areas");
  const { url } = list;
  const [sheet, setSheet] = useState<{ open: boolean; item: TradeArea | null }>({ open: false, item: null });
  const archive = useArchive("trade-areas", "trade area");

  const demo = (t: TradeArea, k: string) => {
    const v = t.demographics?.[k];
    return typeof v === "number" ? v : null;
  };
  const columns: Column<TradeArea>[] = [
    {
      id: "center",
      header: "Trade area",
      cell: (t) => (
        <div className="min-w-[200px]">
          <p className="truncate font-medium">{t.name || t.node_name || t.property_label || "Trade area"}</p>
          <p className="truncate text-xs text-ink-3">{t.node_name ? `Node · ${t.node_name}` : t.property_label ? `Property · ${t.property_label}` : "—"}</p>
        </div>
      ),
    },
    { id: "minutes", header: "Drive time", sortKey: "minutes", align: "right", cell: (t) => `${t.minutes} min` },
    { id: "population", header: "Population", align: "right", hideable: true, cell: (t) => formatNumber(demo(t, "population")) },
    { id: "income", header: "Median HH income", align: "right", hideable: true, cell: (t) => formatCurrency(demo(t, "median_household_income")) },
    { id: "competitors", header: "Competitors", align: "right", hideable: true, cell: (t) => formatNumber(t.competitors.length) },
    { id: "anchors", header: "Anchors", align: "right", hideable: true, cell: (t) => formatNumber(t.anchors.length) },
    { id: "polygon", header: "Polygon", hideable: true, cell: (t) => (t.has_geometry ? <Badge tone="green" dot>Yes</Badge> : <Badge tone="amber" dot>Missing</Badge>) },
    { id: "source", header: "Source", sortKey: "observed_on", hideable: true, cell: (t) => <span className="text-xs text-ink-2">{t.source}{t.observed_on ? ` · ${formatDate(t.observed_on)}` : ""}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (t) =>
        can("territories", "edit") || can("territories", "delete") ? (
          <RowMenu>
            {can("territories", "edit") && <MenuItem icon={<Pencil />} onSelect={() => setSheet({ open: true, item: t })}>Edit</MenuItem>}
            {can("territories", "delete") && <MenuItem icon={<Archive />} destructive onSelect={() => archive.ask({ id: t.id, name: t.name ?? `${t.minutes}-minute trade area` })}>Archive</MenuItem>}
          </RowMenu>
        ) : null,
    },
  ];
  const cols = useColumnVisibility("geo-trade", columns);
  const chips = chipsFor(url, { minutes: "Drive time", node_id: "Node", property_id: "Property" }, (k, v) => (k === "minutes" ? `${v} min` : "Selected"));

  return (
    <>
      <ListShell
        url={url}
        total={list.data?.total ?? 0}
        page={list.page}
        pageSize={list.pageSize}
        chips={chips}
        toolbar={
          <Toolbar
            right={
              <>
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {can("territories", "create") && (
                  <Button variant="primary" onClick={() => setSheet({ open: true, item: null })}>
                    <Plus /> New trade area
                  </Button>
                )}
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search name, node, property, source…" />
            <FacetFilter
              label="Drive time"
              options={TRADE_AREA_MINUTES.map((m) => ({ value: String(m), label: `${m} min` }))}
              selected={url.getAll("minutes")}
              onChange={(v) => url.set({ minutes: v })}
            />
          </Toolbar>
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          hidden={cols.hidden}
          onRowClick={(t) => can("territories", "edit") && setSheet({ open: true, item: t })}
          empty={<EmptyState title="No trade areas" description="Store 5, 10 and 15-minute drive-time polygons with demographics, competitors and anchors." />}
        />
      </ListShell>
      <TradeAreaFormSheet open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))} tradeArea={sheet.item} />
      {archive.dialog}
    </>
  );
}

/* ------------------------------------------------------------------ growth */

function GrowthList() {
  const { can } = useAuth();
  const list = useListQuery<GrowthRecord>("growth-records", "/growth-records");
  const { url } = list;
  const [sheet, setSheet] = useState<{ open: boolean; item: GrowthRecord | null }>({ open: false, item: null });
  const archive = useArchive("growth-records", "growth record");
  const { tab: _t, view: _v, page: _p, page_size: _s, sort: _o, ...filterParams } = url.params;
  const { data: facets } = useQuery({
    queryKey: ["growth-records", "facets", filterParams],
    queryFn: () => api.get<{ kind: Record<string, number> }>("/growth-records/facets", filterParams),
    placeholderData: (prev) => prev,
  });
  const hasCenter = !!(url.get("near_lat") && url.get("near_lng"));

  const columns: Column<GrowthRecord>[] = [
    {
      id: "name",
      header: "Record",
      sortKey: "name",
      cell: (g) => (
        <div className="min-w-[220px]">
          <p className="truncate font-medium">{g.name}</p>
          <p className="truncate text-xs text-ink-3">{[g.status, g.city, g.county].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    { id: "kind", header: "Kind", sortKey: "kind", cell: (g) => <Badge tone="outline">{titleCase(g.kind)}</Badge> },
    { id: "date", header: "Date", sortKey: "event_date", hideable: true, cell: (g) => <span className="text-xs text-ink-2">{formatDate(g.event_date)}</span> },
    { id: "units", header: "Units", sortKey: "units", align: "right", hideable: true, cell: (g) => formatNumber(g.units) },
    { id: "value", header: "Value", sortKey: "value", align: "right", hideable: true, cell: (g) => formatCurrency(g.value, { compact: true }) },
    ...(hasCenter
      ? [{ id: "distance", header: "Distance", sortKey: "distance_miles", align: "right" as const, cell: (g: GrowthRecord) => (g.distance_miles != null ? `${formatNumber(g.distance_miles, 2)} mi` : "—") }]
      : []),
    { id: "source", header: "Source", sortKey: "observed_on", hideable: true, cell: (g) => <span className="text-xs text-ink-2">{g.source}{g.observed_on ? ` · ${formatDate(g.observed_on)}` : ""}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (g) =>
        can("territories", "edit") || can("territories", "delete") ? (
          <RowMenu>
            {can("territories", "edit") && <MenuItem icon={<Pencil />} onSelect={() => setSheet({ open: true, item: g })}>Edit</MenuItem>}
            {can("territories", "delete") && <MenuItem icon={<Archive />} destructive onSelect={() => archive.ask({ id: g.id, name: g.name })}>Archive</MenuItem>}
          </RowMenu>
        ) : null,
    },
  ];
  const cols = useColumnVisibility("geo-growth", columns);
  const more: MoreFilterField[] = [
    { type: "number", label: "Center latitude", key: "near_lat" },
    { type: "number", label: "Center longitude", key: "near_lng" },
    { type: "number", label: "Radius", key: "radius_miles", suffix: "miles" },
    { type: "date-range", label: "Event date", minKey: "from_date", maxKey: "to_date" },
    { type: "text", label: "County", key: "county" },
    { type: "text", label: "City", key: "city" },
  ];
  const chips = chipsFor(
    url,
    { kind: "Kind", near_lat: "Lat", near_lng: "Lng", radius_miles: "Radius (mi)", property_id: "Near property", node_id: "Near node", from_date: "From", to_date: "To", county: "County", city: "City" },
    (k, v) => (k === "kind" ? titleCase(v) : k === "property_id" || k === "node_id" ? "Selected" : v),
  );

  return (
    <>
      <ListShell
        url={url}
        total={list.data?.total ?? 0}
        page={list.page}
        pageSize={list.pageSize}
        chips={chips}
        toolbar={
          <Toolbar
            right={
              <>
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                {can("territories", "create") && (
                  <Button variant="primary" onClick={() => setSheet({ open: true, item: null })}>
                    <Plus /> New record
                  </Button>
                )}
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search growth records…" />
            <FacetFilter
              label="Kind"
              options={GROWTH_KINDS.map((k) => ({ value: k, label: titleCase(k), count: facets?.kind[k] ?? 0 }))}
              selected={url.getAll("kind")}
              onChange={(v) => url.set({ kind: v })}
            />
            <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
          </Toolbar>
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          hidden={cols.hidden}
          onRowClick={(g) => can("territories", "edit") && setSheet({ open: true, item: g })}
          empty={<EmptyState title="No growth records" description="Permits, plats, rooftops, schools, utilities and announced projects — each with a source and date." />}
        />
      </ListShell>
      <GrowthFormSheet open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))} record={sheet.item} />
      {archive.dialog}
    </>
  );
}

function ContextTab() {
  const url = useUrlState();
  const view = url.get("view") === "growth" ? "growth" : "trade";
  return (
    <div className="space-y-3">
      <div className="inline-flex gap-1 rounded-md border border-line bg-subtle p-0.5 text-sm">
        {(
          [
            ["trade", "Trade areas"],
            ["growth", "Growth context"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => url.replaceAll({ tab: "context", view: v === "trade" ? null : v })}
            className={cn("h-7 rounded px-3 font-medium", view === v ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink")}
          >
            {label}
          </button>
        ))}
      </div>
      {view === "trade" ? <TradeAreasList /> : <GrowthList />}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

function GeographyView() {
  const url = useUrlState();
  const tab = url.get("tab") ?? "corridors";
  const [nearby, setNearby] = useState<NearbyTarget>(null);
  const tabs = useMemo(
    () => [
      { value: "corridors", label: "Corridors" },
      { value: "nodes", label: "Nodes" },
      { value: "traffic", label: "Traffic counts" },
      { value: "context", label: "Trade areas & growth" },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Corridors & nodes"
        description="Geography as structured data: corridors, intersections, traffic history, trade areas and growth context."
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "corridors" ? null : v })}>
        <TabList className="mb-4" tabs={tabs} />
        <TabPanel value="corridors">
          <CorridorsTab onNearby={setNearby} onTraffic={(id) => url.replaceAll({ tab: "traffic", corridor_id: id })} />
        </TabPanel>
        <TabPanel value="nodes">
          <NodesTab onNearby={setNearby} onTraffic={(id) => url.replaceAll({ tab: "traffic", node_id: id })} />
        </TabPanel>
        <TabPanel value="traffic">
          <TrafficTab />
        </TabPanel>
        <TabPanel value="context">
          <ContextTab />
        </TabPanel>
      </Tabs>
      <NearbyPropertiesDialog target={nearby} onClose={() => setNearby(null)} />
    </>
  );
}

export default function GeographyPage() {
  return (
    <Suspense>
      <GeographyView />
    </Suspense>
  );
}
