"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe2, Lock, MapPinned, Plus, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, formatRelative } from "@/lib/utils";

import { RULE_LABELS, RULE_TYPES, VISIBILITIES, VISIBILITY_LABELS, type TerritoryListItem } from "@/features/territories/api";
import { TerritoryFormSheet } from "@/features/territories/territory-form";

const VIS_ICON: Record<string, typeof Lock> = { private: Lock, role: Users, company: Globe2 };

const MORE: MoreFilterField[] = [
  { type: "select", label: "Level", key: "top_level", options: [{ value: "true", label: "Top-level only" }] },
  { type: "select", label: "Owner", key: "mine", options: [{ value: "true", label: "Owned by me" }] },
];

const columns: Column<TerritoryListItem>[] = [
  {
    id: "name",
    header: "Territory",
    sortKey: "name",
    cell: (t) => (
      <div className="min-w-[200px] max-w-[360px]">
        <p className="truncate font-medium text-ink">{t.name}</p>
        <p className="truncate text-xs text-ink-3">{t.description ?? (t.parent_id ? "Nested territory" : "—")}</p>
      </div>
    ),
  },
  { id: "rule", header: "Rule", sortKey: "rule_type", hideable: true, cell: (t) => <Badge tone="outline">{RULE_LABELS[t.rule_type] ?? t.rule_type}</Badge> },
  {
    id: "visibility",
    header: "Visibility",
    sortKey: "visibility",
    hideable: true,
    cell: (t) => {
      const Icon = VIS_ICON[t.visibility] ?? Lock;
      return (
        <span className="inline-flex items-center gap-1.5 text-ink-2">
          <Icon className="size-3.5 text-ink-3" />
          {VISIBILITY_LABELS[t.visibility] ?? t.visibility}
        </span>
      );
    },
  },
  { id: "members", header: "Members", sortKey: "member_count", align: "right", hideable: true, cell: (t) => formatNumber(t.member_count) },
  { id: "geometry", header: "Shape", hideable: true, defaultHidden: true, cell: (t) => (t.has_geometry ? <Badge tone="green" dot>Yes</Badge> : <span className="text-ink-3">—</span>) },
  { id: "computed", header: "Recomputed", sortKey: "last_computed_at", hideable: true, cell: (t) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(t.last_computed_at)}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (t) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(t.updated_at)}</span> },
];

function TerritoriesView() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<TerritoryListItem>("territories", "/territories");
  const { url } = list;
  const cols = useColumnVisibility("territories", columns);
  const [creating, setCreating] = useState(false);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["territories", "facets", filterParams],
    queryFn: () => api.get<{ rule_type: Record<string, number>; visibility: Record<string, number> }>("/territories/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  if (url.get("top_level")) chips.push({ key: "top_level", label: "Level", value: "Top-level", onRemove: () => url.set({ top_level: null }) });
  if (url.get("mine")) chips.push({ key: "mine", label: "Owner", value: "Me", onRemove: () => url.set({ mine: null }) });
  if (url.getAll("rule_type").length)
    chips.unshift({ key: "rule_type", label: "Rule", value: url.getAll("rule_type").map((v) => RULE_LABELS[v] ?? v).join(", "), onRemove: () => url.set({ rule_type: null }) });
  if (url.getAll("visibility").length)
    chips.unshift({ key: "visibility", label: "Visibility", value: url.getAll("visibility").map((v) => VISIBILITY_LABELS[v] ?? v).join(", "), onRemove: () => url.set({ visibility: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="Territories"
        description="Named groupings of properties by assignment, boundary, radius, corridor, county, city or saved query."
        actions={
          can("territories", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New territory
            </Button>
          )
        }
      />
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="territories" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search territories…" />
              <FacetFilter
                label="Rule"
                options={RULE_TYPES.map((r) => ({ value: r, label: RULE_LABELS[r], count: facets?.rule_type[r] ?? 0 }))}
                selected={url.getAll("rule_type")}
                onChange={(v) => url.set({ rule_type: v })}
              />
              <FacetFilter
                label="Visibility"
                options={VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_LABELS[v], count: facets?.visibility[v] ?? 0 }))}
                selected={url.getAll("visibility")}
                onChange={(v) => url.set({ visibility: v })}
              />
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
          rowHref={(t) => `/territories/${t.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<MapPinned />}
              title={filtered ? "No territories match these filters" : "No territories yet"}
              description={filtered ? "Try removing a filter." : "Create a territory to group properties by geography or a saved query — no database change needed."}
              action={
                can("territories", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New territory
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>
      <TerritoryFormSheet open={creating} onOpenChange={setCreating} onSaved={(t) => router.push(`/territories/${t.id}`)} />
    </>
  );
}

export default function TerritoriesPage() {
  return (
    <Suspense>
      <TerritoriesView />
    </Suspense>
  );
}
