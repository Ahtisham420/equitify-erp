"use client";

import { EyeOff, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Checkbox, Tooltip } from "@/components/ui/misc";
import { formatDate } from "@/lib/utils";

import { EVIDENCE_LABELS, EVIDENCE_TYPES, type Evidence } from "./api";

/** Read-only evidence list. Sensitive items are flagged; hidden ones are counted, never shown. */
export function EvidenceList({ items, hidden = 0, compact }: { items: Evidence[]; hidden?: number; compact?: boolean }) {
  if (!items.length && !hidden) return <span className="text-xs text-ink-3">No evidence recorded</span>;
  return (
    <div className={compact ? "flex flex-wrap gap-1" : "space-y-1.5"}>
      {items.map((e, i) =>
        compact ? (
          <Tooltip key={i} content={[e.detail, e.source, e.observed_on ? formatDate(e.observed_on) : null].filter(Boolean).join(" · ") || undefined}>
            <span>
              <Badge tone={e.sensitive ? "amber" : "outline"}>{EVIDENCE_LABELS[e.type] ?? e.type}</Badge>
            </span>
          </Tooltip>
        ) : (
          <div key={i} className="flex items-start gap-2 text-sm">
            <Badge tone={e.sensitive ? "amber" : "outline"}>{EVIDENCE_LABELS[e.type] ?? e.type}</Badge>
            <div className="min-w-0">
              {e.detail && <p className="break-words font-mono text-xs text-ink">{e.detail}</p>}
              <p className="text-xs text-ink-3">
                {[e.source, e.observed_on ? formatDate(e.observed_on) : null, e.sensitive ? "Sensitive · never exported" : null].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
          </div>
        ),
      )}
      {hidden > 0 && (
        <span className="inline-flex items-center gap-1 text-xs text-ink-3">
          <EyeOff className="size-3" /> {hidden} sensitive item{hidden === 1 ? "" : "s"} hidden
        </span>
      )}
    </div>
  );
}

export function EvidenceEditor({ value, onChange }: { value: Evidence[]; onChange: (v: Evidence[]) => void }) {
  const set = (i: number, patch: Partial<Evidence>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="space-y-2">
      {value.map((e, i) => (
        <div key={i} className="space-y-2 rounded-md border border-line p-2">
          <div className="flex gap-2">
            <Select
              className="w-56 shrink-0"
              value={e.type}
              onChange={(ev) => set(i, { type: ev.target.value })}
              options={EVIDENCE_TYPES.map((t) => ({ value: t, label: EVIDENCE_LABELS[t] }))}
            />
            <Input value={e.detail ?? ""} onChange={(ev) => set(i, { detail: ev.target.value })} placeholder="Detail, e.g. the shared address or document reference" />
            <Button size="icon" variant="ghost" aria-label="Remove evidence" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input value={e.source ?? ""} onChange={(ev) => set(i, { source: ev.target.value })} placeholder="Source" />
            <Input type="date" className="w-40 shrink-0" value={e.observed_on ?? ""} onChange={(ev) => set(i, { observed_on: ev.target.value || null })} />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-2">
              <Checkbox checked={!!e.sensitive} onChange={(v) => set(i, { sensitive: v })} />
              Sensitive
            </label>
          </div>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...value, { type: "deed_signatory", detail: "", source: "", observed_on: null, sensitive: false }])}>
        <Plus /> Add evidence
      </Button>
      <p className="text-xs text-ink-3">Sensitive personal circumstances are kept internal and excluded from exports and outbound messaging.</p>
    </div>
  );
}

export function cleanEvidence(items: Evidence[]) {
  return items
    .filter((e) => e.type)
    .map((e) => ({
      type: e.type,
      detail: e.detail?.trim() || null,
      source: e.source?.trim() || null,
      observed_on: e.observed_on || null,
      sensitive: !!e.sensitive,
    }));
}
