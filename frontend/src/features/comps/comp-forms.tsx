"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { titleCase, toNumber } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/features/properties/api";

import { TENANT_CREDIT, TENANT_CREDIT_LABELS, VERIFICATION_METHODS, useSaveComp, useVerifyComp, type CompKind, type LeaseComp, type SaleComp } from "./api";

type FormState = Record<string, string>;

const COMMON_TEXT = ["name", "address_line", "city", "state", "county", "corridor", "property_type", "tenant_name", "tenant_credit", "condition", "source", "document_id", "notes"];
const COMMON_NUM = ["latitude", "longitude", "building_area_sf", "land_area_acres", "year_built"];
const SALE_TEXT = ["sale_date", "buyer_name", "seller_name", "financing"];
const SALE_NUM = ["sale_price", "price_psf", "price_per_acre", "cap_rate", "noi", "lease_term_remaining_years", "occupancy_pct"];
const LEASE_TEXT = ["suite", "lease_type", "commencement_on", "escalation_structure", "recovery_type", "concessions"];
const LEASE_NUM = ["term_months", "area_sf", "base_rent_psf", "escalation_pct", "recoveries_psf", "free_rent_months", "ti_psf", "effective_rent_psf"];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function toForm(kind: CompKind, c?: SaleComp | LeaseComp | null): FormState {
  const keys = [...COMMON_TEXT, ...COMMON_NUM, ...(kind === "sale" ? [...SALE_TEXT, ...SALE_NUM] : [...LEASE_TEXT, ...LEASE_NUM]), "property_id"];
  const s: FormState = { tags: "" };
  for (const k of keys) {
    const v = c ? (c as unknown as Record<string, unknown>)[k] : null;
    s[k] = v === null || v === undefined ? "" : String(v);
  }
  if (c) s.tags = c.tags.join(", ");
  return s;
}

