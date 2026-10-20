"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Separator } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, titleCase, toNumber } from "@/lib/utils";

import { SIDES, useDealOptions, useSaveCommission, useSplitPlans, type Commission } from "./api";

interface Row {
  agent_id: string | null;
  share_pct: string;
  override_agent_pct: string;
}
interface Ded {
  label: string;
  amount: string;
  agent_id: string;
}
interface FormState {
  brokerage_deal_id: string;
  title: string;
  agent_id: string | null;
  property_id: string | null;
  side: string;
  source: string;
  deal_volume: string;
  gross: string;
  probability: string;
  expected_close_on: string;
  expected_on: string;
  split_plan_id: string;
  participants: Row[];
  referral_party: string;
  referral_pct: string;
  referral_amount: string;
  deductions: Ded[];
  notes: string;
}

const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

const toForm = (c?: Commission | null): FormState => ({
  brokerage_deal_id: c?.brokerage_deal_id ?? "",
  title: c?.title ?? "",
  agent_id: c?.agent_id ?? null,
  property_id: c?.property_id ?? null,
  side: c?.side ?? "",
  source: c?.source ?? "",
  deal_volume: str(c?.deal_volume),
  gross: str(c?.gross),
  probability: str(c?.probability),
  expected_close_on: c?.expected_close_on ?? "",
  expected_on: c?.expected_on ?? "",
  split_plan_id: c?.split_plan_id ?? "",
  participants: (c?.participants ?? []).map((p) => ({ agent_id: p.agent_id, share_pct: String(p.share_pct), override_agent_pct: str(p.override_agent_pct) })),
  referral_party: c?.referral_party ?? "",
  referral_pct: str(c?.referral_pct),
  referral_amount: str(c?.referral_amount),
  deductions: (c?.deductions ?? []).map((d) => ({ label: d.label, amount: String(d.amount), agent_id: d.agent_id ?? "" })),
  notes: c?.notes ?? "",
});

