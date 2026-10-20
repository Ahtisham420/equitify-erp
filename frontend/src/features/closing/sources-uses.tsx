"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatPercent, titleCase, toNumber } from "@/lib/utils";

import { SOURCE_KINDS, USE_KINDS, useClosingMutation, type Closing } from "./api";

type Row = { label: string; kind: string; amount: string; capitalized: boolean };

const toRows = (lines: { label: string; kind: string; amount: number; capitalized?: boolean }[]): Row[] =>
  lines.map((l) => ({ label: l.label, kind: l.kind, amount: String(l.amount), capitalized: l.capitalized ?? true }));
const sum = (rows: Row[], pred: (r: Row) => boolean = () => true) => rows.filter(pred).reduce((a, r) => a + (toNumber(r.amount) ?? 0), 0);

function Lines({ title, rows, setRows, kinds, withCapitalized, editable }: { title: string; rows: Row[]; setRows: (r: Row[]) => void; kinds: readonly string[]; withCapitalized?: boolean; editable: boolean }) {
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
        <span className="text-sm font-medium tabular">{formatCurrency(sum(rows))}</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input className="flex-1" value={r.label} disabled={!editable} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label" />
            <Select className="w-40" value={r.kind} disabled={!editable} onChange={(e) => update(i, { kind: e.target.value })} options={kinds.map((k) => ({ value: k, label: titleCase(k) }))} />
            <Input className="w-36 text-right tabular" value={r.amount} disabled={!editable} onChange={(e) => update(i, { amount: e.target.value })} inputMode="decimal" placeholder="0" />
            {withCapitalized && (
              <label className="flex w-20 items-center gap-1 text-xs text-ink-2" title="Included in basis">
                <Checkbox checked={r.capitalized} onChange={(v) => editable && update(i, { capitalized: v })} />
                Basis
              </label>
            )}
            {editable && (
              <Button size="icon-sm" variant="ghost" aria-label="Remove line" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
        {editable && (
          <Button size="xs" variant="ghost" onClick={() => setRows([...rows, { label: "", kind: kinds[0], amount: "", capitalized: true }])}>
            <Plus className="!size-3.5" /> Add line
          </Button>
        )}
      </div>
    </div>
  );
}

export function SourcesUsesEditor({ closing }: { closing: Closing }) {
  const { can } = useAuth();
  const editable = closing.status === "open" && can("closing", "edit");
  const [sources, setSources] = useState<Row[]>(toRows(closing.sources));
  const [uses, setUses] = useState<Row[]>(toRows(closing.uses));
  const save = useClosingMutation(closing.id, (body: unknown) => api.put<Closing>(`/closings/${closing.id}/sources-uses`, body));

  const savedKey = JSON.stringify([closing.sources, closing.uses]);
  useEffect(() => {
    setSources(toRows(closing.sources));
    setUses(toRows(closing.uses));
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalS = sum(sources);
  const totalU = sum(uses);
  const basis = sum(uses, (r) => r.capitalized);
  const gap = totalS - totalU;
  const cs = closing.capital_structure ?? {};
  const invalid = [...sources, ...uses].some((r) => !r.label.trim() || toNumber(r.amount) === null || (toNumber(r.amount) ?? 0) < 0);

  const submit = () =>
    save.mutate(
      {
        sources: sources.map((r) => ({ label: r.label.trim(), kind: r.kind, amount: toNumber(r.amount) ?? 0 })),
        uses: uses.map((r) => ({ label: r.label.trim(), kind: r.kind, amount: toNumber(r.amount) ?? 0, capitalized: r.capitalized })),
      },
      { onSuccess: () => toast.success("Sources and uses saved"), onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title="Final sources & uses"
          description={editable ? "Must balance before the closing can complete." : "Frozen at completion."}
          actions={editable && <Button size="sm" variant="primary" loading={save.isPending} disabled={invalid} onClick={submit}>Save</Button>}
        />
        <CardBody className="space-y-6">
          <Lines title="Sources" rows={sources} setRows={setSources} kinds={SOURCE_KINDS} editable={editable} />
          <Lines title="Uses" rows={uses} setRows={setUses} kinds={USE_KINDS} withCapitalized editable={editable} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Totals & basis" />
        <CardBody className="space-y-3 text-sm">
          <div className="flex justify-between"><span className="text-ink-2">Total sources</span><span className="tabular">{formatCurrency(totalS)}</span></div>
          <div className="flex justify-between"><span className="text-ink-2">Total uses</span><span className="tabular">{formatCurrency(totalU)}</span></div>
          <div className={cn("flex justify-between font-medium", Math.abs(gap) > 0.5 ? "text-negative" : "text-positive")}>
            <span>{Math.abs(gap) > 0.5 ? "Out of balance" : "Balanced"}</span>
            <span className="tabular">{formatCurrency(gap)}</span>
          </div>
          <div className="flex justify-between border-t border-line pt-3 font-medium"><span>Basis</span><span className="tabular">{formatCurrency(basis)}</span></div>
          <div className="space-y-1.5 border-t border-line pt-3 text-xs">
            <p className="font-medium text-ink-2">Capital structure (saved)</p>
            <div className="flex justify-between"><span className="text-ink-3">Equity</span><span className="tabular">{formatCurrency(cs.equity ?? null)}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">Debt</span><span className="tabular">{formatCurrency(cs.debt ?? null)}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">LTV</span><span className="tabular">{formatPercent(cs.ltv_pct ?? null, 1)}</span></div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
