"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ScrollText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils";

import { LEASE_TYPE_LABELS, type LeaseListItem } from "./api";
import { LeaseFormSheet } from "./lease-form";
import { RentRollView } from "./rent-roll";
import { RolloverView } from "./rollover";

const columns: Column<LeaseListItem>[] = [
  { id: "tenant", header: "Tenant", cell: (l) => <span className="font-medium text-ink">{l.tenant_name}</span> },
  { id: "suite", header: "Suite", cell: (l) => <span className="text-ink-2">{l.suite ?? "—"}</span> },
  { id: "type", header: "Type", cell: (l) => <span className="text-ink-2">{LEASE_TYPE_LABELS[l.lease_type] ?? l.lease_type}</span> },
  { id: "status", header: "Status", cell: (l) => <StatusBadge status={l.status} /> },
  { id: "sf", header: "SF", align: "right", cell: (l) => formatNumber(l.rentable_sf) },
  { id: "rent", header: "Annual rent", align: "right", cell: (l) => formatCurrency(l.current_annual_rent) },
  { id: "expires", header: "Expires", cell: (l) => <span className="whitespace-nowrap text-ink-2">{formatDate(l.expiration_on)}</span> },
  { id: "verified", header: "", cell: (l) => (l.verified ? <Badge tone="green" dot>Verified</Badge> : <Badge tone="amber" dot>{l.ai_extracted ? "AI · unverified" : "Unverified"}</Badge>) },
];

/** Leases, rent roll and rollover for one property. */
export function PropertyLeasesTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const params = { property_id: propertyId, page_size: 200, sort: "expiration_on" };
  const { data, isLoading } = useQuery({
    queryKey: ["leases", "list", "/leases", params],
    queryFn: () => api.get<Page<LeaseListItem>>("/leases", params),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Rent roll as of today, rollover exposure and every lease abstract for this property.</p>
        {can("leases", "create") && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New lease
          </Button>
        )}
      </div>
      <RentRollView propertyId={propertyId} />
      <Card className="overflow-hidden">
        <CardHeader title="All leases" description="Including drafts, expired and terminated leases" />
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          dense
          rowHref={(l) => `/leases/${l.id}`}
          empty={<EmptyState icon={<ScrollText />} title="No leases" description="Abstract a lease to build the rent roll." />}
        />
      </Card>
      <RolloverView propertyId={propertyId} />
      <LeaseFormSheet open={creating} onOpenChange={setCreating} propertyId={propertyId} onSaved={(l) => router.push(`/leases/${l.id}`)} />
    </div>
  );
}
