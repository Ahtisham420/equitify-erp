"use client";

import { differenceInCalendarDays, parseISO } from "date-fns";
import { AlertTriangle, ArrowRight, Calculator, Check, Info, MoreHorizontal, Pencil, Plus, Repeat, ShieldAlert, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import {
  IDENTIFICATION_RULE_LABELS,
  PROGRESSION,
  STAGE_TONES,
  stageLabel,
  useAcceptOffer,
  useDeleteDisposition,
  useDisposition,
  useExchange,
  useGates,
  useOffers,
  useProceeds,
  useRetrades,
  useStageEvents,
  type AnnualRow,
  type Comparison,
  type Disposition,
  type ExchangeCandidate,
  type ExchangeInput,
  type Offer,
  type ReconLine,
  type Retrade,
  type Stage,
  type TaxEstimate,
} from "@/features/dispositions/api";
import {
  CandidateSheet,
  CompareSheet,
  DispositionEditSheet,
  ExchangeSheet,
  MoveDispositionDialog,
  OfferSheet,
  RetradeDecisionDialog,
  RetradeSheet,
  TaxCaution,
  comparisonOf,
} from "@/features/dispositions/disposition-forms";

/* ------------------------------------------------------------------ helpers */

const TERMINAL = ["closed", "withdrawn"];
const acct = (v?: number | null) => (v === null || v === undefined ? "—" : v < 0 ? `(${formatCurrency(-v)})` : formatCurrency(v));
const neg = (v?: number | null) => (v === null || v === undefined ? null : -v);

const OFFER_TONES: Record<string, Tone> = {
  received: "sky", countered: "amber", best_and_final: "blue", accepted: "green", backup: "neutral", rejected: "red", withdrawn: "neutral",
};
const OUTCOME_TONES: Record<string, Tone> = { closed: "green", fell_through: "red", pending: "neutral", buyer_walked: "red", seller_terminated: "red" };
const DECISION_TONES: Record<string, Tone> = { pending: "amber", accepted: "green", countered: "blue", rejected: "red" };
const CANDIDATE_TONES: Record<string, Tone> = { candidate: "neutral", identified: "blue", under_contract: "amber", acquired: "green", dropped: "neutral" };

function Tag({ value, tones }: { value: string | null | undefined; tones: Record<string, Tone> }) {
  if (!value) return <span className="text-ink-3">—</span>;
  return (
    <Badge tone={tones[value] ?? "neutral"} dot>
      {titleCase(value)}
    </Badge>
  );
}

function StageBadge({ stage }: { stage: string }) {
  return (
    <Badge tone={STAGE_TONES[stage] ?? "neutral"} dot>
      {stageLabel(stage)}
    </Badge>
  );
}

/** Label / amount row for financial summaries. */
function Line({ label, value, strong, muted, href }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean; href?: string | null }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1.5 text-sm", strong && "border-t border-line font-semibold text-ink")}>
      <span className={cn("min-w-0 truncate", muted ? "text-ink-3" : "text-ink-2", strong && "text-ink")}>
        {href ? (
          <Link href={href} className="hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </span>
      <span className="shrink-0 tabular text-ink">{value}</span>
    </div>
  );
}

function StageStepper({ stage }: { stage: Stage }) {
  const idx = (PROGRESSION as readonly string[]).indexOf(stage);
  const off = idx === -1;
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <ol className="flex min-w-[760px] items-center">
        {PROGRESSION.map((s, i) => {
          const done = !off && (i < idx || stage === "closed");
          const current = s === stage;
          return (
            <li key={s} className="flex flex-1 items-center">
              <div className="flex flex-col items-center gap-1">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-2xs font-semibold",
                    current && stage !== "closed"
                      ? "border-ink bg-ink text-white"
                      : done
                        ? "border-positive bg-positive-soft text-positive"
                        : "border-line-strong bg-surface text-ink-3",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("whitespace-nowrap text-2xs", current ? "font-semibold text-ink" : "text-ink-3")}>{stageLabel(s)}</span>
              </div>
              {i < PROGRESSION.length - 1 && <span className={cn("mx-1 mb-4 h-px flex-1", done && i < idx ? "bg-positive/50" : "bg-line")} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function NextGate({ d, onMove }: { d: Disposition; onMove: (s: Stage) => void }) {
  const { can } = useAuth();
  const { data, isLoading } = useGates(d.id);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  const next = data?.next_stage;
  const gate = data?.stages.find((s) => s.stage === next);
  if (!data || !next || !gate) {
    return (
      <Card>
        <CardHeader title="Next stage" />
        <CardBody className="text-sm text-ink-2">
          {d.stage === "closed"
            ? "Closed — the sale is recorded and the asset is disposed."
            : "Withdrawn — move the disposition back to an active stage to resume. The target stage's requirements apply."}
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader
        title={`Ready for ${stageLabel(next).toLowerCase()}?`}
        description={gate.ready ? "All requirements are met." : "These requirements block advancement."}
        actions={
          can("dispositions", "edit") && (
            <Button size="sm" variant={gate.ready ? "primary" : "secondary"} onClick={() => onMove(next)}>
              {gate.ready ? "Advance" : "Review"} <ArrowRight />
            </Button>
          )
        }
      />
      <CardBody>
        <ul className="space-y-2">
          {gate.requirements.map((r) => (
            <li key={r.key} className="flex items-start gap-2 text-sm">
              {!r.blocking ? (
                <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
              ) : r.met ? (
                <Check className="mt-0.5 size-4 shrink-0 text-positive" />
              ) : (
                <X className="mt-0.5 size-4 shrink-0 text-negative" />
              )}
              <div className="min-w-0">
                <p className="text-ink">{r.label}</p>
                {r.detail && <p className="text-xs text-ink-3">{r.detail}</p>}
              </div>
            </li>
          ))}
          {gate.requirements.length === 0 && <li className="text-sm text-ink-3">No requirements for this stage.</li>}
        </ul>
      </CardBody>
    </Card>
  );
}

function Overview({ d, onMove, onEdit, onCompare }: { d: Disposition; onMove: (s: Stage) => void; onEdit: () => void; onCompare: () => void }) {
  const { can } = useAuth();
  const c = comparisonOf(d);
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        {!c && !TERMINAL.includes(d.stage) && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-caution/30 bg-caution-soft px-4 py-3 text-sm">
            <div>
              <p className="font-medium text-caution">Hold / sell / refinance comparison has not been run</p>
              <p className="mt-0.5 text-ink-2">Compare the alternatives before pricing. The comparison is required to move past the candidate stage.</p>
            </div>
            {can("dispositions", "edit") && (
              <Button size="sm" onClick={onCompare}>
                <Calculator /> Run comparison
              </Button>
            )}
          </div>
        )}
        <Card>
          <CardHeader title="Key fields" actions={can("dispositions", "edit") && <Button size="sm" variant="ghost" onClick={onEdit}><Pencil /> Edit</Button>} />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Owner">{d.owner_name}</FieldItem>
              <FieldItem label="Asset status">{d.asset_status ? titleCase(d.asset_status) : null}</FieldItem>
              <FieldItem label="In stage since">{formatDate(d.stage_entered_at)}</FieldItem>
              <FieldItem label="Target price">{d.target_price != null ? formatCurrency(d.target_price) : null}</FieldItem>
              <FieldItem label="List price">{d.list_price != null ? formatCurrency(d.list_price) : null}</FieldItem>
              <FieldItem label="Comparison run">{d.comparison_at ? formatDateTime(d.comparison_at) : null}</FieldItem>
              <FieldItem label="Broker">
                {d.broker_organization_id ? (
                  <Link href={`/organizations/${d.broker_organization_id}`} className="hover:underline">
                    {d.broker_name || "Broker organization"}
                  </Link>
                ) : (
                  d.broker_name
                )}
              </FieldItem>
              <FieldItem label="Commission">{d.commission_pct != null ? formatPercent(d.commission_pct, 2) : null}</FieldItem>
              <FieldItem label="Marketing launched">{d.marketing_launched_on ? formatDate(d.marketing_launched_on) : null}</FieldItem>
              <FieldItem label="Offers due">{d.offers_due_on ? formatDate(d.offers_due_on) : null}</FieldItem>
              <FieldItem label="Buyer">
                {d.buyer_organization_id ? (
                  <Link href={`/organizations/${d.buyer_organization_id}`} className="hover:underline">
                    {d.buyer_name || "Buyer organization"}
                  </Link>
                ) : (
                  d.buyer_name
                )}
              </FieldItem>
              <FieldItem label="Contract price">{d.contract_price != null ? formatCurrency(d.contract_price) : null}</FieldItem>
              <FieldItem label="Contract executed">{d.contract_executed_on ? formatDate(d.contract_executed_on) : null}</FieldItem>
              <FieldItem label="Buyer DD expires">{d.dd_expires_on ? formatDate(d.dd_expires_on) : null}</FieldItem>
              <FieldItem label="Target closing">{d.target_closing_on ? formatDate(d.target_closing_on) : null}</FieldItem>
              <FieldItem label="Closed on">{d.closed_on ? formatDate(d.closed_on) : null}</FieldItem>
              <FieldItem label="Final sale price">{d.sale_price != null ? formatCurrency(d.sale_price) : null}</FieldItem>
              <FieldItem label="Created">{formatDateTime(d.created_at)}</FieldItem>
            </FieldGrid>
            {(d.reason || d.pricing_notes || d.notes) && (
              <div className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
                {[
                  ["Reason for disposition", d.reason],
                  ["Pricing notes", d.pricing_notes],
                  ["Notes", d.notes],
                ]
                  .filter(([, v]) => v)
                  .map(([label, v]) => (
                    <div key={label}>
                      <p className="text-xs text-ink-3">{label}</p>
                      <p className="whitespace-pre-wrap text-ink-2">{v}</p>
                    </div>
                  ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
      <div className="space-y-5">
        <NextGate d={d} onMove={onMove} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ compare */

interface ScenarioCol {
  label: string;
  sub: string;
  gross: number | null;
  costs: number | null;
  debt: number | null;
  prepay: number | null;
  pre: number | null;
  tax: TaxEstimate;
  after: number | null;
  if1031?: number | null;
  npv: number | null;
  irr: number | null;
  total: number | null;
  noi: number | null;
  cap: number | null;
}

function AnnualTable({ title, rows }: { title: string; rows: AnnualRow[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-subtle text-xs text-ink-3">
              <th className="px-3 py-2 text-left font-medium">Year</th>
              <th className="px-3 py-2 text-right font-medium">NOI</th>
              <th className="px-3 py-2 text-right font-medium">Debt service</th>
              <th className="px-3 py-2 text-right font-medium">Capex</th>
              <th className="px-3 py-2 text-right font-medium">Cash flow</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.year} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5 text-ink-2">{r.year}</td>
                <td className="px-3 py-1.5 text-right tabular">{formatCurrency(r.noi)}</td>
                <td className="px-3 py-1.5 text-right tabular">{acct(neg(r.debt_service))}</td>
                <td className="px-3 py-1.5 text-right tabular">{acct(neg(r.capex))}</td>
                <td className={cn("px-3 py-1.5 text-right font-medium tabular", (r.cash_flow ?? 0) < 0 && "text-negative")}>{acct(r.cash_flow)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function CompareTab({ d, onRun }: { d: Disposition; onRun: () => void }) {
  const { can } = useAuth();
  const c: Comparison | null = comparisonOf(d);
  const canRun = can("dispositions", "edit");
  if (!c) {
    return (
      <Card>
        <EmptyState
          icon={<Calculator />}
          title="No comparison yet"
          description="Model selling now against holding and refinancing, using the asset's NOI, debt, prepayment terms and tax basis."
          action={canRun ? <Button variant="primary" onClick={onRun}><Calculator /> Run comparison</Button> : undefined}
        />
      </Card>
    );
  }
  const n = c.inputs.hold_years ?? c.hold.annual.length;
  const cols: ScenarioCol[] = [
    {
      label: c.sell.label, sub: "Today", gross: c.sell.gross_price, costs: c.sell.selling_costs, debt: c.sell.debt_payoff,
      prepay: c.sell.prepayment_cost, pre: c.sell.pre_tax_proceeds, tax: c.sell.tax, after: c.sell.after_tax_proceeds,
      if1031: c.sell.after_tax_if_1031, npv: null, irr: null, total: null, noi: c.inputs.noi, cap: null,
    },
    ...[c.hold, c.refinance].map((s) => ({
      label: s.label, sub: `Exit in year ${n}`, gross: s.exit.exit_value, costs: s.exit.exit_costs, debt: s.exit.loan_balance_at_exit,
      prepay: s.exit.prepayment_at_exit, pre: s.exit.pre_tax_proceeds, tax: s.exit.tax, after: s.exit.after_tax_proceeds,
      npv: s.npv, irr: s.irr_vs_sale, total: s.total_cash_flow, noi: s.exit.exit_noi, cap: c.inputs.exit_cap_rate,
    })),
  ];
  const has1031 = c.sell.after_tax_if_1031 !== null && c.sell.after_tax_if_1031 !== undefined;
  type Row = { label: string; get: (s: ScenarioCol) => ReactNode; strong?: boolean } | { section: string };
  const rows: Row[] = [
    { label: "Gross price / exit value", get: (s) => formatCurrency(s.gross) },
    { label: "Selling costs", get: (s) => acct(neg(s.costs)) },
    { label: "Debt payoff", get: (s) => acct(neg(s.debt)) },
    { label: "Prepayment cost", get: (s) => acct(neg(s.prepay)) },
    { label: "Pre-tax proceeds", get: (s) => acct(s.pre), strong: true },
    { section: "Tax (modeled estimate)" },
    { label: "Gain on sale", get: (s) => acct(s.tax.gain) },
    { label: "Depreciation recapture", get: (s) => formatCurrency(s.tax.depreciation_recapture) },
    { label: "Recapture tax", get: (s) => acct(neg(s.tax.recapture_tax)) },
    { label: "Capital gains tax", get: (s) => acct(neg(s.tax.capital_gains_tax)) },
    { label: "State tax", get: (s) => acct(neg(s.tax.state_tax)) },
    { label: "NIIT", get: (s) => acct(neg(s.tax.niit)) },
    { label: "Total tax", get: (s) => acct(neg(s.tax.total_tax)), strong: true },
    { label: "After-tax proceeds", get: (s) => acct(s.after), strong: true },
    ...(has1031 ? [{ label: "After tax if 1031 deferred", get: (s: ScenarioCol) => (s.if1031 != null ? acct(s.if1031) : "—") }] : []),
    { section: "Returns" },
    { label: "Total cash flow over hold", get: (s) => acct(s.total) },
    { label: "NPV (after tax)", get: (s) => acct(s.npv) },
    { label: "IRR vs sale today", get: (s) => formatPercent(s.irr, 2) },
    { section: "Exit" },
    { label: "NOI (current / at exit)", get: (s) => formatCurrency(s.noi) },
    { label: "Exit cap rate", get: (s) => formatPercent(s.cap, 2) },
  ];
  const r = c.refinance;
  const inp = c.inputs;

  return (
    <div className="space-y-5">
      <TaxCaution note={c.tax_note} />

      <Card>
        <CardHeader
          title="Hold / sell / refinance"
          description={`Computed ${formatDateTime(c.computed_at)}`}
          actions={canRun && <Button size="sm" onClick={onRun}><Calculator /> Run comparison</Button>}
        />
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line bg-subtle">
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-3" />
                {cols.map((s) => (
                  <th key={s.label} className="px-4 py-2 text-right">
                    <p className="text-sm font-semibold text-ink">{s.label}</p>
                    <p className="text-xs font-normal text-ink-3">{s.sub}</p>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) =>
                "section" in row ? (
                  <tr key={i}>
                    <td colSpan={4} className="border-b border-line px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                      {row.section}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={cn("border-b border-line", row.strong && "bg-subtle/50")}>
                    <td className={cn("px-4 py-1.5", row.strong ? "font-semibold text-ink" : "text-ink-2")}>{row.label}</td>
                    {cols.map((s) => (
                      <td key={s.label} className={cn("px-4 py-1.5 text-right tabular", row.strong && "font-semibold")}>
                        {row.get(s)}
                      </td>
                    ))}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2 text-xs text-ink-3">{c.method_note}</p>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Refinance sizing" description={r.sizing.binding ? `Binding constraint: ${titleCase(r.sizing.binding)}` : undefined} />
          <CardBody className="py-2">
            <Line label="New loan" value={formatCurrency(r.new_loan)} />
            {Object.entries(r.sizing.constraints ?? {}).map(([k, v]) => (
              <Line key={k} label={`Max by ${titleCase(k)}`} value={formatCurrency(v)} muted />
            ))}
            <Line label="Refinance costs" value={acct(neg(r.refi_costs))} />
            <Line label="Annual debt service" value={formatCurrency(r.new_debt_service)} />
            <Line label="Rate" value={formatPercent(inp.refi_rate, 2)} />
            <Line label="Cash out after payoff" value={acct(r.cash_out)} strong />
          </CardBody>
        </Card>
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Risks" description="Conditions the model does not fully capture." />
            <CardBody>
              {c.risks.length ? (
                <ul className="space-y-2">
                  {c.risks.map((x) => (
                    <li key={x} className="flex items-start gap-2 text-sm text-ink-2">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution" />
                      {x}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">No specific risks flagged for these inputs.</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <AnnualTable title={`${c.hold.label} · annual cash flow`} rows={c.hold.annual} />
        <AnnualTable title={`${r.label} · annual cash flow`} rows={r.annual} />
      </div>

      <Card>
        <CardHeader title="Inputs used" description="Blank inputs were filled from the asset, its loans and market defaults." />
        <CardBody>
          <FieldGrid cols={3}>
            <FieldItem label="Current value">{formatCurrency(inp.value)}</FieldItem>
            <FieldItem label="NOI">{formatCurrency(inp.noi)}</FieldItem>
            <FieldItem label="NOI growth">{formatPercent(inp.noi_growth_pct, 2)}</FieldItem>
            <FieldItem label="Hold years">{formatNumber(inp.hold_years)}</FieldItem>
            <FieldItem label="Exit cap rate">{formatPercent(inp.exit_cap_rate, 2)}</FieldItem>
            <FieldItem label="Discount rate">{formatPercent(inp.discount_rate, 2)}</FieldItem>
            <FieldItem label="Sale costs">{formatPercent(inp.sale_cost_pct, 2)}</FieldItem>
            <FieldItem label="Planned capex">{formatCurrency(inp.capex_planned)}</FieldItem>
            <FieldItem label="Remaining lease term">{inp.remaining_lease_term_years != null ? `${formatNumber(inp.remaining_lease_term_years, 1)} yrs` : null}</FieldItem>
            <FieldItem label="Tax basis">{formatCurrency(inp.tax_basis)}</FieldItem>
            <FieldItem label="Accumulated depreciation" extra={inp.accumulated_depreciation_estimated ? <Badge tone="amber">Estimated</Badge> : undefined}>
              {formatCurrency(inp.accumulated_depreciation)}
            </FieldItem>
            <FieldItem label="Land / depreciation life">{`${formatPercent(inp.land_pct, 0)} · ${formatNumber(inp.depreciation_years)} yrs`}</FieldItem>
            <FieldItem label="Tax rates (CG / recapture / state / NIIT)">
              {[inp.cap_gains_rate, inp.recapture_rate, inp.state_rate, inp.niit_rate].map((x) => formatPercent(x, 1)).join(" / ")}
            </FieldItem>
            <FieldItem label="Debt balance">{formatCurrency(inp.debt_balance)}</FieldItem>
            <FieldItem label="First debt maturity">{inp.debt_maturity ? formatDate(inp.debt_maturity) : null}</FieldItem>
            <FieldItem label="Prepayment cost today">{formatCurrency(inp.prepayment_cost_now)}</FieldItem>
            <FieldItem label="Treasury rate">{formatPercent(inp.treasury_rate, 2)}</FieldItem>
            <FieldItem label="Refi rate">{formatPercent(inp.refi_rate, 2)}</FieldItem>
          </FieldGrid>
          {inp.accumulated_depreciation_estimated && (
            <p className="mt-3 text-xs text-ink-3">Accumulated depreciation was estimated from basis, land share, depreciation life and years held. Enter the actual figure for a firmer estimate.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ offers */

function OffersTab({ d }: { d: Disposition }) {
  const { can } = useAuth();
  const offers = useOffers(d.id);
  const retrades = useRetrades(d.id);
  const accept = useAcceptOffer(d.id);
  const [offerSheet, setOfferSheet] = useState<{ open: boolean; offer: Offer | null }>({ open: false, offer: null });
  const [accepting, setAccepting] = useState<Offer | null>(null);
  const [retradeOpen, setRetradeOpen] = useState(false);
  const [deciding, setDeciding] = useState<Retrade | null>(null);
  const active = !TERMINAL.includes(d.stage);
  const canEdit = can("dispositions", "edit");
  const canApprove = can("dispositions", "approve");

  const offerCols: Column<Offer>[] = [
    {
      id: "buyer",
      header: "Buyer",
      cell: (o) => (
        <div className="min-w-[160px]">
          <p className="truncate font-medium text-ink">
            {o.buyer_organization_id ? (
              <Link href={`/organizations/${o.buyer_organization_id}`} className="hover:underline">
                {o.buyer_name}
              </Link>
            ) : (
              o.buyer_name
            )}
          </p>
          {o.broker_name && <p className="truncate text-xs text-ink-3">via {o.broker_name}</p>}
        </div>
      ),
    },
    { id: "price", header: "Price", align: "right", cell: (o) => <span className="font-medium">{formatCurrency(o.price)}</span> },
    { id: "em", header: "EM", align: "right", cell: (o) => formatCurrency(o.earnest_money) },
    { id: "dd", header: "DD days", align: "right", cell: (o) => formatNumber(o.dd_days) },
    { id: "closing", header: "Closing days", align: "right", cell: (o) => formatNumber(o.closing_days) },
    { id: "financing", header: "Financing", cell: (o) => <span className="whitespace-nowrap text-ink-2">{titleCase(o.financing_type)}</span> },
    { id: "received", header: "Received", cell: (o) => <span className="whitespace-nowrap text-ink-2">{formatDate(o.received_on)}</span> },
    { id: "expires", header: "Expires", cell: (o) => <span className="whitespace-nowrap text-ink-2">{formatDate(o.expires_on)}</span> },
    { id: "status", header: "Status", cell: (o) => <Tag value={o.status} tones={OFFER_TONES} /> },
    { id: "outcome", header: "Outcome", cell: (o) => <Tag value={o.outcome} tones={OUTCOME_TONES} /> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (o) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {active && canApprove && !["accepted", "rejected", "withdrawn"].includes(o.status) && (
            <Button size="xs" onClick={() => setAccepting(o)}>
              Accept
            </Button>
          )}
          {canEdit && (
            <Button size="xs" variant="ghost" onClick={() => setOfferSheet({ open: true, offer: o })}>
              <Pencil /> Edit
            </Button>
          )}
        </div>
      ),
    },
  ];

  const retradeCols: Column<Retrade>[] = [
    { id: "requested", header: "Requested", cell: (r) => <span className="whitespace-nowrap text-ink-2">{formatDate(r.requested_on)}</span> },
    { id: "buyer", header: "Buyer", cell: (r) => <span className="font-medium text-ink">{r.buyer_name}</span> },
    { id: "category", header: "Category", cell: (r) => <span className="whitespace-nowrap text-ink-2">{titleCase(r.reason_category)}</span> },
    { id: "reason", header: "Reason", cell: (r) => <p className="max-w-[260px] truncate text-ink-2" title={r.reason}>{r.reason}</p> },
    { id: "amount", header: "Requested", align: "right", cell: (r) => formatCurrency(r.amount_requested) },
    { id: "decision", header: "Decision", cell: (r) => <Tag value={r.decision} tones={DECISION_TONES} /> },
    { id: "agreed", header: "Agreed", align: "right", cell: (r) => formatCurrency(r.agreed_amount) },
    { id: "outcome", header: "Outcome", cell: (r) => <Tag value={r.outcome} tones={OUTCOME_TONES} /> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (r) =>
        canApprove ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Button size="xs" variant="ghost" onClick={() => setDeciding(r)}>
              Decide
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Offers"
          description="All offers received, including rejected and withdrawn ones."
          actions={
            canEdit && active && (
              <Button size="sm" onClick={() => setOfferSheet({ open: true, offer: null })}>
                <Plus /> Record offer
              </Button>
            )
          }
        />
        <DataTable
          columns={offerCols}
          data={offers.data}
          loading={offers.isLoading}
          dense
          empty={<EmptyState title="No offers yet" description="Record each offer as it arrives; the best offer appears on the pipeline." />}
        />
      </Card>

      <Card>
        <CardHeader
          title="Retrades"
          description="Buyer requests to reduce price after contract. Retrades are retained for future counterparty intelligence."
          actions={
            canEdit && active && (
              <Button size="sm" onClick={() => setRetradeOpen(true)}>
                <Plus /> New retrade
              </Button>
            )
          }
        />
        <DataTable
          columns={retradeCols}
          data={retrades.data}
          loading={retrades.isLoading}
          dense
          empty={<EmptyState title="No retrade requests" description="Pending retrades block moving to closing until decided." />}
        />
      </Card>

      <OfferSheet open={offerSheet.open} onOpenChange={(o) => setOfferSheet((s) => ({ ...s, open: o }))} dispositionId={d.id} offer={offerSheet.offer} />
      <RetradeSheet open={retradeOpen} onOpenChange={setRetradeOpen} dispositionId={d.id} offers={offers.data ?? []} acceptedOfferId={d.accepted_offer_id} />
      <RetradeDecisionDialog open={!!deciding} onOpenChange={(o) => !o && setDeciding(null)} dispositionId={d.id} retrade={deciding} />
      <ConfirmDialog
        open={!!accepting}
        onOpenChange={(o) => !o && setAccepting(null)}
        title="Accept this offer?"
        description={
          accepting
            ? `${accepting.buyer_name} at ${formatCurrency(accepting.price)}. The buyer and contract price are set on the disposition; a previously accepted offer becomes a backup.`
            : undefined
        }
        confirmLabel="Accept offer"
        loading={accept.isPending}
        onConfirm={() =>
          accepting &&
          accept.mutate(accepting.id, {
            onSuccess: () => {
              toast.success("Offer accepted");
              setAccepting(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ exchange */

function DeadlineRow({ label, date, days }: { label: string; date: string | null; days: number | null }) {
  const passed = days !== null && days < 0;
  const urgent = days !== null && days <= 14;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-ink-3">{date ? formatDate(date) : "Set the start date to compute"}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {date && <Badge tone="red">Blocking critical date</Badge>}
        <span className={cn("min-w-[80px] text-right text-sm font-semibold tabular", urgent ? "text-negative" : "text-ink")}>
          {days === null ? "—" : passed ? "Passed" : `${formatNumber(days)} days`}
        </span>
      </div>
    </div>
  );
}

function ExchangeTab({ d }: { d: Disposition }) {
  const { can } = useAuth();
  const { data: ex, isLoading } = useExchange(d.id);
  const [editing, setEditing] = useState(false);
  const [cand, setCand] = useState<{ open: boolean; candidate: ExchangeCandidate | null }>({ open: false, candidate: null });
  const canEdit = can("dispositions", "edit");
  const defaults = useMemo<ExchangeInput>(
    () => ({ relinquished_sale_price: d.sale_price ?? d.contract_price ?? d.target_price, start_on: d.closed_on }),
    [d.sale_price, d.contract_price, d.target_price, d.closed_on],
  );

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  const sheets = (
    <>
      <ExchangeSheet open={editing} onOpenChange={setEditing} dispositionId={d.id} exchange={ex ?? null} defaults={defaults} />
      {ex && (
        <CandidateSheet
          open={cand.open}
          onOpenChange={(o) => setCand((s) => ({ ...s, open: o }))}
          dispositionId={d.id}
          candidate={cand.candidate}
          defaultRank={ex.candidates.length + 1}
        />
      )}
    </>
  );

  if (!ex) {
    return (
      <Card>
        <EmptyState
          icon={<Repeat />}
          title="No 1031 exchange"
          description="Set up a forward, reverse or improvement exchange to track the 45-day and 180-day deadlines, replacement candidates and boot."
          action={canEdit ? <Button variant="primary" onClick={() => setEditing(true)}>Set up 1031 exchange</Button> : undefined}
        />
        {sheets}
      </Card>
    );
  }

  const a = ex.analysis;
  const start = ex.start_on;
  const end = a.replacement_deadline ?? ex.replacement_deadline;
  let track: { ident: number; today: number } | null = null;
  if (start && end) {
    const total = Math.max(1, differenceInCalendarDays(parseISO(end), parseISO(start)));
    const pos = (dt: Date) => Math.max(0, Math.min(100, (differenceInCalendarDays(dt, parseISO(start)) / total) * 100));
    const ident = a.identification_deadline ?? ex.identification_deadline;
    track = { ident: ident ? pos(parseISO(ident)) : 0, today: pos(new Date()) };
  }

  const candCols: Column<ExchangeCandidate>[] = [
    { id: "rank", header: "Rank", align: "right", width: 60, cell: (c) => formatNumber(c.rank) },
    {
      id: "property",
      header: "Property",
      cell: (c) => (
        <div className="min-w-[180px]">
          {c.property_id ? (
            <Link href={`/properties/${c.property_id}`} className="font-medium text-ink hover:underline">
              {c.property_label ?? "Property"}
            </Link>
          ) : (
            <span className="font-medium text-ink">{c.description}</span>
          )}
          {c.property_id && c.description && <p className="truncate text-xs text-ink-3">{c.description}</p>}
        </div>
      ),
    },
    { id: "backup", header: "Backup", cell: (c) => (c.is_backup ? <Badge tone="outline">Backup</Badge> : <span className="text-ink-3">—</span>) },
    { id: "status", header: "Status", cell: (c) => <Tag value={c.status} tones={CANDIDATE_TONES} /> },
    { id: "identified", header: "Identified", cell: (c) => <span className="whitespace-nowrap text-ink-2">{formatDate(c.identified_on)}</span> },
    { id: "exp_price", header: "Expected price", align: "right", cell: (c) => formatCurrency(c.expected_price) },
    { id: "exp_debt", header: "Expected debt", align: "right", cell: (c) => formatCurrency(c.expected_debt) },
    { id: "acq_price", header: "Acquired price", align: "right", cell: (c) => formatCurrency(c.acquired_price) },
    { id: "acq_debt", header: "Acquired debt", align: "right", cell: (c) => formatCurrency(c.acquired_debt) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) =>
        canEdit ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Button size="xs" variant="ghost" onClick={() => setCand({ open: true, candidate: c })}>
              <Pencil /> Edit
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Exchange timeline"
              description={`${titleCase(ex.exchange_type)} exchange · ${start ? `${ex.exchange_type === "forward" ? "relinquished closing" : "parking date"} ${formatDate(start)}` : "start date not set"}`}
              actions={
                <>
                  <Tag value={ex.status} tones={{ planned: "neutral", open: "blue", identified: "blue", completed: "green", failed: "red", cancelled: "neutral" }} />
                  {canEdit && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                      <Pencil /> Edit
                    </Button>
                  )}
                </>
              }
            />
            <CardBody>
              <div className="divide-y divide-line">
                <DeadlineRow label="45-day identification deadline" date={a.identification_deadline} days={a.days_to_identification} />
                <DeadlineRow label="180-day replacement deadline" date={a.replacement_deadline} days={a.days_to_replacement} />
              </div>
              {track && start && end && (
                <div className="mt-4">
                  <div className="relative h-2 rounded-full bg-muted">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-accent/40" style={{ width: `${track.today}%` }} />
                    <span className="absolute -top-1 h-4 w-0.5 bg-caution" style={{ left: `${track.ident}%` }} title="Identification deadline" />
                    <span className="absolute -top-1.5 h-5 w-0.5 bg-ink" style={{ left: `${track.today}%` }} title="Today" />
                  </div>
                  <div className="relative mt-1.5 h-4 text-2xs text-ink-3">
                    <span className="absolute left-0">{formatDate(start)}</span>
                    <span className="absolute -translate-x-1/2 text-caution" style={{ left: `${track.ident}%` }}>
                      45 days
                    </span>
                    <span className="absolute right-0">{formatDate(end)}</span>
                  </div>
                </div>
              )}
              <p className="mt-3 text-xs text-ink-3">
                Statutory deadlines cannot be extended; they are tracked as blocking critical dates with reminders to the owner.
                {ex.tax_return_due_on && ` Replacement deadline also limited by the tax return due date ${formatDate(ex.tax_return_due_on)}.`}
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Replacement candidates"
              description={`${IDENTIFICATION_RULE_LABELS[ex.identification_rule] ?? titleCase(ex.identification_rule)} · ${a.identified_count} identified · ${a.backup_count} backup · identification ${a.identification_open ? "open" : "closed"}`}
              actions={
                canEdit && (
                  <Button size="sm" onClick={() => setCand({ open: true, candidate: null })}>
                    <Plus /> Add candidate
                  </Button>
                )
              }
            />
            {a.warnings.length > 0 && (
              <div className="border-b border-line bg-caution-soft px-4 py-2.5">
                <ul className="space-y-1">
                  {a.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-caution">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <DataTable
              columns={candCols}
              data={ex.candidates}
              dense
              empty={<EmptyState title="No replacement candidates" description="Add properties under consideration, then mark them identified before the 45-day deadline." />}
            />
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Parties" />
            <CardBody>
              <FieldGrid cols={1}>
                <FieldItem label="Qualified intermediary">
                  {ex.qi_organization_id ? (
                    <Link href={`/organizations/${ex.qi_organization_id}`} className="hover:underline">
                      {ex.qi_name || "QI organization"}
                    </Link>
                  ) : (
                    ex.qi_name
                  )}
                </FieldItem>
                {ex.exchange_type !== "forward" && (
                  <>
                    <FieldItem label="Exchange accommodation titleholder">
                      {ex.eat_organization_id ? (
                        <Link href={`/organizations/${ex.eat_organization_id}`} className="hover:underline">
                          View organization
                        </Link>
                      ) : null}
                    </FieldItem>
                    <FieldItem label="Parked property">
                      {ex.parked_property_id ? (
                        <Link href={`/properties/${ex.parked_property_id}`} className="hover:underline">
                          {ex.parked_property_label ?? "Property"}
                        </Link>
                      ) : null}
                    </FieldItem>
                  </>
                )}
                {ex.exchange_type === "improvement" && (
                  <FieldItem label="Improvement budget">{ex.improvement_budget != null ? formatCurrency(ex.improvement_budget) : null}</FieldItem>
                )}
                <FieldItem label="Identification rule">{IDENTIFICATION_RULE_LABELS[ex.identification_rule] ?? titleCase(ex.identification_rule)}</FieldItem>
              </FieldGrid>
              {!ex.qi_organization_id && !ex.qi_name && (
                <p className="mt-3 text-xs text-negative">No qualified intermediary recorded. A QI must be engaged before closing.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Boot analysis & basis carryover" />
            <CardBody className="py-2">
              <Line label="Replacement price" value={formatCurrency(a.replacement_price)} muted />
              <Line label="Replacement debt" value={formatCurrency(a.replacement_debt)} muted />
              <Line label="Net equity relinquished" value={acct(a.net_equity_relinquished)} />
              <Line label="Equity reinvested" value={acct(a.equity_reinvested)} />
              <Line label="Cash boot" value={acct(a.cash_boot)} />
              <Line label="Mortgage boot" value={acct(a.mortgage_boot)} />
              <Line label="Total boot" value={acct(a.total_boot)} strong />
              <Line label="Realized gain" value={acct(a.realized_gain)} />
              <Line label="Recognized gain" value={acct(a.recognized_gain)} />
              <Line label="Deferred gain" value={acct(a.deferred_gain)} strong />
              <Line label="Replacement basis" value={acct(a.replacement_basis)} strong />
              <p className="pb-1 pt-2 text-xs text-ink-3">{a.basis_note}</p>
            </CardBody>
          </Card>
          <TaxCaution note={a.tax_note} />
        </div>
      </div>
      {sheets}
    </div>
  );
}

/* ------------------------------------------------------------------ proceeds */

function ReconTable({ lines, total }: { lines: ReconLine[]; total?: { label: string; amount: number | null } }) {
  return (
    <div>
      {lines.map((l, i) => (
        <Line key={i} label={l.label} value={acct(l.amount)} strong={l.subtotal} href={l.href} />
      ))}
      {total && <Line label={total.label} value={acct(total.amount)} strong />}
    </div>
  );
}

function ProceedsTab({ d }: { d: Disposition }) {
  const { data: p, isLoading, error } = useProceeds(d.id);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !p) return <Card><EmptyState title="Proceeds unavailable" description={errorMessage(error)} /></Card>;
  const t = p.tax;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Sale proceeds reconciliation"
            description={`${p.price_source} · closing ${formatDate(p.closing_on)}`}
            actions={p.reconciled ? <Badge tone="green" dot>Reconciles to basis, debt and costs</Badge> : <Badge tone="red" dot>Does not reconcile</Badge>}
          />
          <CardBody className="py-2">
            <ReconTable lines={p.reconciliation} total={{ label: "Distributable proceeds", amount: p.distributable }} />
            {!p.reconciled && (
              <p className="pt-2 text-xs text-negative">Line total {acct(p.reconciliation_total)} differs from distributable proceeds.</p>
            )}
            {p.drill.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-xs">
                {p.drill.map((x) => (
                  <Link key={x.href} href={x.href} className="text-accent hover:underline">
                    {x.label}
                  </Link>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Gain on sale" description="Amount realized less adjusted tax basis." />
          <CardBody className="py-2">
            <ReconTable lines={p.gain_reconciliation} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Debt payoff" description="Allocated share of each active loan, with prepayment cost at the closing date." />
        {p.debt.length ? (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-subtle text-xs text-ink-3">
                  <th className="px-4 py-2 text-left font-medium">Loan</th>
                  <th className="px-4 py-2 text-right font-medium">Payoff</th>
                  <th className="px-4 py-2 text-right font-medium">Prepayment cost</th>
                  <th className="px-4 py-2 text-left font-medium">Prepayment type</th>
                  <th className="px-4 py-2 text-left font-medium">Prepayment</th>
                  <th className="px-4 py-2 text-right font-medium">Reserves released</th>
                </tr>
              </thead>
              <tbody>
                {p.debt.map((l) => (
                  <tr key={l.loan_id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <Link href={l.href} className="font-medium text-ink hover:underline">
                        {l.lender_name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right tabular">{formatCurrency(l.payoff)}</td>
                    <td className="px-4 py-2 text-right tabular">{formatCurrency(l.prepayment_cost)}</td>
                    <td className="px-4 py-2 text-ink-2">{titleCase(l.prepayment_type)}</td>
                    <td className="px-4 py-2">{l.prepayment_allowed ? <Badge tone="green">Allowed</Badge> : <Badge tone="red">Locked out</Badge>}</td>
                    <td className="px-4 py-2 text-right tabular">{formatCurrency(l.reserves_released)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <CardBody className="text-sm text-ink-3">No active loans on this asset.</CardBody>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Tax estimate" description="Modeled estimate subject to professional review." />
          <CardBody className="space-y-3 py-2">
            <div>
              <Line label="Gain on sale" value={acct(t.gain)} />
              <Line label="Depreciation recapture" value={formatCurrency(t.depreciation_recapture)} muted />
              <Line label="Capital gain" value={formatCurrency(t.capital_gain)} muted />
              <Line label="Recapture tax" value={formatCurrency(t.recapture_tax)} />
              <Line label="Capital gains tax" value={formatCurrency(t.capital_gains_tax)} />
              <Line label="State tax" value={formatCurrency(t.state_tax)} />
              <Line label="NIIT" value={formatCurrency(t.niit)} />
              <Line label="Total estimated tax" value={formatCurrency(t.total_tax)} strong />
            </div>
            {p.tax_deferred_1031 && (
              <p className="rounded-md border border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
                Gain is expected to be deferred through the 1031 exchange, so after-tax distributable proceeds exclude this tax. Proceeds go to the qualified intermediary, not to partners.
              </p>
            )}
            <Line label="After-tax distributable" value={acct(p.after_tax_distributable)} strong />
            <TaxCaution note={p.tax_note} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Distributions by partner" description={p.partners_note} />
          {p.partners_unavailable || !p.partners ? (
            <CardBody className="text-sm text-ink-3">Investor data unavailable.</CardBody>
          ) : p.partners.length === 0 ? (
            <CardBody className="text-sm text-ink-3">No investor records for this asset.</CardBody>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-subtle text-xs text-ink-3">
                  <th className="px-4 py-2 text-left font-medium">Partner</th>
                  <th className="px-4 py-2 text-right font-medium">Ownership</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {p.partners.map((x, i) => (
                  <tr key={x.partner_id ?? `u${i}`} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      {x.href ? (
                        <Link href={x.href} className="font-medium text-ink hover:underline">
                          {x.name}
                        </Link>
                      ) : (
                        <span className="text-ink-3">{x.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{formatPercent(x.ownership_pct, 2)}</td>
                    <td className="px-4 py-2 text-right tabular">{acct(x.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ history */

function StageHistory({ id }: { id: string }) {
  const { data, isLoading } = useStageEvents(id);
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.length) return <p className="text-sm text-ink-3">No stage movements yet.</p>;
  return (
    <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-line">
      {data.map((e) => (
        <li key={e.id} className="relative flex gap-3">
          <Avatar name={e.actor_name ?? "System"} className="relative z-10 ring-4 ring-surface" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
              <span className="font-medium">{e.actor_name ?? "System"}</span>
              {e.from_stage ? (
                <>
                  <span className="text-ink-2">moved</span>
                  <StageBadge stage={e.from_stage} />
                  <ArrowRight className="size-3 text-ink-3" />
                </>
              ) : (
                <span className="text-ink-2">created in</span>
              )}
              <StageBadge stage={e.to_stage} />
              {e.override && (
                <Badge tone="red">
                  <ShieldAlert className="size-3" /> Override
                </Badge>
              )}
            </p>
            <p className="text-xs text-ink-3" title={formatDateTime(e.at)}>
              {formatRelative(e.at)}
            </p>
            {e.reason && <p className="mt-1 text-sm text-ink-2">{e.reason}</p>}
            {e.override && e.unmet.length > 0 && <p className="mt-0.5 text-xs text-ink-3">Unmet: {e.unmet.map((r) => r.label).join(", ")}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ page */

const TABS = ["overview", "compare", "offers", "exchange", "proceeds", "history"] as const;

function DispositionDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: d, isLoading, error } = useDisposition(id);
  const gates = useGates(id);
  const remove = useDeleteDisposition();
  const [moveTo, setMoveTo] = useState<Stage | null>(null);
  const [editing, setEditing] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const rawTab = url.get("tab") ?? "overview";
  const tab = (TABS as readonly string[]).includes(rawTab) ? rawTab : "overview";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !d) {
    return (
      <EmptyState
        title="Disposition not found"
        description={errorMessage(error)}
        action={
          <Link href="/dispositions">
            <Button>Back to dispositions</Button>
          </Link>
        }
      />
    );
  }

  const canEdit = can("dispositions", "edit");
  const movable = canEdit && d.stage !== "closed";
  const next = gates.data?.next_stage ?? null;

  const doDelete = () =>
    remove.mutate(id, {
      onSuccess: () => {
        toast.success("Disposition deleted");
        router.replace("/dispositions");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Dispositions", href: "/dispositions" }, { label: d.name }]}
        title={d.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link href={`/properties/${d.property_id}`} className="hover:underline">
              {[d.property_label, d.city, d.state].filter(Boolean).join(", ") || "Property"}
            </Link>
            <Link href={`/assets/${d.asset_id}`} className="text-ink-3 hover:text-ink hover:underline">
              Asset{d.asset_status ? ` · ${titleCase(d.asset_status)}` : ""}
            </Link>
          </span>
        }
        meta={
          <>
            <StageBadge stage={d.stage} />
            {d.is_1031 && <Badge tone="blue">1031 exchange</Badge>}
            <span className="text-xs text-ink-3">In stage since {formatDate(d.stage_entered_at)}</span>
            {d.owner_name && (
              <span className="flex items-center gap-1 text-xs text-ink-3">
                <Avatar name={d.owner_name} size={18} /> {d.owner_name}
              </span>
            )}
          </>
        }
        actions={
          canEdit && (
            <>
              {movable && next && (
                <Button variant="primary" onClick={() => setMoveTo(next)}>
                  Move to {stageLabel(next).toLowerCase()} <ArrowRight />
                </Button>
              )}
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              {movable && (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon" aria-label="More actions">
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent width={220}>
                    <MenuLabel>Move to stage</MenuLabel>
                    {PROGRESSION.filter((s) => s !== d.stage).map((s) => (
                      <MenuItem key={s} onSelect={() => setMoveTo(s)}>
                        {stageLabel(s)}
                      </MenuItem>
                    ))}
                    {d.stage !== "withdrawn" && (
                      <>
                        <MenuSeparator />
                        <MenuItem destructive onSelect={() => setMoveTo("withdrawn")}>
                          Withdraw…
                        </MenuItem>
                      </>
                    )}
                    {can("dispositions", "delete") && (d.stage === "candidate" || d.stage === "withdrawn") && (
                      <>
                        <MenuSeparator />
                        <MenuItem icon={<Trash2 />} destructive onSelect={() => setDeleting(true)}>
                          Delete disposition
                        </MenuItem>
                      </>
                    )}
                  </MenuContent>
                </Menu>
              )}
            </>
          )
        }
      />

      <Card className="mb-5">
        <CardBody>
          <StageStepper stage={d.stage} />
        </CardBody>
      </Card>

      {d.stage === "withdrawn" && (
        <div className="mb-5 rounded-lg border border-negative/30 bg-negative-soft px-4 py-3 text-sm">
          <p className="font-medium text-negative">
            Withdrawn<span className="font-normal text-ink-3"> · {formatDate(d.stage_entered_at)}</span>
          </p>
          {d.withdrawn_reason && <p className="mt-0.5 text-ink-2">{d.withdrawn_reason}</p>}
          <p className="mt-1 text-xs text-ink-3">The record, offers and retrades are retained. Move it back to an active stage to resume.</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "compare", label: "Hold / sell / refi" },
            { value: "offers", label: "Offers & retrades" },
            { value: "exchange", label: "1031 exchange" },
            { value: "proceeds", label: "Proceeds" },
            { value: "history", label: "History" },
          ]}
        />
        <TabPanel value="overview">
          <Overview d={d} onMove={setMoveTo} onEdit={() => setEditing(true)} onCompare={() => setComparing(true)} />
        </TabPanel>
        <TabPanel value="compare">
          <CompareTab d={d} onRun={() => setComparing(true)} />
        </TabPanel>
        <TabPanel value="offers">
          <OffersTab d={d} />
        </TabPanel>
        <TabPanel value="exchange">
          <ExchangeTab d={d} />
        </TabPanel>
        <TabPanel value="proceeds">
          <ProceedsTab d={d} />
        </TabPanel>
        <TabPanel value="history">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Stage history" description="Every movement and override, with actor and reason." />
              <CardBody>
                <StageHistory id={id} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Activity" />
              <CardBody>
                <RecordTimeline entityType="disposition" entityId={id} />
              </CardBody>
            </Card>
          </div>
        </TabPanel>
      </Tabs>

      <MoveDispositionDialog open={!!moveTo} onOpenChange={(v) => !v && setMoveTo(null)} disposition={d} toStage={moveTo} />
      {canEdit && <DispositionEditSheet open={editing} onOpenChange={setEditing} disposition={d} />}
      {canEdit && <CompareSheet open={comparing} onOpenChange={setComparing} disposition={d} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this disposition?"
        description="Only candidate or withdrawn dispositions can be deleted. The record is retained for audit."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={doDelete}
      />
    </>
  );
}

export default function DispositionPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <DispositionDetail id={params.id} />
    </Suspense>
  );
}
