"use client";

import { useQuery } from "@tanstack/react-query";
import { MapPinned, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { PropertyPicker } from "@/components/data/entity-picker";
import { FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber } from "@/lib/utils";

import { label, opts, useMutate, useUserNames } from "@/features/brokerage/api";
import { RecordSheet, State, party, type FieldSpec } from "@/features/brokerage/ui";

import { TOUR_STATUSES, type Tour } from "./api";

function PropertyList({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="space-y-1.5">
      {value.map((id, i) => (
        <div key={id} className="flex items-center gap-1.5">
          <span className="w-5 text-right text-xs text-ink-3 tabular">{i + 1}</span>
          <div className="flex-1">
            <PropertyPicker value={id} onChange={(next) => onChange(next ? value.map((v, j) => (j === i ? next : v)) : value.filter((_, j) => j !== i))} />
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Remove stop" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </div>
      ))}
      <PropertyPicker value={null} onChange={(id) => id && !value.includes(id) && onChange([...value, id])} placeholder="Add property stop…" />
      <p className="text-xs text-ink-3">Stops are ordered automatically by nearest-neighbour routing.</p>
    </div>
  );
}

export const TOUR_FIELDS: FieldSpec[] = [
  { key: "title", label: "Title", type: "text", full: true, hint: "Defaults to the date and client" },
  { key: "scheduled_on", label: "Date", type: "date", required: true },
  { key: "start_time", label: "Start time", type: "time" },
  { key: "status", label: "Status", type: "select", options: opts(TOUR_STATUSES), required: true },
  { key: "agent_id", label: "Agent", type: "user" },
  { key: "client_organization_id", label: "Client organization", type: "organization" },
  { key: "client_person_id", label: "Client contact", type: "person" },
  { key: "start_label", label: "Starting point", type: "text", placeholder: "e.g. Office" },
  { key: "start_lat", label: "Start latitude", type: "number" },
  { key: "start_lng", label: "Start longitude", type: "number" },
  { key: "notes", label: "Notes", type: "textarea" },
];

const columns: Column<Tour>[] = [
  { id: "title", header: "Tour", sortKey: "title", cell: (t) => <div className="min-w-[200px]"><p className="font-medium text-ink">{t.title}</p><p className="text-xs text-ink-3">{party(t) ?? "—"}</p></div> },
  { id: "date", header: "Date", sortKey: "scheduled_on", cell: (t) => <span className="whitespace-nowrap text-ink-2">{formatDate(t.scheduled_on)}{t.start_time ? ` · ${t.start_time}` : ""}</span> },
  { id: "status", header: "Status", sortKey: "status", cell: (t) => <State value={t.status} /> },
  { id: "stops", header: "Stops", align: "right", cell: (t) => formatNumber(t.stop_count) },
  { id: "distance", header: "Route", sortKey: "total_distance_miles", align: "right", cell: (t) => (t.total_distance_miles != null ? `${formatNumber(t.total_distance_miles, 1)} mi` : "—") },
  { id: "participants", header: "Participants", align: "right", cell: (t) => formatNumber(t.participants.length) },
  { id: "feedback", header: "Feedback", align: "right", cell: (t) => formatNumber(t.feedback_count) },
  { id: "agent", header: "Agent", cell: (t) => <span className="whitespace-nowrap text-ink-2">{t.agent_name ?? "—"}</span> },
];

export function ToursTab() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<Tour>("dealroom", "/tours");
  const { url } = list;
  const users = useUserNames();
  const [creating, setCreating] = useState(false);
  const create = useMutate((body: Record<string, unknown>) => api.post<Tour>("/tours", body), ["dealroom"]);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["dealroom", "tour-facets", filterParams],
    queryFn: () => api.get<{ status: Record<string, number>; agent_id: Record<string, number> }>("/tours/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  for (const [key, l] of [["status", "Status"], ["agent_id", "Agent"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label: l, value: values.map((v) => (key === "agent_id" ? users[v] ?? "Agent" : label(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (url.get("from_date")) chips.push({ key: "from", label: "From", value: url.get("from_date")!, onRemove: () => url.set({ from_date: null }) });
  if (url.get("to_date")) chips.push({ key: "to", label: "To", value: url.get("to_date")!, onRemove: () => url.set({ to_date: null }) });

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="dealroom" />
                  {can("dealroom", "create") && (
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Plus /> Schedule tour
                    </Button>
                  )}
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search tours…" />
              <FacetFilter label="Status" options={TOUR_STATUSES.map((s) => ({ value: s, label: label(s), count: facets?.status[s] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Agent" searchable options={Object.entries(facets?.agent_id ?? {}).map(([id, c]) => ({ value: id, label: users[id] ?? "Unknown", count: c }))} selected={url.getAll("agent_id")} onChange={(v) => url.set({ agent_id: v })} />
              <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-sm text-ink-2 shadow-card">
                <Checkbox checked={url.get("mine") === "true"} onChange={(c) => url.set({ mine: c || null })} />
                My tours
              </label>
              <MoreFilters fields={[{ type: "date-range", label: "Tour date", minKey: "from_date", maxKey: "to_date" }]} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), q: url.get("q") })} />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowHref={(t) => `/tours/${t.id}`}
          empty={<EmptyState icon={<MapPinned />} title={chips.length ? "No tours match these filters" : "No tours scheduled"} description="Plan a property tour with an optimized route, participants and feedback capture." />}
        />
      </ListCard>
      <RecordSheet
        open={creating}
        onOpenChange={setCreating}
        title="Schedule tour"
        fields={[...TOUR_FIELDS, { key: "property_ids", label: "Properties", type: "custom", render: (v, set) => <PropertyList value={(v as string[]) ?? []} onChange={set} /> }]}
        initial={{ status: "planned", property_ids: [] }}
        onSubmit={async (b) => {
          const t = await create.mutateAsync(b);
          router.push(`/tours/${t.id}`);
        }}
      />
    </>
  );
}
