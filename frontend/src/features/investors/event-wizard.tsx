"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Calculator } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { cn, formatCurrency, toNumber } from "@/lib/utils";

import { CalcView } from "./allocation-table";
import { useAssetOptions, useCreateEvent, useWaterfalls, type Calc, type EventPreviewInput } from "./api";

const today = () => new Date().toISOString().slice(0, 10);

interface FormState {
  event_type: string;
  asset_id: string;
  amount: string;
  event_date: string;
  due_on: string;
  waterfall_id: string;
  gross_proceeds: string;
  debt_payoff: string;
  closing_costs: string;
  reserves: string;
  default_rate: string;
  grace_days: string;
  penalty_pct: string;
  purpose: string;
  wire_instructions: string;
  name: string;
  notes: string;
}

const EMPTY: FormState = {
  event_type: "distribution", asset_id: "", amount: "", event_date: today(), due_on: "", waterfall_id: "",
  gross_proceeds: "", debt_payoff: "", closing_costs: "", reserves: "", default_rate: "8", grace_days: "10",
  penalty_pct: "", purpose: "", wire_instructions: "", name: "", notes: "",
};

const TYPES = [
  { value: "call", label: "Capital call", hint: "Pro rata to commitment; notices are generated when posted." },
  { value: "distribution", label: "Distribution", hint: "Runs the stored waterfall against current capital accounts." },
  { value: "liquidation", label: "Liquidation", hint: "Net sale proceeds through the waterfall; investments exit when posted." },
];

