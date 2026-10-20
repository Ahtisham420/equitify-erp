"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, Copy, History, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, ListCard, StatCard } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress, Skeleton } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatNumber, formatPercent, formatRelative, pluralize, titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

/* ------------------------------------------------------------------ types & hooks */

export interface QualitySummary {
  total_properties: number;
  average_completeness: number;
  completeness_bands: Record<"low" | "medium" | "high", number>;
  completeness_by_type: { property_type: string; count: number; average: number }[];
  verification_backlog: number;
  ai_unverified: number;
  stale_total: number;
  stale_by_field: { field: string; threshold_days: number; stale: number }[];
  duplicate_groups: number;
  duplicate_properties: number;
  duplicate_rate: number;
}

export interface BacklogItem {
  id: string;
  property_id: string;
  property_title: string;
  property_location: string | null;
  field: string;
  value: unknown;
  source: string;
  observed_on: string | null;
  confidence: number;
  ai_derived: boolean;
  recorded_at: string;
}

export interface StaleItem extends BacklogItem {
  verification: string;
  threshold_days: number;
  age_days: number;
}

export interface DuplicateGroup {
  normalized_address: string;
  count: number;
  properties: {
    id: string;
    name: string | null;
    address_line: string;
    city: string | null;
    state: string | null;
    status: string;
    completeness_score: number;
    created_at: string;
  }[];
}

export interface Threshold {
  field: string;
  days: number | null;
  default_days: number | null;
  is_default: boolean;
}

/** Separate list-cache keys per table (useListQuery keys are `[key, "list", params]`). */
const DQ_KEYS = { backlog: "data-quality-backlog", stale: "data-quality-stale", duplicates: "data-quality-duplicates" } as const;

export function useQualitySummary() {
  return useQuery({ queryKey: ["data-quality", "summary"], queryFn: () => api.get<QualitySummary>("/data-quality/summary") });
}

function useVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, state }: { id: string; state: "verified" | "rejected" }) => api.post(`/properties/observations/${id}/verify`, { state }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["data-quality"] });
      qc.invalidateQueries({ queryKey: [DQ_KEYS.backlog] });
      qc.invalidateQueries({ queryKey: [DQ_KEYS.stale] });
      qc.invalidateQueries({ queryKey: ["properties"] });
    },
  });
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return formatNumber(value, 2);
  return String(value);
}

