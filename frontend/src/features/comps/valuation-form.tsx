"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { toNumber } from "@/lib/utils";

import { VALUATION_METHOD_LABELS, VALUATION_METHODS, useCreateValuation, usePreviewValuation, type CompSetListItem, type SourcedValue, type ValuationInput } from "./api";
import { ValueRange } from "./value-range";

const FIELDS: Record<string, { key: string; label: string; material?: boolean }[]> = {
  direct_cap: [
    { key: "noi", label: "Stabilized NOI ($)", material: true },
    { key: "cap_rate", label: "Cap rate (%)", material: true },
    { key: "cap_rate_low", label: "Cap rate low (%)" },
    { key: "cap_rate_high", label: "Cap rate high (%)" },
  ],
  dcf: [
    { key: "discount_rate", label: "Discount rate (%)", material: true },
    { key: "discount_rate_low", label: "Discount rate low (%)" },
    { key: "discount_rate_high", label: "Discount rate high (%)" },
    { key: "noi_year1", label: "Year 1 NOI ($)", material: true },
    { key: "growth_pct", label: "NOI growth (%/yr)", material: true },
    { key: "hold_years", label: "Hold (years)" },
    { key: "exit_cap", label: "Exit cap (%)", material: true },
    { key: "selling_cost_pct", label: "Selling costs (%)" },
  ],
  land_residual: [
    { key: "gross_development_value", label: "Gross development value ($)", material: true },
    { key: "development_costs", label: "Hard / site costs ($)", material: true },
    { key: "soft_costs", label: "Soft costs ($)", material: true },
    { key: "carry_costs", label: "Carry costs ($)" },
    { key: "developer_profit_pct", label: "Developer profit (% of GDV)", material: true },
    { key: "gdv_low", label: "GDV low ($)" },
    { key: "gdv_high", label: "GDV high ($)" },
  ],
};

