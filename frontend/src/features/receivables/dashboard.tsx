"use client";

import { Receipt } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Card, CardHeader } from "@/components/ui/card";
import { cn, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

import { BUCKETS, bucketPastDue, useDashboard, type Buckets, type DashboardRow } from "./api";

export function AgingCards({ totals, unapplied, compact }: { totals?: Buckets; unapplied?: number; compact?: boolean }) {
  const tone = (key: string, v: number) => (v <= 0 ? "default" : key === "d90_plus" || key === "d61_90" ? "negative" : key === "current" ? "default" : "caution");
  return (
    <div className={cn("grid grid-cols-2 gap-3", compact ? "lg:grid-cols-6" : "md:grid-cols-3 xl:grid-cols-7")}>
      {BUCKETS.map((b) => {
        const v = totals?.[b.key] ?? 0;
        return <StatCard key={b.key} label={b.label} value={totals ? formatCurrency(v, { compact: true }) : "—"} tone={tone(b.key, v)} />;
      })}
      <StatCard label="Total receivable" value={totals ? formatCurrency(totals.total, { compact: true }) : "—"} hint={totals ? `${formatCurrency(bucketPastDue(totals), { compact: true })} past due` : undefined} />
      {!compact && <StatCard label="Unapplied cash" value={unapplied != null ? formatCurrency(unapplied, { compact: true }) : "—"} />}
    </div>
  );
}

export function bucketColumns<T extends { buckets: Buckets }>(): Column<T>[] {
  return [
    ...BUCKETS.map((b) => ({
      id: b.key,
      header: b.label,
      align: "right" as const,
      cell: (r: T) => {
        const v = r.buckets[b.key];
        return <span className={cn(Math.abs(v) < 0.005 && "text-ink-3", v > 0 && (b.key === "d61_90" || b.key === "d90_plus") && "font-medium text-negative")}>{formatCurrency(v)}</span>;
      },
    })),
    { id: "total", header: "Total", align: "right" as const, cell: (r: T) => <span className="font-medium">{formatCurrency(r.buckets.total)}</span> },
  ];
}

const propertyColumns: Column<DashboardRow>[] = [
  {
    id: "label",
    header: "Asset",
    cell: (r) => (
      <Link href={`/properties/${r.property_id}?tab=receivables`} className="font-medium text-ink hover:underline">
        {r.label}
      </Link>
    ),
  },
  { id: "tenants", header: "Tenants", align: "right", cell: (r) => formatNumber(r.tenants) },
  ...bucketColumns<DashboardRow>(),
];

const tenantColumns: Column<DashboardRow>[] = [
  { id: "label", header: "Tenant", cell: (r) => <span className="font-medium text-ink">{r.label}</span> },
  ...bucketColumns<DashboardRow>(),
  { id: "unapplied", header: "Unapplied", align: "right", cell: (r) => formatCurrency(r.unapplied) },
];

export function ReceivablesDashboard({ propertyId, assetId }: { propertyId?: string | null; assetId?: string | null }) {
  const { data, isLoading } = useDashboard({ property_id: propertyId, asset_id: assetId });

  return (
    <div className="space-y-5">
      <AgingCards totals={data?.totals} unapplied={data?.unapplied} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Billed this month" value={data ? formatCurrency(data.billed_this_month, { compact: true }) : "—"} />
        <StatCard label="Collected this month" value={data ? formatCurrency(data.collected_this_month, { compact: true }) : "—"} />
        <StatCard label="Collection rate" value={data?.collection_rate != null ? formatPercent(data.collection_rate, 1) : "—"} hint="Collected ÷ billed, month to date" />
        <StatCard label="Delinquent tenants" value={data ? formatNumber(data.delinquent_tenants) : "—"} tone={data?.delinquent_tenants ? "caution" : "default"} />
      </div>
      {!propertyId && (
        <Card className="overflow-hidden">
          <CardHeader title="Aging by asset" />
          <DataTable columns={propertyColumns} data={data?.by_property} loading={isLoading} dense empty={<EmptyState icon={<Receipt />} title="No open receivables" />} />
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader title="Most past-due tenants" description="Open the ledger for detail" />
        <DataTable
          columns={tenantColumns}
          data={data?.by_tenant}
          loading={isLoading}
          dense
          rowHref={(r) => `/receivables/tenants/${r.lease_id}`}
          empty={<EmptyState title="No tenants past due" />}
        />
      </Card>
    </div>
  );
}
