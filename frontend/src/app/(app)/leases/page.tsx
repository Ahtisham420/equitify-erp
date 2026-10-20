"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ScrollText } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState, type ReactNode } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { PropertyPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatRelative, titleCase } from "@/lib/utils";

import { LEASE_STATUSES, LEASE_TYPE_LABELS, LEASE_TYPES, type LeaseFacets, type LeaseListItem } from "@/features/leases/api";
import { LeaseFormSheet } from "@/features/leases/lease-form";
import { ReconciliationPanel } from "@/features/leases/reconciliation-panel";
import { RentRollView } from "@/features/leases/rent-roll";
import { RolloverView } from "@/features/leases/rollover";

const MORE: MoreFilterField[] = [
  { type: "date-range", label: "Expires between", minKey: "expires_from", maxKey: "expires_to" },
  { type: "range", label: "Rentable area", minKey: "min_sf", maxKey: "max_sf", suffix: "SF" },
];

const CHIP_LABELS: Record<string, string> = {
  expires_from: "Expires after", expires_to: "Expires before", min_sf: "Min SF", max_sf: "Max SF",
};

const EXPIRING = [
  { value: "90", label: "Within 90 days" },
  { value: "180", label: "Within 6 months" },
  { value: "365", label: "Within 12 months" },
  { value: "730", label: "Within 24 months" },
];

function daysUntil(d: string | null) {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);
}

const columns: Column<LeaseListItem>[] = [
  {
    id: "tenant",
    header: "Tenant",
    sortKey: "tenant_name",
    cell: (l) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{l.tenant_name}</p>
        <p className="truncate text-xs text-ink-3">{[l.property_name, l.suite ? `Suite ${l.suite}` : null].filter(Boolean).join(" · ")}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", sortKey: "lease_type", hideable: true, cell: (l) => <span className="text-ink-2">{LEASE_TYPE_LABELS[l.lease_type] ?? titleCase(l.lease_type)}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (l) => <StatusBadge status={l.status} /> },
  { id: "sf", header: "SF", sortKey: "rentable_sf", align: "right", hideable: true, cell: (l) => formatNumber(l.rentable_sf) },
  { id: "rent", header: "Annual rent", sortKey: "current_annual_rent", align: "right", hideable: true, cell: (l) => formatCurrency(l.current_annual_rent) },
  { id: "psf", header: "Rent / SF", align: "right", hideable: true, cell: (l) => (l.rent_psf != null ? `$${formatNumber(l.rent_psf, 2)}` : "—") },
  { id: "commence", header: "Commenced", sortKey: "commencement_on", hideable: true, defaultHidden: true, cell: (l) => <span className="whitespace-nowrap text-ink-2">{formatDate(l.commencement_on)}</span> },
  {
    id: "expires",
    header: "Expires",
    sortKey: "expiration_on",
    hideable: true,
    cell: (l) => {
      const d = daysUntil(l.expiration_on);
      return (
        <span className={cn("whitespace-nowrap", d !== null && d >= 0 && d <= 180 ? "font-medium text-caution" : "text-ink-2")}>
          {formatDate(l.expiration_on)}
        </span>
      );
    },
  },
  {
    id: "verified",
    header: "Abstract",
    hideable: true,
    cell: (l) => (l.verified ? <Badge tone="green" dot>Verified</Badge> : <Badge tone="amber" dot>{l.ai_extracted ? "AI · unverified" : "Unverified"}</Badge>),
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (l) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(l.updated_at)}</span> },
];

