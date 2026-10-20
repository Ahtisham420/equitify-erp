"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatNumber, titleCase, toNumber } from "@/lib/utils";
import { OrganizationPicker } from "@/features/contacts/pickers";

import { LEASE_STATUSES, LEASE_TYPE_LABELS, LEASE_TYPES, useSaveLease, useSpaceOptions, type Lease, type LeaseInput } from "./api";

type FormState = Record<string, string>;

const TEXT = ["tenant_name", "landlord_name", "premises_description", "status", "lease_type", "execution_on", "commencement_on", "rent_commencement_on", "expiration_on", "document_id", "notes"] as const;
const NUMS = [
  "rentable_sf", "pro_rata_share", "base_rent_annual", "security_deposit", "late_fee_grace_days", "late_fee_pct", "late_fee_flat",
  "market_rent_psf", "downtime_months", "releasing_cost_psf",
] as const;

function toForm(l?: Lease | null): FormState {
  const s: FormState = { status: "draft", lease_type: "nnn", tags: "", renewal_probability: "" };
  if (!l) return s;
  for (const k of [...TEXT, ...NUMS]) {
    const v = (l as unknown as Record<string, unknown>)[k];
    s[k] = v === null || v === undefined ? "" : String(v);
  }
  s.renewal_probability = l.renewal_probability != null ? String(Math.round(l.renewal_probability * 100)) : "";
  s.tags = l.tags.join(", ");
  return s;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

export function LeaseFormSheet({
  open,
  onOpenChange,
  lease,
  propertyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lease?: Lease | null;
  propertyId?: string;
  onSaved?: (l: Lease) => void;
}) {
  const [form, setForm] = useState<FormState>(toForm(lease));
  const [prop, setProp] = useState<string | null>(lease?.property_id ?? propertyId ?? null);
  const [spaceId, setSpaceId] = useState<string>(lease?.space_id ?? "");
  const [orgId, setOrgId] = useState<string | null>(lease?.tenant_organization_id ?? null);
  const [managerId, setManagerId] = useState<string | null>(lease?.manager_id ?? null);
  const [source, setSource] = useState({ source: "Lease abstract (manual)", observed_on: "", confidence: "90", verified: false, ai: false });
  const save = useSaveLease(lease?.id);
  const spaces = useSpaceOptions(prop);

  useEffect(() => {
    if (open) {
      setForm(toForm(lease));
      setProp(lease?.property_id ?? propertyId ?? null);
      setSpaceId(lease?.space_id ?? "");
      setOrgId(lease?.tenant_organization_id ?? null);
      setManagerId(lease?.manager_id ?? null);
    }
  }, [open, lease, propertyId]);

  const bind = (key: string) => ({
    id: key,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!prop) {
      toast.error("Choose a property");
      return;
    }
    const data: Record<string, unknown> = {};
    for (const k of TEXT) {
      const v = form[k]?.trim() ?? "";
      if (lease || v) data[k] = v === "" ? null : v;
    }
    for (const k of NUMS) {
      const n = toNumber(form[k] ?? "");
      if (lease || n !== null) data[k] = n;
    }
    const prob = toNumber(form.renewal_probability ?? "");
    data.renewal_probability = prob === null ? null : Math.min(100, Math.max(0, prob)) / 100;
    data.tenant_name = form.tenant_name.trim();
    data.status = form.status || "draft";
    data.lease_type = form.lease_type || "nnn";
    data.space_id = spaceId || null;
    data.tenant_organization_id = orgId;
    data.manager_id = managerId;
    data.tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (!lease) data.property_id = prop;
    data.provenance = {
      source: source.source.trim() || "Manual entry",
      observed_on: source.observed_on || null,
      confidence: Math.min(100, Math.max(0, Number(source.confidence) || 0)) / 100,
      verified: source.verified && !source.ai,
      ai_derived: source.ai,
    };
    save.mutate(data as LeaseInput, {
      onSuccess: (l) => {
        toast.success(lease ? "Lease updated" : "Lease created");
        onOpenChange(false);
        onSaved?.(l);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={lease ? "Edit lease abstract" : "New lease"}
      description={lease ? lease.tenant_name : "Abstract the lease. Material terms keep their source and history."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="lease-form" loading={save.isPending}>
            {lease ? "Save changes" : "Create lease"}
          </Button>
        </>
      }
    >
      <form id="lease-form" onSubmit={submit} className="space-y-6">
        <Section title="Parties & premises">
          {!lease && (
            <Field label="Property" required className="col-span-2">
              <PropertyPicker value={prop} onChange={(id) => { setProp(id); setSpaceId(""); }} />
            </Field>
          )}
          <Field label="Tenant name" required className="col-span-2">
            <Input {...bind("tenant_name")} required />
          </Field>
          <Field label="Tenant organization" className="col-span-2">
            <OrganizationPicker value={orgId} onChange={setOrgId} placeholder="Link organization (optional)" />
          </Field>
          <Field label="Landlord"><Input {...bind("landlord_name")} /></Field>
          <Field label="Space / suite">
            <Select
              value={spaceId}
              onChange={(e) => setSpaceId(e.target.value)}
              placeholder={prop ? "No space" : "Choose a property first"}
              disabled={!prop}
              options={(spaces.data ?? []).map((s) => ({ value: s.id, label: `Suite ${s.suite}${s.area_sf ? ` · ${formatNumber(s.area_sf)} SF` : ""}${s.tenant_name ? ` · ${s.tenant_name}` : ""}` }))}
            />
          </Field>
          <Field label="Premises description" className="col-span-2"><Textarea rows={2} {...bind("premises_description")} /></Field>
        </Section>

        <Section title="Term">
          <Field label="Status">
            <Select {...bind("status")} options={LEASE_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Lease type">
            <Select {...bind("lease_type")} options={LEASE_TYPES.map((t) => ({ value: t, label: LEASE_TYPE_LABELS[t] }))} />
          </Field>
          <Field label="Executed"><Input type="date" {...bind("execution_on")} /></Field>
          <Field label="Commencement"><Input type="date" {...bind("commencement_on")} /></Field>
          <Field label="Rent commencement"><Input type="date" {...bind("rent_commencement_on")} /></Field>
          <Field label="Expiration"><Input type="date" {...bind("expiration_on")} /></Field>
        </Section>

        <Section title="Economics">
          <Field label="Rentable SF"><Input inputMode="decimal" {...bind("rentable_sf")} /></Field>
          <Field label="Pro-rata share (%)"><Input inputMode="decimal" {...bind("pro_rata_share")} /></Field>
          <Field label="Base rent (annual $)"><Input inputMode="decimal" {...bind("base_rent_annual")} /></Field>
          <Field label="Security deposit ($)"><Input inputMode="decimal" {...bind("security_deposit")} /></Field>
          <Field label="Late fee grace (days)"><Input inputMode="numeric" {...bind("late_fee_grace_days")} /></Field>
          <Field label="Late fee (%)"><Input inputMode="decimal" {...bind("late_fee_pct")} /></Field>
          <Field label="Late fee flat ($)"><Input inputMode="decimal" {...bind("late_fee_flat")} /></Field>
        </Section>

        <Section title="Rollover assumptions">
          <Field label="Market rent ($/SF/yr)"><Input inputMode="decimal" {...bind("market_rent_psf")} /></Field>
          <Field label="Renewal probability (%)"><Input inputMode="decimal" {...bind("renewal_probability")} /></Field>
          <Field label="Downtime (months)"><Input inputMode="numeric" {...bind("downtime_months")} /></Field>
          <Field label="Re-leasing cost ($/SF)"><Input inputMode="decimal" {...bind("releasing_cost_psf")} /></Field>
        </Section>

        <Section title="Record">
          <Field label="Lease administrator" className="col-span-2"><UserPicker value={managerId} onChange={setManagerId} /></Field>
          <Field label="Source document ID" hint="Lease document in the document library" className="col-span-2"><Input {...bind("document_id")} /></Field>
          <Field label="Tags" hint="Comma separated" className="col-span-2"><Input {...bind("tags")} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>

        <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
          <div>
            <h4 className="text-sm font-medium">Source of these terms</h4>
            <p className="text-xs text-ink-3">Changed material terms keep this source, date and confidence. AI-extracted values stay unverified until a person verifies them.</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Source" className="col-span-3">
              <Input value={source.source} onChange={(e) => setSource((s) => ({ ...s, source: e.target.value }))} />
            </Field>
            <Field label="Observed on" className="col-span-2">
              <Input type="date" value={source.observed_on} onChange={(e) => setSource((s) => ({ ...s, observed_on: e.target.value }))} />
            </Field>
            <Field label="Confidence %">
              <Input inputMode="numeric" value={source.confidence} onChange={(e) => setSource((s) => ({ ...s, confidence: e.target.value }))} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={source.ai} onChange={(v) => setSource((s) => ({ ...s, ai: v, verified: v ? false : s.verified }))} />
            Values were extracted by AI
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={source.verified} onChange={(v) => setSource((s) => ({ ...s, verified: v && !s.ai }))} />
            I verified these terms against the executed lease
          </label>
        </section>
      </form>
    </Sheet>
  );
}