interface Row {
  value: string;
  source: string;
  comp_ids: string;
  document_id: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Record a dated valuation or portfolio mark. Material inputs carry their evidence (source, comps, document). */
export function ValuationFormSheet({
  open,
  onOpenChange,
  propertyId,
  defaultMark = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  propertyId?: string | null;
  defaultMark?: boolean;
}) {
  const [property, setProperty] = useState<string | null>(propertyId ?? null);
  const [method, setMethod] = useState("direct_cap");
  const [asOf, setAsOf] = useState(today());
  const [isMark, setIsMark] = useState(defaultMark);
  const [compSet, setCompSet] = useState<string | null>(null);
  const [uwModel, setUwModel] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [manual, setManual] = useState({ low: "", high: "", point: "", document_id: "", third_party: "" });
  const [notes, setNotes] = useState("");
  const create = useCreateValuation();
  const preview = usePreviewValuation();

  useEffect(() => {
    if (open) {
      setProperty(propertyId ?? null);
      setMethod("direct_cap");
      setAsOf(today());
      setIsMark(defaultMark);
      setCompSet(null);
      setUwModel(null);
      setRows({});
      setManual({ low: "", high: "", point: "", document_id: "", third_party: "" });
      setNotes("");
      preview.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, propertyId, defaultMark]);

  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((r) => {
      const current: Row = (r[key] as Row | undefined) ?? { value: "", source: "", comp_ids: "", document_id: "" };
      return { ...r, [key]: { ...current, ...patch } };
    });

  const payload = (): ValuationInput | null => {
    if (!property) return null;
    const assumptions: Record<string, SourcedValue> = {};
    for (const f of FIELDS[method] ?? []) {
      const r = rows[f.key];
      if (!r) continue;
      const v = toNumber(r.value);
      if (v === null) continue;
      assumptions[f.key] = {
        value: v,
        source: r.source.trim() || null,
        comp_ids: r.comp_ids.split(",").map((s) => s.trim()).filter(Boolean),
        document_id: r.document_id.trim() || null,
      };
    }
    return {
      property_id: property,
      method,
      as_of: asOf,
      is_mark: isMark,
      comp_set_id: method === "sales_comparison" ? compSet : null,
      uw_model_id: method === "dcf" ? uwModel : null,
      assumptions,
      value_low: toNumber(manual.low),
      value_high: toNumber(manual.high),
      value_point: toNumber(manual.point),
      document_id: manual.document_id.trim() || null,
      third_party: manual.third_party.trim() || null,
      notes: notes.trim() || null,
    };
  };

  const runPreview = () => {
    const body = payload();
    if (body) preview.mutate(body, { onError: (e) => toast.error(errorMessage(e)) });
  };

  const save = () => {
    const body = payload();
    if (!body) return;
    create.mutate(body, {
      onSuccess: () => {
        toast.success(isMark ? "Portfolio mark recorded" : "Valuation saved");
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const manualMethod = method === "appraisal" || method === "bov";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={isMark ? "New portfolio mark" : "New valuation"}
      description="Valuations are dated and never overwritten; a new conclusion is a new record."
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={runPreview} loading={preview.isPending} disabled={!property}>
            Preview
          </Button>
          <Button variant="primary" onClick={save} loading={create.isPending} disabled={!property || !asOf}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Property" required className="col-span-2">
            <PropertyPicker value={property} onChange={(id) => setProperty(id)} />
          </Field>
          <Field label="Method" required>
            <Select value={method} onChange={(e) => { setMethod(e.target.value); preview.reset(); }} options={VALUATION_METHODS.map((m) => ({ value: m, label: VALUATION_METHOD_LABELS[m] }))} />
          </Field>
          <Field label="As of" required>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={isMark} onChange={setIsMark} />
            Record as portfolio value mark
            <span className="text-xs text-ink-3">(requires evidence for every material assumption)</span>
          </label>
        </div>

        {method === "sales_comparison" && (
          <Field label="Sale comp set" required hint="The indicated range of this comp set and its included comps become the evidence.">
            <EntityPicker<CompSetListItem>
              endpoint="/comp-sets"
              value={compSet}
              onChange={(id) => setCompSet(id)}
              placeholder="Select comp set"
              toOption={(s) => ({ id: s.id, label: s.name, sublabel: [s.subject_label, s.kind === "sale" ? "Sale" : "Lease", `${s.included_count} included`].filter(Boolean).join(" · ") })}
            />
          </Field>
        )}

        {method === "dcf" && (
          <Field label="Underwriting model (optional)" hint="When chosen, its unlevered cash flows are discounted; otherwise the simple inputs below are used.">
            <EntityPicker<{ id: string; name: string; version: number; status: string; property_label: string | null }>
              endpoint="/uw-models"
              value={uwModel}
              onChange={(id) => setUwModel(id)}
              placeholder="Select model"
              toOption={(m) => ({ id: m.id, label: `${m.name} · v${m.version}`, sublabel: [m.property_label, m.status].filter(Boolean).join(" · ") })}
            />
          </Field>
        )}

        {FIELDS[method] && (
          <div className="space-y-2">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Assumptions and evidence</p>
            <div className="grid grid-cols-[1.3fr_0.9fr_1.2fr_1fr_1fr] gap-2 text-2xs font-medium text-ink-3">
              <span>Input</span>
              <span>Value</span>
              <span>Source</span>
              <span>Comp ids</span>
              <span>Document id</span>
            </div>
            {FIELDS[method]
              .filter((f) => !(method === "dcf" && uwModel && !["discount_rate", "discount_rate_low", "discount_rate_high"].includes(f.key)))
              .map((f) => {
                const r = rows[f.key] ?? { value: "", source: "", comp_ids: "", document_id: "" };
                const flagged = f.material && r.value.trim() && !r.source.trim() && !r.comp_ids.trim() && !r.document_id.trim();
                return (
                  <div key={f.key} className="grid grid-cols-[1.3fr_0.9fr_1.2fr_1fr_1fr] items-center gap-2">
                    <span className="flex items-center gap-1 text-sm text-ink-2">
                      {f.label}
                      {flagged && <AlertTriangle className="size-3.5 text-caution" aria-label="Unsourced" />}
                    </span>
                    <Input inputMode="decimal" value={r.value} onChange={(e) => setRow(f.key, { value: e.target.value })} />
                    <Input value={r.source} onChange={(e) => setRow(f.key, { source: e.target.value })} placeholder={f.material ? "Required for marks" : ""} />
                    <Input value={r.comp_ids} onChange={(e) => setRow(f.key, { comp_ids: e.target.value })} placeholder="id, id" />
                    <Input value={r.document_id} onChange={(e) => setRow(f.key, { document_id: e.target.value })} />
                  </div>
                );
              })}
          </div>
        )}

        {manualMethod && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Value low">
              <Input inputMode="decimal" value={manual.low} onChange={(e) => setManual((m) => ({ ...m, low: e.target.value }))} />
            </Field>
            <Field label="Value conclusion" required>
              <Input inputMode="decimal" value={manual.point} onChange={(e) => setManual((m) => ({ ...m, point: e.target.value }))} />
            </Field>
            <Field label="Value high">
              <Input inputMode="decimal" value={manual.high} onChange={(e) => setManual((m) => ({ ...m, high: e.target.value }))} />
            </Field>
            <Field label={method === "appraisal" ? "Appraiser" : "Broker"} className="col-span-1">
              <Input value={manual.third_party} onChange={(e) => setManual((m) => ({ ...m, third_party: e.target.value }))} />
            </Field>
            <Field label="Document id" required={method === "appraisal"} className="col-span-2" hint="The appraisal or BOV document from Documents.">
              <Input value={manual.document_id} onChange={(e) => setManual((m) => ({ ...m, document_id: e.target.value }))} placeholder="UUID" />
            </Field>
          </div>
        )}

        <Field label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {preview.data && (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <p className="text-xs font-medium text-ink-2">Preview</p>
            <ValueRange low={preview.data.value_low} high={preview.data.value_high} point={preview.data.value_point} />
            {preview.data.unsourced.length > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-caution">
                <AlertTriangle className="size-3.5" />
                Unsourced: {preview.data.unsourced.join(", ")}
              </p>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
