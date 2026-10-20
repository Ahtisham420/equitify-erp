"use client";

import { ScrollText } from "lucide-react";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { StatusBadge } from "@/components/ui/badge";
import { useListQuery } from "@/hooks/use-list-query";
import { formatDateTime } from "@/lib/utils";

import { CHANNEL_LABELS, CHANNELS, type OutboundMessage } from "./api";

const MORE: MoreFilterField[] = [{ type: "date-range", label: "Sent", minKey: "date_from", maxKey: "date_to" }];

const columns: Column<OutboundMessage>[] = [
  { id: "sent", header: "Sent", sortKey: "sent_at", width: 160, cell: (m) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(m.sent_at)}</span> },
  { id: "channel", header: "Channel", sortKey: "channel", cell: (m) => <span className="text-ink">{CHANNEL_LABELS[m.channel] ?? m.channel}</span> },
  { id: "to", header: "To", cell: (m) => <span className="text-ink">{m.to_value}</span> },
  {
    id: "result",
    header: "Result",
    cell: (m) => (
      <div className="max-w-[280px]">
        <StatusBadge status={m.allowed ? "allowed" : "blocked"} />
        {!m.allowed && m.block_reasons.length > 0 && <p className="mt-0.5 line-clamp-2 text-xs text-negative">{m.block_reasons.join("; ")}</p>}
      </div>
    ),
  },
  {
    id: "content",
    header: "Content",
    cell: (m) => (
      <p className="line-clamp-2 max-w-[420px] text-xs text-ink-2" title={m.content ?? undefined}>
        {m.subject ? <span className="font-medium text-ink">{m.subject} — </span> : null}
        {m.content ?? "—"}
      </p>
    ),
  },
  { id: "actor", header: "By", cell: (m) => <span className="whitespace-nowrap text-ink-2">{m.actor_name ?? "—"}</span> },
];

/** Immutable outbound content log (read-only). */
export function OutboundTab() {
  const list = useListQuery<OutboundMessage>("compliance", "/compliance/outbound");
  const { url } = list;
  const chips: FilterChip[] = [];
  if (url.getAll("channel").length) chips.push({ key: "channel", label: "Channel", value: url.getAll("channel").map((c) => CHANNEL_LABELS[c] ?? c).join(", "), onRemove: () => url.set({ channel: null }) });
  if (url.get("allowed")) chips.push({ key: "allowed", label: "Result", value: url.get("allowed") === "true" ? "Allowed" : "Blocked", onRemove: () => url.set({ allowed: null }) });
  for (const [k, label] of [["date_from", "From"], ["date_to", "To"]] as const) if (url.get(k)) chips.push({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) });

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search recipient, content, sender…" />
            <FacetFilter label="Channel" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} selected={url.getAll("channel")} onChange={(v) => url.set({ channel: v })} />
            <FacetFilter
              label="Result"
              single
              options={[{ value: "true", label: "Allowed" }, { value: "false", label: "Blocked" }]}
              selected={url.getAll("allowed")}
              onChange={(v) => url.set({ allowed: v })}
            />
            <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
          </Toolbar>
          <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q") })} />
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
        empty={<EmptyState icon={<ScrollText />} title="No outbound messages logged" description="Every outbound call, text and email — including blocked attempts — is recorded here and cannot be edited." />}
      />
    </ListCard>
  );
}
