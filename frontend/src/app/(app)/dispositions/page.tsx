"use client";

import { ArrowUpRight, Handshake, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent } from "@/lib/utils";

import {
  PROGRESSION,
  STAGE_LABELS,
  STAGE_TONES,
  STAGES,
  useBuyers,
  useDispositionFacets,
  useDispositionQueue,
  type BuyerStats,
  type DispositionListItem,
} from "@/features/dispositions/api";
import { NewDispositionSheet } from "@/features/dispositions/disposition-forms";

const daysUntil = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - t.getTime()) / 86_400_000);
};

const columns: Column<DispositionListItem>[] = [
  {
    id: "disposition",
    header: "Disposition",
    sortKey: "name",
    cell: (d) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{d.name}</p>
        <p className="truncate text-xs text-ink-3">{[d.property_label, d.city, d.state].filter(Boolean).join(", ") || "—"}</p>
      </div>
    ),
  },
  {
    id: "stage",
    header: "Stage",
    sortKey: "stage",
    hideable: true,
    cell: (d) => (
      <span className="flex items-center gap-1.5">
        <Badge tone={STAGE_TONES[d.stage] ?? "neutral"} dot>{STAGE_LABELS[d.stage] ?? d.stage}</Badge>
        {d.is_1031 && <Badge tone="outline">1031</Badge>}
      </span>
    ),
  },
  { id: "days", header: "Days in stage", sortKey: "stage_entered_at", align: "right", hideable: true, cell: (d) => formatNumber(d.days_in_stage) },
  { id: "target", header: "Target price", sortKey: "target_price", align: "right", hideable: true, cell: (d) => formatCurrency(d.target_price, { compact: true }) },
  {
    id: "best_offer",
    header: "Best offer",
    align: "right",
    hideable: true,
    cell: (d) =>
      d.best_offer != null ? (
        <span>
          {formatCurrency(d.best_offer, { compact: true })}
          <span className="ml-1 text-xs text-ink-3">({d.offer_count})</span>
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "contract", header: "Contract price", sortKey: "contract_price", align: "right", hideable: true, cell: (d) => formatCurrency(d.contract_price, { compact: true }) },
  { id: "closing", header: "Target closing", sortKey: "target_closing_on", hideable: true, cell: (d) => <span className="whitespace-nowrap text-ink-2">{formatDate(d.target_closing_on)}</span> },
  {
    id: "deadline",
    header: "Next 1031 deadline",
    hideable: true,
    cell: (d) => {
      const days = daysUntil(d.next_exchange_deadline);
      if (days === null) return <span className="text-ink-3">—</span>;
      return (
        <span className={cn("whitespace-nowrap tabular", days <= 14 ? "font-medium text-negative" : "text-ink-2")}>
          {formatDate(d.next_exchange_deadline)}
          <span className="ml-1 text-xs">{days < 0 ? "· passed" : `· ${days}d`}</span>
        </span>
      );
    },
  },
  {
    id: "owner",
    header: "Owner",
    hideable: true,
    cell: (d) =>
      d.owner_name ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          <Avatar name={d.owner_name} size={18} /> {d.owner_name}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (d) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDate(d.updated_at)}</span> },
];

type BuyerRow = BuyerStats & { id: string };

