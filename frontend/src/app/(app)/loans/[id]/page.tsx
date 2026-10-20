"use client";

import { AlertTriangle, Archive, ArrowRight, ExternalLink, Landmark, MoreHorizontal, Pencil, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Progress, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useDebounce } from "@/hooks/use-debounce";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, isOverdue, titleCase, toNumber } from "@/lib/utils";

import {
  COVENANT_KIND_LABELS,
  COVENANT_STATE_LABELS,
  COVENANT_STATE_TONES,
  useCovenantTests,
  useDeleteLoan,
  useHoldRefiSell,
  useLoan,
  useLoanCovenants,
  useLoanEvents,
  useObligations,
  usePrepayment,
  useRefinance,
  useRemoveCollateral,
  useReserves,
  useReserveTxns,
  useTestAllCovenants,
  type Collateral,
  type Covenant,
  type CovenantTest,
  type Loan,
  type MarketTerms,
  type Obligation,
  type Reserve,
  type ReserveTxn,
} from "@/features/debt/api";
import {
  CollateralDialog,
  CovenantSheet,
  CovenantStateBadge,
  formatCovenantValue,
  LoanFormSheet,
  ManualTestDialog,
  ObligationSheet,
  ReserveSheet,
  ReserveTxnDialog,
  SubmitObligationDialog,
  todayIso,
} from "@/features/debt/loan-forms";

const daysUntil = (d: string | null | undefined) => (d ? (new Date(d).getTime() - Date.now()) / 86_400_000 : null);

function StateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="text-ink-3">—</span>;
  return <Badge tone={COVENANT_STATE_TONES[state] ?? "neutral"}>{COVENANT_STATE_LABELS[state] ?? titleCase(state)}</Badge>;
}

function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Row actions">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent>{children}</MenuContent>
      </Menu>
    </div>
  );
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return formatNumber(v, 2);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 120);
  return String(v);
}

/* ------------------------------------------------------------------ terms */

