"use client";

import { AlertTriangle, Lock, Play, Plus, Send, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { EmptyState, StatCard } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime, formatNumber, titleCase } from "@/lib/utils";

import {
  LAND_PATHS,
  MODEL_PATHS,
  OUTPUT_LABELS,
  formatOutput,
  useDecision,
  useDiff,
  useSaveScenarios,
  useSensitivity,
  useSimulate,
  useUwEvents,
  useVariance,
  useVersions,
  type Scenario,
  type SimRange,
  type UwModel,
  type VarianceCell,
} from "./api";
import { NumInput } from "./fields";

const money = (v: unknown) => (typeof v === "number" ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v) : "—");
const AXIS_TICK = { fontSize: 11, fill: "rgb(var(--ink-3))" };

/* ------------------------------------------------------------------ cash flow */

const INCOME_ROWS: { key: string; label: string; strong?: boolean; pct?: boolean }[] = [
  { key: "base_rent", label: "Base rent" },
  { key: "abatements", label: "Abatements / free rent" },
  { key: "percentage_rent", label: "Percentage rent" },
  { key: "recoveries", label: "Recoveries" },
  { key: "other_income", label: "Other income" },
  { key: "general_vacancy", label: "General vacancy" },
  { key: "credit_loss", label: "Credit loss" },
  { key: "egr", label: "Effective gross revenue", strong: true },
  { key: "expenses", label: "Operating expenses" },
  { key: "mgmt_fee", label: "Management fee" },
  { key: "noi", label: "Net operating income", strong: true },
  { key: "ti", label: "Tenant improvements" },
  { key: "lc", label: "Leasing commissions" },
  { key: "reserves", label: "Reserves" },
  { key: "capex", label: "Capital expenditures" },
  { key: "cf_unlevered", label: "Cash flow before debt", strong: true },
  { key: "interest", label: "Interest" },
  { key: "principal", label: "Principal" },
  { key: "debt_service", label: "Debt service" },
  { key: "cf_levered", label: "Cash flow after debt", strong: true },
  { key: "occupancy_pct", label: "Average occupancy", pct: true },
];
const LAND_ROWS: { key: string; label: string; strong?: boolean; pct?: boolean }[] = [
  { key: "sales", label: "Land sales" },
  { key: "income", label: "Ground lease income" },
  { key: "selling_costs", label: "Selling costs" },
  { key: "development", label: "Entitlement and development" },
  { key: "carry", label: "Carry" },
  { key: "cf_unlevered", label: "Cash flow before debt", strong: true },
  { key: "interest", label: "Interest" },
  { key: "cf_levered", label: "Cash flow after debt", strong: true },
];

