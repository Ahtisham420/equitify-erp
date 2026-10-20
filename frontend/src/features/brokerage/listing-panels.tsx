"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, FileText, Inbox, Megaphone, Pencil, Plus, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import { INQUIRY_STATUSES, LISTING_STATUSES, label, opts, useMutate, type Inquiry, type Listing, type MarketingItem, type PriceHistory, type SellerReport, type Showing, type StatusEvent } from "./api";
import { INQUIRY_FIELDS, MARKETING_FIELDS, SHOWING_FIELDS } from "./forms";
import { RecordSheet, State, party } from "./ui";

/* ------------------------------------------------------------------ price & status changes */

export function PriceDialog({ listing, open, onOpenChange }: { listing: Listing; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [price, setPrice] = useState("");
  const [effective, setEffective] = useState("");
  const [reason, setReason] = useState("");
  const save = useMutate((body: Record<string, unknown>) => api.post<Listing>(`/listings/${listing.id}/price`, body));
  const lease = listing.listing_type === "lease";
  const submit = () =>
    save.mutate(
      { [lease ? "asking_rent_psf" : "asking_price"]: Number(price.replace(/,/g, "")), effective_on: effective || null, reason: reason || null },
      {
        onSuccess: () => {
          toast.success("Asking price updated; history retained");
          onOpenChange(false);
          setPrice("");
          setReason("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change asking price"
      description="Every change is appended to the price history and synced to the property record."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!price.trim()} loading={save.isPending} onClick={submit}>
            Save price
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={lease ? "New asking rent ($/SF/yr)" : "New asking price"} required hint={`Current: ${lease ? (listing.asking_rent_psf != null ? `$${formatNumber(listing.asking_rent_psf, 2)}` : "—") : formatCurrency(listing.asking_price)}`}>
          <Input autoFocus inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Effective on">
          <Input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
        </Field>
        <Field label="Reason" className="col-span-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Seller approved reduction after 60 days of activity" />
        </Field>
      </div>
    </Dialog>
  );
}

export function StatusDialog({ listing, open, onOpenChange }: { listing: Listing; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [status, setStatus] = useState(listing.status);
  const [reason, setReason] = useState("");
  const [closedOn, setClosedOn] = useState("");
  const [closedPrice, setClosedPrice] = useState("");
  const save = useMutate((body: Record<string, unknown>) => api.post<Listing>(`/listings/${listing.id}/status`, body));
  const closing = status === "sold" || status === "leased";
  const submit = () =>
    save.mutate(
      { status, reason: reason || null, closed_on: closedOn || null, closed_price: closedPrice ? Number(closedPrice.replace(/,/g, "")) : null },
      {
        onSuccess: () => {
          toast.success(`Status set to ${label(status)}`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change listing status"
      description="Status changes are kept in the listing history and update the property status."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={status === listing.status} loading={save.isPending} onClick={submit}>
            Update status
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status" className="col-span-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} options={opts(LISTING_STATUSES)} />
        </Field>
        {closing && (
          <>
            <Field label="Closed on" required>
              <Input type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} />
            </Field>
            <Field label={status === "sold" ? "Sale price" : "Lease value"} required={status === "sold"}>
              <Input inputMode="decimal" value={closedPrice} onChange={(e) => setClosedPrice(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Reason" required={status === "withdrawn" || status === "expired"} className="col-span-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ history */

export function PriceTimeline({ listingId }: { listingId: string }) {
  const prices = useQuery({ queryKey: ["brokerage", "price-history", listingId], queryFn: () => api.get<PriceHistory[]>(`/listings/${listingId}/price-history`) });
  const statuses = useQuery({ queryKey: ["brokerage", "status-history", listingId], queryFn: () => api.get<StatusEvent[]>(`/listings/${listingId}/status-history`) });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="Asking-price history" description="Appended on every change; never overwritten" />
        <CardBody>
          {!prices.data?.length ? (
            <p className="text-sm text-ink-3">No asking price recorded yet.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-line pl-4">
              {prices.data.map((p) => {
                const delta = p.previous_price && p.price != null ? ((p.price - p.previous_price) / p.previous_price) * 100 : null;
                return (
                  <li key={p.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-accent" />
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-semibold tabular text-ink">{p.price != null ? formatCurrency(p.price) : p.rent_psf != null ? `$${formatNumber(p.rent_psf, 2)}/SF` : "—"}</span>
                      {delta != null && (
                        <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular", delta < 0 ? "text-negative" : "text-positive")}>
                          {delta < 0 ? <ArrowDownRight className="size-3" /> : <ArrowUpRight className="size-3" />}
                          {formatPercent(Math.abs(delta), 1)}
                        </span>
                      )}
                      <span className="text-xs text-ink-3">effective {formatDate(p.effective_on)}</span>
                    </div>
                    {p.reason && <p className="mt-0.5 text-sm text-ink-2">{p.reason}</p>}
                    <p className="mt-0.5 text-xs text-ink-3">
                      {p.source} · {p.actor_name ?? "System"} · {formatDateTime(p.at)}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Status history" />
        <CardBody>
          {!statuses.data?.length ? (
            <p className="text-sm text-ink-3">No status changes yet.</p>
          ) : (
            <ol className="space-y-3">
              {statuses.data.map((s) => (
                <li key={s.id} className="flex items-start gap-3">
                  <div className="flex shrink-0 items-center gap-1.5">
                    {s.from_status && <State value={s.from_status} />}
                    {s.from_status && <span className="text-ink-3">→</span>}
                    <State value={s.to_status} />
                  </div>
                  <div className="min-w-0 text-xs text-ink-3">
                    {s.reason && <p className="text-sm text-ink-2">{s.reason}</p>}
                    {s.actor_name ?? "System"} · {formatDateTime(s.at)}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ marketing */

export function MarketingPanel({ listing }: { listing: Listing }) {
  const { can } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ["brokerage", "marketing", listing.id], queryFn: () => api.get<MarketingItem[]>(`/listings/${listing.id}/marketing`) });
  const [editing, setEditing] = useState<MarketingItem | "new" | null>(null);
  const save = useMutate(({ id, body }: { id?: string; body: Record<string, unknown> }) =>
    id ? api.patch(`/marketing-items/${id}`, body) : api.post(`/listings/${listing.id}/marketing`, body),
  );
  const review = useMutate((m: MarketingItem) => api.post("/ad-reviews", { title: m.title, marketing_item_id: m.id, listing_id: listing.id, channel: m.channels[0] ?? null }), ["brokerage", "dealroom"]);

  const columns: Column<MarketingItem>[] = [
    { id: "title", header: "Material", cell: (m) => <div><p className="font-medium text-ink">{m.title}</p><p className="text-xs text-ink-3">{label(m.kind)}</p></div> },
    { id: "status", header: "Status", cell: (m) => <State value={m.status} /> },
    { id: "review", header: "Ad review", cell: (m) => (m.ad_review_status ? <State value={m.ad_review_status} /> : <span className="text-xs text-ink-3">Not submitted</span>) },
    { id: "channels", header: "Channels", cell: (m) => <div className="flex flex-wrap gap-1">{m.channels.length ? m.channels.map((c) => <Badge key={c} tone="outline">{label(c)}</Badge>) : <span className="text-ink-3">—</span>}</div> },
    { id: "synd", header: "Syndication", cell: (m) => <div className="flex flex-col"><State value={m.syndication_status} />{m.syndicated_at && <span className="mt-0.5 text-2xs text-ink-3">since {formatDate(m.syndicated_at)}</span>}</div> },
    { id: "docs", header: "Files", align: "right", cell: (m) => formatNumber(m.document_ids.length) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (m) => (
        <div className="flex justify-end gap-1">
          {can("dealroom", "create") && (!m.ad_review_status || m.ad_review_status === "changes_requested" || m.ad_review_status === "rejected") && (
            <Button size="xs" onClick={() => review.mutate(m, { onSuccess: () => toast.success("Submitted for advertising review"), onError: (e) => toast.error(errorMessage(e)) })}>
              <Send className="!size-3.5" /> Submit for review
            </Button>
          )}
          {can("brokerage", "edit") && (
            <Button size="xs" variant="ghost" onClick={() => setEditing(m)} aria-label="Edit">
              <Pencil className="!size-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-2">Marketing materials and where they are syndicated. Publishing requires an approved advertising review.</p>
        {can("brokerage", "create") && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus /> Add material
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState icon={<Megaphone />} title="No marketing materials" description="Add the offering memorandum, flyers and syndication channels." />} />
      </Card>
      <RecordSheet
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "Add marketing material" : "Edit marketing material"}
        mode={editing === "new" ? "create" : "edit"}
        fields={MARKETING_FIELDS}
        initial={editing && editing !== "new" ? (editing as unknown as Record<string, unknown>) : { kind: "flyer", status: "draft", syndication_status: "not_syndicated", channels: [], document_ids: [] }}
        onSubmit={(body) => save.mutateAsync({ id: editing && editing !== "new" ? editing.id : undefined, body })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ inquiries & showings */

export function InquiriesPanel({ listing }: { listing: Listing }) {
  const { can } = useAuth();
  const params = { listing_id: listing.id, page_size: 100 };
  const { data, isLoading } = useQuery({ queryKey: ["brokerage", "inquiries", params], queryFn: () => api.get<Page<Inquiry>>("/inquiries", params) });
  const [creating, setCreating] = useState(false);
  const create = useMutate((body: Record<string, unknown>) => api.post("/inquiries", { ...body, listing_id: listing.id }), ["brokerage", "tasks"]);
  const setStatus = useMutate(({ id, status }: { id: string; status: string }) => api.patch(`/inquiries/${id}`, { status }));

  const columns: Column<Inquiry>[] = [
    { id: "who", header: "Prospect", cell: (i) => <div><p className="font-medium text-ink">{party(i) ?? i.contact_name ?? "—"}</p><p className="text-xs text-ink-3">{[i.contact_email, i.contact_phone].filter(Boolean).join(" · ") || "—"}</p></div> },
    { id: "source", header: "Source", cell: (i) => <span className="text-ink-2">{label(i.source)}</span> },
    { id: "received", header: "Received", cell: (i) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(i.received_at)}</span> },
    {
      id: "status",
      header: "Status",
      cell: (i) =>
        can("brokerage", "edit") ? (
          <select
            value={i.status}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setStatus.mutate({ id: i.id, status: e.target.value }, { onError: (err) => toast.error(errorMessage(err)) })}
            className="h-7 rounded-md border border-line-strong/80 bg-surface px-1.5 text-xs"
          >
            {INQUIRY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        ) : (
          <State value={i.status} />
        ),
    },
    { id: "assigned", header: "Assigned", cell: (i) => <span className="whitespace-nowrap text-ink-2">{i.assigned_name ?? "—"}</span> },
    { id: "follow", header: "Follow-up", cell: (i) => (i.follow_up_task_id ? <span className="text-xs text-ink-2">Task due {formatDate(i.follow_up_at)}</span> : <span className="text-ink-3">—</span>) },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Inquiry log"
        description="Every inquiry gets an owned follow-up task"
        actions={can("brokerage", "create") && <Button size="sm" onClick={() => setCreating(true)}><Plus /> Log inquiry</Button>}
      />
      <DataTable columns={columns} data={data?.items} loading={isLoading} dense empty={<EmptyState icon={<Inbox />} title="No inquiries yet" />} />
      <RecordSheet open={creating} onOpenChange={setCreating} title="Log inquiry" fields={INQUIRY_FIELDS} initial={{ source: "website", status: "new" }} onSubmit={(b) => create.mutateAsync(b)} />
    </Card>
  );
}

export function ShowingsPanel({ listing }: { listing: Listing }) {
  const { can } = useAuth();
  const params = { listing_id: listing.id, page_size: 100 };
  const { data, isLoading } = useQuery({ queryKey: ["brokerage", "showings", params], queryFn: () => api.get<Page<Showing>>("/showings", params) });
  const [editing, setEditing] = useState<Showing | "new" | null>(null);
  const save = useMutate(({ id, body }: { id?: string; body: Record<string, unknown> }) => (id ? api.patch(`/showings/${id}`, body) : api.post("/showings", { ...body, listing_id: listing.id })));

  const columns: Column<Showing>[] = [
    { id: "when", header: "When", cell: (s) => <span className="whitespace-nowrap text-ink">{formatDateTime(s.scheduled_at)}</span> },
    { id: "who", header: "Visitor", cell: (s) => <span className="text-ink-2">{party(s) ?? s.contact_name ?? "—"}</span> },
    { id: "status", header: "Status", cell: (s) => <State value={s.status} /> },
    { id: "interest", header: "Interest", cell: (s) => (s.interest_level ? <State value={s.interest_level} /> : <span className="text-ink-3">—</span>) },
    { id: "feedback", header: "Feedback", cell: (s) => <span className="line-clamp-2 max-w-[320px] text-xs text-ink-2">{s.feedback ?? "—"}</span> },
    { id: "by", header: "Shown by", cell: (s) => <span className="whitespace-nowrap text-ink-2">{s.shown_by_name ?? "—"}</span> },
    { id: "source", header: "", cell: (s) => (s.tour_id ? <Badge tone="outline">Tour</Badge> : null) },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Showing activity" actions={can("brokerage", "create") && <Button size="sm" onClick={() => setEditing("new")}><Plus /> Schedule showing</Button>} />
      <DataTable columns={columns} data={data?.items} loading={isLoading} dense onRowClick={(s) => can("brokerage", "edit") && setEditing(s)} empty={<EmptyState title="No showings yet" />} />
      <RecordSheet
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "Schedule showing" : "Update showing"}
        mode={editing === "new" ? "create" : "edit"}
        fields={SHOWING_FIELDS}
        initial={editing && editing !== "new" ? (editing as unknown as Record<string, unknown>) : { status: "scheduled" }}
        onSubmit={(body) => save.mutateAsync({ id: editing && editing !== "new" ? editing.id : undefined, body })}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ seller reports */

function Tally({ title, data }: { title: string; data?: Record<string, number> }) {
  const entries = Object.entries(data ?? {});
  return (
    <div>
      <p className="text-xs text-ink-3">{title}</p>
      {entries.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {entries.map(([k, v]) => (
            <Badge key={k} tone="outline">
              {label(k)} <span className="tabular text-ink">{v}</span>
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-3">—</p>
      )}
    </div>
  );
}

export function SellerReportsPanel({ listing }: { listing: Listing }) {
  const { can } = useAuth();
  const { data } = useQuery({ queryKey: ["brokerage", "seller-reports", listing.id], queryFn: () => api.get<SellerReport[]>(`/listings/${listing.id}/seller-reports`) });
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [commentary, setCommentary] = useState("");
  const generate = useMutate(() => api.post(`/listings/${listing.id}/seller-reports`, { period_start: start || null, period_end: end || null, commentary: commentary || null }));
  const markSent = useMutate(({ id, to }: { id: string; to: string }) => api.patch(`/seller-reports/${id}`, { status: "sent", sent_to: to || null }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          Cadence: <span className="font-medium text-ink">{titleCase(listing.reporting_cadence)}</span>
          {listing.next_report_on && <> · next report due {formatDate(listing.next_report_on)}</>}
        </p>
        {can("brokerage", "create") && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <FileText /> Generate report
          </Button>
        )}
      </div>
      {!data?.length ? (
        <Card>
          <EmptyState icon={<FileText />} title="No seller reports yet" description="Reports summarise inquiries, showings, offers and price changes for the period." />
        </Card>
      ) : (
        data.map((r) => (
          <Card key={r.id}>
            <CardHeader
              title={`${formatDate(r.period_start)} – ${formatDate(r.period_end)}`}
              description={`Generated ${formatDateTime(r.generated_at)}${r.sent_at ? ` · sent ${formatDate(r.sent_at)}${r.sent_to ? ` to ${r.sent_to}` : ""}` : ""}`}
              actions={
                <>
                  <State value={r.status} />
                  {r.status !== "sent" && can("brokerage", "edit") && (
                    <Button
                      size="xs"
                      onClick={() => {
                        const to = window.prompt("Sent to (seller email or name)") ?? "";
                        markSent.mutate({ id: r.id, to }, { onSuccess: () => toast.success("Marked as sent"), onError: (e) => toast.error(errorMessage(e)) });
                      }}
                    >
                      <Send className="!size-3.5" /> Mark sent
                    </Button>
                  )}
                </>
              }
            />
            <CardBody className="grid gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-ink-3">Inquiries</p>
                <p className="text-xl font-semibold tabular">{r.summary.inquiries?.count ?? 0}</p>
              </div>
              <div>
                <p className="text-xs text-ink-3">Showings (completed)</p>
                <p className="text-xl font-semibold tabular">
                  {r.summary.showings?.count ?? 0} <span className="text-sm text-ink-3">({r.summary.showings?.completed ?? 0})</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-ink-3">Offers</p>
                <p className="text-xl font-semibold tabular">{r.summary.offers?.count ?? 0}</p>
                {r.summary.offers?.high != null && <p className="text-xs text-ink-3">High {formatCurrency(r.summary.offers.high, { compact: true })}</p>}
              </div>
              <div>
                <p className="text-xs text-ink-3">Days on market</p>
                <p className="text-xl font-semibold tabular">{r.summary.days_on_market ?? "—"}</p>
              </div>
              <div className="sm:col-span-2">
                <Tally title="Inquiries by source" data={r.summary.inquiries?.by_source} />
              </div>
              <div className="sm:col-span-2">
                <Tally title="Showing interest" data={r.summary.showings?.by_interest} />
              </div>
              {!!r.summary.price_changes?.length && (
                <div className="sm:col-span-4">
                  <p className="text-xs text-ink-3">Price changes</p>
                  {r.summary.price_changes.map((p, i) => (
                    <p key={i} className="text-sm text-ink-2">
                      {formatDate(p.effective_on)}: {formatCurrency(p.previous_price)} → {formatCurrency(p.price)} {p.reason ? `· ${p.reason}` : ""}
                    </p>
                  ))}
                </div>
              )}
              {!!r.summary.showings?.feedback?.length && (
                <div className="sm:col-span-4">
                  <p className="text-xs text-ink-3">Showing feedback</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-2">
                    {r.summary.showings.feedback.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
              {r.commentary && <p className="whitespace-pre-wrap text-sm text-ink-2 sm:col-span-4">{r.commentary}</p>}
            </CardBody>
          </Card>
        ))
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Generate seller report"
        description="Defaults to the period since the last report. The summary is frozen at generation."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={generate.isPending}
              onClick={() =>
                generate.mutate(undefined, {
                  onSuccess: () => {
                    toast.success("Seller report generated");
                    setOpen(false);
                    setCommentary("");
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              Generate
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Period start">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Period end">
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Broker commentary" className="col-span-2">
            <Textarea value={commentary} onChange={(e) => setCommentary(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ offers (deal room submissions) */

export interface OfferRow {
  id: string;
  room_id: string | null;
  listing_id: string | null;
  submitter_name: string | null;
  buyer_entity: string | null;
  person_label: string | null;
  organization_label: string | null;
  price: number;
  earnest_money: number | null;
  due_diligence_days: number | null;
  closing_days: number | null;
  financing_type: string | null;
  contingencies: string[];
  terms: string | null;
  version: number;
  status: string;
  submitted_at: string;
  reviewer_name: string | null;
  review_notes: string | null;
}

const REVIEW_STATUSES = ["under_review", "shortlisted", "countered", "accepted", "rejected"];

export function OffersTable({ params }: { params: Record<string, string> }) {
  const { can } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ["dealroom", "offers", params], queryFn: () => api.get<Page<OfferRow>>("/offer-submissions", { ...params, page_size: 100 }) });
  const review = useMutate(({ id, status }: { id: string; status: string }) => api.post(`/offer-submissions/${id}/review`, { status }), ["dealroom", "brokerage"]);
  const columns: Column<OfferRow>[] = [
    { id: "who", header: "Submitted by", cell: (o) => <div><p className="font-medium text-ink">{o.buyer_entity ?? party(o) ?? o.submitter_name ?? "—"}</p><p className="text-xs text-ink-3">{o.submitter_name ?? ""}{o.version > 1 ? ` · v${o.version}` : ""}</p></div> },
    { id: "price", header: "Price", align: "right", cell: (o) => <span className="font-medium">{formatCurrency(o.price)}</span> },
    { id: "em", header: "Earnest money", align: "right", cell: (o) => formatCurrency(o.earnest_money) },
    { id: "dd", header: "DD / close", align: "right", cell: (o) => <span className="text-ink-2">{o.due_diligence_days ?? "—"}d / {o.closing_days ?? "—"}d</span> },
    { id: "fin", header: "Financing", cell: (o) => <span className="text-ink-2">{titleCase(o.financing_type)}</span> },
    { id: "submitted", header: "Submitted", cell: (o) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(o.submitted_at)}</span> },
    {
      id: "status",
      header: "Status",
      cell: (o) =>
        can("dealroom", "edit") && !["accepted", "rejected", "withdrawn"].includes(o.status) ? (
          <select
            value={o.status}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => review.mutate({ id: o.id, status: e.target.value }, { onSuccess: () => toast.success("Offer updated"), onError: (err) => toast.error(errorMessage(err)) })}
            className="h-7 rounded-md border border-line-strong/80 bg-surface px-1.5 text-xs"
          >
            <option value={o.status}>{label(o.status)}</option>
            {REVIEW_STATUSES.filter((s) => s !== o.status).map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        ) : (
          <State value={o.status} />
        ),
    },
  ];
  return <DataTable columns={columns} data={data?.items} loading={isLoading} dense empty={<EmptyState title="No offers submitted" description="Offers arrive through the deal room submission channel." />} />;
}
