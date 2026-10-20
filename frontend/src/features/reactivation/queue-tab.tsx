"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BellOff, History, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import { FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatRelative, titleCase } from "@/lib/utils";

import { DEAD_REASON_LABELS, stageLabel } from "@/features/pipeline/api";

import { ITEM_STATUSES, useReactivationMeta, type Change, type ReactivationItem } from "./api";
import { DismissDialog, ReactivateDialog, SnoozeDialog } from "./action-dialogs";

const STATUS_TONES: Record<string, Tone> = { pending: "blue", snoozed: "amber", reactivated: "green", dismissed: "neutral" };

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return `${v.length} owner${v.length === 1 ? "" : "s"}`;
  if (typeof v === "number") return v >= 1000 ? formatCurrency(v, { compact: true }) : String(v);
  return String(v);
}

function ChangeRow({ c }: { c: Change }) {
  const hasDelta = c.from !== null && c.from !== undefined && c.to !== null && c.to !== undefined && typeof c.to !== "object";
  return (
    <li className="space-y-0.5">
      <p className="text-sm text-ink">{c.label}</p>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
        {hasDelta && (
          <>
            <span className="tabular">{show(c.from)}</span>
            <ArrowRight className="size-3" />
            <span className="font-medium text-ink-2 tabular">{show(c.to)}</span>
            <span>·</span>
          </>
        )}
        {c.source && <span>{c.source}</span>}
        {c.observed_on && <span>· {formatDate(c.observed_on)}</span>}
      </p>
    </li>
  );
}

function ContextItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="truncate text-sm text-ink">{children ?? "—"}</dd>
    </div>
  );
}

