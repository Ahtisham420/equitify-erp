"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { toNumber } from "@/lib/utils";

import { useAssetOptions, useSaveInvestment, useWaterfalls, type Investment } from "./api";

interface FormState {
  asset_id: string;
  waterfall_id: string;
  commitment: string;
  ownership_pct: string;
  pref_rate: string;
  pref_compounding: string;
  day_count: string;
  waterfall_position: string;
  status: string;
  invested_on: string;
  notes: string;
  source: string;
}

const toForm = (i?: Investment | null): FormState => ({
  asset_id: i?.asset_id ?? "",
  waterfall_id: i?.waterfall_id ?? "",
  commitment: i ? String(i.commitment) : "",
  ownership_pct: i ? String(i.ownership_pct) : "",
  pref_rate: i ? String(i.pref_rate) : "8",
  pref_compounding: i?.pref_compounding ?? "simple",
  day_count: i?.day_count ?? "act_365",
  waterfall_position: i?.waterfall_position ?? "lp",
  status: i?.status ?? "active",
  invested_on: i?.invested_on ?? "",
  notes: i?.notes ?? "",
  source: i ? "Amendment" : "Subscription documents",
});

export function InvestmentFormSheet({
  open,
  onOpenChange,
  partnerId,
  investment,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partnerId: string;
  investment?: Investment | null;
}) {
  const [form, setForm] = useState<FormState>(toForm(investment));
  const save = useSaveInvestment(investment?.id);
  const assets = useAssetOptions(open);
  const waterfalls = useWaterfalls(open);

  useEffect(() => {
    if (open) setForm(toForm(investment));
  }, [open, investment]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const commitment = toNumber(form.commitment);
    const ownership = toNumber(form.ownership_pct);
    if (commitment === null || ownership === null) {
      toast.error("Commitment and ownership are required");
      return;
    }
    const body = {
      waterfall_id: form.waterfall_id || null,
      commitment,
      ownership_pct: ownership,
      pref_rate: toNumber(form.pref_rate) ?? 0,
      pref_compounding: form.pref_compounding,
      day_count: form.day_count,
      waterfall_position: form.waterfall_position,
      status: form.status,
      invested_on: form.invested_on || null,
      notes: form.notes.trim() || null,
      provenance: { source: form.source.trim() || "Manual entry", observed_on: null, confidence: 1, verified: true },
    };
    save.mutate(investment ? body : { ...body, partner_id: partnerId, asset_id: form.asset_id }, {
      onSuccess: () => {
        toast.success(investment ? "Investment updated" : "Investment added");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const wfOptions = (waterfalls.data ?? []).filter((w) => w.is_active).map((w) => ({ value: w.id, label: `${w.name} (v${w.version})` }));

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={investment ? "Edit investment" : "Add investment"}
      description="Commitment, ownership and waterfall terms are kept with their source and history."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="investment-form" loading={save.isPending} disabled={!investment && !form.asset_id}>
            {investment ? "Save changes" : "Add investment"}
          </Button>
        </>
      }
    >
      <form id="investment-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Asset" required className="col-span-2" hint={assets.data && assets.data.length === 0 ? "No owned assets are available yet." : undefined}>
          {investment ? (
            <Input value={investment.asset_label ?? investment.asset_id} disabled />
          ) : (
            <Select value={form.asset_id} onChange={(e) => set("asset_id", e.target.value)} placeholder="Select asset" options={(assets.data ?? []).map((a) => ({ value: a.id, label: a.label }))} />
          )}
        </Field>
        <Field label="Commitment" required>
          <Input inputMode="decimal" value={form.commitment} onChange={(e) => set("commitment", e.target.value)} placeholder="$" />
        </Field>
        <Field label="Ownership %" required>
          <Input inputMode="decimal" value={form.ownership_pct} onChange={(e) => set("ownership_pct", e.target.value)} placeholder="e.g. 12.5" />
        </Field>
        <Field label="Waterfall position">
          <Select value={form.waterfall_position} onChange={(e) => set("waterfall_position", e.target.value)} options={[{ value: "lp", label: "LP (investor)" }, { value: "gp", label: "GP (sponsor / promote)" }]} />
        </Field>
        <Field label="Waterfall">
          <Select value={form.waterfall_id} onChange={(e) => set("waterfall_id", e.target.value)} placeholder="Asset default" options={wfOptions} />
        </Field>
        <Field label="Preferred return %" hint="Annual rate on unreturned capital">
          <Input inputMode="decimal" value={form.pref_rate} onChange={(e) => set("pref_rate", e.target.value)} />
        </Field>
        <Field label="Compounding">
          <Select value={form.pref_compounding} onChange={(e) => set("pref_compounding", e.target.value)} options={[{ value: "simple", label: "Simple (non-compounding)" }, { value: "annual", label: "Compounded annually" }]} />
        </Field>
        <Field label="Day count">
          <Select value={form.day_count} onChange={(e) => set("day_count", e.target.value)} options={[{ value: "act_365", label: "Actual/365" }, { value: "act_360", label: "Actual/360" }, { value: "30_360", label: "30/360" }]} />
        </Field>
        <Field label="Invested on">
          <Input type="date" value={form.invested_on} onChange={(e) => set("invested_on", e.target.value)} />
        </Field>
        {investment && (
          <Field label="Status">
            <Select value={form.status} onChange={(e) => set("status", e.target.value)} options={[{ value: "active", label: "Active" }, { value: "exited", label: "Exited" }]} />
          </Field>
        )}
        <Field label="Source of terms" className={investment ? "" : "col-span-2"}>
          <Input value={form.source} onChange={(e) => set("source", e.target.value)} placeholder="e.g. Subscription agreement dated…" />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}
