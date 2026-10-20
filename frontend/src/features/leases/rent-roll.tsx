"use client";

import { ScrollText } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent } from "@/lib/utils";

import { LEASE_TYPE_LABELS, useRentRoll, type RentRoll, type RentRollRow } from "./api";

const TOTALS_ID = "__totals";

function totalsRow(r: RentRoll): RentRollRow {
  return {
    id: TOTALS_ID, lease_id: null, property_id: "", property_name: null, space_id: null, suite: null, tenant_name: "Total",
    lease_type: null, status: "", sf: r.totals.total_sf, annual_rent: r.totals.annual_rent, monthly_rent: r.totals.monthly_rent,
    rent_psf: r.totals.avg_rent_psf, commencement_on: null, expiration_on: null, remaining_years: r.totals.wale_years, verified: null,
  };
}

function columns(showProperty: boolean): Column<RentRollRow>[] {
  const cols: Column<RentRollRow>[] = [
    { id: "suite", header: "Suite", cell: (r) => (r.id === TOTALS_ID ? "" : <span className="text-ink-2">{r.suite ?? "—"}</span>) },
    {
      id: "tenant",
      header: "Tenant",
      cell: (r) =>
        r.id === TOTALS_ID ? (
          <span className="font-semibold">Total</span>
        ) : r.lease_id ? (
          <Link href={`/leases/${r.lease_id}`} className="font-medium text-ink hover:underline">{r.tenant_name}</Link>
        ) : (
          <Badge tone="outline">Vacant</Badge>
        ),
    },
    { id: "type", header: "Type", cell: (r) => <span className="text-ink-2">{r.lease_type ? LEASE_TYPE_LABELS[r.lease_type] ?? r.lease_type : ""}</span> },
    { id: "sf", header: "SF", align: "right", cell: (r) => formatNumber(r.sf) },
    { id: "annual", header: "Annual rent", align: "right", cell: (r) => (r.annual_rent != null ? formatCurrency(r.annual_rent) : "—") },
    { id: "monthly", header: "Monthly", align: "right", cell: (r) => (r.monthly_rent != null ? formatCurrency(r.monthly_rent) : "—") },
    { id: "psf", header: "Rent / SF", align: "right", cell: (r) => (r.rent_psf != null ? `$${formatNumber(r.rent_psf, 2)}` : "—") },
    { id: "commence", header: "Commenced", cell: (r) => <span className="whitespace-nowrap text-ink-2">{r.id === TOTALS_ID ? "" : formatDate(r.commencement_on)}</span> },
    { id: "expire", header: "Expires", cell: (r) => <span className="whitespace-nowrap text-ink-2">{r.id === TOTALS_ID ? "" : formatDate(r.expiration_on)}</span> },
    {
      id: "remaining",
      header: "Remaining",
      align: "right",
      cell: (r) => (r.remaining_years != null ? `${formatNumber(r.remaining_years, 1)} yrs${r.id === TOTALS_ID ? " WALE" : ""}` : "—"),
    },
    {
      id: "verified",
      header: "",
      cell: (r) => (r.verified === false ? <Badge tone="amber" dot>Unverified</Badge> : null),
    },
  ];
  if (showProperty) cols.unshift({ id: "property", header: "Property", cell: (r) => <span className="text-ink-2">{r.id === TOTALS_ID ? "" : r.property_name}</span> });
  return cols;
}

export function RentRollView({ propertyId, showProperty = false }: { propertyId: string | null; showProperty?: boolean }) {
  const { data, isLoading } = useRentRoll(propertyId);
  const t = data?.totals;
  const rows = data ? (data.rows.length ? [...data.rows, totalsRow(data)] : []) : undefined;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Occupancy" value={t?.occupancy_pct != null ? formatPercent(t.occupancy_pct, 1) : "—"} hint={t ? `${formatNumber(t.leased_sf)} of ${formatNumber(t.total_sf)} SF` : undefined} />
        <StatCard label="Annual rent" value={t ? formatCurrency(t.annual_rent, { compact: true }) : "—"} hint={t ? `${formatCurrency(t.monthly_rent)} / mo` : undefined} />
        <StatCard label="Avg rent / SF" value={t?.avg_rent_psf != null ? `$${formatNumber(t.avg_rent_psf, 2)}` : "—"} />
        <StatCard label="WALE" value={t?.wale_years != null ? `${formatNumber(t.wale_years, 1)} yrs` : "—"} hint="Weighted by rent" />
        <StatCard label="Tenants" value={t ? formatNumber(t.tenant_count) : "—"} hint={t && t.vacant_sf ? `${formatNumber(t.vacant_sf)} SF vacant` : undefined} />
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns(showProperty)}
          data={rows}
          loading={isLoading}
          dense
          rowClassName={(r) => cn(r.id === TOTALS_ID && "bg-subtle font-medium", r.status === "vacant" && "bg-subtle/40")}
          empty={<EmptyState icon={<ScrollText />} title="No tenants in place" description="Active leases and vacant spaces appear here as of today." />}
        />
      </Card>
    </div>
  );
}
