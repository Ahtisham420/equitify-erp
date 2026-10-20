"use client";

import { useEffect, useState, type ReactNode } from "react";

import { EntityPicker, UserPicker } from "@/components/data/entity-picker";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { titleCase, toNumber } from "@/lib/utils";

import { DEAD_REASON_LABELS, DEAD_REASONS, PRIORITIES, fromLocalInput, toLocalInput, type ReactivationRule, type ReactivationTypeSpec } from "./api";

type Kind = "text" | "textarea" | "money" | "number" | "percent" | "date" | "datetime" | "person" | "organization" | "list" | "dead_reason" | "rule" | "user" | "priority";

export const FIELD_DEFS: Record<string, { label: string; kind: Kind; hint?: string }> = {
  title: { label: "Title", kind: "text" },
  owner_id: { label: "Owner", kind: "user" },
  priority: { label: "Priority", kind: "priority" },
  source: { label: "Source", kind: "text" },
  primary_person_id: { label: "Primary contact", kind: "person" },
  primary_organization_id: { label: "Owner organization", kind: "organization" },
  next_action: { label: "Next action", kind: "text" },
  next_action_at: { label: "Next action due", kind: "datetime" },
  research_missing_fields: { label: "Missing fields to resolve", kind: "list", hint: "Comma separated, e.g. noi, year_built" },
  research_notes: { label: "Research notes", kind: "textarea" },
  estimated_value: { label: "Estimated value ($)", kind: "money" },
  cap_rate: { label: "Cap rate (%)", kind: "percent" },
  underwriting_notes: { label: "Underwriting notes", kind: "textarea" },
  price_expectation: { label: "Owner price expectation ($)", kind: "money" },
  offer_price: { label: "Offer price ($)", kind: "money" },
  offer_sent_at: { label: "Offer sent", kind: "datetime" },
  response_due_at: { label: "Response due", kind: "datetime" },
  contract_executed_on: { label: "Contract executed on", kind: "date" },
  dd_deadline: { label: "Due diligence deadline", kind: "date" },
  closing_date: { label: "Closing date", kind: "date" },
  closed_price: { label: "Closed price ($)", kind: "money" },
  closed_on: { label: "Closed on", kind: "date" },
  dead_reason: { label: "Dead reason", kind: "dead_reason" },
  dead_notes: { label: "Dead notes", kind: "textarea" },
  price_gap: { label: "Price gap ($)", kind: "money", hint: "Owner expectation minus our maximum" },
  reactivation_rule: { label: "Reactivation rule", kind: "rule" },
  next_touch_on: { label: "Next touch", kind: "date" },
  nurture_cadence_days: { label: "Touch cadence (days)", kind: "number" },
  notes: { label: "Notes", kind: "textarea" },
};

export function NumberInput({ value, onChange, placeholder }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => {
    if (toNumber(text) !== (value ?? null)) setText(value == null ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(toNumber(e.target.value));
      }}
    />
  );
}

function ListInput({ value, onChange }: { value: string[] | null | undefined; onChange: (v: string[]) => void }) {
  const [text, setText] = useState((value ?? []).join(", "));
  useEffect(() => {
    const parsed = text.split(",").map((x) => x.trim()).filter(Boolean);
    if (parsed.join(",") !== (value ?? []).join(",")) setText((value ?? []).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean));
      }}
    />
  );
}

interface PersonLite { id: string; full_name: string; primary_email?: string | null }
interface OrgLite { id: string; name: string; city?: string | null; state?: string | null }

