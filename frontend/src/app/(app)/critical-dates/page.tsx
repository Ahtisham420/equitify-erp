"use client";

import { useQuery } from "@tanstack/react-query";
import { addDays, format, parseISO, startOfWeek } from "date-fns";
import { CalendarClock, CalendarDays, Check, List, Lock, Radar, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, PageHeader, StatCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Avatar, Checkbox, Skeleton, Tooltip } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Params } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, titleCase } from "@/lib/utils";

import {
  DATE_STATUS_LABELS,
  DATE_STATUSES,
  DATE_TYPE_LABELS,
  RELATED_TYPE_LABELS,
  isOverdueDate,
  relatedHref,
  useBulkDates,
  useScanDates,
  useUserOptions,
  type CriticalDate,
  type DateFacets,
  type DateSummary,
} from "@/features/contracts/api";
import { DateActionDialog, DateProvenance, DateRowActions, DateStatusBadge, DueText, SourceBadge, type DateDialogKind } from "@/features/contracts/critical-date-actions";
import { MonthCalendar } from "@/features/contracts/month-calendar";

const OPEN_STATUSES = ["proposed", "confirmed", "missed"];
const WINDOWS = [
  { value: "overdue", label: "Overdue" },
  { value: "7", label: "Next 7 days" },
  { value: "30", label: "Next 30 days" },
  { value: "90", label: "Next 90 days" },
];
const MORE: MoreFilterField[] = [{ type: "date-range", label: "Due between", minKey: "due_from", maxKey: "due_to" }];
const VIEW_KEYS = ["view", "month"];

interface Group {
  key: string;
  label: string;
  overdue?: boolean;
  items: CriticalDate[];
}

function groupByWeek(items: CriticalDate[]): Group[] {
  const groups: Group[] = [];
  const overdue = items.filter(isOverdueDate);
  if (overdue.length) groups.push({ key: "overdue", label: "Overdue", overdue: true, items: overdue });
  const thisWeek = format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");
  const nextWeek = format(addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), 7), "yyyy-MM-dd");
  const map = new Map<string, CriticalDate[]>();
  for (const d of items) {
    if (isOverdueDate(d)) continue;
    const wk = format(startOfWeek(parseISO(d.due_on), { weekStartsOn: 1 }), "yyyy-MM-dd");
    map.set(wk, [...(map.get(wk) ?? []), d]);
  }
  for (const [wk, rows] of Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const label = wk === thisWeek ? "This week" : wk === nextWeek ? "Next week" : `Week of ${formatDate(wk, "MMM d, yyyy")}`;
    groups.push({ key: wk, label, items: rows });
  }
  return groups;
}

function DateRowItem({ d, selected, onSelect, selectable, onAction }: { d: CriticalDate; selected: boolean; onSelect: (on: boolean) => void; selectable: boolean; onAction: (k: DateDialogKind) => void }) {
  const href = relatedHref(d);
  return (
    <li className={cn("grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-4 py-2.5 md:grid-cols-[24px_minmax(0,1fr)_190px_150px_auto]", isOverdueDate(d) && "bg-negative-soft/40", selected && "bg-accent-soft/50")}>
      <div>{selectable && <Checkbox checked={selected} onChange={onSelect} label="Select date" />}</div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {d.is_blocking && (
            <Tooltip content="Blocking deadline">
              <Lock className="size-3.5 shrink-0 text-ink-3" />
            </Tooltip>
          )}
          <span className="truncate">{d.label}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <span>{RELATED_TYPE_LABELS[d.related_type] ?? titleCase(d.related_type)}</span>
          {href ? (
            <Link href={href} className="truncate text-ink-2 hover:underline" onClick={(e) => e.stopPropagation()}>
              {d.related_label ?? d.property_label ?? "Open record"}
            </Link>
          ) : (
            d.related_label && <span className="truncate text-ink-2">{d.related_label}</span>
          )}
          {d.property_label && d.related_label && <span className="truncate">· {d.property_label}</span>}
          <span>· {DATE_TYPE_LABELS[d.date_type] ?? titleCase(d.date_type)}</span>
        </p>
      </div>
      <div className="col-start-2 text-sm md:col-start-auto">
        <DueText d={d} />
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-1.5 md:col-start-auto">
        <DateStatusBadge status={d.status} />
        <SourceBadge d={d} />
        {d.owner_name ? (
          <Tooltip content={d.owner_name}>
            <span>
              <Avatar name={d.owner_name} size={18} />
            </span>
          </Tooltip>
        ) : (
          <span className="text-xs text-negative">No owner</span>
        )}
      </div>
      <div className="col-start-2 md:col-start-auto">
        <DateRowActions d={d} compact onAction={onAction} />
      </div>
    </li>
  );
}

