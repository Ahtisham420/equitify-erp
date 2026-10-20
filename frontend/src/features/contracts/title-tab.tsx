"use client";

import { Landmark, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, isOverdue, titleCase } from "@/lib/utils";

import { OrganizationPicker, PersonPicker } from "@/features/contacts/pickers";

import {
  EXCEPTION_KINDS,
  EXCEPTION_SOURCES,
  EXCEPTION_STATUS_TONES,
  EXCEPTION_STATUSES,
  SEVERITIES,
  useDeleteTitleException,
  useSaveTitleException,
  useTitleExceptions,
  type Contract,
  type TitleException,
} from "./api";
import { EntityPickerDocument } from "./reports-tab";

const OPEN = ["open", "objected", "cure_pending", "uncured"];

const columns: Column<TitleException>[] = [
  { id: "ref", header: "Ref", cell: (x) => <span className="whitespace-nowrap text-ink-2">{x.schedule_ref ?? "—"}</span> },
  {
    id: "matter",
    header: "Matter",
    cell: (x) => (
      <div className="min-w-[240px] max-w-[420px]">
        <p className="line-clamp-2 text-ink">{x.description}</p>
        <p className="text-xs text-ink-3">
          {titleCase(x.kind)} · {titleCase(x.source)}
          {x.recording_ref ? ` · ${x.recording_ref}` : ""}
        </p>
      </div>
    ),
  },
  { id: "severity", header: "Severity", cell: (x) => <StatusBadge status={x.severity} /> },
  {
    id: "status",
    header: "Objection / cure",
    cell: (x) => (
      <Badge tone={EXCEPTION_STATUS_TONES[x.status] ?? "neutral"} dot>
        {titleCase(x.status)}
      </Badge>
    ),
  },
  { id: "objected", header: "Objection sent", cell: (x) => <span className="whitespace-nowrap text-ink-2 tabular">{formatDate(x.objection_sent_on)}</span> },
  {
    id: "cure",
    header: "Cure due",
    cell: (x) => (
      <span className={cn("whitespace-nowrap tabular", OPEN.includes(x.status) && isOverdue(x.cure_due_on) ? "font-medium text-negative" : "text-ink-2")}>{formatDate(x.cure_due_on)}</span>
    ),
  },
  { id: "attorney", header: "Attorney", cell: (x) => <span className="text-ink-2">{x.attorney_label ?? "—"}</span> },
];

