"use client";

import { Building2 } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn, formatDate, formatDateTime, formatPercent, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import { useContactContext, type ContextOut, type EntityKind } from "./api";

type Prop = ContextOut["properties"][number];
type Opp = ContextOut["opportunities"][number];

const propColumns: Column<Prop & { id: string }>[] = [
  {
    id: "property",
    header: "Property",
    cell: (p) => (
      <div className="min-w-[200px]">
        <Link href={`/properties/${p.property_id}`} className="font-medium text-ink hover:underline">{p.property_label}</Link>
        <p className="text-xs text-ink-3">{[p.city, p.state].filter(Boolean).join(", ") || "—"}</p>
      </div>
    ),
  },
  { id: "role", header: "Role", cell: (p) => <span className="text-ink-2">{titleCase(p.role)}</span> },
  { id: "pct", header: "Interest", align: "right", cell: (p) => formatPercent(p.interest_pct, 1) },
  {
    id: "period",
    header: "Held",
    cell: (p) => (
      <span className="whitespace-nowrap text-xs text-ink-2">
        {formatDate(p.effective_from)} – {p.effective_to ? formatDate(p.effective_to) : "present"}
      </span>
    ),
  },
  {
    id: "via",
    header: "Through",
    cell: (p) =>
      p.via_organization_id ? (
        <Link href={`/organizations/${p.via_organization_id}`} className="text-xs text-accent hover:underline">{p.via_organization_name}</Link>
      ) : (
        <span className="text-xs text-ink-3">Direct</span>
      ),
  },
  { id: "state", header: "", cell: (p) => <Badge tone={p.is_current ? "green" : "outline"}>{p.is_current ? "Current" : "Prior"}</Badge> },
];

const oppColumns: Column<Opp>[] = [
  { id: "title", header: "Opportunity", cell: (o) => <Link href={`/pipeline/${o.id}`} className="font-medium text-ink hover:underline">{o.title ?? "Untitled"}</Link> },
  { id: "stage", header: "Stage", cell: (o) => <StatusBadge status={o.stage} /> },
  { id: "source", header: "Source", cell: (o) => <span className="text-ink-2">{titleCase(o.source)}</span> },
  {
    id: "next",
    header: "Next action",
    cell: (o) => <span className={cn("text-xs", isOverdue(o.next_action_at) ? "text-negative" : "text-ink-2")}>{formatRelative(o.next_action_at)}</span>,
  },
];

export function ContextPanel({ kind, id }: { kind: EntityKind; id: string }) {
  const { data, isLoading } = useContactContext(kind, id);
  const props = (data?.properties ?? []).map((p) => ({ ...p, id: p.interest_id }));
  const openTasks = (data?.tasks ?? []).filter((t) => !["done", "cancelled"].includes(t.status));

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader title="Properties" description="Current and prior ownership, directly and through organizations" />
        <DataTable
          columns={propColumns}
          data={props}
          loading={isLoading}
          dense
          empty={<EmptyState icon={<Building2 />} title="No properties connected" description="Ownership interests recorded for this record appear here." />}
        />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Deals" />
        <DataTable columns={oppColumns} data={data?.opportunities} loading={isLoading} dense empty={<EmptyState title="No opportunities linked" />} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Interactions" description="Calls, emails, texts, meetings, tours, letters and notes" />
          <CardBody className="p-0">
            {!data?.interactions.length ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">No interactions logged.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.interactions.map((i) => (
                  <li key={i.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Badge tone="outline">{titleCase(i.channel)}</Badge>
                      <span className="text-xs text-ink-3">{titleCase(i.direction)}</span>
                      {i.disposition && <span className="text-xs text-ink-2">· {titleCase(i.disposition)}</span>}
                      <span className="ml-auto text-xs text-ink-3" title={formatDateTime(i.occurred_at)}>{formatRelative(i.occurred_at)}</span>
                    </div>
                    {i.summary && <p className="mt-1 line-clamp-2 text-sm text-ink-2">{i.summary}</p>}
                    <div className="mt-1 flex gap-3 text-xs">
                      {i.property_id && <Link href={`/properties/${i.property_id}`} className="text-accent hover:underline">Property</Link>}
                      {i.opportunity_id && <Link href={`/pipeline/${i.opportunity_id}`} className="text-accent hover:underline">Opportunity</Link>}
                      {i.loop_closed === false && i.next_action_at && (
                        <span className={cn(isOverdue(i.next_action_at) ? "text-negative" : "text-ink-3")}>Follow-up {formatRelative(i.next_action_at)}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Follow-up tasks" description={`${openTasks.length} open`} />
          <CardBody className="p-0">
            {!data?.tasks.length ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">No tasks linked to this record.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 px-4 py-2.5">
                    <span className={cn("min-w-0 flex-1 truncate text-sm", ["done", "cancelled"].includes(t.status) ? "text-ink-3 line-through" : "text-ink")}>{t.title}</span>
                    <StatusBadge status={t.priority} />
                    <span className={cn("whitespace-nowrap text-xs", isOverdue(t.due_at) && !["done", "cancelled"].includes(t.status) ? "text-negative" : "text-ink-3")}>
                      {formatDate(t.due_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
