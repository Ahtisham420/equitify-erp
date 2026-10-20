"use client";

import { EmptyState } from "@/components/data/page";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";

import type { AccountSummary } from "./api";

const COLS: { key: keyof AccountSummary; label: string }[] = [
  { key: "commitment", label: "Commitment" },
  { key: "contributions", label: "Contributions" },
  { key: "distributions", label: "Distributions" },
  { key: "return_of_capital", label: "Return of capital" },
  { key: "preferred_paid", label: "Pref paid" },
  { key: "profit_distributions", label: "Profit / promote" },
  { key: "income_allocated", label: "Income" },
  { key: "loss_allocated", label: "Loss" },
  { key: "unreturned_capital", label: "Unreturned capital" },
  { key: "accrued_pref", label: "Accrued pref" },
  { key: "unfunded", label: "Unfunded" },
  { key: "ending_balance", label: "Ending balance" },
];

/** Capital account roll-forward per investment with a totals row. */
export function StatementTable({ accounts, totals }: { accounts: AccountSummary[]; totals: Record<string, number> }) {
  if (!accounts.length) return <EmptyState title="No capital account activity" />;
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-xs text-ink-3">
          <tr>
            <th className="sticky left-0 bg-subtle px-3 py-2 text-left font-medium">Asset</th>
            {COLS.map((c) => (
              <th key={c.key} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.investment_id} className="border-t border-line">
              <td className="sticky left-0 whitespace-nowrap bg-surface px-3 py-1.5">
                <span className="font-medium">{a.asset_label}</span>{" "}
                <span className="text-xs text-ink-3">
                  {a.position.toUpperCase()} · {formatNumber(a.ownership_pct, 2)}%
                </span>
              </td>
              {COLS.map((c) => (
                <td key={c.key} className={cn("px-3 py-1.5 text-right tabular", c.key === "ending_balance" && "font-medium")}>
                  {formatCurrency(a[c.key] as number)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-line bg-subtle/60 font-medium">
            <td className="sticky left-0 bg-subtle px-3 py-1.5">Total</td>
            {COLS.map((c) => (
              <td key={c.key} className="px-3 py-1.5 text-right tabular">
                {formatCurrency(totals[c.key])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
