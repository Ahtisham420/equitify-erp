"use client";

import { format } from "date-fns";
import { Check, Info, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { cn, formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";
import { OrganizationPicker, PersonPicker } from "@/features/contacts/pickers";

import {
  CANDIDATE_STATUSES,
  EXCHANGE_STATUSES,
  EXCHANGE_TYPES,
  FINANCING_TYPES,
  IDENTIFICATION_RULE_LABELS,
  IDENTIFICATION_RULES,
  OFFER_STATUSES,
  RETRADE_DECISIONS,
  RETRADE_OUTCOMES,
  RETRADE_REASONS,
  stageLabel,
  useAddRetrade,
  useCreateDisposition,
  useDecideRetrade,
  useGates,
  useMoveDisposition,
  useRunComparison,
  useSaveCandidate,
  useSaveExchange,
  useSaveOffer,
  useUpdateDisposition,
  type CandidateInput,
  type Comparison,
  type CompareInput,
  type Disposition,
  type DispositionInput,
  type Exchange,
  type ExchangeCandidate,
  type ExchangeInput,
  type Offer,
  type OfferInput,
  type Retrade,
  type RetradeInput,
  type Stage,
} from "./api";

/* ------------------------------------------------------------------ helpers */

type FormState = Record<string, string>;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
const num = (v: string | undefined) => toNumber(v ?? "");
export const todayIso = () => format(new Date(), "yyyy-MM-dd");
const opts = (values: readonly string[], label: (v: string) => string = titleCase) => values.map((v) => ({ value: v, label: label(v) }));

function binder(form: FormState, setForm: Dispatch<SetStateAction<FormState>>) {
  return (key: string) => ({
    id: key,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
}

function pick(source: object | null | undefined, keys: readonly string[]): FormState {
  const out: FormState = {};
  const rec = (source ?? {}) as Record<string, unknown>;
  for (const k of keys) out[k] = str(rec[k]);
  return out;
}

function Section({ title, children, description }: { title: string; children: ReactNode; description?: ReactNode }) {
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

/** Caution banner for modeled tax figures. */
export function TaxCaution({ note, className }: { note?: string | null; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border border-caution/30 bg-caution-soft px-3 py-2.5 text-sm", className)}>
      <Info className="mt-0.5 size-4 shrink-0 text-caution" />
      <div>
        <p className="font-medium text-caution">Modeled estimates subject to professional review</p>
        {note && <p className="mt-0.5 text-xs text-ink-2">{note}</p>}
      </div>
    </div>
  );
}

export function comparisonOf(d: Pick<Disposition, "comparison">): Comparison | null {
  const c = d.comparison as Partial<Comparison> | null | undefined;
  return c && c.sell && c.hold ? (c as Comparison) : null;
}

/* ------------------------------------------------------------------ new disposition */

interface AssetLite {
  id: string;
  property_label: string;
  city: string | null;
  state: string | null;
  status: string;
}

export function NewDispositionSheet({
  open,
  onOpenChange,
  assetId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  assetId?: string | null;
  onCreated?: (d: Disposition) => void;
}) {
  const create = useCreateDisposition();
  const [asset, setAsset] = useState<string | null>(assetId ?? null);
  const [owner, setOwner] = useState<string | null>(null);
  const [is1031, setIs1031] = useState(false);
  const [form, setForm] = useState<FormState>({});
  const bind = binder(form, setForm);

  useEffect(() => {
    if (open) {
      setAsset(assetId ?? null);
      setOwner(null);
      setIs1031(false);
      setForm({});
    }
  }, [open, assetId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!asset) {
      toast.error("Choose the asset to dispose of");
      return;
    }
    create.mutate(
      { asset_id: asset, name: text(form.name), owner_id: owner, reason: text(form.reason), is_1031: is1031, target_price: num(form.target_price) },
      {
        onSuccess: (d) => {
          toast.success("Disposition created");
          onOpenChange(false);
          onCreated?.(d);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New disposition"
      description="Starts in the candidate stage. Compare hold, sell and refinance before pricing."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-disposition-form" loading={create.isPending}>
            Create disposition
          </Button>
        </>
      }
    >
      <form id="new-disposition-form" onSubmit={submit} className="space-y-4">
        <Field label="Asset" required>
          <EntityPicker<AssetLite>
            endpoint="/assets"
            value={asset}
            onChange={(id) => setAsset(id)}
            placeholder="Select owned asset"
            toOption={(a) => ({ id: a.id, label: a.property_label || "Asset", sublabel: [a.city, a.state, a.status ? titleCase(a.status) : null].filter(Boolean).join(" · ") || undefined })}
          />
        </Field>
        <Field label="Name" hint="Defaults to the property name.">
          <Input {...bind("name")} />
        </Field>
        <Field label="Owner">
          <UserPicker value={owner} onChange={setOwner} placeholder="Defaults to you" />
        </Field>
        <Field label="Reason for disposition">
          <Textarea {...bind("reason")} placeholder="e.g. Hold period reached, lease rollover risk, debt maturity" />
        </Field>
        <Field label="Target price ($)">
          <Input {...bind("target_price")} inputMode="decimal" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={is1031} onChange={setIs1031} />
          Planned as a 1031 exchange
        </label>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ edit disposition */

const D_TEXT = [
  "name", "reason", "pricing_notes", "broker_name", "marketing_launched_on", "offers_due_on", "buyer_name",
  "contract_executed_on", "dd_expires_on", "target_closing_on", "closed_on", "notes",
] as const;
const D_NUM = ["target_price", "list_price", "commission_pct", "contract_price", "sale_price"] as const;
const TAX_KEYS = ["tax_basis", "accumulated_depreciation", "cap_gains_rate", "recapture_rate", "state_rate", "niit_rate"] as const;
const TAX_DEFAULTS: Record<string, number> = { cap_gains_rate: 20, recapture_rate: 25, state_rate: 0, niit_rate: 3.8 };

export function DispositionEditSheet({ open, onOpenChange, disposition: d }: { open: boolean; onOpenChange: (o: boolean) => void; disposition: Disposition }) {
  const save = useUpdateDisposition(d.id);
  const [form, setForm] = useState<FormState>({});
  const [tax, setTax] = useState<FormState>({});
  const [ids, setIds] = useState<Record<string, string | null>>({});
  const [is1031, setIs1031] = useState(false);
  const [lines, setLines] = useState<{ label: string; amount: string }[]>([]);
  const bind = binder(form, setForm);
  const bindTax = binder(tax, setTax);
  const closed = d.stage === "closed";

  useEffect(() => {
    if (!open) return;
    setForm(pick(d, [...D_TEXT, ...D_NUM]));
    const t = pick(d.tax_inputs, TAX_KEYS);
    for (const [k, v] of Object.entries(TAX_DEFAULTS)) if (!t[k]) t[k] = String(v);
    setTax(t);
    setIds({ owner_id: d.owner_id, broker_organization_id: d.broker_organization_id, buyer_organization_id: d.buyer_organization_id });
    setIs1031(d.is_1031);
    setLines((d.cost_lines ?? []).map((c) => ({ label: c.label, amount: str(c.amount) })));
  }, [open, d]);

  const setId = (k: string) => (v: string | null) => setIds((s) => ({ ...s, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (lines.some((l) => !l.label.trim() && l.amount.trim())) {
      toast.error("Every selling cost line needs a label");
      return;
    }
    const tax_inputs = {
      tax_basis: num(tax.tax_basis),
      accumulated_depreciation: num(tax.accumulated_depreciation),
      cap_gains_rate: num(tax.cap_gains_rate) ?? TAX_DEFAULTS.cap_gains_rate,
      recapture_rate: num(tax.recapture_rate) ?? TAX_DEFAULTS.recapture_rate,
      state_rate: num(tax.state_rate) ?? TAX_DEFAULTS.state_rate,
      niit_rate: num(tax.niit_rate) ?? TAX_DEFAULTS.niit_rate,
    };
    const cost_lines = lines.filter((l) => l.label.trim()).map((l) => ({ label: l.label.trim(), amount: num(l.amount) ?? 0 }));
    const data: Record<string, unknown> = { notes: text(form.notes), cost_lines, tax_inputs };
    if (!closed) {
      for (const k of D_TEXT) if (k !== "notes") data[k] = text(form[k]);
      for (const k of D_NUM) data[k] = num(form[k]);
      if (!data.name) delete data.name;
      Object.assign(data, ids, { is_1031: is1031 });
    }
    save.mutate(data as DispositionInput, {
      onSuccess: () => {
        toast.success("Disposition updated");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Edit disposition"
      description={d.name}
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="disposition-edit-form" loading={save.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="disposition-edit-form" onSubmit={submit} className="space-y-6">
        {closed ? (
          <p className="rounded-md border border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
            This disposition is closed. Only selling costs, tax inputs and notes can change.
          </p>
        ) : (
          <>
            <Section title="General">
              <Field label="Name" className="col-span-2"><Input {...bind("name")} /></Field>
              <Field label="Owner"><UserPicker value={ids.owner_id} onChange={setId("owner_id")} /></Field>
              <div className="flex items-end pb-1.5">
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <Checkbox checked={is1031} onChange={setIs1031} />
                  1031 exchange planned
                </label>
              </div>
              <Field label="Reason" className="col-span-2"><Textarea {...bind("reason")} rows={2} /></Field>
            </Section>
            <Section title="Pricing">
              <Field label="Target price ($)"><Input {...bind("target_price")} inputMode="decimal" /></Field>
              <Field label="List price ($)"><Input {...bind("list_price")} inputMode="decimal" /></Field>
              <Field label="Pricing notes" className="col-span-2"><Textarea {...bind("pricing_notes")} rows={2} /></Field>
            </Section>
            <Section title="Marketing">
              <Field label="Broker organization"><OrganizationPicker value={ids.broker_organization_id} onChange={setId("broker_organization_id")} /></Field>
              <Field label="Broker name"><Input {...bind("broker_name")} /></Field>
              <Field label="Commission (%)"><Input {...bind("commission_pct")} inputMode="decimal" /></Field>
              <Field label="Marketing launched"><Input type="date" {...bind("marketing_launched_on")} /></Field>
              <Field label="Offers due"><Input type="date" {...bind("offers_due_on")} /></Field>
            </Section>
            <Section title="Contract & closing">
              <Field label="Buyer name"><Input {...bind("buyer_name")} /></Field>
              <Field label="Buyer organization"><OrganizationPicker value={ids.buyer_organization_id} onChange={setId("buyer_organization_id")} /></Field>
              <Field label="Contract price ($)" hint="Agreed retrades reduce this automatically."><Input {...bind("contract_price")} inputMode="decimal" /></Field>
              <Field label="Contract executed"><Input type="date" {...bind("contract_executed_on")} /></Field>
              <Field label="Buyer DD expires"><Input type="date" {...bind("dd_expires_on")} /></Field>
              <Field label="Target closing"><Input type="date" {...bind("target_closing_on")} /></Field>
              <Field label="Closed on"><Input type="date" {...bind("closed_on")} /></Field>
              <Field label="Final sale price ($)"><Input {...bind("sale_price")} inputMode="decimal" /></Field>
            </Section>
          </>
        )}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Selling costs</h4>
              <p className="mt-0.5 text-xs text-ink-3">Brokerage commission is added from the commission percentage.</p>
            </div>
            <Button size="xs" onClick={() => setLines((l) => [...l, { label: "", amount: "" }])}>
              <Plus /> Add line
            </Button>
          </div>
          {lines.length === 0 && <p className="text-xs text-ink-3">No cost lines. Add title, transfer tax, legal and other closing costs.</p>}
          {lines.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="flex-1"
                placeholder="Label, e.g. Transfer tax"
                value={l.label}
                onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <Input
                className="w-36 text-right"
                inputMode="decimal"
                placeholder="Amount"
                value={l.amount}
                onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
              <Button size="icon-sm" variant="ghost" aria-label="Remove line" onClick={() => setLines((all) => all.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </section>

        <Section title="Tax inputs" description="Modeled estimates subject to professional review.">
          <Field label="Tax basis ($)" hint="Blank uses asset basis plus capitalized capex."><Input {...bindTax("tax_basis")} inputMode="decimal" /></Field>
          <Field label="Accumulated depreciation ($)"><Input {...bindTax("accumulated_depreciation")} inputMode="decimal" /></Field>
          <Field label="Capital gains rate (%)"><Input {...bindTax("cap_gains_rate")} inputMode="decimal" /></Field>
          <Field label="Recapture rate (%)"><Input {...bindTax("recapture_rate")} inputMode="decimal" /></Field>
          <Field label="State rate (%)"><Input {...bindTax("state_rate")} inputMode="decimal" /></Field>
          <Field label="NIIT rate (%)"><Input {...bindTax("niit_rate")} inputMode="decimal" /></Field>
        </Section>

        <Section title="Notes">
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ move stage */

export function MoveDispositionDialog({
  open,
  onOpenChange,
  disposition,
  toStage,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  disposition: { id: string; name: string; stage: Stage };
  toStage: Stage | null;
}) {
  const gates = useGates(disposition.id);
  const move = useMoveDisposition(disposition.id);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setOverride(false);
    }
  }, [open, toStage]);

  const withdrawing = toStage === "withdrawn";
  const target = gates.data?.stages.find((s) => s.stage === toStage);
  const requirements = withdrawing ? [] : target?.requirements ?? [];
  const unmet = requirements.filter((r) => r.blocking && !r.met);
  const canOverride = gates.data?.can_override ?? false;
  const needsReason = withdrawing || unmet.length > 0;
  const movable = withdrawing ? disposition.stage !== "closed" && disposition.stage !== "withdrawn" : !!target;
  const disabled = !toStage || !movable || (unmet.length > 0 && (!canOverride || !override)) || (needsReason && reason.trim().length < 3);

  const submit = () => {
    if (!toStage) return;
    move.mutate(
      { to_stage: toStage, reason: text(reason), override: unmet.length > 0 && override },
      {
        onSuccess: () => {
          toast.success(`Moved to ${stageLabel(toStage)}${unmet.length ? " (override recorded)" : ""}`);
          onOpenChange(false);
        },
        onError: (e) => {
          toast.error(errorMessage(e));
          gates.refetch();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-xl"
      title={withdrawing ? "Withdraw disposition" : `Move to ${toStage ? stageLabel(toStage) : ""}`}
      description={`${disposition.name} · currently ${stageLabel(disposition.stage).toLowerCase()}`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={withdrawing || unmet.length ? "danger" : "primary"} loading={move.isPending} disabled={disabled} onClick={submit}>
            {withdrawing ? "Withdraw" : unmet.length ? "Override and move" : `Move to ${toStage ? stageLabel(toStage) : ""}`}
          </Button>
        </>
      }
    >
      {gates.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : !movable ? (
        <p className="text-sm text-ink-2">This disposition cannot move to {toStage ? stageLabel(toStage).toLowerCase() : "that stage"}.</p>
      ) : (
        <div className="space-y-4">
          {!withdrawing && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Entry requirements</p>
              <ul className="space-y-1.5">
                {requirements.map((r) => (
                  <li key={r.key} className="flex items-start gap-2 text-sm">
                    {!r.blocking ? (
                      <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
                    ) : r.met ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-positive" />
                    ) : (
                      <X className="mt-0.5 size-4 shrink-0 text-negative" />
                    )}
                    <div className="min-w-0">
                      <p className={cn("text-ink", r.blocking && !r.met && "text-negative")}>
                        {r.label}
                        {!r.blocking && <span className="ml-1 text-xs text-ink-3">(informational)</span>}
                      </p>
                      {r.detail && <p className="text-xs text-ink-3">{r.detail}</p>}
                    </div>
                  </li>
                ))}
                {requirements.length === 0 && <li className="text-sm text-ink-3">No requirements for this stage.</li>}
              </ul>
            </div>
          )}

          {withdrawing && (
            <p className="text-sm text-ink-2">
              The asset returns to active status and any accepted offer is recorded as fallen through. The record and its offers are retained.
            </p>
          )}

          {unmet.length > 0 && (
            <div className="space-y-2 rounded-md border border-negative/30 bg-negative-soft px-3 py-3">
              <p className="text-sm font-medium text-negative">
                {unmet.length} requirement{unmet.length === 1 ? "" : "s"} not met
              </p>
              {canOverride ? (
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <Checkbox checked={override} onChange={setOverride} />
                  Override the unmet requirements (audited with your name and reason)
                </label>
              ) : (
                <p className="text-xs text-ink-2">Complete the requirements first. Overriding needs disposition approval permission.</p>
              )}
            </div>
          )}

          <Field label="Reason" required={needsReason} hint={needsReason ? "Required — recorded in the stage history." : "Optional — recorded in the stage history."}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ compare */

type CompareKey = keyof CompareInput;
const COMPARE_GROUPS: { title: string; description?: string; fields: { key: CompareKey; label: string; placeholder?: string }[] }[] = [
  {
    title: "Value & income",
    fields: [
      { key: "value", label: "Current value ($)", placeholder: "Asset value" },
      { key: "noi", label: "NOI ($)", placeholder: "Trailing 12 months" },
      { key: "noi_growth_pct", label: "NOI growth (%)", placeholder: "2" },
      { key: "hold_years", label: "Hold years", placeholder: "5" },
      { key: "exit_cap_rate", label: "Exit cap rate (%)", placeholder: "Asset or market + 0.25" },
      { key: "discount_rate", label: "Discount rate (%)", placeholder: "8" },
      { key: "sale_cost_pct", label: "Sale costs (%)", placeholder: "Market default" },
      { key: "capex_planned", label: "Planned capex ($)", placeholder: "0" },
      { key: "remaining_lease_term_years", label: "Remaining lease term (yrs)", placeholder: "WALE" },
    ],
  },
  {
    title: "Tax",
    description: "Modeled estimates subject to professional review.",
    fields: [
      { key: "tax_basis", label: "Tax basis ($)", placeholder: "Basis + capex" },
      { key: "accumulated_depreciation", label: "Accumulated depreciation ($)", placeholder: "Estimated" },
      { key: "land_pct", label: "Land (%)", placeholder: "20" },
      { key: "depreciation_years", label: "Depreciation years", placeholder: "39" },
      { key: "cap_gains_rate", label: "Capital gains (%)", placeholder: "20" },
      { key: "recapture_rate", label: "Recapture (%)", placeholder: "25" },
      { key: "state_rate", label: "State (%)", placeholder: "0" },
      { key: "niit_rate", label: "NIIT (%)", placeholder: "3.8" },
    ],
  },
  {
    title: "Refinance & market",
    fields: [
      { key: "refi_rate", label: "Refi rate (%)", placeholder: "Market" },
      { key: "refi_ltv", label: "Refi LTV (%)", placeholder: "Market" },
      { key: "refi_dscr", label: "Refi DSCR (x)", placeholder: "Market" },
      { key: "refi_debt_yield", label: "Refi debt yield (%)", placeholder: "Market" },
      { key: "refi_amort_years", label: "Refi amortization (yrs)", placeholder: "Market" },
      { key: "refi_cost_pct", label: "Refi costs (%)", placeholder: "Market" },
      { key: "treasury_rate", label: "Treasury rate (%)", placeholder: "Market" },
    ],
  },
];
const COMPARE_KEYS = COMPARE_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

export function CompareSheet({ open, onOpenChange, disposition: d }: { open: boolean; onOpenChange: (o: boolean) => void; disposition: Disposition }) {
  const run = useRunComparison(d.id);
  const [form, setForm] = useState<FormState>({});
  const bind = binder(form, setForm);

  useEffect(() => {
    if (!open) return;
    const c = comparisonOf(d);
    if (c) {
      const f = pick(c.inputs, COMPARE_KEYS);
      if (c.inputs.accumulated_depreciation_estimated) f.accumulated_depreciation = "";
      setForm(f);
    } else {
      setForm(pick(d.tax_inputs, ["tax_basis", "accumulated_depreciation", "cap_gains_rate", "recapture_rate", "state_rate", "niit_rate"]));
    }
  }, [open, d]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, number> = {};
    for (const k of COMPARE_KEYS) {
      const n = num(form[k]);
      if (n !== null) body[k] = k === "hold_years" ? Math.max(1, Math.round(n)) : n;
    }
    run.mutate(body as CompareInput, {
      onSuccess: () => {
        toast.success("Comparison updated");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Hold / sell / refinance comparison"
      description="Blank fields use the asset's current figures and market defaults."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => setForm({})}>Clear to defaults</Button>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="compare-form" loading={run.isPending}>
            Run comparison
          </Button>
        </>
      }
    >
      <form id="compare-form" onSubmit={submit} className="space-y-6">
        {COMPARE_GROUPS.map((g) => (
          <Section key={g.title} title={g.title} description={g.description}>
            {g.fields.map((f) => (
              <Field key={f.key} label={f.label}>
                <Input {...bind(f.key)} inputMode="decimal" placeholder={f.placeholder} />
              </Field>
            ))}
          </Section>
        ))}
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ offers */

const O_TEXT = ["buyer_name", "broker_name", "financing_type", "contingencies", "received_on", "expires_on", "status", "notes"] as const;
const O_NUM = ["price", "earnest_money", "dd_days", "closing_days"] as const;

export function OfferSheet({
  open,
  onOpenChange,
  dispositionId,
  offer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dispositionId: string;
  offer?: Offer | null;
}) {
  const save = useSaveOffer(dispositionId);
  const [form, setForm] = useState<FormState>({});
  const [org, setOrg] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const bind = binder(form, setForm);
  const accepted = offer?.status === "accepted";
  const statuses = accepted ? ["withdrawn"] : OFFER_STATUSES.filter((s) => s !== "accepted");

  useEffect(() => {
    if (!open) return;
    const f = pick(offer, [...O_TEXT, ...O_NUM]);
    if (!offer) Object.assign(f, { financing_type: "cash", status: "received", received_on: todayIso() });
    if (accepted) f.status = "withdrawn";
    setForm(f);
    setOrg(offer?.buyer_organization_id ?? null);
    setPerson(offer?.buyer_person_id ?? null);
  }, [open, offer, accepted]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const price = num(form.price);
    if (!text(form.buyer_name) || !price || !form.received_on) {
      toast.error("Buyer, price and received date are required");
      return;
    }
    const data: OfferInput = {
      buyer_name: text(form.buyer_name) ?? "",
      buyer_organization_id: org,
      buyer_person_id: person,
      broker_name: text(form.broker_name),
      price,
      earnest_money: num(form.earnest_money),
      dd_days: num(form.dd_days),
      closing_days: num(form.closing_days),
      financing_type: form.financing_type || "cash",
      contingencies: text(form.contingencies),
      received_on: form.received_on,
      expires_on: text(form.expires_on),
      status: form.status || "received",
      notes: text(form.notes),
    };
    save.mutate(
      { id: offer?.id, data },
      {
        onSuccess: () => {
          toast.success(offer ? "Offer updated" : "Offer recorded");
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
      title={offer ? "Edit offer" : "Record offer"}
      description={accepted ? "The accepted offer can only be withdrawn. Record price changes as a retrade." : "Every offer is retained for counterparty intelligence."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="offer-form" loading={save.isPending}>
            {offer ? "Save offer" : "Record offer"}
          </Button>
        </>
      }
    >
      <form id="offer-form" onSubmit={submit} className="space-y-6">
        <Section title="Buyer">
          <Field label="Buyer name" required className="col-span-2"><Input {...bind("buyer_name")} required /></Field>
          <Field label="Buyer organization"><OrganizationPicker value={org} onChange={setOrg} /></Field>
          <Field label="Buyer contact"><PersonPicker value={person} onChange={setPerson} /></Field>
          <Field label="Buyer broker" className="col-span-2"><Input {...bind("broker_name")} /></Field>
        </Section>
        <Section title="Terms">
          <Field label="Price ($)" required><Input {...bind("price")} inputMode="decimal" required /></Field>
          <Field label="Earnest money ($)"><Input {...bind("earnest_money")} inputMode="decimal" /></Field>
          <Field label="Due diligence (days)"><Input {...bind("dd_days")} inputMode="numeric" /></Field>
          <Field label="Closing (days)"><Input {...bind("closing_days")} inputMode="numeric" /></Field>
          <Field label="Financing"><Select {...bind("financing_type")} options={opts(FINANCING_TYPES)} /></Field>
          <Field label="Status" hint={accepted ? undefined : "Accept from the offers table (approval permission)."}>
            <Select {...bind("status")} options={opts(statuses)} />
          </Field>
          <Field label="Received on" required><Input type="date" {...bind("received_on")} required /></Field>
          <Field label="Expires on"><Input type="date" {...bind("expires_on")} /></Field>
          <Field label="Contingencies" className="col-span-2"><Textarea {...bind("contingencies")} rows={2} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} rows={2} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ retrades */

export function RetradeSheet({
  open,
  onOpenChange,
  dispositionId,
  offers,
  acceptedOfferId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dispositionId: string;
  offers: Offer[];
  acceptedOfferId: string | null;
}) {
  const add = useAddRetrade(dispositionId);
  const [form, setForm] = useState<FormState>({});
  const bind = binder(form, setForm);

  useEffect(() => {
    if (open) setForm({ offer_id: acceptedOfferId ?? "", requested_on: todayIso(), reason_category: "inspection" });
  }, [open, acceptedOfferId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const amount = num(form.amount_requested);
    if (amount === null || (form.reason ?? "").trim().length < 3) {
      toast.error("Amount requested and a reason are required");
      return;
    }
    const data: RetradeInput = {
      offer_id: form.offer_id || null,
      buyer_name: form.offer_id ? null : text(form.buyer_name),
      requested_on: form.requested_on || todayIso(),
      reason_category: form.reason_category || "other",
      reason: form.reason.trim(),
      amount_requested: amount,
      notes: text(form.notes),
    };
    add.mutate(data, {
      onSuccess: () => {
        toast.success("Retrade request recorded");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New retrade request"
      description="A buyer request to reduce price or change terms. Retained for counterparty intelligence."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="retrade-form" loading={add.isPending}>
            Record retrade
          </Button>
        </>
      }
    >
      <form id="retrade-form" onSubmit={submit} className="space-y-6">
        <Section title="Request">
          <Field label="Offer" className="col-span-2">
            <Select
              {...bind("offer_id")}
              placeholder="No linked offer"
              options={offers.map((o) => ({ value: o.id, label: `${o.buyer_name} · ${formatCurrency(o.price)} · ${titleCase(o.status)}` }))}
            />
          </Field>
          {!form.offer_id && (
            <Field label="Buyer name" className="col-span-2" hint="Defaults to the contract buyer.">
              <Input {...bind("buyer_name")} />
            </Field>
          )}
          <Field label="Requested on" required><Input type="date" {...bind("requested_on")} required /></Field>
          <Field label="Amount requested ($)" required><Input {...bind("amount_requested")} inputMode="decimal" required /></Field>
          <Field label="Reason category" className="col-span-2"><Select {...bind("reason_category")} options={opts(RETRADE_REASONS)} /></Field>
          <Field label="Reason" required className="col-span-2"><Textarea {...bind("reason")} rows={3} required /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} rows={2} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

export function RetradeDecisionDialog({
  open,
  onOpenChange,
  dispositionId,
  retrade,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dispositionId: string;
  retrade: Retrade | null;
}) {
  const decide = useDecideRetrade(dispositionId);
  const [form, setForm] = useState<FormState>({});
  const bind = binder(form, setForm);

  useEffect(() => {
    if (open && retrade) setForm(pick(retrade, ["decision", "agreed_amount", "outcome", "notes"]));
  }, [open, retrade]);

  const submit = () => {
    if (!retrade) return;
    decide.mutate(
      { id: retrade.id, data: { decision: form.decision, agreed_amount: num(form.agreed_amount), outcome: form.outcome, notes: text(form.notes) } },
      {
        onSuccess: () => {
          toast.success("Retrade decision saved");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Retrade decision"
      description={retrade ? `${retrade.buyer_name} requested ${formatCurrency(retrade.amount_requested)} on ${formatDate(retrade.requested_on)}` : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={decide.isPending} disabled={!retrade} onClick={submit}>
            Save decision
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Decision"><Select {...bind("decision")} options={opts(RETRADE_DECISIONS)} /></Field>
        <Field label="Agreed reduction ($)"><Input {...bind("agreed_amount")} inputMode="decimal" placeholder={retrade ? String(retrade.amount_requested) : undefined} /></Field>
        <Field label="Outcome" className="col-span-2"><Select {...bind("outcome")} options={opts(RETRADE_OUTCOMES)} /></Field>
        <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} rows={3} /></Field>
        <p className="col-span-2 text-xs text-ink-3">
          Accepting or countering with an agreed amount reduces the contract price once. Accepting without an amount agrees to the full request.
        </p>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ 1031 exchange */

const X_TEXT = ["exchange_type", "status", "qi_name", "start_on", "tax_return_due_on", "identification_rule", "improvement_notes", "notes"] as const;
const X_NUM = [
  "relinquished_sale_price", "relinquished_costs", "relinquished_debt_paid", "relinquished_adjusted_basis", "cash_received",
  "additional_cash_invested", "improvement_budget",
] as const;

export function ExchangeSheet({
  open,
  onOpenChange,
  dispositionId,
  exchange,
  defaults,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dispositionId: string;
  exchange?: Exchange | null;
  defaults?: ExchangeInput;
}) {
  const save = useSaveExchange(dispositionId);
  const [form, setForm] = useState<FormState>({});
  const [ids, setIds] = useState<Record<string, string | null>>({});
  const bind = binder(form, setForm);
  const type = form.exchange_type || "forward";
  const parked = type !== "forward";

  useEffect(() => {
    if (!open) return;
    const src = exchange ?? { exchange_type: "forward", identification_rule: "three_property", ...defaults };
    setForm(pick(src, [...X_TEXT, ...X_NUM]));
    setIds({
      qi_organization_id: exchange?.qi_organization_id ?? null,
      eat_organization_id: exchange?.eat_organization_id ?? null,
      parked_property_id: exchange?.parked_property_id ?? null,
    });
  }, [open, exchange, defaults]);

  const setId = (k: string) => (v: string | null) => setIds((s) => ({ ...s, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = {};
    for (const k of X_TEXT) data[k] = text(form[k]);
    for (const k of X_NUM) data[k] = num(form[k]);
    data.exchange_type = type;
    data.identification_rule = form.identification_rule || "three_property";
    if (!data.status) delete data.status;
    data.qi_organization_id = ids.qi_organization_id ?? null;
    data.eat_organization_id = parked ? ids.eat_organization_id ?? null : null;
    data.parked_property_id = parked ? ids.parked_property_id ?? null : null;
    if (type !== "improvement") {
      data.improvement_budget = null;
      data.improvement_notes = null;
    }
    save.mutate(data as ExchangeInput, {
      onSuccess: () => {
        toast.success(exchange ? "Exchange updated" : "1031 exchange set up");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={exchange ? "Edit 1031 exchange" : "Set up 1031 exchange"}
      description="Statutory deadlines cannot be extended. Proceeds must go to the qualified intermediary."
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="exchange-form" loading={save.isPending}>
            {exchange ? "Save exchange" : "Set up exchange"}
          </Button>
        </>
      }
    >
      <form id="exchange-form" onSubmit={submit} className="space-y-6">
        <Section title="Structure">
          <Field label="Exchange type"><Select {...bind("exchange_type")} options={opts(EXCHANGE_TYPES)} /></Field>
          <Field label="Status"><Select {...bind("status")} placeholder={exchange ? undefined : "Set automatically"} options={opts(EXCHANGE_STATUSES)} /></Field>
          <Field label="Qualified intermediary"><OrganizationPicker value={ids.qi_organization_id} onChange={setId("qi_organization_id")} /></Field>
          <Field label="QI contact name"><Input {...bind("qi_name")} /></Field>
          {parked && (
            <>
              <Field label="Exchange accommodation titleholder"><OrganizationPicker value={ids.eat_organization_id} onChange={setId("eat_organization_id")} /></Field>
              <Field label="Parked property"><PropertyPicker value={ids.parked_property_id} onChange={(id) => setId("parked_property_id")(id)} /></Field>
            </>
          )}
        </Section>
        <Section title="Timeline">
          <Field
            label={parked ? "Parking date" : "Relinquished closing date"}
            className="col-span-2"
            hint="The 45-day identification and 180-day replacement deadlines are computed from this date and become blocking critical dates."
          >
            <Input type="date" {...bind("start_on")} />
          </Field>
          <Field label="Tax return due date" hint="The replacement deadline is the earlier of 180 days or this date."><Input type="date" {...bind("tax_return_due_on")} /></Field>
          <Field label="Identification rule"><Select {...bind("identification_rule")} options={opts(IDENTIFICATION_RULES, (v) => IDENTIFICATION_RULE_LABELS[v] ?? titleCase(v))} /></Field>
        </Section>
        <Section title="Relinquished property" description="Used for the boot analysis and basis carryover.">
          <Field label="Sale price ($)"><Input {...bind("relinquished_sale_price")} inputMode="decimal" /></Field>
          <Field label="Selling costs ($)"><Input {...bind("relinquished_costs")} inputMode="decimal" /></Field>
          <Field label="Debt paid off ($)"><Input {...bind("relinquished_debt_paid")} inputMode="decimal" /></Field>
          <Field label="Adjusted basis ($)"><Input {...bind("relinquished_adjusted_basis")} inputMode="decimal" /></Field>
          <Field label="Cash received by seller ($)"><Input {...bind("cash_received")} inputMode="decimal" /></Field>
          <Field label="Additional cash invested ($)"><Input {...bind("additional_cash_invested")} inputMode="decimal" /></Field>
        </Section>
        {type === "improvement" && (
          <Section title="Improvements">
            <Field label="Improvement budget ($)"><Input {...bind("improvement_budget")} inputMode="decimal" /></Field>
            <Field label="Improvement notes" className="col-span-2"><Textarea {...bind("improvement_notes")} rows={2} /></Field>
          </Section>
        )}
        <Section title="Notes">
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}

const C_TEXT = ["description", "status", "acquired_on", "notes"] as const;
const C_NUM = ["rank", "expected_price", "expected_debt", "acquired_price", "acquired_debt"] as const;

export function CandidateSheet({
  open,
  onOpenChange,
  dispositionId,
  candidate,
  defaultRank = 1,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dispositionId: string;
  candidate?: ExchangeCandidate | null;
  defaultRank?: number;
}) {
  const save = useSaveCandidate(dispositionId);
  const [form, setForm] = useState<FormState>({});
  const [property, setProperty] = useState<string | null>(null);
  const [backup, setBackup] = useState(false);
  const bind = binder(form, setForm);

  useEffect(() => {
    if (!open) return;
    const f = pick(candidate, [...C_TEXT, ...C_NUM]);
    if (!candidate) Object.assign(f, { status: "candidate", rank: String(defaultRank) });
    setForm(f);
    setProperty(candidate?.property_id ?? null);
    setBackup(candidate?.is_backup ?? false);
  }, [open, candidate, defaultRank]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!property && !text(form.description)) {
      toast.error("Link a property or describe the replacement property");
      return;
    }
    const data: CandidateInput = {
      property_id: property,
      description: text(form.description),
      is_backup: backup,
      rank: Math.max(1, Math.round(num(form.rank) ?? 1)),
      status: form.status || "candidate",
      expected_price: num(form.expected_price),
      expected_debt: num(form.expected_debt),
      acquired_on: text(form.acquired_on),
      acquired_price: num(form.acquired_price),
      acquired_debt: num(form.acquired_debt),
      notes: text(form.notes),
    };
    save.mutate(
      { id: candidate?.id, data },
      {
        onSuccess: () => {
          toast.success(candidate ? "Candidate updated" : "Replacement candidate added");
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
      title={candidate ? "Edit replacement candidate" : "Add replacement candidate"}
      description="Identification is only allowed within the 45-day window and must respect the identification rule."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="candidate-form" loading={save.isPending}>
            {candidate ? "Save candidate" : "Add candidate"}
          </Button>
        </>
      }
    >
      <form id="candidate-form" onSubmit={submit} className="space-y-6">
        <Section title="Property">
          <Field label="Linked property" className="col-span-2"><PropertyPicker value={property} onChange={(id) => setProperty(id)} /></Field>
          <Field label="Description" className="col-span-2" hint="Required when no property record exists — use an unambiguous legal description or address.">
            <Input {...bind("description")} maxLength={300} />
          </Field>
          <Field label="Rank"><Input {...bind("rank")} inputMode="numeric" /></Field>
          <Field label="Status"><Select {...bind("status")} options={opts(CANDIDATE_STATUSES)} /></Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={backup} onChange={setBackup} />
            Backup identification
          </label>
        </Section>
        <Section title="Expected">
          <Field label="Expected price ($)"><Input {...bind("expected_price")} inputMode="decimal" /></Field>
          <Field label="Expected debt ($)"><Input {...bind("expected_debt")} inputMode="decimal" /></Field>
        </Section>
        <Section title="Acquired">
          <Field label="Acquired on"><Input type="date" {...bind("acquired_on")} /></Field>
          <Field label="Acquired price ($)"><Input {...bind("acquired_price")} inputMode="decimal" /></Field>
          <Field label="Acquired debt ($)"><Input {...bind("acquired_debt")} inputMode="decimal" /></Field>
        </Section>
        <Section title="Notes">
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} rows={2} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}
