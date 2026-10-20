"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn, titleCase, toNumber } from "@/lib/utils";

import { REQUIREMENT_LABELS, REQUIREMENTS, type BuyboxMeta, type CriterionInput, type FieldMeta, type RequirementLevel } from "./api";

interface Row {
  key: string;
  field: string;
  operator: string;
  requirement: RequirementLevel;
  note: string | null;
  a: string;
  b: string;
  list: string[];
  flag: boolean;
}

let seq = 0;
const nextKey = () => `row-${++seq}`;
const numeric = (f?: FieldMeta) => f?.type === "number" || f?.type === "integer";

function toRow(c: CriterionInput, f?: FieldMeta): Row {
  const row: Row = { key: nextKey(), field: c.field, operator: c.operator, requirement: c.requirement, note: c.note ?? null, a: "", b: "", list: [], flag: true };
  const v = c.value;
  if (c.operator === "is_set") row.flag = v !== false;
  else if (c.operator === "between" && Array.isArray(v)) [row.a, row.b] = [String(v[0] ?? ""), String(v[1] ?? "")];
  else if ((c.operator === "in" || c.operator === "not_in") && f?.type === "enum" && Array.isArray(v)) row.list = v.map(String);
  else if (Array.isArray(v)) row.a = v.join(", ");
  else row.a = v === null || v === undefined ? "" : String(v);
  return row;
}

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Converts a row into a criterion, or returns a validation message. */
function toCriterion(r: Row, f?: FieldMeta): CriterionInput | string {
  const label = f?.label ?? r.field;
  const base = { field: r.field, operator: r.operator, requirement: r.requirement, note: r.note };
  const scalar = (s: string): unknown => (numeric(f) ? toNumber(s) : s.trim() || null);
  if (!f) return "Choose a field";
  if (r.operator === "is_set") return { ...base, value: r.flag };
  if (r.operator === "between") {
    const lo = scalar(r.a);
    const hi = scalar(r.b);
    return lo === null || hi === null ? `${label}: enter both bounds` : { ...base, value: [lo, hi] };
  }
  if (r.operator === "in" || r.operator === "not_in" || f.type === "tags") {
    const values = f.type === "enum" && r.operator !== "contains" ? r.list : splitList(r.a);
    const parsed = numeric(f) ? values.map((v) => toNumber(v)) : values;
    if (!parsed.length || parsed.some((v) => v === null)) return `${label}: enter at least one valid value`;
    return { ...base, value: parsed };
  }
  const v = scalar(r.a);
  return v === null ? `${label}: enter a value` : { ...base, value: v };
}

function ValueInput({ row, field, onChange, disabled }: { row: Row; field?: FieldMeta; onChange: (patch: Partial<Row>) => void; disabled?: boolean }) {
  if (!field) return <Input disabled placeholder="Choose a field" />;
  const inputType = field.type === "date" ? "date" : "text";
  const mode = numeric(field) ? "decimal" : undefined;
  const ph = field.unit ? `Value (${field.unit})` : "Value";

  if (row.operator === "is_set") {
    return (
      <Select
        disabled={disabled}
        value={row.flag ? "true" : "false"}
        onChange={(e) => onChange({ flag: e.target.value === "true" })}
        options={[{ value: "true", label: "Has a value" }, { value: "false", label: "Is empty" }]}
      />
    );
  }
  if (row.operator === "between") {
    return (
      <div className="flex items-center gap-1.5">
        <Input disabled={disabled} type={inputType} inputMode={mode} value={row.a} onChange={(e) => onChange({ a: e.target.value })} placeholder="Min" />
        <span className="text-ink-3">–</span>
        <Input disabled={disabled} type={inputType} inputMode={mode} value={row.b} onChange={(e) => onChange({ b: e.target.value })} placeholder="Max" />
      </div>
    );
  }
  if (field.type === "enum" && (row.operator === "in" || row.operator === "not_in")) {
    return (
      <div className="flex flex-wrap gap-1">
        {(field.options ?? []).map((o) => {
          const on = row.list.includes(o);
          return (
            <button
              key={o}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ list: on ? row.list.filter((x) => x !== o) : [...row.list, o] })}
              className={cn(
                "h-6 rounded border px-1.5 text-xs transition-colors",
                on ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-line-strong/80 bg-surface text-ink-2 hover:bg-subtle",
              )}
            >
              {titleCase(o)}
            </button>
          );
        })}
      </div>
    );
  }
  if (field.type === "enum") {
    return (
      <Select
        disabled={disabled}
        value={row.a}
        onChange={(e) => onChange({ a: e.target.value })}
        placeholder="Select…"
        options={(field.options ?? []).map((o) => ({ value: o, label: titleCase(o) }))}
      />
    );
  }
  const listy = row.operator === "in" || row.operator === "not_in" || field.type === "tags";
  return (
    <Input
      disabled={disabled}
      type={listy ? "text" : inputType}
      inputMode={listy ? undefined : mode}
      value={row.a}
      onChange={(e) => onChange({ a: e.target.value })}
      placeholder={listy ? "Comma-separated values" : ph}
    />
  );
}

