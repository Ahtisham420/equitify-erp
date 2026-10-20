"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useMemo } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { cn, formatDate, formatRelative, titleCase } from "@/lib/utils";

import { CHANNEL_LABELS, CHANNELS, CONSENT_STATES, DNC_STATUSES, PHONE_TYPES, type ComplianceRecord, type RecordFacets } from "./api";
import { NewRecordSheet, RecordSheet } from "./record-sheet";

const MORE: MoreFilterField[] = [
  { type: "select", label: "Scrub", key: "scrub_expired", options: [{ value: "true", label: "Expired scrubs only" }] },
  { type: "text", label: "Provider", key: "provider" },
];

const today = () => new Date().toISOString().slice(0, 10);

const columns: Column<ComplianceRecord>[] = [
  {
    id: "value",
    header: "Value",
    sortKey: "value",
    cell: (r) => (
      <div className="min-w-[200px]">
        <p className="font-medium text-ink">{r.value}</p>
        <p className="text-xs text-ink-3">{CHANNEL_LABELS[r.channel] ?? r.channel}{r.jurisdiction_state ? ` · ${r.jurisdiction_state}` : ""}</p>
      </div>
    ),
  },
  { id: "phone_type", header: "Type", hideable: true, cell: (r) => <span className="text-ink-2">{r.channel === "email" ? "—" : titleCase(r.phone_type)}</span> },
  {
    id: "dnc",
    header: "DNC",
    sortKey: "dnc_status",
    hideable: true,
    cell: (r) => (r.channel === "email" ? <span className="text-ink-3">—</span> : <Badge tone={r.dnc_status === "listed" ? "red" : r.dnc_status === "clear" ? "green" : "neutral"}>{titleCase(r.dnc_status)}</Badge>),
  },
  {
    id: "scrub",
    header: "Scrub expires",
    sortKey: "scrub_expires_on",
    hideable: true,
    cell: (r) =>
      r.scrub_expires_on ? (
        <span className={cn("text-xs", r.scrub_expires_on < today() ? "font-medium text-negative" : "text-ink-2")}>{formatDate(r.scrub_expires_on)}</span>
      ) : (
        <span className="text-xs text-ink-3">{r.channel === "email" ? "—" : "Never scrubbed"}</span>
      ),
  },
  { id: "consent", header: "Consent", sortKey: "consent_state", hideable: true, cell: (r) => <Badge tone={r.consent_state === "granted" ? "green" : r.consent_state === "revoked" ? "red" : "neutral"}>{titleCase(r.consent_state)}</Badge> },
  {
    id: "suppression",
    header: "Suppression",
    hideable: true,
    cell: (r) =>
      r.internal_suppression ? (
        <div className="max-w-[240px]">
          <StatusBadge status="suppressed" />
          <p className="truncate text-xs text-ink-3" title={r.suppression_reason ?? undefined}>{r.suppression_reason}</p>
        </div>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "provider", header: "Provider", hideable: true, defaultHidden: true, cell: (r) => <span className="text-ink-2">{r.provider ?? "—"}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (r) => <span className="text-xs text-ink-3">{formatRelative(r.updated_at)}</span> },
];

export function RecordsTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const list = useListQuery<ComplianceRecord>("compliance", "/compliance/records");
  const { url } = list;
  const cols = useColumnVisibility("compliance-records", columns);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, record: _r, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["compliance", "facets", filterParams],
    queryFn: () => api.get<RecordFacets>("/compliance/records/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  for (const [key, label] of [["channel", "Channel"], ["dnc_status", "DNC"], ["consent_state", "Consent"], ["phone_type", "Phone type"], ["suppressed", "Suppression"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map((v) => CHANNEL_LABELS[v] ?? titleCase(v)).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (url.get("scrub_expired")) chips.push({ key: "scrub_expired", label: "Scrub", value: "Expired", onRemove: () => url.set({ scrub_expired: null }) });
  if (url.get("provider")) chips.push({ key: "provider", label: "Provider", value: url.get("provider")!, onRemove: () => url.set({ provider: null }) });

  const opts = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string = titleCase) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="compliance" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search phone or email…" />
              <FacetFilter label="Channel" options={opts(facets?.channel, CHANNELS, (v) => CHANNEL_LABELS[v])} selected={url.getAll("channel")} onChange={(v) => url.set({ channel: v })} />
              <FacetFilter label="DNC" options={opts(facets?.dnc_status, DNC_STATUSES)} selected={url.getAll("dnc_status")} onChange={(v) => url.set({ dnc_status: v })} />
              <FacetFilter label="Consent" options={opts(facets?.consent_state, CONSENT_STATES)} selected={url.getAll("consent_state")} onChange={(v) => url.set({ consent_state: v })} />
              <FacetFilter label="Suppression" options={opts(facets?.suppressed, ["suppressed", "active"])} selected={url.getAll("suppressed")} onChange={(v) => url.set({ suppressed: v })} />
              <FacetFilter label="Phone type" options={opts(facets?.phone_type, PHONE_TYPES)} selected={url.getAll("phone_type")} onChange={(v) => url.set({ phone_type: v })} />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
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
          onRowClick={(r) => url.set({ record: r.id }, { resetPage: false })}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<ShieldCheck />}
              title={chips.length || url.get("q") ? "No records match these filters" : "No compliance records yet"}
              description="Records are created when numbers are scrubbed, consent is captured, or outreach is attempted."
            />
          }
        />
      </ListCard>
      <RecordSheet id={url.get("record")} onOpenChange={(o) => !o && url.set({ record: null }, { resetPage: false })} />
      <NewRecordSheet open={creating} onOpenChange={onCreatingChange} />
    </>
  );
}
