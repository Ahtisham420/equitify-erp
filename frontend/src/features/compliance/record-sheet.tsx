"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { FieldGrid, FieldItem } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, titleCase } from "@/lib/utils";

import { CHANNEL_LABELS, CHANNELS, DNC_STATUSES, EVENT_LABELS, PHONE_TYPES, useComplianceRecord, useUpsertRecord, type ComplianceRecord } from "./api";

type ScrubForm = { channel: string; value: string; phone_type: string; jurisdiction_state: string; dnc_status: string; scrub_date: string; scrub_source: string; provider: string; notes: string };

function toForm(r?: ComplianceRecord | null): ScrubForm {
  return {
    channel: r?.channel ?? "phone",
    value: r?.value ?? "",
    phone_type: r?.phone_type ?? "unknown",
    jurisdiction_state: r?.jurisdiction_state ?? "",
    dnc_status: r?.dnc_status ?? "unknown",
    scrub_date: r?.scrub_date ?? "",
    scrub_source: r?.scrub_source ?? "",
    provider: r?.provider ?? "",
    notes: r?.notes ?? "",
  };
}

function ScrubFields({ form, set, isNew }: { form: ScrubForm; set: (k: keyof ScrubForm, v: string) => void; isNew: boolean }) {
  const phone = form.channel !== "email";
  return (
    <div className="grid grid-cols-2 gap-3">
      {isNew && (
        <>
          <Field label="Channel">
            <Select value={form.channel} onChange={(e) => set("channel", e.target.value)} options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
          </Field>
          <Field label={phone ? "Phone number" : "Email address"} required>
            <Input value={form.value} onChange={(e) => set("value", e.target.value)} />
          </Field>
        </>
      )}
      {phone && (
        <>
          <Field label="Phone type">
            <Select value={form.phone_type} onChange={(e) => set("phone_type", e.target.value)} options={PHONE_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} />
          </Field>
          <Field label="Jurisdiction (state)" hint="Drives quiet hours">
            <Input value={form.jurisdiction_state} onChange={(e) => set("jurisdiction_state", e.target.value.toUpperCase())} maxLength={10} placeholder="TX" />
          </Field>
          <Field label="DNC status">
            <Select value={form.dnc_status} onChange={(e) => set("dnc_status", e.target.value)} options={DNC_STATUSES.map((t) => ({ value: t, label: titleCase(t) }))} />
          </Field>
          <Field label="Scrub date">
            <Input type="date" value={form.scrub_date} onChange={(e) => set("scrub_date", e.target.value)} />
          </Field>
          <Field label="Scrub source">
            <Input value={form.scrub_source} onChange={(e) => set("scrub_source", e.target.value)} placeholder="e.g. National DNC registry" />
          </Field>
        </>
      )}
      <Field label="Data provider" hint="Used for export restrictions">
        <Input value={form.provider} onChange={(e) => set("provider", e.target.value)} />
      </Field>
      <Field label="Notes" className="col-span-2">
        <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
      </Field>
    </div>
  );
}

