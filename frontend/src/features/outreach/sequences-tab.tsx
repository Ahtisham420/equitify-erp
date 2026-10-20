"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ListOrdered, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import { PersonPicker } from "@/features/tasks/record-pickers";

import {
  CHANNEL_LABELS,
  DISPOSITION_LABELS,
  DISPOSITIONS,
  useEnroll,
  useEnrollmentAction,
  useSaveSequence,
  useSequences,
  type Enrollment,
  type Sequence,
  type SequenceInput,
  type SequenceStep,
} from "./api";

const STEP_CHANNELS: SequenceStep["channel"][] = ["call", "email", "sms", "letter"];
const EMPTY: SequenceInput = { name: "", description: null, status: "active", steps: [{ channel: "call", delay_days: 0, template: null }], enrollment_cap: null, exit_dispositions: [] };

function SequenceSheet({ open, onOpenChange, sequence }: { open: boolean; onOpenChange: (o: boolean) => void; sequence: Sequence | null }) {
  const [form, setForm] = useState<SequenceInput>(EMPTY);
  const [cap, setCap] = useState("");
  const save = useSaveSequence(sequence?.id);

  useEffect(() => {
    if (!open) return;
    if (sequence) {
      setForm({ name: sequence.name, description: sequence.description, status: sequence.status, steps: sequence.steps, enrollment_cap: sequence.enrollment_cap, exit_dispositions: sequence.exit_dispositions });
      setCap(sequence.enrollment_cap ? String(sequence.enrollment_cap) : "");
    } else {
      setForm(EMPTY);
      setCap("");
    }
  }, [open, sequence]);

  const setStep = (i: number, patch: Partial<SequenceStep>) => setForm((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const moveStep = (i: number, d: number) =>
    setForm((f) => {
      const steps = [...f.steps];
      const [s] = steps.splice(i, 1);
      steps.splice(i + d, 0, s);
      return { ...f, steps };
    });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={sequence ? "Edit sequence" : "New sequence"}
      description="A structured multi-step, multi-channel plan. People exit automatically when they reply or a conversation happens."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!form.name.trim() || form.steps.length === 0}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { ...form, name: form.name.trim(), description: form.description?.trim() || null, enrollment_cap: cap ? Number(cap) || null : null, steps: form.steps.map((s) => ({ ...s, template: s.template?.trim() || null })) },
                {
                  onSuccess: () => {
                    toast.success("Sequence saved");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Save sequence
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Description">
          <Textarea value={form.description ?? ""} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} options={["active", "paused", "archived"].map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Enrollment cap" hint="Maximum people active at once">
            <Input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" />
          </Field>
        </div>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-ink-2">Steps</h4>
            <Button size="xs" variant="ghost" onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, { channel: "email", delay_days: 3, template: null }] }))}>
              <Plus /> Add step
            </Button>
          </div>
          <ol className="space-y-2">
            {form.steps.map((s, i) => (
              <li key={i} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-ink-2">{i + 1}</span>
                  <Select value={s.channel} onChange={(e) => setStep(i, { channel: e.target.value as SequenceStep["channel"] })} options={STEP_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} className="w-28" />
                  <span className="text-xs text-ink-3">after</span>
                  <Input inputMode="numeric" value={String(s.delay_days)} onChange={(e) => setStep(i, { delay_days: Math.max(0, Number(e.target.value) || 0) })} className="w-16" />
                  <span className="text-xs text-ink-3">{i === 0 ? "days from enrollment" : "days"}</span>
                  <span className="ml-auto flex gap-0.5">
                    <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => moveStep(i, -1)} aria-label="Move up"><ArrowUp /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={i === form.steps.length - 1} onClick={() => moveStep(i, 1)} aria-label="Move down"><ArrowDown /></Button>
                    <Button size="icon-sm" variant="ghost" disabled={form.steps.length === 1} onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} aria-label="Remove step"><Trash2 /></Button>
                  </span>
                </div>
                <Textarea className="mt-2" rows={3} value={s.template ?? ""} onChange={(e) => setStep(i, { template: e.target.value })} placeholder="Template / talking points for this step" />
              </li>
            ))}
          </ol>
        </section>

        <Field label="Also exit on these dispositions" hint="Replies and conversation dispositions (connected, callback, information/offer requested, not interested, wrong number) always exit.">
          <div className="grid grid-cols-2 gap-1.5 rounded-md border border-line p-2.5">
            {DISPOSITIONS.map((d) => (
              <label key={d} className="flex items-center gap-2 text-sm text-ink-2">
                <Checkbox
                  checked={form.exit_dispositions.includes(d)}
                  onChange={(on) => setForm((f) => ({ ...f, exit_dispositions: on ? [...f.exit_dispositions, d] : f.exit_dispositions.filter((x) => x !== d) }))}
                />
                {DISPOSITION_LABELS[d]}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Sheet>
  );
}

function EnrollDialog({ sequence, open, onOpenChange }: { sequence: Sequence; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [people, setPeople] = useState<{ id: string; label: string }[]>([]);
  const [skipped, setSkipped] = useState<{ person_id: string; reason: string }[]>([]);
  const enroll = useEnroll(sequence.id);
  useEffect(() => {
    if (open) {
      setPeople([]);
      setSkipped([]);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Enroll in “${sequence.name}”`}
      description={sequence.enrollment_cap ? `${sequence.active_enrollments} of ${sequence.enrollment_cap} active slots used.` : "People with an opt-out or suppression are skipped."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            variant="primary"
            disabled={!people.length}
            loading={enroll.isPending}
            onClick={() =>
              enroll.mutate(
                people.map((p) => p.id),
                {
                  onSuccess: (r) => {
                    toast.success(`${r.enrolled} enrolled${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`);
                    setSkipped(r.skipped);
                    setPeople([]);
                    if (!r.skipped.length) onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Enroll {people.length || ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <PersonPicker value={null} placeholder="Add a person…" onChange={(id, label) => id && !people.some((p) => p.id === id) && setPeople((ps) => [...ps, { id, label: label ?? "Person" }])} />
        <div className="flex flex-wrap gap-1.5">
          {people.map((p) => (
            <span key={p.id} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface pl-2 pr-1 text-xs">
              {p.label}
              <button onClick={() => setPeople((ps) => ps.filter((x) => x.id !== p.id))} className="rounded p-0.5 text-ink-3 hover:bg-muted" aria-label="Remove">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        {skipped.length > 0 && (
          <div className="rounded-md border border-caution/30 bg-caution-soft p-2.5 text-xs text-caution">
            <p className="font-medium">Skipped</p>
            <ul className="mt-1 space-y-0.5">
              {skipped.map((s) => (
                <li key={s.person_id}>{s.reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Enrollments({ sequence }: { sequence: Sequence }) {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("active");
  const [exiting, setExiting] = useState<Enrollment | null>(null);
  const [reason, setReason] = useState("");
  const action = useEnrollmentAction();
  const { data, isLoading } = useQuery({
    queryKey: ["sequences", "enrollments", sequence.id, status, page],
    queryFn: () => api.get<Page<Enrollment>>("/sequence-enrollments", { sequence_id: sequence.id, status: status || undefined, page, page_size: 25, sort: "next_step_at" }),
  });

  const columns: Column<Enrollment>[] = [
    { id: "person", header: "Person", cell: (e) => <span className="font-medium text-ink">{e.person_name ?? "—"}</span> },
    { id: "status", header: "Status", cell: (e) => <StatusBadge status={e.status === "exited" ? "closed" : e.status} label={titleCase(e.status)} /> },
    { id: "step", header: "Step", align: "right", cell: (e) => `${Math.min(e.current_step + (e.status === "active" ? 1 : 0), e.total_steps)} / ${e.total_steps}` },
    {
      id: "next",
      header: "Next step",
      cell: (e) =>
        e.next_step_at ? (
          <span className={cn("text-xs", isOverdue(e.next_step_at) ? "text-negative" : "text-ink-2")}>
            {e.next_step_channel ? `${CHANNEL_LABELS[e.next_step_channel] ?? e.next_step_channel} · ` : ""}
            {formatDate(e.next_step_at)}
          </span>
        ) : (
          <span className="text-xs text-ink-3">{e.exit_reason ?? "—"}</span>
        ),
    },
    { id: "enrolled", header: "Enrolled", cell: (e) => <span className="text-xs text-ink-3">{formatRelative(e.enrolled_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (e) =>
        e.status === "active" && can("outreach", "edit") ? (
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" onClick={() => action.mutate({ id: e.id, action: "advance" }, { onSuccess: () => toast.success("Step marked done"), onError: (err) => toast.error(errorMessage(err)) })}>
              Step done
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setExiting(e)}>
              Exit
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        {["active", "completed", "exited", ""].map((s) => (
          <button key={s || "all"} onClick={() => { setStatus(s); setPage(1); }} className={cn("h-7 rounded px-2.5 text-xs font-medium", status === s ? "bg-ink text-white" : "text-ink-2 hover:bg-muted")}>
            {s ? titleCase(s) : "All"}
          </button>
        ))}
      </div>
      <DataTable columns={columns} data={data?.items} loading={isLoading} empty={<EmptyState icon={<UserPlus />} title="No enrollments" description="Enroll people to start this sequence." />} />
      <TableFooter page={page} pageSize={25} total={data?.total ?? 0} onPage={setPage} />
      <Dialog
        open={!!exiting}
        onOpenChange={(o) => !o && setExiting(null)}
        title="Exit sequence"
        description={exiting?.person_name}
        footer={
          <>
            <Button onClick={() => setExiting(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={reason.trim().length < 2}
              loading={action.isPending}
              onClick={() =>
                exiting &&
                action.mutate(
                  { id: exiting.id, action: "exit", reason: reason.trim() },
                  {
                    onSuccess: () => {
                      toast.success("Exited sequence");
                      setExiting(null);
                      setReason("");
                    },
                    onError: (err) => toast.error(errorMessage(err)),
                  },
                )
              }
            >
              Exit
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}

export function SequencesTab() {
  const { can } = useAuth();
  const url = useUrlState();
  const { data: sequences, isLoading } = useSequences();
  const [editing, setEditing] = useState<Sequence | null>(null);
  const [creating, setCreating] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const selected = sequences?.find((s) => s.id === url.get("seq")) ?? sequences?.[0] ?? null;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader
          title="Sequences"
          actions={
            can("outreach", "create") ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New
              </Button>
            ) : undefined
          }
        />
        {isLoading ? (
          <p className="p-4 text-sm text-ink-3">Loading…</p>
        ) : !sequences?.length ? (
          <EmptyState icon={<ListOrdered />} title="No sequences" description="Create a multi-step outreach plan." />
        ) : (
          <ul className="divide-y divide-line">
            {sequences.map((s) => (
              <li key={s.id}>
                <button onClick={() => url.set({ seq: s.id })} className={cn("w-full px-4 py-2.5 text-left", selected?.id === s.id ? "bg-accent-soft/60" : "hover:bg-subtle")}>
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{s.name}</span>
                    <StatusBadge status={s.status} />
                  </span>
                  <span className="text-xs text-ink-3 tabular">
                    {s.steps.length} steps · {s.active_enrollments} active{s.enrollment_cap ? ` / cap ${s.enrollment_cap}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected ? (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title={selected.name}
              description={selected.description}
              actions={
                <>
                  {can("outreach", "edit") && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(selected)}>
                      <Pencil /> Edit
                    </Button>
                  )}
                  {can("outreach", "create") && (
                    <Button size="sm" variant="primary" disabled={selected.status !== "active"} onClick={() => setEnrolling(true)}>
                      <UserPlus /> Enroll people
                    </Button>
                  )}
                </>
              }
            />
            <CardBody>
              <ol className="flex flex-wrap gap-2">
                {selected.steps.map((st, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm" title={st.template ?? undefined}>
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-2xs font-semibold">{i + 1}</span>
                    {CHANNEL_LABELS[st.channel]}
                    <span className="text-xs text-ink-3">+{st.delay_days}d</span>
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex flex-wrap gap-1.5 text-xs text-ink-3">
                <span>Enrollment cap: {selected.enrollment_cap ?? "none"}</span>
                <span>·</span>
                <span>{selected.total_enrollments} total enrollments</span>
                {selected.exit_dispositions.length > 0 && (
                  <>
                    <span>·</span>
                    <span>Extra exits: </span>
                    {selected.exit_dispositions.map((d) => (
                      <Badge key={d} tone="outline">{DISPOSITION_LABELS[d] ?? d}</Badge>
                    ))}
                  </>
                )}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Enrollments" />
            <Enrollments key={selected.id} sequence={selected} />
          </Card>
          <EnrollDialog sequence={selected} open={enrolling} onOpenChange={setEnrolling} />
        </div>
      ) : null}

      <SequenceSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} sequence={editing} />
    </div>
  );
}
