"use client";

import { ChevronDown, ChevronRight, History, RotateCcw, Save, XCircle } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { cn, formatDate, formatDateTime, formatNumber, titleCase } from "@/lib/utils";

import { ADJUSTMENT_FACTORS, formatMetric, previewAdjusted, useSaveGrid, useUpdateSetItem, type CompSet, type CompSetItem } from "./api";

type Draft = Record<string, { adjustments: Record<string, string>; notes: Record<string, string>; weight: string }>;

function toDraft(items: CompSetItem[]): Draft {
  const d: Draft = {};
  for (const it of items) {
    d[it.id] = {
      adjustments: Object.fromEntries(ADJUSTMENT_FACTORS.map((f) => [f, it.adjustments[f] !== undefined ? String(it.adjustments[f]) : ""])),
      notes: Object.fromEntries(ADJUSTMENT_FACTORS.map((f) => [f, it.adjustment_notes[f] ?? ""])),
      weight: String(it.weight ?? 1),
    };
  }
  return d;
}

const num = (s: string) => {
  const n = Number(s);
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
};

/** Structured adjustment grid: percentage adjustments per comp and factor, live adjusted metric/value preview. */
export function AdjustmentGrid({ set, editable }: { set: CompSet; editable: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(set.items));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [excluding, setExcluding] = useState<CompSetItem | null>(null);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<CompSetItem | null>(null);
  const saveGrid = useSaveGrid(set.id);
  const updateItem = useUpdateSetItem(set.id);

  useEffect(() => setDraft(toDraft(set.items)), [set.items]);

  const dirty = useMemo(
    () =>
      set.items.some((it) => {
        const d = draft[it.id];
        if (!d) return false;
        if ((num(d.weight) ?? 1) !== it.weight) return true;
        return ADJUSTMENT_FACTORS.some((f) => (num(d.adjustments[f]) ?? 0) !== (it.adjustments[f] ?? 0) || (d.notes[f] ?? "") !== (it.adjustment_notes[f] ?? ""));
      }),
    [draft, set.items],
  );

  const setAdj = (id: string, f: string, v: string) => setDraft((d) => ({ ...d, [id]: { ...d[id], adjustments: { ...d[id].adjustments, [f]: v } } }));
  const setNote = (id: string, f: string, v: string) => setDraft((d) => ({ ...d, [id]: { ...d[id], notes: { ...d[id].notes, [f]: v } } }));
  const setWeight = (id: string, v: string) => setDraft((d) => ({ ...d, [id]: { ...d[id], weight: v } }));

  const save = () =>
    saveGrid.mutate(
      {
        items: set.items.map((it) => {
          const d = draft[it.id];
          const adjustments: Record<string, number> = {};
          for (const f of ADJUSTMENT_FACTORS) {
            const n = num(d.adjustments[f]);
            if (n !== null && n !== 0) adjustments[f] = n;
          }
          const notes: Record<string, string> = {};
          for (const f of ADJUSTMENT_FACTORS) if (d.notes[f]?.trim()) notes[f] = d.notes[f].trim();
          return { id: it.id, adjustments, adjustment_notes: notes, weight: num(d.weight) ?? 1 };
        }),
      },
      { onSuccess: () => toast.success("Adjustment grid saved"), onError: (e) => toast.error(errorMessage(e)) },
    );

  const exclude = () => {
    if (!excluding) return;
    updateItem.mutate(
      { itemId: excluding.id, included: false, exclusion_reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success("Comp excluded; the reason is kept with the set");
          setExcluding(null);
          setReason("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const include = (it: CompSetItem) =>
    updateItem.mutate({ itemId: it.id, included: true }, { onSuccess: () => toast.success("Comp included"), onError: (e) => toast.error(errorMessage(e)) });

  const qty = set.subject_quantity;
  const toValue = (m: number | null) => {
    if (m === null) return null;
    if (set.value_basis === "cap_rate") return qty && m > 0 ? qty / (m / 100) : null;
    if (set.value_basis === "price") return m;
    return qty ? m * qty : null;
  };
  const sorted = [...set.items].sort((a, b) => Number(b.included) - Number(a.included) || a.sort_order - b.sort_order);
  const headCls = "sticky top-0 z-10 whitespace-nowrap border-b border-line bg-subtle px-2 py-2 text-xs font-medium text-ink-3";

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className={cn(headCls, "w-7")} />
                <th className={cn(headCls, "min-w-[200px] text-left")}>Comp</th>
                <th className={cn(headCls, "text-right")}>Base</th>
                {ADJUSTMENT_FACTORS.map((f) => (
                  <th key={f} className={cn(headCls, "w-[78px] text-right")}>
                    {titleCase(f)} %
                  </th>
                ))}
                <th className={cn(headCls, "text-right")}>Net</th>
                <th className={cn(headCls, "text-right")}>Adjusted</th>
                <th className={cn(headCls, "text-right")}>Indicated value</th>
                <th className={cn(headCls, "w-[64px] text-right")}>Weight</th>
                <th className={cn(headCls, "text-right")} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((it) => {
                const d = draft[it.id];
                if (!d) return null;
                const adj = Object.fromEntries(ADJUSTMENT_FACTORS.map((f) => [f, num(d.adjustments[f])]));
                const { net, adjusted } = previewAdjusted(it.base_metric, adj);
                const open = expanded === it.id;
                const compHref = it.sale_comp_id ? `/comps?tab=sale&q=${encodeURIComponent(String(it.comp.label ?? ""))}` : `/comps?tab=lease&q=${encodeURIComponent(String(it.comp.label ?? ""))}`;
                return (
                  <Fragment key={it.id}>
                    <tr className={cn(!it.included && "bg-subtle/50 text-ink-3")}>
                      <td className="border-b border-line px-1 py-1.5 text-center">
                        <button type="button" onClick={() => setExpanded(open ? null : it.id)} className="rounded p-0.5 text-ink-3 hover:bg-muted hover:text-ink" aria-label="Adjustment rationale">
                          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </td>
                      <td className="border-b border-line px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Link href={compHref} className={cn("truncate font-medium hover:underline", it.included ? "text-ink" : "text-ink-3 line-through")}>
                            {String(it.comp.label ?? "Comp")}
                          </Link>
                          {it.comp.verification_status && it.comp.verification_status !== "verified" && <StatusBadge status={it.comp.verification_status} />}
                          {it.comp.archived && <Badge tone="red">Archived</Badge>}
                        </div>
                        <p className="truncate text-xs text-ink-3">
                          {[formatDate(it.comp.date ?? null), it.comp.city, it.distance_miles !== null ? `${formatNumber(it.distance_miles, 1)} mi` : null].filter((x) => x && x !== "—").join(" · ")}
                        </p>
                        {!it.included && it.exclusion_reason && <p className="text-xs text-caution">Excluded: {it.exclusion_reason}</p>}
                      </td>
                      <td className="border-b border-line px-2 py-1.5 text-right tabular">{formatMetric(it.base_metric, set.value_basis)}</td>
                      {ADJUSTMENT_FACTORS.map((f) => (
                        <td key={f} className="border-b border-line px-1 py-1">
                          <input
                            inputMode="decimal"
                            disabled={!editable || !it.included}
                            value={d.adjustments[f]}
                            onChange={(e) => setAdj(it.id, f, e.target.value)}
                            placeholder="0"
                            aria-label={`${titleCase(f)} adjustment`}
                            className="h-7 w-full rounded border border-transparent bg-transparent px-1.5 text-right text-sm tabular text-ink placeholder:text-ink-3 hover:border-line focus:border-accent/60 focus:bg-surface focus:outline-none disabled:hover:border-transparent"
                          />
                        </td>
                      ))}
                      <td className={cn("border-b border-line px-2 py-1.5 text-right font-medium tabular", net > 0 ? "text-positive" : net < 0 ? "text-negative" : "text-ink-3")}>
                        {net > 0 ? "+" : ""}
                        {formatNumber(net, 1)}%
                      </td>
                      <td className="border-b border-line px-2 py-1.5 text-right font-medium tabular">{formatMetric(adjusted, set.value_basis)}</td>
                      <td className="border-b border-line px-2 py-1.5 text-right tabular">{formatMetric(toValue(adjusted), "price")}</td>
                      <td className="border-b border-line px-1 py-1">
                        <input
                          inputMode="decimal"
                          disabled={!editable || !it.included}
                          value={d.weight}
                          onChange={(e) => setWeight(it.id, e.target.value)}
                          aria-label="Weight"
                          className="h-7 w-full rounded border border-transparent bg-transparent px-1.5 text-right text-sm tabular hover:border-line focus:border-accent/60 focus:bg-surface focus:outline-none"
                        />
                      </td>
                      <td className="whitespace-nowrap border-b border-line px-2 py-1.5 text-right">
                        <div className="flex justify-end gap-0.5">
                          <Tooltip content="Include / exclude history">
                            <Button size="icon-sm" variant="ghost" onClick={() => setHistory(it)} aria-label="History">
                              <History />
                            </Button>
                          </Tooltip>
                          {editable &&
                            (it.included ? (
                              <Tooltip content="Exclude with reason">
                                <Button size="icon-sm" variant="ghost" onClick={() => { setExcluding(it); setReason(""); }} aria-label="Exclude">
                                  <XCircle />
                                </Button>
                              </Tooltip>
                            ) : (
                              <Tooltip content="Include again">
                                <Button size="icon-sm" variant="ghost" onClick={() => include(it)} aria-label="Include">
                                  <RotateCcw />
                                </Button>
                              </Tooltip>
                            ))}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-subtle/40">
                        <td />
                        <td colSpan={ADJUSTMENT_FACTORS.length + 7} className="border-b border-line px-2 py-3">
                          <p className="mb-2 text-xs font-medium text-ink-2">Adjustment rationale</p>
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                            {ADJUSTMENT_FACTORS.map((f) => (
                              <label key={f} className="block">
                                <span className="text-2xs text-ink-3">{titleCase(f)}</span>
                                <input
                                  disabled={!editable}
                                  value={d.notes[f]}
                                  onChange={(e) => setNote(it.id, f, e.target.value)}
                                  placeholder="Why this adjustment"
                                  className="h-7 w-full rounded border border-line bg-surface px-2 text-xs focus:border-accent/60 focus:outline-none disabled:bg-subtle"
                                />
                              </label>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {set.items.length === 0 && <p className="px-4 py-10 text-center text-sm text-ink-3">No comps in this set yet. Use Find candidates to add some.</p>}
        </div>
      </div>
      {editable && set.items.length > 0 && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="text-xs text-caution">Unsaved adjustments</span>}
          <Button disabled={!dirty} onClick={() => setDraft(toDraft(set.items))}>
            Discard
          </Button>
          <Button variant="primary" disabled={!dirty} loading={saveGrid.isPending} onClick={save}>
            <Save /> Save grid
          </Button>
        </div>
      )}

      <Dialog
        open={!!excluding}
        onOpenChange={(o) => !o && setExcluding(null)}
        title="Exclude comp"
        description="Excluded comps stay in the set with their reason so the selection is defensible."
        footer={
          <>
            <Button onClick={() => setExcluding(null)}>Cancel</Button>
            <Button variant="primary" disabled={reason.trim().length < 3} loading={updateItem.isPending} onClick={exclude}>
              Exclude
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sale-leaseback with non-market rent" />
        </Field>
      </Dialog>

      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)} title="Selection history" description={String(history?.comp.label ?? "")}>
        <ul className="space-y-2">
          {(history?.decision_history ?? []).slice().reverse().map((h, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <StatusBadge status={h.included ? "active" : "rejected"} label={h.included ? "Included" : "Excluded"} />
              <div className="min-w-0">
                <p className="text-ink">{h.reason || "—"}</p>
                <p className="text-xs text-ink-3">
                  {h.by_name ?? "Unknown"} · {formatDateTime(h.at)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