export function NewRecordSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState<ScrubForm>(toForm());
  const save = useUpsertRecord();
  useEffect(() => {
    if (open) setForm(toForm());
  }, [open]);
  const set = (k: keyof ScrubForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const phone = form.channel !== "email";
    save.mutate(
      {
        channel: form.channel,
        value: form.value.trim(),
        ...(phone
          ? { phone_type: form.phone_type, jurisdiction_state: form.jurisdiction_state || null, dnc_status: form.dnc_status, scrub_date: form.scrub_date || null, scrub_source: form.scrub_source || null }
          : {}),
        provider: form.provider || null,
        notes: form.notes || null,
      },
      {
        onSuccess: () => {
          toast.success("Compliance record saved");
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
      title="Add or update a compliance record"
      description="Records are keyed by channel and normalized value; saving an existing value updates its scrub facts."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="compliance-record-form" loading={save.isPending} disabled={form.value.trim().length < 3}>
            Save record
          </Button>
        </>
      }
    >
      <form id="compliance-record-form" onSubmit={submit}>
        <ScrubFields form={form} set={set} isNew />
      </form>
    </Sheet>
  );
}

export function RecordSheet({ id, onOpenChange }: { id: string | null; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const { data: r, isLoading } = useComplianceRecord(id);
  const [form, setForm] = useState<ScrubForm>(toForm());
  const save = useUpsertRecord();
  useEffect(() => {
    if (r) setForm(toForm(r));
  }, [r]);
  const set = (k: keyof ScrubForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const editable = can("compliance", "edit");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!r) return;
    const phone = r.channel !== "email";
    save.mutate(
      {
        id: r.id,
        ...(phone
          ? { phone_type: form.phone_type, jurisdiction_state: form.jurisdiction_state || null, dnc_status: form.dnc_status, scrub_date: form.scrub_date || null, scrub_source: form.scrub_source || null }
          : {}),
        provider: form.provider || null,
        notes: form.notes || null,
      },
      { onSuccess: () => toast.success("Record updated"), onError: (err) => toast.error(errorMessage(err)) },
    );
  };

  const consentHref = r ? `/compliance?tab=consent&channel=${r.channel}&value=${encodeURIComponent(r.value)}` : "#";

  return (
    <Sheet
      open={!!id}
      onOpenChange={onOpenChange}
      title={r ? r.value : "Compliance record"}
      description={r ? CHANNEL_LABELS[r.channel] : undefined}
      footer={
        editable && r ? (
          <Button variant="primary" type="submit" form="compliance-edit-form" loading={save.isPending}>
            Save scrub facts
          </Button>
        ) : undefined
      }
    >
      {isLoading || !r ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className={r.allowed ? "rounded-lg border border-positive/30 bg-positive-soft p-3 text-sm text-positive" : "rounded-lg border border-negative/30 bg-negative-soft p-3 text-sm text-negative"}>
            <p className="flex items-center gap-1.5 font-medium">
              {r.allowed ? <ShieldCheck className="size-4" /> : <ShieldAlert className="size-4" />}
              {r.allowed ? "Contact allowed right now" : "Contact blocked right now"}
            </p>
            {r.reasons.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                {r.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </div>

          <FieldGrid cols={3}>
            <FieldItem label="DNC status"><StatusBadge status={r.dnc_status === "listed" ? "blocked" : r.dnc_status === "clear" ? "allowed" : "unknown"} label={titleCase(r.dnc_status)} /></FieldItem>
            <FieldItem label="Scrub">{r.scrub_date ? `${formatDate(r.scrub_date)}${r.scrub_source ? ` · ${r.scrub_source}` : ""}` : null}</FieldItem>
            <FieldItem label="Scrub expires">{r.scrub_expires_on ? formatDate(r.scrub_expires_on) : null}</FieldItem>
            <FieldItem label="Consent"><StatusBadge status={r.consent_state === "granted" ? "consented" : r.consent_state === "revoked" ? "blocked" : "unknown"} label={titleCase(r.consent_state)} /></FieldItem>
            <FieldItem label="Consent source">{r.consent_source ? `${r.consent_source} · ${formatDate(r.consent_date)}` : null}</FieldItem>
            <FieldItem label="Opt-outs">{r.opt_out_count ? `${r.opt_out_count} · last ${formatDate(r.opted_out_at)}` : "None"}</FieldItem>
            <FieldItem label="Internal suppression">
              {r.internal_suppression ? <Badge tone="red">Suppressed{r.suppressed_until ? ` until ${formatDate(r.suppressed_until)}` : ""}</Badge> : "No"}
            </FieldItem>
            <FieldItem label="Suppression reason" className="col-span-2">{r.suppression_reason}</FieldItem>
            <FieldItem label="Phone type">{r.channel === "email" ? null : titleCase(r.phone_type)}</FieldItem>
            <FieldItem label="Jurisdiction">{[r.jurisdiction_state, r.jurisdiction_country].filter(Boolean).join(", ")}</FieldItem>
            <FieldItem label="Provider">{r.provider}</FieldItem>
          </FieldGrid>

          <div className="flex flex-wrap gap-2">
            <Link href={consentHref} className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-subtle">
              Record opt-out or consent
            </Link>
            {r.person_id && (
              <Link href={`/people/${r.person_id}`} className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-subtle">
                Open person
              </Link>
            )}
          </div>

          {editable && (
            <form id="compliance-edit-form" onSubmit={submit} className="space-y-2">
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Scrub & classification</h4>
              <ScrubFields form={form} set={set} isNew={false} />
            </form>
          )}

          <section>
            <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">History (immutable)</h4>
            {r.events.length === 0 ? (
              <p className="text-sm text-ink-3">No consent or suppression events.</p>
            ) : (
              <ol className="space-y-2">
                {r.events.map((e) => (
                  <li key={e.id} className="rounded-md border border-line px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                      <Badge tone="outline">{e.channel}</Badge>
                      <span className="ml-auto text-xs text-ink-3">{formatDateTime(e.occurred_at)}</span>
                    </div>
                    <p className="text-xs text-ink-3">
                      {e.actor_name ?? "System"}
                      {e.source ? ` · ${e.source}` : ""}
                    </p>
                    {e.evidence && <p className="mt-1 whitespace-pre-wrap text-xs text-ink-2">Evidence: {e.evidence}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
