"use client";

import { useQuery } from "@tanstack/react-query";
import { Landmark, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
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
import { formatCurrency, formatRelative, titleCase } from "@/lib/utils";

import { PARTNER_STATUSES, PARTNER_TYPES, type PartnerFacets, type PartnerListItem } from "@/features/investors/api";
import { EventsTab } from "@/features/investors/events-tab";
import { PartnerFormSheet } from "@/features/investors/partner-form";
import { ReportsTab } from "@/features/investors/reports-tab";
import { WaterfallsTab } from "@/features/investors/waterfalls-tab";

const MORE: MoreFilterField[] = [
  { type: "select", label: "Default status", key: "in_default", options: [{ value: "true", label: "In default" }, { value: "false", label: "Not in default" }] },
];

const columns: Column<PartnerListItem>[] = [
  {
    id: "name",
    header: "Partner",
    sortKey: "name",
    cell: (p) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{p.name}</p>
        <p className="truncate text-xs text-ink-3">{p.email ?? "—"}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", sortKey: "type", hideable: true, cell: (p) => <span className="text-ink-2">{titleCase(p.type)}</span> },
  {
    id: "status",
    header: "Status",
    sortKey: "status",
    hideable: true,
    cell: (p) => (
      <div className="flex items-center gap-1">
        <StatusBadge status={p.status} />
        {p.in_default && <Badge tone="red">Default</Badge>}
      </div>
    ),
  },
  { id: "investments", header: "Investments", align: "right", hideable: true, cell: (p) => p.investment_count },
  { id: "commitment", header: "Commitment", align: "right", hideable: true, cell: (p) => formatCurrency(p.commitment, { compact: true }) },
  { id: "funded", header: "Funded", align: "right", hideable: true, cell: (p) => formatCurrency(p.funded, { compact: true }) },
  { id: "unfunded", header: "Unfunded", align: "right", hideable: true, cell: (p) => formatCurrency(p.unfunded, { compact: true }) },
  { id: "portal", header: "Portal", hideable: true, defaultHidden: true, cell: (p) => (p.portal_user_id ? <Badge tone="sky">Enabled</Badge> : <span className="text-ink-3">—</span>) },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (p) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(p.updated_at)}</span> },
];

function PartnersList() {
  const { can } = useAuth();
  const list = useListQuery<PartnerListItem>("investors", "/investors/partners");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const cols = useColumnVisibility("investor-partners", columns);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["investors", "partner-facets", filterParams],
    queryFn: () => api.get<PartnerFacets>("/investors/partners/facets", filterParams),
    placeholderData: (p) => p,
  });

  const chips: FilterChip[] = [];
  for (const [key, label] of [["type", "Type"], ["status", "Status"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map(titleCase).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (url.get("in_default")) chips.push({ key: "in_default", label: "Default", value: url.get("in_default") === "true" ? "In default" : "Not in default", onRemove: () => url.set({ in_default: null }) });

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="investors" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search partners, email…" />
              <FacetFilter label="Type" options={PARTNER_TYPES.map((v) => ({ value: v, label: titleCase(v), count: facets?.type?.[v] ?? 0 }))} selected={url.getAll("type")} onChange={(v) => url.set({ type: v })} />
              <FacetFilter label="Status" options={PARTNER_STATUSES.map((v) => ({ value: v, label: titleCase(v), count: facets?.status?.[v] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
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
          rowHref={(p) => `/investors/${p.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Landmark />}
              title={chips.length || url.get("q") ? "No partners match these filters" : "No capital partners yet"}
              description={chips.length || url.get("q") ? "Try removing a filter." : "Add LP investors and sponsor entities, then record their investments."}
              action={
                can("investors", "create") && !chips.length ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New partner
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>
      <PartnerFormSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

function InvestorsView() {
  const router = useRouter();
  const url = useUrlState();
  const { can, user } = useAuth();
  const [creating, setCreating] = useState(false);
  const tab = url.get("tab") ?? "partners";
  const portal = user?.role.key === "capital_partner";

  useEffect(() => {
    if (portal) router.replace("/investors/portal");
  }, [portal, router]);
  if (portal) return null;

  return (
    <>
      <PageHeader
        title="Capital partners"
        description="Equity relationships, commitments, capital accounts, distributions and investor reporting."
        actions={
          tab === "partners" &&
          can("investors", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New partner
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "partners" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "partners", label: "Partners" },
            { value: "events", label: "Capital events" },
            { value: "waterfalls", label: "Waterfalls" },
            { value: "reports", label: "Reporting" },
          ]}
        />
        <TabPanel value="partners">{tab === "partners" && <PartnersList />}</TabPanel>
        <TabPanel value="events">{tab === "events" && <EventsTab />}</TabPanel>
        <TabPanel value="waterfalls">{tab === "waterfalls" && <WaterfallsTab />}</TabPanel>
        <TabPanel value="reports">{tab === "reports" && <ReportsTab />}</TabPanel>
      </Tabs>
      <PartnerFormSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function InvestorsPage() {
  return (
    <Suspense>
      <InvestorsView />
    </Suspense>
  );
}
