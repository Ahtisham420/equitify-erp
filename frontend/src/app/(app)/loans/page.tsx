"use client";

import { Landmark, Plus, Radar, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader, StatCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import {
  COVENANT_STATE_LABELS,
  COVENANT_STATE_TONES,
  COVENANT_STATES,
  LOAN_STATUSES,
  LOAN_TYPES,
  RATE_TYPES,
  useCovenantStatus,
  useDebtSettings,
  useExposure,
  useLadder,
  useLoanFacets,
  useScanLoans,
  type Covenant,
  type LadderBucket,
  type LoanListItem,
} from "@/features/debt/api";
import { CovenantStateBadge, DebtSettingsSheet, formatCovenantValue, LoanFormSheet } from "@/features/debt/loan-forms";

const MORE: MoreFilterField[] = [{ type: "date-range", label: "Maturity date", minKey: "maturity_from", maxKey: "maturity_to" }];
const CHIP_LABELS: Record<string, string> = { maturity_from: "Matures after", maturity_to: "Matures before" };
const BUCKETS = ["year", "quarter", "month"] as const;
type BucketKind = (typeof BUCKETS)[number];
const STATE_RANK: Record<string, number> = { breach: 5, projected_breach: 4, watch: 3, insufficient_data: 2, pass: 1, none: 0 };

function MaturityCell({ l }: { l: LoanListItem }) {
  if (!l.maturity_on) return <span className="text-ink-3">—</span>;
  const m = l.months_to_maturity;
  const tone = m !== null && m <= 6 ? "font-medium text-negative" : l.in_refi_window ? "font-medium text-caution" : "text-ink-3";
  return (
    <div className="whitespace-nowrap">
      <p className="text-ink">{formatDate(l.maturity_on)}</p>
      <p className={cn("text-xs", tone)}>
        {m === null ? "" : m < 0 ? "Matured" : `${formatNumber(m)} mo`}
        {l.in_refi_window && m !== null && m >= 0 ? " · refi window" : ""}
      </p>
    </div>
  );
}

const columns: Column<LoanListItem>[] = [
  {
    id: "loan",
    header: "Loan",
    sortKey: "label",
    cell: (l) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{l.label}</p>
        <p className="truncate text-xs text-ink-3">{l.property_label ?? "No property linked"}</p>
      </div>
    ),
  },
  { id: "lender", header: "Lender", sortKey: "lender_name", hideable: true, cell: (l) => <span className="text-ink-2">{l.lender_name ?? "—"}</span> },
  { id: "type", header: "Type", sortKey: "loan_type", hideable: true, cell: (l) => <span className="text-ink-2">{titleCase(l.loan_type)}</span> },
  { id: "balance", header: "Balance", sortKey: "current_balance", align: "right", hideable: true, cell: (l) => formatCurrency(l.current_balance, { compact: true }) },
  {
    id: "rate",
    header: "Rate",
    sortKey: "rate",
    align: "right",
    hideable: true,
    cell: (l) => (
      <div className="whitespace-nowrap">
        <p>{formatPercent(l.rate, 2)}</p>
        {l.rate_type === "floating" && <p className="text-xs text-ink-3">floating</p>}
      </div>
    ),
  },
  { id: "maturity", header: "Maturity", sortKey: "maturity_on", hideable: true, cell: (l) => <MaturityCell l={l} /> },
  { id: "covenants", header: "Covenants", sortKey: "covenant_state", hideable: true, cell: (l) => <CovenantStateBadge state={l.covenant_state} /> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (l) => <StatusBadge status={l.status} /> },
  {
    id: "cap",
    header: "Cap expiry",
    hideable: true,
    cell: (l) => {
      if (!l.cap_expires_on) return <span className="text-ink-3">—</span>;
      const days = (new Date(l.cap_expires_on).getTime() - Date.now()) / 86_400_000;
      return <span className={cn("whitespace-nowrap", days < 0 ? "text-ink-3" : days <= 90 ? "font-medium text-caution" : "text-ink-2")}>{formatDate(l.cap_expires_on)}</span>;
    },
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (l) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(l.updated_at)}</span> },
];

