"use client";

import { ArrowRight, CalendarClock, Check, FileSearch, History, MoreHorizontal, Pencil, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import {
  DATE_SOURCE_LABELS,
  DATE_STATUS_LABELS,
  DATE_STATUS_TONES,
  DATE_TYPE_LABELS,
  daysLabel,
  describeRule,
  isOpenDate,
  useCreateDate,
  useDateAction,
  useDateEvents,
  useUpdateDate,
  type CriticalDate,
} from "./api";

export function DateStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={DATE_STATUS_TONES[status] ?? "neutral"} dot>
      {DATE_STATUS_LABELS[status] ?? titleCase(status)}
    </Badge>
  );
}

export function SourceBadge({ d }: { d: Pick<CriticalDate, "source" | "rule"> }) {
  const assumed = d.source === "rule" && d.rule?.assumed;
  return (
    <Badge tone={d.source === "ai" ? "sky" : "outline"}>
      {DATE_SOURCE_LABELS[d.source] ?? d.source}
      {assumed ? " · default" : ""}
    </Badge>
  );
}

export function DueText({ d, className }: { d: CriticalDate; className?: string }) {
  const overdue = isOpenDate(d) && (d.days_until ?? 0) < 0;
  const soon = isOpenDate(d) && !overdue && (d.days_until ?? 99) <= Math.max(3, Math.min(d.lead_days, 7));
  return (
    <span className={cn("whitespace-nowrap tabular", overdue ? "font-medium text-negative" : soon ? "font-medium text-caution" : "text-ink-2", className)}>
      {formatDate(d.due_on)}
      {isOpenDate(d) && <span className="ml-1.5 text-xs font-normal text-ink-3">{daysLabel(d.days_until)}</span>}
    </span>
  );
}

export type DateDialogKind = "confirm" | "complete" | "waive" | "reschedule" | "edit" | "history";

/** What a person verifying a proposed date needs to see: where it came from. */
export function DateProvenance({ d }: { d: CriticalDate }) {
  const rule = describeRule(d.rule);
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-subtle/60 px-3 py-2.5 text-xs">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="text-ink-3">Source</span>
        <SourceBadge d={d} />
        {d.related_label && <span className="text-ink-2">· {d.related_label}</span>}
      </p>
      {rule && (
        <p className="text-ink-2">
          <span className="text-ink-3">Rule:</span> {rule}
        </p>
      )}
      {d.rule?.assumed && <p className="text-caution">Market default, not read from the contract terms. Verify against the executed agreement.</p>}
      {d.citation && (
        <div className="text-ink-2">
          <span className="text-ink-3">Citation:</span>{" "}
          {[d.citation.clause && `§ ${d.citation.clause}`, d.citation.page != null && `page ${d.citation.page}`].filter(Boolean).join(", ") || "document"}
          {d.citation.confidence != null && <span className="text-ink-3"> · confidence {Math.round(d.citation.confidence * 100)}%</span>}
          {d.citation.text && <blockquote className="mt-1 border-l-2 border-line-strong pl-2 italic text-ink-2">{d.citation.text}</blockquote>}
        </div>
      )}
      {d.proposed_due_on && (
        <p className="text-caution">
          A newer computed value ({formatDate(d.proposed_due_on)}) differs from the confirmed date.
        </p>
      )}
    </div>
  );
}

export function DateHistory({ id }: { id: string }) {
  const { data, isLoading } = useDateEvents(id);
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.length) return <p className="text-sm text-ink-3">No history yet.</p>;
  return (
    <ol className="space-y-3">
      {data.map((e) => (
        <li key={e.id} className="text-sm">
          <p className="flex flex-wrap items-center gap-1.5 text-ink">
            <span className="font-medium">{e.actor_name ?? "System"}</span>
            <span className="text-ink-2">{titleCase(e.kind).toLowerCase()}</span>
            {e.from_due_on && e.to_due_on && (
              <span className="flex items-center gap-1 text-xs text-ink-2 tabular">
                {formatDate(e.from_due_on)} <ArrowRight className="size-3" /> {formatDate(e.to_due_on)}
              </span>
            )}
            {e.to_status && e.from_status !== e.to_status && <DateStatusBadge status={e.to_status} />}
          </p>
          <p className="text-xs text-ink-3" title={formatDateTime(e.at)}>
            {formatRelative(e.at)}
          </p>
          {e.reason && <p className="mt-0.5 text-ink-2">{e.reason}</p>}
        </li>
      ))}
    </ol>
  );
}

