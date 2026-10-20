"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { EntityPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { titleCase, toNumber } from "@/lib/utils";

import {
  OCCUPANCY_STATES,
  PARCEL_RELATIONSHIPS,
  SPACE_USE_TYPES,
  useLinkParcel,
  useSaveBuilding,
  useSaveSpace,
  type Building,
  type ParcelListItem,
  type PropertyParcel,
  type Space,
} from "./api";

const opt = (values: readonly string[]) => values.map((v) => ({ value: v, label: titleCase(v) }));

function SourceFields({ value, onChange }: { value: { source: string; observed_on: string }; onChange: (v: { source: string; observed_on: string }) => void }) {
  return (
    <div className="col-span-2 grid grid-cols-2 gap-3 rounded-lg border border-line bg-subtle/60 p-3">
      <p className="col-span-2 text-xs text-ink-3">Area, occupancy and tenant changes keep this source and date in their history.</p>
      <Field label="Source">
        <Input value={value.source} onChange={(e) => onChange({ ...value, source: e.target.value })} />
      </Field>
      <Field label="Observed on">
        <Input type="date" value={value.observed_on} onChange={(e) => onChange({ ...value, observed_on: e.target.value })} />
      </Field>
    </div>
  );
}

const provenance = (s: { source: string; observed_on: string }) => ({
  source: s.source.trim() || "Manual entry",
  observed_on: s.observed_on || null,
  confidence: 0.8,
  verified: false,
});

/* ------------------------------------------------------------------ link parcel */