function LadderCard({ bucket, onBucket }: { bucket: BucketKind; onBucket: (b: BucketKind) => void }) {
  const router = useRouter();
  const { data, isLoading } = useLadder(bucket);
  const buckets = data?.buckets ?? [];
  return (
    <Card>
      <CardHeader
        title="Maturity ladder"
        description="Active loan balance by maturity. Click a bar or row to open those loans."
        actions={
          <div className="flex rounded-md border border-line-strong/80 p-0.5">
            {BUCKETS.map((b) => (
              <button
                key={b}
                onClick={() => onBucket(b)}
                className={cn("h-6 rounded px-2 text-xs font-medium", b === bucket ? "bg-muted text-ink" : "text-ink-3 hover:text-ink")}
              >
                {titleCase(b)}
              </button>
            ))}
          </div>
        }
      />
      <CardBody>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : buckets.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-3">No active loans with maturity dates</p>
        ) : (
          <>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={buckets}
                  margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                  barCategoryGap={6}
                  style={{ cursor: "pointer" }}
                  onClick={(s) => {
                    const b = buckets.find((x) => x.key === s?.activeLabel);
                    if (b) router.push(b.drill);
                  }}
                >
                  <XAxis dataKey="key" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    tick={{ fontSize: 11, fill: "rgb(var(--ink-3))" }}
                    tickFormatter={(v: number) => formatCurrency(v, { compact: true })}
                  />
                  <ChartTooltip
                    cursor={{ fill: "rgb(var(--muted))" }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const b = payload[0].payload as LadderBucket;
                      return (
                        <div className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
                          <p className="text-ink-3">{b.key}</p>
                          <p className="font-medium text-ink tabular">
                            {formatCurrency(b.balance)} · {formatNumber(b.count)} {b.count === 1 ? "loan" : "loans"}
                          </p>
                          <p className="text-ink-3 tabular">
                            Fixed {formatCurrency(b.fixed_balance, { compact: true })} · Floating {formatCurrency(b.floating_balance, { compact: true })}
                          </p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="balance" fill="rgb(var(--accent))" radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-xs text-ink-3">
                  <th className="py-1 text-left font-medium">Period</th>
                  <th className="py-1 text-right font-medium">Loans</th>
                  <th className="py-1 text-right font-medium">Balance</th>
                  <th className="py-1 text-right font-medium">Fixed</th>
                  <th className="py-1 text-right font-medium">Floating</th>
                  <th className="py-1 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.key} onClick={() => router.push(b.drill)} className="cursor-pointer border-t border-line hover:bg-subtle">
                    <td className="py-1.5 font-medium text-ink">{b.key}</td>
                    <td className="py-1.5 text-right tabular">{formatNumber(b.count)}</td>
                    <td className="py-1.5 text-right tabular">{formatCurrency(b.balance, { compact: true })}</td>
                    <td className="py-1.5 text-right text-ink-2 tabular">{formatCurrency(b.fixed_balance, { compact: true })}</td>
                    <td className="py-1.5 text-right text-ink-2 tabular">{formatCurrency(b.floating_balance, { compact: true })}</td>
                    <td className="py-1.5 text-right text-ink-2 tabular">{formatPercent(b.share_pct, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.undated.length > 0 && <p className="mt-2 text-xs text-ink-3">{formatNumber(data.undated.length)} active loans have no maturity date and are not shown.</p>}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function effectiveState(c: Covenant): string {
  if (c.last_projected_state === "breach" && c.last_state !== "breach") return "projected_breach";
  return c.last_state ?? "insufficient_data";
}

function CovenantStatusCard() {
  const { data, isLoading } = useCovenantStatus();
  const [state, setState] = useState<string | null>(null);
  const rows = useMemo(
    () => (data ?? []).filter((c) => c.is_active).map((c) => ({ c, s: effectiveState(c) })).sort((a, b) => (STATE_RANK[b.s] ?? 0) - (STATE_RANK[a.s] ?? 0)),
    [data],
  );
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.s]: (acc[r.s] ?? 0) + 1 }), {});
  const shown = rows.filter((r) => !state || r.s === state).slice(0, 8);
  return (
    <Card>
      <CardHeader title="Covenant status" description="Latest tests on actual verified results, with projections." />
      <CardBody className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-3">No active covenants</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {COVENANT_STATES.filter((s) => counts[s]).map((s) => (
                <button key={s} onClick={() => setState(state === s ? null : s)} className={cn("rounded", state && state !== s && "opacity-50")}>
                  <Badge tone={COVENANT_STATE_TONES[s]}>
                    {COVENANT_STATE_LABELS[s]} <span className="tabular">{counts[s]}</span>
                  </Badge>
                </button>
              ))}
            </div>
            <ul className="divide-y divide-line">
              {shown.map(({ c, s }) => (
                <li key={c.id}>
                  <Link href={`/loans/${c.loan_id}?tab=covenants`} className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-subtle">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">{c.label}</p>
                      <p className="truncate text-xs text-ink-3">{[c.loan_label, c.property_label].filter(Boolean).join(" · ")}</p>
                    </div>
                    <span className="text-xs text-ink-2 tabular">{formatCovenantValue(c.kind, c.last_value)}</span>
                    <Badge tone={COVENANT_STATE_TONES[s] ?? "neutral"}>{COVENANT_STATE_LABELS[s] ?? titleCase(s)}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function LoansView() {
  const { can } = useAuth();
  const list = useListQuery<LoanListItem>("loans", "/loans");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const cols = useColumnVisibility("loans", columns);
  const scan = useScanLoans();
  const { data: exposure } = useExposure();
  const { data: settings } = useDebtSettings();
  const { data: allFacets } = useLoanFacets({});
  const bucket = (BUCKETS as readonly string[]).includes(url.get("ladder") ?? "") ? (url.get("ladder") as BucketKind) : "year";
  const { data: ladder } = useLadder(bucket);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ladder: _l, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useLoanFacets(filterParams);

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: formatDate(url.get(k)), onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label] of [["status", "Status"], ["rate_type", "Rate"], ["loan_type", "Type"], ["covenant_state", "Covenants"], ["lender_name", "Lender"]] as const) {
    const values = url.getAll(key);
    if (values.length)
      chips.unshift({
        key,
        label,
        value: values.map((v) => (key === "covenant_state" ? COVENANT_STATE_LABELS[v] ?? v : key === "lender_name" ? v : titleCase(v))).join(", "),
        onRemove: () => url.set({ [key]: null }),
      });
  }

  const facetOptions = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (r) => {
        const parts = Object.entries(r)
          .filter(([k, v]) => k !== "loans" && v)
          .map(([k, v]) => `${formatNumber(v)} ${titleCase(k).toLowerCase()}`);
        toast.success(`Scanned ${formatNumber(r.loans ?? 0)} active loans`, { description: parts.length ? parts.join(" · ") : "Nothing new to flag." });
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const refiCount = useMemo(() => {
    if (!ladder || !settings) return null;
    const limit = new Date();
    limit.setMonth(limit.getMonth() + settings.refi_window_months);
    return ladder.buckets.flatMap((b) => b.loans).filter((l) => new Date(l.maturity_on) <= limit).length;
  }, [ladder, settings]);
  const refiTo = useMemo(() => {
    if (!settings) return null;
    const d = new Date();
    d.setMonth(d.getMonth() + settings.refi_window_months);
    return d.toISOString().slice(0, 10);
  }, [settings]);

  const cs = allFacets?.covenant_state ?? {};
  const breaches = (cs.breach ?? 0) + (cs.projected_breach ?? 0);
  const active = !!(chips.length || url.get("q"));

  return (
    <>
      <PageHeader
        title="Loans & debt"
        description="Loan terms, maturities, covenants, reserves and lender reporting across the portfolio."
        actions={
          <>
            {can("debt", "edit") && (
              <Button onClick={runScan} loading={scan.isPending}>
                <Radar /> Run debt scan
              </Button>
            )}
            {can("debt", "approve") && (
              <Button onClick={() => setSettingsOpen(true)}>
                <Settings /> Settings
              </Button>
            )}
            {can("debt", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New loan
              </Button>
            )}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {!exposure ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)
        ) : (
          <>
            <StatCard label="Total balance" value={formatCurrency(exposure.total_balance, { compact: true })} hint={`${formatNumber(allFacets?.status?.active ?? 0)} active loans`} />
            <StatCard
              label="Floating rate"
              value={formatPercent(exposure.floating_pct, 1)}
              hint={`${formatCurrency(exposure.floating_balance, { compact: true })} floating`}
              href={exposure.drill}
            />
            <StatCard
              label="Unhedged floating"
              value={formatCurrency(exposure.unhedged_floating_balance, { compact: true })}
              hint={`${formatCurrency(exposure.annual_cost_per_100bp_unhedged, { compact: true })} per year per 100 bp`}
              tone={(exposure.unhedged_floating_balance ?? 0) > 0 ? "caution" : "default"}
              href={exposure.drill}
            />
            <StatCard label="Weighted rate" value={formatPercent(exposure.weighted_rate, 2)} hint="Balance-weighted, active loans" />
            <StatCard
              label="Refi window · breaches"
              value={
                <span>
                  {refiCount === null ? "—" : formatNumber(refiCount)}
                  <span className="text-ink-3"> · </span>
                  <span className={cn(breaches > 0 && "text-negative")}>{formatNumber(breaches)}</span>
                </span>
              }
              hint={`${formatNumber(cs.watch ?? 0)} on watch`}
              href={breaches > 0 ? "/loans?covenant_state=breach&covenant_state=projected_breach" : refiTo ? `/loans?maturity_to=${refiTo}` : undefined}
            />
          </>
        )}
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LadderCard bucket={bucket} onBucket={(b) => url.set({ ladder: b === "year" ? null : b }, { resetPage: false })} />
        </div>
        <div className="space-y-5">
          <CovenantStatusCard />
          <Card>
            <CardHeader title="Rate cap expirations" description={exposure ? `Floating loans with caps expiring soon` : undefined} />
            <CardBody>
              {!exposure ? (
                <Skeleton className="h-16 w-full" />
              ) : exposure.caps_expiring.length === 0 ? (
                <p className="py-2 text-center text-sm text-ink-3">No caps expiring within the lead time</p>
              ) : (
                <ul className="divide-y divide-line">
                  {exposure.caps_expiring.map((c) => (
                    <li key={c.id}>
                      <Link href={c.href} className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-subtle">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-ink">{c.label}</p>
                          <p className="truncate text-xs text-ink-3">
                            {[c.property_label, c.cap_strike != null ? `${formatPercent(c.cap_strike, 2)} strike` : null].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-medium text-caution">{formatDate(c.cap_expires_on)}</p>
                          <p className="text-xs text-ink-3 tabular">{formatCurrency(c.balance, { compact: true })}</p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="debt" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search loan, number, lender…" />
              <FacetFilter label="Status" options={facetOptions(facets?.status, LOAN_STATUSES, titleCase)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Rate" options={facetOptions(facets?.rate_type, RATE_TYPES, titleCase)} selected={url.getAll("rate_type")} onChange={(v) => url.set({ rate_type: v })} />
              <FacetFilter label="Type" options={facetOptions(facets?.loan_type, LOAN_TYPES, titleCase)} selected={url.getAll("loan_type")} onChange={(v) => url.set({ loan_type: v })} />
              <FacetFilter
                label="Covenants"
                options={facetOptions(facets?.covenant_state, COVENANT_STATES, (v) => COVENANT_STATE_LABELS[v] ?? titleCase(v))}
                selected={url.getAll("covenant_state")}
                onChange={(v) => url.set({ covenant_state: v })}
              />
              <FacetFilter
                label="Lender"
                searchable
                options={Object.entries(facets?.lender_name ?? {}).sort().map(([v, c]) => ({ value: v, label: v, count: c }))}
                selected={url.getAll("lender_name")}
                onChange={(v) => url.set({ lender_name: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort"), ladder: url.get("ladder") })} />
          </div>
        }
        footer={
          <TableFooter
            page={list.page}
            pageSize={list.pageSize}
            total={list.data?.total ?? 0}
            onPage={(page) => url.set({ page }, { resetPage: false })}
            onPageSize={(size) => url.set({ page_size: size })}
          />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowHref={(l) => `/loans/${l.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Landmark />}
              title={active ? "No loans match these filters" : "No loans yet"}
              description={active ? "Try removing a filter or broadening your search." : "Add a loan to track its terms, maturity, covenants and reporting."}
              action={
                can("debt", "create") && !active ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New loan
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <LoanFormSheet open={creating} onOpenChange={setCreating} />
      {can("debt", "approve") && <DebtSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />}
    </>
  );
}

export default function LoansPage() {
  return (
    <Suspense>
      <LoansView />
    </Suspense>
  );
}
