"use client";

import { Activity, Download } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Sheet } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { useListQuery } from "@/hooks/use-list-query";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils";

import { useExportsByUser, useJobSummary, type ExportByUser, type ExportEvent, type JobRun, type JobSummary } from "./api";

const JOB_STATUS_LABEL: Record<string, string> = { running: "Running", succeeded: "Succeeded", failed: "Failed" };

function JobStatus({ status }: { status: string }) {
  if (status === "running") return <Badge tone="sky" dot>Running</Badge>;
  return <StatusBadge status={status === "succeeded" ? "success" : "failed"} label={JOB_STATUS_LABEL[status] ?? status} />;
}

function duration(ms: number | null) {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${formatNumber(ms / 1000, 1)} s`;
}

export function JobsTab() {
  const summary = useJobSummary(7);
  const list = useListQuery<JobRun>("platform", "/platform/jobs");
  const { url } = list;
  const statuses = url.getAll("status");
  const keys = url.getAll("job_key");
  const [open, setOpen] = useState<JobRun | null>(null);

  const summaryCols: Column<JobSummary & { id: string }>[] = [
    { id: "key", header: "Job", cell: (j) => <span className="font-mono text-xs text-ink">{j.job_key}</span> },
    { id: "runs", header: "Runs (7d)", align: "right", cell: (j) => formatNumber(j.runs) },
    { id: "failures", header: "Failures", align: "right", cell: (j) => <span className={j.failures ? "text-negative" : undefined}>{formatNumber(j.failures)}</span> },
    { id: "last", header: "Last run", cell: (j) => <span className="flex items-center gap-2"><JobStatus status={j.last_status} /><span className="text-ink-3">{formatRelative(j.last_started_at)}</span></span> },
    { id: "error", header: "Last error", cell: (j) => <span className="block max-w-[360px] truncate text-xs text-ink-3">{j.last_error ?? "—"}</span> },
  ];

  const columns: Column<JobRun>[] = [
    { id: "key", header: "Job", cell: (j) => <span className="font-mono text-xs text-ink">{j.job_key}</span> },
    { id: "status", header: "Status", cell: (j) => <JobStatus status={j.status} /> },
    { id: "started", header: "Started", cell: (j) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(j.started_at)}</span> },
    { id: "duration", header: "Duration", align: "right", cell: (j) => duration(j.duration_ms) },
    {
      id: "counts",
      header: "Counts",
      cell: (j) => (
        <span className="block max-w-[280px] truncate text-xs text-ink-3">
          {Object.entries(j.counts ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") || "—"}
        </span>
      ),
    },
    { id: "error", header: "Error", cell: (j) => <span className="block max-w-[280px] truncate text-xs text-negative">{j.error ?? ""}</span> },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Jobs in the last 7 days" description="Every background job records a run with status, counts and errors. Failed runs are retryable by re-triggering the job." />
        <DataTable
          columns={summaryCols}
          data={summary.data?.map((s) => ({ ...s, id: s.job_key }))}
          loading={summary.isLoading}
          onRowClick={(s) => url.set({ job_key: [s.job_key] })}
          dense
          empty={<EmptyState icon={<Activity />} title="No job runs yet" description="Runs appear when scheduled or manual jobs execute." />}
        />
      </Card>
      <ListCard
        toolbar={
          <div className="space-y-2">
            <Toolbar>
              <SearchInput value={(url.params.q as string) ?? ""} onChange={(v) => url.set({ q: v })} placeholder="Search job or error" shortcut={false} />
              <FacetFilter label="Status" options={Object.entries(JOB_STATUS_LABEL).map(([value, label]) => ({ value, label }))} selected={statuses} onChange={(v) => url.set({ status: v })} />
            </Toolbar>
            <FilterChips
              chips={[
                ...statuses.map((s) => ({ key: `s:${s}`, label: "Status", value: JOB_STATUS_LABEL[s] ?? s, onRemove: () => url.set({ status: statuses.filter((x) => x !== s) }) })),
                ...keys.map((k) => ({ key: `k:${k}`, label: "Job", value: k, onRemove: () => url.set({ job_key: keys.filter((x) => x !== k) }) })),
              ]}
              onClear={() => url.set({ status: null, job_key: null, q: null })}
            />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(p) => url.set({ page: p }, { resetPage: false })} onPageSize={(s) => url.set({ page_size: s })} />}
      >
        <DataTable columns={columns} data={list.data?.items} loading={list.isLoading} fetching={list.isFetching} onRowClick={setOpen} dense empty={<EmptyState icon={<Activity />} title="No runs match" />} />
      </ListCard>
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.job_key ?? "Job run"} description={open ? formatDateTime(open.started_at) : undefined}>
        {open && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-3">
              <JobStatus status={open.status} />
              <span className="text-ink-3">{duration(open.duration_ms)}</span>
            </div>
            {open.error && <pre className="whitespace-pre-wrap rounded-md border border-negative/30 bg-negative-soft p-3 font-mono text-xs text-negative">{open.error}</pre>}
            <pre className="rounded-md border border-line bg-subtle p-3 font-mono text-xs text-ink">{JSON.stringify(open.counts, null, 2)}</pre>
          </div>
        )}
      </Sheet>
    </div>
  );
}

const DAY_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
];

export function ExportsTab() {
  const list = useListQuery<ExportEvent>("platform", "/platform/exports");
  const { url } = list;
  const days = Number(url.get("days") ?? "30") || 30;
  const byUser = useExportsByUser(days);
  const actorId = url.get("actor_id");

  const userCols: Column<ExportByUser & { id: string }>[] = [
    { id: "user", header: "User", cell: (u) => <span className="font-medium text-ink">{u.actor_name ?? "System"}</span> },
    { id: "exports", header: "Exports", align: "right", cell: (u) => formatNumber(u.exports) },
    { id: "rows", header: "Rows exported", align: "right", cell: (u) => formatNumber(u.rows) },
    { id: "last", header: "Last export", cell: (u) => <span className="text-ink-3">{formatRelative(u.last_at)}</span> },
  ];

  const columns: Column<ExportEvent>[] = [
    { id: "when", header: "When", cell: (e) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(e.occurred_at)}</span> },
    { id: "user", header: "User", cell: (e) => <span className="text-ink">{e.actor_name ?? "System"}</span> },
    { id: "action", header: "Export", cell: (e) => <span className="font-mono text-xs text-ink">{e.action}</span> },
    { id: "rows", header: "Rows", align: "right", cell: (e) => formatNumber(e.rows) },
    { id: "summary", header: "Details", cell: (e) => <span className="block max-w-[320px] truncate text-xs text-ink-3">{e.summary ?? "—"}</span> },
    { id: "ip", header: "IP", cell: (e) => <span className="font-mono text-2xs text-ink-3">{e.ip_address ?? "—"}</span> },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Export volume by user"
          description="Every bulk export is written to the immutable audit log. Unusual volume is a data-loss signal."
          actions={<Select value={String(days)} onChange={(e) => url.set({ days: e.target.value })} options={DAY_OPTIONS} className="w-40" />}
        />
        <DataTable
          columns={userCols}
          data={byUser.data?.map((u) => ({ ...u, id: u.actor_id ?? "system" }))}
          loading={byUser.isLoading}
          onRowClick={(u) => u.actor_id && url.set({ actor_id: u.actor_id })}
          dense
          empty={<EmptyState icon={<Download />} title="No exports in this period" />}
        />
      </Card>
      <ListCard
        toolbar={
          <div className="space-y-2">
            <Toolbar right={<Link href="/admin/audit" className="text-sm text-ink-2 hover:text-ink hover:underline">Open audit log</Link>}>
              <SearchInput value={(url.params.q as string) ?? ""} onChange={(v) => url.set({ q: v })} placeholder="Search exports" shortcut={false} />
            </Toolbar>
            <FilterChips
              chips={actorId ? [{ key: "actor", label: "User", value: byUser.data?.find((u) => u.actor_id === actorId)?.actor_name ?? "Selected user", onRemove: () => url.set({ actor_id: null }) }] : []}
              onClear={() => url.set({ actor_id: null, q: null })}
            />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(p) => url.set({ page: p }, { resetPage: false })} onPageSize={(s) => url.set({ page_size: s })} />}
      >
        <DataTable columns={columns} data={list.data?.items} loading={list.isLoading} fetching={list.isFetching} dense empty={<EmptyState icon={<Download />} title="No exports match" />} />
      </ListCard>
    </div>
  );
}
