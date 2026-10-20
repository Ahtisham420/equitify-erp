"use client";

import { useQuery } from "@tanstack/react-query";
import { FileSignature, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DataTable } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/misc";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import type { OfferListItem } from "./api";
import { OfferCreateSheet } from "./offer-form";
import { offerColumns } from "./offer-table";

/** Offers on one opportunity (latest version of each negotiation, or every version). */
export function OpportunityOffersPanel({ opportunityId }: { opportunityId: string }) {
  const { can } = useAuth();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [allVersions, setAllVersions] = useState(false);
  const params = { opportunity_id: opportunityId, latest_only: !allVersions, page_size: 100, sort: "-updated_at" };
  const { data, isLoading } = useQuery({
    queryKey: ["offers", "list", "opportunity", params],
    queryFn: () => api.get<Page<OfferListItem>>("/offers", params),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Offers"
        description="Prepared from approved underwriting; every counter is retained as a version."
        actions={
          <>
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <Checkbox checked={allVersions} onChange={setAllVersions} label="Show all versions" />
              All versions
            </label>
            {can("offers", "create") && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New offer
              </Button>
            )}
          </>
        }
      />
      <DataTable
        columns={offerColumns.filter((c) => !["owner", "updated", "structure", "em", "feas"].includes(c.id))}
        data={data?.items}
        loading={isLoading}
        dense
        rowHref={(o) => `/offers/${o.id}`}
        rowClassName={(o) => (o.overdue ? "bg-negative-soft/40" : !o.is_latest ? "bg-subtle/40" : undefined)}
        empty={
          <EmptyState
            icon={<FileSignature />}
            title="No offers yet"
            description="Create an offer from an approved underwriting model."
            action={
              can("offers", "create") ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus /> New offer
                </Button>
              ) : undefined
            }
          />
        }
      />
      <OfferCreateSheet open={creating} onOpenChange={setCreating} opportunityId={opportunityId} onCreated={(o) => router.push(`/offers/${o.id}`)} />
    </Card>
  );
}
