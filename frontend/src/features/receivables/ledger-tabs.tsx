"use client";

import { useQuery } from "@tanstack/react-query";
import { Banknote, Check, FileWarning, MoreHorizontal, Plus, Receipt, RefreshCw, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase } from "@/lib/utils";

import {
  CHARGE_SOURCES,
  CHARGE_STATUSES,
  CHARGE_TYPE_LABELS,
  CHARGE_TYPES,
  COLLECTION_STATUSES,
  METHOD_LABELS,
  PAYMENT_METHODS,
  SOURCE_LABELS,
  today,
  useReceivablesMutation,
  type Charge,
  type ChargeFacets,
  type Payment,
  type TenantBalance,
} from "./api";
import { bucketColumns } from "./dashboard";
import { GenerateChargesDialog, ManualChargeSheet, PaymentDialog, ReasonDialog, RecordPaymentSheet } from "./forms";

const STATUS_TONE: Record<string, "neutral" | "blue" | "green" | "amber" | "red" | "sky"> = {
  pending_approval: "amber", open: "blue", partial: "sky", paid: "green", credit: "green", void: "neutral",
  received: "green", reversed: "red", current: "green", delinquent: "amber", payment_plan: "sky", legal: "red", resolved: "neutral",
};

export function RxStatus({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>{status === "pending_approval" ? "Pending approval" : titleCase(status)}</Badge>;
}

function sourceTrace(c: Charge) {
  const r = c.source_ref ?? {};
  if (c.source === "schedule") return r.amendment_id ? "Rent step (amendment)" : r.recovery_id ? "Recovery estimate" : "Rent step";
  if (c.source === "late_fee") return `${r.basis === "lease_terms" ? "Lease terms" : "Defaults"}: ${r.pct ? `${r.pct}%` : ""}${r.flat ? ` +$${r.flat}` : ""} after ${r.grace_days ?? 0}d grace`;
  if (c.source === "reconciliation") return `${r.year ?? ""} reconciliation`;
  return c.approved_at ? "Approved manual entry" : "Awaiting approval";
}

/* ------------------------------------------------------------------ tenants */

export function TenantsTab({ propertyId }: { propertyId?: string }) {
  const list = useListQuery<TenantBalance>("receivables", "/receivables/tenants", propertyId ? { property_id: propertyId } : undefined);
  const { url } = list;
  const columns: Column<TenantBalance>[] = [
    {
      id: "tenant",
      header: "Tenant",
      sortKey: "tenant_name",
      cell: (t) => (
        <div className="min-w-[180px]">
          <p className="truncate font-medium text-ink">{t.tenant_name}</p>
          <p className="truncate text-xs text-ink-3">{t.property_name}</p>
        </div>
      ),
    },
    ...bucketColumns<TenantBalance>(),
    { id: "unapplied", header: "Unapplied", align: "right", cell: (t) => formatCurrency(t.unapplied) },
    { id: "balance", header: "Net balance", sortKey: "balance", align: "right", cell: (t) => <span className="font-medium">{formatCurrency(t.balance)}</span> },
    {
      id: "collection",
      header: "Collection",
      cell: (t) => (
        <span className="flex items-center gap-1.5">
          <RxStatus status={t.collection_status} />
          {t.step_key && <span className="text-xs text-ink-3">{titleCase(t.step_key)}</span>}
          {t.has_plan && <Badge tone="sky">Plan</Badge>}
        </span>
      ),
    },
  ];
  return (
    <ListCard
      toolbar={
        <Toolbar right={<SavedViewsMenu module="receivables" />}>
          <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search tenant or property…" />
          <FacetFilter
            label="Collection"
            options={COLLECTION_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))}
            selected={url.getAll("collection_status")}
            onChange={(v) => url.set({ collection_status: v })}
          />
          <FacetFilter
            label="Past due"
            single
            options={[{ value: "true", label: "Past due only" }]}
            selected={url.get("delinquent_only") ? ["true"] : []}
            onChange={(v) => url.set({ delinquent_only: v[0] ?? null })}
          />
        </Toolbar>
      }
      footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(s) => url.set({ page_size: s })} />}
    >
      <DataTable
        columns={columns}
        data={list.data?.items}
        loading={list.isLoading}
        fetching={list.isFetching}
        sort={url.get("sort")}
        onSortChange={(sort) => url.set({ sort })}
        rowHref={(t) => `/receivables/tenants/${t.lease_id}`}
        dense
        empty={<EmptyState icon={<Users />} title="No tenant balances" description="Active leases and any lease with open charges or cash appear here." />}
      />
    </ListCard>
  );
}

/* ------------------------------------------------------------------ charges */

const CHARGE_MORE: MoreFilterField[] = [
  { type: "text", label: "Billing period (YYYY-MM)", key: "period", placeholder: "2026-10" },
  { type: "date-range", label: "Due between", minKey: "due_from", maxKey: "due_to" },
  { type: "select", label: "Overdue", key: "overdue", options: [{ value: "true", label: "Overdue only" }] },
];