export function CommissionFormSheet({ open, onOpenChange, commission, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; commission?: Commission | null; onSaved?: (id: string) => void }) {
  const { can } = useAuth();
  const sensitive = can("commissions", "view_sensitive");
  const [form, setForm] = useState<FormState>(toForm(commission));
  const save = useSaveCommission(commission?.id);
  const deals = useDealOptions(open && !commission);
  const plans = useSplitPlans(open && sensitive);

  useEffect(() => {
    if (open) setForm(toForm(commission));
  }, [open, commission]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setRow = (i: number, patch: Partial<Row>) => set("participants", form.participants.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setDed = (i: number, patch: Partial<Ded>) => set("deductions", form.deductions.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const pickDeal = (id: string) => {
    const d = deals.data?.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      brokerage_deal_id: id,
      title: f.title || d?.label || "",
      agent_id: f.agent_id ?? d?.agent_id ?? null,
      gross: f.gross || str(d?.gross_commission_estimate),
      probability: f.probability || str(d?.probability),
      expected_close_on: f.expected_close_on || d?.expected_close_on || "",
    }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const gross = toNumber(form.gross);
    if (gross === null && !form.brokerage_deal_id) {
      toast.error("Gross commission is required");
      return;
    }
    const participants = form.participants
      .filter((p) => p.agent_id)
      .map((p) => ({ agent_id: p.agent_id as string, share_pct: toNumber(p.share_pct) ?? 100, override_agent_pct: toNumber(p.override_agent_pct) }));
    const body = {
      title: form.title.trim() || null,
      agent_id: form.agent_id,
      property_id: form.property_id,
      side: form.side || null,
      source: form.source.trim() || null,
      deal_volume: toNumber(form.deal_volume),
      gross: gross ?? 0,
      probability: toNumber(form.probability),
      expected_close_on: form.expected_close_on || null,
      expected_on: form.expected_on || null,
      ...(sensitive ? { split_plan_id: form.split_plan_id || null } : {}),
      participants,
      referral_party: form.referral_party.trim() || null,
      referral_pct: toNumber(form.referral_pct),
      referral_amount: toNumber(form.referral_amount),
      deductions: form.deductions.filter((d) => d.label.trim() && toNumber(d.amount) !== null).map((d) => ({ label: d.label.trim(), amount: toNumber(d.amount) ?? 0, agent_id: d.agent_id || null })),
      notes: form.notes.trim() || null,
    };
    save.mutate(commission ? body : { ...body, brokerage_deal_id: form.brokerage_deal_id || null }, {
      onSuccess: (c) => {
        toast.success(commission ? "Commission updated and splits recalculated" : "Commission record created");
        onOpenChange(false);
        onSaved?.(c.id);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      title={commission ? "Edit commission" : "New commission record"}
      description="Splits are calculated from the agent plan (YTD GCI tiers and caps) unless a per-deal override is set."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="commission-form" loading={save.isPending}>
            {commission ? "Save and recalculate" : "Create commission"}
          </Button>
        </>
      }
    >
      <form id="commission-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        {!commission && (
          <Field label="Brokerage transaction" className="col-span-2" hint={deals.data && !deals.data.length ? "No brokerage transactions available; the record can still be created manually." : "Defaults agent, estimate, probability and close date from the transaction."}>
            <Select
              value={form.brokerage_deal_id}
              onChange={(e) => pickDeal(e.target.value)}
              placeholder="Not linked"
              options={(deals.data ?? []).filter((d) => !d.has_commission).map((d) => ({ value: d.id, label: `${d.label}${d.stage ? ` · ${titleCase(d.stage)}` : ""}${d.gross_commission_estimate ? ` · ${formatCurrency(d.gross_commission_estimate, { compact: true })}` : ""}` }))}
            />
          </Field>
        )}
        <Field label="Title" className="col-span-2">
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Defaults to the transaction name" />
        </Field>
        <Field label="Primary agent">
          <UserPicker value={form.agent_id} onChange={(id) => set("agent_id", id)} placeholder="Defaults to transaction agent" />
        </Field>
        <Field label="Property">
          <PropertyPicker value={form.property_id} onChange={(id) => set("property_id", id)} />
        </Field>
        <Field label="Side">
          <Select value={form.side} onChange={(e) => set("side", e.target.value)} placeholder="—" options={SIDES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Source">
          <Input value={form.source} onChange={(e) => set("source", e.target.value)} placeholder="e.g. referral, cold call, repeat client" />
        </Field>
        <Field label="Transaction value">
          <Input inputMode="decimal" value={form.deal_volume} onChange={(e) => set("deal_volume", e.target.value)} placeholder="$" />
        </Field>
        <Field label="Gross commission" required={!form.brokerage_deal_id}>
          <Input inputMode="decimal" value={form.gross} onChange={(e) => set("gross", e.target.value)} placeholder="$" />
        </Field>
        <Field label="Probability %">
          <Input inputMode="decimal" value={form.probability} onChange={(e) => set("probability", e.target.value)} />
        </Field>
        <Field label="Expected close">
          <Input type="date" value={form.expected_close_on} onChange={(e) => set("expected_close_on", e.target.value)} />
        </Field>
        <Field label="Expected payment" hint="Defaults to 30 days after close">
          <Input type="date" value={form.expected_on} onChange={(e) => set("expected_on", e.target.value)} />
        </Field>
        {sensitive && (
          <Field label="Split plan">
            <Select value={form.split_plan_id} onChange={(e) => set("split_plan_id", e.target.value)} placeholder="Agent's assigned plan" options={(plans.data ?? []).filter((p) => p.is_active).map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
        )}

        <Separator className="col-span-2 my-1" />
        <div className="col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Agent split structure</p>
            <Button size="xs" onClick={() => set("participants", [...form.participants, { agent_id: null, share_pct: "50", override_agent_pct: "" }])}>
              <Plus className="!size-3.5" /> Co-agent
            </Button>
          </div>
          {form.participants.length === 0 && <p className="text-xs text-ink-3">The primary agent receives 100% of the agent side. Add rows to co-broker.</p>}
          <div className="space-y-2">
            {form.participants.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_90px_120px_32px] items-end gap-2">
                <Field label={i === 0 ? "Agent" : ""}>
                  <UserPicker value={r.agent_id} onChange={(id) => setRow(i, { agent_id: id })} />
                </Field>
                <Field label={i === 0 ? "Share %" : ""}>
                  <Input inputMode="decimal" value={r.share_pct} onChange={(e) => setRow(i, { share_pct: e.target.value })} />
                </Field>
                <Field label={i === 0 ? "Override agent %" : ""}>
                  <Input inputMode="decimal" value={r.override_agent_pct} onChange={(e) => setRow(i, { override_agent_pct: e.target.value })} placeholder="Plan" />
                </Field>
                <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => set("participants", form.participants.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <Field label="Referral party">
          <Input value={form.referral_party} onChange={(e) => set("referral_party", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Referral %">
            <Input inputMode="decimal" value={form.referral_pct} onChange={(e) => set("referral_pct", e.target.value)} />
          </Field>
          <Field label="or amount">
            <Input inputMode="decimal" value={form.referral_amount} onChange={(e) => set("referral_amount", e.target.value)} />
          </Field>
        </div>

        <div className="col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Expense deductions</p>
            <Button size="xs" onClick={() => set("deductions", [...form.deductions, { label: "", amount: "", agent_id: "" }])}>
              <Plus className="!size-3.5" /> Deduction
            </Button>
          </div>
          <div className="space-y-2">
            {form.deductions.map((d, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_32px] items-center gap-2">
                <Input value={d.label} onChange={(e) => setDed(i, { label: e.target.value })} placeholder="e.g. Marketing, E&O fee" />
                <Input inputMode="decimal" value={d.amount} onChange={(e) => setDed(i, { amount: e.target.value })} placeholder="$" />
                <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => set("deductions", form.deductions.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          {form.deductions.length > 0 && <p className="mt-1 text-xs text-ink-3">Deductions are charged to the primary agent&apos;s split.</p>}
        </div>

        <Field label="Notes" className="col-span-2">
          <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}
