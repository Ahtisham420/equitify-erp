"use client";

import { useQuery } from "@tanstack/react-query";
import { Calculator, Lock, Plus } from "lucide-react";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/misc";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatRelative, titleCase } from "@/lib/utils";

import { TEMPLATE_LABELS, formatOutput, type UwListItem } from "./api";
import { UwModelCreateSheet } from "./model-form";

const columns: Column<UwListItem>[] = [
  {
    id: "name",
    header: "Model",
    cell: (m) => (
      <span className="flex items-center gap-1.5 font-medium text-ink">
        {m.name}
        {m.is_locked && <Lock className="size-3.5 text-ink-3" aria-label="Locked" />}
      </span>
    ),
  },
  { id: "version", header: "Version", align: "right", cell: (m) => `v${m.version}` },
  { id: "template", header: "Template", cell: (m) => <span className="text-ink-2">{TEMPLATE_LABELS[m.template] ?? titleCase(m.template)}</span> },
  { id: "status", header: "Status", cell: (m) => <StatusBadge status={m.status} /> },
  { id: "price", header: "Price", align: "right", cell: (m) => formatCurrency(m.purchase_price, { compact: true }) },
  { id: "cap", header: "Going-in cap", align: "right", cell: (m) => formatOutput("going_in_cap", m.going_in_cap) },
  { id: "irr", header: "Levered IRR", align: "right", cell: (m) => formatOutput("irr", m.irr) },
  { id: "sources", header: "Sources", cell: (m) => (m.unsourced_count ? <Badge tone="amber">{m.unsourced_count} unsourced</Badge> : <Badge tone="green">Sourced</Badge>) },
  { id: "updated", header: "Updated", cell: (m) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(m.updated_at)}</span> },
];

/** Property detail tab: underwriting models (latest version per model, or every version) for this property. */
export function PropertyUnderwritingTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [all, setAll] = useState(false);
  const params = { property_id: propertyId, page_size: 100, sort: "-updated_at", latest_only: all ? false : undefined };
  const { data, isLoading } = useQuery({
    queryKey: ["uw-models", "list", params],
    queryFn: () => api.get<Page<UwListItem>>("/uw-models", params),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-4">
          <p className="text-sm text-ink-2">Versioned models for this property. The approved version is locked and feeds offers.</p>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={all} onChange={setAll} />
            All versions
          </label>
        </div>
        {can("underwriting", "create") && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New model
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          dense
          rowHref={(m) => `/underwriting/${m.id}`}
          rowClassName={(m) => (m.status === "superseded" || m.status === "rejected" ? "bg-subtle/40" : undefined)}
          empty={
            <EmptyState
              icon={<Calculator />}
              title="No underwriting yet"
              description="Create a model from a property-type template."
              action={can("underwriting", "create") ? <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New model</Button> : undefined}
            />
          }
        />
      </Card>
      <UwModelCreateSheet open={creating} onOpenChange={setCreating} propertyId={propertyId} />
    </div>
  );
}
