"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, MessagesSquare, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, FieldGrid, FieldItem, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatDateTime, isOverdue, titleCase } from "@/lib/utils";

import { fromLocalInput, relatedHref, toLocalInput } from "@/features/tasks/api";

import {
  CHANNEL_LABELS,
  CHANNELS,
  DIRECTIONS,
  DISPOSITION_LABELS,
  DISPOSITION_TONES,
  DISPOSITIONS,
  formatDuration,
  useUpdateInteraction,
  type Interaction,
  type InteractionFacets,
} from "./api";
import { LogInteractionSheet } from "./log-interaction-sheet";
import { CHANNEL_ICONS } from "./record-interactions";

const MORE: MoreFilterField[] = [
  { type: "date-range", label: "Date", minKey: "date_from", maxKey: "date_to" },
  { type: "select", label: "Meaningful conversations", key: "meaningful", options: [{ value: "true", label: "Meaningful only" }, { value: "false", label: "Other touches" }] },
  { type: "select", label: "Logged by", key: "logged_by", options: [{ value: "me", label: "Me" }] },
];

const CHIP_LABELS: Record<string, string> = { date_from: "From", date_to: "To" };
const RECORD_KEYS = [
  ["person_id", "Person"],
  ["organization_id", "Organization"],
  ["property_id", "Property"],
  ["opportunity_id", "Opportunity"],
] as const;

function recordLinks(it: Interaction) {
  return [
    it.person_id && { href: relatedHref("person", it.person_id)!, label: it.person_name ?? "Person" },
    it.organization_id && { href: relatedHref("organization", it.organization_id)!, label: it.organization_name ?? "Organization" },
    it.property_id && { href: relatedHref("property", it.property_id)!, label: it.property_label ?? "Property" },
    it.opportunity_id && { href: relatedHref("opportunity", it.opportunity_id)!, label: it.opportunity_title ?? "Opportunity" },
  ].filter(Boolean) as { href: string; label: string }[];
}

const columns: Column<Interaction>[] = [
  { id: "when", header: "When", sortKey: "occurred_at", width: 150, cell: (i) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(i.occurred_at)}</span> },
  {
    id: "channel",
    header: "Channel",
    sortKey: "channel",
    cell: (i) => {
      const Icon = CHANNEL_ICONS[i.channel];
      return (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink">
          {Icon && <Icon className="size-3.5 text-ink-3" />}
          {CHANNEL_LABELS[i.channel] ?? i.channel}
          {i.direction === "inbound" ? <ArrowDownLeft className="size-3.5 text-ink-3" /> : i.direction === "outbound" ? <ArrowUpRight className="size-3.5 text-ink-3" /> : null}
        </span>
      );
    },
  },
  {
    id: "record",
    header: "Record",
    cell: (i) => (
      <div className="flex max-w-[260px] flex-col">
        {recordLinks(i).map((l) => (
          <Link key={l.href} href={l.href} className="truncate text-sm text-ink hover:underline">
            {l.label}
          </Link>
        ))}
      </div>
    ),
  },
  { id: "disposition", header: "Disposition", sortKey: "disposition", hideable: true, cell: (i) => (i.disposition ? <Badge tone={DISPOSITION_TONES[i.disposition]}>{DISPOSITION_LABELS[i.disposition]}</Badge> : <span className="text-ink-3">—</span>) },
  { id: "summary", header: "Summary", hideable: true, cell: (i) => <p className="line-clamp-2 max-w-[360px] text-sm text-ink-2">{i.subject ? `${i.subject} — ` : ""}{i.summary ?? "—"}</p> },
  {
    id: "next",
    header: "Next step",
    sortKey: "next_action_at",
    hideable: true,
    cell: (i) =>
      i.loop_closed ? (
        <span className="text-xs text-ink-3" title={i.closed_reason ?? undefined}>Loop closed</span>
      ) : i.next_action ? (
        <div className="max-w-[220px]">
          <p className="truncate text-sm text-ink">{i.next_action}</p>
          <p className={cn("text-xs", i.next_action_at && isOverdue(i.next_action_at) ? "text-negative" : "text-ink-3")}>{formatDate(i.next_action_at)}</p>
        </div>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "by", header: "Logged by", hideable: true, cell: (i) => <span className="whitespace-nowrap text-ink-2">{i.logged_by_name ?? "—"}</span> },
  { id: "contact", header: "To / from", hideable: true, defaultHidden: true, cell: (i) => <span className="text-xs text-ink-2">{i.contact_value ?? "—"}</span> },
];