function TermsTab({ loan }: { loan: Loan }) {
  const { can } = useAuth();
  const editable = can("debt", "edit");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Collateral | null>(null);
  const remove = useRemoveCollateral(loan.id);
  const capDays = daysUntil(loan.cap_expires_on);
  const swapDays = daysUntil(loan.swap_expires_on);
  const floating = loan.rate_type === "floating";

  const collateralCols: Column<Collateral>[] = [
    {
      id: "property",
      header: "Property",
      cell: (c) => (
        <div className="flex items-center gap-2">
          <Link href={`/properties/${c.property_id}`} className="font-medium text-ink hover:underline">
            {c.property_label ?? "Property"}
          </Link>
          {c.is_primary && <Badge tone="outline">Primary</Badge>}
        </div>
      ),
    },
    { id: "allocated", header: "Allocated amount", align: "right", cell: (c) => formatCurrency(c.allocated_amount) },
    { id: "release", header: "Release price", align: "right", cell: (c) => formatCurrency(c.release_price) },
    {
      id: "actions",
      header: "",
      width: 48,
      cell: (c) =>
        editable && !c.is_primary ? (
          <RowActions>
            <MenuItem icon={<Trash2 />} destructive onSelect={() => setRemoving(c)}>
              Remove from collateral
            </MenuItem>
          </RowActions>
        ) : null,
    },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Loan terms" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Lender">
                {loan.lender_organization_id ? (
                  <Link href={`/organizations/${loan.lender_organization_id}`} className="text-accent hover:underline">
                    {loan.lender_label ?? loan.lender_name ?? "Lender"}
                  </Link>
                ) : (
                  loan.lender_name
                )}
              </FieldItem>
              <FieldItem label="Loan number">{loan.loan_number}</FieldItem>
              <FieldItem label="Loan type">{titleCase(loan.loan_type)}</FieldItem>
              <FieldItem label="Original balance"><span className="tabular">{formatCurrency(loan.original_balance)}</span></FieldItem>
              <FieldItem label="Current balance"><span className="tabular">{formatCurrency(loan.current_balance)}</span></FieldItem>
              <FieldItem label="Reserve balance"><span className="tabular">{formatCurrency(loan.reserve_balance)}</span></FieldItem>
              <FieldItem label="Originated">{loan.originated_on ? formatDate(loan.originated_on) : null}</FieldItem>
              <FieldItem label="Maturity">{loan.maturity_on ? formatDate(loan.maturity_on) : null}</FieldItem>
              <FieldItem label="Months to maturity">
                {loan.months_to_maturity !== null ? (
                  <span className={cn("tabular", loan.months_to_maturity <= 6 ? "font-medium text-negative" : loan.in_refi_window && "font-medium text-caution")}>
                    {loan.months_to_maturity < 0 ? "Matured" : formatNumber(loan.months_to_maturity)}
                  </span>
                ) : null}
              </FieldItem>
              <FieldItem label="Refinance window opens">
                {loan.refi_window_opens_on ? (
                  <span className="flex items-center gap-1.5">
                    {formatDate(loan.refi_window_opens_on)}
                    {loan.in_refi_window && <Badge tone="amber">Open</Badge>}
                  </span>
                ) : null}
              </FieldItem>
              <FieldItem label="Rate type">{titleCase(loan.rate_type)}</FieldItem>
              <FieldItem label="Rate"><span className="tabular">{formatPercent(loan.rate, 2)}</span></FieldItem>
              {floating && <FieldItem label="Index">{loan.index_name}</FieldItem>}
              {floating && <FieldItem label="Spread">{loan.spread !== null ? formatPercent(loan.spread, 2) : null}</FieldItem>}
              {floating && <FieldItem label="Rate floor">{loan.rate_floor !== null ? formatPercent(loan.rate_floor, 2) : null}</FieldItem>}
              <FieldItem label="Amortization">{loan.amortization_months !== null ? `${formatNumber(loan.amortization_months)} months` : null}</FieldItem>
              <FieldItem label="Interest-only">{loan.io_months !== null ? `${formatNumber(loan.io_months)} months` : null}</FieldItem>
              <FieldItem label="Annual debt service"><span className="tabular">{formatCurrency(loan.annual_debt_service)}</span></FieldItem>
              <FieldItem label="Owner">{loan.owner_name}</FieldItem>
              <FieldItem label="Created">{formatDateTime(loan.created_at)}</FieldItem>
              <FieldItem label="Updated">{formatRelative(loan.updated_at)}</FieldItem>
            </FieldGrid>
            {loan.notes && (
              <div className="mt-4 border-t border-line pt-4 text-sm">
                <p className="text-xs text-ink-3">Notes</p>
                <p className="whitespace-pre-wrap text-ink-2">{loan.notes}</p>
              </div>
            )}
          </CardBody>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Collateral"
            description="Properties securing this loan, with allocated amounts and release prices."
            actions={
              editable && (
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus /> Add property
                </Button>
              )
            }
          />
          <DataTable columns={collateralCols} data={loan.collateral} dense empty={<EmptyState title="No collateral linked" description="Link the primary property on the loan, or add cross-collateral." />} />
        </Card>
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Recourse & guarantors" />
          <CardBody className="space-y-4">
            <FieldGrid cols={1}>
              <FieldItem label="Recourse">{titleCase(loan.recourse)}</FieldItem>
            </FieldGrid>
            {loan.recourse_notes && <p className="whitespace-pre-wrap text-sm text-ink-2">{loan.recourse_notes}</p>}
            {loan.guarantors.length === 0 ? (
              <p className="text-sm text-ink-3">No guarantors recorded.</p>
            ) : (
              <ul className="divide-y divide-line">
                {loan.guarantors.map((g, i) => {
                  const href = g.kind === "person" && g.person_id ? `/people/${g.person_id}` : g.kind === "organization" && g.organization_id ? `/organizations/${g.organization_id}` : null;
                  const name = g.name || (href ? "Linked record" : "Unnamed guarantor");
                  return (
                    <li key={i} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        {href ? (
                          <Link href={href} className="truncate text-sm font-medium text-accent hover:underline">
                            {name}
                          </Link>
                        ) : (
                          <p className="truncate text-sm font-medium text-ink">{name}</p>
                        )}
                        <p className="text-xs text-ink-3">
                          {titleCase(g.kind)} · {titleCase(g.guaranty_type)} guaranty
                        </p>
                      </div>
                      <span className="text-sm text-ink-2 tabular">{g.limit_amount !== null ? formatCurrency(g.limit_amount) : "Unlimited"}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {floating && (
          <Card>
            <CardHeader title="Hedging" />
            <CardBody className="space-y-3">
              {capDays !== null && capDays >= 0 && capDays <= 90 && (
                <p className="flex items-center gap-1.5 rounded-md bg-caution-soft px-2.5 py-1.5 text-xs font-medium text-caution">
                  <AlertTriangle className="size-3.5" /> Rate cap expires in {formatNumber(Math.ceil(capDays))} days
                </p>
              )}
              {swapDays !== null && swapDays >= 0 && swapDays <= 90 && (
                <p className="flex items-center gap-1.5 rounded-md bg-caution-soft px-2.5 py-1.5 text-xs font-medium text-caution">
                  <AlertTriangle className="size-3.5" /> Swap expires in {formatNumber(Math.ceil(swapDays))} days
                </p>
              )}
              <FieldGrid cols={2}>
                <FieldItem label="Cap strike">{loan.cap_strike !== null ? formatPercent(loan.cap_strike, 2) : null}</FieldItem>
                <FieldItem label="Cap provider">{loan.cap_provider}</FieldItem>
                <FieldItem label="Cap expires">
                  {loan.cap_expires_on ? <span className={cn(capDays !== null && capDays < 0 && "text-negative")}>{formatDate(loan.cap_expires_on)}</span> : null}
                </FieldItem>
                <div />
                <FieldItem label="Swap rate">{loan.swap_rate !== null ? formatPercent(loan.swap_rate, 2) : null}</FieldItem>
                <FieldItem label="Swap expires">{loan.swap_expires_on ? formatDate(loan.swap_expires_on) : null}</FieldItem>
              </FieldGrid>
            </CardBody>
          </Card>
        )}
      </div>

      <CollateralDialog open={adding} onOpenChange={setAdding} loanId={loan.id} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this property from collateral?"
        description={removing?.property_label ?? undefined}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success("Collateral removed");
              setRemoving(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ prepayment */

function PrepaymentTab({ loan }: { loan: Loan }) {
  const p = loan.prepayment;
  const [payoff, setPayoff] = useState(todayIso());
  const [tsy, setTsy] = useState(p.treasury_rate !== null && p.treasury_rate !== undefined ? String(p.treasury_rate) : "");
  const debouncedTsy = useDebounce(tsy, 400);
  const { data: est, isFetching, error } = usePrepayment(loan.id, payoff || null, toNumber(debouncedTsy));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Prepayment structure" />
        <CardBody className="space-y-4">
          <FieldGrid cols={2}>
            <FieldItem label="Structure">{titleCase(p.type)}</FieldItem>
            <FieldItem label="Lockout ends">{p.lockout_end ? formatDate(p.lockout_end) : null}</FieldItem>
            <FieldItem label="Open at par from">{p.open_from ? formatDate(p.open_from) : null}</FieldItem>
            <FieldItem label="YM floor">{p.ym_floor_pct !== null ? formatPercent(p.ym_floor_pct, 2) : null}</FieldItem>
            <FieldItem label="Treasury rate">{p.treasury_rate !== null ? formatPercent(p.treasury_rate, 2) : null}</FieldItem>
            <FieldItem label="Defeasance fees">{p.defeasance_fee !== null ? formatCurrency(p.defeasance_fee) : null}</FieldItem>
          </FieldGrid>
          {(p.step_down ?? []).length > 0 && (
            <div>
              <p className="mb-1 text-xs text-ink-3">Step-down schedule</p>
              <table className="w-full text-sm">
                <tbody>
                  {p.step_down.map((s, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1.5 text-ink-2">Until {formatDate(s.until)}</td>
                      <td className="py-1.5 text-right tabular">{formatPercent(s.pct, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {p.notes && <p className="whitespace-pre-wrap text-sm text-ink-2">{p.notes}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Prepayment estimator" description="An estimate only; confirm against the servicer payoff statement." />
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Payoff date"><Input type="date" value={payoff} onChange={(e) => setPayoff(e.target.value)} /></Field>
            <Field label="Treasury rate (%)" hint="Blank uses the loan or market setting"><Input value={tsy} onChange={(e) => setTsy(e.target.value)} inputMode="decimal" /></Field>
          </div>
          {error ? (
            <p className="text-sm text-negative">{errorMessage(error)}</p>
          ) : !est ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className={cn("space-y-3", isFetching && "opacity-70")}>
              <div className="flex items-center gap-2">
                {est.allowed ? <Badge tone="green" dot>Prepayment allowed</Badge> : <Badge tone="red" dot>Locked out</Badge>}
                <span className="text-xs text-ink-3">Balance {formatCurrency(est.balance)} on {formatDate(est.payoff_on)}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border border-line p-3">
                  <p className="text-xs text-ink-3">Estimated cost</p>
                  <p className="mt-0.5 text-lg font-semibold tabular">{formatCurrency(est.cost)}</p>
                </div>
                <div className="rounded-md border border-line p-3">
                  <p className="text-xs text-ink-3">Cost % of balance</p>
                  <p className="mt-0.5 text-lg font-semibold tabular">{formatPercent(est.cost_pct, 2)}</p>
                </div>
              </div>
              {est.explanation && <p className="text-sm text-ink-2">{est.explanation}</p>}
              {est.lines.length > 0 && (
                <table className="w-full text-sm">
                  <tbody>
                    {est.lines.map((l, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="py-1.5 text-ink-2">{l.label}</td>
                        <td className="py-1.5 text-right tabular">{formatCurrency(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ reserves */

function ReservesTab({ loan }: { loan: Loan }) {
  const { can } = useAuth();
  const editable = can("debt", "edit");
  const approver = can("debt", "approve");
  const { data: reserves, isLoading } = useReserves(loan.id);
  const { data: txns, isLoading: txnsLoading } = useReserveTxns(loan.id);
  const [editing, setEditing] = useState<Reserve | null>(null);
  const [creating, setCreating] = useState(false);
  const [txn, setTxn] = useState<{ reserve: Reserve; kind: ReserveTxn["kind"] } | null>(null);
  const names = useMemo(() => Object.fromEntries((reserves ?? []).map((r) => [r.id, r.label || titleCase(r.reserve_type)])), [reserves]);

  const cols: Column<Reserve>[] = [
    {
      id: "reserve",
      header: "Reserve",
      cell: (r) => (
        <div>
          <p className="font-medium text-ink">{r.label || titleCase(r.reserve_type)}</p>
          <p className="text-xs text-ink-3">{titleCase(r.reserve_type)}</p>
        </div>
      ),
    },
    { id: "required", header: "Required", align: "right", cell: (r) => formatCurrency(r.required_amount) },
    { id: "monthly", header: "Monthly deposit", align: "right", cell: (r) => formatCurrency(r.monthly_deposit) },
    { id: "cap", header: "Cap", align: "right", cell: (r) => formatCurrency(r.cap_amount) },
    { id: "balance", header: "Balance", align: "right", cell: (r) => <span className="font-medium">{formatCurrency(r.balance)}</span> },
    {
      id: "funded",
      header: "Funded",
      width: 130,
      cell: (r) =>
        r.funded_pct !== null ? (
          <div className="flex items-center gap-2">
            <Progress value={r.funded_pct} className="w-14" />
            <span className="text-xs text-ink-3 tabular">{formatPercent(r.funded_pct, 0)}</span>
          </div>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      width: 48,
      cell: (r) =>
        editable ? (
          <RowActions>
            <MenuItem onSelect={() => setTxn({ reserve: r, kind: "deposit" })}>Record deposit</MenuItem>
            <MenuItem disabled={!approver} onSelect={() => setTxn({ reserve: r, kind: "release" })}>Record release</MenuItem>
            <MenuItem disabled={!approver} onSelect={() => setTxn({ reserve: r, kind: "adjustment" })}>Record adjustment</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Pencil />} onSelect={() => setEditing(r)}>Edit reserve</MenuItem>
          </RowActions>
        ) : null,
    },
  ];

  const txnCols: Column<ReserveTxn>[] = [
    { id: "date", header: "Date", cell: (t) => <span className="whitespace-nowrap">{formatDate(t.occurred_on)}</span> },
    { id: "reserve", header: "Reserve", cell: (t) => <span className="text-ink-2">{names[t.reserve_id] ?? "—"}</span> },
    { id: "kind", header: "Kind", cell: (t) => <Badge tone={t.kind === "deposit" ? "green" : t.kind === "release" ? "amber" : "neutral"}>{titleCase(t.kind)}</Badge> },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      cell: (t) => <span className={cn(t.kind === "release" && "text-negative")}>{formatCurrency(t.kind === "release" ? -t.amount : t.amount)}</span>,
    },
    { id: "after", header: "Balance after", align: "right", cell: (t) => formatCurrency(t.balance_after) },
    { id: "memo", header: "Memo", cell: (t) => <span className="text-ink-2">{t.memo ?? "—"}</span> },
    { id: "doc", header: "Document", cell: (t) => (t.document_id ? <span className="font-mono text-xs text-ink-3">{t.document_id.slice(0, 8)}</span> : <span className="text-ink-3">—</span>) },
  ];

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Reserves"
          description="Releases and adjustments require approval permission."
          actions={
            editable && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> Add reserve
              </Button>
            )
          }
        />
        <DataTable columns={cols} data={reserves} loading={isLoading} dense empty={<EmptyState title="No reserves" description="Add tax, insurance, replacement or other lender-held reserves." />} />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Transactions" description="Every deposit, release and adjustment with the resulting balance." />
        <DataTable columns={txnCols} data={txns} loading={txnsLoading} dense empty={<EmptyState title="No transactions yet" />} />
      </Card>
      <ReserveSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} loanId={loan.id} reserve={editing} />
      <ReserveTxnDialog open={!!txn} onOpenChange={(o) => !o && setTxn(null)} loanId={loan.id} reserve={txn?.reserve ?? null} kind={txn?.kind ?? "deposit"} />
    </div>
  );
}

/* ------------------------------------------------------------------ covenants */

const INPUT_LABELS: [string, string, "currency" | "number" | "percent" | "text"][] = [
  ["noi_ttm", "NOI (TTM)", "currency"],
  ["noi_prior_quarter_ttm", "NOI prior quarter (TTM)", "currency"],
  ["quarterly_trend", "Quarterly NOI trend", "currency"],
  ["debt_service", "Debt service", "currency"],
  ["balance", "Loan balance", "currency"],
  ["value", "Value", "currency"],
  ["value_source", "Value source", "text"],
  ["occupancy", "Occupancy", "percent"],
  ["occupancy_source", "Occupancy source", "text"],
  ["months_verified", "Months verified", "number"],
  ["watch_threshold", "Watch level", "number"],
  ["manual_value", "Manual value", "number"],
];

function formatInput(v: unknown, kind: "currency" | "number" | "percent" | "text") {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return kind === "currency" ? formatCurrency(v) : kind === "percent" ? formatPercent(v, 1) : formatNumber(v, 2);
  return fmtValue(v);
}

function CovenantsTab({ loan }: { loan: Loan }) {
  const { can } = useAuth();
  const editable = can("debt", "edit");
  const { data: covenants, isLoading } = useLoanCovenants(loan.id);
  const { data: tests, isLoading: testsLoading } = useCovenantTests(loan.id);
  const testAll = useTestAllCovenants(loan.id);
  const [editing, setEditing] = useState<Covenant | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<Covenant | null>(null);
  const [inspect, setInspect] = useState<CovenantTest | null>(null);
  const byId = useMemo(() => Object.fromEntries((covenants ?? []).map((c) => [c.id, c])), [covenants]);

  const cols: Column<Covenant>[] = [
    {
      id: "label",
      header: "Covenant",
      cell: (c) => (
        <div className={cn(!c.is_active && "opacity-60")}>
          <p className="font-medium text-ink">{c.label ?? COVENANT_KIND_LABELS[c.kind]}</p>
          <p className="text-xs text-ink-3">
            {COVENANT_KIND_LABELS[c.kind]}
            {!c.is_active && " · inactive"}
          </p>
        </div>
      ),
    },
    { id: "req", header: "Requirement", align: "right", cell: (c) => <span className="whitespace-nowrap">{c.operator === "min" ? "≥" : "≤"} {formatCovenantValue(c.kind, c.threshold)}</span> },
    { id: "watch", header: "Watch level", align: "right", cell: (c) => <span className="text-ink-2">{formatCovenantValue(c.kind, c.effective_watch)}</span> },
    { id: "freq", header: "Frequency", cell: (c) => <span className="text-ink-2">{titleCase(c.frequency)}</span> },
    {
      id: "next",
      header: "Next test",
      cell: (c) =>
        c.next_test_on ? (
          <span className={cn("whitespace-nowrap", c.is_active && isOverdue(c.next_test_on) ? "font-medium text-negative" : "text-ink-2")}>{formatDate(c.next_test_on)}</span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    { id: "value", header: "Last value", align: "right", cell: (c) => formatCovenantValue(c.kind, c.last_value) },
    { id: "state", header: "Last state", cell: (c) => <StateBadge state={c.last_state} /> },
    {
      id: "projected",
      header: "Projected",
      cell: (c) => {
        const warn = c.last_projected_state === "breach" && c.last_state !== "breach";
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-ink-2 tabular">{formatCovenantValue(c.kind, c.last_projected_value)}</span>
            {warn ? <Badge tone="red" dot>Projected breach</Badge> : <StateBadge state={c.last_projected_state} />}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "",
      width: 48,
      cell: (c) =>
        editable ? (
          <RowActions>
            <MenuItem icon={<Play />} onSelect={() => setTesting(c)}>Run test…</MenuItem>
            <MenuItem icon={<Pencil />} onSelect={() => setEditing(c)}>Edit covenant</MenuItem>
          </RowActions>
        ) : null,
    },
  ];

  const testCols: Column<CovenantTest>[] = [
    { id: "date", header: "Tested", cell: (t) => <span className="whitespace-nowrap">{formatDate(t.test_date)}</span> },
    { id: "covenant", header: "Covenant", cell: (t) => <span className="text-ink">{byId[t.covenant_id]?.label ?? "Covenant"}</span> },
    {
      id: "period",
      header: "Period",
      cell: (t) => <span className="whitespace-nowrap text-xs text-ink-3">{t.period_start || t.period_end ? `${formatDate(t.period_start)} – ${formatDate(t.period_end)}` : "—"}</span>,
    },
    { id: "measured", header: "Measured", align: "right", cell: (t) => formatCovenantValue(byId[t.covenant_id]?.kind ?? "", t.measured_value) },
    { id: "threshold", header: "Threshold", align: "right", cell: (t) => <span className="text-ink-2">{formatCovenantValue(byId[t.covenant_id]?.kind ?? "", t.threshold)}</span> },
    { id: "state", header: "State", cell: (t) => <StateBadge state={t.state} /> },
    {
      id: "projected",
      header: "Projected",
      cell: (t) =>
        t.projected_state ? (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-ink-2 tabular">{formatCovenantValue(byId[t.covenant_id]?.kind ?? "", t.projected_value)}</span>
            <StateBadge state={t.projected_state} />
            {t.projected_on && <span className="text-xs text-ink-3">by {formatDate(t.projected_on)}</span>}
          </div>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    { id: "basis", header: "Basis", cell: (t) => (t.is_manual ? <Badge tone="amber">Manual</Badge> : <Badge tone="sky">Actual verified</Badge>) },
    {
      id: "inputs",
      header: "",
      width: 72,
      cell: (t) => (
        <Button size="xs" variant="ghost" onClick={() => setInspect(t)}>
          Inputs
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Covenants"
          description="Tests use actual verified operating results (trailing twelve months), never projections or pro forma. The projection carries the recent trend forward so breaches surface early."
          actions={
            editable && (
              <>
                <Button
                  size="sm"
                  loading={testAll.isPending}
                  disabled={!covenants?.length}
                  onClick={() =>
                    testAll.mutate(undefined, {
                      onSuccess: (r) => toast.success(`${formatNumber(r.length)} covenant tests recorded`),
                      onError: (e) => toast.error(errorMessage(e)),
                    })
                  }
                >
                  <Play /> Test all now
                </Button>
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus /> Add covenant
                </Button>
              </>
            )
          }
        />
        <DataTable
          columns={cols}
          data={covenants}
          loading={isLoading}
          dense
          rowClassName={(c) => (c.last_projected_state === "breach" && c.last_state !== "breach" ? "bg-negative-soft/40" : undefined)}
          empty={<EmptyState title="No covenants" description="Add DSCR, debt yield, LTV, occupancy or guarantor net worth covenants." />}
        />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Test history" description="Every test is retained with the inputs it used. Guarantor net worth is tested manually." />
        <DataTable columns={testCols} data={tests} loading={testsLoading} dense onRowClick={setInspect} empty={<EmptyState title="No tests yet" />} />
      </Card>

      <CovenantSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} loanId={loan.id} covenant={editing} />
      <ManualTestDialog open={!!testing} onOpenChange={(o) => !o && setTesting(null)} loanId={loan.id} covenant={testing} />
      <Dialog
        open={!!inspect}
        onOpenChange={(o) => !o && setInspect(null)}
        title="Test inputs"
        description={inspect ? `${byId[inspect.covenant_id]?.label ?? "Covenant"} · ${formatDate(inspect.test_date)} · ${inspect.is_manual ? "manual value" : "actual verified results"}` : undefined}
      >
        {inspect && (
          <div className="space-y-4">
            <FieldGrid cols={2}>
              {INPUT_LABELS.map(([k, label, kind]) => (
                <FieldItem key={k} label={label}>
                  <span className="tabular">{formatInput(inspect.inputs[k], kind)}</span>
                </FieldItem>
              ))}
            </FieldGrid>
            {inspect.notes && <p className="text-sm text-ink-2">{inspect.notes}</p>}
            {inspect.inputs.drill && inspect.inputs.drill.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                {inspect.inputs.drill.map((d) => (
                  <Link key={d.href} href={d.href} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                    {d.label} <ExternalLink className="size-3.5" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ refinance */

const TERM_FIELDS: { key: keyof MarketTerms; label: string }[] = [
  { key: "rate", label: "Rate (%)" },
  { key: "ltv", label: "Max LTV (%)" },
  { key: "dscr", label: "Min DSCR (x)" },
  { key: "debt_yield", label: "Min debt yield (%)" },
  { key: "amort_years", label: "Amortization (yrs)" },
  { key: "cap_rate", label: "Cap rate (%)" },
  { key: "treasury_rate", label: "Treasury (%)" },
  { key: "refi_cost_pct", label: "Refi costs (%)" },
  { key: "sale_cost_pct", label: "Sale costs (%)" },
];
const CONSTRAINT_LABELS: Record<string, string> = { ltv: "Loan-to-value", dscr: "Debt service coverage", debt_yield: "Debt yield" };

function Line({ label, value, strong, tone }: { label: ReactNode; value: ReactNode; strong?: boolean; tone?: "negative" | "positive" }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1.5 text-sm", strong && "border-t border-line font-semibold")}>
      <span className={cn(strong ? "text-ink" : "text-ink-2")}>{label}</span>
      <span className={cn("tabular", tone === "negative" && "text-negative", tone === "positive" && "text-positive")}>{value}</span>
    </div>
  );
}

function RefinanceTab({ loan }: { loan: Loan }) {
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const debounced = useDebounce(form, 500);
  const terms = useMemo(() => {
    const out: Partial<MarketTerms> = {};
    for (const f of TERM_FIELDS) {
      const n = toNumber(debounced?.[f.key] ?? "");
      if (n !== null) out[f.key] = n;
    }
    return out;
  }, [debounced]);
  const refi = useRefinance(loan.id, terms);
  const hrs = useHoldRefiSell(loan.id, terms);
  const r = refi.data;
  const h = hrs.data;

  useEffect(() => {
    if (r && form === null) setForm(Object.fromEntries(TERM_FIELDS.map((f) => [f.key, String(r.market[f.key])])));
  }, [r, form]);

  if (refi.error) return <EmptyState title="Refinance analysis unavailable" description={errorMessage(refi.error)} />;
  if (!r) return <Skeleton className="h-64 w-full" />;

  const constraints = Object.entries(r.sizing.constraints);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Market terms" description="Prefilled from debt settings. Changes here are for this analysis only." />
        <CardBody>
          <div className="grid grid-cols-3 gap-3 md:grid-cols-5 xl:grid-cols-9">
            {TERM_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <Input value={form?.[f.key] ?? ""} onChange={(e) => setForm((s) => ({ ...(s ?? {}), [f.key]: e.target.value }))} inputMode="decimal" />
              </Field>
            ))}
          </div>
        </CardBody>
      </Card>

      <div className={cn("grid gap-5 lg:grid-cols-3", refi.isFetching && "opacity-80")}>
        <Card>
          <CardHeader title="Refinance window" />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {r.window.in_window ? (
                <Badge tone="amber" dot>In refinance window</Badge>
              ) : r.window.opens_on ? (
                <Badge tone="neutral">Opens {formatDate(r.window.opens_on)}</Badge>
              ) : (
                <Badge tone="neutral">No maturity date</Badge>
              )}
              {r.window.months_to_maturity !== null && <span className="text-xs text-ink-3">{formatNumber(r.window.months_to_maturity)} months to maturity · {r.window.window_months}-month window</span>}
            </div>
            <div>
              <Line label={`NOI${r.noi_period_end ? ` (TTM to ${formatDate(r.noi_period_end)})` : ""}`} value={formatCurrency(r.noi)} />
              <Line label="Value" value={formatCurrency(r.value)} />
              {r.value_basis && <p className="text-xs text-ink-3">{r.value_basis}</p>}
            </div>
            {r.drill.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-3">
                {r.drill.map((d) => (
                  <Link key={d.href + d.label} href={d.href} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                    {d.label} <ArrowRight className="size-3" />
                  </Link>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Loan sizing" description="The lowest constraint binds the new loan amount." />
          <CardBody>
            {constraints.length === 0 ? (
              <p className="text-sm text-ink-3">Not enough NOI or value data to size a new loan.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {constraints.map(([k, v]) => {
                    const binding = r.sizing.binding === k;
                    return (
                      <tr key={k} className={cn("border-b border-line last:border-0", binding && "bg-accent-soft")}>
                        <td className={cn("px-2 py-1.5", binding ? "font-medium text-accent-ink" : "text-ink-2")}>
                          {CONSTRAINT_LABELS[k] ?? titleCase(k)}
                          {binding && <span className="ml-1.5 text-2xs font-semibold uppercase tracking-wide">Binding</span>}
                        </td>
                        <td className={cn("px-2 py-1.5 text-right tabular", binding && "font-semibold text-accent-ink")}>{formatCurrency(v)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="mt-3">
              <Line label="Maximum new loan" value={formatCurrency(r.sizing.max_loan)} strong />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Proceeds" description={`Payoff assumed ${formatDate(r.payoff_on)}`} />
          <CardBody>
            <Line label="Current balance" value={formatCurrency(r.current_balance)} />
            <Line
              label={r.prepayment.allowed ? `Prepayment (${titleCase(r.prepayment.type)})` : "Prepayment (locked out)"}
              value={r.prepayment.allowed ? formatCurrency(r.prepayment.cost) : "—"}
            />
            <Line label="Total payoff" value={formatCurrency(r.payoff)} strong />
            <Line label="Refinance costs" value={formatCurrency(r.refi_costs)} />
            {r.shortfall > 0 ? (
              <Line label="Shortfall (equity required)" value={formatCurrency(-r.shortfall)} strong tone="negative" />
            ) : (
              <Line label="Net proceeds" value={formatCurrency(r.net_proceeds)} strong tone={r.net_proceeds ? "positive" : undefined} />
            )}
            <div className="mt-3 border-t border-line pt-2">
              <Line label="Debt service now → new" value={`${formatCurrency(r.current_annual_debt_service, { compact: true })} → ${formatCurrency(r.new_annual_debt_service, { compact: true })}`} />
              <Line
                label="DSCR now → new"
                value={`${r.current_dscr !== null ? `${r.current_dscr.toFixed(2)}x` : "—"} → ${r.new_dscr !== null ? `${r.new_dscr.toFixed(2)}x` : "—"}`}
              />
            </div>
            {!r.prepayment.allowed && <p className="mt-2 text-xs text-caution">{r.prepayment.explanation}</p>}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Hold, refinance or sell" description={h?.note} />
        <CardBody>
          {!h ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className={cn("grid gap-5 md:grid-cols-3", hrs.isFetching && "opacity-80")}>
              <div>
                <h4 className="mb-1 text-sm font-semibold text-ink">Hold</h4>
                <Line label="Annual cash flow" value={formatCurrency(h.hold.annual_cash_flow)} tone={(h.hold.annual_cash_flow ?? 0) < 0 ? "negative" : undefined} />
                <Line label="Debt service" value={formatCurrency(h.hold.debt_service)} />
                <Line label="DSCR" value={h.hold.dscr !== null ? `${h.hold.dscr.toFixed(2)}x` : "—"} />
                <Line label="Equity" value={formatCurrency(h.hold.equity)} strong />
                <p className="mt-2 text-xs text-ink-3">
                  {h.hold.notes}
                  {h.hold.maturity_on && ` Maturity ${formatDate(h.hold.maturity_on)}.`}
                </p>
              </div>
              <div>
                <h4 className="mb-1 text-sm font-semibold text-ink">Refinance</h4>
                <Line label="New loan" value={formatCurrency(h.refinance.new_loan)} />
                <Line label="Binding constraint" value={h.refinance.binding_constraint ? CONSTRAINT_LABELS[h.refinance.binding_constraint] ?? titleCase(h.refinance.binding_constraint) : "—"} />
                <Line label="Prepayment + costs" value={formatCurrency(h.refinance.prepayment_cost + h.refinance.costs)} />
                <Line label="Annual cash flow" value={formatCurrency(h.refinance.annual_cash_flow)} />
                <Line label="DSCR" value={h.refinance.dscr !== null ? `${h.refinance.dscr.toFixed(2)}x` : "—"} />
                {h.refinance.shortfall > 0 ? (
                  <Line label="Shortfall" value={formatCurrency(-h.refinance.shortfall)} strong tone="negative" />
                ) : (
                  <Line label="Cash out" value={formatCurrency(h.refinance.cash_out)} strong />
                )}
              </div>
              <div>
                <h4 className="mb-1 text-sm font-semibold text-ink">Sell</h4>
                <Line label="Gross price" value={formatCurrency(h.sell.gross_price)} />
                <Line label="Sale costs" value={formatCurrency(h.sell.sale_costs)} />
                <Line label="Debt payoff" value={formatCurrency(h.sell.debt_payoff)} />
                <Line label="Prepayment" value={h.sell.prepayment_allowed ? formatCurrency(h.sell.prepayment_cost) : "Locked out"} tone={h.sell.prepayment_allowed ? undefined : "negative"} />
                <Line label="Net equity" value={formatCurrency(h.sell.net_equity)} strong tone={(h.sell.net_equity ?? 0) < 0 ? "negative" : undefined} />
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ reporting */

function ReportingTab({ loan }: { loan: Loan }) {
  const { can } = useAuth();
  const editable = can("debt", "edit");
  const { data, isLoading } = useObligations(loan.id);
  const [editing, setEditing] = useState<Obligation | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState<Obligation | null>(null);

  const cols: Column<Obligation>[] = [
    {
      id: "report",
      header: "Report",
      cell: (o) => (
        <div className={cn(!o.is_active && "opacity-60")}>
          <p className="font-medium text-ink">{o.label || titleCase(o.report_type)}</p>
          <p className="text-xs text-ink-3">{titleCase(o.report_type)}</p>
        </div>
      ),
    },
    { id: "freq", header: "Frequency", cell: (o) => <span className="text-ink-2">{titleCase(o.frequency)}</span> },
    { id: "days", header: "Days after period", align: "right", cell: (o) => formatNumber(o.days_after_period) },
    {
      id: "due",
      header: "Next due",
      cell: (o) =>
        o.next_due_on ? (
          <span className={cn("whitespace-nowrap", o.overdue ? "font-medium text-negative" : "text-ink-2")}>
            {formatDate(o.next_due_on)}
            {o.overdue && " · overdue"}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      id: "owner",
      header: "Owner",
      cell: (o) =>
        o.owner_name ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
            <Avatar name={o.owner_name} size={20} />
            {o.owner_name}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    { id: "last", header: "Last submitted", cell: (o) => <span className="whitespace-nowrap text-ink-2">{formatDate(o.last_submitted_on)}</span> },
    { id: "active", header: "Active", cell: (o) => <StatusBadge status={o.is_active ? "active" : "inactive"} /> },
    {
      id: "actions",
      header: "",
      width: 120,
      cell: (o) =>
        editable ? (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {o.is_active && (
              <Button size="xs" onClick={() => setSubmitting(o)}>
                Submit
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="Edit obligation" onClick={() => setEditing(o)}>
              <Pencil />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Lender reporting"
        description="Each obligation creates a recurring critical date and an owned task; recording a submission completes them and schedules the next period."
        actions={
          editable && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> Add obligation
            </Button>
          )
        }
      />
      <DataTable
        columns={cols}
        data={data}
        loading={isLoading}
        dense
        rowClassName={(o) => (o.overdue ? "bg-negative-soft/30" : undefined)}
        empty={<EmptyState title="No reporting obligations" description="Add financial statements, rent rolls, compliance certificates and other lender deliverables." />}
      />
      <ObligationSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} loanId={loan.id} obligation={editing} />
      <SubmitObligationDialog open={!!submitting} onOpenChange={(o) => !o && setSubmitting(null)} loanId={loan.id} obligation={submitting} />
    </Card>
  );
}

/* ------------------------------------------------------------------ history */

function HistoryTab({ id }: { id: string }) {
  const { data, isLoading } = useLoanEvents(id);
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Loan history" description="Material term changes are preserved with their effective date; prior values are never overwritten." />
        <CardBody>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !data?.length ? (
            <p className="text-sm text-ink-3">No history recorded yet.</p>
          ) : (
            <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-line">
              {data.map((e) => (
                <li key={e.id} className="relative flex gap-3">
                  <Avatar name={e.actor_name ?? "System"} className="relative z-10 ring-4 ring-surface" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
                      <span className="font-medium">{e.actor_name ?? "System"}</span>
                      <Badge tone="outline">{titleCase(e.event_type)}</Badge>
                      {e.field && <span className="text-ink-2">{titleCase(e.field)}</span>}
                    </p>
                    {(e.from_value !== null || e.to_value !== null) && e.field && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="text-ink-3 line-through decoration-ink-3/40">{fmtValue(e.from_value)}</span>
                        <ArrowRight className="size-3 text-ink-3" />
                        <span className="font-medium text-ink">{fmtValue(e.to_value)}</span>
                      </p>
                    )}
                    {e.note && <p className="mt-0.5 text-sm text-ink-2">{e.note}</p>}
                    <p className="mt-0.5 text-xs text-ink-3" title={formatDateTime(e.at)}>
                      {e.effective_on ? `Effective ${formatDate(e.effective_on)} · ` : ""}
                      {formatRelative(e.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Activity" />
        <CardBody>
          <RecordTimeline entityType="loan" entityId={id} />
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

function LoanDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: loan, isLoading, error } = useLoan(id);
  const remove = useDeleteLoan();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const tab = url.get("tab") ?? "terms";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !loan) {
    return (
      <EmptyState
        icon={<Landmark />}
        title="Loan not found"
        description={errorMessage(error)}
        action={
          <Link href="/loans">
            <Button>Back to loans</Button>
          </Link>
        }
      />
    );
  }

  const archive = () =>
    remove.mutate(id, {
      onSuccess: () => {
        toast.success("Loan archived");
        router.replace("/loans");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Loans", href: "/loans" }, { label: loan.label }]}
        title={loan.label}
        description={
          loan.property_id || loan.asset_id ? (
            <span className="flex flex-wrap items-center gap-x-3">
              {loan.property_id && (
                <Link href={`/properties/${loan.property_id}`} className="hover:underline">
                  {loan.property_label ?? "Property"}
                </Link>
              )}
              {loan.asset_id && (
                <Link href={`/assets/${loan.asset_id}`} className="text-ink-3 hover:text-ink hover:underline">
                  View asset
                </Link>
              )}
            </span>
          ) : undefined
        }
        meta={
          <>
            <StatusBadge status={loan.status} />
            <CovenantStateBadge state={loan.covenant_state} />
            <Badge tone="outline">{titleCase(loan.loan_type)}</Badge>
            <span className="text-xs text-ink-3 tabular">
              {formatCurrency(loan.current_balance)} · {formatPercent(loan.rate, 2)} {loan.rate_type}
              {loan.maturity_on ? ` · matures ${formatDate(loan.maturity_on)}` : ""}
            </span>
          </>
        }
        actions={
          <>
            {can("debt", "edit") && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can("debt", "delete") && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                    Archive loan
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "terms" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "terms", label: "Terms" },
            { value: "prepayment", label: "Prepayment" },
            { value: "reserves", label: "Reserves" },
            { value: "covenants", label: "Covenants" },
            { value: "refinance", label: "Refinance" },
            { value: "reporting", label: "Reporting" },
            { value: "history", label: "History" },
          ]}
        />
        <TabPanel value="terms">
          <TermsTab loan={loan} />
        </TabPanel>
        <TabPanel value="prepayment">
          <PrepaymentTab loan={loan} />
        </TabPanel>
        <TabPanel value="reserves">
          <ReservesTab loan={loan} />
        </TabPanel>
        <TabPanel value="covenants">
          <CovenantsTab loan={loan} />
        </TabPanel>
        <TabPanel value="refinance">
          <RefinanceTab loan={loan} />
        </TabPanel>
        <TabPanel value="reporting">
          <ReportingTab loan={loan} />
        </TabPanel>
        <TabPanel value="history">
          <HistoryTab id={id} />
        </TabPanel>
      </Tabs>

      {can("debt", "edit") && <LoanFormSheet open={editing} onOpenChange={setEditing} loan={loan} />}
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this loan?"
        description="The loan, its covenant tests, reserve ledger and history are retained for audit. It will no longer appear in lists or portfolio totals."
        confirmLabel="Archive"
        destructive
        loading={remove.isPending}
        onConfirm={archive}
      />
    </>
  );
}

export default function LoanPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <LoanDetail id={params.id} />
    </Suspense>
  );
}
