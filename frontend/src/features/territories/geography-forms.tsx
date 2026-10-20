"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { titleCase, toNumber } from "@/lib/utils";

import { GeometryField } from "@/features/parcels/geometry-field";
import { parseGeoJson } from "@/features/parcels/geojson";

import {
  GROWTH_KINDS,
  QUADRANTS,
  ROAD_CLASSES,
  TRADE_AREA_MINUTES,
  useSaveGeo,
  type Corridor,
  type GrowthRecord,
  type Node,
  type TradeArea,
  type TrafficCount,
} from "./api";

type Form = Record<string, string>;

const SIDES = ["north", "south", "east", "west", "both"];
const DIRECTIONS = ["northbound", "southbound", "eastbound", "westbound", "both"];
const APPROACHES = ["NB", "SB", "EB", "WB"];
const COUNT_TYPES = ["aadt", "adt", "peak_hour", "other"];
const DEMOGRAPHIC_FIELDS = [
  ["population", "Population"],
  ["households", "Households"],
  ["median_household_income", "Median household income ($)"],
  ["daytime_population", "Daytime population"],
] as const;

const opts = (values: readonly (string | number)[]) => values.map((v) => ({ value: String(v), label: typeof v === "number" ? `${v} min` : titleCase(v) }));

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function useForm(open: boolean, initial: () => Form) {
  const [form, setForm] = useState<Form>(initial);
  useEffect(() => {
    if (open) setForm(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const bind = (k: string) => ({ value: form[k] ?? "", onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })) });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return { form, bind, set };
}

const txt = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function SourceRow({ bind, required }: { bind: (k: string) => { value: string; onChange: (e: { target: { value: string } }) => void }; required?: boolean }) {
  return (
    <>
      <Field label="Source" required={required}>
        <Input {...bind("source")} required={required} placeholder="e.g. TxDOT, county permits" />
      </Field>
      <Field label="Observed on">
        <Input type="date" {...bind("observed_on")} />
      </Field>
    </>
  );
}

function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  formId,
  pending,
  editing,
  onSubmit,
  children,
  disabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  formId: string;
  pending: boolean;
  editing: boolean;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} loading={pending} disabled={disabled}>
            {editing ? "Save changes" : "Create"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="space-y-6">
        {children}
      </form>
    </Sheet>
  );
}

function done(label: string, editing: boolean, close: (o: boolean) => void) {
  return {
    onSuccess: () => {
      toast.success(`${label} ${editing ? "updated" : "created"}`);
      close(false);
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  };
}

/* ------------------------------------------------------------------ corridor */

export function CorridorFormSheet({ open, onOpenChange, corridor }: { open: boolean; onOpenChange: (o: boolean) => void; corridor?: Corridor | null }) {
  const save = useSaveGeo<Corridor>("corridors", corridor?.id);
  const { form, bind, set } = useForm(open, () => ({
    name: s(corridor?.name), road_name: s(corridor?.road_name), road_class: corridor?.road_class ?? "arterial",
    side_of_road: s(corridor?.side_of_road), travel_direction: s(corridor?.travel_direction),
    frontage_length_ft: s(corridor?.frontage_length_ft), city: s(corridor?.city), county: s(corridor?.county), state: s(corridor?.state),
    source: s(corridor?.source), observed_on: s(corridor?.observed_on), notes: s(corridor?.notes), geometry: "",
  }));
  const geometry = parseGeoJson(form.geometry);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (geometry.error) return;
    const data: Record<string, unknown> = {
      name: form.name.trim(), road_name: txt(form.road_name), road_class: form.road_class, side_of_road: txt(form.side_of_road),
      travel_direction: txt(form.travel_direction), frontage_length_ft: toNumber(form.frontage_length_ft), city: txt(form.city),
      county: txt(form.county), state: txt(form.state), source: txt(form.source), observed_on: form.observed_on || null, notes: txt(form.notes),
    };
    if (geometry.value) data.geometry = geometry.value;
    save.mutate(data, done("Corridor", !!corridor, onOpenChange));
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={corridor ? "Edit corridor" : "New corridor"} formId="corridor-form" pending={save.isPending} editing={!!corridor} onSubmit={submit} disabled={!!geometry.error}>
      <Section title="Corridor">
        <Field label="Name" required className="col-span-2">
          <Input {...bind("name")} required placeholder="e.g. I-35 north of SH-45" />
        </Field>
        <Field label="Highway / arterial">
          <Input {...bind("road_name")} placeholder="e.g. IH-35" />
        </Field>
        <Field label="Road class">
          <Select {...bind("road_class")} options={opts(ROAD_CLASSES)} />
        </Field>
        <Field label="Side of road">
          <Select {...bind("side_of_road")} placeholder="Not specified" options={opts(SIDES)} />
        </Field>
        <Field label="Travel direction">
          <Select {...bind("travel_direction")} placeholder="Not specified" options={opts(DIRECTIONS)} />
        </Field>
        <Field label="Frontage length (ft)">
          <Input {...bind("frontage_length_ft")} inputMode="decimal" />
        </Field>
        <Field label="City">
          <Input {...bind("city")} />
        </Field>
        <Field label="County">
          <Input {...bind("county")} />
        </Field>
        <Field label="State">
          <Input {...bind("state")} maxLength={40} />
        </Field>
      </Section>
      <Section title="Geometry & source">
        <GeometryField
          className="col-span-2"
          label="Centerline (GeoJSON LineString)"
          value={form.geometry}
          onChange={(v) => set("geometry", v)}
          placeholder='{"type":"LineString","coordinates":[[-97.70,30.40],[-97.68,30.45]]}'
          hint={corridor?.has_geometry ? "Leave empty to keep the current line." : "Needed for corridor-buffer territories and property searches."}
        />
        <SourceRow bind={bind} />
        <Field label="Notes" className="col-span-2">
          <Textarea {...bind("notes")} />
        </Field>
      </Section>
    </FormSheet>
  );
}

