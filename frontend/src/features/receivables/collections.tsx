"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Mail, Plus, Settings2, Trash2, Zap } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, titleCase, toNumber } from "@/lib/utils";

import { today, useCollections, usePlans, useReceivablesMutation, useSettings, type Collection, type LadderStep, type Notice, type Plan, type Settings } from "./api";
import { PlanSheet } from "./forms";
import { RxStatus } from "./ledger-tabs";

/* ------------------------------------------------------------------ ladder */

function LadderStrip({ steps, current }: { steps: LadderStep[]; current?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {steps.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <ChevronRight className="size-3.5 text-ink-3" />}
          <span
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs",
              current !== undefined && i + 1 <= current ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2",
            )}
          >
            {s.label}
            <span className={cn("tabular", current !== undefined && i + 1 <= current ? "text-white/70" : "text-ink-3")}>{s.days_past_due}d</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

export function LadderSettingsSheet({ open, onOpenChange, settings }: { open: boolean; onOpenChange: (o: boolean) => void; settings?: Settings }) {
  const [steps, setSteps] = useState<LadderStep[]>([]);
  const [fees, setFees] = useState({ grace_days: "5", pct: "5", flat: "" });
  const [alertDays, setAlertDays] = useState("90");
  const m = useReceivablesMutation<Record<string, unknown>, Settings>("/receivables/settings", "put");
  useEffect(() => {
    if (open && settings) {
      setSteps(settings.ladder.map((s) => ({ ...s })));
      setFees({ grace_days: String(settings.late_fee_defaults.grace_days), pct: settings.late_fee_defaults.pct != null ? String(settings.late_fee_defaults.pct) : "", flat: settings.late_fee_defaults.flat != null ? String(settings.late_fee_defaults.flat) : "" });
      setAlertDays(String(settings.alert_days));
    }
  }, [open, settings]);
  const upd = (i: number, patch: Partial<LadderStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = () =>
    m.mutate(
      {
        ladder: steps,
        alert_days: toNumber(alertDays) ?? 90,
        late_fee_defaults: { grace_days: toNumber(fees.grace_days) ?? 0, pct: toNumber(fees.pct), flat: toNumber(fees.flat), charge_types: settings?.late_fee_defaults.charge_types },
      },
      { onSuccess: () => { toast.success("Collections settings saved"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Collections settings"
      description="Late-fee defaults apply when a verified lease does not specify its own terms. Templates accept {tenant_name}, {property_name}, {balance}, {days_past_due}, {as_of}, {cure_by}."
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={save}>Save settings</Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Late-fee defaults</h4>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Grace days"><Input inputMode="numeric" value={fees.grace_days} onChange={(e) => setFees((f) => ({ ...f, grace_days: e.target.value }))} /></Field>
            <Field label="Fee %"><Input inputMode="decimal" value={fees.pct} onChange={(e) => setFees((f) => ({ ...f, pct: e.target.value }))} /></Field>
            <Field label="Flat fee $"><Input inputMode="decimal" value={fees.flat} onChange={(e) => setFees((f) => ({ ...f, flat: e.target.value }))} /></Field>
            <Field label="Alert at (days)"><Input inputMode="numeric" value={alertDays} onChange={(e) => setAlertDays(e.target.value)} /></Field>
          </div>
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Escalation ladder</h4>
            <Button
              size="xs"
              onClick={() => setSteps((s) => [...s, { key: `step_${s.length + 1}`, label: "New step", days_past_due: (s.length ? s[s.length - 1].days_past_due : 0) + 15, min_balance: 0, create_task: true, task_priority: "normal", collection_status: "delinquent", subject: "Notice: {property_name}", body: "Dear {tenant_name},\n\nYour balance of {balance} is {days_past_due} days past due." }])}
            >
              <Plus className="!size-3.5" /> Step
            </Button>
          </div>
          {steps.map((s, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-line p-3">
              <div className="grid grid-cols-[1fr_1.5fr_90px_110px_auto] items-end gap-2">
                <Field label="Key"><Input value={s.key} onChange={(e) => upd(i, { key: e.target.value })} /></Field>
                <Field label="Label"><Input value={s.label} onChange={(e) => upd(i, { label: e.target.value })} /></Field>
                <Field label="Days late"><Input inputMode="numeric" value={String(s.days_past_due)} onChange={(e) => upd(i, { days_past_due: toNumber(e.target.value) ?? 0 })} /></Field>
                <Field label="Min balance"><Input inputMode="decimal" value={String(s.min_balance)} onChange={(e) => upd(i, { min_balance: toNumber(e.target.value) ?? 0 })} /></Field>
                <Button size="icon-sm" variant="ghost" aria-label="Remove step" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
              <div className="grid grid-cols-3 items-end gap-2">
                <label className="flex h-8 items-center gap-2 text-sm text-ink-2">
                  <Checkbox checked={s.create_task} onChange={(v) => upd(i, { create_task: v })} /> Create task
                </label>
                <Field label="Task priority">
                  <Select value={s.task_priority} onChange={(e) => upd(i, { task_priority: e.target.value })} options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: titleCase(p) }))} />
                </Field>
                <Field label="Status at this step">
                  <Select value={s.collection_status} onChange={(e) => upd(i, { collection_status: e.target.value as LadderStep["collection_status"] })} options={[{ value: "delinquent", label: "Delinquent" }, { value: "legal", label: "Legal" }]} />
                </Field>
              </div>
              <Field label="Notice subject"><Input value={s.subject} onChange={(e) => upd(i, { subject: e.target.value })} /></Field>
              <Field label="Notice body"><Textarea rows={3} value={s.body} onChange={(e) => upd(i, { body: e.target.value })} /></Field>
            </div>
          ))}
        </section>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ notices */

function NoticeDialog({ notice, onOpenChange }: { notice: Notice | null; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const [method, setMethod] = useState("email");
  const send = useReceivablesMutation<{ id: string; delivery_method: string }, Notice>((b) => `/receivables/notices/${b.id}/send`);
  const cancel = useReceivablesMutation<{ id: string }, Notice>((b) => `/receivables/notices/${b.id}/cancel`);
  const n = notice;
  return (
    <Dialog
      open={!!n}
      onOpenChange={onOpenChange}
      title={n?.subject ?? "Notice"}
      description={n ? `${n.label} · ${formatCurrency(n.balance)} · ${n.days_past_due} days past due` : undefined}
      className="max-w-xl"
      footer={
        n?.status === "draft" && can("receivables", "edit") ? (
          <>
            <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate({ id: n.id }, { onSuccess: () => { toast.success("Notice cancelled"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) })}>
              Cancel notice
            </Button>
            <Select className="w-40" value={method} onChange={(e) => setMethod(e.target.value)} options={["email", "mail", "certified_mail", "hand", "portal"].map((m) => ({ value: m, label: titleCase(m) }))} />
            <Button variant="primary" loading={send.isPending} onClick={() => send.mutate({ id: n.id, delivery_method: method }, { onSuccess: () => { toast.success("Notice marked sent"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) })}>
              <Mail /> Mark sent
            </Button>
          </>
        ) : undefined
      }
    >
      {n && (
        <div className="space-y-3">
          <pre className="whitespace-pre-wrap rounded-lg border border-line bg-subtle/60 p-3 font-sans text-sm text-ink">{n.body}</pre>
          <p className="text-xs text-ink-3">
            {n.status === "sent" ? `Sent ${formatDateTime(n.sent_at)} by ${titleCase(n.delivery_method)}` : `Drafted ${formatDateTime(n.created_at)}`}
            {n.task_id ? " · follow-up task created" : ""}
          </p>
        </div>
      )}
    </Dialog>
  );
}

export function NoticesTable({ propertyId, leaseId }: { propertyId?: string; leaseId?: string }) {
  const [status, setStatus] = useState<string>("draft");
  const [open, setOpen] = useState<Notice | null>(null);
  const params = { property_id: propertyId, lease_id: leaseId, status: status === "all" ? undefined : status, page_size: 100 };
  const { data, isLoading } = useQuery({
    queryKey: ["receivables", "notices", params],
    queryFn: () => api.get<Page<Notice>>("/receivables/notices", params),
  });
  const columns: Column<Notice>[] = [
    { id: "created", header: "Drafted", cell: (n) => <span className="whitespace-nowrap text-ink-2">{formatDate(n.created_at)}</span> },
    ...(leaseId ? [] : [{ id: "tenant", header: "Tenant", cell: (n: Notice) => <span className="font-medium">{n.tenant_name}</span> }]),
    { id: "step", header: "Step", cell: (n) => n.label },
    { id: "subject", header: "Subject", cell: (n) => <span className="block max-w-[320px] truncate text-ink-2">{n.subject}</span> },
    { id: "balance", header: "Balance", align: "right", cell: (n) => formatCurrency(n.balance) },
    { id: "days", header: "Days late", align: "right", cell: (n) => n.days_past_due },
    { id: "status", header: "Status", cell: (n) => <Badge tone={n.status === "sent" ? "green" : n.status === "draft" ? "amber" : "neutral"} dot>{titleCase(n.status)}</Badge> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Notices"
        description="Drafted by the ladder or manually; mark sent once delivered."
        actions={<Select className="w-32" value={status} onChange={(e) => setStatus(e.target.value)} options={["draft", "sent", "cancelled", "all"].map((s) => ({ value: s, label: titleCase(s) }))} />}
      />
      <DataTable columns={columns} data={data?.items} loading={isLoading} dense onRowClick={setOpen} empty={<EmptyState title="No notices" />} />
      <NoticeDialog notice={open} onOpenChange={(o) => !o && setOpen(null)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ delinquency */

export function DelinquencyTab({ propertyId }: { propertyId?: string }) {
  const { can } = useAuth();
  const { data: settings } = useSettings();
  const { data, isLoading } = useCollections({ property_id: propertyId });
  const [configuring, setConfiguring] = useState(false);
  const evaluate = useReceivablesMutation<{ as_of: string; property_id?: string | null }, { evaluated: number; escalated: number; resolved: number; notices: number; breached_plans: number; late_fees: number }>("/receivables/delinquency/evaluate");
  const draft = useReceivablesMutation<{ lease_id: string; step_key: string }, Notice>("/receivables/notices");
  const ladder = [...(settings?.ladder ?? [])].sort((a, b) => a.days_past_due - b.days_past_due);
  const total = (data ?? []).reduce((s, c) => s + c.past_due_balance, 0);

  const columns: Column<Collection>[] = [
    {
      id: "tenant",
      header: "Tenant",
      cell: (c) => (
        <div>
          <Link href={`/receivables/tenants/${c.lease_id}`} className="font-medium text-ink hover:underline">{c.tenant_name}</Link>
          <p className="text-xs text-ink-3">{c.property_name}</p>
        </div>
      ),
    },
    { id: "past", header: "Past due", align: "right", cell: (c) => <span className="font-medium">{formatCurrency(c.past_due_balance)}</span> },
    { id: "days", header: "Days", align: "right", cell: (c) => <span className={cn(c.days_past_due >= 60 && "font-medium text-negative")}>{c.days_past_due}</span> },
    { id: "oldest", header: "Oldest due", cell: (c) => <span className="text-ink-2">{formatDate(c.oldest_due_on)}</span> },
    { id: "status", header: "Status", cell: (c) => <RxStatus status={c.status} /> },
    { id: "ladder", header: "Ladder", cell: (c) => (ladder.length ? <LadderStrip steps={ladder} current={c.step_index} /> : null) },
    { id: "evaluated", header: "Evaluated", cell: (c) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(c.last_evaluated_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) =>
        can("receivables", "create") ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm">Draft notice <ChevronDown /></Button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Ladder step</MenuLabel>
                {ladder.map((s) => (
                  <MenuItem key={s.key} onSelect={() => draft.mutate({ lease_id: c.lease_id, step_key: s.key }, { onSuccess: () => toast.success("Notice drafted"), onError: (e) => toast.error(errorMessage(e)) })}>
                    {s.label}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-ink-3">Escalation ladder</p>
          {ladder.length > 0 && <LadderStrip steps={ladder} />}
        </div>
        <div className="flex gap-2">
          {can("receivables", "approve") && (
            <Button onClick={() => setConfiguring(true)}><Settings2 /> Settings</Button>
          )}
          {can("receivables", "edit") && (
            <Button
              variant="primary"
              loading={evaluate.isPending}
              onClick={() =>
                evaluate.mutate(
                  { as_of: today(), property_id: propertyId ?? null },
                  {
                    onSuccess: (r) => toast.success(`${r.evaluated} tenants evaluated · ${r.escalated} escalated · ${r.notices} notices · ${r.late_fees} late fees · ${r.breached_plans} plans breached`),
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              <Zap /> Run aging automations
            </Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Tenants in collections" value={formatNumber(data?.length ?? 0)} tone={data?.length ? "caution" : "default"} />
        <StatCard label="Past due in collections" value={formatCurrency(total, { compact: true })} />
        <StatCard label="On payment plans" value={formatNumber((data ?? []).filter((c) => c.status === "payment_plan").length)} />
        <StatCard label="Referred to legal" value={formatNumber((data ?? []).filter((c) => c.status === "legal").length)} tone={(data ?? []).some((c) => c.status === "legal") ? "negative" : "default"} />
      </div>
      <Card className="overflow-hidden">
        <CardHeader title="Collection status" description="Aging thresholds advance tenants through the ladder, drafting notices and creating tasks." />
        <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState icon={<AlertTriangle />} title="No tenants in collections" description="Run the aging automations after posting payments." />} />
      </Card>
      <NoticesTable propertyId={propertyId} />
      <LadderSettingsSheet open={configuring} onOpenChange={setConfiguring} settings={settings} />
    </div>
  );
}

/* ------------------------------------------------------------------ payment plans */

export function PlansTab({ propertyId, leaseId }: { propertyId?: string; leaseId?: string }) {
  const { can } = useAuth();
  const [status, setStatus] = useState("active");
  const { data, isLoading } = usePlans({ property_id: propertyId, lease_id: leaseId, status: status === "all" ? undefined : status });
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cancel = useReceivablesMutation<{ id: string }, Plan>((b) => `/receivables/payment-plans/${b.id}/cancel`);

  const rows: Plan[] = data ?? [];
  const columns: Column<Plan>[] = [
    {
      id: "tenant",
      header: "Tenant",
      cell: (p) => (
        <span className="flex items-center gap-1.5 font-medium">
          {expanded === p.id ? <ChevronDown className="size-3.5 text-ink-3" /> : <ChevronRight className="size-3.5 text-ink-3" />}
          {p.tenant_name}
        </span>
      ),
    },
    { id: "total", header: "Plan amount", align: "right", cell: (p) => formatCurrency(p.total_amount) },
    { id: "paid", header: "Paid toward plan", align: "right", cell: (p) => formatCurrency(p.paid_amount) },
    { id: "schedule", header: "Schedule", cell: (p) => <span className="text-ink-2">{p.installment_count} × every {p.frequency_months} mo from {formatDate(p.start_on)}</span> },
    {
      id: "next",
      header: "Next installment",
      cell: (p) => {
        const next = p.installments.find((i) => i.status !== "paid");
        return next ? <span className={cn(next.status === "missed" && "font-medium text-negative")}>{formatDate(next.due_on)} · {formatCurrency(next.amount - next.paid_amount)}</span> : "—";
      },
    },
    { id: "status", header: "Status", cell: (p) => <Badge tone={p.status === "active" ? "blue" : p.status === "completed" ? "green" : p.status === "breached" ? "red" : "neutral"} dot>{titleCase(p.status)}</Badge> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (p) =>
        p.status === "active" && can("receivables", "approve") ? (
          <Button size="xs" variant="ghost" onClick={(e) => { e.stopPropagation(); cancel.mutate({ id: p.id }, { onSuccess: () => toast.success("Plan cancelled"), onError: (err) => toast.error(errorMessage(err)) }); }}>
            Cancel plan
          </Button>
        ) : null,
    },
  ];
  const open = rows.find((p) => p.id === expanded);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} options={["active", "breached", "completed", "cancelled", "all"].map((s) => ({ value: s, label: titleCase(s) }))} />
        {can("receivables", "approve") && <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New payment plan</Button>}
      </div>
      <Card className="overflow-hidden">
        <DataTable columns={columns} data={rows} loading={isLoading} dense onRowClick={(p) => setExpanded((e) => (e === p.id ? null : p.id))} empty={<EmptyState title="No payment plans" />} />
      </Card>
      {open && (
        <Card className="overflow-hidden">
          <CardHeader title={`Installments · ${open.tenant_name}`} description={open.breached_at ? `Breached ${formatDateTime(open.breached_at)}` : `Grace ${open.grace_days} days`} />
          <DataTable
            dense
            data={open.installments}
            columns={[
              { id: "seq", header: "#", cell: (i) => i.sequence },
              { id: "due", header: "Due", cell: (i) => formatDate(i.due_on) },
              { id: "amount", header: "Amount", align: "right", cell: (i) => formatCurrency(i.amount) },
              { id: "paid", header: "Paid", align: "right", cell: (i) => formatCurrency(i.paid_amount) },
              { id: "status", header: "Status", cell: (i) => <Badge tone={i.status === "paid" ? "green" : i.status === "missed" ? "red" : i.status === "partial" ? "sky" : "neutral"} dot>{titleCase(i.status)}</Badge> },
            ]}
          />
        </Card>
      )}
      <PlanSheet open={creating} onOpenChange={setCreating} leaseId={leaseId} />
    </div>
  );
}
