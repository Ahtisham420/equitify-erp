"use client";

import { ArrowUpRight, CheckCheck, Pencil, Plus, Radar, ScanSearch, Trash2, X } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { ConfidencePill } from "@/components/data/provenance";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Avatar, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import {
  CATEGORY_LABELS,
  TRIGGER_LABELS,
  useAsset,
  useAssetHistory,
  useCashFlow,
  useDeleteFinancial,
  useFinancials,
  useMilestones,
  usePerformance,
  useScanVariances,
  useScanWatchlist,
  useVariances,
  useVerifyFinancials,
  useWatchlist,
  type Asset,
  type CashFlowRow,
  type FinancialRow,
  type Milestone,
  type Observation,
  type PerfLine,
  type Variance,
  type WatchEntry,
} from "@/features/assets/api";
import {
  AssetFormSheet,
  AssetStatusBadge,
  ExplainVarianceDialog,
  FinancialEntrySheet,
  MetricCards,
  MilestoneSheet,
  MilestoneStatusBadge,
  ResolveWatchDialog,
  ReviewVarianceDialog,
  VarianceStatusBadge,
  type VarianceTarget,
} from "@/features/assets/asset-forms";
import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

const KPI_KEYS = ["value", "noi", "occupancy", "wale", "yield_on_cost", "leverage", "coverage", "debt"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const money = (v: number | null | undefined) => formatCurrency(v);

/* ------------------------------------------------------------------ overview */

function CovenantBadge({ state }: { state: string }) {
  if (state === "breach") return <Badge tone="red" dot>Breach</Badge>;
  if (state === "projected_breach") return <Badge tone="red" dot>Projected breach</Badge>;
  if (state === "watch") return <Badge tone="amber" dot>Watch</Badge>;
  if (["ok", "compliant", "pass", "passing"].includes(state)) return <Badge tone="green" dot>{titleCase(state)}</Badge>;
  return <Badge tone="neutral">{titleCase(state)}</Badge>;
}

const UW_LABELS: Record<string, string> = {
  purchase_price: "Purchase price", noi_year1: "Year-1 NOI", going_in_cap: "Going-in cap", stabilized_cap: "Stabilized cap",
  loan_amount: "Loan amount", dscr: "DSCR", debt_yield: "Debt yield", cash_on_cash: "Cash-on-cash", irr: "IRR",
  equity_multiple: "Equity multiple", exit_value: "Exit value", breakeven_occupancy: "Breakeven occupancy",
};

function formatUw(key: string, v: number | null): string {
  if (v === null || v === undefined) return "—";
  if (["purchase_price", "noi_year1", "loan_amount", "exit_value", "peak_equity"].includes(key)) return formatCurrency(v);
  if (key === "dscr" || key === "equity_multiple") return `${formatNumber(v, 2)}x`;
  return formatPercent(Math.abs(v) <= 1 ? v * 100 : v, 2);
}

function Overview({ a }: { a: Asset }) {
  const cs = a.capital_structure;
  const b = a.benchmark;
  return (
    <div className="space-y-5">
      <MetricCards metrics={a.kpis} keys={KPI_KEYS} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Asset record" />
            <CardBody>
              <FieldGrid cols={3}>
                <FieldItem label="Basis">{a.basis !== null ? money(a.basis) : null}</FieldItem>
                <FieldItem label="Equity invested">{a.equity_invested !== null ? money(a.equity_invested) : null}</FieldItem>
                <FieldItem label="Current value">
                  {a.current_value !== null ? (
                    <>
                      {money(a.current_value)}
                      {a.value_as_of && <span className="text-ink-3"> · as of {formatDate(a.value_as_of)}</span>}
                    </>
                  ) : null}
                </FieldItem>
                <FieldItem label="Acquired">{a.acquired_on ? formatDate(a.acquired_on) : null}</FieldItem>
                <FieldItem label="Target hold">{a.target_hold_years !== null ? `${formatNumber(a.target_hold_years, 1)} years` : null}</FieldItem>
                <FieldItem label="Exit cap rate">{a.exit_cap_rate !== null ? formatPercent(a.exit_cap_rate, 2) : null}</FieldItem>
                <FieldItem label="Target exit">{a.target_exit_on ? formatDate(a.target_exit_on) : null}</FieldItem>
                <FieldItem label="Disposed">{a.disposed_on ? formatDate(a.disposed_on) : null}</FieldItem>
                <FieldItem label="Corridor">{a.corridor}</FieldItem>
              </FieldGrid>
              {(a.hold_thesis || a.business_plan || a.notes) && (
                <div className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
                  {a.hold_thesis && (
                    <div>
                      <p className="text-xs text-ink-3">Hold thesis</p>
                      <p className="whitespace-pre-wrap text-ink-2">{a.hold_thesis}</p>
                    </div>
                  )}
                  {a.business_plan && (
                    <div>
                      <p className="text-xs text-ink-3">Business plan</p>
                      <p className="whitespace-pre-wrap text-ink-2">{a.business_plan}</p>
                    </div>
                  )}
                  {a.notes && (
                    <div>
                      <p className="text-xs text-ink-3">Notes</p>
                      <p className="whitespace-pre-wrap text-ink-2">{a.notes}</p>
                    </div>
                  )}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Capital structure" description={cs.ltv !== null ? `Loan-to-value ${formatPercent(cs.ltv, 1)}` : undefined} />
            <CardBody className="space-y-4">
              <FieldGrid cols={3}>
                <FieldItem label="Debt">{cs.debt_total !== null ? money(cs.debt_total) : null}</FieldItem>
                <FieldItem label="Value">{cs.value !== null ? money(cs.value) : null}</FieldItem>
                <FieldItem label="Equity invested">{cs.equity_invested !== null ? money(cs.equity_invested) : null}</FieldItem>
              </FieldGrid>
              {cs.loans.length === 0 ? (
                <p className="text-sm text-ink-3">No active loans — the asset is unlevered.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-line scrollbar-thin">
                  <table className="w-full text-sm">
                    <thead className="bg-subtle text-xs text-ink-3">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Lender</th>
                        <th className="px-3 py-2 text-right font-medium">Balance</th>
                        <th className="px-3 py-2 text-right font-medium">Rate</th>
                        <th className="px-3 py-2 text-right font-medium">Debt service</th>
                        <th className="px-3 py-2 text-left font-medium">Maturity</th>
                        <th className="px-3 py-2 text-left font-medium">Covenants</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cs.loans.map((l) => (
                        <tr key={l.id} className="border-t border-line">
                          <td className="px-3 py-2">
                            <Link href={l.href} className="font-medium text-ink hover:underline">
                              {l.lender_name}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-right tabular">{money(l.balance)}</td>
                          <td className="px-3 py-2 text-right tabular">
                            {formatPercent(l.rate, 2)} <span className="text-xs text-ink-3">{l.rate_type}</span>
                          </td>
                          <td className="px-3 py-2 text-right tabular">{money(l.annual_debt_service)}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-ink-2">{formatDate(l.maturity_on)}</td>
                          <td className="px-3 py-2">
                            <CovenantBadge state={l.covenant_state} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-3">Capital partners</p>
                {cs.partners === null ? (
                  <p className="text-sm text-ink-3">Investor data unavailable.</p>
                ) : cs.partners.length === 0 ? (
                  <p className="text-sm text-ink-3">No capital partners recorded.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {cs.partners.map((p) => (
                      <li key={p.partner_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <Link href={p.href} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">
                          {p.name}
                        </Link>
                        <span className="text-ink-2 tabular">{formatPercent(p.ownership_pct, 2)}</span>
                        <span className="w-28 text-right text-xs text-ink-3 tabular">
                          {formatCurrency(p.funded, { compact: true })} of {formatCurrency(p.commitment, { compact: true })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Underwriting benchmark"
              description="The approved acquisition underwriting remains the original benchmark."
              actions={b?.href && <Link href={b.href} className="text-xs font-medium text-accent hover:underline">Open model</Link>}
            />
            <CardBody>
              {!b ? (
                <p className="text-sm text-ink-3">No underwriting model is linked to this asset.</p>
              ) : !b.available ? (
                <p className="text-sm text-caution">{b.note ?? "The linked underwriting model is not available."}</p>
              ) : (
                <>
                  <p className="mb-3 text-sm text-ink-2">
                    {b.name ?? "Underwriting model"}
                    {b.version ? ` · v${b.version}` : ""}
                    {b.approved_at && <span className="text-ink-3"> · approved {formatDate(b.approved_at)}</span>}
                  </p>
                  <dl className="divide-y divide-line text-sm">
                    {Object.entries(b.outputs ?? {}).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between py-1.5">
                        <dt className="text-ink-3">{UW_LABELS[k] ?? titleCase(k)}</dt>
                        <dd className="font-medium text-ink tabular">{formatUw(k, v)}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ financials */

function varTone(fav: boolean | null) {
  return fav === null ? "text-ink-3" : fav ? "text-positive" : "text-negative";
}

function VarCells({
  line,
  win,
  basis,
  canEdit,
  onExplain,
}: {
  line: PerfLine;
  win: "month" | "ttm";
  basis: "budget" | "underwriting";
  canEdit: boolean;
  onExplain: (line: PerfLine, basis: "budget" | "underwriting") => void;
}) {
  const w = line[win];
  const isBudget = basis === "budget";
  const bench = isBudget ? w.budget : w.uw;
  const v = isBudget ? w.var_budget : w.var_uw;
  const vp = isBudget ? w.var_budget_pct : w.var_uw_pct;
  const fav = isBudget ? w.fav_budget : w.fav_uw;
  const flag = isBudget ? w.flag_budget : w.flag_uw;
  const expl = line.explanations[`${win}:${basis}`];
  const reopen = expl && (expl.status === "required" || expl.status === "rejected");
  return (
    <>
      <td className="border-l border-line px-3 py-1.5 text-right tabular text-ink-2">{money(bench)}</td>
      <td className={cn("px-3 py-1.5 text-right tabular", varTone(fav), flag && "bg-caution-soft")}>{money(v)}</td>
      <td className={cn("px-3 py-1.5 text-right tabular", varTone(fav), flag && "bg-caution-soft")}>
        <div className="flex items-center justify-end gap-1.5">
          <span>{formatPercent(vp, 1)}</span>
          {expl ? (
            canEdit && reopen ? (
              <button onClick={() => onExplain(line, basis)} title="Explain">
                <VarianceStatusBadge status={expl.status} />
              </button>
            ) : (
              <VarianceStatusBadge status={expl.status} />
            )
          ) : flag && canEdit ? (
            <Button size="xs" onClick={() => onExplain(line, basis)}>
              Explain
            </Button>
          ) : null}
        </div>
      </td>
    </>
  );
}

function FinancialsTab({ a }: { a: Asset }) {
  const { can } = useAuth();
  const url = useUrlState();
  const account = url.get("account");
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState<number | null>(null);
  const [win, setWin] = useState<"month" | "ttm">("month");
  const [grid, setGrid] = useState(false);
  const [explain, setExplain] = useState<VarianceTarget | null>(null);
  const [reviewing, setReviewing] = useState<Variance | null>(null);
  const [deleting, setDeleting] = useState<FinancialRow | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [range, setRange] = useState({ from: "", to: "" });
  const [adding, setAdding] = useState(false);

  const { data: perf, isLoading } = usePerformance(a.id, year, month);
  const rows = useFinancials(a.id, { period_from: `${year}-01-01`, period_to: `${year}-12-01`, account: account ?? undefined });
  const variances = useVariances({ asset_id: a.id });
  const remove = useDeleteFinancial(a.id);
  const verify = useVerifyFinancials(a.id);
  const scan = useScanVariances(a.id);
  const canEdit = can("assets", "edit");
  const canApprove = can("assets", "approve");
  const selMonth = month ?? perf?.month ?? null;

  const openExplain = (line: PerfLine, basis: "budget" | "underwriting") => {
    if (!perf) return;
    const w = line[win];
    const isBudget = basis === "budget";
    setExplain({
      period: perf.period,
      window: win,
      basis,
      account: line.account,
      actual: w.actual,
      benchmark: isBudget ? w.budget : w.uw,
      variance: isBudget ? w.var_budget : w.var_uw,
      variance_pct: isBudget ? w.var_budget_pct : w.var_uw_pct,
    });
  };

  const runScan = () =>
    scan.mutate(
      { year, month: selMonth },
      {
        onSuccess: (r) => toast.success(r.created ? `${r.created} variances require an explanation` : "No new variances above threshold"),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const openVerify = () => {
    const p = (perf?.period ?? `${year}-01-01`).slice(0, 7);
    setRange({ from: (perf?.ttm_start ?? `${year}-01-01`).slice(0, 7), to: p });
    setVerifyOpen(true);
  };
  const runVerify = () =>
    verify.mutate(
      { period_from: `${range.from}-01`, period_to: `${range.to}-01` },
      {
        onSuccess: (r) => {
          toast.success(`${r.verified} rows verified`);
          setVerifyOpen(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const rowCols: Column<FinancialRow>[] = [
    { id: "period", header: "Period", cell: (r) => <span className="whitespace-nowrap">{formatDate(r.period, "MMM yyyy")}</span> },
    { id: "account", header: "Account", cell: (r) => <span className="font-medium text-ink" title={r.notes ?? undefined}>{r.account}</span> },
    { id: "category", header: "Category", cell: (r) => <span className="text-ink-2">{CATEGORY_LABELS[r.category] ?? titleCase(r.category)}</span> },
    { id: "amount", header: "Amount", align: "right", cell: (r) => money(r.amount) },
    { id: "source", header: "Source", cell: (r) => <span className="text-ink-2">{titleCase(r.source)}</span> },
    {
      id: "verified",
      header: "Status",
      cell: (r) => (r.verified ? <Badge tone="green" dot>Verified</Badge> : <Badge tone="amber" dot>Unverified</Badge>),
    },
    { id: "created", header: "Entered", cell: (r) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(r.created_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (r) =>
        canEdit && (!r.verified || canApprove) ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete row"
            onClick={(e) => {
              e.stopPropagation();
              setDeleting(r);
            }}
          >
            <Trash2 />
          </Button>
        ) : null,
    },
  ];

  const varCols: Column<Variance>[] = [
    { id: "period", header: "Period", cell: (v) => <span className="whitespace-nowrap">{formatDate(v.period, "MMM yyyy")}</span> },
    { id: "account", header: "Account", cell: (v) => <span className="font-medium text-ink">{v.account}</span> },
    { id: "basis", header: "Against", cell: (v) => <span className="whitespace-nowrap text-ink-2">{v.window === "ttm" ? "TTM" : "Month"} · {v.basis === "budget" ? "Budget" : "Underwriting"}</span> },
    { id: "variance", header: "Variance", align: "right", cell: (v) => <span>{money(v.variance)} <span className="text-xs text-ink-3">{formatPercent(v.variance_pct, 1)}</span></span> },
    { id: "explanation", header: "Explanation", cell: (v) => <p className="max-w-[320px] truncate text-ink-2" title={v.explanation ?? undefined}>{v.explanation ?? "—"}</p> },
    { id: "owner", header: "Owner", cell: (v) => <span className="whitespace-nowrap text-ink-2">{v.owner_name ?? "—"}</span> },
    { id: "status", header: "Status", cell: (v) => <VarianceStatusBadge status={v.status} /> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (v) => (
        <div className="flex justify-end gap-1">
          {canEdit && (v.status === "required" || v.status === "rejected") && (
            <Button size="xs" onClick={(e) => { e.stopPropagation(); setExplain({ ...v }); }}>
              Explain
            </Button>
          )}
          {canApprove && v.status === "submitted" && (
            <Button size="xs" onClick={(e) => { e.stopPropagation(); setReviewing(v); }}>
              Review
            </Button>
          )}
        </div>
      ),
    },
  ];

  const lines = perf ? [...perf.lines, ...perf.summary] : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Year"
          className="w-24"
          value={String(year)}
          onChange={(e) => {
            setYear(Number(e.target.value));
            setMonth(null);
          }}
          options={Array.from({ length: 8 }, (_, i) => String(thisYear - i)).map((y) => ({ value: y, label: y }))}
        />
        <Select
          aria-label="Month"
          className="w-24"
          value={selMonth ? String(selMonth) : ""}
          onChange={(e) => setMonth(e.target.value ? Number(e.target.value) : null)}
          options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
        />
        <div className="flex rounded-md border border-line bg-surface p-0.5 shadow-card">
          {(["month", "ttm"] as const).map((w) => (
            <button key={w} onClick={() => setWin(w)} className={cn("h-6 rounded px-2.5 text-xs font-medium", win === w ? "bg-ink text-white" : "text-ink-2 hover:bg-muted")}>
              {w === "month" ? "Monthly" : "TTM"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && (
            <Button size="sm" loading={scan.isPending} onClick={runScan}>
              <ScanSearch /> Detect variances
            </Button>
          )}
          {canApprove && (
            <Button size="sm" onClick={openVerify}>
              <CheckCheck /> Verify period
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus /> Add financials
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title={perf ? `Actual vs budget vs underwriting · ${win === "ttm" ? `TTM ${formatDate(perf.ttm_start, "MMM yyyy")} – ${formatDate(perf.ttm_end, "MMM yyyy")}` : formatDate(perf.period, "MMMM yyyy")}` : "Actual vs budget vs underwriting"}
          description={
            perf
              ? `Variances are flagged at ≥ ${formatNumber(perf.thresholds.pct, 1)}% and ≥ ${formatCurrency(perf.thresholds.amount)}. ${perf.budget_available ? "" : "No approved budget covers this period. "}${perf.uw_note}`
              : undefined
          }
        />
        {isLoading && !perf ? (
          <div className="p-4">
            <Skeleton className="h-48 w-full" />
          </div>
        ) : !lines.length ? (
          <EmptyState title="No financials for this year" description="Add monthly actuals to compare against budget and underwriting." />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-xs text-ink-3">
                <tr>
                  <th className="px-3 py-1.5" />
                  <th className="px-3 py-1.5" />
                  <th colSpan={3} className="border-l border-line px-3 py-1.5 text-center font-medium">Budget{perf && !perf.budget_available ? " (none)" : ""}</th>
                  <th colSpan={3} className="border-l border-line px-3 py-1.5 text-center font-medium">Underwriting{perf && !perf.uw_available ? " (none)" : ""}</th>
                </tr>
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Account</th>
                  <th className="px-3 py-1.5 text-right font-medium">Actual</th>
                  <th className="border-l border-line px-3 py-1.5 text-right font-medium">Budget</th>
                  <th className="px-3 py-1.5 text-right font-medium">Var</th>
                  <th className="px-3 py-1.5 text-right font-medium">Var %</th>
                  <th className="border-l border-line px-3 py-1.5 text-right font-medium">UW</th>
                  <th className="px-3 py-1.5 text-right font-medium">Var</th>
                  <th className="px-3 py-1.5 text-right font-medium">Var %</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr
                    key={`${line.is_summary ? "s" : "l"}:${line.account}`}
                    className={cn(
                      "border-t border-line",
                      line.is_summary && "bg-subtle/60 font-semibold",
                      line.is_summary && i > 0 && !lines[i - 1].is_summary && "border-t-2 border-t-line-strong",
                      !line.is_summary && account === line.account && "bg-accent-soft/50",
                    )}
                  >
                    <td className="px-3 py-1.5">
                      {line.is_summary ? (
                        line.account
                      ) : (
                        <Link href={`/assets/${a.id}?tab=financials&account=${encodeURIComponent(line.account)}`} scroll={false} className="text-ink hover:underline">
                          {line.account}
                        </Link>
                      )}
                      {!line.is_summary && <span className="ml-1.5 text-xs text-ink-3">{CATEGORY_LABELS[line.category] ?? titleCase(line.category)}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular">{money(line[win].actual)}</td>
                    <VarCells line={line} win={win} basis="budget" canEdit={canEdit && !line.is_summary} onExplain={openExplain} />
                    <VarCells line={line} win={win} basis="underwriting" canEdit={canEdit && !line.is_summary} onExplain={openExplain} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {perf && lines.length > 0 && (
          <div className="border-t border-line">
            <button onClick={() => setGrid((g) => !g)} className="w-full px-4 py-2 text-left text-xs font-medium text-ink-2 hover:bg-subtle hover:text-ink">
              {grid ? "Hide" : "Show"} {perf.year} monthly actuals
            </button>
            {grid && (
              <div className="overflow-x-auto border-t border-line scrollbar-thin">
                <table className="w-full text-xs">
                  <thead className="bg-subtle text-ink-3">
                    <tr>
                      <th className="sticky left-0 bg-subtle px-3 py-1.5 text-left font-medium">Account</th>
                      {perf.months.map((m) => (
                        <th key={m} className="px-2 py-1.5 text-right font-medium">{formatDate(m, "MMM")}</th>
                      ))}
                      <th className="px-3 py-1.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={`${line.is_summary ? "s" : "l"}:${line.account}`} className={cn("border-t border-line", line.is_summary && "font-semibold")}>
                        <td className="sticky left-0 max-w-[200px] truncate bg-surface px-3 py-1.5">{line.account}</td>
                        {line.monthly.map((m) => (
                          <td key={m.period} className="px-2 py-1.5 text-right tabular">{m.actual ? formatNumber(m.actual) : <span className="text-ink-3">—</span>}</td>
                        ))}
                        <td className="px-3 py-1.5 text-right tabular">{formatNumber(line.monthly.reduce((s, m) => s + (m.actual ?? 0), 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={`Financial rows · ${year}`}
          description="Current values per period and account. Superseded values are kept in history."
          actions={
            account && (
              <span className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface pl-2 pr-1 text-xs">
                <span className="text-ink-3">Account:</span> <span className="font-medium">{account}</span>
                <button onClick={() => url.set({ account: null }, { resetPage: false })} className="rounded p-0.5 text-ink-3 hover:bg-muted hover:text-ink" aria-label="Clear account filter">
                  <X className="size-3" />
                </button>
              </span>
            )
          }
        />
        <DataTable
          columns={rowCols}
          data={rows.data}
          loading={rows.isLoading}
          dense
          empty={<EmptyState title="No rows" description={account ? "No entries for this account in the selected year." : "No monthly actuals recorded for the selected year."} />}
        />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Variance explanations" description="Flagged variances, their explanations and review decisions." />
        <DataTable
          columns={varCols}
          data={variances.data}
          loading={variances.isLoading}
          dense
          empty={<EmptyState title="No variance records" description="Run detect variances to require explanations for flagged lines." />}
        />
      </Card>

      <FinancialEntrySheet open={adding} onOpenChange={setAdding} assetId={a.id} />
      <ExplainVarianceDialog open={!!explain} onOpenChange={(o) => !o && setExplain(null)} assetId={a.id} target={explain} />
      <ReviewVarianceDialog open={!!reviewing} onOpenChange={(o) => !o && setReviewing(null)} variance={reviewing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this financial row?"
        description={deleting ? `${deleting.account} · ${formatDate(deleting.period, "MMM yyyy")} · ${money(deleting.amount)}` : undefined}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Row deleted");
              setDeleting(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
      <Dialog
        open={verifyOpen}
        onOpenChange={setVerifyOpen}
        title="Verify period"
        description="Marks every current row in the range as verified. Verified actuals can only be deleted by an approver."
        footer={
          <>
            <Button onClick={() => setVerifyOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!range.from || !range.to || range.from > range.to} loading={verify.isPending} onClick={runVerify}>
              Verify
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Input type="month" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
          </Field>
          <Field label="To">
            <Input type="month" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ cash flow */

type CfKey = Exclude<keyof CashFlowRow, "period" | "debt_service_estimated">;
const CF_ROWS: { key: CfKey; label: string; strong?: boolean }[] = [
  { key: "income", label: "Income" },
  { key: "expense", label: "Operating expenses" },
  { key: "noi", label: "Net operating income", strong: true },
  { key: "capex", label: "Capital expenditure" },
  { key: "reserves", label: "Reserve deposits" },
  { key: "debt_service", label: "Debt service" },
  { key: "cash_flow_after_debt", label: "Cash flow after debt", strong: true },
  { key: "distributions", label: "Distributions" },
  { key: "net_cash_flow", label: "Net cash flow", strong: true },
  { key: "cumulative", label: "Cumulative" },
];

function CashFlowTab({ a }: { a: Asset }) {
  const [months, setMonths] = useState(12);
  const { data, isLoading } = useCashFlow(a.id, months);
  const last = data?.rows[data.rows.length - 1];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Cash flow"
        description={data ? `${formatDate(data.start, "MMM yyyy")} – ${formatDate(data.end, "MMM yyyy")}` : undefined}
        actions={
          <div className="flex rounded-md border border-line bg-surface p-0.5 shadow-card">
            {[12, 24].map((m) => (
              <button key={m} onClick={() => setMonths(m)} className={cn("h-6 rounded px-2.5 text-xs font-medium", months === m ? "bg-ink text-white" : "text-ink-2 hover:bg-muted")}>
                {m} months
              </button>
            ))}
          </div>
        }
      />
      {isLoading || !data ? (
        <div className="p-4">
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead className="bg-subtle text-ink-3">
                <tr>
                  <th className="sticky left-0 bg-subtle px-3 py-1.5 text-left font-medium">Line</th>
                  {data.rows.map((r) => (
                    <th key={r.period} className="whitespace-nowrap px-2 py-1.5 text-right font-medium">{formatDate(r.period, "MMM yy")}</th>
                  ))}
                  <th className="px-3 py-1.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {CF_ROWS.map(({ key, label, strong }) => (
                  <tr key={key} className={cn("border-t border-line", strong && "bg-subtle/50 font-semibold")}>
                    <td className={cn("sticky left-0 whitespace-nowrap px-3 py-1.5", strong ? "bg-subtle" : "bg-surface")}>{label}</td>
                    {data.rows.map((r) => (
                      <td key={r.period} className={cn("whitespace-nowrap px-2 py-1.5 text-right tabular", r[key] < 0 && "text-negative")}>
                        {r[key] ? formatNumber(r[key]) : <span className="text-ink-3">—</span>}
                        {key === "debt_service" && r.debt_service_estimated && <span className="ml-1 text-2xs font-normal text-caution">est.</span>}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular">
                      {formatNumber(key === "cumulative" ? last?.cumulative ?? 0 : data.totals[key] ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-xs">
            <span className="text-ink-3">{data.note}</span>
            {data.drill.map((d) => (
              <Link key={d.href} href={d.href} className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline">
                {d.label} <ArrowUpRight className="size-3" />
              </Link>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ milestones / watchlist / history */

function MilestonesTab({ a }: { a: Asset }) {
  const { can } = useAuth();
  const { data, isLoading } = useMilestones(a.id);
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [open, setOpen] = useState(false);
  const edit = (m: Milestone | null) => {
    setEditing(m);
    setOpen(true);
  };
  const columns: Column<Milestone>[] = [
    {
      id: "title",
      header: "Milestone",
      cell: (m) => (
        <div className="min-w-[200px] max-w-[420px]">
          <p className="truncate font-medium text-ink">{m.title}</p>
          {m.description && <p className="truncate text-xs text-ink-3">{m.description}</p>}
        </div>
      ),
    },
    {
      id: "owner",
      header: "Owner",
      cell: (m) =>
        m.owner_name ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
            <Avatar name={m.owner_name} size={20} /> {m.owner_name}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    { id: "due", header: "Due", cell: (m) => <span className={cn("whitespace-nowrap", m.overdue ? "font-medium text-negative" : "text-ink-2")}>{formatDate(m.due_on)}</span> },
    { id: "status", header: "Status", cell: (m) => <MilestoneStatusBadge status={m.status} /> },
    { id: "completed", header: "Completed", cell: (m) => <span className="text-ink-2">{formatDate(m.completed_on)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (m) =>
        can("assets", "edit") ? (
          <Button size="icon-sm" variant="ghost" aria-label="Edit milestone" onClick={(e) => { e.stopPropagation(); edit(m); }}>
            <Pencil />
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Business plan milestones for this asset.</p>
        {can("assets", "edit") && (
          <Button size="sm" onClick={() => edit(null)}>
            <Plus /> Add milestone
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No milestones" description="Track the business plan with dated, owned milestones." />} />
      </Card>
      <MilestoneSheet open={open} onOpenChange={setOpen} assetId={a.id} milestone={editing} />
    </div>
  );
}

function WatchlistTab({ a }: { a: Asset }) {
  const { can } = useAuth();
  const { data, isLoading } = useWatchlist({ asset_id: a.id });
  const [resolving, setResolving] = useState<WatchEntry | null>(null);
  const columns: Column<WatchEntry>[] = [
    { id: "trigger", header: "Trigger", cell: (e) => <span className="whitespace-nowrap font-medium text-ink">{TRIGGER_LABELS[e.trigger] ?? titleCase(e.trigger)}</span> },
    { id: "severity", header: "Severity", cell: (e) => <StatusBadge status={e.severity} /> },
    { id: "status", header: "Status", cell: (e) => <StatusBadge status={e.status} /> },
    {
      id: "detail",
      header: "Detail",
      cell: (e) => (
        <div className="max-w-[420px]">
          <p className="truncate text-ink-2" title={e.detail ?? undefined}>{e.detail ?? "—"}</p>
          {e.resolution_note && <p className="truncate text-xs text-ink-3" title={e.resolution_note}>{e.resolution_note}</p>}
        </div>
      ),
    },
    { id: "detected", header: "Detected", cell: (e) => <span className="whitespace-nowrap text-xs text-ink-3" title={formatDateTime(e.first_detected_at)}>{formatRelative(e.first_detected_at)}</span> },
    { id: "resolved", header: "Closed", cell: (e) => <span className="whitespace-nowrap text-xs text-ink-3">{e.resolved_at ? formatDate(e.resolved_at) : "—"}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (e) => (
        <div className="flex items-center justify-end gap-2">
          {e.source_href && (
            <Link href={e.source_href} className="inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline">
              Source <ArrowUpRight className="size-3" />
            </Link>
          )}
          {e.status === "open" && can("assets", "edit") && (
            <Button size="xs" onClick={(ev) => { ev.stopPropagation(); setResolving(e); }}>
              Resolve
            </Button>
          )}
        </div>
      ),
    },
  ];
  return (
    <>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          dense
          rowClassName={(e) => (e.status !== "open" ? "bg-subtle/40" : undefined)}
          empty={<EmptyState title="No watchlist history" description="Triggers are evaluated by the watchlist scan." />}
        />
      </Card>
      <ResolveWatchDialog open={!!resolving} onOpenChange={(o) => !o && setResolving(null)} entry={resolving} />
    </>
  );
}

function HistoryTab({ a }: { a: Asset }) {
  const { data, isLoading } = useAssetHistory(a.id);
  const columns: Column<Observation>[] = [
    { id: "field", header: "Field", cell: (o) => <span className="font-medium">{titleCase(o.field)}</span> },
    { id: "value", header: "Value", cell: (o) => <span className="text-ink">{typeof o.value === "number" ? formatNumber(o.value, 2) : String(o.value ?? "—")}</span> },
    { id: "source", header: "Source", cell: (o) => <span className="text-ink-2">{o.source}</span> },
    { id: "observed", header: "Observed", cell: (o) => <span className="text-ink-2">{formatDate(o.observed_on)}</span> },
    { id: "confidence", header: "Confidence", align: "right", cell: (o) => <ConfidencePill value={o.confidence} /> },
    { id: "verification", header: "Verification", cell: (o) => <StatusBadge status={o.verification} /> },
    { id: "recorded", header: "Recorded", cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(o.recorded_at)}</span> },
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="overflow-hidden lg:col-span-2">
        <CardHeader title="Field history" description="Every recorded value of basis, value, acquisition and exit assumptions, with its source." />
        <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No history yet" />} />
      </Card>
      <Card>
        <CardHeader title="Activity" />
        <CardBody>
          <RecordTimeline entityType="asset" entityId={a.id} />
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

function AssetDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const url = useUrlState();
  const { data: a, isLoading, error } = useAsset(id);
  const scan = useScanWatchlist();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const tab = url.get("tab") ?? "overview";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !a) {
    return <EmptyState title="Asset not found" description={errorMessage(error)} action={<Link href="/assets"><Button>Back to assets</Button></Link>} />;
  }

  const runScan = () =>
    scan.mutate(a.id, {
      onSuccess: (r) => toast.success(`Watchlist scan: ${r.opened} opened, ${r.refreshed} refreshed, ${r.cleared} cleared`),
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Assets", href: "/assets" }, { label: a.property_label }]}
        title={a.property_label}
        description={
          <Link href={`/properties/${a.property_id}`} className="hover:underline">
            {[a.address_line, a.city, a.state].filter(Boolean).join(", ") || "Property record"}
          </Link>
        }
        meta={
          <>
            <AssetStatusBadge status={a.status} />
            {a.property_type && <Badge tone="outline">{PROPERTY_TYPE_LABELS[a.property_type] ?? titleCase(a.property_type)}</Badge>}
            {a.manager_name && (
              <span className="flex items-center gap-1 text-xs text-ink-3">
                <Avatar name={a.manager_name} size={18} /> {a.manager_name}
              </span>
            )}
            {a.acquired_on && <span className="text-xs text-ink-3">Acquired {formatDate(a.acquired_on)}</span>}
          </>
        }
        actions={
          can("assets", "edit") && (
            <>
              <Button loading={scan.isPending} onClick={runScan}>
                <Radar /> Scan watchlist
              </Button>
              <Button onClick={() => setAdding(true)}>
                <Plus /> Add financials
              </Button>
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </>
          )
        }
      />

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v, account: null }, { resetPage: false })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "financials", label: "Financials" },
            { value: "cash-flow", label: "Cash flow" },
            { value: "milestones", label: "Milestones" },
            { value: "watchlist", label: "Watchlist" },
            { value: "history", label: "History" },
          ]}
        />
        <TabPanel value="overview">
          <Overview a={a} />
        </TabPanel>
        <TabPanel value="financials">
          <FinancialsTab a={a} />
        </TabPanel>
        <TabPanel value="cash-flow">
          <CashFlowTab a={a} />
        </TabPanel>
        <TabPanel value="milestones">
          <MilestonesTab a={a} />
        </TabPanel>
        <TabPanel value="watchlist">
          <WatchlistTab a={a} />
        </TabPanel>
        <TabPanel value="history">
          <HistoryTab a={a} />
        </TabPanel>
      </Tabs>

      <AssetFormSheet open={editing} onOpenChange={setEditing} asset={a} />
      <FinancialEntrySheet open={adding} onOpenChange={setAdding} assetId={a.id} />
    </>
  );
}

export default function AssetPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <AssetDetail id={params.id} />
    </Suspense>
  );
}
