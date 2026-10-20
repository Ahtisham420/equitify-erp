"use client";

import { AlertTriangle, ClipboardList, Flag, Lock, MoreHorizontal, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Checkbox, Progress, Skeleton, Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";

import {
  DD_CATEGORY_LABELS,
  DD_STATUS_TONES,
  DD_STATUSES,
  RISK_CATEGORIES,
  SEVERITIES,
  useApplyTemplate,
  useDDItems,
  useDeleteDDItem,
  useEscalateDDItem,
  useSaveDDItem,
  useSaveRisk,
  useTemplates,
  type Contract,
  type DDItem,
} from "./api";

const CATEGORY_ORDER = ["title", "survey", "environmental", "physical", "zoning", "tenancy", "financial", "legal", "general"];

export function DDStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={DD_STATUS_TONES[status] ?? "neutral"} dot>
      {titleCase(status)}
    </Badge>
  );
}

function DDItemSheet({ open, onOpenChange, contractId, item, items }: { open: boolean; onOpenChange: (o: boolean) => void; contractId: string; item: DDItem | null; items: DDItem[] }) {
  const save = useSaveDDItem(contractId);
  const [v, setV] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!open) return;
    setV(
      item
        ? {
            title: item.title, category: item.category, description: item.description ?? "", owner_id: item.owner_id, status: item.status,
            due_on: item.due_on ?? "", depends_on: item.depends_on, source: item.source, findings: item.findings ?? "",
            severity: item.severity ?? "", cost_impact: item.cost_impact ?? "", resolution: item.resolution ?? "",
          }
        : { title: "", category: "general", status: "not_started", depends_on: [], source: "manual", severity: "", cost_impact: "", due_on: "" },
    );
  }, [open, item]);

  const set = (k: string, value: unknown) => setV((s) => ({ ...s, [k]: value }));
  const deps = (v.depends_on as string[]) ?? [];
  const candidates = items.filter((i) => i.id !== item?.id);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data = {
      ...v,
      description: (v.description as string)?.trim() || null,
      findings: (v.findings as string)?.trim() || null,
      resolution: (v.resolution as string)?.trim() || null,
      severity: v.severity || null,
      due_on: v.due_on || null,
      cost_impact: typeof v.cost_impact === "string" ? toNumber(v.cost_impact) : v.cost_impact,
    };
    save.mutate(
      { id: item?.id, data },
      {
        onSuccess: () => {
          toast.success(item ? "DD item updated" : "DD item added");
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
      title={item ? "Edit DD item" : "New DD item"}
      description="An item cannot be completed while an item it depends on is still open."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="dd-item-form" loading={save.isPending} disabled={!(v.title as string)?.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form id="dd-item-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Title" required className="col-span-2">
          <Input value={(v.title as string) ?? ""} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Category">
          <Select value={(v.category as string) ?? "general"} onChange={(e) => set("category", e.target.value)} options={CATEGORY_ORDER.map((c) => ({ value: c, label: DD_CATEGORY_LABELS[c] }))} />
        </Field>
        <Field label="Status">
          <Select value={(v.status as string) ?? "not_started"} onChange={(e) => set("status", e.target.value)} options={DD_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Owner">
          <UserPicker value={v.owner_id as string | null} onChange={(id) => set("owner_id", id)} />
        </Field>
        <Field label="Due date">
          <Input type="date" value={(v.due_on as string) ?? ""} onChange={(e) => set("due_on", e.target.value)} />
        </Field>
        <Field label="Severity">
          <Select value={(v.severity as string) ?? ""} onChange={(e) => set("severity", e.target.value)} placeholder="Not assessed" options={SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Cost impact">
          <Input inputMode="decimal" value={String(v.cost_impact ?? "")} onChange={(e) => set("cost_impact", e.target.value)} />
        </Field>
        <Field label="Source" className="col-span-2">
          <Select
            value={(v.source as string) ?? "manual"}
            onChange={(e) => set("source", e.target.value)}
            options={["manual", "template", "third_party_report", "title", "estoppel", "ai"].map((s) => ({ value: s, label: titleCase(s) }))}
          />
        </Field>
        <Field label="Description" className="col-span-2">
          <Textarea value={(v.description as string) ?? ""} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <Field label="Findings" className="col-span-2">
          <Textarea value={(v.findings as string) ?? ""} onChange={(e) => set("findings", e.target.value)} />
        </Field>
        <Field label="Resolution" className="col-span-2">
          <Textarea value={(v.resolution as string) ?? ""} onChange={(e) => set("resolution", e.target.value)} />
        </Field>
        <Field label="Depends on" className="col-span-2" hint="This item stays locked until these are complete or waived.">
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-2 scrollbar-thin">
            {candidates.length === 0 && <p className="text-xs text-ink-3">No other items on this contract.</p>}
            {candidates.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={deps.includes(c.id)} onChange={(on) => set("depends_on", on ? [...deps, c.id] : deps.filter((x) => x !== c.id))} label={c.title} />
                <span className="flex-1 truncate">{c.title}</span>
                <DDStatusBadge status={c.status} />
              </label>
            ))}
          </div>
        </Field>
      </form>
    </Sheet>
  );
}

export function DDTab({ contract }: { contract: Contract }) {
  const { can } = useAuth();
  const { data, isLoading } = useDDItems(contract.id);
  const { data: templates } = useTemplates();
  const apply = useApplyTemplate(contract.id);
  const save = useSaveDDItem(contract.id);
  const remove = useDeleteDDItem();
  const escalate = useEscalateDDItem();
  const saveRisk = useSaveRisk(contract.id);
  const [template, setTemplate] = useState("");
  const [editing, setEditing] = useState<DDItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [escalating, setEscalating] = useState<DDItem | null>(null);
  const [escalateNote, setEscalateNote] = useState("");
  const [deleting, setDeleting] = useState<DDItem | null>(null);
  const editable = can("contracts", "edit") && !["closed", "terminated"].includes(contract.status);

  const items = useMemo(() => data ?? [], [data]);
  const groups = useMemo(() => {
    const by = new Map<string, DDItem[]>();
    for (const i of items) by.set(i.category, [...(by.get(i.category) ?? []), i]);
    const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length);
    return Array.from(by.entries()).sort(([a], [b]) => rank(a) - rank(b));
  }, [items]);
  const done = items.filter((i) => i.status === "complete" || i.status === "waived").length;
  const openHigh = items.filter((i) => !["complete", "waived"].includes(i.status) && (i.severity === "high" || i.severity === "critical"));
  const overdue = items.filter((i) => i.is_overdue);

  const setStatus = (i: DDItem, status: string) =>
    save.mutate({ id: i.id, data: { status } }, { onSuccess: () => toast.success(`${i.title}: ${titleCase(status)}`), onError: (e) => toast.error(errorMessage(e)) });

  const toRisk = (i: DDItem) =>
    saveRisk.mutate(
      {
        data: {
          title: i.title,
          description: i.findings,
          category: (RISK_CATEGORIES as readonly string[]).includes(i.category) ? i.category : "other",
          severity: i.severity ?? "medium",
          source_type: "dd_item",
          source_id: i.id,
          cost_impact: i.cost_impact,
          owner_id: i.owner_id,
        },
      },
      { onSuccess: () => toast.success("Added to the risk register"), onError: (e) => toast.error(errorMessage(e)) },
    );

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-[260px] items-center gap-3">
          <Progress value={items.length ? (done / items.length) * 100 : 0} className="w-40" tone="accent" />
          <span className="text-sm text-ink-2 tabular">
            {done} of {items.length} complete
          </span>
          {openHigh.length > 0 && <Badge tone="red">{openHigh.length} open high-severity</Badge>}
          {overdue.length > 0 && <Badge tone="amber">{overdue.length} overdue</Badge>}
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Template for property type"
              options={(templates ?? []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: `${t.name} (v${t.version})` }))}
              className="w-60"
            />
            <Button
              size="sm"
              loading={apply.isPending}
              onClick={() =>
                apply.mutate(template || null, {
                  onSuccess: (r) => toast.success(r.length ? `${r.length} items added from template` : "Checklist already has every template item"),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              <ClipboardList /> Apply template
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> Add item
            </Button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList />}
            title="No diligence items"
            description="The checklist is created from the property-type template when the contract is executed, or apply a template now."
          />
        </Card>
      ) : (
        groups.map(([category, rows]) => {
          const groupDone = rows.filter((i) => i.status === "complete" || i.status === "waived").length;
          return (
            <Card key={category} className="overflow-hidden">
              <CardHeader title={DD_CATEGORY_LABELS[category] ?? titleCase(category)} description={`${groupDone} of ${rows.length} complete`} />
              <ul className="divide-y divide-line">
                {rows.map((i) => {
                  const locked = i.blocked_by.length > 0;
                  const isDone = i.status === "complete" || i.status === "waived";
                  return (
                    <li key={i.id} className={cn("grid grid-cols-1 gap-2 px-4 py-2.5 md:grid-cols-[150px_minmax(0,1fr)_170px_auto] md:items-center", isDone && "opacity-70", i.is_overdue && "bg-negative-soft/30")}>
                      <div onClick={(e) => e.stopPropagation()}>
                        {editable ? (
                          <select
                            value={i.status}
                            onChange={(e) => setStatus(i, e.target.value)}
                            aria-label="Status"
                            className="h-7 w-full rounded-md border border-line-strong/80 bg-surface px-1.5 text-xs text-ink focus:outline-none"
                          >
                            {DD_STATUSES.map((s) => (
                              <option key={s} value={s} disabled={s === "complete" && locked}>
                                {titleCase(s)}
                                {s === "complete" && locked ? " (locked)" : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <DDStatusBadge status={i.status} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <button type="button" className={cn("text-left text-sm font-medium text-ink hover:underline", isDone && "line-through decoration-ink-3/50")} onClick={() => editable && setEditing(i)}>
                          {i.title}
                        </button>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                          {i.severity && <StatusBadge status={i.severity} />}
                          {locked && (
                            <Tooltip content={i.blocked_by.map((b) => `${b.title} (${titleCase(b.status)})`).join(", ")}>
                              <span className="flex items-center gap-1 text-caution">
                                <Lock className="size-3" /> Waiting on {i.blocked_by.length === 1 ? i.blocked_by[0].title : `${i.blocked_by.length} items`}
                              </span>
                            </Tooltip>
                          )}
                          {i.escalation_level > 0 && (
                            <span className="flex items-center gap-1 text-negative">
                              <Flag className="size-3" /> Escalated{i.escalation_level > 1 ? ` ×${i.escalation_level}` : ""}
                            </span>
                          )}
                          {i.cost_impact != null && <span className="tabular">Cost impact {formatCurrency(i.cost_impact)}</span>}
                          {i.source !== "template" && <span>{titleCase(i.source)}</span>}
                        </div>
                        {i.findings && <p className="mt-1 line-clamp-2 text-xs text-ink-2">{i.findings}</p>}
                        {i.resolution && <p className="mt-0.5 text-xs text-positive">Resolution: {i.resolution}</p>}
                      </div>
                      <div className="text-xs">
                        <p className={cn("tabular", i.is_overdue ? "font-medium text-negative" : "text-ink-2")}>
                          {i.due_on ? `Due ${formatDate(i.due_on)}` : "No due date"}
                          {i.is_overdue && <AlertTriangle className="ml-1 inline size-3" />}
                        </p>
                        {i.owner_name && (
                          <p className="mt-0.5 flex items-center gap-1 text-ink-3">
                            <Avatar name={i.owner_name} size={16} /> {i.owner_name}
                          </p>
                        )}
                      </div>
                      {editable ? (
                        <Menu>
                          <MenuTrigger asChild>
                            <Button size="icon-sm" variant="ghost" aria-label="Item actions">
                              <MoreHorizontal />
                            </Button>
                          </MenuTrigger>
                          <MenuContent width={210}>
                            <MenuItem icon={<Pencil />} onSelect={() => setEditing(i)}>
                              Edit…
                            </MenuItem>
                            <MenuItem
                              icon={<Flag />}
                              onSelect={() => {
                                setEscalateNote("");
                                setEscalating(i);
                              }}
                            >
                              Escalate…
                            </MenuItem>
                            <MenuItem icon={<ShieldAlert />} onSelect={() => toRisk(i)}>
                              Add to risk register
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem icon={<Trash2 />} destructive onSelect={() => setDeleting(i)}>
                              Remove
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      ) : (
                        <span />
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })
      )}

      <DDItemSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} contractId={contract.id} item={editing} items={items} />

      <Dialog
        open={!!escalating}
        onOpenChange={(o) => !o && setEscalating(null)}
        title="Escalate DD item"
        description={escalating ? `${escalating.title} — alerts the owner's manager or the contract coordinator.` : undefined}
        footer={
          <>
            <Button onClick={() => setEscalating(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!escalateNote.trim()}
              loading={escalate.isPending}
              onClick={() =>
                escalating &&
                escalate.mutate(
                  { id: escalating.id, note: escalateNote.trim() },
                  { onSuccess: () => { toast.success("Escalated"); setEscalating(null); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              Escalate
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea value={escalateNote} onChange={(e) => setEscalateNote(e.target.value)} />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this DD item?"
        description="The item is archived and kept in the audit trail."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, { onSuccess: () => { toast.success("Item removed"); setDeleting(null); }, onError: (e) => toast.error(errorMessage(e)) })
        }
      />
    </div>
  );
}