/* ------------------------------------------------------------------ node */

export function NodeFormSheet({ open, onOpenChange, node }: { open: boolean; onOpenChange: (o: boolean) => void; node?: Node | null }) {
  const save = useSaveGeo<Node>("nodes", node?.id);
  const { form, bind, set } = useForm(open, () => {
    const f: Form = {
      name: s(node?.name), corridor_id: s(node?.corridor_id), cross_street: s(node?.cross_street), city: s(node?.city),
      county: s(node?.county), state: s(node?.state), latitude: s(node?.latitude), longitude: s(node?.longitude),
      signalized: node?.signalized == null ? "" : node.signalized ? "yes" : "no", turn_restrictions: s(node?.turn_restrictions),
      nearby_development: s(node?.nearby_development), source: s(node?.source), observed_on: s(node?.observed_on), notes: s(node?.notes),
    };
    for (const a of APPROACHES) f[`approach_${a}`] = s(node?.approach_traffic?.[a]);
    for (const q of QUADRANTS) {
      f[`${q}_tenancy`] = s(node?.quadrants?.[q]?.tenancy);
      f[`${q}_vacancy`] = s(node?.quadrants?.[q]?.vacancy);
    }
    return f;
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const approach: Record<string, number> = {};
    for (const a of APPROACHES) {
      const n = toNumber(form[`approach_${a}`] ?? "");
      if (n !== null) approach[a] = n;
    }
    const quadrants: Record<string, { tenancy: string | null; vacancy: string | null }> = {};
    for (const q of QUADRANTS) {
      const tenancy = txt(form[`${q}_tenancy`]);
      const vacancy = txt(form[`${q}_vacancy`]);
      if (tenancy || vacancy) quadrants[q] = { tenancy, vacancy };
    }
    save.mutate(
      {
        name: form.name.trim(), corridor_id: form.corridor_id || null, cross_street: txt(form.cross_street), city: txt(form.city),
        county: txt(form.county), state: txt(form.state), latitude: toNumber(form.latitude), longitude: toNumber(form.longitude),
        signalized: form.signalized === "" ? null : form.signalized === "yes", turn_restrictions: txt(form.turn_restrictions),
        approach_traffic: approach, quadrants, nearby_development: txt(form.nearby_development), source: txt(form.source),
        observed_on: form.observed_on || null, notes: txt(form.notes),
      },
      done("Node", !!node, onOpenChange),
    );
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={node ? "Edit node" : "New node"} description="A major intersection or interchange." formId="node-form" pending={save.isPending} editing={!!node} onSubmit={submit}>
      <Section title="Intersection">
        <Field label="Intersection name" required className="col-span-2">
          <Input {...bind("name")} required placeholder="e.g. US-290 & Brodie Ln" />
        </Field>
        <Field label="Corridor" className="col-span-2">
          <EntityPicker<Corridor>
            endpoint="/corridors"
            value={form.corridor_id || null}
            onChange={(id) => set("corridor_id", id ?? "")}
            placeholder="Not linked"
            toOption={(c) => ({ id: c.id, label: c.name, sublabel: c.road_name ?? undefined })}
          />
        </Field>
        <Field label="Cross street">
          <Input {...bind("cross_street")} />
        </Field>
        <Field label="Signalized">
          <Select {...bind("signalized")} placeholder="Unknown" options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
        </Field>
        <Field label="Latitude">
          <Input {...bind("latitude")} inputMode="decimal" />
        </Field>
        <Field label="Longitude">
          <Input {...bind("longitude")} inputMode="decimal" />
        </Field>
        <Field label="City">
          <Input {...bind("city")} />
        </Field>
        <Field label="County">
          <Input {...bind("county")} />
        </Field>
        <Field label="Turn restrictions" className="col-span-2">
          <Textarea {...bind("turn_restrictions")} rows={2} placeholder="e.g. No left turn from EB approach; right-in/right-out on NE corner" />
        </Field>
      </Section>
      <Section title="Approach traffic (vehicles per day)">
        {APPROACHES.map((a) => (
          <Field key={a} label={a}>
            <Input {...bind(`approach_${a}`)} inputMode="numeric" />
          </Field>
        ))}
      </Section>
      <Section title="Quadrant tenancy & vacancy">
        {QUADRANTS.map((q) => (
          <div key={q} className="col-span-2 grid grid-cols-[40px_1fr_1fr] items-end gap-2">
            <span className="pb-2 text-xs font-semibold text-ink-2">{q}</span>
            <Field label="Tenancy">
              <Input {...bind(`${q}_tenancy`)} placeholder="Anchors / tenants" />
            </Field>
            <Field label="Vacancy">
              <Input {...bind(`${q}_vacancy`)} placeholder="e.g. 1.2 ac pad available" />
            </Field>
          </div>
        ))}
      </Section>
      <Section title="Context & source">
        <Field label="Nearby development" className="col-span-2">
          <Textarea {...bind("nearby_development")} rows={2} />
        </Field>
        <SourceRow bind={bind} />
        <Field label="Notes" className="col-span-2">
          <Textarea {...bind("notes")} />
        </Field>
      </Section>
    </FormSheet>
  );
}

/* ------------------------------------------------------------------ traffic count */

export function TrafficCountFormSheet({ open, onOpenChange, count }: { open: boolean; onOpenChange: (o: boolean) => void; count?: TrafficCount | null }) {
  const save = useSaveGeo<TrafficCount>("traffic-counts", count?.id);
  const { form, bind, set } = useForm(open, () => ({
    corridor_id: s(count?.corridor_id), node_id: s(count?.node_id), segment: s(count?.segment), approach: s(count?.approach),
    count: s(count?.count), count_year: s(count?.count_year ?? new Date().getFullYear()), count_type: count?.count_type ?? "aadt",
    latitude: s(count?.latitude), longitude: s(count?.longitude), source: s(count?.source), observed_on: s(count?.observed_on), notes: s(count?.notes),
  }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        corridor_id: form.corridor_id || null, node_id: form.node_id || null, segment: txt(form.segment), approach: txt(form.approach),
        count: toNumber(form.count), count_year: toNumber(form.count_year), count_type: form.count_type,
        latitude: toNumber(form.latitude), longitude: toNumber(form.longitude), source: form.source.trim(),
        observed_on: form.observed_on || null, notes: txt(form.notes),
      },
      done("Traffic count", !!count, onOpenChange),
    );
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={count ? "Edit traffic count" : "New traffic count"} description="Add a new row for each count year to keep the historical trend." formId="traffic-form" pending={save.isPending} editing={!!count} onSubmit={submit}>
      <Section title="Location">
        <Field label="Corridor" className="col-span-2">
          <EntityPicker<Corridor> endpoint="/corridors" value={form.corridor_id || null} onChange={(id) => set("corridor_id", id ?? "")} placeholder="Not linked" toOption={(c) => ({ id: c.id, label: c.name, sublabel: c.road_name ?? undefined })} />
        </Field>
        <Field label="Node" className="col-span-2">
          <EntityPicker<Node> endpoint="/nodes" value={form.node_id || null} onChange={(id) => set("node_id", id ?? "")} placeholder="Not linked" toOption={(n) => ({ id: n.id, label: n.name, sublabel: n.city ?? undefined })} />
        </Field>
        <Field label="Segment" className="col-span-2">
          <Input {...bind("segment")} placeholder="e.g. IH-35 between Parmer Ln and SH-45" />
        </Field>
        <Field label="Approach">
          <Input {...bind("approach")} placeholder="NB / SB / EB / WB" />
        </Field>
        <Field label="Count type">
          <Select {...bind("count_type")} options={COUNT_TYPES.map((c) => ({ value: c, label: c === "aadt" || c === "adt" ? c.toUpperCase() : titleCase(c) }))} />
        </Field>
        <Field label="Latitude">
          <Input {...bind("latitude")} inputMode="decimal" />
        </Field>
        <Field label="Longitude">
          <Input {...bind("longitude")} inputMode="decimal" />
        </Field>
      </Section>
      <Section title="Count">
        <Field label="Vehicles per day" required>
          <Input {...bind("count")} inputMode="numeric" required />
        </Field>
        <Field label="Count year" required>
          <Input {...bind("count_year")} inputMode="numeric" required />
        </Field>
        <SourceRow bind={bind} required />
        <Field label="Notes" className="col-span-2">
          <Textarea {...bind("notes")} />
        </Field>
      </Section>
    </FormSheet>
  );
}

