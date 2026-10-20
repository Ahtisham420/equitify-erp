"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { titleCase, toNumber } from "@/lib/utils";

import { PROPERTY_STATUSES, PROPERTY_TYPE_LABELS, PROPERTY_TYPES, useSaveProperty, type Property, type PropertyInput } from "./api";

type FormState = Record<string, string>;

const TEXT_FIELDS = [
  "name", "address_line", "city", "state", "postal_code", "county", "property_type", "property_subtype",
  "construction_class", "status", "last_sale_date", "zoning", "future_land_use", "flood_zone", "corridor", "notes",
] as const;
const NUMBER_FIELDS = [
  "latitude", "longitude", "building_area_sf", "land_area_acres", "year_built", "year_renovated", "parking_spaces",
  "asking_price", "last_sale_price", "occupancy_pct", "wale_years", "noi", "traffic_count",
] as const;

function toForm(p?: Property | null): FormState {
  const s: FormState = { property_type: "other", status: "tracked", tags: "" };
  if (!p) return s;
  for (const k of [...TEXT_FIELDS, ...NUMBER_FIELDS]) {
    const v = (p as unknown as Record<string, unknown>)[k];
    s[k] = v === null || v === undefined ? "" : String(v);
  }
  s.tags = p.tags.join(", ");
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

export function PropertyFormSheet({
  open,
  onOpenChange,
  property,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  property?: Property | null;
  onSaved?: (p: Property) => void;
}) {
  const { can } = useAuth();
  const [form, setForm] = useState<FormState>(toForm(property));
  const [source, setSource] = useState({ source: "Manual entry", observed_on: "", confidence: "80", verified: false });
  const [duplicates, setDuplicates] = useState<{ id: string; address_line: string; city: string | null; status: string }[]>([]);
  const save = useSaveProperty(property?.id);

  useEffect(() => {
    if (open) {
      setForm(toForm(property));
      setDuplicates([]);
    }
  }, [open, property]);

  const bind = (key: string) => ({
    id: key,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const buildPayload = (): PropertyInput => {
    const data: Record<string, unknown> = {};
    for (const k of TEXT_FIELDS) {
      const v = form[k]?.trim() ?? "";
      if (property || v) data[k] = v === "" ? null : v;
    }
    for (const k of NUMBER_FIELDS) {
      const n = toNumber(form[k] ?? "");
      if (property || n !== null) data[k] = n;
    }
    data.address_line = form.address_line?.trim();
    data.property_type = form.property_type || "other";
    data.status = form.status || "tracked";
    data.tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    data.provenance = {
      source: source.source.trim() || "Manual entry",
      observed_on: source.observed_on || null,
      confidence: Math.min(100, Math.max(0, Number(source.confidence) || 0)) / 100,
      verified: source.verified,
    };
    return data as PropertyInput;
  };

  const submit = (e: FormEvent, force = false) => {
    e.preventDefault();
    save.mutate(
      { data: buildPayload(), force },
      {
        onSuccess: (p) => {
          toast.success(property ? "Property updated" : "Property created");
          onOpenChange(false);
          onSaved?.(p);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409 && err.detail && typeof err.detail === "object") {
            setDuplicates((err.detail as { duplicates?: typeof duplicates }).duplicates ?? []);
          } else toast.error(errorMessage(err));
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={property ? "Edit property" : "New property"}
      description={property ? property.address_line : "Address is normalized and checked for duplicates on save."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="property-form" loading={save.isPending}>
            {property ? "Save changes" : "Create property"}
          </Button>
        </>
      }
    >
      <form id="property-form" onSubmit={(e) => submit(e)} className="space-y-6">
        {duplicates.length > 0 && (
          <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
            <p className="font-medium text-caution">Possible duplicate</p>
            <p className="mt-0.5 text-ink-2">A property with this address already exists:</p>
            <ul className="mt-2 space-y-1">
              {duplicates.map((d) => (
                <li key={d.id}>
                  <Link href={`/properties/${d.id}`} className="font-medium text-accent hover:underline">
                    {d.address_line}
                    {d.city ? `, ${d.city}` : ""}
                  </Link>{" "}
                  <span className="text-ink-3">· {titleCase(d.status)}</span>
                </li>
              ))}
            </ul>
            {can("properties", "approve") && (
              <Button size="sm" className="mt-3" onClick={(e) => submit(e as unknown as FormEvent, true)}>
                Create anyway
              </Button>
            )}
          </div>
        )}

        <Section title="Identity">
          <Field label="Property name" className="col-span-2">
            <Input {...bind("name")} placeholder="e.g. Walgreens – Main & 5th" />
          </Field>
          <Field label="Street address" required className="col-span-2">
            <Input {...bind("address_line")} required />
          </Field>
          <Field label="City"><Input {...bind("city")} /></Field>
          <Field label="State"><Input {...bind("state")} maxLength={40} /></Field>
          <Field label="Postal code"><Input {...bind("postal_code")} /></Field>
          <Field label="County"><Input {...bind("county")} /></Field>
          <Field label="Latitude"><Input {...bind("latitude")} inputMode="decimal" /></Field>
          <Field label="Longitude"><Input {...bind("longitude")} inputMode="decimal" /></Field>
        </Section>

        <Section title="Classification">
          <Field label="Property type">
            <Select {...bind("property_type")} options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }))} />
          </Field>
          <Field label="Status">
            <Select {...bind("status")} options={PROPERTY_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Subtype"><Input {...bind("property_subtype")} /></Field>
          <Field label="Construction class"><Input {...bind("construction_class")} placeholder="A / B / C" /></Field>
        </Section>

        <Section title="Physical">
          <Field label="Building area (SF)"><Input {...bind("building_area_sf")} inputMode="decimal" /></Field>
          <Field label="Land area (acres)"><Input {...bind("land_area_acres")} inputMode="decimal" /></Field>
          <Field label="Year built"><Input {...bind("year_built")} inputMode="numeric" /></Field>
          <Field label="Year renovated"><Input {...bind("year_renovated")} inputMode="numeric" /></Field>
          <Field label="Parking spaces"><Input {...bind("parking_spaces")} inputMode="numeric" /></Field>
        </Section>

        <Section title="Market & income">
          <Field label="Asking price ($)"><Input {...bind("asking_price")} inputMode="decimal" /></Field>
          <Field label="NOI ($)"><Input {...bind("noi")} inputMode="decimal" /></Field>
          <Field label="Last sale price ($)"><Input {...bind("last_sale_price")} inputMode="decimal" /></Field>
          <Field label="Last sale date"><Input type="date" {...bind("last_sale_date")} /></Field>
          <Field label="Occupancy (%)"><Input {...bind("occupancy_pct")} inputMode="decimal" /></Field>
          <Field label="WALE (years)"><Input {...bind("wale_years")} inputMode="decimal" /></Field>
        </Section>

        <Section title="Site & location">
          <Field label="Zoning"><Input {...bind("zoning")} /></Field>
          <Field label="Future land use"><Input {...bind("future_land_use")} /></Field>
          <Field label="Flood zone"><Input {...bind("flood_zone")} /></Field>
          <Field label="Traffic count (VPD)"><Input {...bind("traffic_count")} inputMode="numeric" /></Field>
          <Field label="Corridor" className="col-span-2"><Input {...bind("corridor")} /></Field>
          <Field label="Tags" hint="Comma separated" className="col-span-2"><Input {...bind("tags")} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>

        <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
          <div>
            <h4 className="text-sm font-medium">Source of these facts</h4>
            <p className="text-xs text-ink-3">Changed material fields keep this source, date and confidence in their history.</p>
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
            <Checkbox checked={source.verified} onChange={(v) => setSource((s) => ({ ...s, verified: v }))} />
            I verified these values against the source
          </label>
        </section>
      </form>
    </Sheet>
  );
}
