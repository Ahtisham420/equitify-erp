"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import { INSPECTION_STATUSES, useCreateInspection, useInspectionTemplates, type InspectionListItem } from "@/features/maintenance/api";
import { InspectionTemplatesTab } from "@/features/maintenance/inspection-templates-tab";
import { MaintenanceBadge, todayISO, toastApiError } from "@/features/maintenance/work-order-form";
import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

const MORE: MoreFilterField[] = [{ type: "date-range", label: "Scheduled date", minKey: "scheduled_from", maxKey: "scheduled_to" }];

const CHIP_LABELS: Record<string, string> = { scheduled_from: "Scheduled after", scheduled_to: "Scheduled before" };

const columns: Column<InspectionListItem>[] = [
  {
    id: "property",
    header: "Property",
    cell: (i) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{i.property_name ?? "—"}</p>
        <p className="truncate text-xs text-ink-3">{i.property_type ? PROPERTY_TYPE_LABELS[i.property_type] ?? titleCase(i.property_type) : "—"}</p>
      </div>
    ),
  },
  { id: "template", header: "Template", hideable: true, cell: (i) => <span className="block max-w-[220px] truncate text-ink-2">{i.template_name ?? "—"}</span> },
  { id: "inspector", header: "Inspector", hideable: true, cell: (i) => <span className="whitespace-nowrap text-ink-2">{i.inspector_name ?? "—"}</span> },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (i) => <MaintenanceBadge value={i.status} /> },
  { id: "scheduled", header: "Scheduled", sortKey: "scheduled_on", hideable: true, cell: (i) => <span className="whitespace-nowrap text-ink-2">{formatDate(i.scheduled_on)}</span> },
  {
    id: "score",
    header: "Score",
    sortKey: "score",
    align: "right",
    hideable: true,
    cell: (i) => <span className={cn(i.score != null && i.score < 70 ? "font-medium text-negative" : i.score != null && i.score < 90 ? "text-caution" : "")}>{formatPercent(i.score, 0)}</span>,
  },
  {
    id: "findings",
    header: "Findings (open / total)",
    align: "right",
    hideable: true,
    cell: (i) => (
      <span className={i.open_finding_count ? "font-medium text-caution" : "text-ink-3"}>
        {formatNumber(i.open_finding_count)} / {formatNumber(i.finding_count)}
      </span>
    ),
  },
  { id: "completed", header: "Completed", sortKey: "completed_at", hideable: true, defaultHidden: true, cell: (i) => <span className="whitespace-nowrap text-ink-2">{formatDate(i.completed_at)}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (i) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(i.updated_at)}</span> },
];

/* ------------------------------------------------------------------ new inspection */

function NewInspectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [inspectorId, setInspectorId] = useState<string | null>(user?.id ?? null);
  const [scheduledOn, setScheduledOn] = useState(todayISO());
  const create = useCreateInspection();

  useEffect(() => {
    if (!open) return;
    setPropertyId(null);
    setTemplateId("");
    setInspectorId(user?.id ?? null);
    setScheduledOn(todayISO());
  }, [open, user?.id]);

  const property = useQuery({
    queryKey: ["properties", propertyId, "type"],
    queryFn: () => api.get<{ id: string; property_type: string }>(`/properties/${propertyId}`),
    enabled: !!propertyId,
    staleTime: 5 * 60_000,
  });
  const propertyType = property.data?.property_type ?? null;
  const templates = useInspectionTemplates({ property_type: propertyType, active: true });
  const options = useMemo(() => (propertyId && propertyType ? templates.data ?? [] : []), [propertyId, propertyType, templates.data]);

  useEffect(() => {
    if (templateId && !options.some((t) => t.id === templateId)) setTemplateId("");
    if (!templateId && options.length === 1) setTemplateId(options[0].id);
  }, [options, templateId]);

  const submit = () => {
    if (!propertyId || !templateId) return;
    create.mutate(
      { property_id: propertyId, template_id: templateId, inspector_id: inspectorId, scheduled_on: scheduledOn || null },
      {
        onSuccess: (insp) => {
          toast.success("Inspection scheduled");
          onOpenChange(false);
          router.push(`/inspections/${insp.id}`);
        },
        onError: (e) => toastApiError(e),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New inspection"
      description="Templates are offered for the property's type. The checklist is snapshotted when the inspection is created."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!propertyId || !templateId} loading={create.isPending} onClick={submit}>
            Create inspection
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Property" required>
          <PropertyPicker value={propertyId} onChange={(id) => setPropertyId(id)} />
        </Field>
        <Field
          label="Template"
          required
          hint={
            propertyId && propertyType
              ? `Showing templates for ${PROPERTY_TYPE_LABELS[propertyType] ?? titleCase(propertyType)} and any type`
              : "Select a property first"
          }
        >
          <Select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={!propertyId || property.isLoading || templates.isLoading}
            placeholder={propertyId && !property.isLoading && options.length === 0 && !templates.isLoading ? "No active templates for this type" : "Select template"}
            options={options.map((t) => ({
              value: t.id,
              label: `${t.name} · v${t.version} · ${t.item_count} items${t.property_type ? "" : " · any type"}`,
            }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Inspector">
            <UserPicker value={inspectorId} onChange={setInspectorId} />
          </Field>
          <Field label="Scheduled date">
            <Input type="date" value={scheduledOn} onChange={(e) => setScheduledOn(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ list */

function InspectionsList({ onCreate }: { onCreate: () => void }) {
  const { can } = useAuth();
  const list = useListQuery<InspectionListItem>("inspections", "/inspections");
  const { url } = list;
  const cols = useColumnVisibility("inspections", columns);

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["inspections", "facets", filterParams],
    queryFn: () => api.get<{ status: Record<string, number> }>("/inspections/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({ key: k, label, value: formatDate(url.get(k)), onRemove: () => url.set({ [k]: null }) }));
  const statuses = url.getAll("status");
  if (statuses.length) chips.unshift({ key: "status", label: "Status", value: statuses.map((s) => titleCase(s)).join(", "), onRemove: () => url.set({ status: null }) });
  if (url.get("property_id")) {
    chips.unshift({ key: "property_id", label: "Property", value: list.data?.items[0]?.property_name ?? "Selected property", onRemove: () => url.set({ property_id: null }) });
  }
  const filtered = chips.length > 0 || !!url.get("q");

  return (
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
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search property, template, summary…" />
            <FacetFilter
              label="Status"
              options={INSPECTION_STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status?.[s] ?? 0 }))}
              selected={statuses}
              onChange={(v) => url.set({ status: v })}
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
        rowHref={(i) => `/inspections/${i.id}`}
        hidden={cols.hidden}
        empty={
          <EmptyState
            icon={<ClipboardCheck />}
            title={filtered ? "No inspections match these filters" : "No inspections yet"}
            description={filtered ? "Try removing a filter or broadening your search." : "Schedule a field inspection from a template for the property type."}
            action={
              can("maintenance", "create") && !filtered ? (
                <Button variant="primary" onClick={onCreate}>
                  <Plus /> New inspection
                </Button>
              ) : undefined
            }
          />
        }
      />
    </ListCard>
  );
}

function InspectionsView() {
  const { can } = useAuth();
  const url = useUrlState();
  const [creating, setCreating] = useState(false);
  const tab = url.get("tab") ?? "list";

  return (
    <>
      <PageHeader
        title="Inspections"
        description="Mobile field inspections by property type, with geotagged deficiencies that turn into work orders."
        actions={
          can("maintenance", "create") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New inspection
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "list" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "list", label: "Inspections" },
            { value: "templates", label: "Templates" },
          ]}
        />
        <TabPanel value="list">
          <InspectionsList onCreate={() => setCreating(true)} />
        </TabPanel>
        <TabPanel value="templates">
          <InspectionTemplatesTab />
        </TabPanel>
      </Tabs>
      <NewInspectionDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function InspectionsPage() {
  return (
    <Suspense>
      <InspectionsView />
    </Suspense>
  );
}
