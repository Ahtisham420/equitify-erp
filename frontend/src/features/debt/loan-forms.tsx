"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { OrganizationPicker, PersonPicker } from "@/features/contacts/pickers";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, titleCase, toNumber } from "@/lib/utils";

import {
  COVENANT_KIND_LABELS,
  COVENANT_KINDS,
  COVENANT_STATE_LABELS,
  COVENANT_STATE_TONES,
  FREQUENCIES,
  LOAN_STATUSES,
  LOAN_TYPES,
  PREPAYMENT_TYPES,
  RATE_TYPES,
  RECOURSE_TYPES,
  REPORT_TYPES,
  RESERVE_TYPES,
  useAddCollateral,
  useDebtSettings,
  usePostReserveTxn,
  useSaveCovenant,
  useSaveDebtSettings,
  useSaveLoan,
  useSaveObligation,
  useSaveReserve,
  useSubmitObligation,
  useTestCovenant,
  type Covenant,
  type DebtSettings,
  type Guarantor,
  type Loan,
  type LoanInput,
  type MarketTerms,
  type Obligation,
  type Reserve,
  type ReserveTxn,
} from "./api";

type FormState = Record<string, string>;

const opts = (values: readonly string[], label: (v: string) => string = titleCase) => values.map((v) => ({ value: v, label: label(v) }));
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const textOrNull = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
export const todayIso = () => new Date().toISOString().slice(0, 10);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useBind(form: FormState, setForm: (fn: (f: FormState) => FormState) => void) {
  return (key: string) => ({
    id: key,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
        {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ loan */

const LOAN_TEXT = [
  "name", "loan_number", "lender_name", "loan_type", "originated_on", "maturity_on", "rate_type", "index_name", "recourse",
  "recourse_notes", "cap_provider", "cap_expires_on", "swap_expires_on", "status", "notes",
] as const;
const LOAN_NUM = ["original_balance", "current_balance", "rate", "spread", "rate_floor", "amortization_months", "io_months", "cap_strike", "swap_rate"] as const;
const PREPAY_TEXT = ["type", "lockout_end", "open_from", "notes"] as const;
const PREPAY_NUM = ["ym_floor_pct", "treasury_rate", "defeasance_fee"] as const;

interface GuarantorRow { kind: Guarantor["kind"]; person_id: string | null; organization_id: string | null; name: string; guaranty_type: Guarantor["guaranty_type"]; limit: string }
const GUARANTY_TYPES = ["payment", "carveout", "completion", "environmental", "other"] as const;

function loanToForm(l?: Loan | null): FormState {
  const s: FormState = { loan_type: "senior", rate_type: "fixed", recourse: "non_recourse", status: "active", effective_on: "", change_note: "" };
  if (!l) return s;
  for (const k of [...LOAN_TEXT, ...LOAN_NUM]) s[k] = str((l as unknown as Record<string, unknown>)[k]);
  return s;
}

function prepayToForm(l?: Loan | null): FormState {
  const s: FormState = { type: "none" };
  const p = l?.prepayment;
  if (!p) return s;
  for (const k of [...PREPAY_TEXT, ...PREPAY_NUM]) s[k] = str((p as unknown as Record<string, unknown>)[k]);
  s.type = p.type || "none";
  return s;
}

export function LoanFormSheet({
  open,
  onOpenChange,
  loan,
  propertyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  loan?: Loan | null;
  propertyId?: string;
  onSaved?: (l: Loan) => void;
}) {
  const [form, setForm] = useState<FormState>(loanToForm(loan));
  const [prepay, setPrepay] = useState<FormState>(prepayToForm(loan));
  const [steps, setSteps] = useState<{ until: string; pct: string }[]>([]);
  const [guarantors, setGuarantors] = useState<GuarantorRow[]>([]);
  const [ids, setIds] = useState<{ property_id: string | null; lender_organization_id: string | null; owner_id: string | null }>({ property_id: null, lender_organization_id: null, owner_id: null });
  const save = useSaveLoan(loan?.id);
  const bind = useBind(form, setForm);
  const bindP = useBind(prepay, setPrepay);

  useEffect(() => {
    if (!open) return;
    setForm(loanToForm(loan));
    setPrepay(prepayToForm(loan));
    setSteps((loan?.prepayment?.step_down ?? []).map((s) => ({ until: s.until, pct: String(s.pct) })));
    setGuarantors(
      (loan?.guarantors ?? []).map((g) => ({
        kind: g.kind, person_id: g.person_id, organization_id: g.organization_id, name: g.name ?? "",
        guaranty_type: g.guaranty_type, limit: str(g.limit_amount),
      })),
    );
    setIds({ property_id: loan?.property_id ?? propertyId ?? null, lender_organization_id: loan?.lender_organization_id ?? null, owner_id: loan?.owner_id ?? null });
  }, [open, loan, propertyId]);

  const setG = (i: number, patch: Partial<GuarantorRow>) => setGuarantors((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setStep = (i: number, patch: Partial<{ until: string; pct: string }>) => setSteps((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = {};
    for (const k of LOAN_TEXT) data[k] = textOrNull(form[k]);
    for (const k of LOAN_NUM) data[k] = toNumber(form[k] ?? "");
    for (const k of ["amortization_months", "io_months"]) if (data[k] !== null) data[k] = Math.round(data[k] as number);
    data.loan_type = form.loan_type || "senior";
    data.rate_type = form.rate_type || "fixed";
    data.recourse = form.recourse || "non_recourse";
    data.status = form.status || "active";
    Object.assign(data, ids);
    const p: Record<string, unknown> = {};
    for (const k of PREPAY_TEXT) p[k] = textOrNull(prepay[k]);
    for (const k of PREPAY_NUM) p[k] = toNumber(prepay[k] ?? "");
    p.type = prepay.type || "none";
    p.step_down = steps.filter((s) => s.until && toNumber(s.pct) !== null).map((s) => ({ until: s.until, pct: toNumber(s.pct) }));
    data.prepayment = p;
    data.guarantors = guarantors
      .filter((g) => g.person_id || g.organization_id || g.name.trim())
      .map((g) => ({
        kind: g.kind,
        person_id: g.kind === "person" ? g.person_id : null,
        organization_id: g.kind === "organization" ? g.organization_id : null,
        name: textOrNull(g.name),
        guaranty_type: g.guaranty_type,
        limit_amount: toNumber(g.limit),
      }));
    if (loan) {
      data.effective_on = form.effective_on || null;
      data.change_note = textOrNull(form.change_note);
    }
    save.mutate(data as LoanInput, {
      onSuccess: (l) => {
        toast.success(loan ? "Loan updated" : "Loan created");
        onOpenChange(false);
        onSaved?.(l);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const ptype = prepay.type || "none";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={loan ? "Edit loan" : "New loan"}
      description={loan ? loan.label : "The asset is linked automatically from the property."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="loan-form" loading={save.isPending}>
            {loan ? "Save changes" : "Create loan"}
          </Button>
        </>
      }
    >
      <form id="loan-form" onSubmit={submit} className="space-y-6">
        {loan && (
          <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
            <div>
              <h4 className="text-sm font-medium">Change context</h4>
              <p className="text-xs text-ink-3">Material changes (balance, rate, maturity, status, terms) are written to the loan history with this date and note.</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Effective date">
                <Input type="date" {...bind("effective_on")} />
              </Field>
              <Field label="Change note" className="col-span-2">
                <Input {...bind("change_note")} placeholder="e.g. Principal paydown, extension exercised" />
              </Field>
            </div>
          </section>
        )}

        <Section title="Identity">
          <Field label="Loan name" className="col-span-2"><Input {...bind("name")} placeholder="e.g. Senior loan – Main & 5th" /></Field>
          <Field label="Loan number"><Input {...bind("loan_number")} /></Field>
          <Field label="Status"><Select {...bind("status")} options={opts(LOAN_STATUSES)} /></Field>
          <Field label="Property" className="col-span-2">
            <PropertyPicker value={ids.property_id} onChange={(id) => setIds((s) => ({ ...s, property_id: id }))} />
          </Field>
          <Field label="Lender organization">
            <OrganizationPicker value={ids.lender_organization_id} onChange={(id) => setIds((s) => ({ ...s, lender_organization_id: id }))} />
          </Field>
          <Field label="Lender name" hint="Used when no organization is linked"><Input {...bind("lender_name")} /></Field>
          <Field label="Loan type"><Select {...bind("loan_type")} options={opts(LOAN_TYPES)} /></Field>
          <Field label="Owner"><UserPicker value={ids.owner_id} onChange={(id) => setIds((s) => ({ ...s, owner_id: id }))} /></Field>
        </Section>

        <Section title="Balance & dates">
          <Field label="Original balance ($)"><Input {...bind("original_balance")} inputMode="decimal" /></Field>
          <Field label="Current balance ($)"><Input {...bind("current_balance")} inputMode="decimal" /></Field>
          <Field label="Originated on"><Input type="date" {...bind("originated_on")} /></Field>
          <Field label="Maturity date"><Input type="date" {...bind("maturity_on")} /></Field>
        </Section>

        <Section title="Rate & amortization">
          <Field label="Rate type"><Select {...bind("rate_type")} options={opts(RATE_TYPES)} /></Field>
          <Field label="Rate (%)" hint={form.rate_type === "floating" ? "All-in current rate" : undefined}><Input {...bind("rate")} inputMode="decimal" /></Field>
          {form.rate_type === "floating" && (
            <>
              <Field label="Index"><Input {...bind("index_name")} placeholder="e.g. SOFR" /></Field>
              <Field label="Spread (%)"><Input {...bind("spread")} inputMode="decimal" /></Field>
              <Field label="Rate floor (%)"><Input {...bind("rate_floor")} inputMode="decimal" /></Field>
            </>
          )}
          <Field label="Amortization (months)"><Input {...bind("amortization_months")} inputMode="numeric" /></Field>
          <Field label="Interest-only (months)"><Input {...bind("io_months")} inputMode="numeric" /></Field>
        </Section>

        {form.rate_type === "floating" && (
          <Section title="Hedging">
            <Field label="Cap strike (%)"><Input {...bind("cap_strike")} inputMode="decimal" /></Field>
            <Field label="Cap provider"><Input {...bind("cap_provider")} /></Field>
            <Field label="Cap expires on"><Input type="date" {...bind("cap_expires_on")} /></Field>
            <div />
            <Field label="Swap rate (%)"><Input {...bind("swap_rate")} inputMode="decimal" /></Field>
            <Field label="Swap expires on"><Input type="date" {...bind("swap_expires_on")} /></Field>
          </Section>
        )}

        <Section title="Recourse & guarantors">
          <Field label="Recourse"><Select {...bind("recourse")} options={opts(RECOURSE_TYPES)} /></Field>
          <div />
          <Field label="Recourse notes" className="col-span-2"><Textarea rows={2} {...bind("recourse_notes")} /></Field>
          <div className="col-span-2 space-y-2">
            {guarantors.map((g, i) => (
              <div key={i} className="grid grid-cols-[110px_1fr_auto] gap-2 rounded-md border border-line p-2">
                <Select
                  value={g.kind}
                  onChange={(e) => setG(i, { kind: e.target.value as Guarantor["kind"], person_id: null, organization_id: null })}
                  options={[{ value: "organization", label: "Organization" }, { value: "person", label: "Person" }]}
                  aria-label="Guarantor kind"
                />
                {g.kind === "person" ? (
                  <PersonPicker value={g.person_id} onChange={(id) => setG(i, { person_id: id })} />
                ) : (
                  <OrganizationPicker value={g.organization_id} onChange={(id) => setG(i, { organization_id: id })} />
                )}
                <Button size="icon" variant="ghost" aria-label="Remove guarantor" onClick={() => setGuarantors((rows) => rows.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
                <div className="col-span-3 grid grid-cols-[1fr_150px_110px] gap-2">
                  <Input value={g.name} onChange={(e) => setG(i, { name: e.target.value })} placeholder="Name (if not linked)" />
                  <Select value={g.guaranty_type} onChange={(e) => setG(i, { guaranty_type: e.target.value as Guarantor["guaranty_type"] })} options={opts(GUARANTY_TYPES)} aria-label="Guaranty type" />
                  <Input value={g.limit} onChange={(e) => setG(i, { limit: e.target.value })} placeholder="Limit $" inputMode="decimal" />
                </div>
              </div>
            ))}
            <Button
              size="sm"
              onClick={() => setGuarantors((rows) => [...rows, { kind: "organization", person_id: null, organization_id: null, name: "", guaranty_type: "carveout", limit: "" }])}
            >
              <Plus /> Add guarantor
            </Button>
          </div>
        </Section>

        <Section title="Prepayment">
          <Field label="Structure"><Select {...bindP("type")} options={opts(PREPAYMENT_TYPES)} /></Field>
          {ptype !== "none" && ptype !== "open" ? <Field label="Lockout ends"><Input type="date" {...bindP("lockout_end")} /></Field> : <div />}
          {ptype !== "none" && <Field label="Open at par from"><Input type="date" {...bindP("open_from")} /></Field>}
          {ptype === "yield_maintenance" && <Field label="YM floor (%)"><Input {...bindP("ym_floor_pct")} inputMode="decimal" /></Field>}
          {(ptype === "yield_maintenance" || ptype === "defeasance") && (
            <Field label="Treasury rate (%)" hint="Blank uses the market setting"><Input {...bindP("treasury_rate")} inputMode="decimal" /></Field>
          )}
          {ptype === "defeasance" && <Field label="Defeasance fees ($)"><Input {...bindP("defeasance_fee")} inputMode="decimal" /></Field>}
          {ptype === "step_down" && (
            <div className="col-span-2 space-y-2">
              <p className="text-xs font-medium text-ink-2">Step-down schedule</p>
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-ink-3">Until</span>
                  <Input type="date" value={s.until} onChange={(e) => setStep(i, { until: e.target.value })} className="w-40" />
                  <Input value={s.pct} onChange={(e) => setStep(i, { pct: e.target.value })} placeholder="%" inputMode="decimal" className="w-24" />
                  <span className="text-xs text-ink-3">% of balance</span>
                  <Button size="icon-sm" variant="ghost" aria-label="Remove step" onClick={() => setSteps((rows) => rows.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button size="sm" onClick={() => setSteps((rows) => [...rows, { until: "", pct: "" }])}>
                <Plus /> Add step
              </Button>
            </div>
          )}
          <Field label="Prepayment notes" className="col-span-2"><Textarea rows={2} {...bindP("notes")} /></Field>
        </Section>

        <Section title="Notes">
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ collateral */

export function CollateralDialog({ open, onOpenChange, loanId }: { open: boolean; onOpenChange: (o: boolean) => void; loanId: string }) {
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [allocated, setAllocated] = useState("");
  const [release, setRelease] = useState("");
  const add = useAddCollateral(loanId);

  useEffect(() => {
    if (open) {
      setPropertyId(null);
      setAllocated("");
      setRelease("");
    }
  }, [open]);

  const submit = () => {
    if (!propertyId) return;
    add.mutate(
      { property_id: propertyId, allocated_amount: toNumber(allocated), release_price: toNumber(release) },
      {
        onSuccess: () => {
          toast.success("Collateral added");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add cross-collateral property"
      description="Link another property securing this loan."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!propertyId} loading={add.isPending} onClick={submit}>
            Add property
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Property" required className="col-span-2">
          <PropertyPicker value={propertyId} onChange={(id) => setPropertyId(id)} />
        </Field>
        <Field label="Allocated loan amount ($)"><Input value={allocated} onChange={(e) => setAllocated(e.target.value)} inputMode="decimal" /></Field>
        <Field label="Release price ($)"><Input value={release} onChange={(e) => setRelease(e.target.value)} inputMode="decimal" /></Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ covenants */

export function CovenantStateBadge({ state }: { state: string | null | undefined }) {
  const s = state || "none";
  return (
    <Badge tone={COVENANT_STATE_TONES[s] ?? "neutral"} dot>
      {COVENANT_STATE_LABELS[s] ?? titleCase(s)}
    </Badge>
  );
}

export const COVENANT_UNITS: Record<string, string> = { dscr: "x", debt_yield: "%", ltv: "%", occupancy: "%", net_worth: "$" };

export function formatCovenantValue(kind: string, v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (kind === "dscr") return `${v.toFixed(2)}x`;
  if (kind === "net_worth") return formatCurrency(v);
  return `${v.toFixed(2)}%`;
}

function covenantToForm(c?: Covenant | null): FormState {
  if (!c) return { kind: "dscr", label: "", operator: "min", threshold: "", watch_threshold: "", frequency: "quarterly", next_test_on: "", cure_period_days: "", notes: "", is_active: "1" };
  return {
    kind: c.kind, label: c.label ?? "", operator: c.operator, threshold: str(c.threshold), watch_threshold: str(c.watch_threshold),
    frequency: c.frequency, next_test_on: c.next_test_on ?? "", cure_period_days: str(c.cure_period_days), notes: c.notes ?? "",
    is_active: c.is_active ? "1" : "",
  };
}

export function CovenantSheet({ open, onOpenChange, loanId, covenant }: { open: boolean; onOpenChange: (o: boolean) => void; loanId: string; covenant?: Covenant | null }) {
  const [form, setForm] = useState<FormState>(covenantToForm(covenant));
  const save = useSaveCovenant(loanId);
  const bind = useBind(form, setForm);

  useEffect(() => {
    if (open) setForm(covenantToForm(covenant));
  }, [open, covenant]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const threshold = toNumber(form.threshold ?? "");
    if (threshold === null) {
      toast.error("Threshold is required");
      return;
    }
    const cure = toNumber(form.cure_period_days ?? "");
    save.mutate(
      {
        id: covenant?.id,
        data: {
          kind: form.kind as Covenant["kind"],
          label: textOrNull(form.label),
          operator: (form.operator as "min" | "max") || null,
          threshold,
          watch_threshold: toNumber(form.watch_threshold ?? ""),
          frequency: form.frequency || "quarterly",
          next_test_on: form.next_test_on || null,
          cure_period_days: cure === null ? null : Math.round(cure),
          is_active: form.is_active === "1",
          notes: textOrNull(form.notes),
        },
      },
      {
        onSuccess: () => {
          toast.success(covenant ? "Covenant updated" : "Covenant added");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const unit = COVENANT_UNITS[form.kind] ?? "";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={covenant ? "Edit covenant" : "New covenant"}
      description="Tests use actual verified operating results; the projection carries the trailing trend forward."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="covenant-form" loading={save.isPending}>
            {covenant ? "Save changes" : "Add covenant"}
          </Button>
        </>
      }
    >
      <form id="covenant-form" onSubmit={submit} className="space-y-6">
        <Section title="Test">
          <Field label="Kind">
            <Select
              value={form.kind}
              onChange={(e) => {
                const kind = e.target.value;
                setForm((f) => ({ ...f, kind, operator: kind === "ltv" ? "max" : "min" }));
              }}
              options={COVENANT_KINDS.map((k) => ({ value: k, label: COVENANT_KIND_LABELS[k] }))}
            />
          </Field>
          <Field label="Label" hint="Defaults to the kind"><Input {...bind("label")} /></Field>
          <Field label="Operator">
            <Select {...bind("operator")} options={[{ value: "min", label: "Minimum (at least)" }, { value: "max", label: "Maximum (at most)" }]} />
          </Field>
          <Field label={`Threshold (${unit})`} required><Input {...bind("threshold")} inputMode="decimal" required /></Field>
          <Field label={`Watch threshold (${unit})`} hint="Blank uses the configured watch buffer" className="col-span-2">
            <Input {...bind("watch_threshold")} inputMode="decimal" />
          </Field>
        </Section>
        <Section title="Schedule">
          <Field label="Frequency"><Select {...bind("frequency")} options={opts(FREQUENCIES)} /></Field>
          <Field label="Next test date" hint="Blank means today"><Input type="date" {...bind("next_test_on")} /></Field>
          <Field label="Cure period (days)"><Input {...bind("cure_period_days")} inputMode="numeric" /></Field>
          <label className="flex items-center gap-2 self-end pb-1.5 text-sm text-ink-2">
            <Checkbox checked={form.is_active === "1"} onChange={(v) => setForm((f) => ({ ...f, is_active: v ? "1" : "" }))} />
            Active
          </label>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

export function ManualTestDialog({ open, onOpenChange, loanId, covenant }: { open: boolean; onOpenChange: (o: boolean) => void; loanId: string; covenant: Covenant | null }) {
  const { can } = useAuth();
  const [value, setValue] = useState("");
  const [testDate, setTestDate] = useState("");
  const [notes, setNotes] = useState("");
  const test = useTestCovenant(loanId);
  const netWorth = covenant?.kind === "net_worth";
  const canOverride = netWorth || can("debt", "approve");

  useEffect(() => {
    if (open) {
      setValue("");
      setTestDate("");
      setNotes("");
    }
  }, [open]);

  const submit = () => {
    if (!covenant) return;
    const manual = toNumber(value);
    if (netWorth && manual === null) {
      toast.error("Enter the guarantor net worth from the latest statement");
      return;
    }
    test.mutate(
      { id: covenant.id, manual_value: canOverride ? manual : null, test_date: testDate || null, notes: textOrNull(notes) },
      {
        onSuccess: (t) => {
          toast.success(`Test recorded: ${titleCase(t.state)}`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Test ${covenant?.label ?? "covenant"}`}
      description={netWorth ? "Guarantor net worth is entered from the guarantor's statements." : "Computed from actual verified results unless you enter an override."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={test.isPending} onClick={submit}>
            Run test
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Test date" hint="Blank means today"><Input type="date" value={testDate} onChange={(e) => setTestDate(e.target.value)} /></Field>
        <Field
          label={netWorth ? "Net worth ($)" : `Override value (${COVENANT_UNITS[covenant?.kind ?? ""] ?? ""})`}
          required={netWorth}
          hint={netWorth ? undefined : canOverride ? "Optional; replaces the computed value" : "Overrides require approval permission"}
        >
          <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" disabled={!canOverride} />
        </Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ reserves */

function reserveToForm(r?: Reserve | null): FormState {
  return {
    reserve_type: r?.reserve_type ?? "replacement", label: r?.label ?? "", required_amount: str(r?.required_amount), monthly_deposit: str(r?.monthly_deposit),
    cap_amount: str(r?.cap_amount), release_conditions: r?.release_conditions ?? "", notes: r?.notes ?? "",
  };
}

export function ReserveSheet({ open, onOpenChange, loanId, reserve }: { open: boolean; onOpenChange: (o: boolean) => void; loanId: string; reserve?: Reserve | null }) {
  const [form, setForm] = useState<FormState>(reserveToForm(reserve));
  const save = useSaveReserve(loanId);
  const bind = useBind(form, setForm);

  useEffect(() => {
    if (open) setForm(reserveToForm(reserve));
  }, [open, reserve]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        id: reserve?.id,
        data: {
          reserve_type: form.reserve_type || "replacement",
          label: textOrNull(form.label),
          required_amount: toNumber(form.required_amount ?? ""),
          monthly_deposit: toNumber(form.monthly_deposit ?? ""),
          cap_amount: toNumber(form.cap_amount ?? ""),
          release_conditions: textOrNull(form.release_conditions),
          notes: textOrNull(form.notes),
        },
      },
      {
        onSuccess: () => {
          toast.success(reserve ? "Reserve updated" : "Reserve added");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={reserve ? "Edit reserve" : "New reserve"}
      description="Balances change only through recorded deposits, releases and adjustments."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="reserve-form" loading={save.isPending}>
            {reserve ? "Save changes" : "Add reserve"}
          </Button>
        </>
      }
    >
      <form id="reserve-form" onSubmit={submit} className="space-y-6">
        <Section title="Reserve">
          <Field label="Type"><Select {...bind("reserve_type")} options={opts(RESERVE_TYPES)} /></Field>
          <Field label="Label"><Input {...bind("label")} /></Field>
          <Field label="Required amount ($)"><Input {...bind("required_amount")} inputMode="decimal" /></Field>
          <Field label="Monthly deposit ($)"><Input {...bind("monthly_deposit")} inputMode="decimal" /></Field>
          <Field label="Cap ($)"><Input {...bind("cap_amount")} inputMode="decimal" /></Field>
          <div />
          <Field label="Release conditions" className="col-span-2"><Textarea rows={2} {...bind("release_conditions")} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea rows={2} {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

export function ReserveTxnDialog({
  open,
  onOpenChange,
  loanId,
  reserve,
  kind: initialKind = "deposit",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  loanId: string;
  reserve: Reserve | null;
  kind?: ReserveTxn["kind"];
}) {
  const { can } = useAuth();
  const approver = can("debt", "approve");
  const [kind, setKind] = useState<ReserveTxn["kind"]>(initialKind);
  const [form, setForm] = useState<FormState>({ amount: "", occurred_on: todayIso(), document_id: "", memo: "" });
  const post = usePostReserveTxn(loanId);
  const bind = useBind(form, setForm);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setForm({ amount: "", occurred_on: todayIso(), document_id: "", memo: "" });
    }
  }, [open, initialKind]);

  const blocked = kind !== "deposit" && !approver;

  const submit = () => {
    if (!reserve) return;
    const amount = toNumber(form.amount ?? "");
    if (amount === null || !form.occurred_on) {
      toast.error("Amount and date are required");
      return;
    }
    const doc = form.document_id.trim();
    if (doc && !UUID_RE.test(doc)) {
      toast.error("Document id must be a valid document identifier");
      return;
    }
    post.mutate(
      { reserveId: reserve.id, data: { kind, amount, occurred_on: form.occurred_on, document_id: doc || null, memo: textOrNull(form.memo) } },
      {
        onSuccess: (t) => {
          toast.success(`${titleCase(t.kind)} recorded · balance ${formatCurrency(t.balance_after)}`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Reserve transaction · ${reserve?.label || titleCase(reserve?.reserve_type)}`}
      description={reserve ? `Current balance ${formatCurrency(reserve.balance)}` : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={blocked} loading={post.isPending} onClick={submit}>
            Record {kind}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind" error={blocked ? "Releases and adjustments require approval permission" : null}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as ReserveTxn["kind"])} options={opts(["deposit", "release", "adjustment"])} />
        </Field>
        <Field label="Amount ($)" required hint={kind === "adjustment" ? "Signed: negative reduces the balance" : undefined}>
          <Input {...bind("amount")} inputMode="decimal" />
        </Field>
        <Field label="Date" required><Input type="date" {...bind("occurred_on")} /></Field>
        <Field label="Document id" hint="Optional supporting document"><Input {...bind("document_id")} /></Field>
        <Field label="Memo" className="col-span-2"><Textarea rows={2} {...bind("memo")} /></Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ lender reporting */

function obligationToForm(o?: Obligation | null): FormState {
  return {
    report_type: o?.report_type ?? "operating_statement", label: o?.label ?? "", frequency: o?.frequency ?? "quarterly",
    days_after_period: str(o?.days_after_period ?? 45), next_due_on: o?.next_due_on ?? "", notes: o?.notes ?? "", is_active: o && !o.is_active ? "" : "1",
  };
}

export function ObligationSheet({ open, onOpenChange, loanId, obligation }: { open: boolean; onOpenChange: (o: boolean) => void; loanId: string; obligation?: Obligation | null }) {
  const [form, setForm] = useState<FormState>(obligationToForm(obligation));
  const [owner, setOwner] = useState<string | null>(null);
  const save = useSaveObligation(loanId);
  const bind = useBind(form, setForm);

  useEffect(() => {
    if (open) {
      setForm(obligationToForm(obligation));
      setOwner(obligation?.owner_id ?? null);
    }
  }, [open, obligation]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days = toNumber(form.days_after_period ?? "");
    save.mutate(
      {
        id: obligation?.id,
        data: {
          report_type: form.report_type || "operating_statement",
          label: textOrNull(form.label),
          frequency: form.frequency || "quarterly",
          days_after_period: days === null ? 45 : Math.round(days),
          next_due_on: form.next_due_on || null,
          owner_id: owner,
          is_active: form.is_active === "1",
          notes: textOrNull(form.notes),
        },
      },
      {
        onSuccess: () => {
          toast.success(obligation ? "Reporting obligation updated" : "Reporting obligation added");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={obligation ? "Edit reporting obligation" : "New reporting obligation"}
      description="Each due date becomes a critical date with an owned task."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="obligation-form" loading={save.isPending}>
            {obligation ? "Save changes" : "Add obligation"}
          </Button>
        </>
      }
    >
      <form id="obligation-form" onSubmit={submit} className="space-y-6">
        <Section title="Report">
          <Field label="Report type"><Select {...bind("report_type")} options={opts(REPORT_TYPES)} /></Field>
          <Field label="Label"><Input {...bind("label")} /></Field>
          <Field label="Frequency"><Select {...bind("frequency")} options={opts(FREQUENCIES)} /></Field>
          <Field label="Days after period end"><Input {...bind("days_after_period")} inputMode="numeric" /></Field>
          <Field label="Next due date" hint="Blank computes it from the frequency"><Input type="date" {...bind("next_due_on")} /></Field>
          <Field label="Owner"><UserPicker value={owner} onChange={setOwner} /></Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={form.is_active === "1"} onChange={(v) => setForm((f) => ({ ...f, is_active: v ? "1" : "" }))} />
            Active
          </label>
          <Field label="Notes" className="col-span-2"><Textarea rows={2} {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

export function SubmitObligationDialog({ open, onOpenChange, loanId, obligation }: { open: boolean; onOpenChange: (o: boolean) => void; loanId: string; obligation: Obligation | null }) {
  const [form, setForm] = useState<FormState>({ submitted_on: todayIso(), document_id: "", note: "" });
  const submitM = useSubmitObligation(loanId);
  const bind = useBind(form, setForm);

  useEffect(() => {
    if (open) setForm({ submitted_on: todayIso(), document_id: "", note: "" });
  }, [open]);

  const submit = () => {
    if (!obligation) return;
    const doc = form.document_id.trim();
    if (doc && !UUID_RE.test(doc)) {
      toast.error("Document id must be a valid document identifier");
      return;
    }
    submitM.mutate(
      { id: obligation.id, submitted_on: form.submitted_on || null, document_id: doc || null, note: textOrNull(form.note) },
      {
        onSuccess: () => {
          toast.success("Submission recorded; next due date scheduled");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Submit ${obligation?.label || titleCase(obligation?.report_type)}`}
      description="Completes the current critical date and task, and rolls the obligation forward."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={submitM.isPending} onClick={submit}>
            Record submission
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Submitted on"><Input type="date" {...bind("submitted_on")} /></Field>
        <Field label="Document id" hint="Optional"><Input {...bind("document_id")} /></Field>
        <Field label="Note" className="col-span-2"><Textarea rows={2} {...bind("note")} /></Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ settings */

const MARKET_FIELDS: { key: keyof MarketTerms; label: string }[] = [
  { key: "rate", label: "Rate (%)" },
  { key: "ltv", label: "Max LTV (%)" },
  { key: "dscr", label: "Min DSCR (x)" },
  { key: "debt_yield", label: "Min debt yield (%)" },
  { key: "amort_years", label: "Amortization (years)" },
  { key: "cap_rate", label: "Cap rate (%)" },
  { key: "treasury_rate", label: "Treasury rate (%)" },
  { key: "sale_cost_pct", label: "Sale costs (%)" },
  { key: "refi_cost_pct", label: "Refinance costs (%)" },
];

function settingsToForm(s?: DebtSettings): FormState {
  if (!s) return {};
  const f: FormState = {
    maturity_lead_months: s.maturity_lead_months.join(", "),
    refi_window_months: str(s.refi_window_months),
    cap_lead_days: s.cap_lead_days.join(", "),
    covenant_watch_buffer_pct: str(s.covenant_watch_buffer_pct),
    projection_quarters: str(s.projection_quarters),
  };
  for (const m of MARKET_FIELDS) f[m.key] = str(s.market[m.key]);
  return f;
}

const intList = (v: string) => v.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);

export function DebtSettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useDebtSettings();
  const [form, setForm] = useState<FormState>(settingsToForm(data));
  const save = useSaveDebtSettings();
  const bind = useBind(form, setForm);

  useEffect(() => {
    if (open) setForm(settingsToForm(data));
  }, [open, data]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!data) return;
    const num = (k: string, fallback: number) => toNumber(form[k] ?? "") ?? fallback;
    const market = { ...data.market };
    for (const m of MARKET_FIELDS) market[m.key] = num(m.key, data.market[m.key]);
    const leads = intList(form.maturity_lead_months ?? "");
    const caps = intList(form.cap_lead_days ?? "");
    if (!leads.length || !caps.length) {
      toast.error("Enter at least one maturity lead time and one cap lead time");
      return;
    }
    save.mutate(
      {
        maturity_lead_months: leads,
        refi_window_months: Math.round(num("refi_window_months", data.refi_window_months)),
        cap_lead_days: caps,
        covenant_watch_buffer_pct: num("covenant_watch_buffer_pct", data.covenant_watch_buffer_pct),
        projection_quarters: Math.round(num("projection_quarters", data.projection_quarters)),
        market,
      },
      {
        onSuccess: () => {
          toast.success("Debt settings saved");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Debt settings"
      description="Alert lead times, covenant buffers and the market terms used for refinance sizing."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="debt-settings-form" loading={save.isPending} disabled={!data}>
            Save settings
          </Button>
        </>
      }
    >
      <form id="debt-settings-form" onSubmit={submit} className="space-y-6">
        <Section title="Alerts & windows">
          <Field label="Maturity lead times (months)" hint="Comma separated, e.g. 24, 12, 6, 3"><Input {...bind("maturity_lead_months")} /></Field>
          <Field label="Refinance window (months)"><Input {...bind("refi_window_months")} inputMode="numeric" /></Field>
          <Field label="Rate cap lead times (days)" hint="Comma separated, e.g. 90, 30"><Input {...bind("cap_lead_days")} /></Field>
          <Field label="Covenant watch buffer (%)" hint="Distance from threshold that triggers watch"><Input {...bind("covenant_watch_buffer_pct")} inputMode="decimal" /></Field>
          <Field label="Projection horizon (quarters)"><Input {...bind("projection_quarters")} inputMode="numeric" /></Field>
        </Section>
        <Section title="Market terms" description="Defaults for refinance sizing and hold / refinance / sell comparisons.">
          {MARKET_FIELDS.map((m) => (
            <Field key={m.key} label={m.label}>
              <Input {...bind(m.key)} inputMode="decimal" />
            </Field>
          ))}
        </Section>
      </form>
    </Sheet>
  );
}
