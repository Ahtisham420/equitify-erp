"use client";

import { ArrowLeft, Link2, Printer, RefreshCw, Send, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber, titleCase, toNumber } from "@/lib/utils";

import { ADJUSTMENT_FACTORS, BASIS_LABELS, VALUATION_METHOD_LABELS, formatMetric, useBov, useRegenerateBov, useUpdateBov, type Bov } from "@/features/comps/api";
import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  body * { visibility: hidden !important; }
  #bov-print, #bov-print * { visibility: visible !important; }
  #bov-print { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0 !important; box-shadow: none !important; padding: 0 !important; }
  #bov-print table { page-break-inside: auto; }
  #bov-print tr { page-break-inside: avoid; }
  .bov-no-print { display: none !important; }
}
`;

function EditBovDialog({ bov, open, onOpenChange }: { bov: Bov; open: boolean; onOpenChange: (o: boolean) => void }) {
  const update = useUpdateBov(bov.id);
  const [s, setS] = useState({ title: bov.title, prepared_for: bov.prepared_for ?? "", price: String(bov.recommended_list_price ?? ""), narrative: bov.narrative ?? "", document_id: bov.document_id ?? "" });
  useEffect(() => {
    if (open) setS({ title: bov.title, prepared_for: bov.prepared_for ?? "", price: String(bov.recommended_list_price ?? ""), narrative: bov.narrative ?? "", document_id: bov.document_id ?? "" });
  }, [open, bov]);
  const draft = bov.status === "draft";
  const save = () =>
    update.mutate(
      draft
        ? { title: s.title.trim(), prepared_for: s.prepared_for || null, recommended_list_price: toNumber(s.price), narrative: s.narrative || null, document_id: s.document_id.trim() || null }
        : { document_id: s.document_id.trim() || null },
      { onSuccess: () => { toast.success("BOV updated"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={draft ? "Edit BOV" : "Link delivered document"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {draft && (
          <>
            <Field label="Title">
              <Input value={s.title} onChange={(e) => setS((x) => ({ ...x, title: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Prepared for">
                <Input value={s.prepared_for} onChange={(e) => setS((x) => ({ ...x, prepared_for: e.target.value }))} />
              </Field>
              <Field label="Recommended list price">
                <Input inputMode="decimal" value={s.price} onChange={(e) => setS((x) => ({ ...x, price: e.target.value }))} />
              </Field>
            </div>
            <Field label="Narrative">
              <Textarea rows={5} value={s.narrative} onChange={(e) => setS((x) => ({ ...x, narrative: e.target.value }))} />
            </Field>
          </>
        )}
        <Field label="BOV document id" hint="The delivered PDF stored in Documents; it is linked to the property&apos;s valuation documents.">
          <Input value={s.document_id} onChange={(e) => setS((x) => ({ ...x, document_id: e.target.value }))} placeholder="UUID" />
        </Field>
      </div>
    </Dialog>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wider text-ink-3">{label}</p>
      <p className={strong ? "text-lg font-semibold text-ink tabular" : "text-sm font-medium text-ink tabular"}>{value}</p>
    </div>
  );
}

export default function BovPrintPage({ params }: { params: { id: string } }) {
  const { can } = useAuth();
  const { data: bov, isLoading, error } = useBov(params.id);
  const regenerate = useRegenerateBov(params.id);
  const update = useUpdateBov(params.id);
  const [editing, setEditing] = useState(false);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error || !bov) return <EmptyState title="BOV not found" description={errorMessage(error)} action={<Link href="/comps?tab=valuations"><Button>Back</Button></Link>} />;

  const p = bov.payload;
  const subject = (p.subject ?? {}) as Record<string, unknown>;
  const basis = p.comp_set?.value_basis ?? "price_psf";
  const factors = p.adjustment_factors?.length ? p.adjustment_factors : [...ADJUSTMENT_FACTORS];
  const ind = p.indicated;
  const isLease = p.comp_set?.kind === "lease";
  const setStatus = (status: "final" | "delivered") =>
    update.mutate({ status }, { onSuccess: () => toast.success(status === "final" ? "BOV finalized" : "Marked delivered"), onError: (e) => toast.error(errorMessage(e)) });

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="bov-no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link href={`/comps/sets/${bov.comp_set_id}?tab=bovs`} className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
            <ArrowLeft className="size-4" /> Comp set
          </Link>
          <StatusBadge status={bov.status === "draft" ? "draft" : "completed"} label={titleCase(bov.status)} />
          {bov.document_id && <span className="text-xs text-ink-3">Document linked</span>}
        </div>
        <div className="flex items-center gap-2">
          {can("comps", "edit") && bov.status === "draft" && (
            <Button loading={regenerate.isPending} onClick={() => regenerate.mutate(undefined, { onSuccess: () => toast.success("Regenerated from the current comp set"), onError: (e) => toast.error(errorMessage(e)) })}>
              <RefreshCw /> Regenerate
            </Button>
          )}
          {can("comps", "edit") && (
            <Button onClick={() => setEditing(true)}>
              <Link2 /> {bov.status === "draft" ? "Edit" : "Link document"}
            </Button>
          )}
          {can("comps", "edit") && bov.status === "draft" && (
            <Button onClick={() => setStatus("final")} loading={update.isPending}>
              <CheckCircle2 /> Finalize
            </Button>
          )}
          {can("comps", "edit") && bov.status === "final" && (
            <Button onClick={() => setStatus("delivered")} loading={update.isPending}>
              <Send /> Mark delivered
            </Button>
          )}
          <Button variant="primary" onClick={() => window.print()}>
            <Printer /> Print
          </Button>
        </div>
      </div>

      <article id="bov-print" className="mx-auto max-w-[900px] rounded-lg border border-line bg-surface p-10 text-ink shadow-card">
        <header className="border-b border-line pb-5">
          <p className="text-2xs uppercase tracking-wider text-ink-3">Broker opinion of value</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{bov.title}</h1>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-2">
            {bov.prepared_for && <span>Prepared for {bov.prepared_for}</span>}
            {p.prepared_by && <span>Prepared by {p.prepared_by}</span>}
            <span>{formatDate(bov.generated_at)}</span>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-6 border-b border-line py-5">
          <div>
            <h2 className="mb-2 text-sm font-semibold">Subject property</h2>
            <p className="text-sm font-medium">{String(subject.name || subject.address_line || bov.property_label || "—")}</p>
            <p className="text-sm text-ink-2">{[subject.address_line, subject.city, subject.state].filter(Boolean).join(", ")}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div><dt className="text-ink-3">Type</dt><dd>{subject.property_type ? PROPERTY_TYPE_LABELS[String(subject.property_type)] ?? titleCase(String(subject.property_type)) : "—"}</dd></div>
              <div><dt className="text-ink-3">Building SF</dt><dd className="tabular">{formatNumber(subject.building_area_sf as number | null)}</dd></div>
              <div><dt className="text-ink-3">Land acres</dt><dd className="tabular">{formatNumber(subject.land_area_acres as number | null, 2)}</dd></div>
              <div><dt className="text-ink-3">Year built</dt><dd className="tabular">{subject.year_built ? String(subject.year_built) : "—"}</dd></div>
              <div><dt className="text-ink-3">NOI</dt><dd className="tabular">{formatCurrency(subject.noi as number | null)}</dd></div>
              <div><dt className="text-ink-3">Occupancy</dt><dd className="tabular">{subject.occupancy_pct != null ? `${formatNumber(subject.occupancy_pct as number, 0)}%` : "—"}</dd></div>
            </dl>
          </div>
          <div className="rounded-md border border-line bg-subtle/60 p-4">
            <h2 className="mb-3 text-sm font-semibold">Opinion of value</h2>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Low" value={formatCurrency(bov.value_low)} />
              <Stat label="Point" value={formatCurrency(bov.value_point)} strong />
              <Stat label="High" value={formatCurrency(bov.value_high)} />
            </div>
            {bov.recommended_list_price != null && (
              <div className="mt-3 border-t border-line pt-3">
                <Stat label="Recommended list price" value={formatCurrency(bov.recommended_list_price)} strong />
              </div>
            )}
            <p className="mt-3 text-xs text-ink-3">
              {BASIS_LABELS[basis]} {formatMetric(ind?.metric_low, basis)} – {formatMetric(ind?.metric_high, basis)} (weighted {formatMetric(ind?.metric_point, basis)}) from {ind?.count ?? 0} adjusted comps
              {p.comp_set?.subject_quantity != null ? ` applied to ${formatNumber(p.comp_set.subject_quantity, 2)}${p.comp_set.subject_quantity_source ? ` (${p.comp_set.subject_quantity_source})` : ""}` : ""}.
            </p>
            {p.valuation && (
              <p className="mt-1 text-xs text-ink-3">
                Supporting {VALUATION_METHOD_LABELS[p.valuation.method] ?? p.valuation.method} valuation as of {formatDate(p.valuation.as_of)}: {formatCurrency(p.valuation.value_point)}.
              </p>
            )}
          </div>
        </section>

        <section className="border-b border-line py-5">
          <h2 className="mb-3 text-sm font-semibold">{isLease ? "Lease comparables" : "Sale comparables"} and adjustments</h2>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th className="py-1.5 pr-2 font-medium">Comparable</th>
                <th className="py-1.5 pr-2 font-medium">{isLease ? "Commenced" : "Sold"}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{isLease ? "Rent" : "Price"}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{BASIS_LABELS[basis]}</th>
                {factors.map((f) => (
                  <th key={f} className="py-1.5 pr-2 text-right font-medium">{titleCase(f)}</th>
                ))}
                <th className="py-1.5 pr-2 text-right font-medium">Net</th>
                <th className="py-1.5 text-right font-medium">Adjusted</th>
              </tr>
            </thead>
            <tbody>
              {(p.comps ?? []).map((c) => (
                <tr key={c.id} className="border-b border-line/70 align-top">
                  <td className="py-1.5 pr-2">
                    <p className="font-medium text-ink">{String(c.comp.label ?? "Comp")}</p>
                    <p className="text-ink-3">{[c.comp.city, c.comp.tenant_name as string | null, c.distance_miles != null ? `${formatNumber(c.distance_miles, 1)} mi` : null].filter(Boolean).join(" · ")}</p>
                    <p className="text-ink-3">{c.comp.verification_status === "verified" ? `Verified${c.comp.verification_method ? ` (${titleCase(String(c.comp.verification_method))})` : ""}` : titleCase(c.comp.verification_status ?? "unverified")}</p>
                  </td>
                  <td className="py-1.5 pr-2 tabular">{formatDate(c.comp.date ?? null)}</td>
                  <td className="py-1.5 pr-2 text-right tabular">{isLease ? (c.comp.base_rent_psf != null ? `$${formatNumber(c.comp.base_rent_psf as number, 2)}` : "—") : formatCurrency(c.comp.sale_price as number | null, { compact: true })}</td>
                  <td className="py-1.5 pr-2 text-right tabular">{formatMetric(c.base_metric, basis)}</td>
                  {factors.map((f) => (
                    <td key={f} className="py-1.5 pr-2 text-right tabular" title={c.adjustment_notes?.[f] ?? undefined}>
                      {c.adjustments?.[f] ? `${c.adjustments[f] > 0 ? "+" : ""}${formatNumber(c.adjustments[f], 1)}%` : "—"}
                    </td>
                  ))}
                  <td className="py-1.5 pr-2 text-right tabular">{c.net_adjustment_pct ? `${c.net_adjustment_pct > 0 ? "+" : ""}${formatNumber(c.net_adjustment_pct, 1)}%` : "0%"}</td>
                  <td className="py-1.5 text-right font-medium tabular">{formatMetric(c.adjusted_metric, basis)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(p.comps ?? []).some((c) => Object.values(c.adjustment_notes ?? {}).some(Boolean)) && (
            <div className="mt-3 space-y-1 text-xs text-ink-2">
              <p className="font-medium text-ink">Adjustment rationale</p>
              {(p.comps ?? []).map((c) =>
                Object.entries(c.adjustment_notes ?? {})
                  .filter(([, note]) => note)
                  .map(([f, note]) => (
                    <p key={`${c.id}-${f}`}>
                      <span className="text-ink-3">{String(c.comp.label ?? "Comp")} · {titleCase(f)}:</span> {note}
                    </p>
                  )),
              )}
            </div>
          )}
          {(p.excluded ?? []).length > 0 && (
            <div className="mt-4 text-xs">
              <p className="font-medium text-ink">Considered and excluded</p>
              <ul className="mt-1 space-y-0.5 text-ink-2">
                {(p.excluded ?? []).map((e) => (
                  <li key={e.id}>
                    {e.label ?? "Comp"} — {e.reason ?? "No reason recorded"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {bov.narrative && (
          <section className="border-b border-line py-5">
            <h2 className="mb-2 text-sm font-semibold">Market commentary</h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{bov.narrative}</p>
          </section>
        )}

        <footer className="pt-5 text-2xs leading-relaxed text-ink-3">
          This broker opinion of value is not an appraisal. It is based on {p.comps?.length ?? 0} comparable transactions
          {p.evidence?.document_ids?.length ? ` and ${p.evidence.document_ids.length} supporting documents` : ""} selected and adjusted as shown. Generated {formatDate(p.generated_at)}.
        </footer>
      </article>

      <EditBovDialog bov={bov} open={editing} onOpenChange={setEditing} />
    </>
  );
}