function ExceptionSheet({ open, onOpenChange, contract, item }: { open: boolean; onOpenChange: (o: boolean) => void; contract: Contract; item: TitleException | null }) {
  const save = useSaveTitleException(contract.id);
  const remove = useDeleteTitleException();
  const [v, setV] = useState<Record<string, unknown>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setV(
      item
        ? { ...item }
        : {
            kind: "title_exception", source: "title_commitment", status: "open", description: "",
            attorney_person_id: contract.attorney_person_id, attorney_organization_id: contract.attorney_organization_id,
          },
    );
  }, [open, item, contract]);

  const set = (k: string, value: unknown) => setV((s) => ({ ...s, [k]: value }));
  const str = (k: string) => (v[k] as string | null | undefined) ?? "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data = {
      kind: v.kind, source: v.source, status: v.status, description: str("description").trim(),
      schedule_ref: str("schedule_ref").trim() || null, recording_ref: str("recording_ref").trim() || null,
      severity: v.severity || null, objection_sent_on: v.objection_sent_on || null, cure_due_on: v.cure_due_on || null,
      cure_response: str("cure_response").trim() || null, resolved_on: v.resolved_on || null,
      attorney_person_id: v.attorney_person_id ?? null, attorney_organization_id: v.attorney_organization_id ?? null,
      document_id: v.document_id ?? null, notes: str("notes").trim() || null,
    };
    save.mutate(
      { id: item?.id, data },
      {
        onSuccess: () => {
          toast.success(item ? "Matter updated" : "Matter added");
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
      title={item ? "Title / survey matter" : "New title or survey matter"}
      description="Exceptions, easements and encroachments with objection and cure status."
      footer={
        <>
          {item && (
            <Button variant="ghost" className="mr-auto text-negative" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Remove
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="exception-form" loading={save.isPending} disabled={!str("description").trim()}>
            Save
          </Button>
        </>
      }
    >
      <form id="exception-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Kind">
          <Select value={str("kind")} onChange={(e) => set("kind", e.target.value)} options={EXCEPTION_KINDS.map((k) => ({ value: k, label: titleCase(k) }))} />
        </Field>
        <Field label="Found in">
          <Select value={str("source")} onChange={(e) => set("source", e.target.value)} options={EXCEPTION_SOURCES.map((k) => ({ value: k, label: titleCase(k) }))} />
        </Field>
        <Field label="Schedule reference" hint="e.g. Schedule B-II, item 7">
          <Input value={str("schedule_ref")} onChange={(e) => set("schedule_ref", e.target.value)} />
        </Field>
        <Field label="Recording reference">
          <Input value={str("recording_ref")} onChange={(e) => set("recording_ref", e.target.value)} />
        </Field>
        <Field label="Description" required className="col-span-2">
          <Textarea value={str("description")} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <Field label="Severity">
          <Select value={str("severity")} onChange={(e) => set("severity", e.target.value)} placeholder="Not assessed" options={SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Objection / cure status">
          <Select value={str("status")} onChange={(e) => set("status", e.target.value)} options={EXCEPTION_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Objection sent">
          <Input type="date" value={str("objection_sent_on")} onChange={(e) => set("objection_sent_on", e.target.value)} />
        </Field>
        <Field label="Cure due">
          <Input type="date" value={str("cure_due_on")} onChange={(e) => set("cure_due_on", e.target.value)} />
        </Field>
        <Field label="Seller cure response" className="col-span-2">
          <Textarea value={str("cure_response")} onChange={(e) => set("cure_response", e.target.value)} />
        </Field>
        <Field label="Attorney">
          <PersonPicker value={v.attorney_person_id as string | null} onChange={(id) => set("attorney_person_id", id)} />
        </Field>
        <Field label="Law firm">
          <OrganizationPicker value={v.attorney_organization_id as string | null} onChange={(id) => set("attorney_organization_id", id)} />
        </Field>
        <Field label="Supporting document" className="col-span-2">
          <EntityPickerDocument value={v.document_id as string | null} onChange={(id) => set("document_id", id)} />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea value={str("notes")} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Remove this matter?"
        description="It is archived and kept in the audit trail."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          item &&
          remove.mutate(item.id, {
            onSuccess: () => {
              setConfirmDelete(false);
              onOpenChange(false);
              toast.success("Matter removed");
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </Sheet>
  );
}

export function TitleSurveyTab({ contract }: { contract: Contract }) {
  const { can } = useAuth();
  const { data, isLoading } = useTitleExceptions(contract.id);
  const [editing, setEditing] = useState<TitleException | null>(null);
  const [creating, setCreating] = useState(false);
  const editable = can("contracts", "edit");
  const rows = data ?? [];
  const open = rows.filter((x) => OPEN.includes(x.status)).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          {rows.length ? `${open} of ${rows.length} matters unresolved.` : "Title commitment exceptions and survey matters."}
        </p>
        {editable && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Add matter
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          dense
          onRowClick={editable ? (x) => setEditing(x) : undefined}
          rowClassName={(x) => (x.status === "uncured" ? "bg-negative-soft/30" : !OPEN.includes(x.status) ? "opacity-70" : undefined)}
          empty={<EmptyState icon={<Landmark />} title="No title or survey matters" description="Record Schedule B exceptions, easements and encroachments as you review the commitment and survey." />}
        />
      </Card>
      <ExceptionSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} contract={contract} item={editing} />
    </div>
  );
}