function PropertyCell({ item }: { item: BacklogItem }) {
  return (
    <div className="min-w-[200px] max-w-[300px]">
      <Link href={`/properties/${item.property_id}?tab=history`} className="block truncate font-medium text-ink hover:underline">
        {item.property_title}
      </Link>
      <p className="truncate text-xs text-ink-3">{item.property_location ?? "—"}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

const BAND_META = [
  { key: "high", label: "80% and above", color: "bg-positive" },
  { key: "medium", label: "50–79%", color: "bg-caution" },
  { key: "low", label: "Below 50%", color: "bg-negative" },
] as const;

export function QualityStats({ data }: { data?: QualitySummary }) {
  if (!data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-lg" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <StatCard label="Properties" value={formatNumber(data.total_properties)} href="/properties" />
      <StatCard
        label="Average completeness"
        value={formatPercent(data.average_completeness, 1)}
        tone={data.average_completeness < 60 ? "caution" : "default"}
        href="/properties?sort=completeness_score"
        hint="Against required fields for each property type"
      />
      <StatCard
        label="Verification backlog"
        value={formatNumber(data.verification_backlog)}
        tone={data.verification_backlog > 0 ? "caution" : "positive"}
        hint={`${formatNumber(data.ai_unverified)} AI-derived awaiting review`}
      />
      <StatCard label="Stale facts" value={formatNumber(data.stale_total)} tone={data.stale_total > 0 ? "caution" : "positive"} hint="Older than the field's threshold" />
      <StatCard
        label="Duplicate rate"
        value={formatPercent(data.duplicate_rate, 1)}
        tone={data.duplicate_rate > 0 ? "negative" : "positive"}
        hint={`${pluralize(data.duplicate_properties, "property", "properties")} in ${pluralize(data.duplicate_groups, "group")}`}
      />
    </div>
  );
}

export function CompletenessPanel({ data }: { data?: QualitySummary }) {
  const total = data?.total_properties ?? 0;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card>
        <CardHeader title="Completeness bands" description="Share of properties by completeness score" />
        <CardBody className="space-y-4">
          {!data ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                {BAND_META.map((b) => {
                  const n = data.completeness_bands[b.key] ?? 0;
                  return total ? <div key={b.key} className={b.color} style={{ width: `${(100 * n) / total}%` }} /> : null;
                })}
              </div>
              <ul className="space-y-2">
                {BAND_META.map((b) => {
                  const n = data.completeness_bands[b.key] ?? 0;
                  return (
                    <li key={b.key} className="flex items-center gap-2 text-sm">
                      <span className={cn("size-2 rounded-full", b.color)} />
                      <span className="flex-1 text-ink-2">{b.label}</span>
                      <span className="tabular text-ink">{formatNumber(n)}</span>
                      <span className="w-12 text-right text-xs tabular text-ink-3">{total ? formatPercent((100 * n) / total, 0) : "—"}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader title="Average completeness by property type" description="Each type is scored against its own required fields" />
        <CardBody>
          {!data ? (
            <Skeleton className="h-32" />
          ) : data.completeness_by_type.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-3">No properties yet</p>
          ) : (
            <ul className="space-y-2.5">
              {data.completeness_by_type.map((t) => (
                <li key={t.property_type} className="grid grid-cols-[160px_1fr_56px_64px] items-center gap-3 text-sm">
                  <Link href={`/properties?property_type=${t.property_type}&sort=completeness_score`} className="truncate text-ink-2 hover:text-ink hover:underline">
                    {PROPERTY_TYPE_LABELS[t.property_type] ?? titleCase(t.property_type)}
                  </Link>
                  <Progress value={t.average} className="h-2" />
                  <span className="text-right tabular text-ink">{formatPercent(t.average, 0)}</span>
                  <span className="text-right text-xs tabular text-ink-3">{pluralize(t.count, "prop.", "props.")}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ backlog */

export function BacklogTable() {
  const { can } = useAuth();
  const list = useListQuery<BacklogItem>(DQ_KEYS.backlog, "/data-quality/backlog");
  const { url } = list;
  const verify = useVerify();
  const [selected, setSelected] = useState<string[]>([]);
  const editable = can("properties", "edit");

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["data-quality", "backlog-facets", filterParams],
    queryFn: () => api.get<{ field: Record<string, number>; ai_derived: Record<string, number> }>("/data-quality/backlog/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const act = (item: BacklogItem, state: "verified" | "rejected") =>
    verify.mutate(
      { id: item.id, state },
      { onSuccess: () => toast.success(`${titleCase(item.field)} ${state}`), onError: (e) => toast.error(errorMessage(e)) },
    );

  const bulk = async (state: "verified" | "rejected") => {
    let ok = 0;
    for (const id of selected) {
      try {
        await verify.mutateAsync({ id, state });
        ok += 1;
      } catch (e) {
        toast.error(errorMessage(e));
        break;
      }
    }
    if (ok) toast.success(`${pluralize(ok, "fact")} ${state}`);
    setSelected([]);
  };

  const columns: Column<BacklogItem>[] = [
    { id: "property", header: "Property", cell: (o) => <PropertyCell item={o} /> },
    { id: "field", header: "Field", sortKey: "field", cell: (o) => <span className="font-medium">{titleCase(o.field)}</span> },
    { id: "value", header: "Value", cell: (o) => <span className="block max-w-[200px] truncate text-ink">{show(o.value)}</span> },
    {
      id: "source",
      header: "Source",
      sortKey: "source",
      cell: (o) => (
        <div className="flex items-center gap-1.5">
          <span className="max-w-[180px] truncate text-ink-2">{o.source}</span>
          {o.ai_derived && <Badge tone="sky">AI</Badge>}
        </div>
      ),
    },
    { id: "observed", header: "Observed", sortKey: "observed_on", cell: (o) => <span className="whitespace-nowrap text-ink-2">{formatDate(o.observed_on)}</span> },
    { id: "confidence", header: "Confidence", sortKey: "confidence", align: "right", cell: (o) => <ConfidencePill value={o.confidence} /> },
    { id: "recorded", header: "Waiting", sortKey: "recorded_at", cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(o.recorded_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (o) =>
        editable ? (
          <div className="flex justify-end gap-1">
            <Button size="xs" onClick={() => act(o, "verified")}>
              <Check className="!size-3.5" /> Verify
            </Button>
            <Button size="xs" variant="ghost" onClick={() => act(o, "rejected")} aria-label="Reject">
              <X className="!size-3.5" />
            </Button>
          </div>
        ) : null,
    },
  ];

  const more: MoreFilterField[] = [{ type: "text", label: "Source contains", key: "source" }];
  const chips: FilterChip[] = [];
  const fields = url.getAll("field");
  if (fields.length) chips.push({ key: "field", label: "Field", value: fields.map(titleCase).join(", "), onRemove: () => url.set({ field: null }) });
  const ai = url.get("ai_derived");
  if (ai) chips.push({ key: "ai_derived", label: "Origin", value: ai === "true" ? "AI-derived" : "Human / feed", onRemove: () => url.set({ ai_derived: null }) });
  const source = url.get("source");
  if (source) chips.push({ key: "source", label: "Source", value: source, onRemove: () => url.set({ source: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar right={<SavedViewsMenu module="properties" />}>
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property or source…" />
              <FacetFilter
                label="Field"
                searchable
                options={Object.entries(facets?.field ?? {}).sort((a, b) => b[1] - a[1]).map(([v, c]) => ({ value: v, label: titleCase(v), count: c }))}
                selected={fields}
                onChange={(v) => url.set({ field: v })}
              />
              <FacetFilter
                label="Origin"
                single
                options={[
                  { value: "true", label: "AI-derived", count: facets?.ai_derived.true ?? 0 },
                  { value: "false", label: "Human / feed", count: facets?.ai_derived.false ?? 0 },
                ]}
                selected={ai ? [ai] : []}
                onChange={(v) => url.set({ ai_derived: v[0] ?? null })}
              />
              <MoreFilters fields={more} values={url.params} onApply={(v) => url.set(v)} />
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
          selectable={editable}
          selected={selected}
          onSelectedChange={setSelected}
          empty={
            <EmptyState
              icon={<ClipboardCheck />}
              title={filtered ? "No unverified facts match these filters" : "Verification backlog is clear"}
              description={filtered ? "Try removing a filter." : "Every current sourced fact has been verified or rejected."}
            />
          }
        />
      </ListCard>
      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <BulkButton icon={<Check />} disabled={verify.isPending} onClick={() => bulk("verified")}>
          Verify
        </BulkButton>
        <BulkButton icon={<X />} disabled={verify.isPending} onClick={() => bulk("rejected")}>
          Reject
        </BulkButton>
      </BulkBar>
    </>
  );
}

/* ------------------------------------------------------------------ stale */

export function StaleTable({ summary }: { summary?: QualitySummary }) {
  const list = useListQuery<StaleItem>(DQ_KEYS.stale, "/data-quality/stale");
  const { url } = list;

  const columns: Column<StaleItem>[] = [
    { id: "property", header: "Property", cell: (o) => <PropertyCell item={o} /> },
    { id: "field", header: "Field", sortKey: "field", cell: (o) => <span className="font-medium">{titleCase(o.field)}</span> },
    { id: "value", header: "Current value", cell: (o) => <span className="block max-w-[200px] truncate">{show(o.value)}</span> },
    { id: "source", header: "Source", sortKey: "source", cell: (o) => <span className="block max-w-[180px] truncate text-ink-2">{o.source}</span> },
    { id: "observed", header: "Observed", sortKey: "observed_on", cell: (o) => <span className="whitespace-nowrap text-ink-2">{formatDate(o.observed_on)}</span> },
    {
      id: "age",
      header: "Age / threshold",
      align: "right",
      cell: (o) => (
        <span className="whitespace-nowrap text-xs">
          <span className={cn(o.age_days > o.threshold_days * 2 ? "text-negative" : "text-caution")}>{formatNumber(o.age_days)} d</span>
          <span className="text-ink-3"> / {formatNumber(o.threshold_days)} d</span>
        </span>
      ),
    },
    { id: "verification", header: "Verification", cell: (o) => <StatusBadge status={o.verification} /> },
  ];

  const fields = url.getAll("field");
  const chips: FilterChip[] = fields.length
    ? [{ key: "field", label: "Field", value: fields.map(titleCase).join(", "), onRemove: () => url.set({ field: null }) }]
    : [];

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar right={<SavedViewsMenu module="properties" />}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property or source…" />
            <FacetFilter
              label="Field"
              options={(summary?.stale_by_field ?? []).map((s) => ({ value: s.field, label: titleCase(s.field), count: s.stale }))}
              selected={fields}
              onChange={(v) => url.set({ field: v })}
            />
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
        rowHref={(o) => `/properties/${o.property_id}?tab=history`}
        empty={<EmptyState icon={<History />} title="No stale facts" description="All current facts are within their field's staleness threshold." />}
      />
    </ListCard>
  );
}

/* ------------------------------------------------------------------ duplicates */

export function DuplicatesList() {
  const list = useListQuery<DuplicateGroup>(DQ_KEYS.duplicates, "/data-quality/duplicates");
  const { url } = list;
  const groups = list.data?.items ?? [];

  return (
    <ListCard
      toolbar={
        <Toolbar>
          <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search normalized address…" />
        </Toolbar>
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
      {list.isLoading ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState icon={<Copy />} title="No duplicate addresses" description="No two active properties share a normalized address." />
      ) : (
        <ul className="divide-y divide-line">
          {groups.map((g) => (
            <li key={g.normalized_address} className="px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-xs text-ink-2">{g.normalized_address}</span>
                <Badge tone="red">{g.count} records</Badge>
              </div>
              <ul className="space-y-1">
                {g.properties.map((p) => (
                  <li key={p.id} className="grid grid-cols-[1fr_100px_90px_120px] items-center gap-3 text-sm">
                    <Link href={`/properties/${p.id}`} className="truncate font-medium text-ink hover:underline">
                      {p.name || p.address_line}
                      <span className="ml-1.5 font-normal text-ink-3">{[p.name ? p.address_line : null, p.city, p.state].filter(Boolean).join(", ")}</span>
                    </Link>
                    <StatusBadge status={p.status} />
                    <span className="text-right text-xs tabular text-ink-3">{Math.round(p.completeness_score)}% complete</span>
                    <span className="text-right text-xs text-ink-3">Added {formatDate(p.created_at)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );
}

/* ------------------------------------------------------------------ thresholds */

export function ThresholdsEditor() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can("properties", "approve");
  const { data, isLoading } = useQuery({ queryKey: ["data-quality", "thresholds"], queryFn: () => api.get<Threshold[]>("/data-quality/thresholds") });
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.map((t) => [t.field, t.days != null ? String(t.days) : ""])));
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, number | null> = {};
      for (const t of data ?? []) {
        const raw = draft[t.field]?.trim() ?? "";
        const next = raw === "" ? null : Number(raw);
        if (next !== t.days) body[t.field] = next === null || Number.isNaN(next) ? null : next;
      }
      return api.put<Threshold[]>("/data-quality/thresholds", { thresholds: body });
    },
    onSuccess: (rows) => {
      qc.setQueryData(["data-quality", "thresholds"], rows);
      qc.invalidateQueries({ queryKey: ["data-quality"] });
      toast.success("Staleness thresholds saved");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const dirty = (data ?? []).some((t) => (draft[t.field] ?? "") !== (t.days != null ? String(t.days) : ""));

  return (
    <Card>
      <CardHeader
        title="Staleness thresholds"
        description="A current fact older than its field's threshold counts as stale. Clear a value to return to the default; fields without a default are never marked stale."
        actions={
          editable && (
            <Button variant="primary" size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save thresholds
            </Button>
          )
        }
      />
      {isLoading ? (
        <CardBody>
          <Skeleton className="h-40" />
        </CardBody>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-ink-3">
              <th className="border-b border-line bg-subtle px-4 py-2">Field</th>
              <th className="border-b border-line bg-subtle px-3 py-2 text-right">Default</th>
              <th className="w-48 border-b border-line bg-subtle px-3 py-2 text-right">Threshold (days)</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.field}>
                <td className="border-b border-line px-4 py-1.5 text-ink">
                  {titleCase(t.field)}
                  {!t.is_default && <Badge tone="blue" className="ml-2">Custom</Badge>}
                </td>
                <td className="border-b border-line px-3 py-1.5 text-right tabular text-ink-3">{t.default_days != null ? `${formatNumber(t.default_days)} d` : "None"}</td>
                <td className="border-b border-line px-3 py-1.5">
                  <Input
                    className="ml-auto w-28 text-right tabular"
                    inputMode="numeric"
                    disabled={!editable}
                    value={draft[t.field] ?? ""}
                    placeholder={t.default_days != null ? String(t.default_days) : "Never"}
                    onChange={(e) => setDraft((d) => ({ ...d, [t.field]: e.target.value.replace(/[^0-9]/g, "") }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
