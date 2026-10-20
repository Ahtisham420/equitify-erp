"use client";

import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { api, type Page } from "@/lib/api";
import { formatCurrency, titleCase } from "@/lib/utils";

import { useDashboard, type TenantBalance } from "./api";
import { AgingCards, bucketColumns } from "./dashboard";
import { RxStatus } from "./ledger-tabs";

const columns: Column<TenantBalance>[] = [
  { id: "tenant", header: "Tenant", cell: (t) => <span className="font-medium text-ink">{t.tenant_name}</span> },
  ...bucketColumns<TenantBalance>(),
  { id: "unapplied", header: "Unapplied", align: "right", cell: (t) => formatCurrency(t.unapplied) },
  {
    id: "collection",
    header: "Collection",
    cell: (t) => (
      <span className="flex items-center gap-1.5">
        <RxStatus status={t.collection_status} />
        {t.step_key && <span className="text-xs text-ink-3">{titleCase(t.step_key)}</span>}
        {t.has_plan && <Badge tone="sky">Plan</Badge>}
      </span>
    ),
  },
];

/** Aging and tenant balances for one property. */
export function PropertyReceivablesTab({ propertyId }: { propertyId: string }) {
  const { data: dash } = useDashboard({ property_id: propertyId });
  const params = { property_id: propertyId, page_size: 200 };
  const { data, isLoading } = useQuery({
    queryKey: ["receivables", "tenants", params],
    queryFn: () => api.get<Page<TenantBalance>>("/receivables/tenants", params),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          Open receivables by age for this property.
          {dash?.collection_rate != null ? ` Month-to-date collection rate ${dash.collection_rate}%.` : ""}
        </p>
        <Link href={`/receivables?property_id=${propertyId}&tab=charges`}>
          <Button size="sm">Open in receivables</Button>
        </Link>
      </div>
      <AgingCards totals={dash?.totals} unapplied={dash?.unapplied} />
      <Card className="overflow-hidden">
        <CardHeader title="Tenant balances" />
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          dense
          rowHref={(t) => `/receivables/tenants/${t.lease_id}`}
          empty={<EmptyState icon={<Users />} title="No tenant balances" description="Charges appear once leases are verified and the period is billed." />}
        />
      </Card>
    </div>
  );
}
