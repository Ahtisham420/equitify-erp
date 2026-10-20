"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatCurrency, titleCase, toNumber } from "@/lib/utils";

import {
  AMENDMENT_KINDS,
  CAP_TYPES,
  CLAUSE_CATEGORIES,
  ESCALATION_METHODS,
  GUARANTY_TYPES,
  OPTION_LABELS,
  OPTION_TYPES,
  OVERRIDABLE_FIELDS,
  PRICING_METHODS,
  RECOVERY_CATEGORIES,
  RECOVERY_METHODS,
  useLeaseMutation,
  useSaveLease,
  type Clause,
  type Guaranty,
  type Lease,
  type LeaseOption,
  type Recovery,
} from "./api";

type FormState = Record<string, string>;

function useForm(initial: () => FormState, open: boolean) {
  const [form, setForm] = useState<FormState>(initial);
  useEffect(() => {
    if (open) setForm(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const bind = (key: string) => ({
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  return { form, setForm, bind };
}

function str(v: unknown) {
  return v === null || v === undefined ? "" : String(v);
}

function textOrNull(v: string | undefined) {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

const CITE_KEYS = ["document_id", "page", "clause_ref", "quoted_text"];

function citationPayload(form: FormState) {
  return {
    document_id: textOrNull(form.document_id),
    page: toNumber(form.page ?? ""),
    clause_ref: textOrNull(form.clause_ref),
    quoted_text: textOrNull(form.quoted_text),
  };
}

function CitationFields({ bind }: { bind: (k: string) => { value: string; onChange: (e: { target: { value: string } }) => void } }) {
  return (
    <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
      <div>
        <h4 className="text-sm font-medium">Source citation</h4>
        <p className="text-xs text-ink-3">Where this term appears in the lease document.</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Document ID" className="col-span-3"><Input {...bind("document_id")} /></Field>
        <Field label="Page"><Input inputMode="numeric" {...bind("page")} /></Field>
        <Field label="Clause / section" className="col-span-2"><Input {...bind("clause_ref")} placeholder="e.g. 4.2(b)" /></Field>
        <Field label="Quoted text" className="col-span-3"><Textarea rows={3} {...bind("quoted_text")} /></Field>
      </div>
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function AiFlag({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-2">
      <Checkbox checked={checked} onChange={onChange} />
      Extracted by AI (stays unverified until reviewed)
    </label>
  );
}

function TermSheet({
  open,
  onOpenChange,
  title,
  description,
  formId,
  pending,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  formId: string;
  pending: boolean;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description ?? "Edited terms return to unverified until reviewed."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} loading={pending}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="space-y-5">
        {children}
      </form>
    </Sheet>
  );
}

function useSubmit(leaseId: string, kind: string, existingId: string | undefined, onDone: () => void) {
  const m = useLeaseMutation(leaseId);
  const submit = (body: unknown) =>
    m.mutate(
      { method: existingId ? "patch" : "post", path: existingId ? `${kind}/${existingId}` : kind, body },
      {
        onSuccess: () => {
          toast.success("Saved");
          onDone();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  return { submit, pending: m.isPending };
}

/* ------------------------------------------------------------------ recovery */

export function RecoverySheet({ open, onOpenChange, leaseId, row }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId: string; row?: Recovery | null }) {
  const { form, setForm, bind } = useForm(() => {
    const s: FormState = { method: "nnn", category: "all", cap_type: "none", exclusions: "", ai: "" };
    if (!row) return s;
    for (const [k, v] of Object.entries(row)) if (typeof v !== "object" || v === null) s[k] = str(v);
    s.exclusions = row.exclusions.join(", ");
    s.ai = row.ai_extracted ? "1" : "";
    return s;
  }, open);
  const { submit, pending } = useSubmit(leaseId, "recoveries", row?.id, () => onOpenChange(false));
  const n = (k: string) => toNumber(form[k] ?? "");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit({
      method: form.method, category: form.category, pro_rata_share: n("pro_rata_share"), base_year: n("base_year"),
      base_amount: n("base_amount"), expense_stop_psf: n("expense_stop_psf"), fixed_amount_annual: n("fixed_amount_annual"),
      estimated_monthly: n("estimated_monthly"), cap_type: form.cap_type, cap_pct: n("cap_pct"), cap_base_amount: n("cap_base_amount"),
      cap_base_year: n("cap_base_year"), admin_fee_pct: n("admin_fee_pct"), gross_up_pct: n("gross_up_pct"),
      exclusions: form.exclusions.split(",").map((x) => x.trim()).filter(Boolean), notes: textOrNull(form.notes),
      ai_extracted: !!form.ai, ...citationPayload(form),
    });
  };

  return (
    <TermSheet open={open} onOpenChange={onOpenChange} title={row ? "Edit recovery" : "Add recovery"} formId="recovery-form" pending={pending} onSubmit={onSubmit}>
      <Grid>
        <Field label="Method"><Select {...bind("method")} options={RECOVERY_METHODS} /></Field>
        <Field label="Expense category"><Select {...bind("category")} options={RECOVERY_CATEGORIES.map((c) => ({ value: c, label: c === "all" ? "All recoverable" : titleCase(c) }))} /></Field>
        <Field label="Pro-rata share (%)" hint="Blank uses the lease share or SF ratio"><Input inputMode="decimal" {...bind("pro_rata_share")} /></Field>
        <Field label="Estimated monthly ($)"><Input inputMode="decimal" {...bind("estimated_monthly")} /></Field>
        {(form.method === "base_year" || form.method === "modified_gross") && (
          <>
            <Field label="Base year"><Input inputMode="numeric" {...bind("base_year")} /></Field>
            <Field label="Base-year pool ($)"><Input inputMode="decimal" {...bind("base_amount")} /></Field>
          </>
        )}
        {form.method === "expense_stop" && <Field label="Expense stop ($/SF)"><Input inputMode="decimal" {...bind("expense_stop_psf")} /></Field>}
        {form.method === "fixed_cam" && <Field label="Fixed CAM (annual $)"><Input inputMode="decimal" {...bind("fixed_amount_annual")} /></Field>}
        <Field label="Admin fee (%)"><Input inputMode="decimal" {...bind("admin_fee_pct")} /></Field>
        <Field label="Gross-up (%)"><Input inputMode="decimal" {...bind("gross_up_pct")} /></Field>
      </Grid>
      <section className="space-y-3">
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Caps & exclusions</h4>
        <Grid>
          <Field label="Cap type"><Select {...bind("cap_type")} options={CAP_TYPES} /></Field>
          <Field label="Cap (% per year)"><Input inputMode="decimal" {...bind("cap_pct")} disabled={form.cap_type === "none"} /></Field>
          <Field label="Cap base amount ($)"><Input inputMode="decimal" {...bind("cap_base_amount")} disabled={form.cap_type === "none"} /></Field>
          <Field label="Cap base year"><Input inputMode="numeric" {...bind("cap_base_year")} disabled={form.cap_type === "none"} /></Field>
          <Field label="Excluded accounts" hint="Comma separated pool keys, e.g. capital_repairs, cam:management" className="col-span-2"><Input {...bind("exclusions")} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea rows={2} {...bind("notes")} /></Field>
        </Grid>
      </section>
      <CitationFields bind={bind} />
      <AiFlag checked={!!form.ai} onChange={(v) => setForm((f) => ({ ...f, ai: v ? "1" : "" }))} />
    </TermSheet>
  );
}

/* ------------------------------------------------------------------ option */

export function OptionSheet({ open, onOpenChange, leaseId, row }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId: string; row?: LeaseOption | null }) {
  const { form, setForm, bind } = useForm(() => {
    const s: FormState = { option_type: "renewal", sequence: "1", pricing_method: "fmv", status: "open", ai: "" };
    if (!row) return s;
    for (const [k, v] of Object.entries(row)) if (typeof v !== "object" || v === null) s[k] = str(v);
    s.ai = row.ai_extracted ? "1" : "";
    return s;
  }, open);
  const { submit, pending } = useSubmit(leaseId, "options", row?.id, () => onOpenChange(false));
  const n = (k: string) => toNumber(form[k] ?? "");
  const t = form.option_type;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit({
      option_type: t, sequence: n("sequence") ?? 1, term_months: n("term_months"), notice_start_on: textOrNull(form.notice_start_on),
      notice_end_on: textOrNull(form.notice_end_on), effective_on: textOrNull(form.effective_on), pricing_method: form.pricing_method,
      option_rent_psf: n("option_rent_psf"), increase_pct: n("increase_pct"), fmv_pct: n("fmv_pct"), fee_amount: n("fee_amount"),
      purchase_price: n("purchase_price"), market_rent_psf: n("market_rent_psf"), space_description: textOrNull(form.space_description),
      conditions: textOrNull(form.conditions), status: form.status, exercised_on: textOrNull(form.exercised_on),
      pricing_params: row?.pricing_params ?? {}, ai_extracted: !!form.ai, ...citationPayload(form),
    });
  };

  return (
    <TermSheet open={open} onOpenChange={onOpenChange} title={row ? "Edit option" : "Add option"} formId="option-form" pending={pending} onSubmit={onSubmit}>
      <Grid>
        <Field label="Option type"><Select {...bind("option_type")} options={OPTION_TYPES.map((o) => ({ value: o, label: OPTION_LABELS[o] }))} /></Field>
        <Field label="Sequence"><Input inputMode="numeric" {...bind("sequence")} /></Field>
        {(t === "renewal" || t === "expansion") && <Field label="Term (months)"><Input inputMode="numeric" {...bind("term_months")} /></Field>}
        <Field label="Status"><Select {...bind("status")} options={["open", "exercised", "waived", "expired"].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>
        <Field label="Notice window opens"><Input type="date" {...bind("notice_start_on")} /></Field>
        <Field label="Notice deadline"><Input type="date" {...bind("notice_end_on")} /></Field>
        <Field label="Effective on"><Input type="date" {...bind("effective_on")} /></Field>
        {form.status === "exercised" && <Field label="Exercised on"><Input type="date" {...bind("exercised_on")} /></Field>}
      </Grid>
      <section className="space-y-3">
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Pricing mechanics</h4>
        <Grid>
          <Field label="Pricing method" className="col-span-2"><Select {...bind("pricing_method")} options={PRICING_METHODS} /></Field>
          {form.pricing_method === "fixed_rent" && <Field label="Option rent ($/SF/yr)"><Input inputMode="decimal" {...bind("option_rent_psf")} /></Field>}
          {form.pricing_method === "fixed_increase" && <Field label="Increase over current (%)"><Input inputMode="decimal" {...bind("increase_pct")} /></Field>}
          {form.pricing_method === "pct_of_fmv" && <Field label="% of FMV"><Input inputMode="decimal" {...bind("fmv_pct")} /></Field>}
          {(t === "termination" || form.pricing_method === "fee") && <Field label="Termination fee ($)"><Input inputMode="decimal" {...bind("fee_amount")} /></Field>}
          {(t === "purchase" || form.pricing_method === "fixed_price") && <Field label="Purchase price ($)"><Input inputMode="decimal" {...bind("purchase_price")} /></Field>}
          {(t === "renewal" || t === "expansion") && <Field label="Market rent ($/SF/yr)" hint="Blank uses the lease assumption"><Input inputMode="decimal" {...bind("market_rent_psf")} /></Field>}
          {t === "expansion" && <Field label="Expansion space" className="col-span-2"><Input {...bind("space_description")} /></Field>}
          <Field label="Conditions" className="col-span-2"><Textarea rows={2} {...bind("conditions")} placeholder="e.g. tenant not in default, continuous operation" /></Field>
        </Grid>
      </section>
      <CitationFields bind={bind} />
      <AiFlag checked={!!form.ai} onChange={(v) => setForm((f) => ({ ...f, ai: v ? "1" : "" }))} />
    </TermSheet>
  );
}

/* ------------------------------------------------------------------ clause */

export function ClauseSheet({ open, onOpenChange, leaseId, row, defaultCategory }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId: string; row?: Clause | null; defaultCategory?: string }) {
  const { form, setForm, bind } = useForm(() => {
    const s: FormState = { category: defaultCategory ?? "use", ai: "", terms: "" };
    if (!row) return s;
    for (const [k, v] of Object.entries(row)) if (typeof v !== "object" || v === null) s[k] = str(v);
    s.terms = Object.entries(row.terms ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join("\n");
    s.ai = row.ai_extracted ? "1" : "";
    return s;
  }, open);
  const { submit, pending } = useSubmit(leaseId, "clauses", row?.id, () => onOpenChange(false));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const terms: Record<string, string> = {};
    for (const line of form.terms.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) terms[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    submit({
      category: form.category, title: form.title?.trim() || titleCase(form.category), summary: textOrNull(form.summary), terms,
      obligated_party: textOrNull(form.obligated_party), due_on: textOrNull(form.due_on), recurrence: textOrNull(form.recurrence),
      response_days: toNumber(form.response_days ?? ""), ai_extracted: !!form.ai, ...citationPayload(form),
    });
  };
  const obligation = ["estoppel", "certificate", "reporting", "landlord_obligation", "insurance"].includes(form.category);

  return (
    <TermSheet open={open} onOpenChange={onOpenChange} title={row ? "Edit clause" : "Add clause"} formId="clause-form" pending={pending} onSubmit={onSubmit}>
      <Grid>
        <Field label="Category"><Select {...bind("category")} options={CLAUSE_CATEGORIES.map((c) => ({ value: c, label: c === "sna" ? "SNDA" : titleCase(c) }))} /></Field>
        <Field label="Title"><Input {...bind("title")} placeholder={titleCase(form.category)} /></Field>
        <Field label="Summary" className="col-span-2"><Textarea rows={3} {...bind("summary")} /></Field>
        <Field label="Structured terms" hint="One per line as key: value (e.g. cure_days: 10)" className="col-span-2"><Textarea rows={3} {...bind("terms")} /></Field>
        <Field label="Obligated party">
          <Select {...bind("obligated_party")} placeholder="—" options={["landlord", "tenant", "guarantor"].map((p) => ({ value: p, label: titleCase(p) }))} />
        </Field>
        <Field label="Response / delivery days"><Input inputMode="numeric" {...bind("response_days")} /></Field>
        {obligation && (
          <>
            <Field label="Next due date" hint="Drives a critical date once verified"><Input type="date" {...bind("due_on")} /></Field>
            <Field label="Recurrence">
              <Select {...bind("recurrence")} placeholder="—" options={["once", "monthly", "quarterly", "annual"].map((r) => ({ value: r, label: titleCase(r) }))} />
            </Field>
          </>
        )}
      </Grid>
      <CitationFields bind={bind} />
      <AiFlag checked={!!form.ai} onChange={(v) => setForm((f) => ({ ...f, ai: v ? "1" : "" }))} />
    </TermSheet>
  );
}

/* ------------------------------------------------------------------ guaranty */

export function GuarantySheet({ open, onOpenChange, leaseId, row }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId: string; row?: Guaranty | null }) {
  const { form, setForm, bind } = useForm(() => {
    const s: FormState = { guaranty_type: "full", status: "active", ai: "", financials: "" };
    if (!row) return s;
    for (const [k, v] of Object.entries(row)) if (typeof v !== "object" || v === null) s[k] = str(v);
    s.financials = row.financials_required ? "1" : "";
    s.ai = row.ai_extracted ? "1" : "";
    return s;
  }, open);
  const { submit, pending } = useSubmit(leaseId, "guaranties", row?.id, () => onOpenChange(false));
  const n = (k: string) => toNumber(form[k] ?? "");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit({
      guarantor_name: form.guarantor_name?.trim(), guaranty_type: form.guaranty_type, cap_amount: n("cap_amount"),
      effective_on: textOrNull(form.effective_on), expires_on: textOrNull(form.expires_on), burn_down: row?.burn_down ?? [],
      financials_required: !!form.financials, financials_due_on: textOrNull(form.financials_due_on), estoppel_days: n("estoppel_days"),
      status: form.status, notes: textOrNull(form.notes), ai_extracted: !!form.ai, ...citationPayload(form),
    });
  };

  return (
    <TermSheet open={open} onOpenChange={onOpenChange} title={row ? "Edit guaranty" : "Add guaranty"} formId="guaranty-form" pending={pending} onSubmit={onSubmit}>
      <Grid>
        <Field label="Guarantor" required className="col-span-2"><Input {...bind("guarantor_name")} required /></Field>
        <Field label="Type"><Select {...bind("guaranty_type")} options={GUARANTY_TYPES.map((g) => ({ value: g, label: titleCase(g) }))} /></Field>
        <Field label="Status"><Select {...bind("status")} options={["active", "released", "expired"].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>
        <Field label="Cap ($)"><Input inputMode="decimal" {...bind("cap_amount")} /></Field>
        <Field label="Estoppel delivery (days)"><Input inputMode="numeric" {...bind("estoppel_days")} /></Field>
        <Field label="Effective"><Input type="date" {...bind("effective_on")} /></Field>
        <Field label="Expires"><Input type="date" {...bind("expires_on")} /></Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={!!form.financials} onChange={(v) => setForm((f) => ({ ...f, financials: v ? "1" : "" }))} />
          Guarantor must deliver financial statements
        </label>
        {!!form.financials && <Field label="Financials due"><Input type="date" {...bind("financials_due_on")} /></Field>}
        <Field label="Notes" className="col-span-2"><Textarea rows={2} {...bind("notes")} /></Field>
      </Grid>
      <CitationFields bind={bind} />
      <AiFlag checked={!!form.ai} onChange={(v) => setForm((f) => ({ ...f, ai: v ? "1" : "" }))} />
    </TermSheet>
  );
}

/* ------------------------------------------------------------------ amendment */

interface OverrideRow { field: string; value: string }
interface StepRow { start_on: string; end_on: string; annual_rent: string }

export function AmendmentSheet({ open, onOpenChange, leaseId }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId: string }) {
  const { form, bind } = useForm(() => ({ kind: "amendment" }), open);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [steps, setSteps] = useState<StepRow[]>([]);
  useEffect(() => {
    if (open) {
      setOverrides([]);
      setSteps([]);
    }
  }, [open]);
  const { submit, pending } = useSubmit(leaseId, "amendments", undefined, () => onOpenChange(false));
  const numeric = new Set(["rentable_sf", "base_rent_annual", "pro_rata_share", "security_deposit", "late_fee_grace_days", "late_fee_pct", "late_fee_flat"]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const o: Record<string, unknown> = {};
    for (const r of overrides) if (r.field) o[r.field] = numeric.has(r.field) ? toNumber(r.value) : textOrNull(r.value);
    submit({
      kind: form.kind, title: form.title?.trim(), executed_on: textOrNull(form.executed_on), effective_on: form.effective_on,
      document_id: textOrNull(form.document_id), page: toNumber(form.page ?? ""), clause_ref: textOrNull(form.clause_ref),
      summary: textOrNull(form.summary), overrides: o,
      rent_steps: steps.filter((s) => s.start_on && s.end_on && s.annual_rent).map((s) => ({ start_on: s.start_on, end_on: s.end_on, annual_rent: toNumber(s.annual_rent) ?? 0 })),
    });
  };

  return (
    <TermSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add to amendment chain"
      description="Amendments override terms from their effective date. Original values are kept."
      formId="amendment-form"
      pending={pending}
      onSubmit={onSubmit}
    >
      <Grid>
        <Field label="Kind"><Select {...bind("kind")} options={AMENDMENT_KINDS.map((k) => ({ value: k, label: titleCase(k) }))} /></Field>
        <Field label="Title" required><Input {...bind("title")} required placeholder="e.g. First amendment" /></Field>
        <Field label="Executed"><Input type="date" {...bind("executed_on")} /></Field>
        <Field label="Effective" required><Input type="date" {...bind("effective_on")} required /></Field>
        <Field label="Summary" className="col-span-2"><Textarea rows={2} {...bind("summary")} /></Field>
        <Field label="Document ID" className="col-span-2"><Input {...bind("document_id")} /></Field>
        <Field label="Page"><Input inputMode="numeric" {...bind("page")} /></Field>
        <Field label="Section"><Input {...bind("clause_ref")} /></Field>
      </Grid>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Term overrides</h4>
          <Button size="xs" onClick={() => setOverrides((o) => [...o, { field: "expiration_on", value: "" }])}>
            <Plus className="!size-3.5" /> Override
          </Button>
        </div>
        {overrides.length === 0 && <p className="text-xs text-ink-3">No overrides. Add one for each term this document changes.</p>}
        {overrides.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select
              className="w-48"
              value={r.field}
              onChange={(e) => setOverrides((o) => o.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
              options={OVERRIDABLE_FIELDS.map((f) => ({ value: f, label: titleCase(f) }))}
            />
            <Input
              className="flex-1"
              type={r.field.endsWith("_on") ? "date" : "text"}
              value={r.value}
              onChange={(e) => setOverrides((o) => o.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setOverrides((o) => o.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Replacement rent steps</h4>
          <Button size="xs" onClick={() => setSteps((s) => [...s, { start_on: "", end_on: "", annual_rent: "" }])}>
            <Plus className="!size-3.5" /> Step
          </Button>
        </div>
        <p className="text-xs text-ink-3">Steps here replace the schedule from the amendment&apos;s effective date onward.</p>
        {steps.map((s, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
            <Input type="date" value={s.start_on} onChange={(e) => setSteps((x) => x.map((r, j) => (j === i ? { ...r, start_on: e.target.value } : r)))} />
            <Input type="date" value={s.end_on} onChange={(e) => setSteps((x) => x.map((r, j) => (j === i ? { ...r, end_on: e.target.value } : r)))} />
            <Input inputMode="decimal" placeholder="Annual rent" value={s.annual_rent} onChange={(e) => setSteps((x) => x.map((r, j) => (j === i ? { ...r, annual_rent: e.target.value } : r)))} />
            <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </section>
    </TermSheet>
  );
}

/* ------------------------------------------------------------------ rent schedule */

export function RentStepDialog({ open, onOpenChange, leaseId }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId: string }) {
  const { form, bind } = useForm(() => ({ charge_type: "base_rent" }), open);
  const { submit, pending } = useSubmit(leaseId, "rent-steps", undefined, () => onOpenChange(false));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add rent step"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!form.start_on || !form.end_on || toNumber(form.annual_rent ?? "") === null}
            onClick={() =>
              submit({
                start_on: form.start_on, end_on: form.end_on, annual_rent: toNumber(form.annual_rent ?? "") ?? 0, charge_type: form.charge_type,
                note: textOrNull(form.note), ...citationPayload(form),
              })
            }
          >
            Add step
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start"><Input type="date" {...bind("start_on")} /></Field>
        <Field label="End"><Input type="date" {...bind("end_on")} /></Field>
        <Field label="Annual rent ($)"><Input inputMode="decimal" {...bind("annual_rent")} /></Field>
        <Field label="Charge type">
          <Select {...bind("charge_type")} options={["base_rent", "percentage_rent", "parking", "other"].map((c) => ({ value: c, label: titleCase(c) }))} />
        </Field>
        <Field label="Note" className="col-span-2"><Input {...bind("note")} /></Field>
        <Field label="Page"><Input inputMode="numeric" {...bind("page")} /></Field>
        <Field label="Section"><Input {...bind("clause_ref")} /></Field>
      </div>
    </Dialog>
  );
}

interface TableRow { start_on: string; end_on: string; annual_rent: string; rent_psf: string }

export function EscalationGenerator({ open, onOpenChange, lease }: { open: boolean; onOpenChange: (o: boolean) => void; lease: Lease }) {
  const esc = (lease.escalation ?? {}) as Record<string, unknown>;
  const { form, setForm, bind } = useForm(
    () => ({
      method: str(esc.method) || "fixed_pct",
      base_annual_rent: str(esc.base_annual_rent ?? lease.base_rent_annual),
      base_rent_psf: str(esc.base_rent_psf),
      start_on: str(esc.start_on ?? lease.rent_commencement_on ?? lease.commencement_on),
      end_on: str(esc.end_on ?? lease.expiration_on),
      frequency_months: str(esc.frequency_months ?? 12),
      pct: str(esc.pct ?? 3),
      amount: str(esc.amount),
      cpi_assumed_pct: str(esc.cpi_assumed_pct ?? 3),
      cpi_floor_pct: str(esc.cpi_floor_pct),
      cpi_cap_pct: str(esc.cpi_cap_pct),
      free_rent_months: str(esc.free_rent_months ?? 0),
      replace: "1",
    }),
    open,
  );
  const [rows, setRows] = useState<TableRow[]>([]);
  useEffect(() => {
    if (open) {
      const steps = (esc.steps as { start_on: string; end_on: string | null; annual_rent: number | null; rent_psf: number | null }[] | undefined) ?? [];
      setRows(steps.map((s) => ({ start_on: s.start_on, end_on: s.end_on ?? "", annual_rent: str(s.annual_rent), rent_psf: str(s.rent_psf) })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const m = useLeaseMutation(lease.id);
  const n = (k: string) => toNumber(form[k] ?? "");

  const run = () =>
    m.mutate(
      {
        method: "post",
        path: "rent-steps/generate",
        body: {
          method: form.method, base_annual_rent: n("base_annual_rent"), base_rent_psf: n("base_rent_psf"), start_on: textOrNull(form.start_on),
          end_on: textOrNull(form.end_on), frequency_months: n("frequency_months") ?? 12, pct: n("pct"), amount: n("amount"),
          cpi_assumed_pct: n("cpi_assumed_pct"), cpi_floor_pct: n("cpi_floor_pct"), cpi_cap_pct: n("cpi_cap_pct"),
          free_rent_months: n("free_rent_months") ?? 0, replace: !!form.replace,
          steps: rows.filter((r) => r.start_on).map((r) => ({ start_on: r.start_on, end_on: r.end_on || null, annual_rent: toNumber(r.annual_rent), rent_psf: toNumber(r.rent_psf) })),
        },
      },
      {
        onSuccess: () => {
          toast.success("Rent schedule generated");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const method = form.method;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Escalation generator"
      description="Stores the escalation mechanics on the lease and builds the rent steps."
      className="max-w-xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={run}>
            Generate schedule
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Method" className="col-span-2"><Select {...bind("method")} options={ESCALATION_METHODS} /></Field>
        <Field label="Start"><Input type="date" {...bind("start_on")} /></Field>
        <Field label="End"><Input type="date" {...bind("end_on")} /></Field>
        {method !== "step_table" && (
          <>
            <Field label="Base annual rent ($)" hint={lease.base_rent_annual ? `Abstract: ${formatCurrency(lease.base_rent_annual)}` : undefined}><Input inputMode="decimal" {...bind("base_annual_rent")} /></Field>
            <Field label="or base rent ($/SF)"><Input inputMode="decimal" {...bind("base_rent_psf")} /></Field>
            <Field label="Escalates every (months)"><Input inputMode="numeric" {...bind("frequency_months")} /></Field>
            <Field label="Free rent (months)"><Input inputMode="numeric" {...bind("free_rent_months")} /></Field>
          </>
        )}
        {method === "fixed_pct" && <Field label="Increase (%)"><Input inputMode="decimal" {...bind("pct")} /></Field>}
        {method === "fixed_amount" && <Field label="Increase ($ annual)"><Input inputMode="decimal" {...bind("amount")} /></Field>}
        {method === "cpi" && (
          <>
            <Field label="Assumed CPI (%)"><Input inputMode="decimal" {...bind("cpi_assumed_pct")} /></Field>
            <Field label="Floor (%)"><Input inputMode="decimal" {...bind("cpi_floor_pct")} /></Field>
            <Field label="Cap (%)"><Input inputMode="decimal" {...bind("cpi_cap_pct")} /></Field>
          </>
        )}
      </div>
      {method === "step_table" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-ink-2">Steps</p>
            <Button size="xs" onClick={() => setRows((r) => [...r, { start_on: "", end_on: "", annual_rent: "", rent_psf: "" }])}>
              <Plus className="!size-3.5" /> Row
            </Button>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2">
              <Input type="date" value={r.start_on} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, start_on: e.target.value } : y)))} />
              <Input type="date" value={r.end_on} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, end_on: e.target.value } : y)))} />
              <Input placeholder="Annual $" inputMode="decimal" value={r.annual_rent} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, annual_rent: e.target.value } : y)))} />
              <Input placeholder="$/SF" inputMode="decimal" value={r.rent_psf} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, rent_psf: e.target.value } : y)))} />
              <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      <label className="mt-4 flex items-center gap-2 text-sm text-ink-2">
        <Checkbox checked={!!form.replace} onChange={(v) => setForm((f) => ({ ...f, replace: v ? "1" : "" }))} />
        Replace existing original-lease steps (amendment steps are kept)
      </label>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ field citation */

export function FieldCitationDialog({ open, onOpenChange, lease, field }: { open: boolean; onOpenChange: (o: boolean) => void; lease: Lease; field: string | null }) {
  const current = field ? lease.citations?.[field] : undefined;
  const { form, bind } = useForm(() => {
    const s: FormState = {};
    for (const k of CITE_KEYS) s[k] = str((current as unknown as Record<string, unknown> | undefined)?.[k] ?? (k === "document_id" ? lease.document_id : ""));
    return s;
  }, open);
  const m = useSaveLease(lease.id);
  const save = () => {
    if (!field) return;
    m.mutate(
      {
        citations: { ...(lease.citations ?? {}), [field]: citationPayload(form) },
        provenance: { source: "Citation update", observed_on: null, confidence: 1, verified: lease.verified },
      },
      { onSuccess: () => { toast.success("Citation saved"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Cite ${titleCase(field ?? "")}`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={save}>Save citation</Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="Document ID" className="col-span-3"><Input {...bind("document_id")} /></Field>
        <Field label="Page"><Input inputMode="numeric" {...bind("page")} /></Field>
        <Field label="Clause / section" className="col-span-2"><Input {...bind("clause_ref")} /></Field>
        <Field label="Quoted text" className="col-span-3"><Textarea rows={4} {...bind("quoted_text")} /></Field>
      </div>
    </Dialog>
  );
}
