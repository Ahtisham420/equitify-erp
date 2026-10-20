"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, Link2, Map as MapIcon, MapPinned, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber, formatRelative } from "@/lib/utils";

import { type ParcelFacets, type ParcelListItem } from "@/features/parcels/api";
import { BulkAssociateDialog } from "@/features/parcels/bulk-associate-dialog";
import { downloadGeoJson } from "@/features/parcels/geojson";
import { ParcelFormSheet } from "@/features/parcels/parcel-form";
import { AddToTerritoryDialog } from "@/features/territories/add-to-territory-dialog";

const MORE: MoreFilterField[] = [
  { type: "range", label: "Acreage", minKey: "min_acres", maxKey: "max_acres", suffix: "ac" },
  {
    type: "select",
    label: "Geometry",
    key: "has_geometry",
    options: [
      { value: "true", label: "Has geometry" },
      { value: "false", label: "Missing geometry" },
    ],
  },
  {
    type: "select",
    label: "Property link",
    key: "linked",
    options: [
      { value: "true", label: "Linked to a property" },
      { value: "false", label: "Not linked" },
    ],
  },
  { type: "text", label: "Map extent (minLng,minLat,maxLng,maxLat)", key: "bbox", placeholder: "-97.80,30.20,-97.70,30.30" },
  { type: "number", label: "Near latitude", key: "near_lat" },
  { type: "number", label: "Near longitude", key: "near_lng" },
  { type: "number", label: "Radius", key: "radius_miles", suffix: "miles" },
];

const CHIP_LABELS: Record<string, string> = {
  min_acres: "Min acres", max_acres: "Max acres", has_geometry: "Geometry", linked: "Linked", bbox: "Extent",
  near_lat: "Near lat", near_lng: "Near lng", radius_miles: "Radius (mi)", territory_id: "Territory",
};

const columns: Column<ParcelListItem>[] = [
  {
    id: "apn",
    header: "APN",
    sortKey: "apn",
    cell: (p) => (
      <div className="min-w-[180px] max-w-[300px]">
        <p className="truncate font-mono text-[13px] font-medium text-ink">{p.apn}</p>
        <p className="truncate text-xs text-ink-3">{p.situs_address ?? "No situs address"}</p>
      </div>
    ),
  },
  { id: "county", header: "County", sortKey: "county", hideable: true, cell: (p) => <span className="text-ink-2">{[p.county, p.state].filter(Boolean).join(", ")}</span> },
  { id: "acreage", header: "Acres", sortKey: "acreage", align: "right", hideable: true, cell: (p) => formatNumber(p.acreage, 2) },
  {
    id: "geometry",
    header: "Geometry",
    hideable: true,
    cell: (p) => (p.has_geometry ? <Badge tone="green" dot>Polygon</Badge> : <Badge tone="amber" dot>Missing</Badge>),
  },
  {
    id: "properties",
    header: "Properties",
    align: "right",
    hideable: true,
    cell: (p) => (p.property_count ? formatNumber(p.property_count) : <span className="text-ink-3">—</span>),
  },
  {
    id: "legal",
    header: "Legal description",
    hideable: true,
    defaultHidden: true,
    cell: (p) => <span className="block max-w-[280px] truncate text-xs text-ink-2">{p.legal_description ?? "—"}</span>,
  },
  { id: "source", header: "Source", hideable: true, defaultHidden: true, cell: (p) => <span className="text-xs text-ink-2">{p.source ?? "—"}</span> },
  { id: "observed", header: "Observed", sortKey: "observed_on", hideable: true, defaultHidden: true, cell: (p) => <span className="text-xs text-ink-3">{formatDate(p.observed_on)}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (p) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(p.updated_at)}</span> },
];

function ParcelsView() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<ParcelListItem>("parcels", "/parcels");
  const { url } = list;
  const cols = useColumnVisibility("parcels", columns);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["parcels", "facets", filterParams],
    queryFn: () => api.get<ParcelFacets>("/parcels/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => {
      const raw = url.get(k)!;
      const value = k === "has_geometry" ? (raw === "true" ? "Present" : "Missing") : k === "linked" ? (raw === "true" ? "Yes" : "No") : raw;
      return { key: k, label, value, onRemove: () => url.set({ [k]: null }) };
    });
  for (const [key, label] of [["county", "County"], ["state", "State"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  const filtered = chips.length > 0 || !!url.get("q");

  const exportGeoJson = async () => {
    try {
      const fc = await api.get<{ features: unknown[]; truncated: boolean }>("/parcels/geojson", { ...filterParams, limit: 5000 });
      downloadGeoJson(fc, "parcels.geojson");
      toast.success(`${fc.features.length} parcel shapes exported${fc.truncated ? " (limit reached)" : ""}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const facetOptions = (counts: Record<string, number> | undefined) =>
    Object.entries(counts ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([v, c]) => ({ value: v, label: v, count: c }));

  return (
    <>
      <PageHeader
        title="Parcels & spaces"
        description="Parcel/APN records with geometry, legal descriptions and the properties they make up."
        actions={
          <>
            {can("parcels", "export") && (
              <Button onClick={exportGeoJson}>
                <Download />
                GeoJSON
              </Button>
            )}
            {can("parcels", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus />
                New parcel
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
                  <SavedViewsMenu module="parcels" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search APN, county, legal description…" />
              <FacetFilter label="County" searchable options={facetOptions(facets?.county)} selected={url.getAll("county")} onChange={(v) => url.set({ county: v })} />
              <FacetFilter label="State" options={facetOptions(facets?.state)} selected={url.getAll("state")} onChange={(v) => url.set({ state: v })} />
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
          selectable={can("parcels", "edit") || can("territories", "edit")}
          selected={selected}
          onSelectedChange={setSelected}
          rowHref={(p) => `/parcels/${p.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<MapIcon />}
              title={filtered ? "No parcels match these filters" : "No parcels yet"}
              description={filtered ? "Try removing a filter or widening the map extent." : "Add a parcel with its APN and geometry, or import a county parcel file."}
              action={
                can("parcels", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New parcel
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        {can("parcels", "edit") && (
          <BulkButton icon={<Link2 />} onClick={() => setAssociating(true)}>
            Associate to property
          </BulkButton>
        )}
        {can("territories", "edit") && (
          <BulkButton icon={<MapPinned />} onClick={() => setAssigning(true)}>
            Assign to territory
          </BulkButton>
        )}
      </BulkBar>

      <BulkAssociateDialog
        open={associating}
        onOpenChange={setAssociating}
        parcelIds={selected}
        onDone={(propertyId) => {
          setSelected([]);
          router.push(`/properties/${propertyId}?tab=parcels`);
        }}
      />
      <AddToTerritoryDialog open={assigning} onOpenChange={setAssigning} parcelIds={selected} onDone={() => setSelected([])} />
      <ParcelFormSheet open={creating} onOpenChange={setCreating} onSaved={(p) => router.push(`/parcels/${p.id}`)} />
    </>
  );
}

export default function ParcelsPage() {
  return (
    <Suspense>
      <ParcelsView />
    </Suspense>
  );
}