export function CriteriaBuilder({
  criteria,
  meta,
  readOnly,
  saving,
  onSave,
}: {
  criteria: CriterionInput[];
  meta: BuyboxMeta;
  readOnly?: boolean;
  saving?: boolean;
  onSave: (criteria: CriterionInput[], note: string) => void;
}) {
  const fields = useMemo(() => Object.fromEntries(meta.fields.map((f) => [f.key, f])), [meta]);
  const initial = useMemo(() => criteria.map((c) => toRow(c, fields[c.field])), [criteria, fields]);
  const [rows, setRows] = useState<Row[]>(initial);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(initial);
    setNote("");
    setError(null);
  }, [initial]);

  const converted = rows.map((r) => toCriterion(r, fields[r.field]));
  const dirty = JSON.stringify(converted) !== JSON.stringify(initial.map((r) => toCriterion(r, fields[r.field])));

  const patch = (key: string, p: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...p };
        if (p.field && p.field !== r.field) {
          const ops = fields[p.field]?.operators ?? [];
          next.operator = ops.includes(r.operator) ? r.operator : ops[0] ?? "eq";
          Object.assign(next, { a: "", b: "", list: [], flag: true });
        }
        return next;
      }),
    );

  const add = () => {
    const f = meta.fields[0];
    setRows((rs) => [...rs, { key: nextKey(), field: f.key, operator: f.operators[0], requirement: "mandatory", note: null, a: "", b: "", list: [], flag: true }]);
  };

  const save = () => {
    const bad = converted.find((c) => typeof c === "string");
    if (bad) {
      setError(bad as string);
      return;
    }
    setError(null);
    onSave(converted as CriterionInput[], note.trim());
  };

  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="rounded-md border border-dashed border-line-strong px-3 py-6 text-center text-sm text-ink-3">No criteria yet. Every property passes until you add one.</p>}
      {rows.length > 0 && (
        <div className="hidden grid-cols-[200px_150px_minmax(0,1fr)_150px_32px] gap-2 px-0.5 text-xs font-medium text-ink-3 md:grid">
          <span>Field</span>
          <span>Operator</span>
          <span>Value</span>
          <span>Requirement</span>
          <span />
        </div>
      )}
      {rows.map((r) => {
        const f = fields[r.field];
        return (
          <div key={r.key} className="grid grid-cols-1 items-start gap-2 md:grid-cols-[200px_150px_minmax(0,1fr)_150px_32px]">
            <Select
              disabled={readOnly}
              value={r.field}
              onChange={(e) => patch(r.key, { field: e.target.value })}
              options={meta.fields.map((x) => ({ value: x.key, label: x.label }))}
            />
            <Select
              disabled={readOnly}
              value={r.operator}
              onChange={(e) => patch(r.key, { operator: e.target.value })}
              options={(f?.operators ?? []).map((o) => ({ value: o, label: meta.operator_labels[o] ?? o }))}
            />
            <ValueInput row={r} field={f} disabled={readOnly} onChange={(p) => patch(r.key, p)} />
            <Select
              disabled={readOnly}
              value={r.requirement}
              onChange={(e) => patch(r.key, { requirement: e.target.value as RequirementLevel })}
              options={REQUIREMENTS.map((x) => ({ value: x, label: REQUIREMENT_LABELS[x] }))}
            />
            {!readOnly && (
              <Button size="icon" variant="ghost" aria-label="Remove criterion" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                <Trash2 />
              </Button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <Button size="sm" onClick={add}>
            <Plus /> Add criterion
          </Button>
          {dirty && (
            <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
              {error && <span className="text-xs text-negative">{error}</span>}
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Change note (optional)" className="w-60" />
              <Button size="sm" variant="ghost" onClick={() => setRows(initial)}>
                Discard
              </Button>
              <Button size="sm" variant="primary" loading={saving} onClick={save}>
                Save as new version
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
