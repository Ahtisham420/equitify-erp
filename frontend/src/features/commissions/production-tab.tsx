"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { UserPicker } from "@/components/data/entity-picker";
import { FacetFilter, FilterChips, MoreFilters, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, StatCard } from "@/components/data/page";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatNumber, titleCase } from "@/lib/utils";

import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS } from "@/features/properties/api";

import { PRODUCTION_GROUPS, type Production, type ProductionRow } from "./api";

const CHIP_LABELS: Record<string, string> = { start: "From", end: "To", property_type: "Property type", source: "Source" };

export function ProductionTab() {
  const url = useUrlState();
  const { can } = useAuth();
  const groupBy = url.get("group_by") ?? "agent";
  const params = useMemo(
    () => ({ group_by: groupBy, start: url.get("start"), end: url.get("end"), property_type: url.get("property_type"), source: url.get("source"), agent_id: url.get("agent_id") }),
    [groupBy, url],
  );
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["commissions", "production", params],
    queryFn: () => api.get<Production>("/commissions/production", params),
    placeholderData: keepPreviousData,
  });

  const more: MoreFilterField[] = [
    { type: "date-range", label: "Closed between", minKey: "start", maxKey: "end" },
    { type: "select", label: "Property type", key: "property_type", options: PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] })) },
    { type: "text", label: "Source", key: "source" },
  ];
  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: k === "property_type" ? PROPERTY_TYPE_LABELS[url.get(k)!] ?? url.get(k)! : url.get(k)!, onRemove: () => url.set({ [k]: null }) }));

  const groupLabel = PRODUCTION_GROUPS.find((g) => g.value === groupBy)?.label ?? "Group";
  const columns: Column<ProductionRow & { id: string }>[] = [
    { id: "rank", header: "#", width: 40, cell: (r) => <span className="text-ink-3 tabular">{(data?.rows.findIndex((x) => x.key === r.key) ?? 0) + 1}</span> },
    { id: "label", header: groupLabel, cell: (r) => <span className="font-medium">{groupBy === "property_type" ? PROPERTY_TYPE_LABELS[r.label] ?? titleCase(r.label) : groupBy === "source" ? titleCase(r.label) : r.label}</span> },
    { id: "count", header: "Deals", align: "right", cell: (r) => formatNumber(r.count, 2) },
    { id: "volume", header: "Volume", align: "right", cell: (r) => formatCurrency(r.volume, { compact: true }) },
    { id: "gci", header: "GCI", align: "right", cell: (r) => <span className="font-medium">{formatCurrency(r.gci)}</span> },
    { id: "avg", header: "Avg deal size", align: "right", cell: (r) => formatCurrency(r.avg_deal_size, { compact: true }) },
    { id: "cycle", header: "Cycle time", align: "right", cell: (r) => (r.cycle_time_days != null ? `${formatNumber(r.cycle_time_days, 0)} d` : "—") },
    { id: "pipeline", header: "Pipeline deals", align: "right", cell: (r) => (r.deals_total ? `${r.deals_closed} / ${r.deals_total}` : "—") },
    { id: "conversion", header: "Conversion", align: "right", cell: (r) => (r.conversion_pct != null ? `${formatNumber(r.conversion_pct, 1)}%` : "—") },
    {
      id: "stages",
      header: "Stage mix",
      cell: (r) => (
        <span className="text-xs text-ink-3">
          {Object.entries(r.stage_counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([s, n]) => `${titleCase(s)} ${n}`)
            .join(" · ") || "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-2.5">
        <Toolbar>
          <FacetFilter
            label="Group by"
            single
            options={PRODUCTION_GROUPS.map((g) => ({ value: g.value, label: g.label }))}
            selected={[groupBy]}
            onChange={(v) => url.set({ group_by: v[0] ?? null })}
          />
          {can("commissions", "view_sensitive") && (
            <div className="w-56">
              <UserPicker value={url.get("agent_id")} onChange={(id) => url.set({ agent_id: id })} placeholder="All agents" />
            </div>
          )}
          <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
        </Toolbar>
        <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: "production", group_by: url.get("group_by") })} />
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Closed deals" value={formatNumber(data.totals.count, 1)} hint={`${data.start} to ${data.end}`} />
            <StatCard label="Volume" value={formatCurrency(data.totals.volume, { compact: true })} />
            <StatCard label="GCI" value={formatCurrency(data.totals.gci, { compact: true })} />
            <StatCard label="Average deal size" value={formatCurrency(data.totals.avg_deal_size, { compact: true })} />
            <StatCard label="Average cycle time" value={data.totals.cycle_time_days != null ? `${formatNumber(data.totals.cycle_time_days, 0)} days` : "—"} hint={data.pipeline_available && data.totals.deals_total ? `${formatNumber((100 * data.totals.deals_closed) / data.totals.deals_total, 1)}% pipeline conversion` : undefined} />
          </div>
          <Card className="overflow-hidden">
            <DataTable
              columns={columns}
              data={data.rows.map((r) => ({ ...r, id: r.key }))}
              fetching={isFetching}
              empty={<EmptyState title="No closed production in this period" description="Commissions count once they are earned." />}
            />
          </Card>
          {data.restricted && <p className="text-xs text-ink-3">Showing your own production only.</p>}
          {!data.pipeline_available && <p className="text-xs text-ink-3">Stage conversion is unavailable until the brokerage pipeline is enabled.</p>}
        </>
      )}
    </div>
  );
}
