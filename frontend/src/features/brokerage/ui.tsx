"use client";

import { format, isValid, parseISO } from "date-fns";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { Badge, statusTone, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { cn, toNumber } from "@/lib/utils";

import { OrganizationPicker, PersonPicker } from "@/features/contacts/pickers";

import { label, type DocOption } from "./api";

/* ------------------------------------------------------------------ status badge */

const TONES: Record<string, Tone> = {
  prospect: "neutral", pitched: "sky", engaged: "green", lost: "red",
  coming_soon: "sky", under_contract: "green", sold: "neutral", leased: "neutral", withdrawn: "neutral",
  in_review: "amber", published: "green", retired: "neutral", live: "green", paused: "amber", removed: "neutral",
  not_syndicated: "neutral", error: "red",
  new: "blue", contacted: "sky", qualified: "blue", nda_sent: "amber", toured: "green", offer: "blue",
  scheduled: "blue", no_show: "red", suggested: "neutral", sent: "sky", interested: "green",
  countered: "amber", accepted: "green", superseded: "neutral", withdrawn_offer: "neutral",
  lead: "neutral", engaged_deal: "sky", marketing: "sky", touring: "blue",
  interviewing: "blue", hired: "green", onboarding: "amber", declined: "red",
  planned: "neutral", confirmed: "blue", visited: "green", skipped: "neutral",
  not_sent: "neutral", signed: "green", required: "amber", delivered: "sky", acknowledged: "green", waived: "neutral",
  changes_requested: "amber", provided: "sky", missing: "red", submitted: "blue", under_review: "amber",
  shortlisted: "sky", nda_required: "amber", revoked: "red", pending_renewal: "amber", suspended: "red",
  warning: "amber", fulfilled: "green", terminated: "neutral",
};

export function State({ value, text }: { value?: string | null; text?: string }) {
  if (!value) return <span className="text-ink-3">—</span>;
  return (
    <Badge tone={TONES[value] ?? statusTone(value)} dot>
      {text ?? label(value)}
    </Badge>
  );
}

/* ------------------------------------------------------------------ document picker */

export function DocumentPicker({ value, onChange, placeholder }: { value: string | null | undefined; onChange: (id: string | null) => void; placeholder?: string }) {
  return (
    <EntityPicker<DocOption>
      endpoint="/brokerage/documents/options"
      value={value}
      onChange={(id) => onChange(id)}
      placeholder={placeholder ?? "Select document"}
      toOption={(d) => ({ id: d.id, label: d.title, sublabel: [d.doc_class, d.filename].filter(Boolean).join(" · ") || undefined })}
    />
  );
}

function MultiDocumentPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="space-y-1.5">
      {value.map((id, i) => (
        <DocumentPicker key={id} value={id} onChange={(next) => onChange(next ? value.map((v, j) => (j === i ? next : v)) : value.filter((_, j) => j !== i))} />
      ))}
      <DocumentPicker value={null} onChange={(id) => id && !value.includes(id) && onChange([...value, id])} placeholder="Add document…" />
    </div>
  );
}

/* ------------------------------------------------------------------ generic record sheet */

type Opt = { value: string; label: string };
export type FieldSpec = {
  key: string;
  label: string;
  type:
    | "text" | "textarea" | "number" | "date" | "datetime" | "time" | "select" | "multiselect" | "tags" | "checkbox"
    | "property" | "person" | "organization" | "user" | "document" | "documents" | "custom";
  options?: Opt[];
  required?: boolean;
  hint?: string;
  full?: boolean;
  placeholder?: string;
  suffix?: string;
  render?: (value: unknown, set: (v: unknown) => void, values: Record<string, unknown>) => ReactNode;
  show?: (values: Record<string, unknown>) => boolean;
};

function toLocalInput(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  const d = parseISO(v);
  return isValid(d) ? format(d, "yyyy-MM-dd'T'HH:mm") : "";
}

