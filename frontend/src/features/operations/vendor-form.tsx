"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Tooltip } from "@/components/ui/misc";
import { OrganizationPicker } from "@/features/contacts/pickers";
import { errorMessage } from "@/lib/api";
import { cn, titleCase, toNumber } from "@/lib/utils";

import { VENDOR_SERVICES, VENDOR_STATUSES, useSaveVendor, type Vendor, type VendorInput } from "./api";

/* ------------------------------------------------------------------ shared bits */

export function VendorStatusBadge({ status }: { status: string }) {
  if (status === "suspended") {
    return (
      <Badge tone="red" dot>
        Suspended
      </Badge>
    );
  }
  return <StatusBadge status={status} />;
}

/** Green "Compliant" or red "Blocked" with the blocking reasons in a tooltip. */
export function ComplianceBadge({ compliant, reasons }: { compliant: boolean | null | undefined; reasons: string[] }) {
  if (compliant === null || compliant === undefined) return <span className="text-ink-3">—</span>;
  if (compliant) {
    return (
      <Badge tone="green" dot>
        Compliant
      </Badge>
    );
  }
  return (
    <Tooltip
      content={
        reasons.length ? (
          <ul className="space-y-0.5">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          "Not compliant"
        )
      }
    >
      <span className="inline-flex">
        <Badge tone="red" dot>
          Blocked
        </Badge>
      </span>
    </Tooltip>
  );
}

export function serviceLabel(s: string): string {
  return s === "hvac" ? "HVAC" : titleCase(s);
}

const RATE_UNITS = ["hour", "visit", "sf", "job"];

interface ContactRow { name: string; role: string; email: string; phone: string }
interface RateRow { service: string; unit: string; rate: string; notes: string }
interface ContractRow { title: string; start_on: string; end_on: string; value: string; document_id: string | null }

interface FormState {
  name: string;
  organization_id: string | null;
  status: string;
  services: string[];
  primary_contact_name: string;
  email: string;
  phone: string;
  address: string;
  service_area: string;
  requires_insurance: boolean;
  requires_license: boolean;
  contacts: ContactRow[];
  rates: RateRow[];
  contracts: ContractRow[];
  tags: string;
  notes: string;
}

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const blank = (v: string) => (v.trim() === "" ? null : v.trim());

function toForm(v?: Vendor | null): FormState {
  return {
    name: v?.name ?? "",
    organization_id: v?.organization_id ?? null,
    status: v?.status ?? "active",
    services: v?.services ?? [],
    primary_contact_name: s(v?.primary_contact_name),
    email: s(v?.email),
    phone: s(v?.phone),
    address: s(v?.address),
    service_area: s(v?.service_area),
    requires_insurance: v ? v.requires_insurance : true,
    requires_license: v ? v.requires_license : false,
    contacts: (v?.contacts ?? []).map((c) => ({ name: s(c.name), role: s(c.role), email: s(c.email), phone: s(c.phone) })),
    rates: (v?.rates ?? []).map((r) => ({ service: s(r.service), unit: s(r.unit), rate: s(r.rate), notes: s(r.notes) })),
    contracts: (v?.contracts ?? []).map((c) => ({
      title: s(c.title),
      start_on: s(c.start_on),
      end_on: s(c.end_on),
      value: s(c.value),
      document_id: c.document_id ?? null,
    })),
    tags: (v?.tags ?? []).join(", "),
    notes: s(v?.notes),
  };
}

function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RowsEditor<T>({
  rows,
  onChange,
  blankRow,
  render,
  addLabel,
  empty,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  blankRow: T;
  render: (row: T, set: (patch: Partial<T>) => void) => ReactNode;
  addLabel: string;
  empty: string;
}) {
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-xs text-ink-3">{empty}</p>}
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-2 rounded-md border border-line bg-subtle/50 p-2">
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
            {render(row, (patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))))}
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Remove row" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { ...blankRow }])}>
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ sheet */