const buyerColumns: Column<BuyerRow>[] = [
  {
    id: "buyer",
    header: "Buyer",
    cell: (b) =>
      b.buyer_organization_id ? (
        <Link href={`/organizations/${b.buyer_organization_id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
          {b.buyer_name}
        </Link>
      ) : (
        <span className="font-medium text-ink">{b.buyer_name}</span>
      ),
  },
  { id: "offers", header: "Offers", align: "right", cell: (b) => formatNumber(b.offers) },
  { id: "accepted", header: "Accepted", align: "right", cell: (b) => formatNumber(b.accepted) },
  { id: "closed", header: "Closed", align: "right", cell: (b) => formatNumber(b.closed) },
  { id: "fell", header: "Fell through", align: "right", cell: (b) => <span className={cn(b.fell_through > 0 && "text-negative")}>{formatNumber(b.fell_through)}</span> },
  { id: "close_rate", header: "Close rate", align: "right", cell: (b) => formatPercent(b.close_rate, 0) },
  { id: "retrades", header: "Retrades", align: "right", cell: (b) => <span className={cn(b.retrades > 0 && "text-caution")}>{formatNumber(b.retrades)}</span> },
  { id: "retrade_agreed", header: "Retrade agreed", align: "right", cell: (b) => formatCurrency(b.retrade_agreed, { compact: true }) },
  { id: "retrade_pct", header: "Retrade % of price", align: "right", cell: (b) => formatPercent(b.retrade_pct_of_price, 1) },
  { id: "avg_offer", header: "Avg offer", align: "right", cell: (b) => formatCurrency(b.avg_offer, { compact: true }) },
  { id: "last", header: "Last activity", cell: (b) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDate(b.last_activity)}</span> },
];

function CandidateQueue({ onStart }: { onStart: (assetId: string) => void }) {
  const { can } = useAuth();
  const { data, isLoading } = useDispositionQueue();
  const candidates = data?.candidates ?? [];
  const suggestions = data?.suggestions ?? [];
  return (
    <Card className="mb-5">
      <CardHeader
        title="Candidate queue"
        description="Dispositions in the candidate stage and owned assets flagged by hold period, exit target, debt maturity or watchlist."
      />
      <CardBody className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : candidates.length === 0 && suggestions.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-3">No candidates. Assets are suggested here when they reach their hold period, exit target or debt maturity window.</p>
        ) : (
          <ul className="divide-y divide-line">
            {candidates.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <Link href={`/dispositions/${d.id}`} className="truncate text-sm font-medium text-ink hover:underline">
                    {d.name}
                  </Link>
                  <p className="truncate text-xs text-ink-3">{[d.property_label, d.city, d.state].filter(Boolean).join(", ")}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-ink-3">
                  <Badge tone="neutral" dot>Candidate</Badge>
                  <span className="tabular">{formatNumber(d.days_in_stage)} days</span>
                </div>
              </li>
            ))}
            {suggestions.map((s) => (
              <li key={s.asset_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm">
                    <span className="truncate font-medium text-ink">{s.property_label}</span>
                    <Badge tone="outline">Suggested</Badge>
                  </p>
                  <p className="truncate text-xs text-ink-3">{[s.city, s.state].filter(Boolean).join(", ")}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.reasons.map((r) => (
                      <Badge key={r} tone="amber">{r}</Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Link href={s.href}>
                    <Button size="sm" variant="ghost">
                      Asset <ArrowUpRight />
                    </Button>
                  </Link>
                  {can("dispositions", "create") && (
                    <Button size="sm" onClick={() => onStart(s.asset_id)}>
                      Start disposition
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function BuyersView() {
  const [q, setQ] = useState("");
  const { data, isLoading, isFetching } = useBuyers(q || undefined);
  const rows: BuyerRow[] = (data ?? []).map((b) => ({ ...b, id: b.key }));
  return (
    <ListCard
      toolbar={
        <div className="space-y-1">
          <Toolbar>
            <SearchInput value={q} onChange={setQ} placeholder="Search buyers…" shortcut={false} />
          </Toolbar>
          <p className="text-xs text-ink-3">Every offer and retrade is retained so buyer reliability can be judged on future dispositions.</p>
        </div>
      }
    >
      <DataTable
        columns={buyerColumns}
        data={rows}
        loading={isLoading}
        fetching={isFetching}
        empty={<EmptyState icon={<Handshake />} title="No buyer history yet" description="Buyers appear here once offers or retrades are recorded on a disposition." />}
      />
    </ListCard>
  );
}

function DispositionsView() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<DispositionListItem>("dispositions", "/dispositions");
  const { url } = list;
  const cols = useColumnVisibility("dispositions", columns);
  const [creating, setCreating] = useState(false);
  const [startAsset, setStartAsset] = useState<string | null>(null);
  const view = url.get("view") === "buyers" ? "buyers" : "pipeline";

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, view: _v, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useDispositionFacets(filterParams);

  const ownerNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of list.data?.items ?? []) if (r.owner_id && r.owner_name) m[r.owner_id] = r.owner_name;
    return m;
  }, [list.data]);

  const stages = url.getAll("stage");
  const chips: FilterChip[] = [];
  if (stages.length) chips.push({ key: "stage", label: "Stage", value: stages.map((s) => STAGE_LABELS[s] ?? s).join(", "), onRemove: () => url.set({ stage: null }) });
  const owners = url.getAll("owner_id");
  if (owners.length) chips.push({ key: "owner_id", label: "Owner", value: owners.map((o) => ownerNames[o] ?? "Assigned user").join(", "), onRemove: () => url.set({ owner_id: null }) });
  const flags = url.getAll("is_1031");
  if (flags.length) chips.push({ key: "is_1031", label: "1031", value: flags.map((f) => (f === "true" ? "Yes" : "No")).join(", "), onRemove: () => url.set({ is_1031: null }) });

  const openNew = (assetId: string | null) => {
    setStartAsset(assetId);
    setCreating(true);
  };

  return (
    <>
      <PageHeader
        title="Dispositions"
        description="Sale of owned assets from candidate through closing, with hold / sell / refinance analysis and 1031 exchanges."
        actions={
          can("dispositions", "create") && (
            <Button variant="primary" onClick={() => openNew(null)}>
              <Plus /> New disposition
            </Button>
          )
        }
      />

      <CandidateQueue onStart={(id) => openNew(id)} />

      <Tabs value={view} onValueChange={(v) => url.set({ view: v === "pipeline" ? null : v }, { resetPage: false })}>
        <TabList className="mb-4" tabs={[{ value: "pipeline", label: "Pipeline", count: list.data?.total }, { value: "buyers", label: "Buyers" }]} />
        <TabPanel value="pipeline">
          <div className="mb-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-5 lg:grid-cols-9">
            {STAGES.map((s) => {
              const active = stages.length === 1 && stages[0] === s;
              return (
                <button
                  key={s}
                  onClick={() => url.set({ stage: active ? null : [s] })}
                  className={cn("flex flex-col items-start bg-surface px-3 py-2 text-left transition-colors hover:bg-subtle", active && "bg-accent-soft hover:bg-accent-soft")}
                >
                  <span className={cn("text-xs", active ? "font-medium text-accent-ink" : "text-ink-3")}>{STAGE_LABELS[s]}</span>
                  <span className="text-lg font-semibold text-ink tabular">{formatNumber(facets?.stage?.[s] ?? 0)}</span>
                </button>
              );
            })}
          </div>

          <ListCard
            toolbar={
              <div className="space-y-2.5">
                <Toolbar
                  right={
                    <>
                      <SavedViewsMenu module="dispositions" />
                      <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                    </>
                  }
                >
                  <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search disposition, property, buyer…" />
                  <FacetFilter
                    label="Stage"
                    options={STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s], count: facets?.stage?.[s] ?? 0 }))}
                    selected={stages}
                    onChange={(v) => url.set({ stage: v })}
                  />
                  <FacetFilter
                    label="Owner"
                    options={Object.entries(facets?.owner_id ?? {}).map(([v, c]) => ({ value: v, label: ownerNames[v] ?? "Assigned user", count: c }))}
                    selected={owners}
                    onChange={(v) => url.set({ owner_id: v })}
                  />
                  <FacetFilter
                    label="1031"
                    options={[
                      { value: "true", label: "1031 exchange", count: facets?.is_1031?.true ?? 0 },
                      { value: "false", label: "Taxable sale", count: facets?.is_1031?.false ?? 0 },
                    ]}
                    selected={flags}
                    onChange={(v) => url.set({ is_1031: v })}
                  />
                </Toolbar>
                <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort"), view: url.get("view") })} />
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
              rowHref={(d) => `/dispositions/${d.id}`}
              hidden={cols.hidden}
              empty={
                <EmptyState
                  icon={<Handshake />}
                  title={chips.length || url.get("q") ? "No dispositions match these filters" : "No dispositions yet"}
                  description={
                    chips.length || url.get("q")
                      ? "Try removing a filter or broadening your search."
                      : `Start one from the candidate queue or for any owned asset. Stages: ${PROGRESSION.map((s) => STAGE_LABELS[s]).join(" → ")}.`
                  }
                  action={
                    can("dispositions", "create") && !chips.length ? (
                      <Button variant="primary" onClick={() => openNew(null)}>
                        <Plus /> New disposition
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
          </ListCard>
        </TabPanel>
        <TabPanel value="buyers">
          <BuyersView />
        </TabPanel>
      </Tabs>

      <NewDispositionSheet open={creating} onOpenChange={setCreating} assetId={startAsset} onCreated={(d) => router.push(`/dispositions/${d.id}`)} />
    </>
  );
}

export default function DispositionsPage() {
  return (
    <Suspense>
      <DispositionsView />
    </Suspense>
  );
}
