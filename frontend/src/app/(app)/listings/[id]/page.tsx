"use client";

import { DollarSign, ExternalLink, FolderLock, Pencil, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber, formatPercent } from "@/lib/utils";

import { label, useListing, useMutate } from "@/features/brokerage/api";
import { LISTING_EDIT_FIELDS } from "@/features/brokerage/forms";
import { InquiriesPanel, MarketingPanel, OffersTable, PriceDialog, PriceTimeline, SellerReportsPanel, ShowingsPanel, StatusDialog } from "@/features/brokerage/listing-panels";
import { RecordSheet, State, party } from "@/features/brokerage/ui";

function ListingDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: l, isLoading, error } = useListing(id);
  const [editing, setEditing] = useState(false);
  const [pricing, setPricing] = useState(false);
  const [statusing, setStatusing] = useState(false);
  const update = useMutate((body: Record<string, unknown>) => api.patch(`/listings/${id}`, body));
  const openRoom = useMutate(() => api.post<{ id: string }>("/deal-rooms", { listing_id: id, status: "draft", requires_nda: true }), ["brokerage", "dealroom"]);
  const tab = url.get("tab") ?? "overview";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !l) {
    return <EmptyState title="Listing not found" description={errorMessage(error)} action={<Link href="/listings"><Button>Back to listings</Button></Link>} />;
  }

  const lease = l.listing_type === "lease";
  const createRoom = () =>
    openRoom.mutate(undefined, {
      onSuccess: (r) => {
        toast.success("Deal room created");
        router.push(`/tours/rooms/${r.id}`);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Listings", href: "/listings" }, { label: l.property_label ?? "Listing" }]}
        title={l.property_label ?? "Listing"}
        description={l.headline ?? [l.property_city, l.property_state].filter(Boolean).join(", ")}
        meta={
          <>
            <State value={l.status} />
            <Badge tone="outline">{label(l.listing_type)}</Badge>
            {l.agent_name && <span className="text-xs text-ink-3">Agent: {l.agent_name}</span>}
            <Link href={`/properties/${l.property_id}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
              Property record <ExternalLink className="size-3" />
            </Link>
          </>
        }
        actions={
          <>
            {l.deal_room_id ? (
              <Link href={`/tours/rooms/${l.deal_room_id}`}>
                <Button>
                  <FolderLock /> Deal room
                </Button>
              </Link>
            ) : (
              can("dealroom", "create") && (
                <Button onClick={createRoom} loading={openRoom.isPending}>
                  <FolderLock /> Open deal room
                </Button>
              )
            )}
            {can("brokerage", "edit") && (
              <>
                <Button onClick={() => setStatusing(true)}>
                  <RefreshCw /> Status
                </Button>
                <Button onClick={() => setPricing(true)}>
                  <DollarSign /> Change price
                </Button>
                <Button variant="primary" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label={lease ? "Asking rent" : "Asking price"} value={lease ? (l.asking_rent_psf != null ? `$${formatNumber(l.asking_rent_psf, 2)}/SF` : "—") : formatCurrency(l.asking_price, { compact: true })} hint={l.price_change_count ? `${l.price_change_count} price change${l.price_change_count > 1 ? "s" : ""}` : "Original price"} />
        <StatCard label="Days on market" value={l.days_on_market ?? "—"} hint={l.listed_on ? `Listed ${formatDate(l.listed_on)}` : "Not yet live"} tone={l.days_on_market != null && l.days_on_market > 180 ? "caution" : "default"} />
        <StatCard label="Inquiries" value={formatNumber(l.inquiry_count)} />
        <StatCard label="Showings" value={formatNumber(l.showing_count)} />
        <StatCard label="Listing expires" value={formatDate(l.expires_on)} tone={l.expires_on && new Date(l.expires_on).getTime() - Date.now() < 30 * 864e5 ? "caution" : "default"} />
      </div>

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Profile & history" },
            { value: "marketing", label: "Marketing & syndication" },
            { value: "activity-log", label: "Inquiries & showings", count: l.inquiry_count + l.showing_count },
            { value: "reports", label: "Seller reports" },
            ...(can("dealroom") ? [{ value: "offers", label: "Offers" }] : []),
            { value: "audit", label: "Audit" },
          ]}
        />
        <TabPanel value="overview" className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Listing profile" />
              <CardBody className="space-y-4">
                <FieldGrid cols={3}>
                  <FieldItem label="Type">{label(l.listing_type)}</FieldItem>
                  <FieldItem label="Cap rate">{l.cap_rate != null ? formatPercent(l.cap_rate, 2) : null}</FieldItem>
                  <FieldItem label="Seller">{party(l)}</FieldItem>
                  <FieldItem label="Listed on">{l.listed_on ? formatDate(l.listed_on) : null}</FieldItem>
                  <FieldItem label="Expires">{l.expires_on ? formatDate(l.expires_on) : null}</FieldItem>
                  <FieldItem label="Seller reporting">{label(l.reporting_cadence)}</FieldItem>
                  {l.closed_on && <FieldItem label="Closed on">{formatDate(l.closed_on)}</FieldItem>}
                  {l.closed_price != null && <FieldItem label="Closed price">{formatCurrency(l.closed_price)}</FieldItem>}
                </FieldGrid>
                {l.description && <p className="whitespace-pre-wrap text-sm text-ink-2">{l.description}</p>}
                {l.highlights.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-2">
                    {l.highlights.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Engagement" />
              <CardBody>
                <FieldGrid cols={1}>
                  <FieldItem label="Engagement agreement">{l.engagement_agreement_id ? "On file" : "Not linked"}</FieldItem>
                  <FieldItem label="Originating prospect">{l.prospect_id ? <Link href={`/brokerage?tab=prospects&prospect=${l.prospect_id}`} className="text-accent hover:underline">Open in Brokerage CRM</Link> : null}</FieldItem>
                  <FieldItem label="Deal room">{l.deal_room_id ? <Link href={`/tours/rooms/${l.deal_room_id}`} className="text-accent hover:underline">Open deal room</Link> : null}</FieldItem>
                  <FieldItem label="Tags">{l.tags.length ? l.tags.join(", ") : null}</FieldItem>
                </FieldGrid>
              </CardBody>
            </Card>
          </div>
          <PriceTimeline listingId={id} />
        </TabPanel>
        <TabPanel value="marketing">
          <MarketingPanel listing={l} />
        </TabPanel>
        <TabPanel value="activity-log" className="space-y-5">
          <InquiriesPanel listing={l} />
          <ShowingsPanel listing={l} />
        </TabPanel>
        <TabPanel value="reports">
          <SellerReportsPanel listing={l} />
        </TabPanel>
        <TabPanel value="offers">
          <Card className="overflow-hidden">
            <CardHeader
              title="Offers"
              description="Structured offers submitted through the deal room"
              actions={l.deal_room_id ? <Link href={`/tours/rooms/${l.deal_room_id}?tab=offers`} className="text-xs font-medium text-accent hover:underline">Open in deal room</Link> : undefined}
            />
            <OffersTable params={{ listing_id: id }} />
          </Card>
        </TabPanel>
        <TabPanel value="audit">
          <Card>
            <CardBody>
              <RecordTimeline entityType="listing" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <RecordSheet open={editing} onOpenChange={setEditing} title="Edit listing" description="Price and status have their own actions so their history is kept." mode="edit" fields={LISTING_EDIT_FIELDS} initial={l as unknown as Record<string, unknown>} onSubmit={(b) => update.mutateAsync(b)} />
      <PriceDialog listing={l} open={pricing} onOpenChange={setPricing} />
      {statusing && <StatusDialog listing={l} open={statusing} onOpenChange={setStatusing} />}
    </>
  );
}

export default function ListingPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <ListingDetail id={params.id} />
    </Suspense>
  );
}
