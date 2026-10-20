"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Briefcase, Columns3, FileCheck2, List, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, FieldGrid, FieldItem, ListCard, StatCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Params } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, isOverdue } from "@/lib/utils";

import { DEAL_SIDES, DEAL_STAGES, label, opts, useMutate, useUserNames, useWorkspace, type Deal, type DealColumn } from "./api";
import { DEAL_FIELDS } from "./forms";
import { RecordSheet, Section, State, party } from "./ui";

const columns: Column<Deal>[] = [
  { id: "title", header: "Deal", sortKey: "title", cell: (d) => <div className="min-w-[200px]"><p className="font-medium text-ink">{d.title}</p><p className="text-xs text-ink-3">{party(d) ?? d.property_label ?? "—"}</p></div> },
  { id: "side", header: "Side", sortKey: "side", cell: (d) => <span className="text-ink-2">{label(d.side)}{d.is_dual_rep && d.side !== "dual" ? " · dual" : ""}</span> },
  { id: "stage", header: "Stage", sortKey: "stage", cell: (d) => <State value={d.stage} /> },
  { id: "value", header: "Deal value", sortKey: "deal_value", align: "right", cell: (d) => formatCurrency(d.deal_value, { compact: true }) },
  { id: "gci", header: "Gross commission", sortKey: "gross_commission_estimate", align: "right", cell: (d) => formatCurrency(d.gross_commission_estimate) },
  { id: "prob", header: "Probability", sortKey: "probability", align: "right", cell: (d) => <span className={cn(d.probability == null && "text-ink-3")}>{formatPercent(d.effective_probability, 0)}</span> },
  { id: "weighted", header: "Weighted", align: "right", cell: (d) => formatCurrency(d.weighted_commission) },
  { id: "close", header: "Expected close", sortKey: "expected_close_on", cell: (d) => <span className={cn("whitespace-nowrap text-xs", isOverdue(d.expected_close_on) && !["closed", "lost"].includes(d.stage) ? "font-medium text-negative" : "text-ink-2")}>{formatDate(d.expected_close_on)}</span> },
  { id: "agent", header: "Agent", cell: (d) => <span className="whitespace-nowrap text-ink-2">{d.agent_name ?? "—"}</span> },
];

