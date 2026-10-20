"use client";

import { useQuery } from "@tanstack/react-query";
import { HardHat, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, isOverdue, titleCase } from "@/lib/utils";

import { PROJECT_CATEGORIES, PROJECT_STATUSES, type ProjectListItem } from "@/features/operations/api";
import { ProjectFormSheet, ProjectStatusBadge, categoryLabel } from "@/features/operations/project-form";

interface ProjectFacets {
  status: Record<string, number>;
  category: Record<string, number>;
}

const MORE: MoreFilterField[] = [{ type: "range", label: "Current budget", minKey: "min_budget", maxKey: "max_budget", suffix: "$" }];
const CHIP_LABELS: Record<string, string> = { min_budget: "Min budget", max_budget: "Max budget" };

const columns: Column<ProjectListItem>[] = [
  {
    id: "project",
    header: "Project",
    sortKey: "name",
    cell: (p) => (
      <div className="min-w-[220px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{p.name}</p>
        <p className="truncate text-xs text-ink-3">{p.property_name ?? "—"}</p>
      </div>
    ),
  },
  { id: "category", header: "Category", hideable: true, cell: (p) => <span className="whitespace-nowrap text-ink-2">{categoryLabel(p.category)}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (p) => <ProjectStatusBadge status={p.status} /> },
  {
    id: "budget",
    header: "Budget",
    sortKey: "current_budget",
    align: "right",
    hideable: true,
    cell: (p) => (
      <div className="whitespace-nowrap">
        <p>{formatCurrency(p.current_budget)}</p>
        {Math.abs(p.current_budget - p.original_budget) > 0.005 && (
          <p className="text-xs text-ink-3">orig. {formatCurrency(p.original_budget)}</p>
        )}
      </div>
    ),
  },
  { id: "committed", header: "Committed", sortKey: "contract_amount", align: "right", hideable: true, cell: (p) => (p.committed ? formatCurrency(p.committed) : "—") },
  { id: "spent", header: "Spent", align: "right", hideable: true, cell: (p) => (p.spent ? formatCurrency(p.spent) : "—") },
  {
    id: "utilisation",
    header: "Utilisation",
    hideable: true,
    width: 120,
    cell: (p) => {
      const pct = p.current_budget > 0 ? (100 * p.spent) / p.current_budget : 0;
      return (
        <div className="flex items-center gap-2">
          <Progress value={pct} tone="accent" className="w-14" />
          <span className={cn("text-xs tabular", pct > 100 ? "text-negative" : "text-ink-3")}>{Math.round(pct)}%</span>
        </div>
      );
    },
  },
  { id: "contractor", header: "Contractor", hideable: true, cell: (p) => <span className="whitespace-nowrap text-ink-2">{p.contractor_name ?? "—"}</span> },
  {
    id: "target",
    header: "Target completion",
    sortKey: "target_completion_on",
    hideable: true,
    cell: (p) => {
      const late = !!p.target_completion_on && isOverdue(p.target_completion_on) && !["completed", "closed", "cancelled"].includes(p.status);
      return <span className={cn("whitespace-nowrap", late ? "font-medium text-negative" : "text-ink-2")}>{formatDate(p.target_completion_on)}</span>;
    },
  },
  {
    id: "cos",
    header: "Pending COs",
    align: "right",
    hideable: true,
    cell: (p) => (p.pending_change_orders > 0 ? <Badge tone="amber">{p.pending_change_orders} pending</Badge> : <span className="text-ink-3">—</span>),
  },
  { id: "manager", header: "Manager", hideable: true, defaultHidden: true, cell: (p) => <span className="whitespace-nowrap text-ink-2">{p.manager_name ?? "—"}</span> },
  { id: "start", header: "Start", sortKey: "start_on", hideable: true, defaultHidden: true, cell: (p) => <span className="whitespace-nowrap text-ink-2">{formatDate(p.start_on)}</span> },
];

function ProjectsView() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<ProjectListItem>("capital-projects", "/capital-projects");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const cols = useColumnVisibility("capital-projects", columns);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["capital-projects", "facets", filterParams],
    queryFn: () => api.get<ProjectFacets>("/capital-projects/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: formatCurrency(Number(url.get(k))), onRemove: () => url.set({ [k]: null }) }));
  for (const [key, label] of [["status", "Status"], ["category", "Category"]] as const) {
    const values = url.getAll(key);
    if (values.length) {
      chips.unshift({ key, label, value: values.map((v) => (key === "category" ? categoryLabel(v) : titleCase(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
    }
  }
  const filtered = chips.length > 0 || !!url.get("q");

  return (
    <>
      <PageHeader
        title="Capital projects"
        description="Budget, approval, bidding, execution and closeout for capital work on owned assets."
        actions={
          can("operations", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New project
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
                  <SavedViewsMenu module="operations" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search project, scope, property…" />
              <FacetFilter
                label="Status"
                options={PROJECT_STATUSES.map((v) => ({ value: v, label: titleCase(v), count: facets?.status?.[v] ?? 0 }))}
                selected={url.getAll("status")}
                onChange={(v) => url.set({ status: v })}
              />
              <FacetFilter
                label="Category"
                options={PROJECT_CATEGORIES.map((v) => ({ value: v, label: categoryLabel(v), count: facets?.category?.[v] ?? 0 }))}
                selected={url.getAll("category")}
                onChange={(v) => url.set({ category: v })}
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
          rowHref={(p) => `/capital-projects/${p.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<HardHat />}
              title={filtered ? "No projects match these filters" : "No capital projects yet"}
              description={
                filtered ? "Try removing a filter or broadening your search." : "Create a project with its scope and original budget, then submit it for approval."
              }
              action={
                can("operations", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New project
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <ProjectFormSheet open={creating} onOpenChange={setCreating} onSaved={(p) => router.push(`/capital-projects/${p.id}`)} />
    </>
  );
}

export default function CapitalProjectsPage() {
  return (
    <Suspense>
      <ProjectsView />
    </Suspense>
  );
}
