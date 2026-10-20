"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

import { useRollover, type RolloverYear } from "./api";

type Row = RolloverYear & { id: string };

const columns: Column<Row>[] = [
  { id: "year", header: "Year", cell: (r) => <span className="font-medium tabular">{r.year}</span> },
  { id: "leases", header: "Leases", align: "right", cell: (r) => formatNumber(r.lease_count) },
  { id: "sf", header: "SF expiring", align: "right", cell: (r) => formatNumber(r.sf) },
  { id: "rent", header: "Rent at risk", align: "right", cell: (r) => formatCurrency(r.rent_at_risk) },
  { id: "pct", header: "% of rent", align: "right", cell: (r) => formatPercent(r.pct_of_rent, 1) },
  { id: "prob", header: "Renewal prob.", align: "right", cell: (r) => (r.renewal_probability != null ? formatPercent(r.renewal_probability * 100, 0) : "—") },
  { id: "down", header: "Downtime cost", align: "right", cell: (r) => formatCurrency(r.expected_downtime_cost) },
  { id: "releasing", header: "Re-leasing cost", align: "right", cell: (r) => formatCurrency(r.expected_releasing_cost) },
];

export function RolloverView({ propertyId, years = 10 }: { propertyId: string | null; years?: number }) {
  const { data, isLoading } = useRollover(propertyId, years);
  const rows: Row[] | undefined = data?.years.map((y) => ({ ...y, id: String(y.year) }));
  const atRisk5 = data?.years.slice(0, 5).reduce((s, y) => s + y.rent_at_risk, 0) ?? 0;
  const expectedCost = data?.years.reduce((s, y) => s + y.expected_downtime_cost + y.expected_releasing_cost, 0) ?? 0;
  const peak = data?.years.reduce<RolloverYear | null>((m, y) => (!m || y.rent_at_risk > m.rent_at_risk ? y : m), null);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="In-place rent" value={data ? formatCurrency(data.total_rent, { compact: true }) : "—"} />
        <StatCard label="Rent rolling in 5 years" value={formatCurrency(atRisk5, { compact: true })} hint={data?.total_rent ? `${formatPercent((atRisk5 / data.total_rent) * 100, 0)} of rent` : undefined} />
        <StatCard label="Peak rollover year" value={peak && peak.rent_at_risk > 0 ? peak.year : "—"} hint={peak && peak.rent_at_risk > 0 ? formatCurrency(peak.rent_at_risk, { compact: true }) : undefined} />
        <StatCard label="Expected rollover cost" value={formatCurrency(expectedCost, { compact: true })} hint="Downtime + re-leasing, probability weighted" />
      </div>
      <Card>
        <CardHeader title="Rent at risk by expiration year" description="Current annual rent of leases expiring each year" />
        <CardBody>
          {!data || data.years.every((y) => y.rent_at_risk === 0) ? (
            <p className="py-10 text-center text-sm text-ink-3">{isLoading ? "Loading…" : "No expirations in the horizon"}</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.years} margin={{ top: 4, right: 4, bottom: 0, left: 8 }} barCategoryGap={6}>
                  <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} tickFormatter={(v: number) => formatCurrency(v, { compact: true })} />
                  <ChartTooltip
                    cursor={{ fill: "rgb(var(--muted))" }}
                    content={({ active, payload }) =>
                      active && payload?.length ? (
                        <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                          <p className="text-ink-3">{(payload[0].payload as RolloverYear).year}</p>
                          <p className="font-medium text-ink tabular">{formatCurrency(payload[0].value as number)} at risk</p>
                          <p className="text-ink-3 tabular">
                            {formatNumber((payload[0].payload as RolloverYear).lease_count)} leases · {formatNumber((payload[0].payload as RolloverYear).sf)} SF
                          </p>
                        </div>
                      ) : null
                    }
                  />
                  <Bar dataKey="rent_at_risk" fill="rgb(var(--accent))" radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>
      <Card className="overflow-hidden">
        <DataTable columns={columns} data={rows} loading={isLoading} dense empty={<EmptyState title="No leases in place" />} />
      </Card>
    </div>
  );
}