function ItemCard({ item, onReactivate, onSnooze, onDismiss }: { item: ReactivationItem; onReactivate: () => void; onSnooze: () => void; onDismiss: () => void }) {
  const { can } = useAuth();
  const ctx = item.original_context;
  const open = item.effective_status === "pending" || item.effective_status === "snoozed";
  const askingMoved = ctx.asking_price_at_dead !== undefined && ctx.asking_price_now !== undefined && ctx.asking_price_at_dead !== ctx.asking_price_now;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            <Link href={`/pipeline/${item.opportunity_id}`} className="hover:underline">
              {item.opportunity_title ?? ctx.title ?? "Opportunity"}
            </Link>
            <Badge tone="outline">{titleCase(item.trigger_type)}</Badge>
            <Badge tone={STATUS_TONES[item.effective_status] ?? "neutral"} dot>
              {titleCase(item.effective_status)}
            </Badge>
            {item.converted && <Badge tone="green">Converted</Badge>}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            {item.property_id ? (
              <Link href={`/properties/${item.property_id}`} className="hover:text-ink hover:underline">
                {item.property_label ?? "Property"}
              </Link>
            ) : null}
            {" · "}fired {formatRelative(item.fired_at)}
            {item.trigger_description ? ` · ${item.trigger_description}` : ""}
            {item.owner_name ? ` · owner ${item.owner_name}` : ""}
          </p>
        </div>
        {open && can("reactivation", "edit") && (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              <X /> Dismiss
            </Button>
            <Button size="sm" onClick={onSnooze}>
              <BellOff /> Snooze
            </Button>
            {can("pipeline", "edit") && (
              <Button size="sm" variant="primary" onClick={onReactivate}>
                <RotateCcw /> Reactivate
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="grid gap-0 md:grid-cols-2">
        <div className="border-b border-line px-4 py-3 md:border-b-0 md:border-r">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">What changed</p>
          <ul className="space-y-2">
            {item.changes.map((c, i) => (
              <ChangeRow key={i} c={c} />
            ))}
            {item.changes.length === 0 && <li className="text-sm text-ink-2">{item.what_changed}</li>}
          </ul>
          {(item.score_before !== null || item.score_after !== null) && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
              Score <span className="tabular">{item.score_before !== null ? Math.round(item.score_before) : "—"}</span>
              <ArrowRight className="size-3" />
              <span className="font-medium text-ink tabular">{item.score_after !== null ? Math.round(item.score_after) : "not eligible"}</span>
            </p>
          )}
        </div>
        <div className="px-4 py-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-3">
            <History className="size-3.5" /> Original context
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <ContextItem label="Dead reason">{ctx.dead_reason ? DEAD_REASON_LABELS[ctx.dead_reason] ?? titleCase(ctx.dead_reason) : null}</ContextItem>
            <ContextItem label="Last stage">{ctx.last_stage ? stageLabel(ctx.last_stage) : null}</ContextItem>
            <ContextItem label="Owner price expectation">{ctx.price_expectation != null ? formatCurrency(ctx.price_expectation) : null}</ContextItem>
            <ContextItem label="Our offer">{ctx.offer_price != null ? formatCurrency(ctx.offer_price) : null}</ContextItem>
            <ContextItem label="Price gap">{ctx.price_gap != null ? formatCurrency(ctx.price_gap) : null}</ContextItem>
            <ContextItem label="Asking at dead / now">
              {ctx.asking_price_at_dead != null || ctx.asking_price_now != null ? (
                <span className={askingMoved ? "text-accent-ink" : undefined}>
                  {formatCurrency(ctx.asking_price_at_dead ?? null, { compact: true })} / {formatCurrency(ctx.asking_price_now ?? null, { compact: true })}
                </span>
              ) : null}
            </ContextItem>
            <ContextItem label="Marked dead">{ctx.dead_at ? formatDate(ctx.dead_at) : null}</ContextItem>
            <ContextItem label="Contact">{ctx.primary_person ?? ctx.primary_organization ?? null}</ContextItem>
          </dl>
          {ctx.dead_notes && <p className="mt-2 line-clamp-3 text-xs text-ink-2">“{ctx.dead_notes}”</p>}
        </div>
      </div>
      {(item.decision_reason || item.snoozed_until || item.reactivated_to_stage) && (
        <div className="border-t border-line bg-subtle/60 px-4 py-2 text-xs text-ink-2">
          {item.effective_status === "snoozed" && item.snoozed_until && `Snoozed until ${formatDate(item.snoozed_until)}. `}
          {item.reactivated_to_stage && `Reactivated to ${stageLabel(item.reactivated_to_stage)}. `}
          {item.decision_reason}
        </div>
      )}
    </Card>
  );
}

export function QueueTab() {
  const { user } = useAuth();
  const url = useUrlState();
  // The queue opens on pending work; any explicit status filter replaces the default.
  const statusDefault = url.getAll("status").length ? undefined : { status: ["pending"] };
  const list = useListQuery<ReactivationItem>("reactivation", "/reactivation/items", statusDefault, { pageSize: 25 });
  const { data: meta } = useReactivationMeta();
  const [reactivating, setReactivating] = useState<ReactivationItem | null>(null);
  const [snoozing, setSnoozing] = useState<ReactivationItem | null>(null);
  const [dismissing, setDismissing] = useState<ReactivationItem | null>(null);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const statuses = url.getAll("status").length ? url.getAll("status") : ["pending"];
  const { data: facets } = useQuery({
    queryKey: ["reactivation", "facets", filterParams, statuses],
    queryFn: () =>
      api.get<{ status: Record<string, number>; trigger_type: Record<string, number>; owner_id: Record<string, number> }>("/reactivation/items/facets", { ...filterParams, status: statuses }),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  for (const [key, label] of [["status", "Status"], ["trigger_type", "Trigger"], ["owner_id", "Owner"]] as const) {
    const v = url.getAll(key);
    if (v.length) chips.push({ key, label, value: v.map((x) => (x === "me" ? "Me" : titleCase(x))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  const mine = url.getAll("owner_id").includes("me");

  return (
    <div className="space-y-3">
      <Toolbar
        right={
          <>
            <Button variant={mine ? "primary" : "secondary"} onClick={() => url.set({ owner_id: mine ? null : ["me"] })}>
              My deals
            </Button>
            <SavedViewsMenu module="reactivation" />
          </>
        }
      >
        <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search opportunity or change…" />
        <FacetFilter label="Status" options={ITEM_STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status?.[s] ?? 0 }))} selected={statuses} onChange={(v) => url.set({ status: v.length ? v : ITEM_STATUSES.slice() })} />
        <FacetFilter
          label="Trigger"
          options={(meta?.trigger_types ?? []).map((t) => ({ value: t.type, label: t.label, count: facets?.trigger_type?.[t.type] ?? 0 }))}
          selected={url.getAll("trigger_type")}
          onChange={(v) => url.set({ trigger_type: v })}
        />
      </Toolbar>
      <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q") })} />

      {list.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (list.data?.items ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<RotateCcw />}
            title={chips.length || url.get("q") ? "No items match these filters" : "Nothing to revisit"}
            description="When a dead deal's trigger fires — a price drop, loan maturity, ownership change, lease event, new signal or warm contact — it returns here with its original context."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.data!.items.map((item) => (
            <ItemCard key={item.id} item={item} onReactivate={() => setReactivating(item)} onSnooze={() => setSnoozing(item)} onDismiss={() => setDismissing(item)} />
          ))}
        </div>
      )}
      {(list.data?.total ?? 0) > 0 && (
        <Card>
          <TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />
        </Card>
      )}
      {user && (
        <>
          <ReactivateDialog item={reactivating} onOpenChange={(o) => !o && setReactivating(null)} />
          <SnoozeDialog item={snoozing} onOpenChange={(o) => !o && setSnoozing(null)} />
          <DismissDialog item={dismissing} onOpenChange={(o) => !o && setDismissing(null)} />
        </>
      )}
    </div>
  );
}
