"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarClock, FileSignature, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/misc";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase } from "@/lib/utils";

import { RELATED_TYPE_LABELS, isOverdueDate, relatedHref, useContractsFor, type ContractListItem, type CriticalDate } from "./api";
import { ContractFormSheet } from "./contract-form";
import { DateStatusBadge, DueText } from "./critical-date-actions";

const TONES = { draft: "neutral", executed: "green", closed: "sky", terminated: "red" } as const;

const columns: Column<ContractListItem>[] = [
  { id: "title", header: "Contract", cell: (c) => <span className="font-medium text-ink">{c.title}</span> },
  {
    id: "status",
    header: "Status",
    cell: (c) => (
      <Badge tone={TONES[c.status as keyof typeof TONES] ?? "neutral"} dot>
        {titleCase(c.status)}
      </Badge>
    ),
  },
  { id: "effective", header: "Effective", cell: (c) => <span className="whitespace-nowrap text-ink-2 tabular">{formatDate(c.effective_on)}</span> },
  {
    id: "feasibility",
    header: "Feasibility",
    cell: (c) => (
      <span className={cn("whitespace-nowrap tabular", c.days_to_feasibility != null && c.days_to_feasibility >= 0 && c.days_to_feasibility <= 7 ? "font-medium text-caution" : "text-ink-2")}>
        {formatDate(c.feasibility_on)}
      </span>
    ),
  },
  {
    id: "dd",
    header: "DD",
    cell: (c) =>
      c.dd_total ? (
        <div className="flex items-center gap-2">
          <Progress value={(100 * c.dd_done) / c.dd_total} className="w-12" tone="accent" />
          <span className="text-xs text-ink-3 tabular">
            {c.dd_done}/{c.dd_total}
          </span>
        </div>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "blockers", header: "Blockers", align: "right", cell: (c) => (c.open_blockers ? <span className="font-medium text-negative">{c.open_blockers}</span> : "0") },
  { id: "price", header: "Price", align: "right", cell: (c) => formatCurrency(c.purchase_price, { compact: true }) },
];

/** Contracts for a property plus every open critical date on the property (all modules). */
export function PropertyContractsTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useContractsFor({ property_id: propertyId, page_size: 100, sort: "-updated_at" });
  const dateParams = { property_id: propertyId, status: ["proposed", "confirmed", "missed"], page_size: 50, sort: "due_on" };
  const { data: dates } = useQuery({
    queryKey: ["critical-dates", "property", dateParams],
    queryFn: () => api.get<Page<CriticalDate>>("/critical-dates", dateParams),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-ink-2">Purchase agreements and amendments with their deadlines and diligence.</p>
          {can("contracts", "create") && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New contract
            </Button>
          )}
        </div>
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={data?.items}
            loading={isLoading}
            dense
            rowHref={(c) => `/contracts/${c.id}`}
            empty={<EmptyState icon={<FileSignature />} title="No contracts" description="No agreement has been recorded for this property." />}
          />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Open critical dates"
          description="Across contracts, leases, loans and other records on this property."
          actions={
            <Link href={`/critical-dates?property_id=${propertyId}`}>
              <Button size="sm" variant="ghost">
                View all
              </Button>
            </Link>
          }
        />
        {!dates?.items.length ? (
          <EmptyState icon={<CalendarClock />} title="No open critical dates" className="py-8" />
        ) : (
          <ul className="divide-y divide-line">
            {dates.items.map((d) => {
              const href = relatedHref(d);
              return (
                <li key={d.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2", isOverdueDate(d) && "bg-negative-soft/40")}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{d.label}</p>
                    <p className="truncate text-xs text-ink-3">
                      {RELATED_TYPE_LABELS[d.related_type] ?? titleCase(d.related_type)}
                      {d.related_label ? " · " : ""}
                      {href && d.related_label ? (
                        <Link href={href} className="hover:underline">
                          {d.related_label}
                        </Link>
                      ) : (
                        d.related_label
                      )}
                    </p>
                  </div>
                  <DueText d={d} className="text-sm" />
                  <DateStatusBadge status={d.status} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ContractFormSheet open={creating} onOpenChange={setCreating} propertyId={propertyId} />
    </div>
  );
}
