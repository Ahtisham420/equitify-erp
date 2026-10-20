"use client";

import { useQuery } from "@tanstack/react-query";
import { GitBranch, Plus } from "lucide-react";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatRelative, isOverdue } from "@/lib/utils";

import { DEAD_REASON_LABELS, stageLabel, type OpportunityListItem } from "./api";
import { OpportunityCreateSheet } from "./opportunity-form";

const columns: Column<OpportunityListItem>[] = [
  { id: "title", header: "Opportunity", cell: (o) => <span className="font-medium text-ink">{o.title}</span> },
  {
    id: "stage",
    header: "Stage",
    cell: (o) => (
      <div className="flex items-center gap-1.5">
        <StatusBadge status={o.stage} label={stageLabel(o.stage)} />
        {o.stage === "dead" && o.dead_reason && <span className="text-xs text-ink-3">{DEAD_REASON_LABELS[o.dead_reason]}</span>}
      </div>
    ),
  },
  { id: "age", header: "In stage", align: "right", cell: (o) => <span className={cn(o.stalled && "font-medium text-caution")}>{formatNumber(Math.floor(o.stage_age_days))}d</span> },
  { id: "value", header: "Value", align: "right", cell: (o) => formatCurrency(o.value, { compact: true }) },
  {
    id: "next",
    header: "Next action",
    cell: (o) =>
      o.next_action_at ? (
        <span className={cn("text-xs", isOverdue(o.next_action_at) ? "font-medium text-negative" : "text-ink-2")}>
          {o.next_action ? `${o.next_action} · ` : ""}
          {formatDate(o.next_action_at)}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  {
    id: "owner",
    header: "Owner",
    cell: (o) =>
      o.owner_name ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          <Avatar name={o.owner_name} size={20} />
          {o.owner_name}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "updated", header: "Updated", cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(o.updated_at)}</span> },
];

/** Every opportunity for a property, including dead ones (they are retained for reactivation). */
export function PropertyOpportunitiesTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["opportunities", "list", { property_id: propertyId, page_size: 100, sort: "-updated_at" }],
    queryFn: () => api.get<Page<OpportunityListItem>>("/opportunities", { property_id: propertyId, page_size: 100, sort: "-updated_at" }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Acquisition pursuits for this property, including dead and nurture records.</p>
        {can("pipeline", "create") && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New opportunity
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          dense
          rowHref={(o) => `/pipeline/${o.id}`}
          rowClassName={(o) => (o.stage === "dead" ? "bg-subtle/40" : undefined)}
          empty={
            <EmptyState
              icon={<GitBranch />}
              title="No opportunities"
              description="This property has not been pursued yet."
              action={
                can("pipeline", "create") ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus /> New opportunity
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Card>
      <OpportunityCreateSheet open={creating} onOpenChange={setCreating} propertyId={propertyId} />
    </div>
  );
}