export function CashFlowTab({ model }: { model: UwModel }) {
  const rows = model.assumptions.model_type === "land" ? LAND_ROWS : INCOME_ROWS;
  const years = model.annual;
  const unlev = model.outputs.cash_flows_unlevered ?? [];
  const lev = model.outputs.cash_flows_levered ?? [];
  if (!years.length) return <EmptyState title="No cash flows yet" description="Enter assumptions and save to calculate." />;
  const th = "sticky top-0 whitespace-nowrap border-b border-line bg-subtle px-3 py-2 text-right text-xs font-medium text-ink-3";
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader title="Annual cash flow" description={years[0]?.period_start ? `${years.length} years from ${String(years[0].period_start)}` : `${years.length} years`} />
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className={cn(th, "sticky left-0 z-10 min-w-[200px] text-left")}>Line item</th>
                {years.map((y) => (
                  <th key={String(y.year)} className={th}>Year {String(y.year)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={cn(r.strong && "bg-subtle/50")}>
                  <td className={cn("sticky left-0 border-b border-line bg-surface px-3 py-1.5", r.strong ? "font-medium text-ink" : "text-ink-2")}>{r.label}</td>
                  {years.map((y) => {
                    const v = y[r.key];
                    return (
                      <td key={String(y.year)} className={cn("whitespace-nowrap border-b border-line px-3 py-1.5 text-right tabular", r.strong && "font-medium", typeof v === "number" && v < 0 && "text-negative")}>
                        {r.pct ? (typeof v === "number" ? `${v.toFixed(1)}%` : "—") : money(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Investment cash flows" description="Year 0 is the purchase (and loan funding); the final year includes net sale proceeds and loan payoff." />
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className={cn(th, "min-w-[200px] text-left")}>Series</th>
                {unlev.map((_, i) => (
                  <th key={i} className={th}>Year {i}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[["Unlevered", unlev], ["Levered", lev]].map(([label, cfs]) => (
                <tr key={label as string}>
                  <td className="border-b border-line px-3 py-1.5 font-medium text-ink">{label as string}</td>
                  {(cfs as number[]).map((v, i) => (
                    <td key={i} className={cn("whitespace-nowrap border-b border-line px-3 py-1.5 text-right tabular", v < 0 && "text-negative")}>{money(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ returns */

const INCOME_STATS = ["purchase_price", "total_capitalization", "loan_amount", "equity", "noi_year1", "going_in_cap", "stabilized_cap", "dscr", "debt_yield", "cash_on_cash", "unlevered_irr", "irr", "equity_multiple", "exit_value", "exit_cap", "peak_equity", "breakeven_occupancy", "profit"];
const LAND_STATS = ["purchase_price", "total_capitalization", "loan_amount", "equity", "usable_acres", "price_per_usable_acre", "price_per_frontage_ft", "total_development_cost", "total_carry", "gross_revenue", "exit_value", "unlevered_irr", "irr", "equity_multiple", "peak_equity", "profit"];
const LAND_LABELS: Record<string, string> = {
  usable_acres: "Usable acres", price_per_usable_acre: "Price / usable acre", price_per_frontage_ft: "Price / frontage ft",
  total_development_cost: "Development cost", total_carry: "Total carry", gross_revenue: "Gross revenue", exit_value: "Gross sales / exit",
};

function VarianceCellView({ c }: { c: VarianceCell }) {
  return (
    <td className="border-b border-line px-3 py-1.5 text-right tabular">
      <p>{money(c.actual)}</p>
      <p className="text-2xs text-ink-3">UW {money(c.uw)}</p>
      {c.variance_pct !== null && <p className={cn("text-2xs", c.variance_pct >= 0 ? "text-positive" : "text-negative")}>{c.variance_pct >= 0 ? "+" : ""}{c.variance_pct.toFixed(1)}%</p>}
    </td>
  );
}

export function ReturnsTab({ model }: { model: UwModel }) {
  const o = model.outputs;
  const land = model.assumptions.model_type === "land";
  const keys = land ? LAND_STATS : INCOME_STATS;
  const variance = useVariance(model.id, model.status === "approved" || model.status === "superseded");
  const constraints = (o.loan_constraints ?? {}) as Record<string, number | null>;
  return (
    <div className="space-y-4">
      {model.warnings.length > 0 && (
        <div className="rounded-lg border border-caution/30 bg-caution-soft px-4 py-3 text-sm text-ink-2">
          {model.warnings.map((w) => (
            <p key={w} className="flex items-center gap-2"><AlertTriangle className="size-4 text-caution" />{w}</p>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {keys.map((k) => (
          <StatCard
            key={k}
            label={OUTPUT_LABELS[k] ?? LAND_LABELS[k] ?? titleCase(k)}
            value={k === "usable_acres" ? formatNumber(o[k] as number | null, 2) : formatOutput(k, o[k])}
            tone={k === "irr" && typeof o.irr === "number" ? (o.irr < 0 ? "negative" : undefined) : k === "dscr" && typeof o.dscr === "number" && o.dscr < 1.2 ? "caution" : undefined}
          />
        ))}
      </div>
      {!land && (
        <Card>
          <CardHeader title="Debt sizing" description="The loan is the smallest of the constraints below." />
          <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            {(["ltv", "dscr", "debt_yield"] as const).map((k) => (
              <div key={k}>
                <p className="text-xs text-ink-3">{k === "ltv" ? "LTV constraint" : k === "dscr" ? "DSCR constraint" : "Debt-yield constraint"}</p>
                <p className={cn("font-medium tabular", o.loan_constraint === k ? "text-ink" : "text-ink-2")}>
                  {money(constraints[k])}
                  {o.loan_constraint === k && <Badge tone="blue" className="ml-2">Binding</Badge>}
                </p>
              </div>
            ))}
            <div>
              <p className="text-xs text-ink-3">Annual debt service (Y1)</p>
              <p className="font-medium tabular">{money(o.annual_debt_service)}</p>
            </div>
          </CardBody>
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader title="Actual vs underwriting" description="Post-close actuals from asset management compared with the approved version, by analysis year (pro-rated for partial years)." />
        {model.status !== "approved" && model.status !== "superseded" ? (
          <CardBody><p className="text-sm text-ink-3">Available for approved versions.</p></CardBody>
        ) : variance.isLoading ? (
          <CardBody><Skeleton className="h-16 w-full" /></CardBody>
        ) : !variance.data?.available || !variance.data.rows.length ? (
          <CardBody><p className="text-sm text-ink-3">{variance.data?.reason ?? errorMessage(variance.error)}</p></CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-xs text-ink-3">
                  {["Year", "Income", "Expense", "NOI", "Capex / TI / LC", "Debt service"].map((h, i) => (
                    <th key={h} className={cn("border-b border-line bg-subtle px-3 py-2 font-medium", i ? "text-right" : "text-left")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {variance.data.rows.map((r) => (
                  <tr key={r.year}>
                    <td className="border-b border-line px-3 py-1.5">Year {r.year}<p className="text-2xs text-ink-3">{r.months_actual} months of actuals</p></td>
                    <VarianceCellView c={r.income} />
                    <VarianceCellView c={r.expense} />
                    <VarianceCellView c={r.noi} />
                    <VarianceCellView c={r.capex} />
                    <VarianceCellView c={r.debt_service} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ scenarios */

type OverrideRow = { path: string; mode: "abs" | "delta" | "mult"; value: string };

function toRows(overrides: Record<string, unknown>): OverrideRow[] {
  return Object.entries(overrides).map(([path, v]) => {
    if (v && typeof v === "object" && "delta" in (v as object)) return { path, mode: "delta", value: String((v as { delta: number }).delta) };
    if (v && typeof v === "object" && "mult" in (v as object)) return { path, mode: "mult", value: String((v as { mult: number }).mult) };
    return { path, mode: "abs", value: String(v ?? "") };
  });
}

function fromRows(rows: OverrideRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const n = Number(r.value);
    if (!r.path.trim() || r.value.trim() === "" || !Number.isFinite(n)) continue;
    out[r.path.trim()] = r.mode === "delta" ? { delta: n } : r.mode === "mult" ? { mult: n } : n;
  }
  return out;
}

const COMPARE = ["purchase_price", "noi_year1", "going_in_cap", "loan_amount", "dscr", "cash_on_cash", "unlevered_irr", "irr", "equity_multiple", "exit_value", "peak_equity", "profit"];

export function ScenariosTab({ model, readOnly, onSaved }: { model: UwModel; readOnly: boolean; onSaved: (m: UwModel) => void }) {
  const save = useSaveScenarios(model.id);
  const [draft, setDraft] = useState<{ key: string; name: string; kind: Scenario["kind"]; rows: OverrideRow[] }[]>([]);
  useEffect(() => setDraft(model.scenarios.map((s) => ({ key: s.key, name: s.name, kind: s.kind, rows: toRows(s.overrides ?? {}) }))), [model.scenarios]);
  const paths = model.assumptions.model_type === "land" ? LAND_PATHS : MODEL_PATHS;

  const persist = () =>
    save.mutate(
      { scenarios: draft.map((s) => ({ key: s.key, name: s.name, kind: s.kind, overrides: s.kind === "base" ? {} : fromRows(s.rows) })) },
      { onSuccess: (m) => { toast.success(m.id !== model.id ? `Saved as version ${m.version}` : "Scenarios saved"); onSaved(m); }, onError: (e) => toast.error(errorMessage(e)) },
    );
  const upd = (i: number, patch: Partial<(typeof draft)[number]>) => setDraft((d) => d.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader title="Scenario comparison" description="Each scenario is the base assumptions with the overrides below applied." />
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className="border-b border-line bg-subtle px-3 py-2 text-left text-xs font-medium text-ink-3">Output</th>
                {model.scenarios.map((s) => (
                  <th key={s.key} className="border-b border-line bg-subtle px-3 py-2 text-right text-xs font-medium text-ink-3">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((k) => (
                <tr key={k}>
                  <td className="border-b border-line px-3 py-1.5 text-ink-2">{OUTPUT_LABELS[k] ?? titleCase(k)}</td>
                  {model.scenarios.map((s) => (
                    <td key={s.key} className="border-b border-line px-3 py-1.5 text-right tabular">{formatOutput(k, s.outputs?.[k])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <datalist id="uw-paths">
        {paths.map((p) => (
          <option key={p.path} value={p.path}>{p.label}</option>
        ))}
      </datalist>
      <div className="grid gap-3 lg:grid-cols-2">
        {draft.map((s, i) => (
          <Card key={s.key || i}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {s.kind === "base" ? s.name : <input disabled={readOnly} value={s.name} onChange={(e) => upd(i, { name: e.target.value })} className="rounded border border-transparent bg-transparent px-1 font-semibold hover:border-line focus:border-accent/60 focus:outline-none" />}
                  <Badge tone="outline">{titleCase(s.kind)}</Badge>
                </span>
              }
              actions={!readOnly && s.kind !== "base" ? <Button size="icon-sm" variant="ghost" aria-label="Remove scenario" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}><Trash2 /></Button> : undefined}
            />
            <CardBody className="space-y-2">
              {s.kind === "base" ? (
                <p className="text-sm text-ink-3">Base case uses the assumptions as entered.</p>
              ) : (
                <>
                  {s.rows.map((r, j) => (
                    <div key={j} className="grid grid-cols-[1fr_110px_90px_28px] items-center gap-1.5">
                      <Input list="uw-paths" disabled={readOnly} value={r.path} placeholder="assumption path" onChange={(e) => upd(i, { rows: s.rows.map((x, k) => (k === j ? { ...x, path: e.target.value } : x)) })} />
                      <Select disabled={readOnly} value={r.mode} onChange={(e) => upd(i, { rows: s.rows.map((x, k) => (k === j ? { ...x, mode: e.target.value as OverrideRow["mode"] } : x)) })} options={[{ value: "abs", label: "Set to" }, { value: "delta", label: "Add" }, { value: "mult", label: "Multiply by" }]} />
                      <Input inputMode="decimal" disabled={readOnly} value={r.value} onChange={(e) => upd(i, { rows: s.rows.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} />
                      {!readOnly && (
                        <Button size="icon-sm" variant="ghost" aria-label="Remove override" onClick={() => upd(i, { rows: s.rows.filter((_, k) => k !== j) })}>
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  ))}
                  {!readOnly && (
                    <Button size="xs" variant="ghost" onClick={() => upd(i, { rows: [...s.rows, { path: "", mode: "delta", value: "" }] })}>
                      <Plus /> Add override
                    </Button>
                  )}
                </>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
      {!readOnly && (
        <div className="flex items-center justify-between">
          <Button onClick={() => setDraft((d) => [...d, { key: `scenario_${d.length + 1}`, name: `Scenario ${d.length + 1}`, kind: "named", rows: [] }])}>
            <Plus /> Named scenario
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={persist}>Save scenarios</Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ sensitivity / tornado */

const METRICS = [
  { value: "irr", label: "Levered IRR" },
  { value: "unlevered_irr", label: "Unlevered IRR" },
  { value: "equity_multiple", label: "Equity multiple" },
  { value: "profit", label: "Profit" },
  { value: "exit_value", label: "Exit value" },
  { value: "cash_on_cash", label: "Cash-on-cash (Y1)" },
  { value: "dscr", label: "DSCR" },
];

export function SensitivityTab({ model }: { model: UwModel }) {
  const [metric, setMetric] = useState("irr");
  const [scenario, setScenario] = useState<string | null>(null);
  const { data, isLoading, error } = useSensitivity(model.id, metric, scenario, model.updated_at);
  const fmt = (v: number | null | undefined) => formatOutput(metric, v);
  const chart = useMemo(
    () =>
      (data?.rows ?? []).map((r) => {
        const lo = Math.min(r.low ?? data!.base ?? 0, r.high ?? data!.base ?? 0);
        const hi = Math.max(r.low ?? data!.base ?? 0, r.high ?? data!.base ?? 0);
        return { label: `${r.label} ±${r.step}${r.unit === "%" ? "%" : ` ${r.unit}`}`, range: [lo, hi] as [number, number], low: r.low, high: r.high };
      }),
    [data],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Output" className="w-48">
          <Select value={metric} onChange={(e) => setMetric(e.target.value)} options={METRICS} />
        </Field>
        <Field label="Scenario" className="w-48">
          <Select value={scenario ?? ""} onChange={(e) => setScenario(e.target.value || null)} options={model.scenarios.filter((s) => s.kind !== "base").map((s) => ({ value: s.key, label: s.name }))} placeholder="Base case" />
        </Field>
        {data && <p className="pb-2 text-sm text-ink-2">Base: <span className="font-medium text-ink tabular">{fmt(data.base)}</span></p>}
      </div>
      <Card>
        <CardHeader title="Tornado" description="Bars span the output at −step and +step for each input; widest impact first." />
        <CardBody>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : error ? (
            <p className="text-sm text-negative">{errorMessage(error)}</p>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }} barCategoryGap={10}>
                  <CartesianGrid horizontal={false} stroke="rgb(var(--line))" />
                  <XAxis type="number" domain={["auto", "auto"]} tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={(v: number) => fmt(v)} />
                  <YAxis type="category" dataKey="label" width={170} tickLine={false} axisLine={false} tick={AXIS_TICK} />
                  {data?.base !== null && data?.base !== undefined && <ReferenceLine x={data.base} stroke="rgb(var(--ink-3))" strokeDasharray="3 3" />}
                  <ChartTooltip
                    cursor={{ fill: "rgb(var(--muted))" }}
                    content={({ active, payload }) =>
                      active && payload?.length ? (
                        <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                          <p className="font-medium text-ink">{String(payload[0].payload.label)}</p>
                          <p className="text-ink-2 tabular">Low input: {fmt(payload[0].payload.low)}</p>
                          <p className="text-ink-2 tabular">High input: {fmt(payload[0].payload.high)}</p>
                        </div>
                      ) : null
                    }
                  />
                  <Bar dataKey="range" fill="rgb(var(--accent))" radius={4} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>
      {data && (
        <Card className="overflow-hidden">
          <CardHeader title="Sensitivity table" />
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-xs text-ink-3">
                  <th className="border-b border-line bg-subtle px-3 py-2 text-left font-medium">Input</th>
                  {["−2 steps", "−1 step", "Base", "+1 step", "+2 steps"].map((h) => (
                    <th key={h} className="border-b border-line bg-subtle px-3 py-2 text-right font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.variable}>
                    <td className="border-b border-line px-3 py-1.5 text-ink-2">{r.label} <span className="text-xs text-ink-3">(step {r.step} {r.unit})</span></td>
                    {r.points.map((p) => (
                      <td key={p.shift} className={cn("border-b border-line px-3 py-1.5 text-right tabular", p.shift === 0 && "font-medium")}>{fmt(p.value)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ simulation */

const SIM_METRICS = [
  { key: "irr", label: "Levered IRR" },
  { key: "equity_multiple", label: "Equity multiple" },
  { key: "exit_value", label: "Exit value" },
  { key: "noi_year1", label: "Year 1 NOI" },
  { key: "profit", label: "Profit" },
];

export function SimulationTab({ model }: { model: UwModel }) {
  const land = model.assumptions.model_type === "land";
  const defaults: SimRange[] = land
    ? [{ path: "land.bulk_price_per_usable_acre", label: "Exit price per usable acre", min: 0, max: 0 }]
    : [
        { path: "exit.exit_cap", label: "Exit cap %", min: 0, max: 0 },
        { path: "revenue.general_vacancy_pct", label: "General vacancy %", min: 0, max: 10 },
        { path: "revenue.market_rent_growth_pct", label: "Market rent growth %", min: 1, max: 4 },
      ];
  const [ranges, setRanges] = useState<SimRange[]>(model.simulation?.ranges?.length ? model.simulation.ranges : defaults);
  const [iterations, setIterations] = useState<number | null>(model.simulation?.iterations ?? 500);
  const [seed, setSeed] = useState<number | null>(model.simulation?.seed ?? 1);
  const [target, setTarget] = useState<number | null>(model.simulation?.target_irr ?? null);
  const [metric, setMetric] = useState("irr");
  const sim = useSimulate(model.id);
  const result = sim.data ?? model.simulation;
  const paths = land ? LAND_PATHS : MODEL_PATHS;
  const m = result?.metrics?.[metric];
  const fmt = (v: number | null | undefined) => formatOutput(metric, v);

  const run = () =>
    sim.mutate(
      { iterations: Math.min(2000, Math.max(10, iterations ?? 500)), seed: seed ?? 1, ranges: ranges.filter((r) => r.path && r.max >= r.min), target_irr: target },
      { onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Monte Carlo simulation" description="Seeded, reproducible draws over the ranges below (uniform, or triangular when a most-likely value is given). Up to 2,000 iterations." />
        <CardBody className="space-y-3">
          <datalist id="uw-sim-paths">
            {paths.map((p) => (
              <option key={p.path} value={p.path}>{p.label}</option>
            ))}
          </datalist>
          <div className="grid grid-cols-[1fr_100px_100px_110px_28px] gap-1.5 text-2xs font-medium text-ink-3">
            <span>Assumption</span><span>Min</span><span>Max</span><span>Most likely</span><span />
          </div>
          {ranges.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_100px_100px_110px_28px] items-center gap-1.5">
              <Input list="uw-sim-paths" value={r.path} onChange={(e) => setRanges((rs) => rs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
              <NumInput value={r.min} onChange={(n) => setRanges((rs) => rs.map((x, j) => (j === i ? { ...x, min: n ?? 0 } : x)))} />
              <NumInput value={r.max} onChange={(n) => setRanges((rs) => rs.map((x, j) => (j === i ? { ...x, max: n ?? 0 } : x)))} />
              <NumInput value={r.mode ?? null} placeholder="Uniform" onChange={(n) => setRanges((rs) => rs.map((x, j) => (j === i ? { ...x, mode: n } : x)))} />
              <Button size="icon-sm" variant="ghost" aria-label="Remove range" onClick={() => setRanges((rs) => rs.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-3 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setRanges((rs) => [...rs, { path: "", min: 0, max: 0 }])}><Plus /> Add range</Button>
            <Field label="Iterations" className="w-28"><NumInput value={iterations} onChange={setIterations} /></Field>
            <Field label="Seed" className="w-24"><NumInput value={seed} onChange={setSeed} /></Field>
            <Field label="Target IRR (%)" className="w-32"><NumInput value={target} onChange={setTarget} placeholder="Optional" /></Field>
            <Button variant="primary" className="ml-auto" loading={sim.isPending} disabled={!ranges.length} onClick={run}><Play /> Run simulation</Button>
          </div>
        </CardBody>
      </Card>

      {result && (
        <Card>
          <CardHeader
            title="Results"
            description={`${formatNumber(result.iterations)} iterations · seed ${result.seed}${result.run_at ? ` · ${formatDateTime(result.run_at)}` : ""}${result.run_by ? ` · ${result.run_by}` : ""}${result.stored === false ? " · not stored on this locked version" : ""}`}
            actions={<Select className="w-44" value={metric} onChange={(e) => setMetric(e.target.value)} options={SIM_METRICS.map((x) => ({ value: x.key, label: x.label }))} />}
          />
          <CardBody className="space-y-4">
            {result.prob_irr_below_target !== undefined && (
              <p className="text-sm text-ink-2">
                Probability levered IRR is below {result.target_irr}%: <span className="font-semibold text-ink tabular">{(result.prob_irr_below_target * 100).toFixed(1)}%</span>
              </p>
            )}
            {m && m.count > 0 ? (
              <>
                <div className="grid grid-cols-4 gap-3 md:grid-cols-8">
                  {(["p5", "p10", "p25", "p50", "p75", "p90", "p95", "mean"] as const).map((k) => (
                    <div key={k}>
                      <p className="text-xs text-ink-3">{k === "mean" ? "Mean" : `P${k.slice(1)}`}</p>
                      <p className="text-sm font-medium tabular">{fmt(m[k])}</p>
                    </div>
                  ))}
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={(m.histogram ?? []).map((b) => ({ label: fmt((b.from + b.to) / 2), count: b.count }))} margin={{ top: 4, right: 4, bottom: 0, left: -20 }} barCategoryGap={2}>
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} interval={3} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={AXIS_TICK} />
                      <ChartTooltip
                        cursor={{ fill: "rgb(var(--muted))" }}
                        content={({ active, payload }) =>
                          active && payload?.length ? (
                            <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                              <p className="text-ink-2">Around {String(payload[0].payload.label)}</p>
                              <p className="font-medium text-ink tabular">{String(payload[0].value)} runs</p>
                            </div>
                          ) : null
                        }
                      />
                      <Bar dataKey="count" fill="rgb(var(--accent))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            ) : (
              <p className="text-sm text-ink-3">No values for this output.</p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ versions & approval */

export function VersionsTab({ model, onNavigate }: { model: UwModel; onNavigate: (id: string) => void }) {
  const { can } = useAuth();
  const versions = useVersions(model.id, model.root_id);
  const events = useUwEvents(model.id);
  const [against, setAgainst] = useState<string | null>(null);
  const diff = useDiff(model.id, against);
  const submit = useDecision(model.id, "submit");
  const approve = useDecision(model.id, "approve");
  const reject = useDecision(model.id, "reject");
  const [dialog, setDialog] = useState<"submit" | "approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);

  const act = () => {
    const m = dialog === "submit" ? submit : dialog === "approve" ? approve : reject;
    m.mutate(
      { note: note || null, acknowledge_unsourced: ack },
      {
        onSuccess: () => {
          toast.success(dialog === "submit" ? "Submitted for approval" : dialog === "approve" ? "Approved and locked" : "Rejected");
          setDialog(null);
          setNote("");
          setAck(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Version {model.version}
              <StatusBadge status={model.status} />
              {model.is_locked && <Badge tone="green"><Lock className="size-3" /> Locked</Badge>}
            </span>
          }
          description={
            model.status === "approved"
              ? `Approved by ${model.approved_by_name ?? "—"} ${formatDateTime(model.approved_at)}. Any edit creates a new version.`
              : model.status === "submitted"
                ? `Submitted by ${model.submitted_by_name ?? "—"} ${formatDateTime(model.submitted_at)}.`
                : model.status === "rejected"
                  ? `Rejected: ${model.decision_note ?? ""}`
                  : "Draft versions are edited in place."
          }
          actions={
            <>
              {model.status === "draft" && can("underwriting", "edit") && (
                <Button variant="primary" onClick={() => setDialog("submit")}><Send /> Submit for approval</Button>
              )}
              {model.status === "submitted" && can("underwriting", "approve") && (
                <>
                  <Button onClick={() => setDialog("reject")}><ThumbsDown /> Reject</Button>
                  <Button variant="primary" disabled={!model.can_approve_amount} onClick={() => setDialog("approve")} title={model.can_approve_amount ? undefined : "Purchase price exceeds your approval limit"}>
                    <ThumbsUp /> Approve
                  </Button>
                </>
              )}
            </>
          }
        />
        <CardBody className="space-y-2">
          {model.status === "submitted" && can("underwriting", "approve") && !model.can_approve_amount && (
            <p className="text-sm text-caution">The purchase price of {formatOutput("purchase_price", model.outputs.purchase_price)} exceeds your underwriting approval limit.</p>
          )}
          {model.unsourced.length > 0 ? (
            <div>
              <p className="flex items-center gap-1.5 text-sm font-medium text-caution"><AlertTriangle className="size-4" /> {model.unsourced.length} unsourced material assumptions</p>
              <ul className="mt-1 grid gap-x-6 text-sm text-ink-2 md:grid-cols-2">
                {model.unsourced.map((u) => <li key={u.path}>{u.label}</li>)}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-positive">Every material assumption has a source.</p>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Versions" />
          {versions.isLoading ? (
            <CardBody><Skeleton className="h-20 w-full" /></CardBody>
          ) : (
            <ul className="divide-y divide-line">
              {(versions.data ?? []).map((v) => (
                <li key={v.id} className={cn("flex items-center justify-between gap-3 px-4 py-2.5 text-sm", v.id === model.id && "bg-accent-soft/40")}>
                  <div className="min-w-0">
                    <button className="font-medium text-ink hover:underline" onClick={() => onNavigate(v.id)}>Version {v.version}</button>
                    <p className="truncate text-xs text-ink-3">{[v.change_note, v.created_by_name, formatDateTime(v.created_at)].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-ink-2 tabular">{formatOutput("irr", v.irr)}</span>
                    <StatusBadge status={v.status} />
                    {v.id !== model.id && (
                      <Button size="xs" variant="ghost" onClick={() => setAgainst(v.id)}>Compare</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Approval history" />
          <ul className="divide-y divide-line">
            {(events.data ?? []).map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                <p className="text-ink"><span className="font-medium">{titleCase(e.action)}</span> · {e.actor_name ?? "System"}</p>
                <p className="text-xs text-ink-3">{formatDateTime(e.at)}{e.note ? ` · ${e.note}` : ""}</p>
              </li>
            ))}
            {!events.data?.length && <li className="px-4 py-6 text-center text-sm text-ink-3">No history yet</li>}
          </ul>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Version diff"
          description={diff.data ? `Version ${diff.data.base_version} → version ${diff.data.other_version}` : "Compared with the previous version unless another is chosen."}
        />
        {diff.isLoading ? (
          <CardBody><Skeleton className="h-16 w-full" /></CardBody>
        ) : diff.error ? (
          <CardBody><p className="text-sm text-ink-3">{errorMessage(diff.error)}</p></CardBody>
        ) : diff.data ? (
          <div className="grid gap-0 lg:grid-cols-2">
            <div className="border-b border-line lg:border-b-0 lg:border-r">
              <p className="px-4 pt-3 text-xs font-medium text-ink-2">Assumptions ({diff.data.assumptions.length} changes)</p>
              <ul className="max-h-80 overflow-y-auto px-4 py-2 text-xs scrollbar-thin">
                {diff.data.assumptions.map((c) => (
                  <li key={c.path} className="py-1">
                    <code className="text-ink-2">{c.path}</code>
                    <p className="text-ink-3"><span className="line-through">{JSON.stringify(c.from) ?? "—"}</span> → <span className="text-ink">{JSON.stringify(c.to) ?? "—"}</span></p>
                  </li>
                ))}
                {!diff.data.assumptions.length && <li className="py-2 text-ink-3">No assumption changes</li>}
              </ul>
            </div>
            <div>
              <p className="px-4 pt-3 text-xs font-medium text-ink-2">Outputs</p>
              <table className="w-full text-xs">
                <tbody>
                  {diff.data.outputs.map((o) => (
                    <tr key={o.key}>
                      <td className="px-4 py-1 text-ink-2">{OUTPUT_LABELS[o.key] ?? titleCase(o.key)}</td>
                      <td className="px-2 py-1 text-right tabular text-ink-3">{formatOutput(o.key, o.from)}</td>
                      <td className="px-4 py-1 text-right font-medium tabular">{formatOutput(o.key, o.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!diff.data.outputs.length && <p className="px-4 py-2 text-xs text-ink-3">No output changes</p>}
            </div>
          </div>
        ) : null}
      </Card>

      <Dialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog === "submit" ? "Submit for approval" : dialog === "approve" ? "Approve this version" : "Reject this version"}
        description={dialog === "approve" ? "The approved version is locked and becomes the source for offers. Earlier approved versions are superseded." : undefined}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant={dialog === "reject" ? "danger" : "primary"}
              loading={submit.isPending || approve.isPending || reject.isPending}
              disabled={(dialog === "reject" && !note.trim()) || (dialog === "approve" && model.unsourced.length > 0 && !ack)}
              onClick={act}
            >
              {dialog === "submit" ? "Submit" : dialog === "approve" ? "Approve" : "Reject"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {dialog !== "submit" && model.unsourced.length > 0 && (
            <p className="text-sm text-caution">{model.unsourced.length} material assumptions have no source.</p>
          )}
          <Field label={dialog === "reject" ? "Reason" : "Note"} required={dialog === "reject"}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {dialog === "approve" && model.unsourced.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <Checkbox checked={ack} onChange={setAck} />
              I acknowledge the unsourced assumptions
            </label>
          )}
        </div>
      </Dialog>
    </div>
  );
}

export function PropertyLink({ model }: { model: UwModel }) {
  if (!model.property_id) return null;
  return (
    <Link href={`/properties/${model.property_id}?tab=underwriting`} className="text-xs text-accent hover:underline">
      {model.property_label ?? "Property"}
    </Link>
  );
}
