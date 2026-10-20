"use client";

import { BarChart3, CalendarClock, Camera, Download } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime } from "@/lib/utils";
import { downloadDashboard, paramsToFilters, useCatalog, useDashboard, useReportParams, useRunSnapshots } from "@/features/reports/api";
import { ReportChart } from "@/features/reports/charts";
import { ReportFilterBar } from "@/features/reports/filter-bar";
import { ReportTable, TileCard } from "@/features/reports/report-table";
import { ScheduleSheet, SchedulesPanel } from "@/features/reports/schedules";

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const { can } = useAuth();
  const { url, params } = useReportParams();
  const catalog = useCatalog();
  const snapshots = useRunSnapshots();
  const [scheduling, setScheduling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const tab = url.get("tab");
  const dashboards = catalog.data?.dashboards ?? [];
  const current = dashboards.find((d) => d.key === url.get("d")) ?? dashboards[0] ?? null;
  const dash = useDashboard(tab === "schedules" ? null : current?.key ?? null, params);

  if (!can("reports")) {
    return <EmptyState icon={<BarChart3 />} title="No reports access" description="Ask an administrator for the Reports & Analytics permission." />;
  }

  const exportCsv = async () => {
    if (!current) return;
    setExporting(true);
    try {
      await downloadDashboard(current.key, params);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const recordSnapshots = async () => {
    try {
      const r = await snapshots.mutateAsync();
      toast.success(`Recorded ${r.created} KPI snapshots for ${r.as_of}${r.skipped ? ` (${r.skipped} already recorded)` : ""}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const data = dash.data;
  const wide = new Set(["team", "sources"]);

  return (
    <div className="flex gap-6">
      <aside className="hidden w-52 shrink-0 lg:block">
        <p className="mb-2 px-2 text-xs font-medium text-ink-3">Dashboards</p>
        <nav className="space-y-0.5">
          {catalog.isLoading && Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="mx-2 my-2 h-4" />)}
          {dashboards.map((d) => (
            <button
              key={d.key}
              onClick={() => url.set({ d: d.key, tab: null })}
              className={cn(
                "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                tab !== "schedules" && current?.key === d.key ? "bg-muted font-medium text-ink" : "text-ink-2 hover:bg-subtle hover:text-ink",
              )}
            >
              {d.label}
            </button>
          ))}
        </nav>
        <p className="mb-2 mt-5 px-2 text-xs font-medium text-ink-3">Delivery</p>
        <button
          onClick={() => url.set({ tab: "schedules" })}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            tab === "schedules" ? "bg-muted font-medium text-ink" : "text-ink-2 hover:bg-subtle hover:text-ink",
          )}
        >
          <CalendarClock className="size-4" />
          Scheduled reports
        </button>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-4 lg:hidden">
          <select
            value={tab === "schedules" ? "__schedules" : current?.key ?? ""}
            onChange={(e) => (e.target.value === "__schedules" ? url.set({ tab: "schedules" }) : url.set({ d: e.target.value, tab: null }))}
            className="h-8 w-full rounded-md border border-line-strong/80 bg-surface px-2 text-sm"
          >
            {dashboards.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
            <option value="__schedules">Scheduled reports</option>
          </select>
        </div>

        {tab === "schedules" ? (
          <>
            <PageHeader title="Scheduled reports" description="Recurring CSV delivery of dashboards, computed per recipient permissions." />
            <SchedulesPanel />
          </>
        ) : !current ? (
          catalog.isLoading ? null : (
            <EmptyState icon={<BarChart3 />} title="No dashboards available" description="You do not have access to any module these dashboards report on." />
          )
        ) : (
          <>
            <PageHeader
              title={current.label}
              description={data ? `${current.description} · updated ${formatDateTime(data.generated_at)}` : current.description}
              actions={
                <>
                  {catalog.data?.can_snapshot && (
                    <Button variant="ghost" loading={snapshots.isPending} onClick={recordSnapshots}>
                      <Camera />
                      Record snapshots
                    </Button>
                  )}
                  {catalog.data?.can_schedule && (
                    <Button onClick={() => setScheduling(true)}>
                      <CalendarClock />
                      Schedule
                    </Button>
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
            <div className="mb-5 space-y-2">
              <ReportFilterBar />
              {current.default_me && !url.get("user") && !url.get("team") && (
                <p className="text-xs text-ink-3">Showing your own work. Pick users or a team to see theirs.</p>
              )}
            </div>

            {dash.isError && <EmptyState title="Could not load this dashboard" description={errorMessage(dash.error)} />}

            <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4", dash.isFetching && !dash.isLoading && "opacity-70 transition-opacity")}>
              {dash.isLoading
                ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)
                : data?.tiles.map((t) => <TileCard key={t.key} t={t} />)}
            </div>

            {data && data.series.length > 0 && (
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                {data.series.map((s) => (
                  <ReportChart key={s.key} s={s} />
                ))}
              </div>
            )}

            {data && data.tables.length > 0 && (
              <div className="mt-5 grid gap-5 lg:grid-cols-2">
                {data.tables.map((t) => (
                  <div key={t.key} className={cn(wide.has(t.key) && "lg:col-span-2")}>
                    <ReportTable t={t} />
                  </div>
                ))}
              </div>
            )}

            {data && data.tiles.length === 0 && data.series.length === 0 && data.tables.length === 0 && (
              <EmptyState title="Nothing to show" description="None of this dashboard's sources are available to you." />
            )}

            <ScheduleSheet
              open={scheduling}
              onOpenChange={setScheduling}
              initial={{ dashboard_key: current.key, filters: paramsToFilters(params), name: current.label }}
            />
          </>
        )}
      </div>
    </div>
  );
}
