"use client";

import type { ReactNode } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatCurrency, formatDate, formatNumber, titleCase } from "@/lib/utils";

import { PACKAGE_LABELS, type ReportPackage } from "./api";

type Row = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));

function SimpleTable({ cols, rows }: { cols: { key: string; label: string; money?: boolean; pct?: boolean; render?: (r: Row) => ReactNode }[]; rows: Row[] }) {
  if (!rows.length) return <p className="text-sm text-ink-3">Nothing to report for this period.</p>;
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-sm">
        <thead className="text-xs text-ink-3">
          <tr className="border-b border-line">
            {cols.map((c) => (
              <th key={c.key} className={`px-2 py-1.5 font-medium ${c.money || c.pct ? "text-right" : "text-left"}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {cols.map((c) => (
                <td key={c.key} className={`px-2 py-1.5 ${c.money || c.pct ? "text-right tabular" : ""}`}>
                  {c.render ? c.render(r) : c.money ? formatCurrency(num(r[c.key])) : c.pct ? `${formatNumber(num(r[c.key]), 4)}%` : String(r[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Read-only rendering of a frozen report package snapshot. */
export function PackageView({ pkg }: { pkg: ReportPackage }) {
  const s = (pkg.snapshot.sections ?? {}) as Record<string, Row>;
  const ca = s.capital_accounts as { accounts?: Row[]; totals?: Row; as_of?: string } | undefined;
  const dist = s.distributions as { items?: Row[]; total?: number } | undefined;
  const port = s.portfolio as { investments?: Row[]; totals?: Row } | undefined;
  const val = s.valuation as { items?: Row[] } | undefined;
  const perf = s.property_performance as { assets?: Row[] } | undefined;

  return (
    <div className="space-y-4">
      <div className="text-sm text-ink-2">
        <p>
          Period {formatDate(pkg.period_start)} – {formatDate(pkg.period_end)} · {pkg.package_types.map((t) => PACKAGE_LABELS[t] ?? t).join(", ")}
        </p>
        {pkg.snapshot.data_policy && <p className="mt-1 text-xs text-ink-3">{pkg.snapshot.data_policy}</p>}
      </div>

      {ca && (
        <Card>
          <CardHeader title="Capital accounts" description={ca.as_of ? `As of ${formatDate(ca.as_of)}` : undefined} />
          <CardBody>
            <SimpleTable
              rows={ca.accounts ?? []}
              cols={[
                { key: "asset_label", label: "Asset" },
                { key: "commitment", label: "Commitment", money: true },
                { key: "contributions", label: "Contributed", money: true },
                { key: "distributions", label: "Distributed", money: true },
                { key: "income_allocated", label: "Income", money: true },
                { key: "loss_allocated", label: "Loss", money: true },
                { key: "unreturned_capital", label: "Unreturned", money: true },
                { key: "accrued_pref", label: "Accrued pref", money: true },
                { key: "ending_balance", label: "Balance", money: true },
              ]}
            />
          </CardBody>
        </Card>
      )}

      {dist && (
        <Card>
          <CardHeader title="Distributions" description={`Total ${formatCurrency(dist.total ?? 0)}`} />
          <CardBody>
            <SimpleTable
              rows={dist.items ?? []}
              cols={[
                { key: "date", label: "Date", render: (r) => formatDate(r.date as string) },
                { key: "event", label: "Event" },
                { key: "asset", label: "Asset" },
                { key: "amount", label: "Amount", money: true },
              ]}
            />
          </CardBody>
        </Card>
      )}

      {port && (
        <Card>
          <CardHeader title="Portfolio" />
          <CardBody>
            <SimpleTable
              rows={port.investments ?? []}
              cols={[
                { key: "asset", label: "Asset" },
                { key: "status", label: "Status", render: (r) => titleCase(r.status as string) },
                { key: "ownership_pct", label: "Ownership", pct: true },
                { key: "commitment", label: "Commitment", money: true },
                { key: "funded", label: "Funded", money: true },
                { key: "unfunded", label: "Unfunded", money: true },
              ]}
            />
          </CardBody>
        </Card>
      )}

      {val && (
        <Card>
          <CardHeader title="Valuation" description="Approved valuations only; share shown before debt." />
          <CardBody>
            <SimpleTable
              rows={val.items ?? []}
              cols={[
                { key: "asset", label: "Asset" },
                { key: "as_of", label: "As of", render: (r) => formatDate(r.as_of as string) },
                { key: "method", label: "Method", render: (r) => titleCase(r.method as string) },
                { key: "value_point", label: "Value", money: true },
                { key: "gross_value_share", label: "Your share (gross)", money: true },
              ]}
            />
          </CardBody>
        </Card>
      )}

      {perf && (
        <Card>
          <CardHeader title="Property performance" description="Recorded actuals and verified property facts" />
          <CardBody className="space-y-4">
            {(perf.assets ?? []).map((a, i) => {
              const fin = (a.financials ?? {}) as Record<string, number>;
              const facts = (a.facts ?? {}) as Record<string, { value: unknown; source: string }>;
              return (
                <div key={i}>
                  <p className="mb-1 text-sm font-medium text-ink">{String(a.asset ?? "Asset")}</p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                    {Object.entries(fin).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <span className="text-ink-3">{k === "noi" ? "NOI" : titleCase(k)}</span>
                        <span className="tabular">{formatCurrency(v)}</span>
                      </div>
                    ))}
                    {Object.entries(facts).map(([k, f]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <span className="text-ink-3">{titleCase(k)}</span>
                        <span className="tabular">{typeof f.value === "number" ? formatNumber(f.value, 2) : String(f.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}

      {pkg.excluded?.length > 0 && (
        <Card>
          <CardHeader title="Excluded from this package" description="Items that were not verified or not available are left out rather than estimated." />
          <CardBody>
            <ul className="space-y-1 text-sm text-ink-2">
              {pkg.excluded.map((x, i) => (
                <li key={i}>
                  <span className="text-ink-3">{PACKAGE_LABELS[x.section] ?? titleCase(x.section)}:</span> {x.item ? `${titleCase(String(x.item))} — ` : ""}
                  {x.reason}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
