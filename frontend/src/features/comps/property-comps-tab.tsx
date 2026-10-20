"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, Layers, Link2, Plus, Scale } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatPercent, titleCase, toNumber } from "@/lib/utils";

import {
  BASIS_LABELS,
  VALUATION_METHOD_LABELS,
  formatMetric,
  useBovs,
  useCreateCompSet,
  useLinkValuationDocument,
  useValuationDocuments,
  type CompSetListItem,
  type SaleComp,
  type Valuation,
} from "./api";
import { ValuationFormSheet } from "./valuation-form";
import { ValueRange } from "./value-range";

const valuationColumns: Column<Valuation>[] = [
  { id: "asof", header: "As of", cell: (v) => <span className="whitespace-nowrap">{formatDate(v.as_of)}</span> },
  {
    id: "method",
    header: "Method",
    cell: (v) => (
      <div className="flex items-center gap-1.5">
        <span className="text-ink-2">{VALUATION_METHOD_LABELS[v.method] ?? titleCase(v.method)}</span>
        {v.is_mark && <Badge tone="blue">Mark</Badge>}
      </div>
    ),
  },
  { id: "range", header: "Range", align: "right", cell: (v) => <span className="whitespace-nowrap text-ink-2">{formatCurrency(v.value_low, { compact: true })} – {formatCurrency(v.value_high, { compact: true })}</span> },
  { id: "point", header: "Point", align: "right", cell: (v) => <span className="font-medium">{formatCurrency(v.value_point, { compact: true })}</span> },
  { id: "change", header: "Vs prior mark", align: "right", cell: (v) => (v.change_pct !== null ? <span className={cn(v.change_pct >= 0 ? "text-positive" : "text-negative")}>{v.change_pct >= 0 ? "+" : ""}{formatPercent(v.change_pct, 1)}</span> : "—") },
  { id: "analyst", header: "Analyst", cell: (v) => <span className="text-ink-2">{v.analyst_name ?? "—"}</span> },
  {
    id: "evidence",
    header: "Evidence",
    cell: (v) => (
      <span className="text-xs text-ink-3">
        {[v.comp_set_id ? "Comp set" : null, v.uw_model_id ? "UW model" : null, v.document_id ? "Document" : null, v.third_party].filter(Boolean).join(" · ") || "Sourced inputs"}
        {v.unsourced.length > 0 && <span className="ml-1 text-caution">· {v.unsourced.length} unsourced</span>}
      </span>
    ),
  },
];

