"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, Plus, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, formatRelative } from "@/lib/utils";

import { categoryLabel, useServiceHistory, useWorkOrdersFor, type InspectionListItem, type WorkOrderListItem } from "./api";
import { PMSchedulesTab } from "./pm-schedules-tab";
import { MaintenanceBadge, WorkOrderFormSheet, isPastDue } from "./work-order-form";

const woColumns: Column<WorkOrderListItem>[] = [
  { id: "number", header: "#", align: "right", width: 56, cell: (w) => <span className="text-ink-3">{w.number}</span> },
  {
    id: "title",
    header: "Work order",
    cell: (w) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{w.title}</p>
        <p className="truncate text-xs text-ink-3">{[categoryLabel(w.category), w.system, w.location_detail].filter(Boolean).join(" · ")}</p>
      </div>
    ),
  },
  { id: "priority", header: "Priority", cell: (w) => <StatusBadge status={w.priority} /> },
  { id: "status", header: "Status", cell: (w) => <MaintenanceBadge value={w.status} /> },
  { id: "assignee", header: "Assignee", cell: (w) => <span className="block max-w-[160px] truncate text-ink-2">{w.vendor_name ?? w.assignee_name ?? "—"}</span> },
  { id: "actual", header: "Actual", align: "right", cell: (w) => formatCurrency(w.actual_cost) },
  {
    id: "due",
    header: "Due",
    cell: (w) => <span className={cn("whitespace-nowrap", isPastDue(w.due_on, w.status) ? "font-medium text-negative" : "text-ink-2")}>{formatDate(w.due_on)}</span>,
  },
  { id: "updated", header: "Updated", cell: (w) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(w.updated_at)}</span> },
];

const inspectionColumns: Column<InspectionListItem>[] = [
  { id: "template", header: "Inspection", cell: (i) => <span className="font-medium text-ink">{i.template_name ?? "Inspection"}</span> },
  { id: "status", header: "Status", cell: (i) => <MaintenanceBadge value={i.status} /> },
  { id: "scheduled", header: "Scheduled", cell: (i) => <span className="whitespace-nowrap text-ink-2">{formatDate(i.scheduled_on)}</span> },
  { id: "inspector", header: "Inspector", cell: (i) => <span className="text-ink-2">{i.inspector_name ?? "—"}</span> },
  { id: "score", header: "Score", align: "right", cell: (i) => formatPercent(i.score, 0) },
  {
    id: "findings",
    header: "Open / total findings",
    align: "right",
    cell: (i) => (
      <span className={i.open_finding_count ? "font-medium text-caution" : "text-ink-3"}>
        {formatNumber(i.open_finding_count)} / {formatNumber(i.finding_count)}
      </span>
    ),
  },
];

/** Service history for a property: work orders, recurring maintenance and inspections. */
export function PropertyMaintenanceTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const history = useServiceHistory({ property_id: propertyId });
  const workOrders = useWorkOrdersFor({ property_id: propertyId, sort: "-updated_at" });
  const inspections = useQuery({
    queryKey: ["inspections", "list", "property", propertyId],
    queryFn: () => api.get<Page<InspectionListItem>>("/inspections", { property_id: propertyId, page_size: 10, sort: "-scheduled_on" }),
  });

  const h = history.data;
  const pmDue = h?.pm_schedules.filter((s) => s.is_due).length ?? 0;
  const woTotal = workOrders.data?.total ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Service history for this property, preserved across every request, schedule and inspection.</p>
        {can("maintenance", "create") && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New work order
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open work orders" value={h ? formatNumber(h.open_count) : "—"} tone={h && h.open_count > 0 ? "caution" : "default"} />
        <StatCard label="Completed" value={h ? formatNumber(h.completed_count) : "—"} />
        <StatCard label="Total spend" value={h ? formatCurrency(h.total_cost) : "—"} hint="Actual cost of completed work" />
        <StatCard label="PM due now" value={h ? formatNumber(pmDue) : "—"} tone={pmDue > 0 ? "caution" : "default"} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Work orders"
          description={woTotal > 50 ? `Showing the 50 most recent of ${formatNumber(woTotal)}` : undefined}
          actions={
            <Link href={`/work-orders?property_id=${propertyId}`} className="text-xs font-medium text-accent hover:underline">
              Open in work orders
            </Link>
          }
        />
        <DataTable
          columns={woColumns}
          data={workOrders.data?.items}
          loading={workOrders.isLoading}
          dense
          rowHref={(w) => `/work-orders/${w.id}`}
          empty={<EmptyState icon={<Wrench />} title="No work orders yet" description="Requests from tenants, staff, inspections and preventive schedules appear here." />}
        />
      </Card>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Preventive maintenance</h3>
        <PMSchedulesTab propertyId={propertyId} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Recent inspections"
          actions={
            <Link href={`/inspections?property_id=${propertyId}`} className="text-xs font-medium text-accent hover:underline">
              All inspections
            </Link>
          }
        />
        <DataTable
          columns={inspectionColumns}
          data={inspections.data?.items}
          loading={inspections.isLoading}
          dense
          rowHref={(i) => `/inspections/${i.id}`}
          empty={<EmptyState icon={<ClipboardCheck />} title="No inspections yet" description="Start an inspection from the inspections page." />}
        />
      </Card>

      <WorkOrderFormSheet
        open={creating}
        onOpenChange={setCreating}
        defaults={{ property_id: propertyId }}
        onSaved={(wo) => router.push(`/work-orders/${wo.id}`)}
      />
    </div>
  );
}
