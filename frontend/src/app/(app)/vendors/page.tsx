"use client";

import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { Download, Plus, RefreshCw, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, titleCase } from "@/lib/utils";

import { VENDOR_SERVICES, VENDOR_STATUSES, expiryTone, useOperationsScan, type VendorFacets, type VendorListItem } from "@/features/operations/api";
import { ComplianceBadge, VendorFormSheet, VendorStatusBadge, serviceLabel } from "@/features/operations/vendor-form";

const MORE: MoreFilterField[] = [{ type: "text", label: "Tag", key: "tag" }];

const COMPLIANCE_LABELS: Record<string, string> = { compliant: "Compliant", non_compliant: "Blocked" };

const TONE_TEXT: Record<string, string> = { red: "text-negative", amber: "text-caution", green: "text-ink-2", neutral: "text-ink-3" };

function daysUntil(d: string | null): number | null {
  if (!d) return null;
  return differenceInCalendarDays(parseISO(d), new Date());
}

const columns: Column<VendorListItem>[] = [
  {
    id: "vendor",
    header: "Vendor",
    sortKey: "name",
    cell: (v) => (
      <div className="min-w-[200px] max-w-[300px]">
        <p className="truncate font-medium text-ink">{v.name}</p>
        <p className="truncate text-xs text-ink-3">{[v.primary_contact_name, v.email ?? v.phone].filter(Boolean).join(" · ") || "—"}</p>
      </div>
    ),
  },
  {
    id: "services",
    header: "Services",
    hideable: true,
    cell: (v) =>
      v.services.length ? (
        <div className="flex items-center gap-1">
          {v.services.slice(0, 2).map((s) => (
            <Badge key={s} tone="outline">
              {serviceLabel(s)}
            </Badge>
          ))}
          {v.services.length > 2 && <span className="text-xs text-ink-3">+{v.services.length - 2}</span>}
        </div>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (v) => <VendorStatusBadge status={v.status} /> },
  { id: "compliance", header: "Compliance", hideable: true, cell: (v) => <ComplianceBadge compliant={v.compliant} reasons={v.compliance_reasons} /> },
  {
    id: "expiry",
    header: "Next expiry",
    hideable: true,
    cell: (v) => {
      const days = daysUntil(v.next_expiry_on);
      if (days === null) return <span className="text-ink-3">—</span>;
      return (
        <div className="whitespace-nowrap">
          <p className={cn("text-sm", TONE_TEXT[expiryTone(days)])}>{formatDate(v.next_expiry_on)}</p>
          <p className={cn("text-xs", days < 0 ? "text-negative" : "text-ink-3")}>{days < 0 ? `${-days}d ago` : days === 0 ? "today" : `in ${days}d`}</p>
        </div>
      );
    },
  },
  {
    id: "rating",
    header: "Rating",
    sortKey: "performance_rating",
    align: "right",
    hideable: true,
    cell: (v) => (v.performance_rating != null ? `${formatNumber(v.performance_rating, 1)} / 5` : <span className="text-ink-3">—</span>),
  },
  { id: "spend", header: "Spend YTD", align: "right", hideable: true, cell: (v) => formatCurrency(v.spend_ytd) },
  { id: "tags", header: "Tags", hideable: true, defaultHidden: true, cell: (v) => <span className="text-xs text-ink-2">{v.tags.join(", ") || "—"}</span> },
];

function VendorsView() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<VendorListItem>("vendors", "/vendors");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const cols = useColumnVisibility("vendors", columns);
  const scan = useOperationsScan();

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["vendors", "facets", filterParams],
    queryFn: () => api.get<VendorFacets>("/vendors/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  for (const [key, label] of [["status", "Status"], ["services", "Services"]] as const) {
    const values = url.getAll(key);
    if (values.length) {
      chips.push({ key, label, value: values.map((v) => (key === "services" ? serviceLabel(v) : titleCase(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
    }
  }
  const compliance = url.get("compliance");
  if (compliance) chips.push({ key: "compliance", label: "Compliance", value: COMPLIANCE_LABELS[compliance] ?? compliance, onRemove: () => url.set({ compliance: null }) });
  const tag = url.get("tag");
  if (tag) chips.push({ key: "tag", label: "Tag", value: tag, onRemove: () => url.set({ tag: null }) });

  const serviceValues = useMemo(() => {
    const extra = Object.keys(facets?.services ?? {}).filter((s) => !(VENDOR_SERVICES as readonly string[]).includes(s));
    return [...VENDOR_SERVICES, ...extra];
  }, [facets?.services]);

  const exportCsv = async () => {
    try {
      await api.download("/vendors/export", filterParams, "vendors.csv");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (r) => {
        const parts = [
          `${r.credentials_expiring} credentials expiring`,
          `${r.credentials_expired} expired`,
          `${r.policies_expiring} policies expiring`,
          `${r.certificates_lapsed} certificates lapsed`,
          `${r.protest_deadlines} protest deadlines`,
          `${r.payments_due} tax payments due`,
        ];
        toast.success(`Expiration scan complete · ${r.alerts_raised} new alerts`, { description: parts.join(" · ") });
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Service providers, their credentials, performance, spend and bid history."
        actions={
          <>
            {can("operations", "edit") && (
              <Button onClick={runScan} loading={scan.isPending}>
                {!scan.isPending && <RefreshCw />}
                Run expiration scan
              </Button>
            )}
            {can("operations", "export") && (
              <Button onClick={exportCsv}>
                <Download />
                Export
              </Button>
            )}
            {can("operations", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus />
                New vendor
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
                  <SavedViewsMenu module="operations" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search name, contact, email, area…" />
              <FacetFilter
                label="Status"
                options={VENDOR_STATUSES.map((v) => ({ value: v, label: titleCase(v), count: facets?.status?.[v] ?? 0 }))}
                selected={url.getAll("status")}
                onChange={(v) => url.set({ status: v })}
              />
              <FacetFilter
                label="Services"
                searchable
                options={serviceValues.map((v) => ({ value: v, label: serviceLabel(v), count: facets?.services?.[v] ?? 0 }))}
                selected={url.getAll("services")}
                onChange={(v) => url.set({ services: v })}
              />
              <FacetFilter
                label="Compliance"
                single
                options={[
                  { value: "compliant", label: "Compliant" },
                  { value: "non_compliant", label: "Blocked (non-compliant)" },
                ]}
                selected={compliance ? [compliance] : []}
                onChange={(v) => url.set({ compliance: v[0] ?? null })}
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
          rowHref={(v) => `/vendors/${v.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Wrench />}
              title={filtered ? "No vendors match these filters" : "No vendors yet"}
              description={
                filtered
                  ? "Try removing a filter or broadening your search."
                  : "Add the contractors and service providers who work on your assets, with their insurance and licenses."
              }
              action={
                can("operations", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New vendor
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <VendorFormSheet open={creating} onOpenChange={setCreating} onSaved={(v) => router.push(`/vendors/${v.id}`)} />
    </>
  );
}

export default function VendorsPage() {
  return (
    <Suspense>
      <VendorsView />
    </Suspense>
  );
}