/* ------------------------------------------------------------------ trade area */

function listText(v: unknown[] | undefined): string {
  return (v ?? []).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
}

export function TradeAreaFormSheet({ open, onOpenChange, tradeArea }: { open: boolean; onOpenChange: (o: boolean) => void; tradeArea?: TradeArea | null }) {
  const save = useSaveGeo<TradeArea>("trade-areas", tradeArea?.id);
  const { form, bind, set } = useForm(open, () => {
    const f: Form = {
      name: s(tradeArea?.name), anchor: tradeArea?.property_id ? "property" : "node", node_id: s(tradeArea?.node_id),
      property_id: s(tradeArea?.property_id), minutes: s(tradeArea?.minutes ?? 10), geometry: "",
      competitors: listText(tradeArea?.competitors), anchors: listText(tradeArea?.anchors),
      source: s(tradeArea?.source), observed_on: s(tradeArea?.observed_on), notes: s(tradeArea?.notes),
    };
    for (const [k] of DEMOGRAPHIC_FIELDS) f[`demo_${k}`] = s(tradeArea?.demographics?.[k]);
    return f;
  });
  const geometry = parseGeoJson(form.geometry);
  const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (geometry.error) return;
    const demographics: Record<string, unknown> = { ...(tradeArea?.demographics ?? {}) };
    for (const [k] of DEMOGRAPHIC_FIELDS) {
      const n = toNumber(form[`demo_${k}`] ?? "");
      if (n === null) delete demographics[k];
      else demographics[k] = n;
    }
    const data: Record<string, unknown> = {
      name: txt(form.name), node_id: form.anchor === "node" ? form.node_id || null : null,
      property_id: form.anchor === "property" ? form.property_id || null : null, minutes: Number(form.minutes),
      demographics, competitors: lines(form.competitors), anchors: lines(form.anchors), source: form.source.trim(),
      observed_on: form.observed_on || null, notes: txt(form.notes),
    };
    if (geometry.value) data.geometry = geometry.value;
    save.mutate(data, done("Trade area", !!tradeArea, onOpenChange));
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={tradeArea ? "Edit trade area" : "New trade area"} description="Drive-time polygon with demographics, competitors and anchors from a dated source." formId="trade-form" pending={save.isPending} editing={!!tradeArea} onSubmit={submit} disabled={!!geometry.error}>
      <Section title="Trade area">
        <Field label="Name" className="col-span-2">
          <Input {...bind("name")} placeholder="Optional" />
        </Field>
        <Field label="Centered on">
          <Select {...bind("anchor")} options={[{ value: "node", label: "Node" }, { value: "property", label: "Property" }]} />
        </Field>
        <Field label="Drive time">
          <Select {...bind("minutes")} options={opts(TRADE_AREA_MINUTES)} />
        </Field>
        {form.anchor === "node" ? (
          <Field label="Node" required className="col-span-2">
            <EntityPicker<Node> endpoint="/nodes" value={form.node_id || null} onChange={(id) => set("node_id", id ?? "")} placeholder="Select node" toOption={(n) => ({ id: n.id, label: n.name, sublabel: n.city ?? undefined })} />
          </Field>
        ) : (
          <Field label="Property" required className="col-span-2">
            <PropertyPicker value={form.property_id || null} onChange={(id) => set("property_id", id ?? "")} />
          </Field>
        )}
        <GeometryField className="col-span-2" label="Drive-time polygon (GeoJSON)" value={form.geometry} onChange={(v) => set("geometry", v)} hint={tradeArea?.has_geometry ? "Leave empty to keep the current polygon." : "Export the isochrone from your routing tool and paste it here."} />
      </Section>
      <Section title="Demographics">
        {DEMOGRAPHIC_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <Input {...bind(`demo_${k}`)} inputMode="decimal" />
          </Field>
        ))}
        <Field label="Competitors" hint="One per line" className="col-span-2">
          <Textarea {...bind("competitors")} rows={3} />
        </Field>
        <Field label="Anchors" hint="One per line" className="col-span-2">
          <Textarea {...bind("anchors")} rows={3} />
        </Field>
      </Section>
      <Section title="Source">
        <SourceRow bind={bind} required />
        <Field label="Notes" className="col-span-2">
          <Textarea {...bind("notes")} />
        </Field>
      </Section>
    </FormSheet>
  );
}

