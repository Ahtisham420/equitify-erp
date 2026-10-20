"use client";

import { Lock, Pencil, Plus, Wand2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton, Tooltip } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, titleCase } from "@/lib/utils";

import { CATEGORIES, CATEGORY_LABELS, ITEM_STATUSES, SATISFIED, useChecklist, useClosingMutation, type ChecklistItem, type Closing } from "./api";

type ItemForm = { category: string; title: string; owner_id: string | null; due_on: string; is_blocking: boolean; document_id: string; notes: string; status: string; waived_reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ItemDialog({
  closing,
  item,
  initialStatus,
  open,
  onOpenChange,
}: {
  closing: Closing;
  item: ChecklistItem | null;
  initialStatus?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { can } = useAuth();
  const [f, setF] = useState<ItemForm>({ category: "other", title: "", owner_id: null, due_on: "", is_blocking: false, document_id: "", notes: "", status: "open", waived_reason: "" });
  const save = useClosingMutation(closing.id, (body: Record<string, unknown>) =>
    item ? api.patch<ChecklistItem>(`/closings/checklist/${item.id}`, body) : api.post<ChecklistItem>(`/closings/${closing.id}/checklist`, body),
  );

  useEffect(() => {
    if (open)
      setF(
        item
          ? { category: item.category, title: item.title, owner_id: item.owner_id, due_on: item.due_on ?? "", is_blocking: item.is_blocking, document_id: item.document_id ?? "", notes: item.notes ?? "", status: initialStatus ?? item.status, waived_reason: item.waived_reason ?? "" }
          : { category: "other", title: "", owner_id: closing.coordinator_id, due_on: closing.scheduled_closing_on ?? "", is_blocking: false, document_id: "", notes: "", status: "open", waived_reason: "" },
      );
  }, [open, item, closing, initialStatus]);

  const docInvalid = !!f.document_id && !UUID_RE.test(f.document_id.trim());
  const needsReason = ["waived", "not_applicable"].includes(f.status) && f.status !== item?.status;
  const blockingLocked = !!item?.is_blocking && !can("closing", "approve");

  const submit = () => {
    const body: Record<string, unknown> = {
      category: f.category, title: f.title.trim(), owner_id: f.owner_id, due_on: f.due_on || null, is_blocking: f.is_blocking,
      document_id: f.document_id.trim() || null, notes: f.notes || null,
    };
    if (item) {
      body.status = f.status;
      body.waived_reason = f.waived_reason || null;
    }
    save.mutate(body, {
      onSuccess: () => {
        toast.success(item ? "Checklist item updated" : "Checklist item added");
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? "Edit checklist item" : "Add checklist item"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.title.trim() || docInvalid || (needsReason && !f.waived_reason.trim())} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title" required className="col-span-2"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} />
        </Field>
        <Field label="Due"><Input type="date" value={f.due_on} onChange={(e) => setF({ ...f, due_on: e.target.value })} /></Field>
        <Field label="Owner" className="col-span-2"><UserPicker value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
        {item && (
          <Field label="Status" className="col-span-2">
            <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={ITEM_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
        )}
        {item && (needsReason || f.waived_reason) && (
          <Field label="Reason for waiver / not applicable" required={needsReason} className="col-span-2" hint={item.is_blocking ? "Waiving a blocking item requires closing approval." : undefined}>
            <Textarea rows={2} value={f.waived_reason} onChange={(e) => setF({ ...f, waived_reason: e.target.value })} />
          </Field>
        )}
        <Field label="Document ID" className="col-span-2" error={docInvalid ? "Must be a document UUID" : null} hint="Link the supporting document (settlement statement, certificate…).">
          <Input value={f.document_id} onChange={(e) => setF({ ...f, document_id: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <label className={cn("col-span-2 flex items-center gap-2 text-sm text-ink-2", blockingLocked && "opacity-60")}>
          <Checkbox checked={f.is_blocking} onChange={(v) => !blockingLocked && setF({ ...f, is_blocking: v })} />
          Blocking — closing cannot complete until this is done
          {blockingLocked && <span className="text-xs text-ink-3">(approval required to remove)</span>}
        </label>
      </div>
    </Dialog>
  );
}

export function ChecklistPanel({ closing }: { closing: Closing }) {
  const { can } = useAuth();
  const { data: items, isLoading } = useChecklist(closing.id);
  const [editing, setEditing] = useState<ChecklistItem | null>(null);
  const [initialStatus, setInitialStatus] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const editable = closing.status === "open" && can("closing", "edit");
  const setStatus = useClosingMutation(closing.id, ({ id, status }: { id: string; status: string }) => api.patch<ChecklistItem>(`/closings/checklist/${id}`, { status }));
  const template = useClosingMutation(closing.id, () => api.post<{ added: number }>(`/closings/${closing.id}/checklist/apply-template`));

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const groups = CATEGORIES.map((c) => ({ c, rows: (items ?? []).filter((i) => i.category === c) })).filter((g) => g.rows.length);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Closing checklist"
        description="Blocking items are enforced on the server: the closing cannot complete while any is open."
        actions={
          editable && (
            <>
              <Button size="sm" onClick={() => template.mutate(undefined, { onSuccess: (r) => toast.success(r.added ? `${r.added} template items added` : "Template already applied"), onError: (e) => toast.error(errorMessage(e)) })}>
                <Wand2 /> Apply template
              </Button>
              <Button size="sm" onClick={() => { setEditing(null); setInitialStatus(undefined); setOpen(true); }}>
                <Plus /> Add item
              </Button>
            </>
          )
        }
      />
      {!groups.length ? (
        <EmptyState title="No checklist items" description="Apply the standard closing template to start." />
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {groups.map(({ c, rows }) => (
              <FragmentGroup key={c} label={CATEGORY_LABELS[c]} done={rows.filter((r) => SATISFIED.includes(r.status)).length} total={rows.length}>
                {rows.map((i) => {
                  const satisfied = SATISFIED.includes(i.status);
                  return (
                    <tr key={i.id} className={cn("border-b border-line", i.is_blocking && !satisfied && "bg-negative-soft/30")}>
                      <td className="w-8 px-3 py-2 align-middle">
                        {i.is_blocking ? (
                          <Tooltip content={satisfied ? "Blocking item — satisfied" : "Blocking item — must be done before closing"}>
                            <span className={cn("flex", satisfied ? "text-positive" : "text-negative")}><Lock className="size-3.5" /></span>
                          </Tooltip>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <p className={cn("text-ink", satisfied && "text-ink-3")}>{i.title}</p>
                        <p className="text-xs text-ink-3">
                          {i.owner_name ?? "Unassigned"}
                          {i.document_id && <> · <span className="font-mono">doc {i.document_id.slice(0, 8)}</span></>}
                          {i.waived_reason && <> · {i.waived_reason}</>}
                        </p>
                      </td>
                      <td className={cn("whitespace-nowrap px-3 py-2 text-xs", i.overdue ? "font-medium text-negative" : "text-ink-2")}>{formatDate(i.due_on)}</td>
                      <td className="w-40 px-3 py-2">
                        {editable ? (
                          <Select
                            value={i.status}
                            onChange={(e) => {
                              const next = e.target.value;
                              if (["waived", "not_applicable"].includes(next)) {
                                setEditing(i);
                                setInitialStatus(next);
                                setOpen(true);
                                return;
                              }
                              setStatus.mutate({ id: i.id, status: next }, { onError: (err) => toast.error(errorMessage(err)) });
                            }}
                            options={ITEM_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))}
                          />
                        ) : (
                          <StatusBadge status={i.status} />
                        )}
                      </td>
                      <td className="w-10 px-2 py-2 text-right">
                        {editable && (
                          <Button size="icon-sm" variant="ghost" aria-label="Edit item" onClick={() => { setEditing(i); setInitialStatus(undefined); setOpen(true); }}>
                            <Pencil />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </FragmentGroup>
            ))}
          </tbody>
        </table>
      )}
      <ItemDialog
        closing={closing}
        item={editing}
        initialStatus={initialStatus}
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setEditing(null);
            setInitialStatus(undefined);
          }
        }}
      />
    </Card>
  );
}

function FragmentGroup({ label, done, total, children }: { label: string; done: number; total: number; children: ReactNode }) {
  return (
    <>
      <tr className="border-b border-line bg-subtle">
        <td colSpan={5} className="px-3 py-1.5 text-xs font-medium text-ink-2">
          {label}
          <Badge tone={done === total ? "green" : "outline"} className="ml-2">{done}/{total}</Badge>
        </td>
      </tr>
      {children}
    </>
  );
}
