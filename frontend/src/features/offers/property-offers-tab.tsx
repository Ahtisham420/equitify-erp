"use client";

import { useQuery } from "@tanstack/react-query";
import { FileSignature } from "lucide-react";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/misc";
import { api, type Page } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

import type { OfferListItem } from "./api";
import { offerColumns } from "./offer-table";

/** Every offer made on a property, across opportunities, including lost ones and their winning prices. */
export function PropertyOffersTab({ propertyId }: { propertyId: string }) {
  const [allVersions, setAllVersions] = useState(false);
  const params = { property_id: propertyId, latest_only: !allVersions, page_size: 100, sort: "-updated_at" };
  const { data, isLoading } = useQuery({
    queryKey: ["offers", "list", "property", params],
    queryFn: () => api.get<Page<OfferListItem>>("/offers", params),
  });
  const columns: Column<OfferListItem>[] = [
    ...offerColumns.filter((c) => !["updated", "structure", "em", "feas"].includes(c.id)),
    { id: "winning", header: "Winning price", align: "right", cell: (o) => formatCurrency(o.winning_price) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Offers on this property, traceable to the approved underwriting behind each one.</p>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <Checkbox checked={allVersions} onChange={setAllVersions} label="Show all versions" />
          All versions
        </label>
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          dense
          rowHref={(o) => `/offers/${o.id}`}
          rowClassName={(o) => (o.overdue ? "bg-negative-soft/40" : undefined)}
          empty={<EmptyState icon={<FileSignature />} title="No offers" description="Offers are created from an opportunity with an approved underwriting model." />}
        />
      </Card>
    </div>
  );
}
