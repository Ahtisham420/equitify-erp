"use client";

import { format, subDays } from "date-fns";
import { X } from "lucide-react";

import { FacetFilter, MoreFilters } from "@/components/data/filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUrlState } from "@/hooks/use-url-state";
import { cn, titleCase } from "@/lib/utils";

import { DEFAULT_DAYS, FILTER_KEYS, useFilterOptions } from "./api";

const PRESETS = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "365", label: "1y" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

function list(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** The single filter row shared by every dashboard and drill-through page. All state lives in the URL. */
export function ReportFilterBar({ showUser = true }: { showUser?: boolean }) {
  const url = useUrlState();
  const { data: opts } = useFilterOptions();
  const p = url.params;
  const custom = !!(p.date_from || p.date_to);
  const preset = custom ? "custom" : ((p.days as string | undefined) ?? DEFAULT_DAYS);

  const setPreset = (value: string) => {
    if (value === "custom") {
      const today = new Date();
      url.set({ days: null, date_from: format(subDays(today, 29), "yyyy-MM-dd"), date_to: format(today, "yyyy-MM-dd") });
    } else {
      url.set({ days: value === DEFAULT_DAYS ? null : value, date_from: null, date_to: null });
    }
  };

  const active = FILTER_KEYS.some((k) => k !== "days" && p[k]) || Object.keys(p).some((k) => k.startsWith("f_"));
  const clear = () =>
    url.set(Object.fromEntries([...FILTER_KEYS.filter((k) => k !== "days"), ...Object.keys(p).filter((k) => k.startsWith("f_"))].map((k) => [k, null])));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex h-8 items-center rounded-md border border-line-strong/80 bg-surface p-0.5 shadow-card" role="group" aria-label="Date range">
        {PRESETS.map((o) => (
          <button
            key={o.value}
            onClick={() => setPreset(o.value)}
            className={cn(
              "h-full rounded px-2 text-xs font-medium transition-colors",
              preset === o.value ? "bg-ink text-white" : "text-ink-2 hover:bg-muted hover:text-ink",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {custom && (
        <div className="flex items-center gap-1.5">
          <Input type="date" aria-label="From" className="w-[140px]" value={(p.date_from as string) ?? ""} onChange={(e) => url.set({ date_from: e.target.value || null })} />
          <span className="text-ink-3">–</span>
          <Input type="date" aria-label="To" className="w-[140px]" value={(p.date_to as string) ?? ""} onChange={(e) => url.set({ date_to: e.target.value || null })} />
        </div>
      )}
      {showUser && (
        <FacetFilter label="User" options={opts?.users ?? []} selected={list(p.user)} onChange={(v) => url.set({ user: v })} searchable />
      )}
      {showUser && (opts?.teams.length ?? 0) > 0 && (
        <FacetFilter label="Team" single options={opts?.teams ?? []} selected={list(p.team)} onChange={(v) => url.set({ team: v[0] ?? null })} />
      )}
      <FacetFilter
        label="Property type"
        options={(opts?.property_types ?? []).map((o) => ({ ...o, label: titleCase(o.label) }))}
        selected={list(p.property_type)}
        onChange={(v) => url.set({ property_type: v })}
      />
      <FacetFilter label="State" options={opts?.states ?? []} selected={list(p.state)} onChange={(v) => url.set({ state: v })} searchable />
      {(opts?.territories.length ?? 0) > 0 && (
        <FacetFilter label="Territory" single options={opts?.territories ?? []} selected={list(p.territory)} onChange={(v) => url.set({ territory: v[0] ?? null })} searchable />
      )}
      <FacetFilter label="Source" options={opts?.sources ?? []} selected={list(p.source)} onChange={(v) => url.set({ source: v })} searchable />
      <FacetFilter
        label="Stage"
        options={(opts?.stages ?? []).map((o) => ({ ...o, label: titleCase(o.label) }))}
        selected={list(p.stage)}
        onChange={(v) => url.set({ stage: v })}
      />
      <MoreFilters
        fields={[{ type: "text", label: "County", key: "county", placeholder: "e.g. Harris" }]}
        values={{ county: p.county as string | undefined }}
        onApply={(v) => url.set(v)}
      />
      {active && (
        <Button variant="ghost" size="sm" onClick={clear}>
          <X />
          Clear filters
        </Button>
      )}
    </div>
  );
}
