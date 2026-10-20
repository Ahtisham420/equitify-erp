"use client";

import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PropertyPicker } from "@/components/data/entity-picker";
import { FacetFilter } from "@/components/data/filters";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Checkbox, Spinner } from "@/components/ui/misc";
import type { Params } from "@/lib/api";
import { formatCurrency, formatDate, formatNumber, formatPercent, toNumber } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/features/properties/api";

import { TENANT_CREDIT, TENANT_CREDIT_LABELS, useCandidates, type Candidate, type CompKind } from "./api";

export interface CandidateCriteria {
  kind: CompKind;
  subject_property_id: string | null;
  radius_miles: string;
  property_type: string[];
  county: string;
  corridor: string;
  tenant_credit: string[];
  min_term_years: string;
  max_term_years: string;
  date_from: string;
  date_to: string;
  verified_only: boolean;
}

const yearsAgo = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};

/**
 * Automated comp candidates by type, geography (radius / county / corridor), tenant credit, lease term and date
 * window. With `compSetId` the search runs against that set (its subject and kind; comps already in it are hidden).
 */
export function CandidateSearchDialog({
  open,
  onOpenChange,
  compSetId,
  kind: fixedKind,
  subjectPropertyId,
  confirmLabel = "Add selected",
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  compSetId?: string;
  kind?: CompKind;
  subjectPropertyId?: string | null;
  confirmLabel?: string;
  loading?: boolean;
  onConfirm: (ids: string[], criteria: CandidateCriteria) => void;
}) {
  const initial = (): CandidateCriteria => ({
    kind: fixedKind ?? "sale",
    subject_property_id: subjectPropertyId ?? null,
    radius_miles: "5",
    property_type: [],
    county: "",
    corridor: "",
    tenant_credit: [],
    min_term_years: "",
    max_term_years: "",
    date_from: yearsAgo(3),
    date_to: "",
    verified_only: false,
  });
  const [draft, setDraft] = useState<CandidateCriteria>(initial);
  const [applied, setApplied] = useState<CandidateCriteria>(initial);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      const c = initial();
      setDraft(c);
      setApplied(c);
      setSelected([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fixedKind, subjectPropertyId]);

  const params: Params = useMemo(
    () => ({
      kind: applied.kind,
      subject_property_id: compSetId ? undefined : applied.subject_property_id,
      radius_miles: toNumber(applied.radius_miles) ?? undefined,
      property_type: applied.property_type,
      county: applied.county || undefined,
      corridor: applied.corridor || undefined,
      tenant_credit: applied.tenant_credit,
      min_term_years: toNumber(applied.min_term_years) ?? undefined,
      max_term_years: toNumber(applied.max_term_years) ?? undefined,
      date_from: applied.date_from || undefined,
      date_to: applied.date_to || undefined,
      verified_only: applied.verified_only || undefined,
      limit: 100,
    }),
    [applied, compSetId],
  );
  const path = compSetId ? `/comp-sets/${compSetId}/candidates` : "/comps/candidates";
  const { data, isFetching } = useCandidates(path, params, open && (!!compSetId || !!applied.subject_property_id || !applied.radius_miles));
  const rows = data ?? [];
  const set = <K extends keyof CandidateCriteria>(k: K, v: CandidateCriteria[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggle = (id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Find comp candidates"
      description="Candidates are ranked by distance from the subject, then by date."
      className="max-w-5xl"
      footer={
        <>
          <span className="mr-auto self-center text-xs text-ink-3 tabular">{formatNumber(selected.length)} selected</span>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!selected.length} loading={loading} onClick={() => onConfirm(selected, applied)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {!fixedKind && (
            <Field label="Comp type">
              <Select value={draft.kind} onChange={(e) => set("kind", e.target.value as CompKind)} options={[{ value: "sale", label: "Sale comps" }, { value: "lease", label: "Lease comps" }]} />
            </Field>
          )}
          {!compSetId && (
            <Field label="Subject property" className="col-span-2">
              <PropertyPicker value={draft.subject_property_id} onChange={(id) => set("subject_property_id", id)} />
            </Field>
          )}
          <Field label="Radius (miles)">
            <Input inputMode="decimal" value={draft.radius_miles} onChange={(e) => set("radius_miles", e.target.value)} placeholder="Any" />
          </Field>
          <Field label="County">
            <Input value={draft.county} onChange={(e) => set("county", e.target.value)} />
          </Field>
          <Field label="Corridor">
            <Input value={draft.corridor} onChange={(e) => set("corridor", e.target.value)} />
          </Field>
          <Field label="Lease term (yrs)">
            <div className="flex items-center gap-1.5">
              <Input inputMode="decimal" placeholder="Min" value={draft.min_term_years} onChange={(e) => set("min_term_years", e.target.value)} />
              <Input inputMode="decimal" placeholder="Max" value={draft.max_term_years} onChange={(e) => set("max_term_years", e.target.value)} />
            </div>
          </Field>
          <Field label="Date window">
            <div className="flex items-center gap-1.5">
              <Input type="date" value={draft.date_from} onChange={(e) => set("date_from", e.target.value)} />
              <Input type="date" value={draft.date_to} onChange={(e) => set("date_to", e.target.value)} />
            </div>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FacetFilter label="Type" options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }))} selected={draft.property_type} onChange={(v) => set("property_type", v)} />
          <FacetFilter label="Tenant credit" options={TENANT_CREDIT.map((t) => ({ value: t, label: TENANT_CREDIT_LABELS[t] }))} selected={draft.tenant_credit} onChange={(v) => set("tenant_credit", v)} />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={draft.verified_only} onChange={(v) => set("verified_only", v)} />
            Verified only
          </label>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => setApplied(draft)}>
            <Search /> Search
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-line">
          <div className="max-h-[42vh] overflow-auto scrollbar-thin">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-3">
                  <th className="sticky top-0 w-9 border-b border-line bg-subtle px-3 py-2">
                    <Checkbox
                      checked={rows.length > 0 && rows.every((r) => selected.includes(r.id))}
                      onChange={(on) => setSelected(on ? rows.map((r) => r.id) : [])}
                      label="Select all"
                    />
                  </th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 font-medium">Comp</th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 font-medium">Date</th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 text-right font-medium">{applied.kind === "sale" ? "Price" : "Rent / SF"}</th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 text-right font-medium">{applied.kind === "sale" ? "Cap" : "Area SF"}</th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 text-right font-medium">Term</th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 font-medium">Credit</th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 text-right font-medium">Miles</th>
                  <th className="sticky top-0 border-b border-line bg-subtle px-3 py-2 font-medium">Verification</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c: Candidate) => (
                  <tr key={c.id} className="hover:bg-subtle/70" onClick={() => toggle(c.id, !selected.includes(c.id))}>
                    <td className="border-b border-line px-3 py-1.5">
                      <Checkbox checked={selected.includes(c.id)} onChange={(on) => toggle(c.id, on)} label="Select comp" />
                    </td>
                    <td className="border-b border-line px-3 py-1.5">
                      <p className="truncate font-medium text-ink">{c.label}</p>
                      <p className="truncate text-xs text-ink-3">{[c.tenant_name, c.city, c.state].filter(Boolean).join(" · ") || "—"}</p>
                    </td>
                    <td className="whitespace-nowrap border-b border-line px-3 py-1.5 text-ink-2">{formatDate(c.date)}</td>
                    <td className="border-b border-line px-3 py-1.5 text-right tabular">{c.kind === "sale" ? formatCurrency(c.price, { compact: true }) : c.rent_psf !== null ? `$${c.rent_psf.toFixed(2)}` : "—"}</td>
                    <td className="border-b border-line px-3 py-1.5 text-right tabular">{c.kind === "sale" ? formatPercent(c.cap_rate, 2) : formatNumber(c.area_sf)}</td>
                    <td className="border-b border-line px-3 py-1.5 text-right tabular">{c.term_years !== null ? `${formatNumber(c.term_years, 1)} yrs` : "—"}</td>
                    <td className="border-b border-line px-3 py-1.5 text-ink-2">{c.tenant_credit ? TENANT_CREDIT_LABELS[c.tenant_credit] : "—"}</td>
                    <td className="border-b border-line px-3 py-1.5 text-right tabular">{formatNumber(c.distance_miles, 1)}</td>
                    <td className="border-b border-line px-3 py-1.5">
                      <StatusBadge status={c.verification_status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isFetching && !rows.length && (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            )}
            {!isFetching && rows.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-ink-3">
                {!compSetId && !applied.subject_property_id && applied.radius_miles ? "Choose a subject property to search by radius, or clear the radius." : "No candidates match these criteria."}
              </p>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
