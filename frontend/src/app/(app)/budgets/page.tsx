"use client";

import { useQuery } from "@tanstack/react-query";
import { Calculator, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { PropertyPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";

import { BUDGET_STATUSES, useCreateBudget, type BudgetListItem } from "@/features/operations/api";
import { OpsStatusBadge } from "@/features/operations/insurance-tabs";

const columns: Column<BudgetListItem>[] = [
  {
    id: "name",
    header: "Budget",
    sortKey: "name",
    cell: (b) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{b.name}</p>
        <p className="truncate text-xs text-ink-3">{b.property_name ?? "—"}</p>
      </div>
    ),
  },
  { id: "property", header: "Property", hideable: true, defaultHidden: true, cell: (b) => <span className="text-ink-2">{b.property_name ?? "—"}</span> },
  { id: "fy", header: "FY", sortKey: "fiscal_year", cell: (b) => <span className="tabular text-ink-2">{b.fiscal_year}</span> },
  {
    id: "version",
    header: "Version",
    sortKey: "version",
    cell: (b) => (
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="tabular text-ink-2">v{b.version}</span>
        {b.kind === "reforecast" && <Badge tone="sky">Reforecast</Badge>}
      </span>
    ),
  },
  { id: "status", header: "Status", sortKey: "status", cell: (b) => <OpsStatusBadge status={b.status} /> },
  { id: "income", header: "Income", align: "right", hideable: true, cell: (b) => formatCurrency(b.total_income) },
  { id: "expense", header: "Expense", align: "right", hideable: true, cell: (b) => formatCurrency(b.total_expense) },
  { id: "noi", header: "NOI", align: "right", hideable: true, cell: (b) => <span className={cn("font-medium", b.noi < 0 ? "text-negative" : "text-ink")}>{formatCurrency(b.noi)}</span> },
  { id: "capex", header: "Capex", align: "right", hideable: true, cell: (b) => formatCurrency(b.total_capex) },
  { id: "approved", header: "Approved", hideable: true, cell: (b) => <span className="whitespace-nowrap text-xs text-ink-3">{b.approved_at ? formatDate(b.approved_at) : "—"}</span> },
];

function NewBudgetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const create = useCreateBudget();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [year, setYear] = useState("");
  const [name, setName] = useState("");
  const [loadPrior, setLoadPrior] = useState(true);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPropertyId(null);
      setYear(String(new Date().getFullYear() + 1));
      setName("");
      setLoadPrior(true);
      setConflict(null);
    }
  }, [open]);

  const fy = toNumber(year);
  const submit = () => {
    if (!propertyId || fy === null) return;
    setConflict(null);
    create.mutate(
      { property_id: propertyId, fiscal_year: fy, name: name.trim() || null, load_prior_actuals: loadPrior },
      {
        onSuccess: (b) => {
          toast.success("Budget created");
          onOpenChange(false);
          router.push(`/budgets/${b.id}`);
        },
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409) setConflict(e.message);
          else toast.error(errorMessage(e));
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New operating budget"
      description="One budget per property and fiscal year; later changes are made as new versions."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!propertyId || fy === null} loading={create.isPending} onClick={submit}>
            Create budget
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {conflict && <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm text-caution">{conflict}</div>}
        <Field label="Property" required>
          <PropertyPicker value={propertyId} onChange={(id) => setPropertyId(id)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Fiscal year" required>
            <Input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Name" hint="Optional" className="col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to property and year" />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm text-ink-2">
          <Checkbox checked={loadPrior} onChange={setLoadPrior} className="mt-0.5" />
          <span>
            Start from prior-year actuals
            <span className="block text-xs text-ink-3">Seeds each account and month from the asset financials for the previous year, when available.</span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}

function BudgetsView() {
  const { can } = useAuth();
  const list = useListQuery<BudgetListItem>("budgets", "/budgets");
  const { url } = list;
  const cols = useColumnVisibility("budgets", columns);
  const [creating, setCreating] = useState(false);

  const { page: _p, page_size: _s, sort: _o, ...filterParams } = url.params;
  const { data: facets } = useQuery({
    queryKey: ["budgets", "facets", filterParams],
    queryFn: () => api.get<{ status: Record<string, number>; fiscal_year: Record<string, number> }>("/budgets/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  if (url.getAll("status").length)
    chips.push({ key: "status", label: "Status", value: url.getAll("status").map((s) => titleCase(s)).join(", "), onRemove: () => url.set({ status: null }) });
  if (url.getAll("fiscal_year").length)
    chips.push({ key: "fiscal_year", label: "Fiscal year", value: url.getAll("fiscal_year").join(", "), onRemove: () => url.set({ fiscal_year: null }) });
  if (url.get("current_only") === "true") chips.push({ key: "current_only", label: "Versions", value: "Current only", onRemove: () => url.set({ current_only: null }) });
  const filtered = chips.length > 0 || !!url.get("q");

  const years = Object.entries(facets?.fiscal_year ?? {})
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([v, c]) => ({ value: v, label: v, count: c }));
  for (const y of url.getAll("fiscal_year")) if (!years.some((o) => o.value === y)) years.push({ value: y, label: y, count: 0 });

  const newButton = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus /> New budget
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Annual operating budgets by account and month, with prior actuals, reforecasts, approval and variance."
        actions={can("operations", "create") ? newButton : undefined}
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
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search budget or property…" />
              <FacetFilter
                label="Status"
                options={BUDGET_STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status?.[s] ?? 0 }))}
                selected={url.getAll("status")}
                onChange={(v) => url.set({ status: v })}
              />
              <FacetFilter label="Fiscal year" options={years} selected={url.getAll("fiscal_year")} onChange={(v) => url.set({ fiscal_year: v })} />
              <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-sm text-ink-2 shadow-card hover:bg-subtle">
                <Checkbox checked={url.get("current_only") === "true"} onChange={(v) => url.set({ current_only: v ? "true" : null })} />
                Current versions only
              </label>
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
          rowHref={(b) => `/budgets/${b.id}`}
          hidden={cols.hidden}
          rowClassName={(b) => (b.status === "superseded" ? "opacity-70" : undefined)}
          empty={
            <EmptyState
              icon={<Calculator />}
              title={filtered ? "No budgets match these filters" : "No budgets yet"}
              description={filtered ? "Try removing a filter." : "Create an annual operating budget for a property, optionally seeded from prior-year actuals."}
              action={!filtered && can("operations", "create") ? newButton : undefined}
            />
          }
        />
      </ListCard>
      <NewBudgetDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function BudgetsPage() {
  return (
    <Suspense>
      <BudgetsView />
    </Suspense>
  );
}