export function ChargesTab({ propertyId, leaseId }: { propertyId?: string; leaseId?: string }) {
  const { can } = useAuth();
  const extra = { ...(propertyId ? { property_id: propertyId } : {}), ...(leaseId ? { lease_id: leaseId } : {}) };
  const list = useListQuery<Charge>("receivables", "/receivables/charges", extra);
  const { url } = list;
  const [generating, setGenerating] = useState(false);
  const [manual, setManual] = useState(false);
  const [voiding, setVoiding] = useState<Charge | null>(null);
  const approve = useReceivablesMutation<{ id: string }, Charge>((b) => `/receivables/charges/${b.id}/approve`);
  const voidM = useReceivablesMutation<{ id: string; reason: string }, Charge>((b) => `/receivables/charges/${b.id}/void`);
  const lateFees = useReceivablesMutation<{ as_of: string; property_id?: string | null }, { created: number }>("/receivables/late-fees/assess");

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return { ...rest, ...extra };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.params, propertyId, leaseId]);
  const { data: facets } = useQuery({
    queryKey: ["receivables", "charge-facets", filterParams],
    queryFn: () => api.get<ChargeFacets>("/receivables/charges/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  for (const [k, label] of [["period", "Period"], ["due_from", "Due after"], ["due_to", "Due before"], ["overdue", "Overdue"]] as const) {
    if (url.get(k)) chips.push({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) });
  }
  for (const [k, label] of [["status", "Status"], ["charge_type", "Type"], ["source", "Source"]] as const) {
    const v = url.getAll(k);
    if (v.length) chips.unshift({ key: k, label, value: v.map((x) => (k === "charge_type" ? CHARGE_TYPE_LABELS[x] ?? x : k === "source" ? SOURCE_LABELS[x] ?? x : titleCase(x))).join(", "), onRemove: () => url.set({ [k]: null }) });
  }

  const columns: Column<Charge>[] = [
    { id: "due", header: "Due", sortKey: "due_on", cell: (c) => <span className={cn("whitespace-nowrap", c.days_past_due > 0 ? "font-medium text-negative" : "text-ink-2")}>{formatDate(c.due_on)}</span> },
    ...(leaseId ? [] : [{ id: "tenant", header: "Tenant", sortKey: "tenant_name", cell: (c: Charge) => <Link href={`/receivables/tenants/${c.lease_id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>{c.tenant_name}</Link> }]),
    {
      id: "desc",
      header: "Charge",
      sortKey: "charge_type",
      cell: (c) => (
        <div className="min-w-[160px]">
          <p className="truncate text-ink">{c.description ?? CHARGE_TYPE_LABELS[c.charge_type]}</p>
          <p className="truncate text-xs text-ink-3">{CHARGE_TYPE_LABELS[c.charge_type] ?? c.charge_type}{c.period_start ? ` · ${formatDate(c.period_start)}–${formatDate(c.period_end)}` : ""}</p>
        </div>
      ),
    },
    { id: "source", header: "Traces to", cell: (c) => <Tooltip content={JSON.stringify(c.source_ref)}><span className="text-xs text-ink-2">{sourceTrace(c)}</span></Tooltip> },
    { id: "amount", header: "Amount", sortKey: "amount", align: "right", cell: (c) => formatCurrency(c.amount) },
    { id: "balance", header: "Balance", sortKey: "balance", align: "right", cell: (c) => <span className={cn(c.balance > 0 && c.days_past_due > 0 && "font-medium text-negative")}>{formatCurrency(c.balance)}</span> },
    { id: "late", header: "Days late", align: "right", hideable: true, cell: (c) => (c.days_past_due ? c.days_past_due : "—") },
    { id: "status", header: "Status", sortKey: "status", cell: (c) => <RxStatus status={c.status} /> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) =>
        can("receivables", "approve") && c.status !== "void" ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Actions"><MoreHorizontal /></Button>
              </MenuTrigger>
              <MenuContent>
                {c.status === "pending_approval" && (
                  <MenuItem icon={<Check />} onSelect={() => approve.mutate({ id: c.id }, { onSuccess: () => toast.success("Charge approved"), onError: (e) => toast.error(errorMessage(e)) })}>
                    Approve
                  </MenuItem>
                )}
                {c.amount_paid === 0 && <MenuItem icon={<FileWarning />} destructive onSelect={() => setVoiding(c)}>Void</MenuItem>}
              </MenuContent>
            </Menu>
          </div>
        ) : null,
    },
  ];
  const cols = useColumnVisibility("receivables-charges", columns);

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  {can("receivables", "create") && (
                    <>
                      <Button onClick={() => lateFees.mutate({ as_of: today(), property_id: propertyId ?? null }, { onSuccess: (r) => toast.success(`${r.created} late fees assessed`), onError: (e) => toast.error(errorMessage(e)) })} loading={lateFees.isPending}>
                        Assess late fees
                      </Button>
                      <Button onClick={() => setManual(true)}><Plus /> One-time charge</Button>
                      {!leaseId && <Button variant="primary" onClick={() => setGenerating(true)}><RefreshCw /> Generate for period</Button>}
                    </>
                  )}
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search tenant, description…" />
              <FacetFilter label="Status" options={CHARGE_STATUSES.map((s) => ({ value: s, label: s === "pending_approval" ? "Pending approval" : titleCase(s), count: facets?.status[s] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Type" options={CHARGE_TYPES.map((t) => ({ value: t, label: CHARGE_TYPE_LABELS[t], count: facets?.charge_type[t] ?? 0 }))} selected={url.getAll("charge_type")} onChange={(v) => url.set({ charge_type: v })} />
              <FacetFilter label="Source" options={CHARGE_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s], count: facets?.source[s] ?? 0 }))} selected={url.getAll("source")} onChange={(v) => url.set({ source: v })} />
              <MoreFilters fields={CHARGE_MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(s) => url.set({ page_size: s })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          hidden={cols.hidden}
          dense
          rowClassName={(c) => (c.status === "void" ? "text-ink-3 line-through decoration-ink-3/40" : undefined)}
          empty={<EmptyState icon={<Receipt />} title="No charges" description="Generate the period's recurring charges from verified lease schedules." />}
        />
      </ListCard>
      <GenerateChargesDialog open={generating} onOpenChange={setGenerating} propertyId={propertyId} />
      <ManualChargeSheet open={manual} onOpenChange={setManual} leaseId={leaseId} />
      <ReasonDialog
        open={!!voiding}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Void this charge?"
        description="The charge stays in the ledger with a void entry."
        confirmLabel="Void charge"
        pending={voidM.isPending}
        onConfirm={(reason) => voiding && voidM.mutate({ id: voiding.id, reason }, { onSuccess: () => { toast.success("Charge voided"); setVoiding(null); }, onError: (e) => toast.error(errorMessage(e)) })}
      />
    </>
  );
}

/* ------------------------------------------------------------------ payments */

export function PaymentsTab({ propertyId, leaseId }: { propertyId?: string; leaseId?: string }) {
  const { can } = useAuth();
  const extra = { ...(propertyId ? { property_id: propertyId } : {}), ...(leaseId ? { lease_id: leaseId } : {}) };
  const list = useListQuery<Payment>("receivables", "/receivables/payments", extra);
  const { url } = list;
  const [recording, setRecording] = useState(false);
  const [selected, setSelected] = useState<Payment | null>(null);

  const columns: Column<Payment>[] = [
    { id: "received", header: "Received", sortKey: "received_on", cell: (p) => <span className="whitespace-nowrap text-ink-2">{formatDate(p.received_on)}</span> },
    ...(leaseId ? [] : [{ id: "tenant", header: "Tenant", sortKey: "tenant_name", cell: (p: Payment) => <span className="font-medium">{p.tenant_name}</span> }]),
    { id: "method", header: "Method", cell: (p) => <span className="text-ink-2">{METHOD_LABELS[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ""}</span> },
    { id: "amount", header: "Amount", sortKey: "amount", align: "right", cell: (p) => formatCurrency(p.amount) },
    { id: "applied", header: "Applied", align: "right", cell: (p) => formatCurrency(p.status === "reversed" ? 0 : p.amount - p.unapplied_amount) },
    { id: "unapplied", header: "Unapplied", sortKey: "unapplied_amount", align: "right", cell: (p) => <span className={cn(p.unapplied_amount > 0 && "font-medium text-caution")}>{formatCurrency(p.unapplied_amount)}</span> },
    { id: "status", header: "Status", cell: (p) => <RxStatus status={p.status} /> },
  ];

  return (
    <>
      <ListCard
        toolbar={
          <Toolbar right={can("receivables", "create") && <Button variant="primary" onClick={() => setRecording(true)}><Banknote /> Record payment</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search tenant, reference…" />
            <FacetFilter label="Status" options={["received", "reversed"].map((s) => ({ value: s, label: titleCase(s) }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Method" options={PAYMENT_METHODS.map((m) => ({ value: m, label: METHOD_LABELS[m] }))} selected={url.getAll("method")} onChange={(v) => url.set({ method: v })} />
            <FacetFilter label="Unapplied" single options={[{ value: "true", label: "Has unapplied cash" }]} selected={url.get("unapplied_only") ? ["true"] : []} onChange={(v) => url.set({ unapplied_only: v[0] ?? null })} />
          </Toolbar>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(s) => url.set({ page_size: s })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={setSelected}
          dense
          rowClassName={(p) => (p.status === "reversed" ? "text-ink-3" : undefined)}
          empty={<EmptyState icon={<Banknote />} title="No payments" />}
        />
      </ListCard>
      <RecordPaymentSheet open={recording} onOpenChange={setRecording} leaseId={leaseId} />
      <PaymentDialog payment={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}
