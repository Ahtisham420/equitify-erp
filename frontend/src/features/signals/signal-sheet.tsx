"use client";

import { BadgeCheck, RotateCcw, Trash2, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/utils";

import { OwnerPicker } from "@/features/contacts/pickers";
import type { EntityKind } from "@/features/contacts/api";

import { CATEGORY_LABELS, SEVERITIES, SEVERITY_LABELS, signalTitle, useSaveSignal, useSignal, useSignalAction, useSignalTypes, type SignalInput } from "./api";
import { CategoryBadge, DecayBar, PriorityBadge, SensitiveBadge, SeverityBadge } from "./components";

interface FormState {
  property_id: string | null;
  link_owner: boolean;
  owner_kind: EntityKind;
  owner_id: string | null;
  signal_type: string;
  title: string;
  description: string;
  observed_on: string;
  severity: string;
  source: string;
  source_reference: string;
  confidence: string;
  expires_on: string;
  is_sensitive: boolean | null;
  verified: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

function empty(defaults?: Partial<FormState>): FormState {
  return {
    property_id: null, link_owner: false, owner_kind: "organization", owner_id: null, signal_type: "", title: "", description: "",
    observed_on: today(), severity: "", source: "", source_reference: "", confidence: "0.7", expires_on: "", is_sensitive: null, verified: false,
    ...defaults,
  };
}

export function SignalSheet({
  open,
  onOpenChange,
  signalId,
  defaults,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  signalId?: string | null;
  defaults?: Partial<FormState>;
}) {
  const { can } = useAuth();
  const editing = !!signalId;
  const { data: signal } = useSignal(open ? signalId : null);
  const { data: types = [] } = useSignalTypes();
  const save = useSaveSignal(signalId);
  const action = useSignalAction();
  const [form, setForm] = useState<FormState>(empty(defaults));
  const [dismissing, setDismissing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editing && signal) {
      setForm({
        property_id: signal.property_id, link_owner: !!signal.owner_id, owner_kind: signal.owner_kind ?? "organization", owner_id: signal.owner_id,
        signal_type: signal.signal_type, title: signal.title ?? "", description: signal.description ?? "", observed_on: signal.observed_on,
        severity: String(signal.severity), source: signal.source, source_reference: signal.source_reference ?? "", confidence: String(signal.confidence),
        expires_on: signal.expires_on ?? "", is_sensitive: signal.is_sensitive, verified: signal.verification === "verified",
      });
    } else if (!editing) setForm(empty(defaults));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signal?.id, signal?.updated_at]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const type = types.find((t) => t.key === form.signal_type);
  const grouped = useMemo(
    () => types.filter((t) => t.is_active || t.key === form.signal_type).map((t) => ({ value: t.key, label: `${CATEGORY_LABELS[t.category] ?? t.category} · ${t.label}` })),
    [types, form.signal_type],
  );
  const readOnly = editing ? !can("signals", "edit") || !!signal?.redacted : !can("signals", "create");
  const linked = !!form.property_id || (form.link_owner && !!form.owner_id);
  const valid = linked && !!form.signal_type && !!form.observed_on && form.source.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const conf = Number(form.confidence);
    const common: SignalInput = {
      title: form.title.trim() || null,
      description: form.description.trim() || null,
      observed_on: form.observed_on,
      severity: form.severity ? Number(form.severity) : null,
      source: form.source.trim(),
      source_reference: form.source_reference.trim() || null,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.7,
      expires_on: form.expires_on || null,
    };
    const data: SignalInput = editing
      ? { ...common, ...(form.is_sensitive !== null ? { is_sensitive: form.is_sensitive } : {}) }
      : {
          ...common,
          property_id: form.property_id,
          owner_kind: form.link_owner && form.owner_id ? form.owner_kind : null,
          owner_id: form.link_owner ? form.owner_id : null,
          signal_type: form.signal_type,
          is_sensitive: form.is_sensitive,
          verified: form.verified,
        };
    if (editing && data.severity === null) delete data.severity;
    save.mutate(data, {
      onSuccess: () => {
        toast.success(editing ? "Signal updated" : "Signal recorded");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const run = (body: Parameters<typeof action.mutate>[0], msg: string, after?: () => void) =>
    action.mutate(body, {
      onSuccess: () => {
        toast.success(msg);
        after?.();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={editing ? (signal ? signalTitle(signal) : "Signal") : "Record signal"}
        description={
          editing && signal ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={signal.effective_status} />
              <CategoryBadge category={signal.category} />
              <SeverityBadge severity={signal.severity} />
              <PriorityBadge priority={signal.priority} stacked={signal.stacked} />
              {signal.is_sensitive && <SensitiveBadge />}
              <StatusBadge status={signal.verification} />
            </span>
          ) : (
            "A dated, sourced event that may change owner motivation, property risk or market attractiveness."
          )
        }
        footer={
          <>
            {editing && signal && can("signals", "delete") && (
              <Button variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            )}
            {editing && signal && can("signals", "edit") && !signal.redacted && (
              <>
                {signal.verification !== "verified" && (
                  <Button loading={action.isPending} onClick={() => run({ id: signal.id, action: "verify", state: "verified" }, "Signal verified")}>
                    <BadgeCheck /> Verify
                  </Button>
                )}
                {signal.status === "dismissed" ? (
                  <Button loading={action.isPending} onClick={() => run({ id: signal.id, action: "restore" }, "Signal restored")}>
                    <RotateCcw /> Restore
                  </Button>
                ) : (
                  <Button onClick={() => setDismissing(true)}>
                    <XCircle /> Dismiss
                  </Button>
                )}
              </>
            )}
            {!readOnly && (
              <Button variant="primary" type="submit" form="signal-form" loading={save.isPending} disabled={!valid}>
                {editing ? "Save changes" : "Record signal"}
              </Button>
            )}
          </>
        }
      >
        <form id="signal-form" onSubmit={submit} className="space-y-4">
          {editing && signal && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-subtle/60 p-3 text-sm">
              <div>
                <p className="text-xs text-ink-3">Linked to</p>
                <p className="truncate text-ink">
                  {signal.property_id ? (
                    <Link className="hover:underline" href={`/properties/${signal.property_id}`}>
                      {signal.property_label ?? "Property"}
                    </Link>
                  ) : (
                    "—"
                  )}
                </p>
                {signal.owner_id && (
                  <p className="truncate text-xs text-ink-2">
                    Owner:{" "}
                    <Link className="hover:underline" href={`/${signal.owner_kind === "person" ? "people" : "organizations"}/${signal.owner_id}`}>
                      {signal.owner_label ?? "Owner"}
                    </Link>
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-ink-3">Current weight</p>
                <DecayBar signal={signal} className="mt-1" />
              </div>
              {signal.dismissed_reason && (
                <p className="col-span-2 text-xs text-ink-2">
                  Dismissed {formatDateTime(signal.dismissed_at)}: {signal.dismissed_reason}
                </p>
              )}
              {signal.redacted && <p className="col-span-2 text-xs text-caution">Details are hidden. Viewing sensitive signals requires the sensitive-data permission.</p>}
            </div>
          )}

          <fieldset disabled={readOnly} className="space-y-4">
            {!editing && (
              <>
                <Field label="Property" hint="Link a property, an owner, or both.">
                  <PropertyPicker value={form.property_id} onChange={(id) => set("property_id", id)} />
                </Field>
                <div>
                  <label className="mb-1.5 flex items-center gap-2 text-xs font-medium text-ink-2">
                    <Checkbox checked={form.link_owner} onChange={(v) => set("link_owner", v)} label="Link to an owner" />
                    Link to an owner
                  </label>
                  {form.link_owner && <OwnerPicker kind={form.owner_kind} onKindChange={(k) => set("owner_kind", k)} value={form.owner_id} onChange={(id) => set("owner_id", id)} />}
                </div>
                <Field label="Signal type" required hint={type ? `Default severity ${type.default_severity} · decays with a ${type.half_life_days ? `${type.half_life_days}-day half-life` : "no half-life"}${type.is_sensitive ? " · sensitive by default" : ""}` : undefined}>
                  <Select value={form.signal_type} onChange={(e) => set("signal_type", e.target.value)} placeholder="Choose a type" options={grouped} />
                </Field>
              </>
            )}
            <Field label="Title">
              <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder={type?.label ?? "Defaults to the type label"} maxLength={300} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Observed on" required>
                <Input type="date" max={today()} value={form.observed_on} onChange={(e) => set("observed_on", e.target.value)} />
              </Field>
              <Field label="Severity" hint={!form.severity && type ? `Type default: ${type.default_severity}` : undefined}>
                <Select value={form.severity} onChange={(e) => set("severity", e.target.value)} placeholder="Type default" options={SEVERITIES.map((s) => ({ value: String(s), label: SEVERITY_LABELS[s] }))} />
              </Field>
              <Field label="Source" required>
                <Input value={form.source} onChange={(e) => set("source", e.target.value)} placeholder="e.g. County recorder, broker call" maxLength={200} />
              </Field>
              <Field label="Source reference">
                <Input value={form.source_reference} onChange={(e) => set("source_reference", e.target.value)} placeholder="Document #, URL, case #" />
              </Field>
              <Field label="Confidence" hint="0 to 1">
                <Input type="number" min={0} max={1} step={0.05} value={form.confidence} onChange={(e) => set("confidence", e.target.value)} />
              </Field>
              <Field label="Expires on" hint={!form.expires_on && type?.default_expiry_days ? `Defaults to ${type.default_expiry_days} days after observed` : undefined}>
                <Input type="date" value={form.expires_on} onChange={(e) => set("expires_on", e.target.value)} />
              </Field>
            </div>
            <Field label="Description">
              <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={4} />
            </Field>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-ink">
                <Checkbox checked={form.is_sensitive ?? !!type?.is_sensitive} onChange={(v) => set("is_sensitive", v)} label="Sensitive" />
                Sensitive — keep internal; exclude from exports and outbound use
              </label>
              {!editing && (
                <label className="flex items-center gap-2 text-sm text-ink">
                  <Checkbox checked={form.verified} onChange={(v) => set("verified", v)} label="Verified" />
                  I verified this signal against the source
                </label>
              )}
            </div>
          </fieldset>
          {editing && signal && (
            <p className="text-xs text-ink-3">
              Recorded {formatDateTime(signal.created_at)} · observed {formatDate(signal.observed_on)} · updated {formatDateTime(signal.updated_at)}
            </p>
          )}
        </form>
      </Sheet>

      <Dialog
        open={dismissing}
        onOpenChange={setDismissing}
        title="Dismiss signal"
        description="Dismissed signals stop contributing to motivation and scores. The record is kept."
        footer={
          <>
            <Button onClick={() => setDismissing(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 3}
              loading={action.isPending}
              onClick={() =>
                signal &&
                run({ id: signal.id, action: "dismiss", reason: reason.trim() }, "Signal dismissed", () => {
                  setDismissing(false);
                  setReason("");
                })
              }
            >
              Dismiss
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Lien released, duplicate of another record" />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete signal"
        description="The signal is archived and no longer counted. The audit history is kept."
        confirmLabel="Delete"
        destructive
        loading={action.isPending}
        onConfirm={() =>
          signal &&
          run({ id: signal.id, action: "delete" }, "Signal deleted", () => {
            setDeleting(false);
            onOpenChange(false);
          })
        }
      />
    </>
  );
}
