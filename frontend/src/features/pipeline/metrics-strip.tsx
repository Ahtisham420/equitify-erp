"use client";

import Link from "next/link";

import { Skeleton } from "@/components/ui/misc";
import { cn, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

import { ACTIVE_STAGES, stageLabel, usePipelineMetrics } from "./api";

/** Pipeline health: totals, per-stage counts with conversion and velocity, stalled count. */
export function MetricsStrip({ ownerIds }: { ownerIds: string[] }) {
  const { data, isLoading } = usePipelineMetrics({ owner_id: ownerIds });
  if (isLoading || !data) return <Skeleton className="mb-4 h-[132px] w-full" />;

  const t = data.totals;
  const conv = Object.fromEntries(data.conversion.map((c) => [c.stage, c]));
  const vel = Object.fromEntries(data.velocity.map((v) => [v.stage, v]));
  const byStage = Object.fromEntries(data.stages.map((s) => [s.stage, s]));
  const won = byStage.closed?.count ?? 0;

  const totals = [
    { label: "Active", value: formatNumber(t.active_count), hint: formatCurrency(t.active_value, { compact: true }) },
    { label: "Stalled", value: formatNumber(t.stalled_count), hint: "Over stage threshold", href: "/pipeline?view=table&stalled=true", tone: t.stalled_count ? "text-negative" : "" },
    { label: "Closed", value: formatNumber(won), hint: formatCurrency(t.closed_value, { compact: true }), href: "/pipeline?view=table&stage=closed" },
    { label: "Nurture", value: formatNumber(t.nurture_count), href: "/pipeline?view=table&stage=nurture" },
    { label: "Dead", value: formatNumber(t.dead_count), href: "/pipeline?view=table&stage=dead" },
  ];

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      <div className="grid grid-cols-5 divide-x divide-line border-b border-line">
        {totals.map((m) => {
          const body = (
            <>
              <p className="text-xs font-medium text-ink-3">{m.label}</p>
              <p className={cn("mt-0.5 text-lg font-semibold tracking-tight tabular", m.tone)}>{m.value}</p>
              {m.hint && <p className="truncate text-xs text-ink-3">{m.hint}</p>}
            </>
          );
          return m.href ? (
            <Link key={m.label} href={m.href} className="px-4 py-2.5 transition-colors hover:bg-subtle/60">
              {body}
            </Link>
          ) : (
            <div key={m.label} className="px-4 py-2.5">
              {body}
            </div>
          );
        })}
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <div className="grid min-w-[900px] grid-cols-10 divide-x divide-line">
          {ACTIVE_STAGES.map((s) => {
            const m = byStage[s];
            const c = conv[s];
            const v = vel[s];
            return (
              <div key={s} className="px-3 py-2" title={`Avg ${m?.avg_age_days ?? "—"} days in stage now · ${m?.stalled ?? 0} stalled (>${m?.stall_days ?? 14}d)`}>
                <p className="truncate text-2xs font-medium uppercase tracking-wide text-ink-3">{stageLabel(s)}</p>
                <p className="text-sm font-semibold tabular text-ink">
                  {formatNumber(m?.count ?? 0)}
                  {m?.stalled ? <span className="ml-1 text-xs font-medium text-negative">{m.stalled} stalled</span> : null}
                </p>
                <p className="text-2xs text-ink-3 tabular">
                  {c?.rate != null ? `${formatPercent(c.rate * 100, 0)} → next` : "— → next"} · {v?.avg_days != null ? `${formatNumber(v.avg_days, 1)}d avg` : "—"}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
