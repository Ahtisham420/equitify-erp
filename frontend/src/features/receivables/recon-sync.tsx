"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Calculator, GitCompare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatPercent, titleCase } from "@/lib/utils";
import type { Reconciliation } from "@/features/leases/api";

import { today, useReceivablesMutation, type SyncBatch, type SyncConflict } from "./api";

/* ------------------------------------------------------------------ reconciliation billing */

export function ReconciliationBillingTab({ propertyId }: { propertyId?: string }) {
  const { can } = useAuth();
  const [status, setStatus] = useState("final");
  const [selected, setSelected] = useState<string[]>([]);
  const [dueOn, setDueOn] = useState(today());
  const params = { property_id: propertyId, status: status === "all" ? ["final", "billed"] : [status] };
  const { data, isLoading } = useQuery({
    queryKey: ["receivables", "recon-billing", params],
    queryFn: () => api.get<Reconciliation[]>("/receivables/reconciliation-billing", params),
  });
  const bill = useReceivablesMutation<{ reconciliation_ids: string[]; due_on: string }, { billed: number; skipped: number; amount: number }>("/receivables/reconciliation-billing");
  const selectedTotal = (data ?? []).filter((r) => selected.includes(r.id)).reduce((s, r) => s + r.true_up_amount, 0);

  const columns: Column<Reconciliation>[] = [
    { id: "tenant", header: "Tenant", cell: (r) => <span className="font-medium">{r.tenant_name}</span> },
    { id: "year", header: "Year", cell: (r) => <span className="tabular">{r.year}</span> },
    { id: "share", header: "Share", align: "right", cell: (r) => formatPercent(r.share_pct, 2) },
    { id: "actual", header: "Actual share", align: "right", cell: (r) => formatCurrency(r.actual_share) },
    { id: "cap", header: "Cap savings", align: "right", cell: (r) => formatCurrency(r.cap_reduction) },
    { id: "billed", header: "Estimates billed", align: "right", cell: (r) => formatCurrency(r.estimates_billed) },
    { id: "trueup", header: "True-up", align: "right", cell: (r) => <span className={cn("font-medium", r.true_up_amount < 0 && "text-positive")}>{formatCurrency(r.true_up_amount)}</span> },
    { id: "status", header: "Status", cell: (r) => <Badge tone={r.status === "billed" ? "green" : "blue"} dot>{r.status === "final" ? "Ready to bill" : "Billed"}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setSelected([]); }} options={[{ value: "final", label: "Ready to bill" }, { value: "billed", label: "Billed" }, { value: "all", label: "All" }]} />
        {can("receivables", "create") && status !== "billed" && (
          <div className="flex items-end gap-2">
            <Field label="Due on"><Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
            <Button
              variant="primary"
              disabled={!selected.length}
              loading={bill.isPending}
              onClick={() =>
                bill.mutate(
                  { reconciliation_ids: selected, due_on: dueOn },
                  { onSuccess: (r) => { toast.success(`${r.billed} true-ups billed (${formatCurrency(r.amount)})${r.skipped ? `, ${r.skipped} skipped` : ""}`); setSelected([]); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              <Calculator /> Bill {selected.length || ""} {selected.length ? `· ${formatCurrency(selectedTotal)}` : "selected"}
            </Button>
          </div>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          dense
          selectable={can("receivables", "create") && status !== "billed"}
          selected={selected}
          onSelectedChange={(ids) => setSelected(ids.filter((id) => data?.find((r) => r.id === id)?.status === "final"))}
          empty={<EmptyState icon={<Calculator />} title="Nothing to bill" description="Finalize recovery reconciliations under Leases → Reconciliations; they appear here for billing." />}
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ accounting / banking sync */

function show(v: unknown) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return formatCurrency(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function SyncTab() {
  const { can } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exp, setExp] = useState({ system: "", period_from: "", period_to: today() });
  const [imp, setImp] = useState({ system: "", external_batch_id: "", entries: "" });
  const [conflictStatus, setConflictStatus] = useState("open");
  const batches = useQuery({ queryKey: ["receivables", "sync-batches"], queryFn: () => api.get<SyncBatch[]>("/receivables/sync/batches") });
  const conflicts = useQuery({
    queryKey: ["receivables", "sync-conflicts", conflictStatus],
    queryFn: () => api.get<Page<SyncConflict>>("/receivables/sync/conflicts", { status: conflictStatus === "all" ? undefined : conflictStatus, page_size: 200 }),
  });
  const exportM = useReceivablesMutation<typeof exp, SyncBatch>("/receivables/sync/export");
  const importM = useReceivablesMutation<Record<string, unknown>, SyncBatch>("/receivables/sync/import");
  const resolve = useReceivablesMutation<{ id: string; resolution: string; note?: string }, SyncConflict>((b) => `/receivables/sync/conflicts/${b.id}/resolve`);

  const download = (b: SyncBatch) => {
    const blob = new Blob([JSON.stringify(b.payload ?? [], null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `ledger-export-${b.system}-${b.period_from}-${b.period_to}.json`;
    a.click();
    URL.revokeObjectURL(href);
  };

  const runImport = () => {
    let entries: unknown;
    try {
      entries = JSON.parse(imp.entries);
    } catch {
      toast.error("Entries must be a JSON array");
      return;
    }
    importM.mutate(
      { system: imp.system, external_batch_id: imp.external_batch_id || null, entries },
      { onSuccess: (b) => { toast.success(b.summary ?? "Imported"); setImporting(false); }, onError: (e) => toast.error(errorMessage(e)) },
    );
  };

  const batchColumns: Column<SyncBatch>[] = [
    { id: "when", header: "When", cell: (b) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(b.created_at)}</span> },
    { id: "dir", header: "Direction", cell: (b) => <span className="flex items-center gap-1.5">{b.direction === "export" ? <ArrowUpFromLine className="size-3.5 text-ink-3" /> : <ArrowDownToLine className="size-3.5 text-ink-3" />}{titleCase(b.direction)}</span> },
    { id: "system", header: "System", cell: (b) => b.system },
    { id: "period", header: "Period", cell: (b) => (b.period_from ? `${formatDate(b.period_from)} – ${formatDate(b.period_to)}` : b.external_batch_id ?? "—") },
    { id: "entries", header: "Entries", align: "right", cell: (b) => b.entry_count },
    { id: "matched", header: "Matched", align: "right", cell: (b) => (b.direction === "import" ? b.matched_count : "—") },
    { id: "conflicts", header: "Conflicts", align: "right", cell: (b) => <span className={cn(b.conflict_count > 0 && "font-medium text-caution")}>{b.direction === "import" ? b.conflict_count : "—"}</span> },
    { id: "status", header: "Status", cell: (b) => <Badge tone={b.status === "completed" ? "green" : b.status === "completed_with_conflicts" ? "amber" : "neutral"} dot>{titleCase(b.status)}</Badge> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (b) =>
        b.direction === "export" ? (
          <Button size="xs" variant="ghost" onClick={async () => download(await api.get<SyncBatch>(`/receivables/sync/batches/${b.id}`))}>
            Download
          </Button>
        ) : null,
    },
  ];

  const conflictColumns: Column<SyncConflict>[] = [
    { id: "entity", header: "Record", cell: (c) => <span className="whitespace-nowrap">{titleCase(c.entity_type)} {c.entity_id ? c.entity_id.slice(0, 8) : "(unmatched)"}</span> },
    { id: "external", header: "External ID", cell: (c) => <span className="font-mono text-xs">{c.external_id}</span> },
    { id: "field", header: "Field", cell: (c) => titleCase(c.field) },
    { id: "local", header: "Ours", cell: (c) => <span className="block max-w-[200px] truncate tabular">{show(c.local_value)}</span> },
    { id: "theirs", header: "External", cell: (c) => <span className="block max-w-[200px] truncate font-medium tabular">{show(c.external_value)}</span> },
    { id: "status", header: "Status", cell: (c) => <Badge tone={c.status === "open" ? "amber" : "neutral"} dot>{titleCase(c.status)}</Badge> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) =>
        c.status === "open" && can("receivables", "approve") ? (
          <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button size="xs" onClick={() => resolve.mutate({ id: c.id, resolution: "keep_local" }, { onSuccess: () => toast.success("Kept our value"), onError: (e) => toast.error(errorMessage(e)) })}>Keep ours</Button>
            {c.field !== "unmatched" && (
              <Button size="xs" onClick={() => resolve.mutate({ id: c.id, resolution: "accept_external" }, { onSuccess: () => toast.success("External value accepted and audited"), onError: (e) => toast.error(errorMessage(e)) })}>Accept external</Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => resolve.mutate({ id: c.id, resolution: "dismissed" }, { onError: (e) => toast.error(errorMessage(e)) })}>Dismiss</Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-2">
          Exchange ledger entries with accounting or banking. Imported entries are matched to our charges and payments; any disagreement is held as a conflict for review and is never applied automatically.
        </p>
        <div className="flex gap-2">
          {can("receivables", "edit") && <Button onClick={() => setImporting(true)}><ArrowDownToLine /> Import</Button>}
          {can("receivables", "export") && <Button variant="primary" onClick={() => setExporting(true)}><ArrowUpFromLine /> Export ledger</Button>}
        </div>
      </div>
      <Card className="overflow-hidden">
        <CardHeader
          title="Conflicts"
          description="External data that disagrees with ours"
          actions={<Select className="w-32" value={conflictStatus} onChange={(e) => setConflictStatus(e.target.value)} options={["open", "accepted_external", "keep_local", "dismissed", "all"].map((s) => ({ value: s, label: titleCase(s) }))} />}
        />
        <DataTable columns={conflictColumns} data={conflicts.data?.items} loading={conflicts.isLoading} dense empty={<EmptyState icon={<GitCompare />} title="No conflicts" />} />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Sync batches" />
        <DataTable columns={batchColumns} data={batches.data} loading={batches.isLoading} dense empty={<EmptyState title="No sync batches yet" />} />
      </Card>

      <Dialog
        open={exporting}
        onOpenChange={setExporting}
        title="Export ledger entries"
        footer={
          <>
            <Button onClick={() => setExporting(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={exportM.isPending}
              disabled={!exp.system.trim() || !exp.period_from || !exp.period_to}
              onClick={() => exportM.mutate(exp, { onSuccess: (b) => { toast.success(`${b.entry_count} entries exported`); download(b); setExporting(false); }, onError: (e) => toast.error(errorMessage(e)) })}
            >
              Export
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target system" className="col-span-2"><Input value={exp.system} onChange={(e) => setExp((x) => ({ ...x, system: e.target.value }))} placeholder="e.g. General ledger" /></Field>
          <Field label="From"><Input type="date" value={exp.period_from} onChange={(e) => setExp((x) => ({ ...x, period_from: e.target.value }))} /></Field>
          <Field label="To"><Input type="date" value={exp.period_to} onChange={(e) => setExp((x) => ({ ...x, period_to: e.target.value }))} /></Field>
        </div>
      </Dialog>

      <Dialog
        open={importing}
        onOpenChange={setImporting}
        title="Import external entries"
        description='JSON array of {"external_id", "kind": "charge" | "payment", "local_id"?, "amount"?, "entry_date"?, "status"?, "reference"?}.'
        className="max-w-xl"
        footer={
          <>
            <Button onClick={() => setImporting(false)}>Cancel</Button>
            <Button variant="primary" loading={importM.isPending} disabled={!imp.system.trim() || !imp.entries.trim()} onClick={runImport}>Import</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source system"><Input value={imp.system} onChange={(e) => setImp((x) => ({ ...x, system: e.target.value }))} /></Field>
          <Field label="External batch ID"><Input value={imp.external_batch_id} onChange={(e) => setImp((x) => ({ ...x, external_batch_id: e.target.value }))} /></Field>
          <Field label="Entries (JSON)" className="col-span-2"><Textarea rows={10} className="font-mono text-xs" value={imp.entries} onChange={(e) => setImp((x) => ({ ...x, entries: e.target.value }))} /></Field>
        </div>
      </Dialog>
    </div>
  );
}