/** Create-event wizard: parameters → waterfall preview per partner → save (and route for approval). */
export function EventWizard({ open, onOpenChange, onCreated, defaultAssetId }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void; defaultAssetId?: string }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [step, setStep] = useState<1 | 2>(1);
  const [calc, setCalc] = useState<{ amount: number; calc: Calc } | null>(null);
  const assets = useAssetOptions(open);
  const waterfalls = useWaterfalls(open);
  const create = useCreateEvent();
  const submit = useMutation({ mutationFn: (id: string) => api.post(`/investors/capital-events/${id}/submit`) });

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY, asset_id: defaultAssetId ?? "" });
      setStep(1);
      setCalc(null);
    }
  }, [open, defaultAssetId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const body = (): EventPreviewInput => ({
    event_type: form.event_type,
    asset_id: form.asset_id,
    amount: toNumber(form.amount),
    event_date: form.event_date,
    due_on: form.event_type === "call" ? form.due_on || null : null,
    waterfall_id: form.waterfall_id || null,
    inputs: {
      gross_proceeds: form.event_type === "liquidation" ? toNumber(form.gross_proceeds) : null,
      debt_payoff: form.event_type === "liquidation" ? toNumber(form.debt_payoff) : null,
      closing_costs: form.event_type === "liquidation" ? toNumber(form.closing_costs) : null,
      reserves: form.event_type === "liquidation" ? toNumber(form.reserves) : null,
      default_rate: form.event_type === "call" ? toNumber(form.default_rate) : null,
      grace_days: form.event_type === "call" ? toNumber(form.grace_days) : null,
      penalty_pct: form.event_type === "call" ? toNumber(form.penalty_pct) : null,
      purpose: form.purpose.trim() || null,
      wire_instructions: form.event_type === "call" ? form.wire_instructions.trim() || null : null,
    },
    name: form.name.trim() || null,
    notes: form.notes.trim() || null,
  });

  const preview = useMutation({
    mutationFn: () => api.post<{ amount: number; calc: Calc }>("/investors/capital-events/preview", body()),
    onSuccess: (r) => {
      setCalc(r);
      setStep(2);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const save = (andSubmit: boolean) =>
    create.mutate(body(), {
      onSuccess: async (ev) => {
        if (andSubmit) {
          try {
            await submit.mutateAsync(ev.id);
            toast.success("Capital event submitted for approval");
          } catch (e) {
            toast.error(errorMessage(e));
          }
        } else toast.success("Draft capital event saved");
        onOpenChange(false);
        onCreated?.(ev.id);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const net =
    form.event_type === "liquidation" && toNumber(form.gross_proceeds) !== null
      ? (toNumber(form.gross_proceeds) ?? 0) - (toNumber(form.debt_payoff) ?? 0) - (toNumber(form.closing_costs) ?? 0) - (toNumber(form.reserves) ?? 0)
      : null;
  const canPreview = !!form.asset_id && !!form.event_date && (net !== null ? net > 0 : (toNumber(form.amount) ?? 0) > 0);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-4xl"
      title="New capital event"
      description={step === 1 ? "Step 1 of 2 — event parameters" : "Step 2 of 2 — review the allocation before saving"}
      footer={
        step === 1 ? (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" disabled={!canPreview} loading={preview.isPending} onClick={() => preview.mutate()}>
              <Calculator />
              Preview allocation
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep(1)}>
              <ArrowLeft />
              Back
            </Button>
            <Button loading={create.isPending && !submit.isPending} onClick={() => save(false)}>
              Save draft
            </Button>
            <Button variant="primary" loading={submit.isPending} onClick={() => save(true)}>
              Save and submit for approval
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => set("event_type", t.value)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  form.event_type === t.value ? "border-accent/50 bg-accent-soft" : "border-line hover:bg-subtle",
                )}
              >
                <p className="text-sm font-medium text-ink">{t.label}</p>
                <p className="mt-0.5 text-xs text-ink-3">{t.hint}</p>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Asset" required className="col-span-2">
              <Select value={form.asset_id} onChange={(e) => set("asset_id", e.target.value)} placeholder="Select asset" options={(assets.data ?? []).map((a) => ({ value: a.id, label: a.label }))} />
            </Field>
            <Field label={form.event_type === "call" ? "Notice date" : "Event date"} required>
              <Input type="date" value={form.event_date} onChange={(e) => set("event_date", e.target.value)} />
            </Field>
            {form.event_type !== "liquidation" ? (
              <Field label={form.event_type === "call" ? "Total call amount" : "Distributable amount"} required>
                <Input inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="$" />
              </Field>
            ) : (
              <Field label="Net proceeds" hint="Gross − payoff − costs − reserves">
                <Input value={net !== null ? formatCurrency(net) : ""} disabled placeholder="Enter gross proceeds" />
              </Field>
            )}
            {form.event_type === "liquidation" && (
              <>
                <Field label="Gross sale proceeds" required>
                  <Input inputMode="decimal" value={form.gross_proceeds} onChange={(e) => set("gross_proceeds", e.target.value)} />
                </Field>
                <Field label="Debt payoff">
                  <Input inputMode="decimal" value={form.debt_payoff} onChange={(e) => set("debt_payoff", e.target.value)} />
                </Field>
                <Field label="Closing costs">
                  <Input inputMode="decimal" value={form.closing_costs} onChange={(e) => set("closing_costs", e.target.value)} />
                </Field>
                <Field label="Reserves held back">
                  <Input inputMode="decimal" value={form.reserves} onChange={(e) => set("reserves", e.target.value)} />
                </Field>
              </>
            )}
            {form.event_type !== "call" && (
              <Field label="Waterfall" className="col-span-2" hint="Defaults to the waterfall linked to the asset's investments.">
                <Select value={form.waterfall_id} onChange={(e) => set("waterfall_id", e.target.value)} placeholder="Asset default" options={(waterfalls.data ?? []).filter((w) => w.is_active).map((w) => ({ value: w.id, label: `${w.name} (v${w.version})` }))} />
              </Field>
            )}
            {form.event_type === "call" && (
              <>
                <Field label="Due date" hint="Defaults to 10 days after notice">
                  <Input type="date" value={form.due_on} onChange={(e) => set("due_on", e.target.value)} />
                </Field>
                <Field label="Late interest % (annual)">
                  <Input inputMode="decimal" value={form.default_rate} onChange={(e) => set("default_rate", e.target.value)} />
                </Field>
                <Field label="Grace period (days)">
                  <Input inputMode="numeric" value={form.grace_days} onChange={(e) => set("grace_days", e.target.value)} />
                </Field>
                <Field label="Default penalty %">
                  <Input inputMode="decimal" value={form.penalty_pct} onChange={(e) => set("penalty_pct", e.target.value)} />
                </Field>
                <Field label="Wire instructions" className="col-span-2">
                  <Textarea rows={3} value={form.wire_instructions} onChange={(e) => set("wire_instructions", e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Purpose" className="col-span-2">
              <Input value={form.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder={form.event_type === "call" ? "e.g. Roof replacement and lease-up reserves" : "e.g. Q3 operating cash flow"} />
            </Field>
            <Field label="Name" hint="Optional — generated from type, asset and date">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Internal notes">
              <Input value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </div>
        </div>
      ) : calc ? (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-ink-2">{TYPES.find((t) => t.value === form.event_type)?.label} amount</p>
            <p className="text-xl font-semibold tabular">{formatCurrency(calc.amount)}</p>
          </div>
          <CalcView calc={calc.calc} eventType={form.event_type} />
          <p className="text-xs text-ink-3">
            The calculation is saved as version 1 with the waterfall configuration used. It can be recalculated while in draft; approval locks the version that will post.
          </p>
        </div>
      ) : (
        <Spinner />
      )}
    </Sheet>
  );
}
