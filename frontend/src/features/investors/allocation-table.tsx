"use client";

import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency, formatNumber, titleCase } from "@/lib/utils";

import { TIER_LABELS, pct, type Calc } from "./api";

function money(v: number | null | undefined) {
  return v === null || v === undefined ? "—" : formatCurrency(v);
}

/** Tier summary + per-partner allocation with a tier breakdown, used by the wizard preview and event detail. */
export function CalcView({ calc, eventType }: { calc: Calc; eventType: string }) {
  const tiers = calc.tiers ?? [];
  const tierKeys = tiers.map((t) => t.position);
  const isCall = eventType === "call";

  return (
    <div className="space-y-4">
      {calc.warnings?.length > 0 && (
        <div className="space-y-1 rounded-md border border-caution/30 bg-caution-soft px-3 py-2 text-sm text-caution">
          {calc.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {w}
            </p>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-line scrollbar-thin">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-xs text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Tier</th>
              {!isCall && <th className="px-3 py-2 text-left font-medium">Hurdle</th>}
              <th className="px-3 py-2 text-right font-medium">LP</th>
              <th className="px-3 py-2 text-right font-medium">GP</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              {!isCall && <th className="px-3 py-2 text-right font-medium">LP IRR after</th>}
              {!isCall && <th className="px-3 py-2 text-right font-medium">LP multiple after</th>}
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.position} className="border-t border-line">
                <td className="px-3 py-1.5">
                  <span className="text-ink-3 tabular">{t.position}.</span> {t.name && t.name !== t.tier_type ? t.name : TIER_LABELS[t.tier_type] ?? titleCase(t.tier_type)}
                </td>
                {!isCall && (
                  <td className="px-3 py-1.5 text-ink-2">
                    {t.hurdle_type === "irr" && t.hurdle_value != null ? `${formatNumber(t.hurdle_value * 100, 2)}% IRR` : t.hurdle_type === "equity_multiple" && t.hurdle_value != null ? `${formatNumber(t.hurdle_value, 2)}x` : "—"}
                  </td>
                )}
                <td className="px-3 py-1.5 text-right tabular">{money(t.lp_amount)}</td>
                <td className="px-3 py-1.5 text-right tabular">{money(t.gp_amount)}</td>
                <td className="px-3 py-1.5 text-right font-medium tabular">{money(t.amount)}</td>
                {!isCall && <td className="px-3 py-1.5 text-right tabular text-ink-2">{pct(t.lp_irr_after, 2)}</td>}
                {!isCall && <td className="px-3 py-1.5 text-right tabular text-ink-2">{t.lp_multiple_after != null ? `${formatNumber(t.lp_multiple_after, 2)}x` : "—"}</td>}
              </tr>
            ))}
            <tr className="border-t border-line bg-subtle/60 font-medium">
              <td className="px-3 py-1.5" colSpan={isCall ? 1 : 2}>
                Allocated
              </td>
              <td className="px-3 py-1.5 text-right tabular">{money(tiers.reduce((s, t) => s + t.lp_amount, 0))}</td>
              <td className="px-3 py-1.5 text-right tabular">{money(tiers.reduce((s, t) => s + t.gp_amount, 0))}</td>
              <td className="px-3 py-1.5 text-right tabular">{money(calc.allocated)}</td>
              {!isCall && <td colSpan={2} />}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-md border border-line scrollbar-thin">
        <table className="w-full text-sm">
          <thead className="bg-subtle text-xs text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Partner</th>
              <th className="px-3 py-2 text-right font-medium">Ownership</th>
              {isCall ? (
                <>
                  <th className="px-3 py-2 text-right font-medium">Commitment</th>
                  <th className="px-3 py-2 text-right font-medium">Unfunded before</th>
                </>
              ) : (
                <>
                  <th className="px-3 py-2 text-right font-medium">Unreturned capital</th>
                  <th className="px-3 py-2 text-right font-medium">Accrued pref</th>
                  {tierKeys.map((k) => {
                    const t = tiers.find((x) => x.position === k)!;
                    return (
                      <th key={k} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                        {t.name && t.name !== t.tier_type ? t.name : TIER_LABELS[t.tier_type] ?? titleCase(t.tier_type)}
                      </th>
                    );
                  })}
                </>
              )}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {calc.allocations.map((a) => (
              <tr key={a.investment_id} className="border-t border-line">
                <td className="px-3 py-1.5">
                  <span className="font-medium text-ink">{a.name}</span>{" "}
                  <Badge tone={a.position === "gp" ? "blue" : "outline"}>{a.position.toUpperCase()}</Badge>
                  {a.exceeds_unfunded && (
                    <Badge tone="red" className="ml-1">
                      Exceeds unfunded
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular">{formatNumber(a.ownership_pct, 4)}%</td>
                {isCall ? (
                  <>
                    <td className="px-3 py-1.5 text-right tabular">{money(a.commitment)}</td>
                    <td className="px-3 py-1.5 text-right tabular">{money(a.unfunded_before)}</td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-1.5 text-right tabular text-ink-2">{money(a.unreturned_capital_before)}</td>
                    <td className="px-3 py-1.5 text-right tabular text-ink-2">{money(a.pref_unpaid_before)}</td>
                    {tierKeys.map((k) => {
                      const amt = a.tiers.filter((t) => t.tier === k).reduce((s, t) => s + t.amount, 0);
                      return (
                        <td key={k} className={cn("px-3 py-1.5 text-right tabular", !amt && "text-ink-3")}>
                          {amt ? formatCurrency(amt) : "—"}
                        </td>
                      );
                    })}
                  </>
                )}
                <td className="px-3 py-1.5 text-right font-medium tabular">{money(a.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {calc.waterfall && (
        <p className="text-xs text-ink-3">
          Waterfall {calc.waterfall.name} · config v{calc.waterfall.version}
        </p>
      )}
    </div>
  );
}
