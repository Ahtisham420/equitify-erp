"use client";

import { Clock } from "lucide-react";

import type { Column } from "@/components/data/data-table";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency, formatDateTime, formatNumber, formatRelative } from "@/lib/utils";

import { STATUS_LABELS, STRUCTURE_LABELS, clockLabel, offerTone, type OfferListItem } from "./api";

export function OfferStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={offerTone(status)} dot>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Response clock chip: red when overdue, amber inside 24h. */
export function DueChip({ o }: { o: Pick<OfferListItem, "hours_to_due" | "overdue" | "response_due_at"> }) {
  const label = clockLabel(o.hours_to_due);
  if (!label) return <span className="text-ink-3">—</span>;
  const tone = o.overdue ? "red" : (o.hours_to_due ?? 99) < 24 ? "amber" : "outline";
  return (
    <span title={formatDateTime(o.response_due_at)}>
      <Badge tone={tone}>
        <Clock className="size-3" />
        {label}
      </Badge>
    </span>
  );
}

export function DeviationText({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>;
  return (
    <span className={cn("tabular", value > 0 ? "text-caution" : "text-ink-2")}>
      {value > 0 ? "+" : ""}
      {formatNumber(value, 2)}%
    </span>
  );
}

export const offerColumns: Column<OfferListItem>[] = [
  {
    id: "offer",
    header: "Offer",
    cell: (o) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{o.opportunity_title ?? "Offer"}</p>
        <p className="truncate text-xs text-ink-3">
          v{o.version} · {o.origin === "seller" ? "Counterparty counter" : "Our offer"}
          {o.property_label ? ` · ${o.property_label}` : ""}
        </p>
      </div>
    ),
  },
  { id: "status", header: "Status", sortKey: "status", hideable: true, cell: (o) => <OfferStatusBadge status={o.status} /> },
  { id: "price", header: "Price", sortKey: "price", align: "right", hideable: true, cell: (o) => formatCurrency(o.price) },
  { id: "model", header: "Model price", align: "right", hideable: true, cell: (o) => formatCurrency(o.model_price) },
  { id: "deviation", header: "Deviation", sortKey: "deviation_pct", align: "right", hideable: true, cell: (o) => <DeviationText value={o.deviation_pct} /> },
  { id: "structure", header: "Structure", hideable: true, defaultHidden: true, cell: (o) => <span className="text-ink-2">{STRUCTURE_LABELS[o.structure] ?? o.structure}</span> },
  { id: "em", header: "Earnest", align: "right", hideable: true, defaultHidden: true, cell: (o) => formatCurrency(o.earnest_money) },
  { id: "feas", header: "Feasibility", align: "right", hideable: true, defaultHidden: true, cell: (o) => (o.feasibility_days != null ? `${o.feasibility_days}d` : "—") },
  { id: "due", header: "Response", sortKey: "response_due_at", hideable: true, cell: (o) => <DueChip o={o} /> },
  { id: "sent", header: "Sent", sortKey: "sent_at", hideable: true, cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{o.sent_at ? formatRelative(o.sent_at) : "—"}</span> },
  { id: "owner", header: "Owner", hideable: true, cell: (o) => <span className="whitespace-nowrap text-ink-2">{o.owner_name ?? "—"}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, defaultHidden: true, cell: (o) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(o.updated_at)}</span> },
];
