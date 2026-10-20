"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";

import { PROPERTY_TYPE_TEMPLATE, TEMPLATE_LABELS, TEMPLATES, useCreateUwModel } from "./api";

const nextMonth = () => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  return d.toISOString().slice(0, 10);
};

/** New underwriting model: template seeds the assumption structure; tenants come from leases/spaces when present. */
export function UwModelCreateSheet({
  open,
  onOpenChange,
  propertyId,
  opportunityId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  propertyId?: string | null;
  opportunityId?: string | null;
}) {
  const router = useRouter();
  const create = useCreateUwModel();
  const [s, setS] = useState({ name: "", template: "multi_tenant_retail", property: propertyId ?? null as string | null, opportunity: opportunityId ?? null as string | null, compSet: null as string | null, start: nextMonth(), seed: "auto" });

  useEffect(() => {
    if (open) setS({ name: "", template: "multi_tenant_retail", property: propertyId ?? null, opportunity: opportunityId ?? null, compSet: null, start: nextMonth(), seed: "auto" });
  }, [open, propertyId, opportunityId]);

  useEffect(() => {
    if (!open || !s.property) return;
    let cancelled = false;
    api
      .get<{ property_type: string; name: string | null; address_line: string }>(`/properties/${s.property}`)
      .then((p) => {
        if (cancelled) return;
        setS((x) => ({ ...x, template: PROPERTY_TYPE_TEMPLATE[p.property_type] ?? x.template, name: x.name || `${p.name || p.address_line} underwriting` }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, s.property]);

  const submit = () =>
    create.mutate(
      { name: s.name.trim(), template: s.template, property_id: s.property, opportunity_id: s.opportunity, comp_set_id: s.compSet, analysis_start: s.start || null, seed_tenants: s.seed },
      {
        onSuccess: (m) => {
          toast.success("Model created");
          onOpenChange(false);
          router.push(`/underwriting/${m.id}`);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New underwriting model"
      description="Starts as version 1 (draft). Template defaults are unsourced until you confirm them."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!s.name.trim()} loading={create.isPending} onClick={submit}>
            Create model
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Property">
          <PropertyPicker value={s.property} onChange={(id) => setS((x) => ({ ...x, property: id }))} />
        </Field>
        <Field label="Name" required>
          <Input value={s.name} onChange={(e) => setS((x) => ({ ...x, name: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Template" required>
            <Select value={s.template} onChange={(e) => setS((x) => ({ ...x, template: e.target.value }))} options={TEMPLATES.map((t) => ({ value: t, label: TEMPLATE_LABELS[t] }))} />
          </Field>
          <Field label="Analysis start">
            <Input type="date" value={s.start} onChange={(e) => setS((x) => ({ ...x, start: e.target.value }))} />
          </Field>
        </div>
        {s.template !== "land" && (
          <Field label="Seed tenant rows from" hint="Leases are used when the lease module has them; otherwise spaces. Rows can always be entered manually.">
            <Select
              value={s.seed}
              onChange={(e) => setS((x) => ({ ...x, seed: e.target.value }))}
              options={[
                { value: "auto", label: "Leases, else spaces" },
                { value: "leases", label: "Leases only" },
                { value: "spaces", label: "Spaces only" },
                { value: "none", label: "Start empty" },
              ]}
            />
          </Field>
        )}
        <Field label="Opportunity">
          <EntityPicker<{ id: string; title: string; stage: string }>
            endpoint="/opportunities"
            value={s.opportunity}
            onChange={(id) => setS((x) => ({ ...x, opportunity: id }))}
            placeholder="Optional"
            toOption={(o) => ({ id: o.id, label: o.title, sublabel: o.stage })}
          />
        </Field>
        <Field label="Comp set" hint="A sale comp set on cap-rate basis seeds the exit cap; a lease comp set seeds market rent, with the comps as evidence.">
          <EntityPicker<{ id: string; name: string; kind: string; subject_label: string | null }>
            endpoint="/comp-sets"
            value={s.compSet}
            onChange={(id) => setS((x) => ({ ...x, compSet: id }))}
            placeholder="Optional"
            toOption={(c) => ({ id: c.id, label: c.name, sublabel: [c.kind === "sale" ? "Sale" : "Lease", c.subject_label].filter(Boolean).join(" · ") })}
          />
        </Field>
      </div>
    </Sheet>
  );
}