function FieldInput({ spec, value, set, values }: { spec: FieldSpec; value: unknown; set: (v: unknown) => void; values: Record<string, unknown> }) {
  const str = value === null || value === undefined ? "" : String(value);
  switch (spec.type) {
    case "textarea":
      return <Textarea value={str} onChange={(e) => set(e.target.value)} placeholder={spec.placeholder} />;
    case "number":
      return <Input inputMode="decimal" value={str} onChange={(e) => set(e.target.value === "" ? null : e.target.value)} placeholder={spec.placeholder ?? spec.suffix} />;
    case "date":
      return <Input type="date" value={str.slice(0, 10)} onChange={(e) => set(e.target.value || null)} />;
    case "datetime":
      return <Input type="datetime-local" value={toLocalInput(value)} onChange={(e) => set(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case "time":
      return <Input type="time" value={str} onChange={(e) => set(e.target.value || null)} />;
    case "select":
      return <Select value={str} onChange={(e) => set(e.target.value || null)} options={spec.options ?? []} placeholder={spec.required ? undefined : "—"} />;
    case "multiselect": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {(spec.options ?? []).map((o) => {
            const on = arr.includes(o.value);
            return (
              <button
                type="button"
                key={o.value}
                onClick={() => set(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])}
                className={cn("h-7 rounded-md border px-2 text-xs", on ? "border-accent/30 bg-accent-soft text-accent-ink" : "border-line-strong bg-surface text-ink-2 hover:bg-subtle")}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "tags":
      return (
        <Input
          value={Array.isArray(value) ? (value as string[]).join(", ") : str}
          onChange={(e) => set(e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
          placeholder={spec.placeholder ?? "Comma separated"}
        />
      );
    case "checkbox":
      return (
        <label className="flex h-8 items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={!!value} onChange={(c) => set(c)} />
          {spec.placeholder ?? "Yes"}
        </label>
      );
    case "property":
      return <PropertyPicker value={str || null} onChange={(id) => set(id)} />;
    case "person":
      return <PersonPicker value={str || null} onChange={(id) => set(id)} />;
    case "organization":
      return <OrganizationPicker value={str || null} onChange={(id) => set(id)} />;
    case "user":
      return <UserPicker value={str || null} onChange={(id) => set(id)} />;
    case "document":
      return <DocumentPicker value={str || null} onChange={(id) => set(id)} />;
    case "documents":
      return <MultiDocumentPicker value={Array.isArray(value) ? (value as string[]) : []} onChange={(ids) => set(ids)} />;
    case "custom":
      return <>{spec.render?.(value, set, values)}</>;
    default:
      return <Input value={str} onChange={(e) => set(e.target.value)} placeholder={spec.placeholder} />;
  }
}

function normalise(spec: FieldSpec, v: unknown): unknown {
  if (v === "" || v === undefined) return null;
  if (spec.type === "number" && v !== null) return toNumber(String(v));
  return v;
}

/**
 * Sheet form driven by field specs. In edit mode only changed fields are sent; in create mode empty
 * fields are omitted so server defaults apply.
 */
export function RecordSheet({
  open,
  onOpenChange,
  title,
  description,
  fields,
  initial,
  mode = "create",
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  fields: FieldSpec[];
  initial?: Record<string, unknown>;
  mode?: "create" | "edit";
  submitLabel?: string;
  onSubmit: (payload: Record<string, unknown>) => Promise<unknown>;
  children?: ReactNode;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setValues({ ...(initial ?? {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const visible = fields.filter((f) => !f.show || f.show(values));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = visible.filter((f) => f.required && (values[f.key] === null || values[f.key] === undefined || values[f.key] === "" || (Array.isArray(values[f.key]) && !(values[f.key] as unknown[]).length)));
    if (missing.length) {
      toast.error(`Required: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    const payload: Record<string, unknown> = {};
    for (const f of visible) {
      if (f.type === "custom" && !(f.key in values)) continue;
      const v = normalise(f, values[f.key]);
      if (mode === "edit") {
        const before = normalise(f, initial?.[f.key]);
        if (JSON.stringify(v) !== JSON.stringify(before)) payload[f.key] = v;
      } else if (v !== null && !(Array.isArray(v) && v.length === 0 && !f.required)) payload[f.key] = v;
    }
    if (mode === "edit" && !Object.keys(payload).length) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(payload);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="record-sheet-form" loading={busy}>
            {submitLabel ?? (mode === "edit" ? "Save changes" : "Create")}
          </Button>
        </>
      }
    >
      <form id="record-sheet-form" onSubmit={submit} className="space-y-4">
        {children}
        <div className="grid grid-cols-2 gap-3">
          {visible.map((f) => (
            <Field key={f.key} label={f.label} required={f.required} hint={f.hint} className={cn(f.full || ["textarea", "multiselect", "documents", "custom"].includes(f.type) ? "col-span-2" : "col-span-2 sm:col-span-1")}>
              <FieldInput spec={f} value={values[f.key]} set={(v) => setValues((s) => ({ ...s, [f.key]: v }))} values={values} />
            </Field>
          ))}
        </div>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ small layout helpers */

export function Section({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Party label: person and/or organization. */
export function party(p: { person_label?: string | null; organization_label?: string | null }) {
  return [p.organization_label, p.person_label].filter(Boolean).join(" · ") || null;
}
