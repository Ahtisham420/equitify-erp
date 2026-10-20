"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker } from "@/components/data/entity-picker";
import { Badge, StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { titleCase, toNumber } from "@/lib/utils";

import { OrganizationPicker } from "@/features/contacts/pickers";
import type { VendorListItem } from "@/features/operations/api";

import {
  CATEGORY_LABELS,
  WO_CATEGORIES,
  WO_PRIORITIES,
  WO_SOURCES,
  useSaveWorkOrder,
  type WorkOrder,
  type WorkOrderInput,
  type WorkOrderUpdate,
} from "./api";

/* ------------------------------------------------------------------ shared helpers */

/** Local calendar date as YYYY-MM-DD (matches the backend's date comparisons). */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isPastDue(dueOn: string | null | undefined, status?: string): boolean {
  if (!dueOn) return false;
  if (status && !["open", "assigned", "in_progress"].includes(status)) return false;
  return dueOn.slice(0, 10) < todayISO();
}

/** Compliance reasons from a 422 `{message, reasons}` detail, if present. */
export function apiReasons(e: unknown): string[] {
  if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
    const r = (e.detail as { reasons?: unknown }).reasons;
    if (Array.isArray(r)) return r.map(String);
  }
  return [];
}

export function toastApiError(e: unknown) {
  const reasons = apiReasons(e);
  toast.error(errorMessage(e), reasons.length ? { description: reasons.join("; ") } : undefined);
}

const EXTRA_TONES: Record<string, Tone> = {
  assigned: "sky",
  scheduled: "sky",
  not_required: "neutral",
  work_order_created: "blue",
  deferred: "amber",
  resolved: "green",
  tenant: "amber",
  landlord: "neutral",
  shared: "blue",
  undetermined: "neutral",
  preventive: "sky",
  inspection: "sky",
  staff: "neutral",
  pending_manual: "amber",
  created: "green",
};

/** StatusBadge for maintenance states, including those outside the shared tone map. */
export function MaintenanceBadge({ value, label }: { value?: string | null; label?: string }) {
  if (!value) return <span className="text-ink-3">—</span>;
  const tone = EXTRA_TONES[value];
  if (tone) {
    return (
      <Badge tone={tone} dot>
        {label ?? titleCase(value)}
      </Badge>
    );
  }
  return <StatusBadge status={value} label={label} />;
}

export function VendorPicker({
  value,
  onChange,
  placeholder,
}: {
  value: string | null | undefined;
  onChange: (id: string | null, vendor: VendorListItem | null) => void;
  placeholder?: string;
}) {
  return (
    <EntityPicker<VendorListItem>
      endpoint="/vendors"
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? "Select vendor"}
      toOption={(v) => ({
        id: v.id,
        label: v.name,
        sublabel:
          [
            v.compliant === false ? "Not compliant" : v.compliant === true ? "Compliant" : null,
            v.services?.length ? v.services.map((s) => titleCase(s)).join(", ") : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
      })}
    />
  );
}

interface SpaceLite {
  id: string;
  suite: string | null;
  floor: string | number | null;
  tenant_name: string | null;
}

export function SpacePicker({ propertyId, value, onChange }: { propertyId: string; value: string | null | undefined; onChange: (id: string | null) => void }) {
  return (
    <EntityPicker<SpaceLite>
      endpoint={`/properties/${propertyId}/spaces`}
      list
      value={value}
      onChange={(id) => onChange(id)}
      placeholder="Select space"
      toOption={(s) => ({
        id: s.id,
        label: s.suite ? `Suite ${s.suite}` : "Unnamed space",
        sublabel: [s.floor != null && s.floor !== "" ? `Floor ${s.floor}` : null, s.tenant_name].filter(Boolean).join(" · ") || undefined,
      })}
    />
  );
}

/* ------------------------------------------------------------------ form */

type FormState = Record<string, string>;

const TEXT_FIELDS = ["title", "description", "source", "category", "priority", "system", "location_detail", "requested_by_name", "requester_contact", "due_on"] as const;