function InteractionDetailSheet({ interaction, onOpenChange }: { interaction: Interaction | null; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const update = useUpdateInteraction(interaction?.id ?? "");
  const [nextAction, setNextAction] = useState("");
  const [nextAt, setNextAt] = useState("");
  const [closed, setClosed] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    if (interaction) {
      setNextAction(interaction.next_action ?? "");
      setNextAt(toLocalInput(interaction.next_action_at));
      setClosed("");
      setSummary(interaction.summary ?? "");
    }
  }, [interaction]);

  const run = (body: Parameters<typeof update.mutate>[0], msg: string) =>
    update.mutate(body, {
      onSuccess: () => {
        toast.success(msg);
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const editable = can("outreach", "edit") && !!interaction;
  return (
    <Sheet
      open={!!interaction}
      onOpenChange={onOpenChange}
      title={interaction ? `${CHANNEL_LABELS[interaction.channel] ?? interaction.channel} · ${formatDateTime(interaction.occurred_at)}` : "Interaction"}
      description={interaction?.is_meaningful ? "Meaningful conversation" : undefined}
    >
      {interaction && (
        <div className="space-y-5">
          <FieldGrid>
            <FieldItem label="Direction">{titleCase(interaction.direction)}</FieldItem>
            <FieldItem label="Disposition">{interaction.disposition ? DISPOSITION_LABELS[interaction.disposition] : null}</FieldItem>
            <FieldItem label="To / from">{interaction.contact_value}</FieldItem>
            <FieldItem label="Duration">{formatDuration(interaction.duration_seconds)}</FieldItem>
            <FieldItem label="Logged by">{interaction.logged_by_name}</FieldItem>
            <FieldItem label="Follow-up task">
              {interaction.follow_up_task_id ? (
                <Link href={`/tasks?task=${interaction.follow_up_task_id}`} className="text-accent hover:underline">
                  Open task
                </Link>
              ) : null}
            </FieldItem>
          </FieldGrid>
          <div className="flex flex-wrap gap-2">
            {recordLinks(interaction).map((l) => (
              <Link key={l.href} href={l.href} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-subtle">
                {l.label}
              </Link>
            ))}
          </div>
          {interaction.subject && <p className="text-sm font-medium text-ink">{interaction.subject}</p>}
          {editable ? (
            <Field label="Summary">
              <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={5} />
            </Field>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-ink-2">{interaction.summary ?? "No summary."}</p>
          )}
          {editable && summary !== (interaction.summary ?? "") && (
            <Button size="sm" loading={update.isPending} onClick={() => run({ summary: summary.trim() || null }, "Summary saved")}>
              Save summary
            </Button>
          )}

          <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
            <h4 className="text-sm font-medium text-ink">Next step</h4>
            {interaction.loop_closed ? (
              <p className="text-sm text-ink-2">Loop closed: {interaction.closed_reason}</p>
            ) : (
              <>
                <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Next action" disabled={!editable} />
                <Input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} disabled={!editable} />
                {editable && (
                  <Button
                    size="sm"
                    disabled={!nextAction.trim() || !nextAt}
                    loading={update.isPending}
                    onClick={() => run({ next_action: nextAction.trim(), next_action_at: fromLocalInput(nextAt) }, "Next action updated")}
                  >
                    Save next action
                  </Button>
                )}
                {editable && (
                  <div className="space-y-2 border-t border-line pt-3">
                    <Textarea value={closed} onChange={(e) => setClosed(e.target.value)} rows={2} placeholder="Reason for closing the loop" />
                    <Button size="sm" variant="ghost" disabled={!closed.trim()} onClick={() => run({ loop_closed: true, closed_reason: closed.trim() }, "Loop closed")}>
                      Close the loop
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

export function InteractionsLog() {
  const { can } = useAuth();
  const list = useListQuery<Interaction>("interactions", "/interactions");
  const { url } = list;
  const cols = useColumnVisibility("interactions", columns);
  const [logging, setLogging] = useState(false);
  const [selected, setSelected] = useState<Interaction | null>(null);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["interactions", "facets", filterParams],
    queryFn: () => api.get<InteractionFacets>("/interactions/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label] of [["channel", "Channel"], ["direction", "Direction"], ["disposition", "Disposition"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => CHANNEL_LABELS[v] ?? DISPOSITION_LABELS[v] ?? titleCase(v)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (url.get("meaningful")) chips.push({ key: "meaningful", label: "Meaningful", value: url.get("meaningful") === "true" ? "Yes" : "No", onRemove: () => url.set({ meaningful: null }) });
  if (url.get("logged_by")) chips.push({ key: "logged_by", label: "Logged by", value: url.get("logged_by") === "me" ? "Me" : "User", onRemove: () => url.set({ logged_by: null }) });
  for (const [key, label] of RECORD_KEYS) if (url.get(key)) chips.push({ key, label, value: "This record", onRemove: () => url.set({ [key]: null }) });

  const opts = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));
  const filtered = chips.length > 0 || !!url.get("q");

  const defaults = {
    person_id: url.get("person_id") ?? undefined,
    organization_id: url.get("organization_id") ?? undefined,
    property_id: url.get("property_id") ?? undefined,
    opportunity_id: url.get("opportunity_id") ?? undefined,
  };

  return (
    <>
      <div className="mb-3 flex justify-end">
        {can("outreach", "create") && (
          <Button variant="primary" onClick={() => setLogging(true)}>
            <Plus /> Log interaction
          </Button>
        )}
      </div>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="outreach" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search summaries, next actions, numbers…" />
              <FacetFilter label="Channel" options={opts(facets?.channel, CHANNELS, (v) => CHANNEL_LABELS[v])} selected={url.getAll("channel")} onChange={(v) => url.set({ channel: v })} />
              <FacetFilter label="Direction" options={opts(facets?.direction, DIRECTIONS, titleCase)} selected={url.getAll("direction")} onChange={(v) => url.set({ direction: v })} />
              <FacetFilter label="Disposition" options={opts(facets?.disposition, DISPOSITIONS, (v) => DISPOSITION_LABELS[v])} selected={url.getAll("disposition")} onChange={(v) => url.set({ disposition: v })} />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q"), sort: url.get("sort") })} />
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
          onRowClick={setSelected}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<MessagesSquare />}
              title={filtered ? "No interactions match these filters" : "No interactions logged yet"}
              description={filtered ? "Try removing a filter or widening the date range." : "Calls, emails, texts, meetings, tours, letters and notes appear here."}
            />
          }
        />
      </ListCard>
      <LogInteractionSheet open={logging} onOpenChange={setLogging} defaults={defaults} />
      <InteractionDetailSheet interaction={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}