/** Create / edit a sale or lease comp. Linking a known property fills location and physical facts server-side. */
export function CompFormSheet({
  kind,
  open,
  onOpenChange,
  comp,
}: {
  kind: CompKind;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  comp?: SaleComp | LeaseComp | null;
}) {
  const [form, setForm] = useState<FormState>(toForm(kind, comp));
  const [verify, setVerify] = useState({ verified: false, method: "", notes: "" });
  const save = useSaveComp(kind, comp?.id);

  useEffect(() => {
    if (open) {
      setForm(toForm(kind, comp));
      setVerify({ verified: false, method: "", notes: "" });
    }
  }, [open, kind, comp]);

  const bind = (key: string) => ({
    id: key,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = [...COMMON_TEXT, ...(kind === "sale" ? SALE_TEXT : LEASE_TEXT)];
    const nums = [...COMMON_NUM, ...(kind === "sale" ? SALE_NUM : LEASE_NUM)];
    const data: Record<string, unknown> = {};
    for (const k of text) {
      const v = form[k]?.trim() ?? "";
      if (comp || v) data[k] = v === "" ? null : v;
    }
    for (const k of nums) {
      const n = toNumber(form[k] ?? "");
      if (comp || n !== null) data[k] = n;
    }
    data.property_id = form.property_id || null;
    data.tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (!comp && verify.verified) data.verification = { status: "verified", method: verify.method || null, notes: verify.notes || null };
    save.mutate(data, {
      onSuccess: () => {
        toast.success(comp ? "Comp updated" : "Comp added");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const typeOptions = PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }));
  const creditOptions = TENANT_CREDIT.map((t) => ({ value: t, label: TENANT_CREDIT_LABELS[t] }));

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={comp ? "Edit comp" : kind === "sale" ? "New sale comp" : "New lease comp"}
      description={comp?.verification_status === "verified" ? "Changing a material fact returns this comp to unverified." : "Link the property when it is already in the system."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="comp-form" loading={save.isPending}>
            {comp ? "Save changes" : "Add comp"}
          </Button>
        </>
      }
    >
      <form id="comp-form" onSubmit={submit} className="space-y-6">
        <Section title="Property">
          <Field label="Linked property" className="col-span-2" hint="Location, type, size and year built are copied when left blank.">
            <PropertyPicker value={form.property_id || null} onChange={(id) => setForm((f) => ({ ...f, property_id: id ?? "" }))} />
          </Field>
          <Field label="Name" htmlFor="name">
            <Input {...bind("name")} />
          </Field>
          <Field label="Property type" htmlFor="property_type">
            <Select {...bind("property_type")} options={typeOptions} placeholder="Select" />
          </Field>
          <Field label="Address" htmlFor="address_line" className="col-span-2">
            <Input {...bind("address_line")} />
          </Field>
          <Field label="City" htmlFor="city">
            <Input {...bind("city")} />
          </Field>
          <Field label="State" htmlFor="state">
            <Input {...bind("state")} />
          </Field>
          <Field label="County" htmlFor="county">
            <Input {...bind("county")} />
          </Field>
          <Field label="Corridor" htmlFor="corridor">
            <Input {...bind("corridor")} />
          </Field>
          <Field label="Latitude" htmlFor="latitude">
            <Input inputMode="decimal" {...bind("latitude")} />
          </Field>
          <Field label="Longitude" htmlFor="longitude">
            <Input inputMode="decimal" {...bind("longitude")} />
          </Field>
          <Field label="Building SF" htmlFor="building_area_sf">
            <Input inputMode="decimal" {...bind("building_area_sf")} />
          </Field>
          <Field label="Land acres" htmlFor="land_area_acres">
            <Input inputMode="decimal" {...bind("land_area_acres")} />
          </Field>
          <Field label="Year built" htmlFor="year_built">
            <Input inputMode="numeric" {...bind("year_built")} />
          </Field>
          <Field label="Condition" htmlFor="condition">
            <Select {...bind("condition")} placeholder="Select" options={["excellent", "good", "average", "fair", "poor"].map((v) => ({ value: v, label: titleCase(v) }))} />
          </Field>
        </Section>

        <Section title="Tenant">
          <Field label="Tenant" htmlFor="tenant_name">
            <Input {...bind("tenant_name")} />
          </Field>
          <Field label="Tenant credit" htmlFor="tenant_credit">
            <Select {...bind("tenant_credit")} options={creditOptions} placeholder="Select" />
          </Field>
        </Section>

        {kind === "sale" ? (
          <Section title="Sale">
            <Field label="Sale date" htmlFor="sale_date">
              <Input type="date" {...bind("sale_date")} />
            </Field>
            <Field label="Sale price" htmlFor="sale_price">
              <Input inputMode="decimal" {...bind("sale_price")} />
            </Field>
            <Field label="Price per SF" htmlFor="price_psf" hint="Derived from price and SF when blank">
              <Input inputMode="decimal" {...bind("price_psf")} />
            </Field>
            <Field label="Price per acre" htmlFor="price_per_acre">
              <Input inputMode="decimal" {...bind("price_per_acre")} />
            </Field>
            <Field label="Cap rate (%)" htmlFor="cap_rate">
              <Input inputMode="decimal" {...bind("cap_rate")} />
            </Field>
            <Field label="NOI" htmlFor="noi">
              <Input inputMode="decimal" {...bind("noi")} />
            </Field>
            <Field label="Buyer" htmlFor="buyer_name">
              <Input {...bind("buyer_name")} />
            </Field>
            <Field label="Seller" htmlFor="seller_name">
              <Input {...bind("seller_name")} />
            </Field>
            <Field label="Financing" htmlFor="financing">
              <Input {...bind("financing")} placeholder="e.g. All cash, 60% LTV bank loan" />
            </Field>
            <Field label="Lease term remaining (yrs)" htmlFor="lease_term_remaining_years">
              <Input inputMode="decimal" {...bind("lease_term_remaining_years")} />
            </Field>
            <Field label="Occupancy (%)" htmlFor="occupancy_pct">
              <Input inputMode="decimal" {...bind("occupancy_pct")} />
            </Field>
          </Section>
        ) : (
          <Section title="Lease">
            <Field label="Suite" htmlFor="suite">
              <Input {...bind("suite")} />
            </Field>
            <Field label="Lease type" htmlFor="lease_type">
              <Select {...bind("lease_type")} placeholder="Select" options={["new", "renewal", "expansion", "sublease"].map((v) => ({ value: v, label: titleCase(v) }))} />
            </Field>
            <Field label="Commencement" htmlFor="commencement_on">
              <Input type="date" {...bind("commencement_on")} />
            </Field>
            <Field label="Term (months)" htmlFor="term_months">
              <Input inputMode="numeric" {...bind("term_months")} />
            </Field>
            <Field label="Area SF" htmlFor="area_sf">
              <Input inputMode="decimal" {...bind("area_sf")} />
            </Field>
            <Field label="Base rent ($/SF/yr)" htmlFor="base_rent_psf">
              <Input inputMode="decimal" {...bind("base_rent_psf")} />
            </Field>
            <Field label="Escalation (%/yr)" htmlFor="escalation_pct">
              <Input inputMode="decimal" {...bind("escalation_pct")} />
            </Field>
            <Field label="Escalation structure" htmlFor="escalation_structure">
              <Input {...bind("escalation_structure")} placeholder="e.g. 10% every 5 years" />
            </Field>
            <Field label="Recoveries" htmlFor="recovery_type">
              <Select {...bind("recovery_type")} placeholder="Select" options={["nnn", "absolute_net", "modified_gross", "gross", "base_year"].map((v) => ({ value: v, label: titleCase(v) }))} />
            </Field>
            <Field label="Recoveries ($/SF/yr)" htmlFor="recoveries_psf">
              <Input inputMode="decimal" {...bind("recoveries_psf")} />
            </Field>
            <Field label="Free rent (months)" htmlFor="free_rent_months">
              <Input inputMode="decimal" {...bind("free_rent_months")} />
            </Field>
            <Field label="TI ($/SF)" htmlFor="ti_psf">
              <Input inputMode="decimal" {...bind("ti_psf")} />
            </Field>
            <Field label="Effective rent ($/SF/yr)" htmlFor="effective_rent_psf" hint="Calculated from rent, escalations, free rent and TI when blank" className="col-span-2">
              <Input inputMode="decimal" {...bind("effective_rent_psf")} />
            </Field>
            <Field label="Other concessions" htmlFor="concessions" className="col-span-2">
              <Textarea rows={2} {...bind("concessions")} />
            </Field>
          </Section>
        )}

        <Section title="Evidence">
          <Field label="Source" htmlFor="source">
            <Input {...bind("source")} placeholder="e.g. CoStar, broker call, deed" />
          </Field>
          <Field label="Document id" htmlFor="document_id" hint="Supporting document from Documents">
            <Input {...bind("document_id")} placeholder="UUID" />
          </Field>
          <Field label="Tags" htmlFor="tags" className="col-span-2">
            <Input {...bind("tags")} placeholder="Comma separated" />
          </Field>
          <Field label="Notes" htmlFor="notes" className="col-span-2">
            <Textarea {...bind("notes")} />
          </Field>
          {!comp && (
            <div className="col-span-2 space-y-2 rounded-md border border-line bg-subtle/50 p-3">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={verify.verified} onChange={(e) => setVerify((v) => ({ ...v, verified: e.target.checked }))} />
                I verified this comp
              </label>
              {verify.verified && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Verification method" required>
                    <Select value={verify.method} onChange={(e) => setVerify((v) => ({ ...v, method: e.target.value }))} placeholder="Select" options={VERIFICATION_METHODS.map((m) => ({ value: m, label: titleCase(m) }))} />
                  </Field>
                  <Field label="Notes">
                    <Input value={verify.notes} onChange={(e) => setVerify((v) => ({ ...v, notes: e.target.value }))} />
                  </Field>
                </div>
              )}
            </div>
          )}
        </Section>
      </form>
    </Sheet>
  );
}

