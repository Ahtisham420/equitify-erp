"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, titleCase } from "@/lib/utils";

import type { Accuracy, Forecast, ForecastBucket, ForecastItem } from "./api";

function monthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
}

function ForecastChart({ data }: { data: ForecastBucket[] }) {
  const rows = data.map((b) => ({ ...b, label: monthLabel(b.month) }));
  if (rows.every((r) => r.weighted === 0)) return <p className="py-12 text-center text-sm text-ink-3">No expected commission income in this horizon</p>;
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 8 }} barCategoryGap={6}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} />
          <YAxis tickLine={false} axisLine={false} width={56} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} tickFormatter={(v: number) => formatCurrency(v, { compact: true })} />
          <ChartTooltip
            cursor={{ fill: "rgb(var(--muted))" }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                  <p className="text-ink-3">{(payload[0].payload as ForecastBucket & { label: string }).label}</p>
                  <p className="font-medium text-ink tabular">{formatCurrency(payload[0].value as number)} weighted</p>
                  <p className="text-ink-3 tabular">
                    {formatCurrency((payload[0].payload as ForecastBucket).unweighted)} unweighted · {(payload[0].payload as ForecastBucket).count} items
                  </p>
                </div>
              ) : null
            }
          />
          <Bar dataKey="weighted" fill="rgb(var(--accent))" radius={[4, 4, 0, 0]} maxBarSize={32} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const itemCols: Column<ForecastItem>[] = [
  { id: "title", header: "Commission / deal", cell: (i) => <span className="font-medium">{i.title ?? "—"}</span> },
  { id: "kind", header: "Source", cell: (i) => <span className="text-ink-2">{i.kind === "deal" ? "Pipeline deal" : "Commission"}</span> },
  { id: "status", header: "Status", cell: (i) => <span className="text-ink-2">{titleCase(i.status)}</span> },
  { id: "expected", header: "Expected", cell: (i) => <span className={cn("whitespace-nowrap", i.bucket === "past_due" && "text-negative")}>{formatDate(i.expected_on)}</span> },
  { id: "amount", header: "Amount", align: "right", cell: (i) => formatCurrency(i.amount) },
  { id: "prob", header: "Weight", align: "right", cell: (i) => `${formatNumber(i.weight * 100, 0)}%` },
  { id: "weighted", header: "Weighted", align: "right", cell: (i) => <span className="font-medium">{formatCurrency(i.weighted)}</span> },
];

export function ForecastTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["commissions", "forecast"], queryFn: () => api.get<Forecast>("/commissions/forecast", { months: 12 }) });
  const accuracy = useQuery({
    queryKey: ["commissions", "accuracy"],
    queryFn: () => api.get<Accuracy>("/commissions/forecast/accuracy", { months: 12 }),
    enabled: can("commissions", "view_sensitive"),
  });
  const snap = useMutation({
    mutationFn: () => api.post("/commissions/forecast/snapshot"),
    onSuccess: () => {
      toast.success("Forecast snapshot recorded for this month");
      qc.invalidateQueries({ queryKey: ["commissions", "accuracy"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading || !data) return <Skeleton className="h-72 w-full" />;
  const next3 = data.months.slice(0, 3).reduce((s, b) => s + b.weighted, 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Weighted, next 12 months" value={formatCurrency(data.total_weighted, { compact: true })} hint={`${formatCurrency(data.total_unweighted, { compact: true })} unweighted`} />
        <StatCard label="Weighted, next 3 months" value={formatCurrency(next3, { compact: true })} />
        <StatCard label="Past expected date" value={formatCurrency(data.past_due.weighted, { compact: true })} tone={data.past_due.weighted > 0 ? "caution" : "default"} hint={`${data.past_due.count} items to follow up`} />
        <StatCard label="Unscheduled" value={formatCurrency(data.unscheduled.weighted, { compact: true })} hint={`${data.unscheduled.count} items without an expected date`} />
      </div>

      <Card>
        <CardHeader
          title="Weighted forecast by month"
          description={`Probability-weighted by expected payment date${data.pipeline_included ? ", including pipeline deals without a commission record" : ""}${data.restricted ? " · your net share only" : ""}.`}
          actions={
            can("commissions", "edit") && (
              <Button size="sm" loading={snap.isPending} onClick={() => snap.mutate()}>
                <Camera /> Snapshot
              </Button>
            )
          }
        />
        <CardBody>
          <ForecastChart data={data.months} />
          <div className="mt-3 grid grid-cols-4 gap-x-6 gap-y-1 text-xs sm:grid-cols-6 lg:grid-cols-12">
            {data.months.map((b) => (
              <div key={b.month} className="text-center">
                <p className="text-ink-3">{monthLabel(b.month)}</p>
                <p className="font-medium tabular">{formatCurrency(b.weighted, { compact: true })}</p>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {accuracy.data && (
        <Card className="overflow-hidden">
          <CardHeader
            title="Historical forecast accuracy"
            description={`Forecast at the start of each month vs. collections received · ${accuracy.data.snapshots} monthly snapshots${accuracy.data.average_accuracy_pct != null ? ` · average ${formatNumber(accuracy.data.average_accuracy_pct, 1)}%` : ""}`}
          />
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-xs text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Month</th>
                  <th className="px-3 py-2 text-right font-medium">Forecast (3 mo prior)</th>
                  <th className="px-3 py-2 text-right font-medium">Forecast (start of month)</th>
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-right font-medium">Variance</th>
                  <th className="px-3 py-2 text-right font-medium">Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {accuracy.data.months.map((m) => (
                  <tr key={m.month} className="border-t border-line">
                    <td className="px-3 py-1.5">{monthLabel(m.month)}</td>
                    <td className="px-3 py-1.5 text-right tabular text-ink-2">{m.forecast_3m != null ? formatCurrency(m.forecast_3m) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular">{m.forecast != null ? formatCurrency(m.forecast) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular">{formatCurrency(m.actual)}</td>
                    <td className={cn("px-3 py-1.5 text-right tabular", m.variance != null && m.variance < 0 && "text-negative")}>{m.variance != null ? formatCurrency(m.variance) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular">{m.accuracy_pct != null ? `${formatNumber(m.accuracy_pct, 1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Forecast detail" />
        <DataTable columns={itemCols} data={data.items.map((i) => ({ ...i, id: `${i.kind}-${i.id}` }))} dense empty={<EmptyState title="Nothing forecast" />} />
      </Card>
    </div>
  );
}
