"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EntityPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";

import {
  CHARGE_TYPE_LABELS,
  MANUAL_CHARGE_TYPES,
  METHOD_LABELS,
  PAYMENT_METHODS,
  currentPeriod,
  today,
  useReceivablesMutation,
  type Charge,
  type Ledger,
  type Payment,
} from "./api";

interface LeaseLite { id: string; tenant_name: string; property_name: string | null; suite: string | null }

export function LeasePicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  return (
    <EntityPicker<LeaseLite>
      endpoint="/leases"
      value={value}
      onChange={(id) => onChange(id)}
      placeholder="Select tenant lease"
      toOption={(l) => ({ id: l.id, label: l.tenant_name, sublabel: [l.property_name, l.suite ? `Suite ${l.suite}` : null].filter(Boolean).join(" · ") })}
    />
  );
}

/* ------------------------------------------------------------------ generate charges */

export function GenerateChargesDialog({ open, onOpenChange, propertyId }: { open: boolean; onOpenChange: (o: boolean) => void; propertyId?: string | null }) {
  const [period, setPeriod] = useState(currentPeriod());
  const m = useReceivablesMutation<{ period: string; property_id?: string | null }, { created: number; existing: number; skipped_unverified: number; amount: number }>("/receivables/charges/generate");
  useEffect(() => {
    if (open) setPeriod(currentPeriod());
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate recurring charges"
      description="Creates base rent and recovery estimate charges from verified lease schedules. Safe to re-run: existing charges for the period are skipped."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!/^\d{4}-\d{2}$/.test(period)}
            onClick={() =>
              m.mutate(
                { period, property_id: propertyId ?? null },
                {
                  onSuccess: (r) => {
                    toast.success(`${r.created} charges created (${formatCurrency(r.amount)}), ${r.existing} already existed${r.skipped_unverified ? `, ${r.skipped_unverified} unverified leases skipped` : ""}`);
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Generate
          </Button>
        </>
      }
    >
      <Field label="Billing period">
        <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ manual charge */

export function ManualChargeSheet({ open, onOpenChange, leaseId }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId?: string }) {
  const { can } = useAuth();
  const [lease, setLease] = useState<string | null>(leaseId ?? null);
  const [form, setForm] = useState({ charge_type: "repair", amount: "", due_on: today(), description: "", period_start: "", period_end: "" });
  const m = useReceivablesMutation<Record<string, unknown>, Charge>("/receivables/charges");
  useEffect(() => {
    if (open) {
      setLease(leaseId ?? null);
      setForm({ charge_type: "repair", amount: "", due_on: today(), description: "", period_start: "", period_end: "" });
    }
  }, [open, leaseId]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const amount = toNumber(form.amount);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="One-time charge"
      description={can("receivables", "approve") ? "You can approve charges, so this posts immediately." : "Manual charges post only after a receivables approver signs off."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!lease || amount === null || !form.description.trim()}
            onClick={() =>
              m.mutate(
                { lease_id: lease, charge_type: form.charge_type, amount, due_on: form.due_on, description: form.description.trim(), period_start: form.period_start || null, period_end: form.period_end || null },
                {
                  onSuccess: (c) => {
                    toast.success(c.status === "pending_approval" ? "Charge submitted for approval" : "Charge posted");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            {can("receivables", "approve") ? "Post charge" : "Submit for approval"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {!leaseId && (
          <Field label="Tenant lease" required className="col-span-2">
            <LeasePicker value={lease} onChange={setLease} />
          </Field>
        )}
        <Field label="Charge type">
          <Select value={form.charge_type} onChange={set("charge_type")} options={MANUAL_CHARGE_TYPES.map((t) => ({ value: t, label: CHARGE_TYPE_LABELS[t] }))} />
        </Field>
        <Field label="Amount ($)" hint="Negative for a credit"><Input inputMode="decimal" value={form.amount} onChange={set("amount")} /></Field>
        <Field label="Due on"><Input type="date" value={form.due_on} onChange={set("due_on")} /></Field>
        <div />
        <Field label="Period start"><Input type="date" value={form.period_start} onChange={set("period_start")} /></Field>
        <Field label="Period end"><Input type="date" value={form.period_end} onChange={set("period_end")} /></Field>
        <Field label="Description" required hint="Reason and support for the charge" className="col-span-2"><Textarea rows={3} value={form.description} onChange={set("description")} /></Field>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ record payment */

export function RecordPaymentSheet({ open, onOpenChange, leaseId }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId?: string }) {
  const [lease, setLease] = useState<string | null>(leaseId ?? null);
  const [form, setForm] = useState({ received_on: today(), amount: "", method: "ach", reference: "", notes: "" });
  const [mode, setMode] = useState<"auto" | "manual" | "none">("auto");
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const m = useReceivablesMutation<Record<string, unknown>, Payment>("/receivables/payments");
  const ledger = useQuery({
    queryKey: ["receivables", "ledger", lease],
    queryFn: () => api.get<Ledger>(`/receivables/tenants/${lease}/ledger`),
    enabled: open && !!lease,
  });
  useEffect(() => {
    if (open) {
      setLease(leaseId ?? null);
      setForm({ received_on: today(), amount: "", method: "ach", reference: "", notes: "" });
      setMode("auto");
      setAlloc({});
    }
  }, [open, leaseId]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const amount = toNumber(form.amount);
  const open_ = (ledger.data?.open_charges ?? []).filter((c) => c.balance > 0 && (c.status === "open" || c.status === "partial"));
  const allocated = Object.values(alloc).reduce((s, v) => s + (toNumber(v) ?? 0), 0);

  const submit = () =>
    m.mutate(
      {
        lease_id: lease, received_on: form.received_on, amount, method: form.method, reference: form.reference || null, notes: form.notes || null,
        auto_apply: mode === "auto",
        allocations: mode === "manual" ? Object.entries(alloc).filter(([, v]) => (toNumber(v) ?? 0) > 0).map(([charge_id, v]) => ({ charge_id, amount: toNumber(v) })) : [],
      },
      {
        onSuccess: (p) => {
          toast.success(`Payment recorded${p.unapplied_amount > 0 ? ` · ${formatCurrency(p.unapplied_amount)} unapplied` : ""}`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Record payment"
      description="Payments are never edited or deleted; corrections are reversals."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!lease || !amount || amount <= 0 || (mode === "manual" && allocated > (amount ?? 0) + 0.005)} onClick={submit}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          {!leaseId && (
            <Field label="Tenant lease" required className="col-span-2">
              <LeasePicker value={lease} onChange={setLease} />
            </Field>
          )}
          <Field label="Received on"><Input type="date" value={form.received_on} onChange={set("received_on")} /></Field>
          <Field label="Amount ($)" required><Input inputMode="decimal" value={form.amount} onChange={set("amount")} /></Field>
          <Field label="Method"><Select value={form.method} onChange={set("method")} options={PAYMENT_METHODS.map((m) => ({ value: m, label: METHOD_LABELS[m] }))} /></Field>
          <Field label="Reference"><Input value={form.reference} onChange={set("reference")} placeholder="Check # / trace" /></Field>
          <Field label="Notes" className="col-span-2"><Input value={form.notes} onChange={set("notes")} /></Field>
        </div>
        <section className="space-y-2">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Application</h4>
          <div className="flex gap-4 text-sm">
            {(["auto", "manual", "none"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-ink-2">
                <input type="radio" checked={mode === k} onChange={() => setMode(k)} />
                {k === "auto" ? "Oldest first" : k === "manual" ? "Allocate manually" : "Hold as unapplied"}
              </label>
            ))}
          </div>
          {mode === "manual" && (
            <div className="rounded-lg border border-line">
              {open_.length === 0 && <p className="px-3 py-4 text-sm text-ink-3">{lease ? "No open charges." : "Choose a lease first."}</p>}
              {open_.map((c) => (
                <div key={c.id} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{c.description ?? CHARGE_TYPE_LABELS[c.charge_type]}</p>
                    <p className="text-xs text-ink-3">Due {formatDate(c.due_on)} · balance {formatCurrency(c.balance)}</p>
                  </div>
                  <Input className="w-28" inputMode="decimal" placeholder="0.00" value={alloc[c.id] ?? ""} onChange={(e) => setAlloc((a) => ({ ...a, [c.id]: e.target.value }))} />
                </div>
              ))}
              {open_.length > 0 && (
                <p className="px-3 py-2 text-right text-xs text-ink-3 tabular">
                  Allocated {formatCurrency(allocated)} of {formatCurrency(amount ?? 0)} · {formatCurrency(Math.max(0, (amount ?? 0) - allocated))} stays unapplied
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ reason dialog (void / reverse) */

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" loading={pending} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label="Reason" required hint="Recorded in the audit trail">
        <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ payment detail */

export function PaymentDialog({ payment, onOpenChange }: { payment: Payment | null; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const [reversing, setReversing] = useState(false);
  const [unapplyId, setUnapplyId] = useState<string | null>(null);
  const apply = useReceivablesMutation<{ id: string; allocations: never[] }, Payment>((b) => `/receivables/payments/${b.id}/apply`);
  const unapply = useReceivablesMutation<{ id: string; application_id: string; reason: string }, Payment>((b) => `/receivables/payments/${b.id}/unapply`);
  const reverse = useReceivablesMutation<{ id: string; reason: string }, Payment>((b) => `/receivables/payments/${b.id}/reverse`);
  const p = payment;
  const done = (msg: string) => () => {
    toast.success(msg);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog
        open={!!p}
        onOpenChange={onOpenChange}
        title={p ? `${formatCurrency(p.amount)} from ${p.tenant_name ?? "tenant"}` : "Payment"}
        description={p ? `${METHOD_LABELS[p.method] ?? p.method}${p.reference ? ` · ${p.reference}` : ""} · received ${formatDate(p.received_on)}` : undefined}
        className="max-w-xl"
        footer={
          p && p.status === "received" ? (
            <>
              {can("receivables", "approve") && (
                <Button variant="danger" onClick={() => setReversing(true)}>Reverse payment</Button>
              )}
              {p.unapplied_amount > 0 && can("receivables", "edit") && (
                <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate({ id: p.id, allocations: [] }, { onSuccess: done("Applied oldest first"), onError: (e) => toast.error(errorMessage(e)) })}>
                  Apply {formatCurrency(p.unapplied_amount)} oldest first
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {p && (
          <div className="space-y-3 text-sm">
            {p.status === "reversed" && (
              <p className="rounded-md bg-negative-soft px-3 py-2 text-negative">Reversed {formatDate(p.reversed_at)}: {p.reversal_reason}</p>
            )}
            <div className="flex justify-between text-ink-2">
              <span>Unapplied</span>
              <span className="tabular">{formatCurrency(p.unapplied_amount)}</span>
            </div>
            <div className="rounded-lg border border-line">
              {p.applications.length === 0 && <p className="px-3 py-4 text-ink-3">Not applied to any charge.</p>}
              {p.applications.map((a) => (
                <div key={a.id} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className={a.reversed_at ? "text-ink-3 line-through" : "text-ink"}>Charge {a.charge_id.slice(0, 8)} · {titleCase(a.method)}</p>
                    <p className="text-xs text-ink-3">{a.reversed_at ? `Unapplied: ${a.reversal_reason}` : `Applied ${formatDate(a.applied_on)}`}</p>
                  </div>
                  <span className="tabular">{formatCurrency(a.amount)}</span>
                  {!a.reversed_at && p.status === "received" && can("receivables", "edit") && (
                    <Button size="xs" variant="ghost" onClick={() => setUnapplyId(a.id)}>Unapply</Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>
      <ReasonDialog
        open={reversing}
        onOpenChange={setReversing}
        title="Reverse this payment?"
        description="All applications are reversed and the charges reopen. The payment stays in the ledger with a reversal entry."
        confirmLabel="Reverse payment"
        pending={reverse.isPending}
        onConfirm={(reason) => p && reverse.mutate({ id: p.id, reason }, { onSuccess: () => { setReversing(false); done("Payment reversed")(); }, onError: (e) => toast.error(errorMessage(e)) })}
      />
      <ReasonDialog
        open={!!unapplyId}
        onOpenChange={(o) => !o && setUnapplyId(null)}
        title="Unapply from charge?"
        confirmLabel="Unapply"
        pending={unapply.isPending}
        onConfirm={(reason) => p && unapplyId && unapply.mutate({ id: p.id, application_id: unapplyId, reason }, { onSuccess: () => { setUnapplyId(null); done("Application reversed")(); }, onError: (e) => toast.error(errorMessage(e)) })}
      />
    </>
  );
}

/* ------------------------------------------------------------------ payment plan */

export function PlanSheet({ open, onOpenChange, leaseId }: { open: boolean; onOpenChange: (o: boolean) => void; leaseId?: string }) {
  const [lease, setLease] = useState<string | null>(leaseId ?? null);
  const [form, setForm] = useState({ total_amount: "", start_on: today(), installment_count: "6", frequency_months: "1", grace_days: "5", notes: "" });
  const [useBalance, setUseBalance] = useState(true);
  const m = useReceivablesMutation<Record<string, unknown>>("/receivables/payment-plans");
  useEffect(() => {
    if (open) {
      setLease(leaseId ?? null);
      setUseBalance(true);
      setForm({ total_amount: "", start_on: today(), installment_count: "6", frequency_months: "1", grace_days: "5", notes: "" });
    }
  }, [open, leaseId]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New payment plan"
      description="Installments are tracked against payments received beyond ongoing rent. A missed installment past grace breaches the plan."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!lease}
            onClick={() =>
              m.mutate(
                {
                  lease_id: lease, total_amount: useBalance ? null : toNumber(form.total_amount), start_on: form.start_on,
                  installment_count: toNumber(form.installment_count) ?? 1, frequency_months: toNumber(form.frequency_months) ?? 1,
                  grace_days: toNumber(form.grace_days) ?? 5, notes: form.notes || null,
                },
                { onSuccess: () => { toast.success("Payment plan created"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Create plan
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {!leaseId && (
          <Field label="Tenant lease" required className="col-span-2">
            <LeasePicker value={lease} onChange={setLease} />
          </Field>
        )}
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={useBalance} onChange={setUseBalance} />
          Use the current past-due balance as the plan amount
        </label>
        {!useBalance && <Field label="Plan amount ($)" className="col-span-2"><Input inputMode="decimal" value={form.total_amount} onChange={set("total_amount")} /></Field>}
        <Field label="First installment"><Input type="date" value={form.start_on} onChange={set("start_on")} /></Field>
        <Field label="Installments"><Input inputMode="numeric" value={form.installment_count} onChange={set("installment_count")} /></Field>
        <Field label="Every (months)"><Input inputMode="numeric" value={form.frequency_months} onChange={set("frequency_months")} /></Field>
        <Field label="Grace (days)"><Input inputMode="numeric" value={form.grace_days} onChange={set("grace_days")} /></Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={2} value={form.notes} onChange={set("notes")} /></Field>
      </div>
    </Sheet>
  );
}
