"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, Download, Plus, Tag } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Progress } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import { PROPERTY_STATUSES, PROPERTY_TYPE_LABELS, PROPERTY_TYPES, propertyTitle, useBulkProperties, type PropertyFacets, type PropertyListItem } from "@/features/properties/api";
import { PropertyFormSheet } from "@/features/properties/property-form";

const MORE: MoreFilterField[] = [
  { type: "text", label: "City", key: "city" },
  { type: "text", label: "County", key: "county" },
  { type: "range", label: "Building area", minKey: "min_area", maxKey: "max_area", suffix: "SF" },
  { type: "range", label: "Land area", minKey: "min_acres", maxKey: "max_acres", suffix: "ac" },
  { type: "range", label: "Asking price", minKey: "min_price", maxKey: "max_price", suffix: "$" },
  { type: "range", label: "Year built", minKey: "min_year", maxKey: "max_year" },
  { type: "number", label: "Minimum completeness", key: "min_completeness", suffix: "%" },
  { type: "text", label: "Tag", key: "tag" },
];

const CHIP_LABELS: Record<string, string> = {
  city: "City", county: "County", min_area: "Min SF", max_area: "Max SF", min_acres: "Min acres", max_acres: "Max acres",
  min_price: "Min price", max_price: "Max price", min_year: "Built after", max_year: "Built before",
  min_completeness: "Completeness ≥", tag: "Tag",
};

const columns: Column<PropertyListItem>[] = [
  {
    id: "property",
    header: "Property",
    sortKey: "address_line",
    cell: (p) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{propertyTitle(p)}</p>
        <p className="truncate text-xs text-ink-3">{[p.name ? p.address_line : null, p.city, p.state].filter(Boolean).join(", ") || "—"}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", sortKey: "property_type", hideable: true, cell: (p) => <span className="text-ink-2">{PROPERTY_TYPE_LABELS[p.property_type] ?? titleCase(p.property_type)}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (p) => <StatusBadge status={p.status} /> },
  { id: "county", header: "County", hideable: true, defaultHidden: true, cell: (p) => <span className="text-ink-2">{p.county ?? "—"}</span> },
  { id: "area", header: "Building SF", sortKey: "building_area_sf", align: "right", hideable: true, cell: (p) => formatNumber(p.building_area_sf) },
  { id: "acres", header: "Acres", sortKey: "land_area_acres", align: "right", hideable: true, cell: (p) => formatNumber(p.land_area_acres, 2) },
  { id: "price", header: "Asking", sortKey: "asking_price", align: "right", hideable: true, cell: (p) => formatCurrency(p.asking_price, { compact: true }) },
  { id: "occupancy", header: "Occupancy", align: "right", hideable: true, cell: (p) => formatPercent(p.occupancy_pct, 0) },
  { id: "year", header: "Built", sortKey: "year_built", align: "right", hideable: true, defaultHidden: true, cell: (p) => p.year_built ?? "—" },
  {
    id: "completeness",
    header: "Data",
    sortKey: "completeness_score",
    hideable: true,
    width: 110,
    cell: (p) => (
      <div className="flex items-center gap-2">
        <Progress value={p.completeness_score} className="w-12" />
        <span className="text-xs text-ink-3 tabular">{Math.round(p.completeness_score)}%</span>
      </div>
    ),
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (p) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(p.updated_at)}</span> },
];

function PropertiesView() {
  const { can } = useAuth();
  const list = useListQuery<PropertyListItem>("properties", "/properties");
  const { url } = list;
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");
  const cols = useColumnVisibility("properties", columns);
  const bulk = useBulkProperties();

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["properties", "facets", filterParams],
    queryFn: () => api.get<PropertyFacets>("/properties/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label] of [["status", "Status"], ["property_type", "Type"], ["state", "State"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map((v) => (key === "property_type" ? PROPERTY_TYPE_LABELS[v] ?? v : titleCase(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  const runBulk = (body: { status?: string; add_tags?: string[] }) =>
    bulk.mutate(
      { ids: selected, ...body },
      {
        onSuccess: (r) => {
          toast.success(`${r.updated} properties updated`);
          setSelected([]);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const exportCsv = async () => {
    try {
      await api.download("/properties/export", filterParams, "properties.csv");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const facetOptions = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

  return (
    <>
      <PageHeader
        title="Properties"
        description="The permanent record of every commercial property the company has encountered."
        actions={
          <>
            {can("properties", "export") && (
              <Button onClick={exportCsv}>
                <Download />
                Export
              </Button>
            )}
            {can("properties", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus />
                New property
              </Button>
            )}
          </>
        }
      />

      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="properties" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search address, name, city, county…" />
              <FacetFilter label="Status" options={facetOptions(facets?.status, PROPERTY_STATUSES, titleCase)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Type" options={facetOptions(facets?.property_type, PROPERTY_TYPES, (v) => PROPERTY_TYPE_LABELS[v])} selected={url.getAll("property_type")} onChange={(v) => url.set({ property_type: v })} />
              <FacetFilter
                label="State"
                searchable
                options={Object.entries(facets?.state ?? {}).sort().map(([v, c]) => ({ value: v, label: v, count: c }))}
                selected={url.getAll("state")}
                onChange={(v) => url.set({ state: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips
              chips={chips}
              onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })}
            />
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
          selectable={can("properties", "edit")}
          selected={selected}
          onSelectedChange={setSelected}
          rowHref={(p) => `/properties/${p.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Building2 />}
              title={chips.length || url.get("q") ? "No properties match these filters" : "No properties yet"}
              description={chips.length || url.get("q") ? "Try removing a filter or broadening your search." : "Add a property manually or import a list."}
              action={
                can("properties", "create") && !chips.length ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New property
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <Menu>
          <MenuTrigger asChild>
            <BulkButton>Set status</BulkButton>
          </MenuTrigger>
          <MenuContent align="center">
            {PROPERTY_STATUSES.map((s) => (
              <MenuItem key={s} onSelect={() => runBulk({ status: s })}>
                <StatusBadge status={s} />
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <BulkButton icon={<Tag />} onClick={() => setTagOpen(true)}>
          Add tag
        </BulkButton>
      </BulkBar>

      <Dialog
        open={tagOpen}
        onOpenChange={setTagOpen}
        title={`Tag ${selected.length} properties`}
        footer={
          <>
            <Button onClick={() => setTagOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!tagValue.trim()}
              loading={bulk.isPending}
              onClick={() => {
                runBulk({ add_tags: tagValue.split(",").map((t) => t.trim()).filter(Boolean) });
                setTagOpen(false);
                setTagValue("");
              }}
            >
              Add tag
            </Button>
          </>
        }
      >
        <Input autoFocus value={tagValue} onChange={(e) => setTagValue(e.target.value)} placeholder="e.g. corridor-I35, priority" />
      </Dialog>

      <PropertyFormSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function PropertiesPage() {
  return (
    <Suspense>
      <PropertiesView />
    </Suspense>
  );
}