export function VendorFormSheet({
  open,
  onOpenChange,
  vendor,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vendor?: Vendor | null;
  onSaved?: (v: Vendor) => void;
}) {
  const [form, setForm] = useState<FormState>(toForm(vendor));
  const [otherService, setOtherService] = useState("");
  const save = useSaveVendor(vendor?.id);

  useEffect(() => {
    if (open) {
      setForm(toForm(vendor));
      setOtherService("");
    }
  }, [open, vendor]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const text = (key: "name" | "primary_contact_name" | "email" | "phone" | "address" | "service_area" | "tags" | "notes") => ({
    id: `vendor-${key}`,
    value: form[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
  });

  const toggleService = (svc: string) =>
    set("services", form.services.includes(svc) ? form.services.filter((x) => x !== svc) : [...form.services, svc]);

  const addOtherService = () => {
    const v = otherService.trim().toLowerCase().replace(/\s+/g, "_");
    if (!v) return;
    if (!form.services.includes(v)) set("services", [...form.services, v]);
    setOtherService("");
  };

  const custom = form.services.filter((x) => !(VENDOR_SERVICES as readonly string[]).includes(x));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Vendor name is required");
      return;
    }
    const badContract = form.contracts.find((c) => c.title.trim() && c.start_on && c.end_on && c.end_on < c.start_on);
    if (badContract) {
      toast.error(`Contract "${badContract.title}" ends before it starts`);
      return;
    }
    const data: VendorInput = {
      name: form.name.trim(),
      organization_id: form.organization_id,
      services: form.services,
      status: form.status,
      primary_contact_name: blank(form.primary_contact_name),
      email: blank(form.email),
      phone: blank(form.phone),
      address: blank(form.address),
      service_area: blank(form.service_area),
      requires_insurance: form.requires_insurance,
      requires_license: form.requires_license,
      contacts: form.contacts
        .filter((c) => c.name.trim())
        .map((c) => ({ name: c.name.trim(), role: blank(c.role), email: blank(c.email), phone: blank(c.phone) })),
      rates: form.rates
        .filter((r) => r.service.trim())
        .map((r) => ({ service: r.service.trim(), unit: blank(r.unit), rate: toNumber(r.rate), notes: blank(r.notes) })),
      contracts: form.contracts
        .filter((c) => c.title.trim())
        .map((c) => ({
          title: c.title.trim(),
          start_on: c.start_on || null,
          end_on: c.end_on || null,
          value: toNumber(c.value),
          document_id: c.document_id,
        })),
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      notes: blank(form.notes),
    };
    save.mutate(data, {
      onSuccess: (v) => {
        toast.success(vendor ? "Vendor updated" : "Vendor created");
        onOpenChange(false);
        onSaved?.(v);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={vendor ? "Edit vendor" : "New vendor"}
      description={vendor ? vendor.name : "Service provider profile, credentials requirements, rates and contracts."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="vendor-form" loading={save.isPending}>
            {vendor ? "Save changes" : "Create vendor"}
          </Button>
        </>
      }
    >
      <form id="vendor-form" onSubmit={submit} className="space-y-6">
        <Section title="Identity">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vendor name" required className="col-span-2">
              <Input {...text("name")} required placeholder="e.g. Lone Star Roofing" />
            </Field>
            <Field label="Organization" hint="Link to the company record in contacts">
              <OrganizationPicker value={form.organization_id} onChange={(id) => set("organization_id", id)} />
            </Field>
            <Field label="Status">
              <Select
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
                options={VENDOR_STATUSES.map((v) => ({ value: v, label: titleCase(v) }))}
              />
            </Field>
          </div>
        </Section>

        <Section title="Services" description="Select every service this vendor provides.">
          <div className="flex flex-wrap gap-1.5">
            {VENDOR_SERVICES.map((svc) => {
              const on = form.services.includes(svc);
              return (
                <button
                  key={svc}
                  type="button"
                  onClick={() => toggleService(svc)}
                  aria-pressed={on}
                  className={cn(
                    "inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium transition-colors",
                    on ? "border-accent/30 bg-accent-soft text-accent-ink" : "border-line-strong/80 bg-surface text-ink-2 hover:bg-subtle hover:text-ink",
                  )}
                >
                  {serviceLabel(svc)}
                </button>
              );
            })}
            {custom.map((svc) => (
              <span key={svc} className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/30 bg-accent-soft pl-2 pr-1 text-xs font-medium text-accent-ink">
                {serviceLabel(svc)}
                <button type="button" onClick={() => toggleService(svc)} className="rounded p-0.5 hover:bg-surface/60" aria-label={`Remove ${svc}`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={otherService}
              onChange={(e) => setOtherService(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addOtherService();
                }
              }}
              placeholder="Add another service"
            />
            <Button onClick={addOtherService} disabled={!otherService.trim()}>
              Add
            </Button>
          </div>
        </Section>

        <Section title="Primary contact">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact name"><Input {...text("primary_contact_name")} /></Field>
            <Field label="Phone"><Input {...text("phone")} type="tel" /></Field>
            <Field label="Email" className="col-span-2"><Input {...text("email")} type="email" /></Field>
            <Field label="Address" className="col-span-2"><Input {...text("address")} /></Field>
            <Field label="Service area" className="col-span-2" hint="Markets, counties or radius this vendor covers">
              <Input {...text("service_area")} />
            </Field>
          </div>
        </Section>

        <section className="space-y-2.5 rounded-lg border border-line bg-subtle/60 p-3">
          <div>
            <h4 className="text-sm font-medium">Compliance requirements</h4>
            <p className="text-xs text-ink-3">
              These drive compliance. A vendor missing a current required certificate of insurance or license is blocked from work-order
              assignment, project awards and draw approvals until a valid credential is on file.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={form.requires_insurance} onChange={(v) => set("requires_insurance", v)} />
            Requires a current certificate of insurance
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={form.requires_license} onChange={(v) => set("requires_license", v)} />
            Requires a current license
          </label>
        </section>

        <Section title="Additional contacts">
          <RowsEditor<ContactRow>
            rows={form.contacts}
            onChange={(rows) => set("contacts", rows)}
            blankRow={{ name: "", role: "", email: "", phone: "" }}
            addLabel="Add contact"
            empty="No additional contacts."
            render={(c, patch) => (
              <>
                <Input value={c.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name" aria-label="Contact name" />
                <Input value={c.role} onChange={(e) => patch({ role: e.target.value })} placeholder="Role" aria-label="Contact role" />
                <Input value={c.email} onChange={(e) => patch({ email: e.target.value })} placeholder="Email" type="email" aria-label="Contact email" />
                <Input value={c.phone} onChange={(e) => patch({ phone: e.target.value })} placeholder="Phone" aria-label="Contact phone" />
              </>
            )}
          />
        </Section>

        <Section title="Rates">
          <RowsEditor<RateRow>
            rows={form.rates}
            onChange={(rows) => set("rates", rows)}
            blankRow={{ service: "", unit: "", rate: "", notes: "" }}
            addLabel="Add rate"
            empty="No rates recorded."
            render={(r, patch) => (
              <>
                <Input value={r.service} onChange={(e) => patch({ service: e.target.value })} placeholder="Service" aria-label="Rate service" />
                <Select
                  value={r.unit}
                  onChange={(e) => patch({ unit: e.target.value })}
                  placeholder="Unit"
                  aria-label="Rate unit"
                  options={RATE_UNITS.map((u) => ({ value: u, label: u === "sf" ? "Per SF" : `Per ${u}` }))}
                />
                <Input value={r.rate} onChange={(e) => patch({ rate: e.target.value })} placeholder="Rate ($)" inputMode="decimal" aria-label="Rate amount" />
                <Input value={r.notes} onChange={(e) => patch({ notes: e.target.value })} placeholder="Notes" aria-label="Rate notes" />
              </>
            )}
          />
        </Section>

        <Section title="Contracts" description="Attach executed contracts on the vendor documents tab.">
          <RowsEditor<ContractRow>
            rows={form.contracts}
            onChange={(rows) => set("contracts", rows)}
            blankRow={{ title: "", start_on: "", end_on: "", value: "", document_id: null }}
            addLabel="Add contract"
            empty="No contracts recorded."
            render={(c, patch) => (
              <>
                <Input value={c.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Title" aria-label="Contract title" className="col-span-2" />
                <Input type="date" value={c.start_on} onChange={(e) => patch({ start_on: e.target.value })} aria-label="Contract start" />
                <Input type="date" value={c.end_on} onChange={(e) => patch({ end_on: e.target.value })} aria-label="Contract end" />
                <Input value={c.value} onChange={(e) => patch({ value: e.target.value })} placeholder="Value ($)" inputMode="decimal" aria-label="Contract value" />
              </>
            )}
          />
        </Section>

        <Section title="Other">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tags" hint="Comma separated" className="col-span-2"><Input {...text("tags")} /></Field>
            <Field label="Notes" className="col-span-2"><Textarea {...text("notes")} /></Field>
          </div>
        </Section>
      </form>
    </Sheet>
  );
}
