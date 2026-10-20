"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, Network, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import { INTEREST_ROLES, nodeHref, type Interest, type InterestFacets } from "./api";
import { EvidenceList } from "./evidence";
import { InterestSheet } from "./interest-sheet";

const MORE: MoreFilterField[] = [
  { type: "select", label: "Status", key: "current", options: [{ value: "true", label: "Current interests" }, { value: "false", label: "Ended interests" }] },
  { type: "select", label: "Mailing mismatch", key: "mismatch", options: [{ value: "true", label: "Owner mails out of state" }] },
  { type: "text", label: "Property state", key: "state", placeholder: "e.g. TX" },
];
const CHIP_LABELS: Record<string, string> = { current: "Status", mismatch: "Mismatch", state: "State" };
const OWNER_KINDS = ["organization", "person"];

const columns: Column<Interest>[] = [
  {
    id: "owner",
    header: "Owner",
    sortKey: "owner",
    cell: (i) => (
      <div className="min-w-[180px] max-w-[260px]">
        {i.owner_id ? (
          <Link href={nodeHref(i.owner_kind, i.owner_id)} className="block truncate font-medium text-ink hover:underline">{i.owner_label ?? "—"}</Link>
        ) : (
          <span className="font-medium">{i.owner_label ?? "—"}</span>
        )}
        <p className="text-xs text-ink-3">{titleCase(i.owner_kind)}{i.owner_state ? ` · ${i.owner_state}` : ""}</p>
      </div>
    ),
  },
  {
    id: "property",
    header: "Property",
    sortKey: "property",
    cell: (i) => (
      <div className="min-w-[200px] max-w-[300px]">
        <Link href={`/properties/${i.property_id}?tab=ownership`} className="block truncate text-ink hover:underline">{i.property_label ?? "—"}</Link>
        <p className="truncate text-xs text-ink-3">{[i.property_city, i.property_state].filter(Boolean).join(", ") || "—"}</p>
      </div>
    ),
  },
  { id: "role", header: "Role", sortKey: "role", hideable: true, cell: (i) => <span className="text-ink-2">{titleCase(i.role)}</span> },
  { id: "pct", header: "Interest", sortKey: "interest_pct", align: "right", hideable: true, cell: (i) => formatPercent(i.interest_pct, 1) },
  {
    id: "period",
    header: "Effective",
    sortKey: "effective_from",
    hideable: true,
    cell: (i) => (
      <span className="whitespace-nowrap text-xs text-ink-2">
        {formatDate(i.effective_from)} – {i.effective_to ? formatDate(i.effective_to) : "present"}
      </span>
    ),
  },
  { id: "hold", header: "Hold (yrs)", align: "right", hideable: true, cell: (i) => formatNumber(i.hold_years, 1) },
  { id: "price", header: "Acquired", sortKey: "acquired_price", align: "right", hideable: true, cell: (i) => formatCurrency(i.acquired_price, { compact: true }) },
  { id: "verification", header: "Verification", hideable: true, cell: (i) => <StatusBadge status={i.verification} /> },
  { id: "confidence", header: "Confidence", sortKey: "confidence", align: "right", hideable: true, cell: (i) => <ConfidencePill value={i.confidence} /> },
  {
    id: "flags",
    header: "Flags",
    hideable: true,
    cell: (i) => (
      <div className="flex gap-1">
        {!i.is_current && <Badge tone="outline">Ended</Badge>}
        {i.mismatch && (
          <Badge tone="amber">
            <AlertTriangle className="size-3" /> Out of state
          </Badge>
        )}
      </div>
    ),
  },
  { id: "evidence", header: "Evidence", hideable: true, defaultHidden: true, cell: (i) => <EvidenceList items={i.evidence} hidden={i.hidden_evidence} compact /> },
  { id: "source", header: "Source", hideable: true, defaultHidden: true, cell: (i) => <span className="text-xs text-ink-2">{i.source}</span> },
];

export function InterestsTable() {
  const { can } = useAuth();
  const list = useListQuery<Interest>("ownership", "/ownership/interests");
  const { url } = list;
  const cols = useColumnVisibility("ownership-interests", columns);
  const [adding, setAdding] = useState(false);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["ownership", "interest-facets", filterParams],
    queryFn: () => api.get<InterestFacets>("/ownership/interests/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({
      key: k,
      label,
      value: k === "current" ? (url.get(k) === "true" ? "Current" : "Ended") : k === "mismatch" ? "Out of state" : url.get(k)!,
      onRemove: () => url.set({ [k]: null }),
    }));
  for (const [key, label] of [["role", "Role"], ["verification", "Verification"], ["owner_kind", "Owner type"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map(titleCase).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const opts = (counts: Record<string, number> | undefined, values: readonly string[]) =>
    values.map((v) => ({ value: v, label: titleCase(v), count: counts?.[v] ?? 0 }));

  const exportCsv = async () => {
    try {
      await api.download("/ownership/interests/export", filterParams, "ownership-interests.csv");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="ownership" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                  {can("ownership", "export") && (
                    <Button onClick={exportCsv}>
                      <Download /> Export
                    </Button>
                  )}
                  {can("ownership", "create") && (
                    <Button variant="primary" onClick={() => setAdding(true)}>
                      <Plus /> Add interest
                    </Button>
                  )}
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search owner, property, city…" />
              <FacetFilter label="Role" options={opts(facets?.role, INTEREST_ROLES)} selected={url.getAll("role")} onChange={(v) => url.set({ role: v })} />
              <FacetFilter label="Verification" options={opts(facets?.verification, ["unverified", "verified", "rejected"])} selected={url.getAll("verification")} onChange={(v) => url.set({ verification: v })} />
              <FacetFilter label="Owner type" options={opts(facets?.owner_kind, OWNER_KINDS)} selected={url.getAll("owner_kind")} onChange={(v) => url.set({ owner_kind: v })} />
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
          hidden={cols.hidden}
          rowClassName={(i) => (!i.is_current ? "text-ink-3" : undefined)}
          empty={
            <EmptyState
              icon={<Network />}
              title={filtered ? "No interests match these filters" : "No ownership interests yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Record who owns each property, with evidence and effective dates."}
            />
          }
        />
      </ListCard>
      <InterestSheet open={adding} onOpenChange={setAdding} />
    </>
  );
}