export function LinkParcelSheet({ open, onOpenChange, propertyId }: { open: boolean; onOpenChange: (o: boolean) => void; propertyId: string }) {
  const link = useLinkParcel(propertyId);
  const [parcelId, setParcelId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState("primary");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setParcelId(null);
      setRelationship("primary");
      setNotes("");
    }
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!parcelId) return;
    link.mutate(
      { parcel_id: parcelId, relationship, notes: notes.trim() || null },
      {
        onSuccess: () => {
          toast.success("Parcel linked");
          onOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof ApiError && err.status === 409 ? "That parcel is already linked" : errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Link parcel"
      description="Attach an existing parcel record to this property."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="link-parcel-form" disabled={!parcelId} loading={link.isPending}>
            Link parcel
          </Button>
        </>
      }
    >
      <form id="link-parcel-form" onSubmit={submit} className="space-y-4">
        <Field label="Parcel" required hint="Search by APN, county or legal description. Create new parcels from the Parcels page.">
          <EntityPicker<ParcelListItem>
            endpoint="/parcels"
            value={parcelId}
            onChange={(id) => setParcelId(id)}
            placeholder="Search parcels"
            toOption={(p) => ({ id: p.id, label: `${p.county} · ${p.apn}`, sublabel: p.situs_address ?? (p.acreage != null ? `${p.acreage} ac` : undefined) })}
          />
        </Field>
        <Field label="Relationship">
          <Select value={relationship} onChange={(e) => setRelationship(e.target.value)} options={opt(PARCEL_RELATIONSHIPS)} />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ building */

export function BuildingFormSheet({
  open,
  onOpenChange,
  propertyId,
  building,
  parcels,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  propertyId: string;
  building?: Building | null;
  parcels: PropertyParcel[];
}) {
  const save = useSaveBuilding(propertyId, building?.id);
  const empty = { name: "", parcel_id: "", building_area_sf: "", year_built: "", floors: "", construction_class: "", use_type: "", notes: "" };
  const [form, setForm] = useState(empty);
  const [src, setSrc] = useState({ source: "", observed_on: "" });

  useEffect(() => {
    if (!open) return;
    setSrc({ source: "", observed_on: "" });
    setForm(
      building
        ? {
            name: building.name,
            parcel_id: building.parcel_id ?? "",
            building_area_sf: building.building_area_sf?.toString() ?? "",
            year_built: building.year_built?.toString() ?? "",
            floors: building.floors?.toString() ?? "",
            construction_class: building.construction_class ?? "",
            use_type: building.use_type ?? "",
            notes: building.notes ?? "",
          }
        : empty,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, building]);

  const bind = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        name: form.name.trim(),
        parcel_id: form.parcel_id || null,
        building_area_sf: toNumber(form.building_area_sf),
        year_built: toNumber(form.year_built),
        floors: toNumber(form.floors),
        construction_class: form.construction_class.trim() || null,
        use_type: form.use_type.trim() || null,
        notes: form.notes.trim() || null,
        provenance: provenance(src),
      },
      {
        onSuccess: () => {
          toast.success(building ? "Building updated" : "Building added");
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
      title={building ? "Edit building" : "Add building"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="building-form" loading={save.isPending}>
            {building ? "Save changes" : "Add building"}
          </Button>
        </>
      }
    >
      <form id="building-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Name" required className="col-span-2">
          <Input {...bind("name")} required placeholder="e.g. Building A, Pad 2" />
        </Field>
        <Field label="On parcel" className="col-span-2">
          <Select
            {...bind("parcel_id")}
            placeholder="Not specified"
            options={parcels.map((l) => ({ value: l.parcel.id, label: `${l.parcel.county} · ${l.parcel.apn}` }))}
          />
        </Field>
        <Field label="Building area (SF)">
          <Input {...bind("building_area_sf")} inputMode="decimal" />
        </Field>
        <Field label="Year built">
          <Input {...bind("year_built")} inputMode="numeric" />
        </Field>
        <Field label="Floors">
          <Input {...bind("floors")} inputMode="numeric" />
        </Field>
        <Field label="Construction class">
          <Input {...bind("construction_class")} placeholder="A / B / C" />
        </Field>
        <Field label="Use" className="col-span-2">
          <Input {...bind("use_type")} placeholder="e.g. Retail, Office, Warehouse" />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea {...bind("notes")} />
        </Field>
        <SourceFields value={src} onChange={setSrc} />
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ space / suite */

export function SpaceFormSheet({
  open,
  onOpenChange,
  propertyId,
  space,
  buildings,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  propertyId: string;
  space?: Space | null;
  buildings: Building[];
}) {
  const save = useSaveSpace(propertyId, space?.id);
  const empty = {
    suite: "", building_id: "", area_sf: "", floor: "", location_note: "", use_type: "", occupancy_status: "vacant",
    tenant_name: "", tenant_organization_id: "", notes: "",
  };
  const [form, setForm] = useState(empty);
  const [src, setSrc] = useState({ source: "", observed_on: "" });

  useEffect(() => {
    if (!open) return;
    setSrc({ source: "", observed_on: "" });
    setForm(
      space
        ? {
            suite: space.suite,
            building_id: space.building_id ?? "",
            area_sf: space.area_sf?.toString() ?? "",
            floor: space.floor ?? "",
            location_note: space.location_note ?? "",
            use_type: space.use_type ?? "",
            occupancy_status: space.occupancy_status,
            tenant_name: space.tenant_name ?? "",
            tenant_organization_id: space.tenant_organization_id ?? "",
            notes: space.notes ?? "",
          }
        : empty,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, space]);

  const bind = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })) });
  const occupied = form.occupancy_status === "occupied" || form.occupancy_status === "pending";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        suite: form.suite.trim(),
        building_id: form.building_id || null,
        area_sf: toNumber(form.area_sf),
        floor: form.floor.trim() || null,
        location_note: form.location_note.trim() || null,
        use_type: form.use_type || null,
        occupancy_status: form.occupancy_status,
        tenant_name: form.tenant_name.trim() || null,
        tenant_organization_id: form.tenant_organization_id || null,
        notes: form.notes.trim() || null,
        provenance: provenance(src),
      },
      {
        onSuccess: () => {
          toast.success(space ? "Suite updated" : "Suite added");
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
      title={space ? `Edit suite ${space.suite}` : "Add space / suite"}
      description="Lease linkage is attached to the suite once lease administration is available."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="space-form" loading={save.isPending}>
            {space ? "Save changes" : "Add suite"}
          </Button>
        </>
      }
    >
      <form id="space-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Suite / identifier" required>
          <Input {...bind("suite")} required placeholder="e.g. 100, A-2" />
        </Field>
        <Field label="Building">
          <Select {...bind("building_id")} placeholder="Not specified" options={buildings.map((b) => ({ value: b.id, label: b.name }))} />
        </Field>
        <Field label="Area (SF)">
          <Input {...bind("area_sf")} inputMode="decimal" />
        </Field>
        <Field label="Floor">
          <Input {...bind("floor")} maxLength={20} />
        </Field>
        <Field label="Location" className="col-span-2">
          <Input {...bind("location_note")} placeholder="e.g. End cap, north elevation" />
        </Field>
        <Field label="Use">
          <Select {...bind("use_type")} placeholder="Not specified" options={opt(SPACE_USE_TYPES)} />
        </Field>
        <Field label="Occupancy">
          <Select {...bind("occupancy_status")} options={opt(OCCUPANCY_STATES)} />
        </Field>
        {(occupied || form.tenant_name || form.tenant_organization_id) && (
          <>
            <Field label="Tenant name" className="col-span-2">
              <Input {...bind("tenant_name")} />
            </Field>
            <Field label="Tenant organization" className="col-span-2">
              <EntityPicker<{ id: string; name: string; city?: string | null; state?: string | null }>
                endpoint="/organizations"
                value={form.tenant_organization_id || null}
                onChange={(id, item) =>
                  setForm((f) => ({ ...f, tenant_organization_id: id ?? "", tenant_name: f.tenant_name || item?.name || "" }))
                }
                placeholder="Link organization"
                toOption={(o) => ({ id: o.id, label: o.name, sublabel: [o.city, o.state].filter(Boolean).join(", ") || undefined })}
              />
            </Field>
          </>
        )}
        <Field label="Notes" className="col-span-2">
          <Textarea {...bind("notes")} />
        </Field>
        <SourceFields value={src} onChange={setSrc} />
      </form>
    </Sheet>
  );
}