/** Record verification method, user and date (or dispute / reset) for a comp. */
export function VerifyCompDialog({
  kind,
  comp,
  open,
  onOpenChange,
}: {
  kind: CompKind;
  comp: { id: string; verification_status: string } | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const verify = useVerifyComp(kind);
  const [state, setState] = useState({ status: "verified", method: "", notes: "" });

  useEffect(() => {
    if (open) setState({ status: "verified", method: "", notes: "" });
  }, [open]);

  const submit = () => {
    if (!comp) return;
    verify.mutate(
      { id: comp.id, status: state.status, method: state.method || null, notes: state.notes || null },
      {
        onSuccess: () => {
          toast.success("Verification recorded");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record verification"
      description="The method, your name and today&apos;s date are stored with the comp."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={verify.isPending} disabled={state.status === "verified" && !state.method} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Outcome">
          <Select
            value={state.status}
            onChange={(e) => setState((s) => ({ ...s, status: e.target.value }))}
            options={[
              { value: "verified", label: "Verified" },
              { value: "disputed", label: "Disputed" },
              { value: "unverified", label: "Reset to unverified" },
            ]}
          />
        </Field>
        <Field label="Method" required={state.status === "verified"}>
          <Select value={state.method} onChange={(e) => setState((s) => ({ ...s, method: e.target.value }))} placeholder="Select" options={VERIFICATION_METHODS.map((m) => ({ value: m, label: titleCase(m) }))} />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} value={state.notes} onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))} placeholder="Who confirmed it and what was confirmed" />
        </Field>
      </div>
    </Dialog>
  );
}
