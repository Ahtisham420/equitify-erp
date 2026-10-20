"use client";

import { Download, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { DataTable } from "@/components/data/data-table";
import { FilterChips } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader, StatCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber, titleCase } from "@/lib/utils";
import { downloadKpi, useCatalog, useKpi, useKpiHistory, useKpiRecords, useReportParams, type KpiOut, type SnapshotPoint } from "@/features/reports/api";
import { ReportFilterBar } from "@/features/reports/filter-bar";
import { formatDelta, formatValue, ignoredText } from "@/features/reports/format";
import { AXIS_TICK, SINGLE_SERIES } from "@/features/reports/palette";
import { reportColumns } from "@/features/reports/report-table";

export default function KpiPage({ params }: { params: { key: string } }) {
  return (
    <Suspense fallback={null}>
      <KpiDrill kpiKey={decodeURIComponent(params.key)} />
    </Suspense>
  );
}

function History({ kpi, points }: { kpi: KpiOut; points: SnapshotPoint[] }) {
  if (points.length < 2) {
    return <p className="py-6 text-center text-sm text-ink-3">{points.length === 1 ? `One snapshot recorded (${formatDate(points[0].as_of)})` : "No dated snapshots recorded yet"}</p>;
  }
  return (
    <div className="h-40">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="as_of" tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={(v: string) => formatDate(v, "MMM d")} minTickGap={20} />
          <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} width={56} tickFormatter={(v: number) => formatValue(v, kpi.unit, { compact: true })} />
          <ChartTooltip
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                  <p className="text-ink-3">{formatDate((payload[0].payload as SnapshotPoint).as_of)}</p>
                  <p className="font-medium tabular text-ink">{formatValue(payload[0].value as number, kpi.unit)}</p>
                </div>
              ) : null
            }
          />
          <Line type="monotone" dataKey="value" stroke={SINGLE_SERIES} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function KpiDrill({ kpiKey }: { kpiKey: string }) {
  const { can } = useAuth();
  const { url, params } = useReportParams();
  const catalog = useCatalog();
  const page = url.getNumber("page", 1);
  const pageSize = url.getNumber("page_size", 25);
  const kpi = useKpi(kpiKey, params);
  const recs = useKpiRecords(kpiKey, params, page, pageSize);
  const history = useKpiHistory(kpiKey);
  const [exporting, setExporting] = useState(false);

  if (!can("reports")) return <EmptyState title="No reports access" />;
  if (kpi.isError) {
    return <EmptyState title="Metric not available" description={errorMessage(kpi.error)} action={<Link href="/reports" className="text-sm text-accent hover:underline">Back to reports</Link>} />;
  }

  const k = kpi.data;
  const facets = Object.entries(url.params).filter(([key]) => key.startsWith("f_"));
  const chips = facets.map(([key, value]) => ({
    key,
    label: titleCase(key.slice(2)),
    value: (Array.isArray(value) ? value[0] : value) === "__none__" ? "Not set" : titleCase(String(Array.isArray(value) ? value[0] : value)),
    onRemove: () => url.set({ [key]: null }),
  }));
  const ignored = k ? ignoredText(k.ignored_filters) : null;
  const delta = k ? formatDelta(k.delta, k.unit) : null;
  const tone = k?.delta && k.better ? ((k.delta > 0) === (k.better === "up") ? "positive" : "negative") : "default";

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadKpi(kpiKey, params);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: k ? titleCase(k.family) : "Metric" }]}
        title={k?.label ?? "Loading…"}
        description={k?.definition}
        actions={
          <>
            {k?.module_href && (
              <Link
                href={k.module_href}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong/80 bg-surface px-3 text-sm font-medium text-ink shadow-card hover:bg-subtle [&_svg]:size-4"
              >
                <ExternalLink />
                Open in module
              </Link>
            )}
            {catalog.data?.can_export && (
              <Button onClick={exportCsv} loading={exporting}>
                <Download />
                Export CSV
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 space-y-2">
        <ReportFilterBar />
        <FilterChips chips={chips} onClear={() => url.set(Object.fromEntries(facets.map(([key]) => [key, null])))} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-3">
          <StatCard
            label={k?.point_in_time ? "Current value" : "Value for the selected period"}
            value={k ? formatValue(k.value, k.unit) : "—"}
            hint={[delta, ignored].filter(Boolean).join(" · ") || undefined}
            tone={tone}
          />
          <p className="px-1 text-xs text-ink-3">
            {k?.unit === "percent" && k.columns.some((c) => c.key === "_hit")
              ? "Records below are the denominator; the last column marks those counted in the rate."
              : "Records below are exactly the records that make up this number."}
          </p>
        </div>
        <Card className="lg:col-span-2">
          <CardHeader title="History" description="Dated snapshots of this metric (unfiltered)" />
          <CardBody>{k && <History kpi={k} points={history.data ?? []} />}</CardBody>
        </Card>
      </div>

      <div className="mt-5">
        <ListCard
          toolbar={
            recs.data && recs.data.withheld > 0 ? (
              <p className="text-xs text-caution">
                {formatNumber(recs.data.withheld)} records on this page come from license-restricted sources and are withheld from exports.
              </p>
            ) : undefined
          }
          footer={
            <TableFooter
              page={page}
              pageSize={pageSize}
              total={recs.data?.total ?? 0}
              onPage={(p) => url.set({ page: p }, { resetPage: false })}
              onPageSize={(s) => url.set({ page_size: s })}
            />
          }
        >
          <DataTable
            columns={reportColumns(recs.data?.columns ?? k?.columns ?? [])}
            data={recs.data?.items}
            loading={recs.isLoading}
            fetching={recs.isFetching}
            empty={<EmptyState title="No records" description="Nothing matches this metric with the current filters." />}
          />
        </ListCard>
      </div>
    </>
  );
}
