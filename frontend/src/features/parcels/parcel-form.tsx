"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, toNumber } from "@/lib/utils";

import { useSaveParcel, type Parcel, type ParcelInput } from "./api";
import { GeometryField } from "./geometry-field";
import { parseGeoJson } from "./geojson";

type Dupe = { id: string; apn: string; county: string; situs_address: string | null; acreage: number | null };

const TEXT = ["county", "state", "apn", "situs_address", "legal_description", "source", "observed_on", "notes"] as const;

function toForm(p?: Parcel | null): Record<string, string> {
  const s: Record<string, string> = { acreage: "", facts: "", geometry: "" };
  for (const k of TEXT) s[k] = p ? String(p[k] ?? "") : "";
  if (p) {
    s.acreage = p.acreage != null ? String(p.acreage) : "";
    s.facts = Object.keys(p.facts ?? {}).length ? JSON.stringify(p.facts, null, 2) : "";
  }
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

export function ParcelFormSheet({
  open,
  onOpenChange,
  parcel,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  parcel?: Parcel | null;
  onSaved?: (p: Parcel) => void;
}) {
  const { can } = useAuth();
  const save = useSaveParcel(parcel?.id);
  const [form, setForm] = useState(toForm(parcel));
  const [clearGeometry, setClearGeometry] = useState(false);
  const [prov, setProv] = useState({ source: "", observed_on: "", confidence: "80", verified: false });
  const [duplicates, setDuplicates] = useState<Dupe[]>([]);

  useEffect(() => {
    if (open) {
      setForm(toForm(parcel));
      setClearGeometry(false);
      setDuplicates([]);
      setProv({ source: "", observed_on: "", confidence: "80", verified: false });
    }
  }, [open, parcel]);

  const bind = (key: string) => ({
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const geometry = parseGeoJson(form.geometry);
  let factsError: string | null = null;
  let facts: Record<string, unknown> | undefined;
  if (form.facts.trim()) {
    try {
      const v = JSON.parse(form.facts) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) facts = v as Record<string, unknown>;
      else factsError = "Facts must be a JSON object";
    } catch {
      factsError = "Not valid JSON";
    }
  } else facts = {};

  const submit = (e: FormEvent, force = false) => {
    e.preventDefault();
    if (geometry.error || factsError) return;
    const data: ParcelInput = {};
    for (const k of TEXT) {
      const v = form[k].trim();
      if (parcel || v) (data as Record<string, unknown>)[k] = v === "" ? null : v;
    }
    data.county = form.county.trim();
    data.apn = form.apn.trim();
    const acres = toNumber(form.acreage);
    if (parcel || acres !== null) data.acreage = acres;
    data.facts = facts;
    if (geometry.value) data.geometry = geometry.value;
    if (parcel && clearGeometry && !geometry.value) data.clear_geometry = true;
    data.provenance = {
      source: prov.source.trim() || form.source.trim() || "Manual entry",
      observed_on: prov.observed_on || form.observed_on || null,
      confidence: Math.min(100, Math.max(0, Number(prov.confidence) || 0)) / 100,
      verified: prov.verified,
    };
    save.mutate(
      { data, force },
      {
        onSuccess: (p) => {
          toast.success(parcel ? "Parcel updated" : "Parcel created");
          onOpenChange(false);
          onSaved?.(p);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409 && err.detail && typeof err.detail === "object") {
            setDuplicates((err.detail as { duplicates?: Dupe[] }).duplicates ?? []);
          } else toast.error(errorMessage(err));
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={parcel ? "Edit parcel" : "New parcel"}
      description={parcel ? `${parcel.county} · APN ${parcel.apn}` : "APN is normalized and checked for duplicates within the county."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="parcel-form" loading={save.isPending} disabled={!!geometry.error || !!factsError}>
            {parcel ? "Save changes" : "Create parcel"}
          </Button>
        </>
      }
    >
      <form id="parcel-form" onSubmit={(e) => submit(e)} className="space-y-6">
        {duplicates.length > 0 && (
          <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
            <p className="font-medium text-caution">Possible duplicate parcel — review required</p>
            <p className="mt-0.5 text-ink-2">A parcel with this county and normalized APN already exists. Parcels are never merged automatically.</p>
            <ul className="mt-2 space-y-1">
              {duplicates.map((d) => (
                <li key={d.id}>
                  <Link href={`/parcels/${d.id}`} className="font-medium text-accent hover:underline">
                    {d.county} · {d.apn}
                  </Link>
                  <span className="text-ink-3">
                    {d.situs_address ? ` · ${d.situs_address}` : ""}
                    {d.acreage != null ? ` · ${formatNumber(d.acreage, 2)} ac` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {!parcel && can("parcels", "approve") && (
              <Button size="sm" className="mt-3" onClick={(e) => submit(e as unknown as FormEvent, true)}>
                Create anyway
              </Button>
            )}
          </div>
        )}

        <Section title="Identity">
          <Field label="County" required>
            <Input {...bind("county")} required />
          </Field>
          <Field label="State">
            <Input {...bind("state")} maxLength={40} />
          </Field>
          <Field label="APN" required hint="Stored as observed; matched on a normalized key." className="col-span-2">
            <Input {...bind("apn")} required className="font-mono" />
          </Field>
          <Field label="Situs address" className="col-span-2">
            <Input {...bind("situs_address")} />
          </Field>
          <Field label="Acreage" hint="Calculated from geometry when left blank.">
            <Input {...bind("acreage")} inputMode="decimal" />
          </Field>
        </Section>

        <Section title="Legal description & geometry">
          <Field label="Legal description" className="col-span-2">
            <Textarea {...bind("legal_description")} rows={3} />
          </Field>
          <GeometryField
            className="col-span-2"
            value={form.geometry}
            onChange={(v) => setForm((f) => ({ ...f, geometry: v }))}
            hint={parcel?.has_geometry ? "Leave empty to keep the current geometry. A new geometry creates a history version." : undefined}
          />
          {parcel?.has_geometry && !form.geometry.trim() && (
            <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={clearGeometry} onChange={setClearGeometry} />
              Remove the current geometry
            </label>
          )}
        </Section>

        <Section title="Parcel facts">
          <Field label="Facts (JSON)" error={factsError} hint='e.g. {"zoning": "C-2", "land_use_code": "F1", "assessed_value": 1250000}' className="col-span-2">
            <Textarea {...bind("facts")} rows={4} spellCheck={false} className="font-mono text-xs" aria-invalid={!!factsError} />
          </Field>
          <Field label="Source">
            <Input {...bind("source")} placeholder="e.g. County appraisal district" />
          </Field>
          <Field label="Observed on">
            <Input type="date" {...bind("observed_on")} />
          </Field>
          <Field label="Notes" className="col-span-2">
            <Textarea {...bind("notes")} />
          </Field>
        </Section>

        <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
          <div>
            <h4 className="text-sm font-medium">Provenance for changed facts</h4>
            <p className="text-xs text-ink-3">APN, legal description and acreage changes keep this source, date and confidence in their history.</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Source" className="col-span-3">
              <Input value={prov.source} placeholder={form.source || "Manual entry"} onChange={(e) => setProv((s) => ({ ...s, source: e.target.value }))} />
            </Field>
            <Field label="Observed on" className="col-span-2">
              <Input type="date" value={prov.observed_on} onChange={(e) => setProv((s) => ({ ...s, observed_on: e.target.value }))} />
            </Field>
            <Field label="Confidence %">
              <Input inputMode="numeric" value={prov.confidence} onChange={(e) => setProv((s) => ({ ...s, confidence: e.target.value }))} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={prov.verified} onChange={(v) => setProv((s) => ({ ...s, verified: v }))} />
            I verified these values against the source
          </label>
        </section>
      </form>
    </Sheet>
  );
}
