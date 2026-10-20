"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Store } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatRelative } from "@/lib/utils";

import { LISTING_STATUSES, LISTING_TYPES, label, useMutate, useUserNames, type Listing } from "@/features/brokerage/api";
import { LISTING_CREATE_FIELDS } from "@/features/brokerage/forms";
import { RecordSheet, State } from "@/features/brokerage/ui";

const MORE: MoreFilterField[] = [
  { type: "range", label: "Asking price", minKey: "min_price", maxKey: "max_price", suffix: "$" },
  { type: "range", label: "Days on market", minKey: "min_dom", maxKey: "max_dom" },
];

const CHIP_LABELS: Record<string, string> = { min_price: "Min price", max_price: "Max price", min_dom: "Min DOM", max_dom: "Max DOM" };

const columns: Column<Listing>[] = [
  {
    id: "property",
    header: "Listing",
    cell: (l) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{l.property_label ?? "Property"}</p>
        <p className="truncate text-xs text-ink-3">{l.headline || [l.property_city, l.property_state].filter(Boolean).join(", ") || "—"}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", hideable: true, cell: (l) => <span className="text-ink-2">{label(l.listing_type)}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (l) => <State value={l.status} /> },
  {
    id: "price",
    header: "Asking",
    sortKey: "asking_price",
    align: "right",
    hideable: true,
    cell: (l) => (
      <span>
        {l.listing_type === "lease" && l.asking_rent_psf != null ? `$${formatNumber(l.asking_rent_psf, 2)}/SF` : formatCurrency(l.asking_price, { compact: true })}
        {l.price_change_count > 0 && <span className="ml-1 text-2xs text-ink-3">({l.price_change_count}×)</span>}
      </span>
    ),
  },
  {
    id: "dom",
    header: "Days on market",
    sortKey: "days_on_market",
    align: "right",
    hideable: true,
    cell: (l) => <span className={cn(l.days_on_market != null && l.days_on_market > 180 && "font-medium text-caution")}>{l.days_on_market ?? "—"}</span>,
  },
  { id: "inquiries", header: "Inquiries", align: "right", hideable: true, cell: (l) => formatNumber(l.inquiry_count) },
  { id: "showings", header: "Showings", align: "right", hideable: true, cell: (l) => formatNumber(l.showing_count) },
  { id: "agent", header: "Agent", hideable: true, cell: (l) => <span className="whitespace-nowrap text-ink-2">{l.agent_name ?? "—"}</span> },
  { id: "expires", header: "Expires", sortKey: "expires_on", hideable: true, defaultHidden: true, cell: (l) => <span className="text-ink-2">{formatDate(l.expires_on)}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (l) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(l.updated_at)}</span> },
];

function ListingsView() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<Listing>("brokerage", "/listings");
  const { url } = list;
  const cols = useColumnVisibility("listings", columns);
  const users = useUserNames();
  const [creating, setCreating] = useState(false);
  const create = useMutate((body: Record<string, unknown>) => api.post<Listing>("/listings", body));

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["brokerage", "listing-facets", filterParams],
    queryFn: () => api.get<{ status: Record<string, number>; listing_type: Record<string, number>; agent_id: Record<string, number> }>("/listings/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, l]) => ({ key: k, label: l, value: url.get(k)!, onRemove: () => url.set({ [k]: null }) }));
  for (const [key, l] of [["status", "Status"], ["listing_type", "Type"], ["agent_id", "Agent"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label: l, value: values.map((v) => (key === "agent_id" ? users[v] ?? "Agent" : label(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  const filtered = chips.length > 0 || !!url.get("q") || url.get("mine") === "true";

  return (
    <>
      <PageHeader
        title="Listings"
        description="Seller listings with asking-price and status history, marketing, inquiries, showings and offers."
        actions={
          can("brokerage", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New listing
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
                  <SavedViewsMenu module="brokerage" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property, city, headline…" />
              <FacetFilter label="Status" options={LISTING_STATUSES.map((s) => ({ value: s, label: label(s), count: facets?.status[s] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <FacetFilter label="Type" options={LISTING_TYPES.map((s) => ({ value: s, label: label(s), count: facets?.listing_type[s] ?? 0 }))} selected={url.getAll("listing_type")} onChange={(v) => url.set({ listing_type: v })} />
              <FacetFilter
                label="Agent"
                searchable
                options={Object.entries(facets?.agent_id ?? {}).map(([id, c]) => ({ value: id, label: users[id] ?? "Unknown", count: c }))}
                selected={url.getAll("agent_id")}
                onChange={(v) => url.set({ agent_id: v })}
              />
              <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-sm text-ink-2 shadow-card">
                <Checkbox checked={url.get("mine") === "true"} onChange={(c) => url.set({ mine: c || null })} />
                My listings
              </label>
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={
          <TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowHref={(l) => `/listings/${l.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Store />}
              title={filtered ? "No listings match these filters" : "No listings yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Convert an engaged prospect from Brokerage CRM, or create a listing directly."}
              action={
                can("brokerage", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New listing
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>
      <RecordSheet
        open={creating}
        onOpenChange={setCreating}
        title="New listing"
        description="The initial asking price starts the price history. Live listings mark the property as listed."
        fields={LISTING_CREATE_FIELDS}
        initial={{ listing_type: "sale", status: "draft", reporting_cadence: "biweekly" }}
        onSubmit={async (body) => {
          const l = await create.mutateAsync(body);
          router.push(`/listings/${l.id}`);
        }}
      />
    </>
  );
}

export default function ListingsPage() {
  return (
    <Suspense>
      <ListingsView />
    </Suspense>
  );
}
