"use client";

import { useState } from "react";

import { StatCard } from "@/components/data/page";
import { Card, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Skeleton, Tooltip } from "@/components/ui/misc";
import { cn, formatNumber, titleCase } from "@/lib/utils";

import { useReactivationAnalytics, type TriggerPerformance } from "./api";

function Rate({ value, tone }: { value: number | null; tone: "noise" | "good" }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  const pct = Math.round(value * 100);
  const bad = tone === "noise" ? pct >= 60 : pct < 20;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone === "noise" ? (bad ? "bg-negative" : "bg-caution") : bad ? "bg-caution" : "bg-positive")} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("w-10 text-right tabular", bad && tone === "noise" ? "text-negative" : "text-ink")}>{pct}%</span>
    </div>
  );
}

export function AnalyticsTab() {
  const [since, setSince] = useState<string>("");
  const { data, isLoading } = useReactivationAnalytics(since ? Number(since) : null);

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;
  const t = data.totals;
  const decided = (t.reactivated ?? 0) + (t.dismissed ?? 0);
  const rows: TriggerPerformance[] = data.by_type;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select
          className="w-44"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          options={[
            { value: "", label: "All time" },
            { value: "90", label: "Last 90 days" },
            { value: "365", label: "Last 12 months" },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Armed triggers" value={formatNumber(t.armed ?? 0)} hint="Watching dead deals now" />
        <StatCard label="Fired" value={formatNumber(t.fired ?? 0)} hint={`${t.pending ?? 0} pending · ${t.snoozed ?? 0} snoozed`} />
        <StatCard label="Reactivated" value={formatNumber(t.reactivated ?? 0)} tone="positive" hint={decided ? `${Math.round((100 * (t.reactivated ?? 0)) / decided)}% of decisions` : undefined} />
        <StatCard label="Converted" value={formatNumber(t.converted ?? 0)} tone="positive" hint="Reached offer or later" />
        <StatCard label="Dismissed (noise)" value={formatNumber(t.dismissed ?? 0)} tone={decided && (t.dismissed ?? 0) / decided >= 0.6 ? "negative" : "default"} hint={decided ? `${Math.round((100 * (t.dismissed ?? 0)) / decided)}% of decisions` : undefined} />
      </div>

      <Card>
        <CardHeader title="Trigger performance" description="Noisy triggers (mostly dismissed) should be tuned; conversion shows which triggers find real deals." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-subtle text-left text-xs text-ink-3">
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 text-right font-medium">Armed</th>
                <th className="px-3 py-2 text-right font-medium">Fired</th>
                <th className="px-3 py-2 text-right font-medium">Reactivated</th>
                <th className="px-3 py-2 text-right font-medium">Converted</th>
                <th className="px-3 py-2 text-right font-medium">Dismissed</th>
                <th className="px-3 py-2 text-right font-medium">Noise rate</th>
                <th className="px-3 py-2 text-right font-medium">Conversion</th>
                <th className="px-3 py-2 text-right font-medium">
                  <Tooltip content="Average days between arming (dead disposition) and firing">
                    <span>Days to fire</span>
                  </Tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.trigger_type} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-medium text-ink">{r.label}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(r.armed)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(r.fired)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(r.reactivated)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(r.converted)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatNumber(r.dismissed)}</td>
                  <td className="px-3 py-2">
                    <Rate value={r.noise_rate} tone="noise" />
                  </td>
                  <td className="px-3 py-2">
                    <Rate value={r.conversion_rate} tone="good" />
                  </td>
                  <td className="px-3 py-2 text-right tabular text-ink-2">{r.avg_days_dead_to_fire === null ? "—" : formatNumber(r.avg_days_dead_to_fire, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Top dismissal reasons" description="What users say when a trigger was not worth acting on." />
        {data.top_dismiss_reasons.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">No dismissals yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.top_dismiss_reasons.map((d, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="w-28 shrink-0 text-xs text-ink-3">{titleCase(d.trigger_type)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{d.reason ?? "—"}</span>
                <span className="text-xs text-ink-3 tabular">{d.count}×</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
