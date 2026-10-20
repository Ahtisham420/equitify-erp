"use client";

import { FileText, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker, UserPicker } from "@/components/data/entity-picker";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";

import { OrganizationPicker } from "@/features/contacts/pickers";

import { REPORT_STATUS_TONES, REPORT_STATUSES, REPORT_TYPE_LABELS, REPORT_TYPES, SEVERITIES, useDeleteReport, useReports, useSaveReport, type Contract, type Report } from "./api";

const columns: Column<Report>[] = [
  {
    id: "type",
    header: "Report",
    cell: (r) => (
      <div className="min-w-[160px]">
        <p className="font-medium text-ink">{REPORT_TYPE_LABELS[r.report_type] ?? titleCase(r.report_type)}</p>
        <p className="truncate text-xs text-ink-3">{r.vendor_label ?? "No vendor yet"}</p>
      </div>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (r) => (
      <div className="flex items-center gap-1.5">
        <Badge tone={REPORT_STATUS_TONES[r.status] ?? "neutral"} dot>
          {titleCase(r.status)}
        </Badge>
        {r.is_late && <Badge tone="red">Late</Badge>}
      </div>
    ),
  },
  { id: "ordered", header: "Ordered", cell: (r) => <span className="whitespace-nowrap text-ink-2 tabular">{formatDate(r.ordered_on)}</span> },
  { id: "expected", header: "Expected", cell: (r) => <span className={cn("whitespace-nowrap tabular", r.is_late ? "font-medium text-negative" : "text-ink-2")}>{formatDate(r.expected_on)}</span> },
  { id: "delivered", header: "Delivered", cell: (r) => <span className="whitespace-nowrap text-ink-2 tabular">{formatDate(r.delivered_on)}</span> },
  { id: "severity", header: "Severity", cell: (r) => <StatusBadge status={r.severity} /> },
  { id: "findings", header: "Findings", cell: (r) => <p className="line-clamp-2 max-w-[320px] text-xs text-ink-2">{r.findings ?? "—"}</p> },
  { id: "cost", header: "Cost", align: "right", cell: (r) => formatCurrency(r.cost) },
  { id: "document", header: "Document", cell: (r) => (r.document_id ? <Badge tone="outline">Linked</Badge> : <span className="text-ink-3">—</span>) },
];

interface DocumentLite { id: string; title: string | null; filename: string | null }

function ReportSheet({ open, onOpenChange, contractId, report }: { open: boolean; onOpenChange: (o: boolean) => void; contractId: string; report: Report | null }) {
  const save = useSaveReport(contractId);
  const remove = useDeleteReport();
  const [v, setV] = useState<Record<string, unknown>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setV(
      report
        ? { ...report, cost: report.cost ?? "", findings: report.findings ?? "", notes: report.notes ?? "", vendor_name: report.vendor_name ?? "" }
        : { report_type: "phase_i", status: "not_ordered", cost: "", findings: "", notes: "", vendor_name: "" },
    );
  }, [open, report]);

  const set = (k: string, value: unknown) => setV((s) => ({ ...s, [k]: value }));
  const str = (k: string) => (v[k] as string | null | undefined) ?? "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data = {
      report_type: v.report_type,
      vendor_organization_id: v.vendor_organization_id ?? null,
      vendor_name: str("vendor_name").trim() || null,
      status: v.status,
      ordered_on: v.ordered_on || null,
      expected_on: v.expected_on || null,
      delivered_on: v.delivered_on || null,
      cost: toNumber(String(v.cost ?? "")),
      findings: str("findings").trim() || null,
      severity: v.severity || null,
      document_id: v.document_id ?? null,
      owner_id: v.owner_id ?? null,
      notes: str("notes").trim() || null,
    };
    save.mutate(
      { id: report?.id, data },
      {
        onSuccess: () => {
          toast.success(report ? "Report updated" : "Report added");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={report ? `${REPORT_TYPE_LABELS[report.report_type] ?? "Report"}` : "Order a third-party report"}
      description="Track the vendor, ordered, expected and actual delivery, and the findings."
      footer={
        <>
          {report && (
            <Button variant="ghost" className="mr-auto text-negative" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Remove
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="report-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="report-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Report type">
          <Select value={str("report_type")} onChange={(e) => set("report_type", e.target.value)} options={REPORT_TYPES.map((t) => ({ value: t, label: REPORT_TYPE_LABELS[t] }))} />
        </Field>
        <Field label="Status">
          <Select value={str("status")} onChange={(e) => set("status", e.target.value)} options={REPORT_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Vendor" className="col-span-2">
          <OrganizationPicker value={v.vendor_organization_id as string | null} onChange={(id) => set("vendor_organization_id", id)} placeholder="Select vendor organization" />
        </Field>
        <Field label="Vendor contact / name" className="col-span-2">
          <Input value={str("vendor_name")} onChange={(e) => set("vendor_name", e.target.value)} />
        </Field>
        <Field label="Ordered">
          <Input type="date" value={str("ordered_on")} onChange={(e) => set("ordered_on", e.target.value)} />
        </Field>
        <Field label="Expected delivery">
          <Input type="date" value={str("expected_on")} onChange={(e) => set("expected_on", e.target.value)} />
        </Field>
        <Field label="Delivered">
          <Input type="date" value={str("delivered_on")} onChange={(e) => set("delivered_on", e.target.value)} />
        </Field>
        <Field label="Cost">
          <Input inputMode="decimal" value={String(v.cost ?? "")} onChange={(e) => set("cost", e.target.value)} />
        </Field>
        <Field label="Severity of findings">
          <Select value={str("severity")} onChange={(e) => set("severity", e.target.value)} placeholder="Not assessed" options={SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Owner">
          <UserPicker value={v.owner_id as string | null} onChange={(id) => set("owner_id", id)} />
        </Field>
        <Field label="Report document" className="col-span-2">
          <EntityPickerDocument value={v.document_id as string | null} onChange={(id) => set("document_id", id)} />
        </Field>
        <Field label="Findings" className="col-span-2">
          <Textarea rows={4} value={str("findings")} onChange={(e) => set("findings", e.target.value)} />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea value={str("notes")} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Remove this report?"
        description="It is archived and kept in the audit trail."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          report &&
          remove.mutate(report.id, {
            onSuccess: () => {
              setConfirmDelete(false);
              onOpenChange(false);
              toast.success("Report removed");
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </Sheet>
  );
}

/** Document link (documents module); stores only the id. */
export function EntityPickerDocument({ value, onChange }: { value: string | null | undefined; onChange: (id: string | null) => void }) {
  return (
    <EntityPicker<DocumentLite>
      endpoint="/documents"
      value={value}
      onChange={(id) => onChange(id)}
      placeholder="Link a document"
      toOption={(d) => ({ id: d.id, label: d.title || d.filename || "Document" })}
    />
  );
}

export function ReportsTab({ contract }: { contract: Contract }) {
  const { can } = useAuth();
  const { data, isLoading } = useReports(contract.id);
  const [editing, setEditing] = useState<Report | null>(null);
  const [creating, setCreating] = useState(false);
  const editable = can("contracts", "edit");
  const late = (data ?? []).filter((r) => r.is_late).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          Survey, environmental, PCA, zoning, appraisal, title and lease audit orders.
          {late > 0 && <span className="ml-1 font-medium text-negative">{late} late.</span>}
        </p>
        {editable && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Add report
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          dense
          onRowClick={editable ? (r) => setEditing(r) : undefined}
          rowClassName={(r) => (r.is_late ? "bg-negative-soft/30" : undefined)}
          empty={<EmptyState icon={<FileText />} title="No third-party reports" description="Reports are placed on the checklist by the DD template, or add one here." />}
        />
      </Card>
      <ReportSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} contractId={contract.id} report={editing} />
    </div>
  );
}
