"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatPercent } from "@/lib/utils";

import { label, useMutate, type Deal, type Listing, type Prospect } from "./api";
import { LISTING_CREATE_FIELDS, PROSPECT_FIELDS } from "./forms";
import { RecordSheet, State, party } from "./ui";

const listingCols: Column<Listing>[] = [
  { id: "type", header: "Listing", cell: (l) => <span className="font-medium text-ink">{label(l.listing_type)}{l.headline ? ` · ${l.headline}` : ""}</span> },
  { id: "status", header: "Status", cell: (l) => <State value={l.status} /> },
  { id: "price", header: "Asking", align: "right", cell: (l) => formatCurrency(l.asking_price, { compact: true }) },
  { id: "dom", header: "DOM", align: "right", cell: (l) => l.days_on_market ?? "—" },
  { id: "listed", header: "Listed", cell: (l) => <span className="text-xs text-ink-2">{formatDate(l.listed_on)}</span> },
  { id: "agent", header: "Agent", cell: (l) => <span className="text-ink-2">{l.agent_name ?? "—"}</span> },
];

const prospectCols: Column<Prospect>[] = [
  { id: "title", header: "Prospect", cell: (p) => <span className="font-medium text-ink">{p.title}</span> },
  { id: "owner", header: "Owner", cell: (p) => <span className="text-ink-2">{party(p) ?? "—"}</span> },
  { id: "stage", header: "Stage", cell: (p) => <State value={p.stage} /> },
  { id: "market", header: "Market status", cell: (p) => <span className="text-ink-2">{label(p.market_status)}</span> },
  { id: "pitches", header: "Pitches", align: "right", cell: (p) => p.pitch_count },
  { id: "agent", header: "Agent", cell: (p) => <span className="text-ink-2">{p.agent_name ?? "—"}</span> },
];

const dealCols: Column<Deal>[] = [
  { id: "title", header: "Deal", cell: (d) => <span className="font-medium text-ink">{d.title}</span> },
  { id: "side", header: "Side", cell: (d) => <span className="text-ink-2">{label(d.side)}</span> },
  { id: "stage", header: "Stage", cell: (d) => <State value={d.stage} /> },
  { id: "gci", header: "Gross commission", align: "right", cell: (d) => formatCurrency(d.gross_commission_estimate, { compact: true }) },
  { id: "prob", header: "Probability", align: "right", cell: (d) => formatPercent(d.effective_probability, 0) },
  { id: "close", header: "Expected close", cell: (d) => <span className="text-xs text-ink-2">{formatDate(d.expected_close_on)}</span> },
];

/** Brokerage activity on a property: listings (with price history), owner prospects and transactions. */
export function PropertyBrokerageTab({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const { can } = useAuth();
  const params = { property_id: propertyId, page_size: 50 };
  const listings = useQuery({ queryKey: ["brokerage", "property-listings", propertyId], queryFn: () => api.get<Page<Listing>>("/listings", params) });
  const prospects = useQuery({ queryKey: ["brokerage", "property-prospects", propertyId], queryFn: () => api.get<Page<Prospect>>("/listing-prospects", params) });
  const deals = useQuery({ queryKey: ["brokerage", "property-deals", propertyId], queryFn: () => api.get<Page<Deal>>("/brokerage-deals", params) });
  const [creating, setCreating] = useState<"listing" | "prospect" | null>(null);
  const createListing = useMutate((body: Record<string, unknown>) => api.post<Listing>("/listings", { ...body, property_id: propertyId }));
  const createProspect = useMutate((body: Record<string, unknown>) => api.post<Prospect>("/listing-prospects", { ...body, property_id: propertyId }));

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Listings"
          description="Asking-price and status history are kept on each listing"
          actions={can("brokerage", "create") && <Button size="sm" onClick={() => setCreating("listing")}><Plus /> New listing</Button>}
        />
        <DataTable columns={listingCols} data={listings.data?.items} loading={listings.isLoading} dense rowHref={(l) => `/listings/${l.id}`} empty={<EmptyState title="Not listed" description="This property has no brokerage listings." />} />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader
          title="Listing prospects"
          description="Owner relationships being pitched for a listing"
          actions={can("brokerage", "create") && <Button size="sm" onClick={() => setCreating("prospect")}><Plus /> New prospect</Button>}
        />
        <DataTable columns={prospectCols} data={prospects.data?.items} loading={prospects.isLoading} dense onRowClick={(p) => router.push(`/brokerage?prospect=${p.id}`)} empty={<EmptyState title="No prospects" />} />
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Brokerage deals" actions={<Link href="/brokerage?tab=deals&scope=all" className="text-xs font-medium text-accent hover:underline">All deals</Link>} />
        <DataTable columns={dealCols} data={deals.data?.items} loading={deals.isLoading} dense onRowClick={(d) => router.push(`/brokerage?tab=deals&scope=all&deal=${d.id}`)} empty={<EmptyState title="No brokerage deals" />} />
      </Card>
      <RecordSheet
        open={creating === "listing"}
        onOpenChange={(o) => !o && setCreating(null)}
        title="New listing"
        fields={LISTING_CREATE_FIELDS.filter((f) => f.key !== "property_id")}
        initial={{ listing_type: "sale", status: "draft", reporting_cadence: "biweekly" }}
        onSubmit={async (b) => {
          const l = await createListing.mutateAsync(b);
          router.push(`/listings/${l.id}`);
        }}
      />
      <RecordSheet
        open={creating === "prospect"}
        onOpenChange={(o) => !o && setCreating(null)}
        title="New listing prospect"
        fields={PROSPECT_FIELDS.filter((f) => f.key !== "property_id")}
        initial={{ market_status: "not_listed" }}
        onSubmit={(b) => createProspect.mutateAsync(b)}
      />
    </div>
  );
}
