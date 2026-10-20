"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import type { SavedView } from "@/components/data/saved-views";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toNumber } from "@/lib/utils";

import { GeometryField } from "@/features/parcels/geometry-field";
import { parseGeoJson } from "@/features/parcels/geojson";

import {
  RULE_LABELS,
  RULE_TYPES,
  VISIBILITIES,
  VISIBILITY_LABELS,
  useRoles,
  useSaveTerritory,
  type Corridor,
  type Node,
  type Territory,
  type TerritoryInput,
  type TerritoryListItem,
} from "./api";

const RULE_HELP: Record<string, string> = {
  explicit: "Members are assigned by hand (or from bulk selections on parcel and property lists).",
  boundary: "Properties whose location falls inside the drawn polygon.",
  radius: "Properties within a distance of a point, node or property.",
  corridor: "Properties within a buffer distance of a corridor line.",
  county: "Properties in any of the listed counties.",
  city: "Properties in any of the listed cities.",
  saved_query: "Properties matching a saved property view. Membership follows the view's filters.",
};

type CenterMode = "point" | "node" | "property";

interface FormState {
  name: string;
  description: string;
  rule_type: string;
  parent_id: string | null;
  visibility: string;
  allowed_roles: string[];
  owner_id: string | null;
  assignee_id: string | null;
  geometry: string;
  center: CenterMode;
  lat: string;
  lng: string;
  node_id: string | null;
  property_id: string | null;
  radius_miles: string;
  corridor_id: string | null;
  buffer_ft: string;
  values: string;
  state: string;
  saved_view_id: string;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function toForm(t?: Territory | null): FormState {
  const r = (t?.rule ?? {}) as Record<string, unknown>;
  return {
    name: t?.name ?? "",
    description: t?.description ?? "",
    rule_type: t?.rule_type ?? "explicit",
    parent_id: t?.parent_id ?? null,
    visibility: t?.visibility ?? "private",
    allowed_roles: t?.allowed_roles ?? [],
    owner_id: t?.owner_id ?? null,
    assignee_id: t?.assignee_id ?? null,
    geometry: "",
    center: r.node_id ? "node" : r.property_id ? "property" : "point",
    lat: str(r.lat),
    lng: str(r.lng),
    node_id: (r.node_id as string) ?? null,
    property_id: (r.property_id as string) ?? null,
    radius_miles: str(r.radius_miles ?? "1"),
    corridor_id: (r.corridor_id as string) ?? null,
    buffer_ft: str(r.buffer_ft ?? "500"),
    values: Array.isArray(r.values) ? (r.values as string[]).join(", ") : "",
    state: str(r.state),
    saved_view_id: str(r.saved_view_id),
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function buildRule(f: FormState): Record<string, unknown> {
  switch (f.rule_type) {
    case "radius": {
      const base = { radius_miles: toNumber(f.radius_miles) };
      if (f.center === "node") return { ...base, node_id: f.node_id };
      if (f.center === "property") return { ...base, property_id: f.property_id };
      return { ...base, lat: toNumber(f.lat), lng: toNumber(f.lng) };
    }
    case "corridor":
      return { corridor_id: f.corridor_id, buffer_ft: toNumber(f.buffer_ft) };
    case "county":
    case "city":
      return { values: f.values.split(",").map((v) => v.trim()).filter(Boolean), state: f.state.trim() || undefined };
    case "saved_query":
      return { saved_view_id: f.saved_view_id || null };
    default:
      return {};
  }
}

export function TerritoryFormSheet({
  open,
  onOpenChange,
  territory,
  defaultParentId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  territory?: Territory | null;
  defaultParentId?: string | null;
  onSaved?: (t: Territory) => void;
}) {
  const { can, user } = useAuth();
  const save = useSaveTerritory(territory?.id);
  const [form, setForm] = useState<FormState>(toForm(territory));
  const roles = useRoles(open && form.visibility === "role");
  const views = useQuery({
    queryKey: ["saved-views", "properties"],
    queryFn: () => api.get<SavedView[]>("/saved-views", { module: "properties" }),
    enabled: open && form.rule_type === "saved_query",
  });

  useEffect(() => {
    if (open) setForm({ ...toForm(territory), ...(territory ? {} : { parent_id: defaultParentId ?? null }) });
  }, [open, territory, defaultParentId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const geometry = parseGeoJson(form.geometry);
  const needsGeometry = form.rule_type === "boundary" && !territory?.has_geometry;
  const isApprover = can("territories", "approve");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (geometry.error) return;
    if (needsGeometry && !geometry.value) {
      toast.error("Paste the boundary polygon as GeoJSON");
      return;
    }
    const data: TerritoryInput = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      rule_type: form.rule_type,
      rule: buildRule(form),
      parent_id: form.parent_id,
      visibility: form.visibility,
      allowed_roles: form.visibility === "role" ? form.allowed_roles : [],
      assignee_id: form.assignee_id,
    };
    if (isApprover && form.owner_id) data.owner_id = form.owner_id;
    if (geometry.value && form.rule_type === "boundary") data.geometry = geometry.value;
    save.mutate(data, {
      onSuccess: (t) => {
        toast.success(territory ? "Territory updated" : `Territory created with ${t.member_count} members`);
        onOpenChange(false);
        onSaved?.(t);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={territory ? "Edit territory" : "New territory"}
      description="Membership rules are configurable; rule-based members are recomputed on save."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="territory-form" loading={save.isPending} disabled={!!geometry.error}>
            {territory ? "Save changes" : "Create territory"}
          </Button>
        </>
      }
    >
      <form id="territory-form" onSubmit={submit} className="space-y-6">
        <Section title="Territory">
          <Field label="Name" required className="col-span-2">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} required />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <Field label="Parent territory" hint="Nest territories (e.g. sub-markets inside a region)." className="col-span-2">
            <EntityPicker<TerritoryListItem>
              endpoint="/territories/options"
              list
              value={form.parent_id}
              onChange={(id) => set("parent_id", id && id !== territory?.id ? id : null)}
              placeholder="None (top level)"
              toOption={(t) => ({ id: t.id, label: t.name, sublabel: RULE_LABELS[t.rule_type] })}
            />
          </Field>
        </Section>

        <Section title="Membership rule">
          <Field label="Rule type" className="col-span-2" hint={RULE_HELP[form.rule_type]}>
            <Select value={form.rule_type} onChange={(e) => set("rule_type", e.target.value)} options={RULE_TYPES.map((r) => ({ value: r, label: RULE_LABELS[r] }))} />
          </Field>

          {form.rule_type === "boundary" && (
            <GeometryField
              className="col-span-2"
              label="Boundary polygon (GeoJSON)"
              value={form.geometry}
              onChange={(v) => set("geometry", v)}
              hint={territory?.has_geometry ? "Leave empty to keep the current boundary." : "Paste a Polygon or MultiPolygon drawn in any GIS tool."}
            />
          )}

          {form.rule_type === "radius" && (
            <>
              <Field label="Center" className="col-span-2">
                <Select
                  value={form.center}
                  onChange={(e) => set("center", e.target.value as CenterMode)}
                  options={[
                    { value: "point", label: "Coordinates" },
                    { value: "node", label: "Node (intersection)" },
                    { value: "property", label: "Property" },
                  ]}
                />
              </Field>
              {form.center === "point" && (
                <>
                  <Field label="Latitude" required>
                    <Input value={form.lat} onChange={(e) => set("lat", e.target.value)} inputMode="decimal" />
                  </Field>
                  <Field label="Longitude" required>
                    <Input value={form.lng} onChange={(e) => set("lng", e.target.value)} inputMode="decimal" />
                  </Field>
                </>
              )}
              {form.center === "node" && (
                <Field label="Node" required className="col-span-2">
                  <EntityPicker<Node>
                    endpoint="/nodes"
                    value={form.node_id}
                    onChange={(id) => set("node_id", id)}
                    placeholder="Select node"
                    toOption={(n) => ({ id: n.id, label: n.name, sublabel: [n.city, n.county].filter(Boolean).join(", ") || undefined })}
                  />
                </Field>
              )}
              {form.center === "property" && (
                <Field label="Property" required className="col-span-2">
                  <PropertyPicker value={form.property_id} onChange={(id) => set("property_id", id)} />
                </Field>
              )}
              <Field label="Radius (miles)" required>
                <Input value={form.radius_miles} onChange={(e) => set("radius_miles", e.target.value)} inputMode="decimal" />
              </Field>
            </>
          )}

          {form.rule_type === "corridor" && (
            <>
              <Field label="Corridor" required className="col-span-2" hint="The corridor needs line geometry.">
                <EntityPicker<Corridor>
                  endpoint="/corridors"
                  value={form.corridor_id}
                  onChange={(id) => set("corridor_id", id)}
                  placeholder="Select corridor"
                  toOption={(c) => ({ id: c.id, label: c.name, sublabel: [c.road_name, c.has_geometry ? null : "no geometry"].filter(Boolean).join(" · ") || undefined })}
                />
              </Field>
              <Field label="Buffer (feet)" required>
                <Input value={form.buffer_ft} onChange={(e) => set("buffer_ft", e.target.value)} inputMode="decimal" />
              </Field>
            </>
          )}

          {(form.rule_type === "county" || form.rule_type === "city") && (
            <>
              <Field label={form.rule_type === "county" ? "Counties" : "Cities"} required hint="Comma separated; matched case-insensitively." className="col-span-2">
                <Input value={form.values} onChange={(e) => set("values", e.target.value)} placeholder={form.rule_type === "county" ? "Travis, Williamson" : "Austin, Round Rock"} />
              </Field>
              <Field label="State (optional)">
                <Input value={form.state} onChange={(e) => set("state", e.target.value)} maxLength={40} />
              </Field>
            </>
          )}

          {form.rule_type === "saved_query" && (
            <Field label="Saved property view" required className="col-span-2" hint="Create views from the Properties list with Saved views.">
              <Select
                value={form.saved_view_id}
                onChange={(e) => set("saved_view_id", e.target.value)}
                placeholder={views.isLoading ? "Loading…" : "Select a view"}
                options={(views.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
              />
            </Field>
          )}
        </Section>

        <Section title="Access & routing">
          <Field label="Visibility" className="col-span-2">
            <Select value={form.visibility} onChange={(e) => set("visibility", e.target.value)} options={VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }))} />
          </Field>
          {form.visibility === "role" && (
            <div className="col-span-2 space-y-1.5 rounded-lg border border-line p-3">
              <p className="text-xs font-medium text-ink-2">Roles that can see this territory</p>
              {(roles.data ?? []).map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm text-ink-2">
                  <Checkbox
                    checked={form.allowed_roles.includes(r.key)}
                    onChange={(c) => set("allowed_roles", c ? [...form.allowed_roles, r.key] : form.allowed_roles.filter((k) => k !== r.key))}
                  />
                  {r.name}
                </label>
              ))}
              {roles.isLoading && <p className="text-xs text-ink-3">Loading roles…</p>}
            </div>
          )}
          {isApprover && (
            <Field label="Owner" hint={territory ? undefined : `Defaults to ${user?.full_name ?? "you"}`}>
              <UserPicker value={form.owner_id} onChange={(id) => set("owner_id", id)} />
            </Field>
          )}
          <Field label="Default assignee" hint="Used for territory-driven assignment routing." className={isApprover ? undefined : "col-span-2"}>
            <UserPicker value={form.assignee_id} onChange={(id) => set("assignee_id", id)} />
          </Field>
        </Section>
      </form>
    </Sheet>
  );
}