export function DateActionDialog({ date, kind, onClose }: { date: CriticalDate | null; kind: DateDialogKind | null; onClose: () => void }) {
  const action = useDateAction();
  const update = useUpdateDate();
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const [verified, setVerified] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [lead, setLead] = useState("14");
  const [blocking, setBlocking] = useState(false);
  const open = !!date && !!kind;

  useEffect(() => {
    if (!date || !kind) return;
    setNote("");
    setVerified(false);
    setDue(kind === "reschedule" ? date.proposed_due_on ?? date.due_on : date.due_on);
    setOwner(date.owner_id);
    setLead(String(date.lead_days));
    setBlocking(date.is_blocking);
  }, [date, kind]);

  if (!date || !kind) return null;

  const done = (msg: string) => ({
    onSuccess: () => {
      toast.success(msg);
      onClose();
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  const submit = () => {
    if (kind === "confirm") action.mutate({ id: date.id, action: "confirm", body: { note: note.trim() || null, due_on: due || null } }, done("Date confirmed against source"));
    else if (kind === "complete") action.mutate({ id: date.id, action: "complete", body: { note: note.trim() || null } }, done("Date completed"));
    else if (kind === "waive") action.mutate({ id: date.id, action: "waive", body: { note: note.trim() } }, done("Date waived"));
    else if (kind === "reschedule") action.mutate({ id: date.id, action: "reschedule", body: { due_on: due, reason: note.trim() } }, done("Date rescheduled"));
    else if (kind === "edit") update.mutate({ id: date.id, data: { owner_id: owner, lead_days: Number(lead) || 0, is_blocking: blocking } }, done("Date updated"));
  };

  const titles: Record<DateDialogKind, string> = {
    confirm: "Confirm against source",
    complete: "Mark complete",
    waive: "Waive date",
    reschedule: "Reschedule date",
    edit: "Owner and escalation",
    history: "Date history",
  };
  const disabled =
    (kind === "confirm" && (!verified || !due)) || (kind === "waive" && !note.trim()) || (kind === "reschedule" && (!note.trim() || !due));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={titles[kind]}
      description={`${date.label} · ${DATE_TYPE_LABELS[date.date_type] ?? titleCase(date.date_type)} · due ${formatDate(date.due_on)}`}
      footer={
        kind === "history" ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant={kind === "waive" ? "danger" : "primary"} disabled={disabled} loading={action.isPending || update.isPending} onClick={submit}>
              {kind === "confirm" ? "Confirm date" : kind === "complete" ? "Mark complete" : kind === "waive" ? "Waive" : kind === "reschedule" ? "Reschedule" : "Save"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {kind === "history" && <DateHistory id={date.id} />}
        {kind === "confirm" && (
          <>
            <DateProvenance d={date} />
            <Field label="Date in the executed contract" required hint="Correct it here if the source says otherwise; the change is kept in history.">
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Source reference" hint="Section, page or clause you checked, e.g. PSA § 4.2.">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="PSA § 4.2" />
            </Field>
            <label className="flex items-start gap-2 text-sm text-ink">
              <Checkbox checked={verified} onChange={setVerified} label="Verified" className="mt-0.5" />
              <span>I verified this deadline against the source contract and its amendments.</span>
            </label>
          </>
        )}
        {kind === "complete" && (
          <Field label="Note" hint="What was done, e.g. deposit wired, notice delivered.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {kind === "waive" && (
          <Field label="Reason" required hint="Recorded in the date history and audit log.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {kind === "reschedule" && (
          <>
            {date.proposed_due_on && <DateProvenance d={date} />}
            <Field label="New due date" required>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Reason" required hint="e.g. Amendment No. 1 extended the period. The previous date stays in history.">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
        {kind === "edit" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Accountable owner" className="col-span-2">
              <UserPicker value={owner} onChange={setOwner} />
            </Field>
            <Field label="Lead time (days)" hint="Owner task is created this many days before.">
              <Input inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} />
            </Field>
            <Field label="Blocking">
              <label className="flex h-8 items-center gap-2 text-sm">
                <Checkbox checked={blocking} onChange={setBlocking} label="Blocking" /> Escalate as critical
              </label>
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Row-level menu. Stops propagation so table row navigation is not triggered. */
export function DateRowActions({ d, onAction, compact }: { d: CriticalDate; onAction: (kind: DateDialogKind) => void; compact?: boolean }) {
  const { can } = useAuth();
  const editable = can("contracts", "edit");
  const open = isOpenDate(d);
  return (
    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {editable && d.status === "proposed" && (
        <Button size="xs" variant="primary" onClick={() => onAction("confirm")}>
          <ShieldCheck /> {compact ? "Confirm" : "Confirm against source"}
        </Button>
      )}
      {editable && (d.status === "confirmed" || d.status === "missed") && (
        <Button size="xs" onClick={() => onAction("complete")}>
          <Check /> Complete
        </Button>
      )}
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Date actions">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent width={200}>
          {editable && open && (
            <>
              <MenuItem icon={<CalendarClock />} onSelect={() => onAction("reschedule")}>
                Reschedule…
              </MenuItem>
              <MenuItem icon={<Pencil />} onSelect={() => onAction("edit")}>
                Owner and lead time…
              </MenuItem>
              <MenuItem icon={<X />} destructive onSelect={() => onAction("waive")}>
                Waive…
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {d.proposed_due_on && editable && open && (
            <MenuItem icon={<FileSearch />} onSelect={() => onAction("reschedule")}>
              Review conflicting value…
            </MenuItem>
          )}
          <MenuItem icon={<History />} onSelect={() => onAction("history")}>
            History
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

const MANUAL_TYPES = Object.keys(DATE_TYPE_LABELS);

/** Manually entered date (read by a person from a source document); recorded as confirmed by them. */
export function AddDateDialog({
  open,
  onOpenChange,
  relatedType,
  relatedId,
  relatedLabel,
  propertyId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  relatedType: string;
  relatedId: string;
  relatedLabel?: string | null;
  propertyId?: string | null;
}) {
  const create = useCreateDate();
  const [label, setLabel] = useState("");
  const [type, setType] = useState("other");
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [lead, setLead] = useState("14");
  const [blocking, setBlocking] = useState(false);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setLabel("");
      setType("other");
      setDue("");
      setOwner(null);
      setLead("14");
      setBlocking(false);
      setNotes("");
    }
  }, [open]);

  const submit = () =>
    create.mutate(
      {
        related_type: relatedType,
        related_id: relatedId,
        related_label: relatedLabel ?? null,
        property_id: propertyId ?? null,
        date_type: type,
        label: label.trim(),
        due_on: due,
        owner_id: owner,
        lead_days: Number(lead) || 0,
        is_blocking: blocking,
        notes: notes.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success("Critical date added");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add critical date"
      description="Enter a deadline you read from the source document. It is recorded as confirmed by you."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!label.trim() || !due} loading={create.isPending} onClick={submit}>
            Add date
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Label" required className="col-span-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Seller to deliver rent roll" />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)} options={MANUAL_TYPES.map((t) => ({ value: t, label: DATE_TYPE_LABELS[t] }))} />
        </Field>
        <Field label="Due date" required>
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Accountable owner" className="col-span-2">
          <UserPicker value={owner} onChange={setOwner} />
        </Field>
        <Field label="Lead time (days)">
          <Input inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} />
        </Field>
        <Field label="Blocking">
          <label className="flex h-8 items-center gap-2 text-sm">
            <Checkbox checked={blocking} onChange={setBlocking} label="Blocking" /> Escalate as critical
          </label>
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