/** Property detail tab: comp sets for this subject, dated valuation & mark history, appraisal/BOV documents. */
export function PropertyCompsTab({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const { can } = useAuth();
  const [valuing, setValuing] = useState<{ mark: boolean } | null>(null);
  const [newSet, setNewSet] = useState(false);
  const [setForm, setSetForm] = useState({ name: "", kind: "sale" });
  const [linking, setLinking] = useState(false);
  const [doc, setDoc] = useState({ document_id: "", kind: "appraisal", label: "", prepared_by: "", effective_date: "", value: "" });
  const createSet = useCreateCompSet();
  const linkDoc = useLinkValuationDocument();

  const sets = useQuery({
    queryKey: ["comp-sets", "list", { subject_property_id: propertyId }],
    queryFn: () => api.get<Page<CompSetListItem>>("/comp-sets", { subject_property_id: propertyId, page_size: 50 }),
  });
  const valuations = useQuery({
    queryKey: ["valuations", "list", { property_id: propertyId }],
    queryFn: () => api.get<Page<Valuation>>("/valuations", { property_id: propertyId, page_size: 100, sort: "-as_of" }),
  });
  const atProperty = useQuery({
    queryKey: ["comps", "list", "/sale-comps", { property_id: propertyId }],
    queryFn: () => api.get<Page<SaleComp>>("/sale-comps", { property_id: propertyId, page_size: 20 }),
  });
  const docs = useValuationDocuments(propertyId);
  const bovs = useBovs({ property_id: propertyId, page_size: 20 });

  const latest = valuations.data?.items[0];
  const latestMark = valuations.data?.items.find((v) => v.is_mark);

  const submitSet = () =>
    createSet.mutate(
      { name: setForm.name.trim(), kind: setForm.kind, subject_property_id: propertyId, purpose: "valuation" },
      {
        onSuccess: (cs) => {
          toast.success("Comp set created");
          router.push(`/comps/sets/${cs.id}`);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const submitDoc = () =>
    linkDoc.mutate(
      {
        property_id: propertyId,
        document_id: doc.document_id.trim(),
        kind: doc.kind as "appraisal" | "bov" | "other",
        label: doc.label || null,
        prepared_by: doc.prepared_by || null,
        effective_date: doc.effective_date || null,
        value_conclusion: toNumber(doc.value),
        valuation_id: null,
      },
      {
        onSuccess: () => {
          toast.success("Document linked");
          setLinking(false);
          setDoc({ document_id: "", kind: "appraisal", label: "", prepared_by: "", effective_date: "", value: "" });
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="p-4 md:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-ink-3">Latest value {latest ? `· ${VALUATION_METHOD_LABELS[latest.method] ?? latest.method} as of ${formatDate(latest.as_of)}` : ""}</p>
            {can("comps", "create") && (
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => setValuing({ mark: false })}>
                  <Scale /> Valuation
                </Button>
                <Button size="sm" onClick={() => setValuing({ mark: true })}>
                  <Plus /> Portfolio mark
                </Button>
              </div>
            )}
          </div>
          <ValueRange low={latest?.value_low} high={latest?.value_high} point={latest?.value_point} />
        </Card>
        <StatCard
          label="Latest portfolio mark"
          value={latestMark ? formatCurrency(latestMark.value_point, { compact: true }) : "—"}
          hint={latestMark ? `${formatDate(latestMark.as_of)} · ${latestMark.analyst_name ?? "Unknown analyst"}` : "No marks recorded"}
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Comp sets"
          description="Sale and lease comps selected for this property, with adjustments and indicated ranges."
          actions={can("comps", "create") ? <Button size="sm" onClick={() => { setSetForm({ name: "", kind: "sale" }); setNewSet(true); }}><Layers /> New comp set</Button> : undefined}
        />
        {sets.data?.items.length ? (
          <ul className="divide-y divide-line">
            {sets.data.items.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <Link href={`/comps/sets/${s.id}`} className="font-medium text-ink hover:underline">{s.name}</Link>
                  <p className="text-xs text-ink-3">
                    {s.kind === "sale" ? "Sale" : "Lease"} · {BASIS_LABELS[s.value_basis] ?? s.value_basis} · {s.included_count} included
                    {s.excluded_count ? `, ${s.excluded_count} excluded` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-ink-2 tabular">
                    {s.indicated?.value_low != null
                      ? `${formatCurrency(s.indicated.value_low, { compact: true })} – ${formatCurrency(s.indicated.value_high, { compact: true })}`
                      : s.indicated?.metric_low != null
                        ? `${formatMetric(s.indicated.metric_low, s.value_basis)} – ${formatMetric(s.indicated.metric_high, s.value_basis)}`
                        : "—"}
                  </span>
                  <StatusBadge status={s.status === "final" ? "completed" : "draft"} label={titleCase(s.status)} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Layers />} title="No comp sets" description="Build a comp set to support pricing, underwriting and BOVs." />
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Valuation and mark history" description="Dated conclusions are kept as history; a new value never overwrites a prior one." />
        <DataTable
          columns={valuationColumns}
          data={valuations.data?.items}
          loading={valuations.isLoading}
          dense
          rowHref={(v) => (v.comp_set_id ? `/comps/sets/${v.comp_set_id}?tab=valuations` : `/comps?tab=valuations&property_id=${propertyId}`)}
          empty={<EmptyState icon={<Scale />} title="No valuations yet" />}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader
            title="Appraisal and BOV documents"
            actions={can("comps", "edit") ? <Button size="sm" onClick={() => setLinking(true)}><Link2 /> Link document</Button> : undefined}
          />
          {docs.data?.length ? (
            <ul className="divide-y divide-line">
              {docs.data.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{d.label || titleCase(d.kind)}</p>
                    <p className="truncate text-xs text-ink-3">{[titleCase(d.kind), d.prepared_by, formatDate(d.effective_date), d.document_id.slice(0, 8)].filter((x) => x && x !== "—").join(" · ")}</p>
                  </div>
                  <span className="text-xs tabular text-ink-2">{formatCurrency(d.value_conclusion, { compact: true })}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<FileText />} title="No documents linked" description="Link third-party appraisals and BOVs stored in Documents." />
          )}
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Broker opinions of value" />
          {bovs.data?.items.length ? (
            <ul className="divide-y divide-line">
              {bovs.data.items.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <Link href={`/comps/bov/${b.id}`} className="truncate font-medium text-ink hover:underline">{b.title}</Link>
                    <p className="text-xs text-ink-3">{[b.prepared_for, formatDate(b.generated_at)].filter((x) => x && x !== "—").join(" · ")}</p>
                  </div>
                  <StatusBadge status={b.status === "draft" ? "draft" : "completed"} label={titleCase(b.status)} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<FileText />} title="No BOVs" description="Generate one from a comp set." />
          )}
        </Card>
      </div>

      {(atProperty.data?.items.length ?? 0) > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Sales of this property recorded as comps" />
          <ul className="divide-y divide-line">
            {atProperty.data!.items.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="text-ink">{formatDate(c.sale_date)} · {formatCurrency(c.sale_price)}</span>
                <span className="text-xs text-ink-2">{c.cap_rate !== null ? formatPercent(c.cap_rate, 2) : "—"} · <StatusBadge status={c.verification_status} /></span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ValuationFormSheet open={!!valuing} onOpenChange={(o) => !o && setValuing(null)} propertyId={propertyId} defaultMark={valuing?.mark ?? false} />

      <Dialog
        open={newSet}
        onOpenChange={setNewSet}
        title="New comp set"
        footer={
          <>
            <Button onClick={() => setNewSet(false)}>Cancel</Button>
            <Button variant="primary" disabled={!setForm.name.trim()} loading={createSet.isPending} onClick={submitSet}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input autoFocus value={setForm.name} onChange={(e) => setSetForm((s) => ({ ...s, name: e.target.value }))} />
          </Field>
          <Field label="Comp type">
            <Select value={setForm.kind} onChange={(e) => setSetForm((s) => ({ ...s, kind: e.target.value }))} options={[{ value: "sale", label: "Sale comps" }, { value: "lease", label: "Lease comps" }]} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={linking}
        onOpenChange={setLinking}
        title="Link appraisal or BOV document"
        footer={
          <>
            <Button onClick={() => setLinking(false)}>Cancel</Button>
            <Button variant="primary" disabled={!doc.document_id.trim()} loading={linkDoc.isPending} onClick={submitDoc}>Link</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Document id" required className="col-span-2" hint="From Documents">
            <Input value={doc.document_id} onChange={(e) => setDoc((d) => ({ ...d, document_id: e.target.value }))} placeholder="UUID" />
          </Field>
          <Field label="Kind">
            <Select value={doc.kind} onChange={(e) => setDoc((d) => ({ ...d, kind: e.target.value }))} options={[{ value: "appraisal", label: "Appraisal" }, { value: "bov", label: "BOV" }, { value: "other", label: "Other" }]} />
          </Field>
          <Field label="Effective date">
            <Input type="date" value={doc.effective_date} onChange={(e) => setDoc((d) => ({ ...d, effective_date: e.target.value }))} />
          </Field>
          <Field label="Label">
            <Input value={doc.label} onChange={(e) => setDoc((d) => ({ ...d, label: e.target.value }))} />
          </Field>
          <Field label="Prepared by">
            <Input value={doc.prepared_by} onChange={(e) => setDoc((d) => ({ ...d, prepared_by: e.target.value }))} />
          </Field>
          <Field label="Value conclusion" className="col-span-2">
            <Input inputMode="decimal" value={doc.value} onChange={(e) => setDoc((d) => ({ ...d, value: e.target.value }))} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
