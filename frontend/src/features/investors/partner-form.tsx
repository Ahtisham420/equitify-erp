"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Separator } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { titleCase } from "@/lib/utils";

import { OrganizationPicker, PersonPicker } from "@/features/contacts/pickers";

import { CHANNELS, FREQUENCIES, PACKAGE_LABELS, PACKAGE_TYPES, PARTNER_STATUSES, PARTNER_TYPES, useSavePartner, type Partner } from "./api";

interface FormState {
  name: string;
  type: string;
  status: string;
  organization_id: string | null;
  person_id: string | null;
  email: string;
  phone: string;
  portal_user_id: string | null;
  owner_id: string | null;
  reporting_requirements: string;
  frequency: string;
  packages: string[];
  delivery: string;
  channel: string;
  recipients: string;
  do_not_contact: boolean;
  comm_notes: string;
  notes: string;
  tags: string;
}

const toForm = (p?: Partner | null): FormState => ({
  name: p?.name ?? "",
  type: p?.type ?? "individual",
  status: p?.status ?? "active",
  organization_id: p?.organization_id ?? null,
  person_id: p?.person_id ?? null,
  email: p?.email ?? "",
  phone: p?.phone ?? "",
  portal_user_id: p?.portal_user_id ?? null,
  owner_id: p?.owner_id ?? null,
  reporting_requirements: p?.reporting_requirements ?? "",
  frequency: p?.reporting_prefs?.frequency ?? "quarterly",
  packages: p?.reporting_prefs?.packages ?? ["capital_accounts", "distributions"],
  delivery: p?.reporting_prefs?.delivery ?? "portal",
  channel: p?.communication_prefs?.channel ?? "email",
  recipients: (p?.communication_prefs?.recipients ?? []).join(", "),
  do_not_contact: !!p?.communication_prefs?.do_not_contact,
  comm_notes: p?.communication_prefs?.notes ?? "",
  notes: p?.notes ?? "",
  tags: (p?.tags ?? []).join(", "),
});

export function PartnerFormSheet({ open, onOpenChange, partner }: { open: boolean; onOpenChange: (o: boolean) => void; partner?: Partner | null }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(toForm(partner));
  const save = useSavePartner(partner?.id);

  useEffect(() => {
    if (open) setForm(toForm(partner));
  }, [open, partner]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        name: form.name.trim(),
        type: form.type,
        status: form.status,
        organization_id: form.organization_id,
        person_id: form.person_id,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        portal_user_id: form.portal_user_id,
        owner_id: form.owner_id,
        reporting_requirements: form.reporting_requirements.trim() || null,
        reporting_prefs: { frequency: form.frequency, packages: form.packages, delivery: form.delivery },
        communication_prefs: { channel: form.channel, recipients: list(form.recipients), do_not_contact: form.do_not_contact, notes: form.comm_notes.trim() || undefined },
        notes: form.notes.trim() || null,
        tags: list(form.tags),
      },
      {
        onSuccess: (p) => {
          toast.success(partner ? "Partner updated" : "Partner created");
          onOpenChange(false);
          if (!partner) router.push(`/investors/${p.id}`);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={partner ? "Edit capital partner" : "New capital partner"}
      description="Link the partner to the contact master so relationship history stays in one place."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="partner-form" loading={save.isPending}>
            {partner ? "Save changes" : "Create partner"}
          </Button>
        </>
      }
    >
      <form id="partner-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Name" required className="col-span-2">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. Harbor Family Office LP" />
        </Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => set("type", e.target.value)} options={PARTNER_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} />
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set("status", e.target.value)} options={PARTNER_STATUSES.map((t) => ({ value: t, label: titleCase(t) }))} />
        </Field>
        <Field label="Organization">
          <OrganizationPicker value={form.organization_id} onChange={(id) => set("organization_id", id)} />
        </Field>
        <Field label="Primary contact">
          <PersonPicker value={form.person_id} onChange={(id) => set("person_id", id)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="Relationship owner">
          <UserPicker value={form.owner_id} onChange={(id) => set("owner_id", id)} placeholder="Defaults to you" />
        </Field>
        <Field label="Portal user" hint="A user with the Capital Partner role; sees only this partner's accounts.">
          <UserPicker value={form.portal_user_id} onChange={(id) => set("portal_user_id", id)} placeholder="No portal access" />
        </Field>

        <Separator className="col-span-2 my-1" />
        <p className="col-span-2 text-xs font-medium uppercase tracking-wide text-ink-3">Reporting</p>
        <Field label="Frequency">
          <Select value={form.frequency} onChange={(e) => set("frequency", e.target.value)} options={FREQUENCIES.map((f) => ({ value: f, label: titleCase(f) }))} />
        </Field>
        <Field label="Delivery">
          <Select value={form.delivery} onChange={(e) => set("delivery", e.target.value)} options={CHANNELS.map((f) => ({ value: f, label: titleCase(f) }))} />
        </Field>
        <div className="col-span-2">
          <p className="mb-1.5 text-xs font-medium text-ink-2">Packages</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {PACKAGE_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm text-ink-2">
                <Checkbox checked={form.packages.includes(t)} onChange={(v) => set("packages", v ? [...form.packages, t] : form.packages.filter((x) => x !== t))} />
                {PACKAGE_LABELS[t]}
              </label>
            ))}
          </div>
        </div>
        <Field label="Reporting requirements" className="col-span-2">
          <Textarea value={form.reporting_requirements} onChange={(e) => set("reporting_requirements", e.target.value)} placeholder="e.g. Quarterly within 45 days; annual audited statements; K-1 by March 15" />
        </Field>

        <Separator className="col-span-2 my-1" />
        <p className="col-span-2 text-xs font-medium uppercase tracking-wide text-ink-3">Communication</p>
        <Field label="Preferred channel">
          <Select value={form.channel} onChange={(e) => set("channel", e.target.value)} options={CHANNELS.map((f) => ({ value: f, label: titleCase(f) }))} />
        </Field>
        <Field label="Recipients" hint="Comma-separated emails">
          <Input value={form.recipients} onChange={(e) => set("recipients", e.target.value)} />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={form.do_not_contact} onChange={(v) => set("do_not_contact", v)} />
          Do not contact outside required notices
        </label>
        <Field label="Communication notes" className="col-span-2">
          <Textarea rows={2} value={form.comm_notes} onChange={(e) => set("comm_notes", e.target.value)} />
        </Field>

        <Separator className="col-span-2 my-1" />
        <Field label="Tags" className="col-span-2" hint="Comma-separated">
          <Input value={form.tags} onChange={(e) => set("tags", e.target.value)} />
        </Field>
        <Field label="Internal notes" className="col-span-2">
          <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}