export function ReactivationRuleBuilder({
  value,
  onChange,
  types,
}: {
  value: ReactivationRule | null | undefined;
  onChange: (v: ReactivationRule | null) => void;
  types: ReactivationTypeSpec[];
}) {
  const spec = types.find((t) => t.type === value?.type);
  const params = value?.params ?? {};
  const setParam = (k: string, v: unknown) => value && onChange({ ...value, params: { ...params, [k]: v } });

  return (
    <div className="space-y-3 rounded-md border border-line bg-subtle/60 p-3">
      <Field label="Trigger type" required>
        <Select
          value={value?.type ?? ""}
          placeholder="Choose when to revisit…"
          onChange={(e) => onChange(e.target.value ? { type: e.target.value, params: {} } : null)}
          options={types.map((t) => ({ value: t.type, label: t.label }))}
        />
      </Field>
      {spec && (
        <div className="grid grid-cols-2 gap-3">
          {spec.params.map((p) => {
            const required = spec.required.includes(p.key);
            const v = params[p.key];
            return (
              <Field key={p.key} label={p.label} required={required} className={p.type === "text" ? "col-span-2" : undefined}>
                {p.type === "number" && <NumberInput value={(v as number | null) ?? null} onChange={(n) => setParam(p.key, n)} />}
                {p.type === "date" && <Input type="date" value={(v as string) ?? ""} onChange={(e) => setParam(p.key, e.target.value || null)} />}
                {p.type === "text" && <Input value={(v as string) ?? ""} onChange={(e) => setParam(p.key, e.target.value)} />}
                {p.type === "select" && (
                  <Select
                    value={(v as string) ?? ""}
                    placeholder="Select…"
                    onChange={(e) => setParam(p.key, e.target.value || null)}
                    options={(p.options ?? []).map((o) => ({ value: o, label: titleCase(o) }))}
                  />
                )}
                {p.type === "boolean" && (
                  <label className="flex h-8 items-center gap-2 text-sm text-ink-2">
                    <Checkbox checked={!!v} onChange={(c) => setParam(p.key, c)} /> Yes
                  </label>
                )}
              </Field>
            );
          })}
          {spec.any_of.length > 0 && <p className="col-span-2 text-xs text-ink-3">Provide at least one of: {spec.any_of.map((k) => spec.params.find((p) => p.key === k)?.label.toLowerCase() ?? k).join(", ")}.</p>}
        </div>
      )}
    </div>
  );
}

/** One editable opportunity field, rendered by its kind. Values are API-shaped. */
export function StageFieldInput({
  field,
  value,
  onChange,
  types = [],
  required,
}: {
  field: string;
  value: unknown;
  onChange: (v: unknown) => void;
  types?: ReactivationTypeSpec[];
  required?: boolean;
}) {
  const def = FIELD_DEFS[field] ?? { label: titleCase(field), kind: "text" as Kind };
  const wide = ["textarea", "rule", "list"].includes(def.kind);
  let input: ReactNode;
  switch (def.kind) {
    case "textarea":
      input = <Textarea value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "money":
    case "number":
    case "percent":
      input = <NumberInput value={(value as number | null) ?? null} onChange={onChange} />;
      break;
    case "date":
      input = <Input type="date" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "datetime":
      input = <Input type="datetime-local" value={toLocalInput(value as string | null)} onChange={(e) => onChange(fromLocalInput(e.target.value))} />;
      break;
    case "list":
      input = <ListInput value={value as string[] | null} onChange={onChange} />;
      break;
    case "user":
      input = <UserPicker value={value as string | null} onChange={onChange} />;
      break;
    case "priority":
      input = <Select value={(value as string) ?? "normal"} onChange={(e) => onChange(e.target.value)} options={PRIORITIES.map((p) => ({ value: p, label: titleCase(p) }))} />;
      break;
    case "person":
      input = (
        <EntityPicker<PersonLite>
          endpoint="/people"
          value={value as string | null}
          onChange={(id) => onChange(id)}
          placeholder="Select person"
          toOption={(p) => ({ id: p.id, label: p.full_name, sublabel: p.primary_email ?? undefined })}
        />
      );
      break;
    case "organization":
      input = (
        <EntityPicker<OrgLite>
          endpoint="/organizations"
          value={value as string | null}
          onChange={(id) => onChange(id)}
          placeholder="Select organization"
          toOption={(o) => ({ id: o.id, label: o.name, sublabel: [o.city, o.state].filter(Boolean).join(", ") || undefined })}
        />
      );
      break;
    case "dead_reason":
      input = (
        <Select
          value={(value as string) ?? ""}
          placeholder="Select reason…"
          onChange={(e) => onChange(e.target.value || null)}
          options={DEAD_REASONS.map((r) => ({ value: r, label: DEAD_REASON_LABELS[r] }))}
        />
      );
      break;
    case "rule":
      input = <ReactivationRuleBuilder value={value as ReactivationRule | null} onChange={onChange} types={types} />;
      break;
    default:
      input = <Input value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />;
  }
  return (
    <Field label={def.label} hint={def.hint} required={required} className={wide ? "col-span-2" : undefined}>
      {input}
    </Field>
  );
}