/* ------------------------------------------------------------------ growth record */

export function GrowthFormSheet({ open, onOpenChange, record }: { open: boolean; onOpenChange: (o: boolean) => void; record?: GrowthRecord | null }) {
  const save = useSaveGeo<GrowthRecord>("growth-records", record?.id);
  const { form, bind } = useForm(open, () => ({
    kind: record?.kind ?? "permit", name: s(record?.name), description: s(record?.description), status: s(record?.status),
    units: s(record?.units), value: s(record?.value), event_date: s(record?.event_date), city: s(record?.city), county: s(record?.county),
    state: s(record?.state), latitude: s(record?.latitude), longitude: s(record?.longitude), source: s(record?.source), observed_on: s(record?.observed_on),
  }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        kind: form.kind, name: form.name.trim(), description: txt(form.description), status: txt(form.status), units: toNumber(form.units),
        value: toNumber(form.value), event_date: form.event_date || null, city: txt(form.city), county: txt(form.county), state: txt(form.state),
        latitude: toNumber(form.latitude), longitude: toNumber(form.longitude), source: form.source.trim(), observed_on: form.observed_on || null,
      },
      done("Growth record", !!record, onOpenChange),
    );
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={record ? "Edit growth record" : "New growth record"} description="Permits, plats, rooftops, schools, utilities and announced projects as dated, sourced points." formId="growth-form" pending={save.isPending} editing={!!record} onSubmit={submit}>
      <Section title="Record">
        <Field label="Kind">
          <Select {...bind("kind")} options={opts(GROWTH_KINDS)} />
        </Field>
        <Field label="Status">
          <Input {...bind("status")} placeholder="e.g. Approved, Under construction" />
        </Field>
        <Field label="Name" required className="col-span-2">
          <Input {...bind("name")} required />
        </Field>
        <Field label="Description" className="col-span-2">
          <Textarea {...bind("description")} rows={2} />
        </Field>
        <Field label="Units / rooftops">
          <Input {...bind("units")} inputMode="numeric" />
        </Field>
        <Field label="Value ($)">
          <Input {...bind("value")} inputMode="decimal" />
        </Field>
        <Field label="Event date">
          <Input type="date" {...bind("event_date")} />
        </Field>
      </Section>
      <Section title="Location">
        <Field label="Latitude" required>
          <Input {...bind("latitude")} inputMode="decimal" required />
        </Field>
        <Field label="Longitude" required>
          <Input {...bind("longitude")} inputMode="decimal" required />
        </Field>
        <Field label="City">
          <Input {...bind("city")} />
        </Field>
        <Field label="County">
          <Input {...bind("county")} />
        </Field>
        <SourceRow bind={bind} required />
      </Section>
    </FormSheet>
  );
}
