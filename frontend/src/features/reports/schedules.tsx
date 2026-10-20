"use client";

import { Download, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter } from "@/components/data/filters";
import { EmptyState } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, titleCase } from "@/lib/utils";

import {
  downloadRun,
  useCatalog,
  useCreateSchedule,
  useDeleteSchedule,
  useFilterOptions,
  useRunDue,
  useRuns,
  useSchedules,
  useUpdateSchedule,
  type Cadence,
  type ReportRun,
  type Schedule,
} from "./api";

const CADENCES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

function describeFilters(filters: Record<string, string[]>): string {
  const parts = Object.entries(filters).map(([k, v]) => (k === "days" ? `last ${v[0]} days` : `${titleCase(k)}: ${v.join(", ")}`));
  return parts.length ? parts.join(" · ") : "No filters";
}

/** Create or edit a scheduled report. `initial` pre-fills dashboard and filters from the current view. */
export function ScheduleSheet({
  open,
  onOpenChange,
  schedule,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: Schedule | null;
  initial?: { dashboard_key: string; filters: Record<string, string[]>; name?: string };
}) {
  const { user } = useAuth();
  const { data: catalog } = useCatalog();
  const { data: opts } = useFilterOptions();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const [name, setName] = useState("");
  const [dashboard, setDashboard] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const filters = schedule?.filters ?? initial?.filters ?? {};

  useEffect(() => {
    if (!open) return;
    setName(schedule?.name ?? initial?.name ?? "");
    setDashboard(schedule?.dashboard_key ?? initial?.dashboard_key ?? catalog?.dashboards[0]?.key ?? "");
    setCadence(schedule?.cadence ?? "weekly");
    setRecipients(schedule?.recipient_ids ?? (user ? [user.id] : []));
    setNotes(schedule?.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule]);

  const saving = create.isPending || update.isPending;
  const submit = async () => {
    if (!name.trim() || !dashboard) return toast.error("Name and dashboard are required");
    try {
      if (schedule) {
        await update.mutateAsync({ id: schedule.id, name: name.trim(), cadence, recipient_ids: recipients, notes: notes || null });
        toast.success("Schedule updated");
      } else {
        await create.mutateAsync({ name: name.trim(), dashboard_key: dashboard, filters, cadence, recipient_ids: recipients, notes: notes || null });
        toast.success("Report scheduled");
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const userOptions = (opts?.users ?? []).filter((u) => u.value !== "me");

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={schedule ? "Edit scheduled report" : "Schedule report"}
      description="Each recipient receives a CSV computed with their own permissions."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            {schedule ? "Save" : "Schedule"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly acquisitions summary" />
        </Field>
        <Field label="Dashboard" required>
          <Select
            value={dashboard}
            disabled={!!schedule}
            onChange={(e) => setDashboard(e.target.value)}
            options={(catalog?.dashboards ?? []).map((d) => ({ value: d.key, label: d.label }))}
          />
        </Field>
        <Field label="Filters" hint="Taken from the dashboard view when the schedule was created">
          <p className="rounded-md border border-line bg-subtle px-2.5 py-1.5 text-sm text-ink-2">{describeFilters(filters)}</p>
        </Field>
        <Field label="Cadence">
          <Select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} options={CADENCES} />
        </Field>
        <Field label="Recipients" hint="Defaults to you">
          <div className="flex flex-wrap items-center gap-2">
            <FacetFilter label="Recipients" options={userOptions} selected={recipients} onChange={setRecipients} searchable />
            <span className="text-xs text-ink-3">{recipients.length} selected</span>
          </div>
        </Field>
        <Field label="Format">
          <p className="text-sm text-ink-2">CSV</p>
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}

export function SchedulesPanel() {
  const { can } = useAuth();
  const schedules = useSchedules();
  const runs = useRuns();
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const runDue = useRunDue();
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  const toggle = async (s: Schedule) => {
    try {
      await update.mutateAsync({ id: s.id, is_active: !s.is_active });
      toast.success(s.is_active ? "Schedule paused" : "Schedule resumed");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<Schedule>[] = [
    { id: "name", header: "Name", cell: (s) => <span className="font-medium">{s.name}</span> },
    { id: "dashboard", header: "Dashboard", cell: (s) => s.dashboard_label ?? s.dashboard_key },
    { id: "cadence", header: "Cadence", cell: (s) => titleCase(s.cadence) },
    { id: "filters", header: "Filters", cell: (s) => <span className="text-ink-2">{describeFilters(s.filters)}</span> },
    { id: "recipients", header: "Recipients", cell: (s) => <span className="text-ink-2">{s.recipient_names.join(", ") || "—"}</span> },
    { id: "status", header: "Status", cell: (s) => <StatusBadge status={s.is_active ? "active" : "inactive"} label={s.is_active ? "Active" : "Paused"} /> },
    { id: "next", header: "Next run", cell: (s) => (s.is_active ? formatDateTime(s.next_run_at) : "—") },
    { id: "last", header: "Last run", cell: (s) => formatDateTime(s.last_run_at) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (s) => (
        <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
          {can("reports", "edit") && (
            <>
              <Button size="icon-sm" variant="ghost" aria-label={s.is_active ? "Pause" : "Resume"} onClick={() => toggle(s)}>
                {s.is_active ? <Pause /> : <Play />}
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(s)}>
                <Pencil />
              </Button>
            </>
          )}
          {can("reports", "delete") && (
            <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(s)}>
              <Trash2 />
            </Button>
          )}
        </span>
      ),
    },
  ];

  const runColumns: Column<ReportRun>[] = [
    { id: "ran", header: "Ran", cell: (r) => formatDateTime(r.ran_at) },
    { id: "dashboard", header: "Dashboard", cell: (r) => titleCase(r.dashboard_key) },
    { id: "recipient", header: "Recipient", cell: (r) => r.recipient_name ?? "—" },
    { id: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
    { id: "rows", header: "Rows", align: "right", cell: (r) => formatNumber(r.row_count) },
    { id: "withheld", header: "Withheld", align: "right", cell: (r) => (r.withheld_rows ? formatNumber(r.withheld_rows) : "—") },
    { id: "error", header: "Note", cell: (r) => <span className="text-ink-3">{r.error ?? ""}</span> },
    {
      id: "download",
      header: "",
      align: "right",
      cell: (r) =>
        r.status === "success" ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              downloadRun(r).catch((err) => toast.error(errorMessage(err)));
            }}
          >
            <Download />
            CSV
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Scheduled reports"
          description="Dashboards delivered as CSV on a cadence to the selected recipients"
          actions={
            <>
              {can("reports", "approve") && (
                <Button
                  size="sm"
                  loading={runDue.isPending}
                  onClick={async () => {
                    try {
                      const r = await runDue.mutateAsync();
                      toast.success(`${r.schedules} schedules due · ${r.runs} files generated${r.failed ? ` · ${r.failed} failed` : ""}`);
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Run due now
                </Button>
              )}
              {can("reports", "create") && (
                <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                  <Plus />
                  New schedule
                </Button>
              )}
            </>
          }
        />
        <DataTable
          columns={columns}
          data={schedules.data}
          loading={schedules.isLoading}
          dense
          empty={<EmptyState title="No scheduled reports" description="Open a dashboard and choose Schedule to deliver it on a cadence." />}
        />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Delivered reports" description="Files generated for you (administrators see all runs)" />
        <DataTable columns={runColumns} data={runs.data} loading={runs.isLoading} dense empty={<EmptyState title="No report files yet" />} />
      </Card>
      <ScheduleSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} schedule={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete scheduled report?"
        description="No further files will be generated. Files already delivered stay available."
        destructive
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success("Schedule deleted");
            setDeleting(null);
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </div>
  );
}