function Board({ params, onOpen }: { params: Params; onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ["brokerage", "deal-board", params], queryFn: () => api.get<DealColumn[]>("/brokerage-deals/board", params) });
  return (
    <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
      {(data ?? []).map((c) => (
        <div key={c.stage} className="flex w-64 shrink-0 flex-col rounded-lg border border-line bg-subtle/60">
          <div className="border-b border-line px-3 py-2">
            <div className="flex items-center justify-between">
              <State value={c.stage} />
              <span className="text-xs text-ink-3 tabular">{c.count}</span>
            </div>
            <p className="mt-1 text-2xs text-ink-3 tabular">
              {formatCurrency(c.gross_commission, { compact: true })} GCI · {formatCurrency(c.weighted_commission, { compact: true })} weighted
            </p>
          </div>
          <div className="flex-1 space-y-2 p-2">
            {c.items.map((d) => (
              <button key={d.id} onClick={() => onOpen(d.id)} className="block w-full rounded-md border border-line bg-surface p-2.5 text-left shadow-card hover:border-line-strong">
                <p className="truncate text-sm font-medium text-ink">{d.title}</p>
                <p className="truncate text-xs text-ink-3">{label(d.side)} · {party(d) ?? d.property_label ?? "—"}</p>
                <div className="mt-1.5 flex items-center justify-between text-2xs text-ink-3 tabular">
                  <span>{formatCurrency(d.gross_commission_estimate, { compact: true })} · {formatPercent(d.effective_probability, 0)}</span>
                  <span className={cn(isOverdue(d.expected_close_on) && "font-medium text-negative")}>{d.expected_close_on ? formatDate(d.expected_close_on, "MMM d") : "No date"}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
      {isLoading && <p className="p-3 text-sm text-ink-3">Loading…</p>}
    </div>
  );
}

function MoveDealDialog({ deal, open, onOpenChange }: { deal: Deal; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [to, setTo] = useState(deal.stage);
  const [reason, setReason] = useState("");
  const [lost, setLost] = useState("");
  const [unmet, setUnmet] = useState<string[]>([]);
  const move = useMutate((body: Record<string, unknown>) => api.post(`/brokerage-deals/${deal.id}/move`, body), ["brokerage", "dealroom"]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Move deal"
      description="Moving to under contract opens the transaction-file checklist."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={to === deal.stage}
            loading={move.isPending}
            onClick={() =>
              move.mutate(
                { to_stage: to, reason: reason || null, lost_reason: lost || null },
                {
                  onSuccess: () => {
                    toast.success(`Moved to ${label(to)}`);
                    onOpenChange(false);
                  },
                  onError: (e) => {
                    const d = (e as { detail?: { unmet?: string[] } }).detail;
                    if (d?.unmet) setUnmet(d.unmet);
                    toast.error(errorMessage(e));
                  },
                },
              )
            }
          >
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Stage">
          <Select value={to} onChange={(e) => setTo(e.target.value)} options={opts(DEAL_STAGES)} />
        </Field>
        {to === "lost" && (
          <Field label="Lost reason" required>
            <Input value={lost} onChange={(e) => setLost(e.target.value)} />
          </Field>
        )}
        {unmet.length > 0 && (
          <div className="rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-xs text-ink-2">
            <p className="font-medium text-negative">Requirements not met</p>
            <ul className="mt-1 list-disc pl-4">
              {unmet.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </div>
        )}
        <Field label={unmet.length ? "Override reason" : "Note"} hint={unmet.length ? "Agreement requirements can be overridden by an approver; the reason is audited." : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

interface FileSummary { id: string; completeness_pct: number; complete: boolean; blockers: string[]; status: string }

function DealSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const { data: d } = useQuery({ queryKey: ["brokerage", "deal", id], queryFn: () => api.get<Deal>(`/brokerage-deals/${id}`) });
  const file = useQuery({
    queryKey: ["dealroom", "file-by-deal", id],
    queryFn: () => api.get<FileSummary>(`/transaction-files/by-deal/${id}`),
    enabled: can("dealroom") && can("brokerage"),
    retry: false,
  });
  const [dialog, setDialog] = useState<"edit" | "move" | null>(null);
  const update = useMutate((body: Record<string, unknown>) => api.patch(`/brokerage-deals/${id}`, body));
  const startFile = useMutate(() => api.post("/transaction-files", { brokerage_deal_id: id }), ["dealroom", "brokerage"]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={d?.title ?? "Deal"} description={d ? `${label(d.side)} side${d.is_dual_rep ? " · dual representation" : ""}` : undefined} className="max-w-2xl">
      {!d ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <State value={d.stage} />
            <span className="text-xs text-ink-3">since {formatDate(d.stage_entered_at)}</span>
            {can("brokerage", "edit") && (
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" onClick={() => setDialog("edit")}>
                  <Pencil /> Edit
                </Button>
                <Button size="sm" variant="primary" onClick={() => setDialog("move")}>
                  <ArrowRight /> Move
                </Button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Gross commission" value={formatCurrency(d.gross_commission_estimate, { compact: true })} />
            <StatCard label="Probability" value={formatPercent(d.effective_probability, 0)} hint={d.probability == null ? "Stage default" : "Agent estimate"} />
            <StatCard label="Weighted" value={formatCurrency(d.weighted_commission, { compact: true })} />
          </div>
          <FieldGrid cols={2}>
            <FieldItem label="Property">{d.property_id ? <Link href={`/properties/${d.property_id}`} className="text-accent hover:underline">{d.property_label ?? "Open"}</Link> : null}</FieldItem>
            <FieldItem label="Listing">{d.listing_id ? <Link href={`/listings/${d.listing_id}`} className="text-accent hover:underline">Open listing</Link> : null}</FieldItem>
            <FieldItem label="Client">{party(d)}</FieldItem>
            <FieldItem label="Agent">{d.agent_name}</FieldItem>
            <FieldItem label="Deal value">{d.deal_value != null ? formatCurrency(d.deal_value) : null}</FieldItem>
            <FieldItem label="Commission rate">{d.commission_rate != null ? formatPercent(d.commission_rate, 2) : null}</FieldItem>
            <FieldItem label="Expected close">{d.expected_close_on ? formatDate(d.expected_close_on) : null}</FieldItem>
            <FieldItem label="Next action">{d.next_action_at ? `${d.next_action ?? "Follow up"} · ${formatDate(d.next_action_at)}` : null}</FieldItem>
            {d.closed_on && <FieldItem label="Closed">{`${formatDate(d.closed_on)} · ${formatCurrency(d.closed_price)}`}</FieldItem>}
            {d.lost_reason && <FieldItem label="Lost reason">{d.lost_reason}</FieldItem>}
          </FieldGrid>
          {d.notes && <p className="whitespace-pre-wrap text-sm text-ink-2">{d.notes}</p>}

          {can("dealroom") && (
            <Section title="Transaction file" actions={file.data ? <Link href={`/tours?tab=compliance&file=${file.data.id}`} className="text-xs font-medium text-accent hover:underline">Open checklist</Link> : undefined}>
              {file.data ? (
                <div className="space-y-2 rounded-lg border border-line p-3">
                  <div className="flex items-center gap-3">
                    <Progress value={file.data.completeness_pct} className="flex-1" />
                    <span className="text-sm font-medium tabular">{formatNumber(file.data.completeness_pct, 0)}%</span>
                    {file.data.complete ? <Badge tone="green">Complete</Badge> : <Badge tone="amber">Commission release blocked</Badge>}
                  </div>
                  {file.data.blockers.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                      {file.data.blockers.slice(0, 6).map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between rounded-lg border border-dashed border-line-strong p-3">
                  <p className="text-sm text-ink-3">No transaction file yet. It opens automatically at under contract.</p>
                  {can("dealroom", "create") && (
                    <Button size="sm" loading={startFile.isPending} onClick={() => startFile.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) })}>
                      <FileCheck2 /> Start file
                    </Button>
                  )}
                </div>
              )}
            </Section>
          )}

          <RecordSheet open={dialog === "edit"} onOpenChange={(o) => !o && setDialog(null)} title="Edit deal" mode="edit" fields={DEAL_FIELDS} initial={d as unknown as Record<string, unknown>} onSubmit={(b) => update.mutateAsync(b)} />
          {dialog === "move" && <MoveDealDialog deal={d} open onOpenChange={(o) => !o && setDialog(null)} />}
        </div>
      )}
    </Sheet>
  );
}

export function DealsTab() {
  const { can } = useAuth();
  const url = useUrlState();
  const page = url.getNumber("page", 1);
  const pageSize = url.getNumber("page_size", 25);
  const users = useUserNames();
  const [creating, setCreating] = useState(false);
  const create = useMutate((body: Record<string, unknown>) => api.post<Deal>("/brokerage-deals", body));
  const view = url.get("view") ?? "board";
  // Personal pipeline by default: scope to the signed-in agent unless "all agents" is chosen.
  const scope = url.get("scope") ?? "mine";
  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, view: _v, deal: _d, scope: _sc, ...rest } = url.params;
    return { ...rest, mine: scope === "mine" ? true : undefined } as Params;
  }, [url.params, scope]);
  const ws = useWorkspace(scope === "mine" ? {} : { all_agents: true });
  const { data: facets } = useQuery({
    queryKey: ["brokerage", "deal-facets", filterParams],
    queryFn: () => api.get<{ stage: Record<string, number>; side: Record<string, number>; agent_id: Record<string, number> }>("/brokerage-deals/facets", filterParams),
    placeholderData: (prev) => prev,
  });
  const tableQuery = useQuery({
    queryKey: ["brokerage", "deals", filterParams, page, pageSize, url.get("sort")],
    queryFn: () => api.get<{ items: Deal[]; total: number }>("/brokerage-deals", { ...filterParams, page, page_size: pageSize, sort: url.get("sort") }),
    enabled: view === "table",
  });
  const openId = url.get("deal");

  const chips: FilterChip[] = [];
  for (const [key, l] of [["stage", "Stage"], ["side", "Side"], ["agent_id", "Agent"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label: l, value: values.map((v) => (key === "agent_id" ? users[v] ?? "Agent" : label(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  return (
    <div className="space-y-4">
      {ws.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Pipeline GCI" value={formatCurrency(ws.data.pipeline_gross, { compact: true })} hint={scope === "mine" ? "My open deals" : "All agents"} />
          <StatCard label="Weighted GCI" value={formatCurrency(ws.data.pipeline_weighted, { compact: true })} />
          <StatCard label="Expected in 90 days" value={formatCurrency(ws.data.expected_close_90d, { compact: true })} hint="Weighted" />
          <StatCard label="Agreements expiring" value={ws.data.expiring_agreements} hint="Within 30 days" tone={ws.data.expiring_agreements ? "caution" : "default"} />
          <StatCard label="Overdue next actions" value={ws.data.overdue_actions} tone={ws.data.overdue_actions ? "negative" : "default"} />
        </div>
      )}
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <div className="flex rounded-md border border-line-strong/80 shadow-card">
                    <Button size="icon" variant={view === "board" ? "primary" : "ghost"} onClick={() => url.set({ view: "board" })} aria-label="Board">
                      <Columns3 />
                    </Button>
                    <Button size="icon" variant={view === "table" ? "primary" : "ghost"} onClick={() => url.set({ view: "table" })} aria-label="Table">
                      <List />
                    </Button>
                  </div>
                  <SavedViewsMenu module="brokerage" />
                  {can("brokerage", "create") && (
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Plus /> New deal
                    </Button>
                  )}
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search deals…" />
              <Select value={scope} onChange={(e) => url.set({ scope: e.target.value === "mine" ? null : e.target.value })} options={[{ value: "mine", label: "My pipeline" }, { value: "all", label: "All agents" }]} className="w-36" />
              {view === "table" && <FacetFilter label="Stage" options={DEAL_STAGES.map((s) => ({ value: s, label: label(s), count: facets?.stage[s] ?? 0 }))} selected={url.getAll("stage")} onChange={(v) => url.set({ stage: v })} />}
              <FacetFilter label="Side" options={DEAL_SIDES.map((s) => ({ value: s, label: label(s), count: facets?.side[s] ?? 0 }))} selected={url.getAll("side")} onChange={(v) => url.set({ side: v })} />
              {scope !== "mine" && (
                <FacetFilter label="Agent" searchable options={Object.entries(facets?.agent_id ?? {}).map(([aid, c]) => ({ value: aid, label: users[aid] ?? "Unknown", count: c }))} selected={url.getAll("agent_id")} onChange={(v) => url.set({ agent_id: v })} />
              )}
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), view: url.get("view"), scope: url.get("scope") })} />
          </div>
        }
        footer={view === "table" ? <TableFooter page={page} pageSize={pageSize} total={tableQuery.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} /> : undefined}
      >
        {view === "board" ? (
          <div className="p-3">
            <Board params={filterParams} onOpen={(did) => url.set({ deal: did }, { resetPage: false })} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={tableQuery.data?.items}
            loading={tableQuery.isLoading}
            fetching={tableQuery.isFetching}
            sort={url.get("sort")}
            onSortChange={(sort) => url.set({ sort })}
            onRowClick={(d) => url.set({ deal: d.id }, { resetPage: false })}
            empty={<EmptyState icon={<Briefcase />} title="No deals in this view" description="Add listing, buyer or tenant transactions to build the pipeline." />}
          />
        )}
      </ListCard>
      <RecordSheet
        open={creating}
        onOpenChange={setCreating}
        title="New brokerage deal"
        fields={DEAL_FIELDS}
        initial={{ side: "listing" }}
        onSubmit={async (b) => {
          const d = await create.mutateAsync(b);
          url.set({ deal: d.id }, { resetPage: false });
        }}
      />
      {openId && <DealSheet id={openId} onClose={() => url.set({ deal: null }, { resetPage: false })} />}
    </div>
  );
}
