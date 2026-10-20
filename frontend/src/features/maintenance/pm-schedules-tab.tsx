"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Archive, CalendarClock, MoreHorizontal, Pencil, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { UserPicker, PropertyPicker } from "@/components/data/entity-picker";
import { FacetFilter, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";

import {
  CATEGORY_LABELS,
  PM_FREQUENCIES,
  WO_CATEGORIES,
  WO_PRIORITIES,
  useArchivePMSchedule,
  useMaintenanceSettings,
  useSavePMSchedule,
  useScanPM,
  type PMSchedule,
  type PMScheduleInput,
} from "./api";
import { VendorPicker, todayISO, toastApiError } from "./work-order-form";

function frequencyLabel(s: PMSchedule) {
  return s.frequency === "custom" ? `Every ${s.interval_days ?? "?"} days` : titleCase(s.frequency);
}

function NextService({ s }: { s: PMSchedule }) {
  const overdue = s.is_active && s.next_service_on < todayISO();
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className={cn(overdue ? "font-medium text-negative" : s.is_due ? "font-medium text-caution" : "text-ink-2")}>{formatDate(s.next_service_on)}</span>
      {overdue ? <Badge tone="red">Overdue</Badge> : s.is_due ? <Badge tone="amber">Due</Badge> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ form */

type FormState = Record<string, string>;

function toForm(s: PMSchedule | null | undefined, leadDays: number): FormState {
  if (!s) {
    return {
      system: "", title: "", description: "", category: "general", priority: "normal", frequency: "quarterly",
      interval_days: "", lead_days: String(leadDays), last_service_on: "", next_service_on: "", estimate_amount: "",
    };
  }
  return {
    system: s.system,
    title: s.title,
    description: s.description ?? "",
    category: s.category,
    priority: s.priority,
    frequency: s.frequency,
    interval_days: s.interval_days != null ? String(s.interval_days) : "",
    lead_days: String(s.lead_days),
    last_service_on: s.last_service_on ?? "",
    next_service_on: s.next_service_on ?? "",
    estimate_amount: s.estimate_amount != null ? String(s.estimate_amount) : "",
  };
}

function PMScheduleSheet({
  open,
  onOpenChange,
  schedule,
  propertyId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  schedule: PMSchedule | null;
  propertyId?: string;
}) {
  const { data: settings } = useMaintenanceSettings();
  const defaultLead = settings?.pm_default_lead_days ?? 14;
  const [form, setForm] = useState<FormState>(() => toForm(schedule, defaultLead));
  const [property, setProperty] = useState<string | null>(schedule?.property_id ?? propertyId ?? null);
  const [vendorId, setVendorId] = useState<string | null>(schedule?.default_vendor_id ?? null);
  const [assigneeId, setAssigneeId] = useState<string | null>(schedule?.default_assignee_id ?? null);
  const [active, setActive] = useState(schedule?.is_active ?? true);
  const save = useSavePMSchedule(schedule?.id);

  useEffect(() => {
    if (!open) return;
    setForm(toForm(schedule, defaultLead));
    setProperty(schedule?.property_id ?? propertyId ?? null);
    setVendorId(schedule?.default_vendor_id ?? null);
    setAssigneeId(schedule?.default_assignee_id ?? null);
    setActive(schedule?.is_active ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule]);

  const bind = (key: string) => ({
    id: `pm-${key}`,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const custom = form.frequency === "custom";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!property) return toast.error("Select a property");
    if (!form.system.trim() || !form.title.trim()) return toast.error("System and title are required");
    if (!form.next_service_on) return toast.error("Next service date is required");
    const interval = toNumber(form.interval_days);
    if (custom && (!interval || interval < 1)) return toast.error("Custom frequency requires an interval in days");
    const body: PMScheduleInput = {
      property_id: property,
      asset_id: schedule?.asset_id ?? null,
      system: form.system.trim(),
      title: form.title.trim(),
      description: form.description.trim() || null,
      category: form.category || "general",
      priority: form.priority || "normal",
      frequency: form.frequency,
      interval_days: custom ? Math.round(interval!) : null,
      lead_days: Math.max(0, Math.round(toNumber(form.lead_days) ?? defaultLead)),
      last_service_on: form.last_service_on || null,
      next_service_on: form.next_service_on,
      default_vendor_id: vendorId,
      default_assignee_id: assigneeId,
      estimate_amount: toNumber(form.estimate_amount),
      is_active: active,
    };
    save.mutate(body, {
      onSuccess: () => {
        toast.success(schedule ? "Schedule updated" : "Schedule created");
        onOpenChange(false);
      },
      onError: (err) => toastApiError(err),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={schedule ? "Edit maintenance schedule" : "New maintenance schedule"}
      description="A work order is generated when the next service date enters the lead window. Completing or cancelling it advances the schedule."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="pm-form" loading={save.isPending}>
            {schedule ? "Save changes" : "Create schedule"}
          </Button>
        </>
      }
    >
      <form id="pm-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        {!propertyId && (
          <Field label="Property" required className="col-span-2">
            <PropertyPicker value={property} onChange={(id) => setProperty(id)} />
          </Field>
        )}
        <Field label="System / asset" required htmlFor="pm-system">
          <Input {...bind("system")} placeholder="e.g. HVAC RTU-1" maxLength={120} />
        </Field>
        <Field label="Title" required htmlFor="pm-title">
          <Input {...bind("title")} placeholder="e.g. Quarterly filter change" maxLength={200} />
        </Field>
        <Field label="Description" htmlFor="pm-description" className="col-span-2">
          <Textarea {...bind("description")} rows={2} />
        </Field>
        <Field label="Category" htmlFor="pm-category">
          <Select {...bind("category")} options={WO_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? titleCase(c) }))} />
        </Field>
        <Field label="Priority" htmlFor="pm-priority">
          <Select {...bind("priority")} options={WO_PRIORITIES.map((p) => ({ value: p, label: titleCase(p) }))} />
        </Field>
        <Field label="Frequency" htmlFor="pm-frequency">
          <Select {...bind("frequency")} options={PM_FREQUENCIES.map((f) => ({ value: f, label: titleCase(f) }))} />
        </Field>
        <Field label="Interval (days)" htmlFor="pm-interval_days" required={custom} hint={custom ? "Required for a custom frequency" : "Used only for custom frequency"}>
          <Input {...bind("interval_days")} inputMode="numeric" disabled={!custom} />
        </Field>
        <Field label="Last service" htmlFor="pm-last_service_on">
          <Input type="date" {...bind("last_service_on")} />
        </Field>
        <Field label="Next service" required htmlFor="pm-next_service_on">
          <Input type="date" {...bind("next_service_on")} required />
        </Field>
        <Field label="Lead time (days)" htmlFor="pm-lead_days" hint="Generate the work order this many days ahead">
          <Input {...bind("lead_days")} inputMode="numeric" />
        </Field>
        <Field label="Estimate ($)" htmlFor="pm-estimate_amount">
          <Input {...bind("estimate_amount")} inputMode="decimal" />
        </Field>
        <Field label="Default vendor" hint="Assigned automatically when compliant" className="col-span-2">
          <VendorPicker value={vendorId} onChange={(id) => setVendorId(id)} />
        </Field>
        <Field label="Default staff assignee" hint="Used when no vendor is set" className="col-span-2">
          <UserPicker value={assigneeId} onChange={setAssigneeId} />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={active} onChange={setActive} />
          Active — generates recurring work orders
        </label>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ tab */

export function PMSchedulesTab({ propertyId }: { propertyId?: string }) {
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const [activeFilter, setActiveFilter] = useState<string[]>(["true"]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<string | null>("next_service_on");
  const [editing, setEditing] = useState<PMSchedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<PMSchedule | null>(null);
  const scan = useScanPM();
  const archive = useArchivePMSchedule();

  const params = { property_id: propertyId, q: q || undefined, active: activeFilter[0], page, page_size: pageSize, sort: sort ?? undefined };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["pm-schedules", "list", params],
    queryFn: () => api.get<Page<PMSchedule>>("/pm-schedules", params),
    placeholderData: keepPreviousData,
  });

  const runScan = () =>
    scan.mutate(propertyId, {
      onSuccess: (r) => toast.success(`${r.generated} work order${r.generated === 1 ? "" : "s"} generated`, { description: `${r.scanned} active schedule${r.scanned === 1 ? "" : "s"} checked` }),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const doArchive = () => {
    if (!archiving) return;
    archive.mutate(archiving.id, {
      onSuccess: () => {
        toast.success("Schedule archived");
        setArchiving(null);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const columns: Column<PMSchedule>[] = [
    {
      id: "system",
      header: "System",
      sortKey: "system",
      cell: (s) => <span className="whitespace-nowrap font-medium text-ink">{s.system}</span>,
    },
    {
      id: "title",
      header: "Task",
      sortKey: "title",
      cell: (s) => (
        <div className="min-w-[180px] max-w-[300px]">
          <p className="truncate text-ink">{s.title}</p>
          <p className="truncate text-xs text-ink-3">{CATEGORY_LABELS[s.category] ?? titleCase(s.category)}</p>
        </div>
      ),
    },
    ...(propertyId
      ? []
      : [{ id: "property", header: "Property", cell: (s: PMSchedule) => <span className="block max-w-[220px] truncate text-ink-2">{s.property_name ?? "—"}</span> }]),
    { id: "frequency", header: "Frequency", sortKey: "frequency", cell: (s) => <span className="whitespace-nowrap text-ink-2">{frequencyLabel(s)}</span> },
    { id: "last", header: "Last service", sortKey: "last_service_on", cell: (s) => <span className="whitespace-nowrap text-ink-2">{formatDate(s.last_service_on)}</span> },
    { id: "next", header: "Next service", sortKey: "next_service_on", cell: (s) => <NextService s={s} /> },
    { id: "vendor", header: "Default vendor", cell: (s) => <span className="block max-w-[180px] truncate text-ink-2">{s.vendor_name ?? "—"}</span> },
    { id: "estimate", header: "Estimate", align: "right", cell: (s) => formatCurrency(s.estimate_amount) },
    { id: "active", header: "Active", cell: (s) => <StatusBadge status={s.is_active ? "active" : "inactive"} /> },
    {
      id: "actions",
      header: "",
      align: "right",
      width: 48,
      cell: (s) =>
        can("maintenance", "edit") || can("maintenance", "delete") ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Schedule actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {can("maintenance", "edit") && (
                  <MenuItem icon={<Pencil />} onSelect={() => setEditing(s)}>
                    Edit schedule
                  </MenuItem>
                )}
                {can("maintenance", "delete") && (
                  <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(s)}>
                    Archive
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-ink-2">Recurring service by asset and system. Due schedules generate work orders automatically.</p>
          <p className="text-xs text-ink-3">Each scheduled occurrence produces at most one work order, so re-running generation never creates duplicates.</p>
        </div>
        <div className="flex gap-2">
          {can("maintenance", "create") && (
            <Button loading={scan.isPending} onClick={runScan}>
              <RefreshCw /> Generate due work orders
            </Button>
          )}
          {can("maintenance", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New schedule
            </Button>
          )}
        </div>
      </div>

      <Toolbar>
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search system or task…"
          shortcut={false}
          className="w-64"
        />
        <FacetFilter
          label="Status"
          single
          options={[
            { value: "true", label: "Active" },
            { value: "false", label: "Inactive" },
          ]}
          selected={activeFilter}
          onChange={(v) => {
            setActiveFilter(v);
            setPage(1);
          }}
        />
      </Toolbar>

      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          fetching={isFetching}
          sort={sort}
          onSortChange={setSort}
          dense
          onRowClick={can("maintenance", "edit") ? (s) => setEditing(s) : undefined}
          empty={
            <EmptyState
              icon={<CalendarClock />}
              title={q || activeFilter[0] === "false" ? "No schedules match" : "No maintenance schedules yet"}
              description="Add recurring service for HVAC, roof, life safety and other systems so work is never missed."
              action={
                can("maintenance", "create") ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus /> New schedule
                  </Button>
                ) : undefined
              }
            />
          }
        />
        <TableFooter
          page={page}
          pageSize={pageSize}
          total={data?.total ?? 0}
          onPage={setPage}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </Card>

      <PMScheduleSheet
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        schedule={editing}
        propertyId={propertyId}
      />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this schedule?"
        description="No further work orders will be generated. Existing work orders and service history are kept."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={doArchive}
      />
    </div>
  );
}