function toForm(wo?: WorkOrder | null, defaults?: Partial<WorkOrderInput>): FormState {
  const s: FormState = { source: "staff", category: "general", priority: "normal", estimate_amount: "" };
  const src = (wo ?? defaults ?? {}) as unknown as Record<string, unknown>;
  for (const k of TEXT_FIELDS) {
    const v = src[k];
    if (v !== null && v !== undefined && v !== "") s[k] = String(v);
  }
  if (!wo && defaults?.estimate_amount != null) s.estimate_amount = String(defaults.estimate_amount);
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

export function WorkOrderFormSheet({
  open,
  onOpenChange,
  workOrder,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workOrder?: WorkOrder | null;
  defaults?: Partial<WorkOrderInput>;
  onSaved?: (wo: WorkOrder) => void;
}) {
  const editing = !!workOrder;
  const [form, setForm] = useState<FormState>(() => toForm(workOrder, defaults));
  const [propertyId, setPropertyId] = useState<string | null>(workOrder?.property_id ?? defaults?.property_id ?? null);
  const [spaceId, setSpaceId] = useState<string | null>(workOrder?.space_id ?? defaults?.space_id ?? null);
  const [tenantOrgId, setTenantOrgId] = useState<string | null>(workOrder?.tenant_organization_id ?? defaults?.tenant_organization_id ?? null);
  const save = useSaveWorkOrder(workOrder?.id);

  useEffect(() => {
    if (!open) return;
    setForm(toForm(workOrder, defaults));
    setPropertyId(workOrder?.property_id ?? defaults?.property_id ?? null);
    setSpaceId(workOrder?.space_id ?? defaults?.space_id ?? null);
    setTenantOrgId(workOrder?.tenant_organization_id ?? defaults?.tenant_organization_id ?? null);
    // defaults is usually an inline object; only reset when the sheet opens or the record changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrder]);

  const bind = (key: string) => ({
    id: `wo-${key}`,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const text = (key: string) => {
    const v = form[key]?.trim() ?? "";
    return v === "" ? null : v;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.title?.trim()) return toast.error("Title is required");
    let body: WorkOrderInput | WorkOrderUpdate;
    const common = {
      title: form.title.trim(),
      description: text("description"),
      category: form.category || "general",
      priority: form.priority || "normal",
      space_id: spaceId,
      system: text("system"),
      location_detail: text("location_detail"),
      requested_by_name: text("requested_by_name"),
      requester_contact: text("requester_contact"),
      tenant_organization_id: tenantOrgId,
      due_on: text("due_on"),
    };
    if (editing) {
      body = common;
    } else {
      if (!propertyId) return toast.error("Select a property");
      const estimate = toNumber(form.estimate_amount ?? "");
      if (estimate !== null && estimate < 0) return toast.error("Estimate cannot be negative");
      body = { ...common, property_id: propertyId, source: form.source || "staff", estimate_amount: estimate };
    }
    save.mutate(body, {
      onSuccess: (wo) => {
        toast.success(editing ? "Work order updated" : `Work order #${wo.number} created`);
        onOpenChange(false);
        onSaved?.(wo);
      },
      onError: (err) => toastApiError(err),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit work order #${workOrder!.number}` : "New work order"}
      description={
        editing
          ? "Cost changes go through the costs action on the work order so approvals stay accurate."
          : "Estimates above the configured approval threshold need approval before work starts."
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="work-order-form" loading={save.isPending}>
            {editing ? "Save changes" : "Create work order"}
          </Button>
        </>
      }
    >
      <form id="work-order-form" onSubmit={submit} className="space-y-6">
        <Section title="Request">
          <Field label="Title" required htmlFor="wo-title" className="col-span-2">
            <Input {...bind("title")} required maxLength={200} placeholder="e.g. Rooftop unit not cooling – Suite 120" />
          </Field>
          <Field label="Description" htmlFor="wo-description" className="col-span-2">
            <Textarea {...bind("description")} rows={4} />
          </Field>
          {!editing && (
            <Field label="Source" htmlFor="wo-source">
              <Select {...bind("source")} options={WO_SOURCES.map((s) => ({ value: s, label: titleCase(s) }))} />
            </Field>
          )}
          <Field label="Category" htmlFor="wo-category">
            <Select {...bind("category")} options={WO_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? titleCase(c) }))} />
          </Field>
          <Field label="Priority" htmlFor="wo-priority">
            <Select {...bind("priority")} options={WO_PRIORITIES.map((p) => ({ value: p, label: titleCase(p) }))} />
          </Field>
          <Field label="Due date" htmlFor="wo-due_on">
            <Input type="date" {...bind("due_on")} />
          </Field>
        </Section>

        <Section title="Location">
          {!editing && (
            <Field label="Property" required className="col-span-2">
              <PropertyPicker
                value={propertyId}
                onChange={(id) => {
                  setPropertyId(id);
                  setSpaceId(null);
                }}
              />
            </Field>
          )}
          <Field label="Space" hint={propertyId ? undefined : "Select a property first"} className="col-span-2">
            {propertyId ? <SpacePicker propertyId={propertyId} value={spaceId} onChange={setSpaceId} /> : <Input disabled placeholder="Select space" />}
          </Field>
          <Field label="System / asset" htmlFor="wo-system">
            <Input {...bind("system")} placeholder="e.g. RTU-3, Fire panel" />
          </Field>
          <Field label="Location detail" htmlFor="wo-location_detail">
            <Input {...bind("location_detail")} placeholder="e.g. Rear loading dock" />
          </Field>
        </Section>

        <Section title="Requester">
          <Field label="Requested by" htmlFor="wo-requested_by_name">
            <Input {...bind("requested_by_name")} />
          </Field>
          <Field label="Contact" htmlFor="wo-requester_contact">
            <Input {...bind("requester_contact")} placeholder="Phone or email" />
          </Field>
          <Field label="Tenant organization" className="col-span-2">
            <OrganizationPicker value={tenantOrgId} onChange={setTenantOrgId} placeholder="Select tenant" />
          </Field>
        </Section>

        {!editing && (
          <Section title="Cost">
            <Field label="Estimate ($)" htmlFor="wo-estimate_amount" hint="Optional. Can be added or revised later." className="col-span-2">
              <Input {...bind("estimate_amount")} inputMode="decimal" />
            </Field>
          </Section>
        )}
      </form>
    </Sheet>
  );
}
