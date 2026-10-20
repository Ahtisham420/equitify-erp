"use client";

import { Download, Plus, UserPlus, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { UserPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatRelative, titleCase, toNumber } from "@/lib/utils";

import {
  APPROVAL_STATES,
  CATEGORY_LABELS,
  RESPONSIBILITY,
  SEVERITIES,
  WO_CATEGORIES,
  WO_PRIORITIES,
  WO_SOURCES,
  WO_STATUSES,
  categoryLabel,
  useBulkWorkOrders,
  useMaintenanceSettings,
  useSaveMaintenanceSettings,
  useWorkOrderFacets,
  type WorkOrderListItem,
} from "@/features/maintenance/api";
import { PMSchedulesTab } from "@/features/maintenance/pm-schedules-tab";
import { MaintenanceBadge, WorkOrderFormSheet, isPastDue } from "@/features/maintenance/work-order-form";

const MORE: MoreFilterField[] = [
  { type: "date-range", label: "Due date", minKey: "due_from", maxKey: "due_to" },
  { type: "range", label: "Cost (actual, else estimate)", minKey: "min_cost", maxKey: "max_cost", suffix: "$" },
  { type: "select", label: "Overdue", key: "overdue", options: [{ value: "true", label: "Yes" }] },
  { type: "select", label: "Tenant responsibility", key: "tenant_responsibility", options: RESPONSIBILITY.map((r) => ({ value: r, label: titleCase(r) })) },
];

const CHIP_LABELS: Record<string, string> = {
  due_from: "Due after", due_to: "Due before", min_cost: "Min cost", max_cost: "Max cost", overdue: "Overdue", tenant_responsibility: "Responsibility",
};

const FACETS: { key: "status" | "priority" | "category" | "source" | "approval_status"; label: string; values: readonly string[]; fmt: (v: string) => string }[] = [
  { key: "status", label: "Status", values: WO_STATUSES, fmt: titleCase },
  { key: "priority", label: "Priority", values: WO_PRIORITIES, fmt: titleCase },
  { key: "category", label: "Category", values: WO_CATEGORIES, fmt: (v) => CATEGORY_LABELS[v] ?? titleCase(v) },
  { key: "source", label: "Source", values: WO_SOURCES, fmt: titleCase },
  { key: "approval_status", label: "Approval", values: APPROVAL_STATES, fmt: titleCase },
];

const columns: Column<WorkOrderListItem>[] = [
  { id: "number", header: "#", sortKey: "number", align: "right", width: 64, cell: (w) => <span className="text-ink-3">{w.number}</span> },
  {
    id: "title",
    header: "Work order",
    sortKey: "title",
    cell: (w) => (
      <div className="min-w-[220px] max-w-[340px]">
        <p className="truncate font-medium text-ink">{w.title}</p>
        <p className="truncate text-xs text-ink-3">{[w.property_name, w.system].filter(Boolean).join(" · ") || "—"}</p>
      </div>
    ),
  },
  { id: "category", header: "Category", sortKey: "category", hideable: true, cell: (w) => <span className="whitespace-nowrap text-ink-2">{categoryLabel(w.category)}</span> },
  { id: "priority", header: "Priority", sortKey: "priority", hideable: true, cell: (w) => <StatusBadge status={w.priority} /> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (w) => <MaintenanceBadge value={w.status} /> },
  { id: "source", header: "Source", hideable: true, defaultHidden: true, cell: (w) => <span className="text-ink-2">{titleCase(w.source)}</span> },
  {
    id: "assignee",
    header: "Assignee",
    hideable: true,
    cell: (w) => {
      const name = w.assignee_type === "vendor" ? w.vendor_name : w.assignee_name;
      return name ? (
        <div className="max-w-[180px]">
          <p className="truncate text-ink-2">{name}</p>
          <p className="text-2xs text-ink-3">{w.assignee_type === "vendor" ? "Vendor" : "Staff"}</p>
        </div>
      ) : (
        <span className="text-ink-3">Unassigned</span>
      );
    },
  },
  { id: "estimate", header: "Estimate", sortKey: "estimate_amount", align: "right", hideable: true, cell: (w) => formatCurrency(w.estimate_amount) },
  { id: "actual", header: "Actual", sortKey: "actual_cost", align: "right", hideable: true, cell: (w) => formatCurrency(w.actual_cost) },
  {
    id: "approval",
    header: "Approval",
    hideable: true,
    cell: (w) =>
      w.approval_status === "pending" ? (
        <Badge tone="amber" dot>
          Pending
        </Badge>
      ) : w.approval_status === "not_required" ? (
        <span className="text-xs text-ink-3">Not required</span>
      ) : (
        <StatusBadge status={w.approval_status} />
      ),
  },
  {
    id: "responsibility",
    header: "Responsibility",
    hideable: true,
    defaultHidden: true,
    cell: (w) => <MaintenanceBadge value={w.tenant_responsibility} />,
  },
  {
    id: "due",
    header: "Due",
    sortKey: "due_on",
    hideable: true,
    cell: (w) => {
      const overdue = isPastDue(w.due_on, w.status);
      return <span className={cn("whitespace-nowrap", overdue ? "font-medium text-negative" : "text-ink-2")}>{formatDate(w.due_on)}</span>;
    },
  },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (w) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(w.updated_at)}</span> },
];

