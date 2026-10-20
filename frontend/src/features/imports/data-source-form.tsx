"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { toNumber } from "@/lib/utils";

import { CADENCE_LABELS, CADENCES, useSaveDataSource, type DataSource, type DataSourceInput } from "./api";

const TEXT_KEYS = [
  "provider", "description", "license_terms", "permitted_use", "cadence", "cost_notes", "contact_name", "contact_email",
  "contact_phone", "renewal_date",
] as const;

type FormState = Record<(typeof TEXT_KEYS)[number] | "cost", string> & { redistribution_allowed: boolean; is_active: boolean };

function toForm(s?: DataSource | null): FormState {
  const f = { cadence: "ad_hoc", redistribution_allowed: false, is_active: true } as FormState;
  for (const k of TEXT_KEYS) f[k] = s ? ((s[k] as string | null) ?? "") : f[k] ?? "";
  f.cost = s?.cost != null ? String(s.cost) : "";
  if (s) {
    f.redistribution_allowed = s.redistribution_allowed;
    f.is_active = s.is_active;
  }
  return f;
}

export function DataSourceFormSheet({
  open,
  onOpenChange,
  source,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  source?: DataSource | null;
  onSaved?: (s: DataSource) => void;
}) {
  const [form, setForm] = useState<FormState>(toForm(source));
  const save = useSaveDataSource(source?.id);

  useEffect(() => {
    if (open) setForm(toForm(source));
  }, [open, source]);

  const bind = (key: (typeof TEXT_KEYS)[number] | "cost") => ({
    id: key,
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: Partial<DataSourceInput> = {
      redistribution_allowed: form.redistribution_allowed,
      is_active: form.is_active,
      cost: toNumber(form.cost),
    };
    for (const k of TEXT_KEYS) {
      const v = form[k].trim();
      (data as Record<string, unknown>)[k] = v === "" ? null : v;
    }
    data.provider = form.provider.trim();
    data.cadence = form.cadence || "ad_hoc";
    save.mutate(data, {
      onSuccess: (s) => {
        toast.success(source ? "Data source updated" : "Data source added");
        onOpenChange(false);
        onSaved?.(s);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={source ? "Edit data source" : "New data source"}
      description="External data can only be loaded against an active source with its license terms on record."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="data-source-form" loading={save.isPending}>
            {source ? "Save changes" : "Add source"}
          </Button>
        </>
      }
    >
      <form id="data-source-form" onSubmit={submit} className="space-y-6">
        <section className="grid grid-cols-2 gap-3">
          <Field label="Provider" required className="col-span-2">
            <Input {...bind("provider")} required placeholder="e.g. County assessor roll, CoStar, broker list" />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea {...bind("description")} rows={2} />
          </Field>
          <Field label="Cadence">
            <Select {...bind("cadence")} options={CADENCES.map((c) => ({ value: c, label: CADENCE_LABELS[c] }))} />
          </Field>
          <Field label="Renewal date">
            <Input type="date" {...bind("renewal_date")} />
          </Field>
        </section>

        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">License</h4>
          <Field label="License terms">
            <Textarea {...bind("license_terms")} rows={3} placeholder="Term, seat limits, attribution requirements…" />
          </Field>
          <Field label="Permitted use">
            <Textarea {...bind("permitted_use")} rows={2} placeholder="e.g. Internal acquisition research only" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={form.redistribution_allowed} onChange={(v) => setForm((f) => ({ ...f, redistribution_allowed: v }))} />
            Redistribution to third parties is allowed
          </label>
        </section>

        <section className="grid grid-cols-2 gap-3">
          <h4 className="col-span-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">Commercial & contact</h4>
          <Field label="Cost ($)">
            <Input {...bind("cost")} inputMode="decimal" />
          </Field>
          <Field label="Cost basis">
            <Input {...bind("cost_notes")} placeholder="e.g. per year, per record" />
          </Field>
          <Field label="Contact name">
            <Input {...bind("contact_name")} />
          </Field>
          <Field label="Contact email">
            <Input type="email" {...bind("contact_email")} />
          </Field>
          <Field label="Contact phone">
            <Input {...bind("contact_phone")} />
          </Field>
        </section>

        <label className="flex items-center gap-2 rounded-lg border border-line bg-subtle/60 p-3 text-sm text-ink-2">
          <Checkbox checked={form.is_active} onChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
          Active — imports can be committed against this source
        </label>
      </form>
    </Sheet>
  );
}