function LeaseList() {
  const { can } = useAuth();
  const list = useListQuery<LeaseListItem>("leases", "/leases");
  const { url } = list;
  const cols = useColumnVisibility("leases", columns);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["leases", "facets", filterParams],
    queryFn: () => api.get<LeaseFacets>("/leases/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label] of [["status", "Status"], ["lease_type", "Type"], ["verified", "Abstract"]] as const) {
    const values = url.getAll(key);
    if (values.length)
      chips.unshift({
        key, label,
        value: values.map((v) => (key === "lease_type" ? LEASE_TYPE_LABELS[v] ?? v : key === "verified" ? (v === "true" ? "Verified" : "Unverified") : titleCase(v))).join(", "),
        onRemove: () => url.set({ [key]: null }),
      });
  }
  if (url.get("expiring_within"))
    chips.unshift({ key: "expiring_within", label: "Expiring", value: EXPIRING.find((e) => e.value === url.get("expiring_within"))?.label ?? `${url.get("expiring_within")} days`, onRemove: () => url.set({ expiring_within: null }) });
  if (url.get("property_id")) chips.unshift({ key: "property_id", label: "Property", value: "Selected property", onRemove: () => url.set({ property_id: null }) });

  const opts = (counts: Record<string, number> | undefined, values: readonly string[], label: (v: string) => string) =>
    values.map((v) => ({ value: v, label: label(v), count: counts?.[v] ?? 0 }));

  return (
    <ListCard
      toolbar={
        <div className="space-y-2.5">
          <Toolbar
            right={
              <>
                <SavedViewsMenu module="leases" />
                <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search tenant, landlord, premises…" />
            <FacetFilter label="Status" options={opts(facets?.status, LEASE_STATUSES, titleCase)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Type" options={opts(facets?.lease_type, LEASE_TYPES, (v) => LEASE_TYPE_LABELS[v])} selected={url.getAll("lease_type")} onChange={(v) => url.set({ lease_type: v })} />
            <FacetFilter
              label="Expiring"
              single
              options={EXPIRING.map((e) => ({ ...e, count: facets?.expiring?.[e.value] ?? 0 }))}
              selected={url.get("expiring_within") ? [url.get("expiring_within")!] : []}
              onChange={(v) => url.set({ expiring_within: v[0] ?? null })}
            />
            <FacetFilter
              label="Abstract"
              options={[
                { value: "true", label: "Verified", count: facets?.verified?.true ?? 0 },
                { value: "false", label: "Unverified", count: facets?.verified?.false ?? 0 },
              ]}
              selected={url.getAll("verified")}
              onChange={(v) => url.set({ verified: v })}
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
        rowHref={(l) => `/leases/${l.id}`}
        hidden={cols.hidden}
        empty={
          <EmptyState
            icon={<ScrollText />}
            title={chips.length || url.get("q") ? "No leases match these filters" : "No leases yet"}
            description={chips.length || url.get("q") ? "Try removing a filter or broadening your search." : can("leases", "create") ? "Abstract a lease to start the rent roll." : undefined}
          />
        }
      />
    </ListCard>
  );
}

function PropertyScope({ children, required }: { children: (propertyId: string | null) => ReactNode; required?: boolean }) {
  const url = useUrlState();
  const propertyId = url.get("property_id");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-80">
          <PropertyPicker value={propertyId} onChange={(id) => url.set({ property_id: id })} placeholder={required ? "Choose a property" : "All properties"} />
        </div>
        {!propertyId && !required && <span className="text-xs text-ink-3">Showing the whole portfolio</span>}
      </div>
      {children(propertyId)}
    </div>
  );
}

function LeasesView() {
  const { can } = useAuth();
  const router = useRouter();
  const url = useUrlState();
  const [creating, setCreating] = useState(false);
  const tab = url.get("tab") ?? "leases";

  return (
    <>
      <PageHeader
        title="Leases & rent roll"
        description="Lease abstracts with cited terms, the rent roll, rollover exposure and recovery reconciliations."
        actions={
          can("leases", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New lease
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "leases" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "leases", label: "Leases" },
            { value: "rent-roll", label: "Rent roll" },
            { value: "rollover", label: "Rollover" },
            { value: "reconciliations", label: "Reconciliations" },
          ]}
        />
        <TabPanel value="leases">
          <LeaseList />
        </TabPanel>
        <TabPanel value="rent-roll">
          <PropertyScope>{(pid) => <RentRollView propertyId={pid} showProperty={!pid} />}</PropertyScope>
        </TabPanel>
        <TabPanel value="rollover">
          <PropertyScope>{(pid) => <RolloverView propertyId={pid} />}</PropertyScope>
        </TabPanel>
        <TabPanel value="reconciliations">
          <PropertyScope required>{(pid) => <ReconciliationPanel propertyId={pid} />}</PropertyScope>
        </TabPanel>
      </Tabs>
      <LeaseFormSheet open={creating} onOpenChange={setCreating} onSaved={(l) => router.push(`/leases/${l.id}`)} />
    </>
  );
}

export default function LeasesPage() {
  return (
    <Suspense>
      <LeasesView />
    </Suspense>
  );
}
