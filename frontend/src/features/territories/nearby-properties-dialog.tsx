"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useDebounce } from "@/hooks/use-debounce";
import { api, errorMessage, type Page } from "@/lib/api";
import { formatNumber, titleCase } from "@/lib/utils";

import { GROWTH_KINDS, type PropertyRef, type TrafficCount } from "./api";

export type NearbyTarget = { kind: "corridor" | "node"; id: string; name: string } | null;

/** Properties by corridor buffer / node radius, optionally narrowed by traffic and nearby growth. */
export function NearbyPropertiesDialog({ target, onClose }: { target: NearbyTarget; onClose: () => void }) {
  const [distance, setDistance] = useState("");
  const [minTraffic, setMinTraffic] = useState("");
  const [growth, setGrowth] = useState("");
  const d = useDebounce(distance, 400);
  const t = useDebounce(minTraffic, 400);

  useEffect(() => {
    if (target) {
      setDistance(target.kind === "corridor" ? "500" : "1");
      setMinTraffic("");
      setGrowth("");
    }
  }, [target]);

  const params = target
    ? {
        ...(target.kind === "corridor" ? { corridor_id: target.id, buffer_ft: Number(d) || 500 } : { node_id: target.id, radius_miles: Number(d) || 1 }),
        min_traffic: Number(t) || undefined,
        growth_kind: growth || undefined,
        page_size: 100,
      }
    : undefined;

  const { data, isLoading, error } = useQuery({
    queryKey: ["geography", "properties", params],
    queryFn: () => api.get<Page<PropertyRef>>("/geography/properties", params),
    enabled: !!target,
  });

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()} className="max-w-2xl" title={`Properties near ${target?.name ?? ""}`} description="Spatial query against property locations (PostGIS).">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label={target?.kind === "corridor" ? "Buffer (ft)" : "Radius (miles)"}>
            <Input value={distance} onChange={(e) => setDistance(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Min traffic (VPD)">
            <Input value={minTraffic} onChange={(e) => setMinTraffic(e.target.value)} inputMode="numeric" placeholder="Any" />
          </Field>
          <Field label="Growth within 1 mi">
            <Select value={growth} onChange={(e) => setGrowth(e.target.value)} placeholder="Any" options={GROWTH_KINDS.map((k) => ({ value: k, label: titleCase(k) }))} />
          </Field>
        </div>
        {error ? (
          <p className="text-sm text-negative">{errorMessage(error)}</p>
        ) : isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data?.items.length ? (
          <p className="py-6 text-center text-sm text-ink-3">No properties match.</p>
        ) : (
          <div className="rounded-lg border border-line">
            <p className="border-b border-line bg-subtle/60 px-3 py-2 text-xs text-ink-3 tabular">
              {formatNumber(data.total)} propert{data.total === 1 ? "y" : "ies"}
              {data.total > data.items.length ? ` · showing ${data.items.length}` : ""}
            </p>
            <ul className="max-h-80 divide-y divide-line overflow-y-auto scrollbar-thin">
              {data.items.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <Link href={`/properties/${p.id}`} className="truncate text-sm font-medium text-ink hover:text-accent">
                      {p.name || p.address_line}
                    </Link>
                    <p className="truncate text-xs text-ink-3">{[p.address_line, p.city, p.state].filter(Boolean).join(", ")}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {p.traffic_count != null && <Badge tone="outline">{formatNumber(p.traffic_count)} VPD</Badge>}
                    {p.distance_miles != null && <span className="text-xs text-ink-3 tabular">{formatNumber(p.distance_miles, 2)} mi</span>}
                    <StatusBadge status={p.status} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Year-over-year history for one traffic segment/approach. */
export function TrafficTrendDialog({ row, onClose }: { row: TrafficCount | null; onClose: () => void }) {
  const params = row
    ? { corridor_id: row.corridor_id ?? undefined, node_id: row.node_id ?? undefined, segment: row.segment ?? undefined, approach: row.approach ?? undefined }
    : undefined;
  const { data, isLoading, error } = useQuery({
    queryKey: ["traffic-counts", "trend", params],
    queryFn: () => api.get<{ count_year: number; count: number; source: string }[]>("/traffic-counts/trend", params),
    enabled: !!row && !!(row.corridor_id || row.node_id || row.segment),
  });
  const max = Math.max(1, ...(data ?? []).map((p) => p.count));

  return (
    <Dialog
      open={!!row}
      onOpenChange={(o) => !o && onClose()}
      title="Traffic history"
      description={[row?.segment, row?.approach, row?.corridor_name, row?.node_name].filter(Boolean).join(" · ") || undefined}
    >
      {error ? (
        <p className="text-sm text-negative">{errorMessage(error)}</p>
      ) : isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !data?.length ? (
        <p className="text-sm text-ink-3">Link the count to a corridor, node or segment to see its history.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {data.map((p, i) => {
              const prev = i > 0 ? data[i - 1].count : null;
              const change = prev ? ((p.count - prev) / prev) * 100 : null;
              return (
                <tr key={`${p.count_year}-${i}`} className="border-b border-line last:border-0">
                  <td className="w-14 py-1.5 tabular text-ink-2">{p.count_year}</td>
                  <td className="py-1.5">
                    <div className="h-1.5 rounded-full bg-accent/70" style={{ width: `${(p.count / max) * 100}%` }} />
                  </td>
                  <td className="w-24 py-1.5 text-right tabular">{formatNumber(p.count)}</td>
                  <td className={`w-16 py-1.5 text-right text-xs tabular ${change == null ? "text-ink-3" : change >= 0 ? "text-positive" : "text-negative"}`}>
                    {change == null ? "—" : `${change >= 0 ? "+" : ""}${formatNumber(change, 1)}%`}
                  </td>
                  <td className="max-w-[140px] truncate py-1.5 pl-3 text-xs text-ink-3">{p.source}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}
