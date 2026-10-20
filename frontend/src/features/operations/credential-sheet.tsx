"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { RecordDocuments } from "@/features/documents/record-documents";
import { errorMessage } from "@/lib/api";
import { formatDateTime, titleCase, toNumber } from "@/lib/utils";

import { CREDENTIAL_KINDS, CREDENTIAL_LABELS, useSaveCredential, type Credential, type CredentialInput } from "./api";

const CREDENTIAL_TONES: Record<string, Tone> = { valid: "green", expiring: "amber", expired: "red", pending: "amber", rejected: "red" };

export function CredentialStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={CREDENTIAL_TONES[status] ?? "neutral"} dot>
      {titleCase(status)}
    </Badge>
  );
}

interface FormState {
  kind: string;
  name: string;
  number: string;
  issuer: string;
  coverage_amount: string;
  effective_on: string;
  expires_on: string;
  is_required: boolean;
  verified: boolean;
  notes: string;
}

function toForm(c?: Credential | null): FormState {
  return {
    kind: c?.kind ?? "insurance_coi",
    name: c?.name ?? "",
    number: c?.number ?? "",
    issuer: c?.issuer ?? "",
    coverage_amount: c?.coverage_amount != null ? String(c.coverage_amount) : "",
    effective_on: c?.effective_on ?? "",
    expires_on: c?.expires_on ?? "",
    is_required: c ? c.is_required : true,
    verified: !!c?.verified_at,
    notes: c?.notes ?? "",
  };
}

const blank = (v: string) => (v.trim() === "" ? null : v.trim());

export function CredentialSheet({
  open,
  onOpenChange,
  vendorId,
  credential,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vendorId: string;
  credential?: Credential | null;
}) {
  const [form, setForm] = useState<FormState>(toForm(credential));
  // After creating, the sheet stays open on the saved record so the document can be attached.
  const [saved, setSaved] = useState<Credential | null>(null);
  const current = credential ?? saved;
  const save = useSaveCredential(vendorId, current?.id);

  useEffect(() => {
    if (open) {
      setForm(toForm(credential));
      setSaved(null);
    }
  }, [open, credential]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const bind = (key: "name" | "number" | "issuer" | "coverage_amount" | "effective_on" | "expires_on" | "notes") => ({
    id: `cred-${key}`,
    value: form[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.effective_on && form.expires_on && form.expires_on < form.effective_on) {
      toast.error("Expiry date is before the effective date");
      return;
    }
    const data: CredentialInput = {
      kind: form.kind,
      name: form.name.trim(),
      number: blank(form.number),
      issuer: blank(form.issuer),
      coverage_amount: form.kind === "insurance_coi" ? toNumber(form.coverage_amount) : null,
      effective_on: form.effective_on || null,
      expires_on: form.expires_on || null,
      is_required: form.is_required,
      document_id: current?.document_id ?? null,
      verified: form.verified,
      notes: blank(form.notes),
    };
    save.mutate(data, {
      onSuccess: (c) => {
        if (current) {
          toast.success("Credential updated");
          onOpenChange(false);
        } else {
          toast.success("Credential added. Attach the supporting document below.");
          setSaved(c);
          setForm(toForm(c));
        }
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={current ? "Edit credential" : "Add credential"}
      description={
        current ? (
          <span className="flex items-center gap-2">
            {CREDENTIAL_LABELS[current.kind] ?? titleCase(current.kind)} · {current.name} <CredentialStatusBadge status={current.status} />
          </span>
        ) : (
          "Licenses, certificates of insurance and tax forms. Required credentials gate vendor assignments."
        )
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{saved ? "Done" : "Cancel"}</Button>
          <Button variant="primary" type="submit" form="credential-form" loading={save.isPending}>
            {current ? "Save changes" : "Add credential"}
          </Button>
        </>
      }
    >
      <form id="credential-form" onSubmit={submit} className="space-y-6">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind" required>
            <Select
              value={form.kind}
              onChange={(e) => set("kind", e.target.value)}
              options={CREDENTIAL_KINDS.map((k) => ({ value: k, label: CREDENTIAL_LABELS[k] ?? titleCase(k) }))}
            />
          </Field>
          <Field label="Name" required>
            <Input {...bind("name")} required placeholder={form.kind === "license" ? "e.g. TX roofing contractor" : "e.g. General liability COI"} />
          </Field>
          <Field label={form.kind === "insurance_coi" ? "Policy number" : "Number"}>
            <Input {...bind("number")} />
          </Field>
          <Field label={form.kind === "insurance_coi" ? "Carrier" : "Issuer"}>
            <Input {...bind("issuer")} />
          </Field>
          {form.kind === "insurance_coi" && (
            <Field label="Coverage amount ($)" className="col-span-2">
              <Input {...bind("coverage_amount")} inputMode="decimal" />
            </Field>
          )}
          <Field label="Effective">
            <Input type="date" {...bind("effective_on")} />
          </Field>
          <Field label="Expires" hint="Alerts are raised ahead of expiry by the expiration scan">
            <Input type="date" {...bind("expires_on")} />
          </Field>
          <Field label="Notes" className="col-span-2">
            <Textarea {...bind("notes")} />
          </Field>
        </div>

        <section className="space-y-2.5 rounded-lg border border-line bg-subtle/60 p-3">
          <label className="flex items-start gap-2 text-sm text-ink-2">
            <Checkbox checked={form.is_required} onChange={(v) => set("is_required", v)} className="mt-0.5" />
            <span>
              Required
              <span className="block text-xs text-ink-3">When a required credential expires the vendor is blocked until it is renewed.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink-2">
            <Checkbox checked={form.verified} onChange={(v) => set("verified", v)} className="mt-0.5" />
            <span>
              Verified against the source document
              {current?.verified_at && <span className="block text-xs text-ink-3">Verified {formatDateTime(current.verified_at)}</span>}
            </span>
          </label>
        </section>
      </form>

      {current && (
        <section className="mt-6 space-y-3 border-t border-line pt-5">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Documents</h4>
          <RecordDocuments entityType="vendor_credential" entityId={current.id} />
        </section>
      )}
    </Sheet>
  );
}
