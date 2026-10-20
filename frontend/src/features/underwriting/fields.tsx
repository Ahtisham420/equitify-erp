"use client";

import { Link2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Label } from "@/components/ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

import { isSourced, svValue, type SV } from "./api";

function asSV(x: unknown): SV {
  if (x && typeof x === "object" && "value" in (x as Record<string, unknown>)) return x as SV;
  return { value: typeof x === "number" ? x : null, source: null };
}

/** Evidence chip for a material assumption: green when sourced, amber when a value has no source. */
export function SourceChip({ value, onChange, readOnly }: { value: unknown; onChange: (sv: SV) => void; readOnly?: boolean }) {
  const sv = asSV(value);
  const sourced = isSourced(sv);
  const hasValue = sv.value !== null && sv.value !== undefined;
  const [draft, setDraft] = useState({ source: sv.source ?? "", comp_id: sv.comp_id ?? "", document_id: sv.document_id ?? "", note: sv.note ?? "" });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) setDraft({ source: sv.source ?? "", comp_id: sv.comp_id ?? "", document_id: sv.document_id ?? "", note: sv.note ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const label = sourced ? sv.source || (sv.comp_ids?.length ? `${sv.comp_ids.length} comps` : sv.comp_id ? "Comp" : "Document") : hasValue ? "Unsourced" : "No source";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={sourced ? `Source: ${label}` : "Add the evidence behind this assumption"}
          className={cn(
            "inline-flex h-5 max-w-[160px] items-center gap-1 truncate rounded px-1.5 text-2xs font-medium ring-1 ring-inset",
            sourced ? "bg-positive-soft text-positive ring-positive/20" : hasValue ? "bg-caution-soft text-caution ring-caution/20" : "bg-muted text-ink-3 ring-line-strong/50",
          )}
        >
          <Link2 className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <div className="space-y-2.5">
          <Field label="Source">
            <Input disabled={readOnly} value={draft.source} onChange={(e) => setDraft((d) => ({ ...d, source: e.target.value }))} placeholder="e.g. Rent roll 2026-09, broker survey" />
          </Field>
          <Field label="Comp id">
            <Input disabled={readOnly} value={draft.comp_id} onChange={(e) => setDraft((d) => ({ ...d, comp_id: e.target.value }))} placeholder="Sale or lease comp UUID" />
          </Field>
          <Field label="Document id">
            <Input disabled={readOnly} value={draft.document_id} onChange={(e) => setDraft((d) => ({ ...d, document_id: e.target.value }))} placeholder="UUID from Documents" />
          </Field>
          <Field label="Note">
            <Input disabled={readOnly} value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
          </Field>
          {sv.comp_ids && sv.comp_ids.length > 0 && <p className="text-2xs text-ink-3">Linked comps: {sv.comp_ids.length}{sv.comp_set_id ? " (from comp set)" : ""}</p>}
          {!readOnly && (
            <div className="flex justify-end gap-2">
              <PopoverClose asChild>
                <Button size="sm">Cancel</Button>
              </PopoverClose>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onChange({ ...sv, source: draft.source.trim() || null, comp_id: draft.comp_id.trim() || null, document_id: draft.document_id.trim() || null, note: draft.note.trim() || null });
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Numeric input that keeps a local string so partial input (e.g. "6.") is not lost. */
export function NumInput({ value, onChange, disabled, className, placeholder }: { value: number | null | undefined; onChange: (n: number | null) => void; disabled?: boolean; className?: string; placeholder?: string }) {
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  useEffect(() => {
    const n = text.trim() === "" ? null : Number(text);
    if (n !== (value ?? null)) setText(value === null || value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      inputMode="decimal"
      disabled={disabled}
      className={className}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.replace(/,/g, "").trim();
        if (t === "") onChange(null);
        else if (Number.isFinite(Number(t))) onChange(Number(t));
      }}
    />
  );
}

/** Labeled sourced-value input (value + evidence chip). */
export function SVField({ label, value, onChange, readOnly, hint, suffix }: { label: string; value: unknown; onChange: (sv: SV) => void; readOnly?: boolean; hint?: ReactNode; suffix?: string }) {
  const sv = asSV(value);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <Label className="mb-0">
          {label}
          {suffix && <span className="ml-1 text-ink-3">({suffix})</span>}
        </Label>
        <SourceChip value={sv} onChange={onChange} readOnly={readOnly} />
      </div>
      <NumInput value={svValue(sv)} disabled={readOnly} onChange={(n) => onChange({ ...sv, value: n })} />
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function NumField({ label, value, onChange, readOnly, hint, suffix }: { label: string; value: unknown; onChange: (n: number | null) => void; readOnly?: boolean; hint?: ReactNode; suffix?: string }) {
  return (
    <Field label={suffix ? `${label} (${suffix})` : label} hint={hint}>
      <NumInput value={typeof value === "number" ? value : svValue(value)} disabled={readOnly} onChange={onChange} />
    </Field>
  );
}

export function FormSection({ title, description, children, actions }: { title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface shadow-card">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