function CriticalDatesView() {
  const { can } = useAuth();
  const statusSelected = useUrlState().getAll("status");
  const list = useListQuery<CriticalDate>(
    "critical-dates",
    "/critical-dates",
    { sort: "due_on", view: null, month: null, ...(statusSelected.length ? {} : { status: OPEN_STATUSES }) },
    { pageSize: 100 },
  );
  const { url } = list;
  const view = url.get("view") === "month" ? "month" : "list";
  const month = url.get("month") ?? format(new Date(), "yyyy-MM");
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<{ d: CriticalDate; kind: DateDialogKind } | null>(null);
  const [detail, setDetail] = useState<CriticalDate | null>(null);
  const { data: users } = useUserOptions();
  const bulk = useBulkDates();
  const scan = useScanDates();
  const userName = (id: string) => users?.find((u) => u.id === id)?.full_name ?? "Unknown user";

  const filterParams = useMemo(() => {
    const out: Params = {};
    for (const [k, v] of Object.entries(url.params)) if (!["page", "page_size", "sort", ...VIEW_KEYS].includes(k)) out[k] = v;
    return out;
  }, [url.params]);
  const effectiveFilters = useMemo<Params>(() => (statusSelected.length ? filterParams : { ...filterParams, status: OPEN_STATUSES }), [filterParams, statusSelected.length]);

  const { data: facets } = useQuery({
    queryKey: ["critical-dates", "facets", effectiveFilters],
    queryFn: () => api.get<DateFacets>("/critical-dates/facets", effectiveFilters),
    placeholderData: (prev) => prev,
  });
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["critical-dates", "summary", filterParams],
    queryFn: () => api.get<DateSummary>("/critical-dates/summary", filterParams),
    placeholderData: (prev) => prev,
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const groups = useMemo(() => groupByWeek(items), [items]);
  const selectable = can("contracts", "edit");

  const chips: FilterChip[] = [];
  const add = (key: string, label: string, fmt: (v: string) => string) => {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map(fmt).join(", "), onRemove: () => url.set({ [key]: null }) });
  };
  add("window", "Window", (v) => WINDOWS.find((w) => w.value === v)?.label ?? v);
  add("status", "Status", (v) => DATE_STATUS_LABELS[v] ?? v);
  add("related_type", "Record", (v) => RELATED_TYPE_LABELS[v] ?? titleCase(v));
  add("date_type", "Type", (v) => DATE_TYPE_LABELS[v] ?? titleCase(v));
  add("owner_id", "Owner", userName);
  if (url.get("blocking")) chips.push({ key: "blocking", label: "Blocking", value: "Only", onRemove: () => url.set({ blocking: null }) });
  if (url.get("mine")) chips.push({ key: "mine", label: "Owner", value: "Me", onRemove: () => url.set({ mine: null }) });
  if (url.get("property_id")) chips.push({ key: "property_id", label: "Property", value: "Selected", onRemove: () => url.set({ property_id: null }) });
  if (url.get("due_from")) chips.push({ key: "due_from", label: "Due from", value: formatDate(url.get("due_from")), onRemove: () => url.set({ due_from: null }) });
  if (url.get("due_to")) chips.push({ key: "due_to", label: "Due to", value: formatDate(url.get("due_to")), onRemove: () => url.set({ due_to: null }) });

  const runBulk = (action: "confirm" | "complete") =>
    bulk.mutate(
      { ids: selected, action, note: action === "confirm" ? "Bulk confirmed against source" : null },
      {
        onSuccess: (r) => {
          toast.success(`${r.updated} dates ${action === "confirm" ? "confirmed" : "completed"}`);
          if (r.skipped.length) toast.warning(`Skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).join("; ")}`);
          setSelected([]);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (r) => toast.success(`Scan complete · ${r.tasks ?? 0} tasks, ${r.alerts ?? 0} alerts, ${r.missed ?? 0} newly missed`),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const facetOpts = (counts: Record<string, number> | undefined, values: string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

  return (
    <>
      <PageHeader
        title="Critical dates"
        description="Every accountable deadline across contracts, leases, loans, offers and dispositions."
        actions={
          <>
            <div className="flex rounded-md border border-line-strong/80 bg-surface p-0.5 shadow-card">
              <Button size="sm" variant={view === "list" ? "primary" : "ghost"} onClick={() => url.set({ view: null }, { resetPage: false })}>
                <List /> List
              </Button>
              <Button size="sm" variant={view === "month" ? "primary" : "ghost"} onClick={() => url.set({ view: "month" }, { resetPage: false })}>
                <CalendarDays /> Month
              </Button>
            </div>
            {can("contracts", "edit") && (
              <Button onClick={runScan} loading={scan.isPending}>
                <Radar /> Run escalation scan
              </Button>
            )}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {summaryLoading && !summary ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)
        ) : (
          <>
            <button type="button" className="text-left" onClick={() => url.set({ window: "overdue", status: null })}>
              <StatCard label="Overdue" value={summary?.overdue ?? 0} tone={summary?.overdue ? "negative" : "default"} hint={`${summary?.missed ?? 0} marked missed`} />
            </button>
            <button type="button" className="text-left" onClick={() => url.set({ window: "7", status: null })}>
              <StatCard label="Next 7 days" value={summary?.next_7 ?? 0} tone={summary?.next_7 ? "caution" : "default"} />
            </button>
            <button type="button" className="text-left" onClick={() => url.set({ window: "30", status: null })}>
              <StatCard label="Next 30 days" value={summary?.next_30 ?? 0} hint={`${summary?.next_90 ?? 0} in 90 days`} />
            </button>
            <button type="button" className="text-left" onClick={() => url.set({ status: "proposed", window: null })}>
              <StatCard label="Awaiting confirmation" value={summary?.proposed ?? 0} tone={summary?.proposed ? "caution" : "default"} hint="Not yet verified against source" />
            </button>
            <button type="button" className="text-left" onClick={() => url.set({ blocking: true })}>
              <StatCard label="Blocking, open" value={summary?.blocking_open ?? 0} />
            </button>
          </>
        )}
      </div>

      <div className="mb-3 space-y-2.5">
        <Toolbar right={<SavedViewsMenu module="contracts" />}>
          <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search dates and records…" />
          <FacetFilter label="Window" single options={WINDOWS} selected={url.getAll("window")} onChange={(v) => url.set({ window: v[0] ?? null })} />
          <FacetFilter label="Status" options={facetOpts(facets?.status, [...DATE_STATUSES], (v) => DATE_STATUS_LABELS[v])} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
          <FacetFilter
            label="Record"
            options={Object.entries(facets?.related_type ?? {}).map(([v, n]) => ({ value: v, label: RELATED_TYPE_LABELS[v] ?? titleCase(v), count: n }))}
            selected={url.getAll("related_type")}
            onChange={(v) => url.set({ related_type: v })}
          />
          <FacetFilter
            label="Type"
            searchable
            options={Object.entries(facets?.date_type ?? {}).map(([v, n]) => ({ value: v, label: DATE_TYPE_LABELS[v] ?? titleCase(v), count: n }))}
            selected={url.getAll("date_type")}
            onChange={(v) => url.set({ date_type: v })}
          />
          <FacetFilter
            label="Owner"
            searchable
            options={Object.entries(facets?.owner_id ?? {}).map(([v, n]) => ({ value: v, label: userName(v), count: n }))}
            selected={url.getAll("owner_id")}
            onChange={(v) => url.set({ owner_id: v })}
          />
          <div className="w-56">
            <PropertyPicker value={url.get("property_id")} onChange={(id) => url.set({ property_id: id })} placeholder="Any property" />
          </div>
          <Button variant={url.get("blocking") ? "accent" : "secondary"} onClick={() => url.set({ blocking: url.get("blocking") ? null : true })}>
            <Lock /> Blocking only
          </Button>
          <Button variant={url.get("mine") ? "accent" : "secondary"} onClick={() => url.set({ mine: url.get("mine") ? null : true })}>
            Mine
          </Button>
          <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
        </Toolbar>
        <FilterChips chips={chips} onClear={() => url.replaceAll({ view: url.get("view"), month: url.get("month") })} />
        {!statusSelected.length && <p className="text-xs text-ink-3">Showing open dates (proposed, confirmed, missed). Choose a status to include completed or waived dates.</p>}
      </div>

      {view === "month" ? (
        <MonthCalendar month={month} onMonth={(m) => url.set({ month: m }, { resetPage: false })} filters={effectiveFilters} onSelect={setDetail} />
      ) : (
        <div className="space-y-4">
          {list.isLoading && !list.data ? (
            <Skeleton className="h-64 w-full" />
          ) : groups.length === 0 ? (
            <Card>
              <EmptyState
                icon={<CalendarClock />}
                title={chips.length || url.get("q") ? "No dates match these filters" : "No open critical dates"}
                description={chips.length || url.get("q") ? "Try a wider window or remove a filter." : "Executed contracts, leases and loans add their deadlines here."}
              />
            </Card>
          ) : (
            groups.map((g) => {
              const ids = g.items.map((d) => d.id);
              const all = selectable && ids.every((id) => selected.includes(id));
              return (
                <Card key={g.key} className={cn("overflow-hidden", g.overdue && "border-negative/40")}>
                  <div className={cn("flex items-center gap-3 border-b border-line px-4 py-2", g.overdue ? "bg-negative-soft" : "bg-subtle")}>
                    {selectable && (
                      <Checkbox
                        checked={all}
                        indeterminate={!all && ids.some((id) => selected.includes(id))}
                        onChange={(on) => setSelected((s) => (on ? Array.from(new Set([...s, ...ids])) : s.filter((x) => !ids.includes(x))))}
                        label={`Select ${g.label}`}
                      />
                    )}
                    <h3 className={cn("text-sm font-semibold", g.overdue ? "text-negative" : "text-ink")}>{g.label}</h3>
                    <span className="text-xs text-ink-3 tabular">{g.items.length}</span>
                  </div>
                  <ul className="divide-y divide-line">
                    {g.items.map((d) => (
                      <DateRowItem
                        key={d.id}
                        d={d}
                        selectable={selectable}
                        selected={selected.includes(d.id)}
                        onSelect={(on) => setSelected((s) => (on ? [...s, d.id] : s.filter((x) => x !== d.id)))}
                        onAction={(kind) => setActive({ d, kind })}
                      />
                    ))}
                  </ul>
                </Card>
              );
            })
          )}
          {(list.data?.total ?? 0) > 0 && (
            <Card>
              <TableFooter
                page={list.page}
                pageSize={list.pageSize}
                total={list.data?.total ?? 0}
                onPage={(page) => url.set({ page }, { resetPage: false })}
                onPageSize={(size) => url.set({ page_size: size })}
              />
            </Card>
          )}
        </div>
      )}

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <BulkButton icon={<ShieldCheck />} onClick={() => runBulk("confirm")} disabled={bulk.isPending}>
          Confirm against source
        </BulkButton>
        <BulkButton icon={<Check />} onClick={() => runBulk("complete")} disabled={bulk.isPending}>
          Complete
        </BulkButton>
      </BulkBar>

      <Dialog
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail?.label ?? ""}
        description={detail ? `${RELATED_TYPE_LABELS[detail.related_type] ?? titleCase(detail.related_type)}${detail.related_label ? ` · ${detail.related_label}` : ""}` : undefined}
        footer={detail && <DateRowActions d={detail} onAction={(kind) => { setActive({ d: detail, kind }); setDetail(null); }} />}
      >
        {detail && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <DueText d={detail} />
              <DateStatusBadge status={detail.status} />
              {detail.owner_name && <span className="text-xs text-ink-3">Owner: {detail.owner_name}</span>}
            </div>
            <DateProvenance d={detail} />
            {relatedHref(detail) && (
              <Link href={relatedHref(detail)!} className="text-sm text-accent hover:underline">
                Open related record
              </Link>
            )}
          </div>
        )}
      </Dialog>

      <DateActionDialog date={active?.d ?? null} kind={active?.kind ?? null} onClose={() => setActive(null)} />
    </>
  );
}

export default function CriticalDatesPage() {
  return (
    <Suspense>
      <CriticalDatesView />
    </Suspense>
  );
}
