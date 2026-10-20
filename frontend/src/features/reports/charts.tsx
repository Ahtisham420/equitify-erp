"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { Point, SeriesOut } from "./api";
import { formatValue } from "./format";
import { AXIS_TICK, GRID_STROKE, MAX_SERIES, seriesColor } from "./palette";

type ChartClick = { activeTooltipIndex?: number } | null;
type Datum = { label: string; idx: number } & Record<string, number | string | null>;

function Legend({ s }: { s: SeriesOut }) {
  if (s.series.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {s.series.slice(0, MAX_SERIES).map((m, i) => (
        <Link key={m.key} href={m.href} className="inline-flex items-center gap-1.5 text-xs text-ink-2 hover:text-ink">
          <span className="size-2 rounded-full" style={{ background: seriesColor(i, s.series.length) }} />
          {m.label}
        </Link>
      ))}
    </div>
  );
}

function TooltipBody({ s, point }: { s: SeriesOut; point: Point }) {
  const series = s.series.slice(0, MAX_SERIES);
  return (
    <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
      <p className="mb-0.5 text-ink-3">{point.label}</p>
      {series.map((m, i) => (
        <p key={m.key} className="flex items-center gap-1.5 tabular text-ink">
          {series.length > 1 && <span className="size-2 rounded-full" style={{ background: seriesColor(i, series.length) }} />}
          <span className="font-medium">{formatValue(point.values[m.key], s.unit)}</span>
          {series.length > 1 && <span className="text-ink-3">{m.label}</span>}
        </p>
      ))}
      <p className="mt-0.5 text-2xs text-ink-3">Click to see the records</p>
    </div>
  );
}

/** One dashboard chart: time series (bars or lines) or a categorical breakdown (horizontal bars).
 * Every bar/point drills to the records behind it. */
export function ReportChart({ s }: { s: SeriesOut }) {
  const router = useRouter();
  const [selected, setSelected] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const series = s.series.slice(0, MAX_SERIES);
  const n = series.length;

  const data: Datum[] = useMemo(
    () =>
      s.points.map((p, idx) => {
        const row: Datum = { label: p.label, idx } as Datum;
        s.series.slice(0, MAX_SERIES).forEach((m, i) => {
          row[`s${i}`] = p.values[m.key] ?? null;
        });
        return row;
      }),
    [s],
  );

  const onClick = (state: ChartClick) => {
    const idx = state?.activeTooltipIndex;
    if (typeof idx !== "number" || !s.points[idx]) return;
    if (n === 1) {
      const href = s.points[idx].hrefs[series[0].key];
      if (href) router.push(href);
    } else setSelected(idx);
  };

  const empty = s.points.every((p) => series.every((m) => !p.values[m.key]));
  const tick = (v: number) => formatValue(v, s.unit, { compact: true });
  const tooltip = (
    <ChartTooltip
      cursor={{ fill: "rgb(var(--muted))", stroke: "rgb(var(--line-strong))" }}
      content={({ active, payload }) => {
        const idx = (payload?.[0]?.payload as Datum | undefined)?.idx;
        return active && typeof idx === "number" ? <TooltipBody s={s} point={s.points[idx]} /> : null;
      }}
    />
  );
  const height = s.kind === "breakdown" ? Math.max(160, Math.min(data.length, 12) * 30 + 24) : 224;
  const point = selected !== null ? s.points[selected] : null;

  return (
    <Card>
      <CardHeader
        title={s.label}
        description={s.description ?? undefined}
        actions={
          <button onClick={() => setAsTable((v) => !v)} className="text-xs font-medium text-ink-3 hover:text-ink">
            {asTable ? "Chart" : "Table"}
          </button>
        }
      />
      <CardBody className="space-y-3">
        <Legend s={s} />
        {empty ? (
          <p className="py-10 text-center text-sm text-ink-3">No records for these filters</p>
        ) : asTable ? (
          <div className="max-h-72 overflow-y-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-3">
                  <th className="py-1 font-medium">{s.kind === "time" ? "Period" : "Group"}</th>
                  {series.map((m) => (
                    <th key={m.key} className="py-1 text-right font-medium">{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.points.map((p) => (
                  <tr key={p.key} className="border-t border-line">
                    <td className="py-1 text-ink-2">{p.label}</td>
                    {series.map((m) => (
                      <td key={m.key} className="py-1 text-right tabular">
                        <Link href={p.hrefs[m.key] ?? m.href} className="hover:text-accent hover:underline">
                          {formatValue(p.values[m.key], s.unit)}
                        </Link>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="cursor-pointer" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              {s.kind === "breakdown" ? (
                <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barCategoryGap={6} onClick={onClick}>
                  <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
                  <XAxis type="number" tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={tick} />
                  <YAxis type="category" dataKey="label" width={128} tickLine={false} axisLine={false} tick={AXIS_TICK} interval={0} />
                  {tooltip}
                  {series.map((m, i) => (
                    <Bar key={m.key} dataKey={`s${i}`} name={m.label} fill={seriesColor(i, n)} radius={[0, 4, 4, 0]} maxBarSize={18} />
                  ))}
                </BarChart>
              ) : s.chart === "line" ? (
                <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} onClick={onClick}>
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} minTickGap={16} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={tick} width={56} allowDecimals={false} />
                  {tooltip}
                  {series.map((m, i) => (
                    <Line key={m.key} type="monotone" dataKey={`s${i}`} name={m.label} stroke={seriesColor(i, n)} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  ))}
                </LineChart>
              ) : (
                <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap={4} onClick={onClick}>
                  <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} minTickGap={16} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={tick} width={56} allowDecimals={false} />
                  {tooltip}
                  {series.map((m, i) => (
                    <Bar key={m.key} dataKey={`s${i}`} name={m.label} fill={seriesColor(i, n)} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
        {point && n > 1 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-subtle px-2.5 py-1.5 text-xs">
            <span className="font-medium text-ink">{point.label}</span>
            {series.map((m, i) => (
              <Link key={m.key} href={point.hrefs[m.key] ?? m.href} className={cn("inline-flex items-center gap-1.5 text-ink-2 hover:text-ink hover:underline")}>
                <span className="size-2 rounded-full" style={{ background: seriesColor(i, n) }} />
                {m.label}: <span className="tabular font-medium text-ink">{formatValue(point.values[m.key], s.unit)}</span>
              </Link>
            ))}
            <button onClick={() => setSelected(null)} className="ml-auto text-ink-3 hover:text-ink">Close</button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