/* ------------------------------------------------------------------ work orders list */

function WorkOrdersList({ onCreate }: { onCreate: () => void }) {
  const { can } = useAuth();
  const list = useListQuery<WorkOrderListItem>("work-orders", "/work-orders");
  const { url } = list;
  const [selected, setSelected] = useState<string[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignee, setAssignee] = useState<string | null>(null);
  const cols = useColumnVisibility("work-orders", columns);
  const bulk = useBulkWorkOrders();

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useWorkOrderFacets(filterParams);

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => {
      const v = url.get(k)!;
      const value = k === "overdue" ? "Yes" : k === "tenant_responsibility" ? titleCase(v) : k.startsWith("due_") ? formatDate(v) : v;
      return { key: k, label, value, onRemove: () => url.set({ [k]: null }) };
    });
  for (const f of [...FACETS].reverse()) {
    const values = url.getAll(f.key);
    if (values.length) chips.unshift({ key: f.key, label: f.label, value: values.map(f.fmt).join(", "), onRemove: () => url.set({ [f.key]: null }) });
  }
  if (url.get("property_id")) {
    chips.unshift({ key: "property_id", label: "Property", value: list.data?.items[0]?.property_name ?? "Selected property", onRemove: () => url.set({ property_id: null }) });
  }
  const filtered = chips.length > 0 || !!url.get("q");

  const runBulk = (body: { priority?: string; assigned_user_id?: string }) =>
    bulk.mutate(
      { ids: selected, ...body },
      {
        onSuccess: (r) => {
          toast.success(`${r.updated} work order${r.updated === 1 ? "" : "s"} updated`, body.assigned_user_id ? { description: "Only open or assigned work orders can be reassigned." } : undefined);
          setSelected([]);
          setAssignOpen(false);
          setAssignee(null);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="maintenance" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search title, system, property, requester…" />
              {FACETS.map((f) => (
                <FacetFilter
                  key={f.key}
                  label={f.label}
                  options={f.values.map((v) => ({ value: v, label: f.fmt(v), count: facets?.[f.key]?.[v] ?? 0 }))}
                  selected={url.getAll(f.key)}
                  onChange={(v) => url.set({ [f.key]: v })}
                />
              ))}
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
          selectable={can("maintenance", "edit")}
          selected={selected}
          onSelectedChange={setSelected}
          rowHref={(w) => `/work-orders/${w.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<Wrench />}
              title={filtered ? "No work orders match these filters" : "No work orders yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Log a tenant or staff request, or generate preventive work from maintenance schedules."}
              action={
                can("maintenance", "create") && !filtered ? (
                  <Button variant="primary" onClick={onCreate}>
                    <Plus /> New work order
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
            <BulkButton>Set priority</BulkButton>
          </MenuTrigger>
          <MenuContent align="center">
            {WO_PRIORITIES.map((p) => (
              <MenuItem key={p} onSelect={() => runBulk({ priority: p })}>
                <StatusBadge status={p} />
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <BulkButton icon={<UserPlus />} onClick={() => setAssignOpen(true)}>
          Assign staff
        </BulkButton>
      </BulkBar>

      <Dialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title={`Assign ${selected.length} work order${selected.length === 1 ? "" : "s"}`}
        description="Open and assigned work orders move to the selected staff member, who receives a task for each."
        footer={
          <>
            <Button onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!assignee} loading={bulk.isPending} onClick={() => assignee && runBulk({ assigned_user_id: assignee })}>
              Assign
            </Button>
          </>
        }
      >
        <Field label="Staff member">
          <UserPicker value={assignee} onChange={setAssignee} />
        </Field>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ settings */

function SettingsPanel() {
  const { data, isLoading } = useMaintenanceSettings();
  const save = useSaveMaintenanceSettings();
  const [form, setForm] = useState({ approval_threshold: "", finding_auto_wo_severity: "high", pm_default_lead_days: "" });

  useEffect(() => {
    if (data) {
      setForm({
        approval_threshold: String(data.approval_threshold),
        finding_auto_wo_severity: data.finding_auto_wo_severity,
        pm_default_lead_days: String(data.pm_default_lead_days),
      });
    }
  }, [data]);

  if (isLoading) return <Skeleton className="h-64 w-full max-w-2xl" />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const threshold = toNumber(form.approval_threshold);
    const lead = toNumber(form.pm_default_lead_days);
    if (threshold === null || threshold < 0) return toast.error("Enter an approval threshold of 0 or more");
    if (lead === null || lead < 0 || lead > 180) return toast.error("Lead days must be between 0 and 180");
    save.mutate(
      { approval_threshold: threshold, finding_auto_wo_severity: form.finding_auto_wo_severity, pm_default_lead_days: Math.round(lead) },
      { onSuccess: () => toast.success("Maintenance settings saved"), onError: (err) => toast.error(errorMessage(err)) },
    );
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader title="Maintenance settings" description="Changes apply to new estimates, findings and schedules. Every change is audited." />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Cost approval threshold ($)"
            htmlFor="set-threshold"
            hint="Estimates above this amount need maintenance approval before work can start."
          >
            <Input id="set-threshold" inputMode="decimal" value={form.approval_threshold} onChange={(e) => setForm((f) => ({ ...f, approval_threshold: e.target.value }))} className="max-w-xs" />
          </Field>
          <Field
            label="Auto-create work orders for findings at or above"
            htmlFor="set-severity"
            hint="Inspection deficiencies at this severity or higher get a linked work order automatically."
          >
            <Select
              id="set-severity"
              value={form.finding_auto_wo_severity}
              onChange={(e) => setForm((f) => ({ ...f, finding_auto_wo_severity: e.target.value }))}
              options={SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))}
              className="max-w-xs"
            />
          </Field>
          <Field label="Default PM lead time (days)" htmlFor="set-lead" hint="Pre-filled on new maintenance schedules.">
            <Input id="set-lead" inputMode="numeric" value={form.pm_default_lead_days} onChange={(e) => setForm((f) => ({ ...f, pm_default_lead_days: e.target.value }))} className="max-w-xs" />
          </Field>
          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" type="submit" loading={save.isPending}>
              Save settings
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

function WorkOrdersView() {
  const { can } = useAuth();
  const router = useRouter();
  const url = useUrlState();
  const [creating, setCreating] = useState(false);
  const canSettings = can("maintenance", "approve");
  const requested = url.get("tab") ?? "list";
  const tab = requested === "settings" && !canSettings ? "list" : requested;

  const exportCsv = async () => {
    const { page: _p, page_size: _s, tab: _t, ...params } = url.params;
    try {
      await api.download("/work-orders/export", params, "work-orders.csv");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Work orders"
        description="Service requests, preventive maintenance and completion accountability across the portfolio."
        actions={
          <>
            {can("maintenance", "export") && tab === "list" && (
              <Button onClick={exportCsv}>
                <Download />
                Export
              </Button>
            )}
            {can("maintenance", "create") && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus />
                New work order
              </Button>
            )}
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "list" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "list", label: "Work orders" },
            { value: "pm", label: "Preventive maintenance" },
            ...(canSettings ? [{ value: "settings", label: "Settings" }] : []),
          ]}
        />
        <TabPanel value="list">
          <WorkOrdersList onCreate={() => setCreating(true)} />
        </TabPanel>
        <TabPanel value="pm">
          <PMSchedulesTab />
        </TabPanel>
        {canSettings && (
          <TabPanel value="settings">
            <SettingsPanel />
          </TabPanel>
        )}
      </Tabs>

      <WorkOrderFormSheet open={creating} onOpenChange={setCreating} onSaved={(wo) => router.push(`/work-orders/${wo.id}`)} />
    </>
  );
}

export default function WorkOrdersPage() {
  return (
    <Suspense>
      <WorkOrdersView />
    </Suspense>
  );
}
