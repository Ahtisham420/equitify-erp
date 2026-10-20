"use client";

import { Tooltip } from "@/components/ui/misc";
import { formatCurrency } from "@/lib/utils";

/**
 * Indicated value range: a band from low to high with the point estimate marked, plus each included comp&apos;s
 * adjusted value as a tick so the spread behind the range is visible.
 */
export function ValueRange({
  low,
  high,
  point,
  marks = [],
  format = (v: number) => formatCurrency(v, { compact: true }),
}: {
  low: number | null | undefined;
  high: number | null | undefined;
  point: number | null | undefined;
  marks?: { label: string; value: number | null }[];
  format?: (v: number) => string;
}) {
  if (low === null || low === undefined || high === null || high === undefined || point === null || point === undefined) {
    return <p className="text-sm text-ink-3">No indicated range yet. Include comps and set the subject quantity.</p>;
  }
  const values = [low, high, point, ...marks.map((m) => m.value).filter((v): v is number => v !== null)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.08 || Math.abs(point) * 0.05 || 1;
  const lo = min - pad;
  const span = max + pad - lo;
  const pos = (v: number) => `${((v - lo) / span) * 100}%`;

  return (
    <div>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
        <div className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm bg-accent/20 ring-1 ring-inset ring-accent/30" style={{ left: pos(low), width: `calc(${pos(high)} - ${pos(low)})` }} />
        {marks.map((m, i) =>
          m.value === null ? null : (
            <Tooltip key={i} content={`${m.label}: ${format(m.value)}`}>
              <span className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-ink-3" style={{ left: pos(m.value) }} />
            </Tooltip>
          ),
        )}
        <Tooltip content={`Point estimate: ${format(point)}`}>
          <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow-card" style={{ left: pos(point) }} />
        </Tooltip>
      </div>
      <div className="mt-1 grid grid-cols-3 text-xs">
        <div>
          <p className="text-ink-3">Low</p>
          <p className="font-medium text-ink tabular">{format(low)}</p>
        </div>
        <div className="text-center">
          <p className="text-ink-3">Point</p>
          <p className="font-semibold text-ink tabular">{format(point)}</p>
        </div>
        <div className="text-right">
          <p className="text-ink-3">High</p>
          <p className="font-medium text-ink tabular">{format(high)}</p>
        </div>
      </div>
    </div>
  );
}
