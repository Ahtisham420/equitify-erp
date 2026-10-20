"use client";

import { ArrowRight, Check, FileText, GitBranch, MoreHorizontal, Pencil, Send, ShieldCheck, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDateTime, formatNumber, formatPercent, formatRelative, toNumber } from "@/lib/utils";

import {
  ORIGIN_LABELS,
  STRUCTURE_LABELS,
  useDeleteOffer,
  useOffer,
  useOfferAction,
  useOfferApprovals,
  useOfferDelta,
  useOfferVersions,
  type Offer,
  type OfferListItem,
  type TermDelta,
} from "@/features/offers/api";
import { OfferTermsSheet, fromLocalInput, toLocalInput } from "@/features/offers/offer-form";
import { DeviationText, DueChip, OfferStatusBadge } from "@/features/offers/offer-table";

const days = (v: number | null) => (v != null ? `${formatNumber(v)} days` : null);
const yesNo = (v: boolean) => (v ? "Yes" : "No");

function TermsCard({ o }: { o: Offer }) {
  return (
    <Card>
      <CardHeader title="Terms" description={o.origin === "seller" ? "Counterparty terms, recorded as received" : "Our terms for this version"} />
      <CardBody>
        <FieldGrid cols={3}>
          <FieldItem label="Price">{formatCurrency(o.price)}</FieldItem>
          <FieldItem label="Structure">{STRUCTURE_LABELS[o.structure] ?? o.structure}</FieldItem>
          <FieldItem label="Earnest money">{o.earnest_money != null ? formatCurrency(o.earnest_money) : null}</FieldItem>
          <FieldItem label="Earnest goes hard">{days(o.earnest_money_hard_days)}</FieldItem>
          <FieldItem label="Feasibility">{days(o.feasibility_days)}</FieldItem>
          <FieldItem label="Closing">{days(o.closing_days)}</FieldItem>
          <FieldItem label="Extensions">
            {o.extension_count ? `${o.extension_count} × ${o.extension_days ?? "—"} days${o.extension_cost ? ` @ ${formatCurrency(o.extension_cost)}` : ""}` : null}
          </FieldItem>
          <FieldItem label="Financing contingency">{o.financing_contingency ? `Yes${o.financing_days != null ? ` · ${o.financing_days} days` : ""}` : "No"}</FieldItem>
          <FieldItem label="Title / survey review">{days(o.title_survey_days)}</FieldItem>
          <FieldItem label="Assignment">{yesNo(o.assignment_allowed)}</FieldItem>
          <FieldItem label="Exclusivity">{days(o.exclusivity_days)}</FieldItem>
          <FieldItem label="Expires">{o.expiration_at ? formatDateTime(o.expiration_at) : null}</FieldItem>
          <FieldItem label="Buyer entity">{o.buyer_entity}</FieldItem>
          <FieldItem label="Seller">{o.seller_name}</FieldItem>
        </FieldGrid>
        {(o.title_survey_terms || o.assignment_terms || o.access_terms || o.other_terms || o.notes) && (
          <dl className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
            {[
              ["Title / survey terms", o.title_survey_terms],
              ["Assignment terms", o.assignment_terms],
              ["Access / inspection rights", o.access_terms],
              ["Other terms", o.other_terms],
              ["Internal notes", o.notes],
            ]
              .filter(([, v]) => v)
              .map(([label, v]) => (
                <div key={label as string}>
                  <dt className="text-xs text-ink-3">{label}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap text-ink-2">{v}</dd>
                </div>
              ))}
          </dl>
        )}
      </CardBody>
    </Card>
  );
}

function fmtDeltaValue(d: TermDelta, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return yesNo(v);
  if (typeof v === "number") return ["price", "earnest_money", "extension_cost"].includes(d.field) ? formatCurrency(v) : formatNumber(v);
  if (d.field === "expiration_at") return formatDateTime(String(v));
  if (d.field === "structure") return STRUCTURE_LABELS[String(v)] ?? String(v);
  return String(v);
}

function DeltaCard({ o, versions }: { o: Offer; versions: OfferListItem[] }) {
  const others = versions.filter((v) => v.id !== o.id);
  const [against, setAgainst] = useState<string>(o.parent_offer_id ?? others[0]?.id ?? "");
  useEffect(() => setAgainst(o.parent_offer_id ?? others[0]?.id ?? ""), [o.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, isLoading, error } = useOfferDelta(o.id, against || null, !!against);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Term delta"
        description="What changed between two versions of this negotiation"
        actions={
          others.length > 0 ? (
            <Select
              className="w-48"
              value={against}
              onChange={(e) => setAgainst(e.target.value)}
              options={others.map((v) => ({ value: v.id, label: `Compare with v${v.version} (${v.origin === "seller" ? "counterparty" : "ours"})` }))}
            />
          ) : undefined
        }
      />
      {!against ? (
        <EmptyState title="Only one version" description="Counters create new versions; their differences appear here." />
      ) : isLoading ? (
        <div className="p-4"><Skeleton className="h-24 w-full" /></div>
      ) : error ? (
        <p className="p-4 text-sm text-negative">{errorMessage(error)}</p>
      ) : data && data.changes.length === 0 ? (
        <EmptyState title="No term changes" description={`v${data.from_version} and v${data.to_version} have identical terms.`} />
      ) : data ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-subtle text-left text-xs text-ink-3">
              <th className="px-4 py-2 font-medium">Term</th>
              <th className="px-4 py-2 text-right font-medium">v{data.from_version}</th>
              <th className="w-6" />
              <th className="px-4 py-2 text-right font-medium">v{data.to_version}</th>
              <th className="px-4 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {data.changes.map((d) => (
              <tr key={d.field} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-ink-2">{d.label}</td>
                <td className="px-4 py-2 text-right tabular text-ink-3 line-through decoration-ink-3/40">{fmtDeltaValue(d, d.from_value)}</td>
                <td className="text-center text-ink-3"><ArrowRight className="inline size-3.5" /></td>
                <td className="px-4 py-2 text-right font-medium tabular text-ink">{fmtDeltaValue(d, d.to_value)}</td>
                <td className={cn("px-4 py-2 text-right tabular", d.change != null && d.change > 0 ? "text-caution" : "text-ink-2")}>
                  {d.change != null ? `${d.change > 0 ? "+" : ""}${["price", "earnest_money", "extension_cost"].includes(d.field) ? formatCurrency(d.change) : formatNumber(d.change)}` : ""}
                  {d.change_pct != null ? <span className="ml-1 text-xs text-ink-3">({d.change_pct > 0 ? "+" : ""}{formatNumber(d.change_pct, 1)}%)</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}

function VersionTimeline({ o, versions }: { o: Offer; versions: OfferListItem[] }) {
  return (
    <Card>
      <CardHeader title="Versions" description="Every counter is retained" />
      <CardBody className="p-0">
        <ol className="divide-y divide-line">
          {[...versions].reverse().map((v) => (
            <li key={v.id}>
              <Link href={`/offers/${v.id}`} className={cn("flex items-start gap-3 px-4 py-2.5 hover:bg-subtle/60", v.id === o.id && "bg-accent-soft/50")}>
                <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold tabular", v.origin === "seller" ? "border-info/30 text-info" : "border-line-strong text-ink-2")}>
                  v{v.version}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-ink">{formatCurrency(v.price)}</span>
                    <OfferStatusBadge status={v.status} />
                  </div>
                  <p className="text-xs text-ink-3">
                    {v.origin === "seller" ? "Counterparty" : "Ours"} · {formatRelative(v.created_at)}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}

function ApprovalPanel({ o }: { o: Offer }) {
  const { data: approvals = [] } = useOfferApprovals(o.id);
  const action = useOfferAction(o.id);
  const [note, setNote] = useState("");
  const decide = (decision: "approved" | "rejected") =>
    action.mutate(
      { action: "approve", body: { decision, note: note || null } },
      {
        onSuccess: () => {
          toast.success(decision === "approved" ? "Approval recorded" : "Offer returned to draft");
          setNote("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Card>
      <CardHeader
        title="Approval"
        description={o.approval_required ? `${o.approvals_required} approval${o.approvals_required > 1 ? "s" : ""} required` : "Within approval thresholds"}
        actions={o.status === "pending_approval" ? <Badge tone="amber">{o.approvals_received}/{o.approvals_required}</Badge> : undefined}
      />
      <CardBody className="space-y-3">
        {o.approval_reasons.length > 0 && (
          <ul className="space-y-1 text-xs text-ink-2">
            {o.approval_reasons.map((r) => (
              <li key={r} className="flex gap-1.5"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-caution" />{r}</li>
            ))}
          </ul>
        )}
        {o.can_approve && (
          <div className="space-y-2 rounded-lg border border-line bg-subtle/60 p-3">
            <Textarea rows={2} placeholder="Note (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => decide("rejected")} disabled={!note.trim()} loading={action.isPending}>
                <X /> Reject
              </Button>
              <Button size="sm" variant="primary" onClick={() => decide("approved")} loading={action.isPending}>
                <Check /> Approve
              </Button>
            </div>
          </div>
        )}
        {approvals.length > 0 ? (
          <ul className="space-y-2 border-t border-line pt-3">
            {approvals.map((a) => (
              <li key={a.id} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{a.approver_name ?? "Unknown"}</span>
                  <Badge tone={a.decision === "approved" ? "green" : "red"}>{a.decision === "approved" ? "Approved" : "Rejected"}</Badge>
                </div>
                <p className="text-ink-3">{formatDateTime(a.decided_at)} · submission {a.submission_no} · {formatCurrency(a.price)}</p>
                {a.note && <p className="mt-0.5 text-ink-2">{a.note}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">No approval decisions yet.</p>
        )}
      </CardBody>
    </Card>
  );
}

function SendDialog({ o, open, onOpenChange }: { o: Offer; open: boolean; onOpenChange: (v: boolean) => void }) {
  const action = useOfferAction(o.id);
  const [sentTo, setSentTo] = useState("");
  const [via, setVia] = useState("email");
  const [due, setDue] = useState("");
  useEffect(() => {
    if (open) {
      setSentTo(o.seller_name ?? "");
      setDue(toLocalInput(o.expiration_at));
    }
  }, [open, o]);
  const send = () =>
    action.mutate(
      { action: "send", body: { sent_to: sentTo || null, sent_via: via || null, response_due_at: fromLocalInput(due) } },
      {
        onSuccess: () => {
          toast.success("Offer sent; response clock started");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Send offer v${o.version}`}
      description="The LOI is frozen as sent. A response critical date and a follow-up task are created."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={action.isPending} onClick={send}><Send /> Mark as sent</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sent to" className="col-span-2"><Input value={sentTo} onChange={(e) => setSentTo(e.target.value)} placeholder="Seller, broker or counsel" /></Field>
        <Field label="Via">
          <Select value={via} onChange={(e) => setVia(e.target.value)} options={["email", "broker", "portal", "mail", "in_person"].map((v) => ({ value: v, label: v.replace("_", " ").replace(/^./, (c) => c.toUpperCase()) }))} />
        </Field>
        <Field label="Response due" hint="Defaults to the offer expiration or the standard window.">
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function RespondDialog({ o, open, onOpenChange, preset }: { o: Offer; open: boolean; onOpenChange: (v: boolean) => void; preset: string }) {
  const action = useOfferAction(o.id);
  const [outcome, setOutcome] = useState(preset);
  const [note, setNote] = useState("");
  const [winPrice, setWinPrice] = useState("");
  const [winBuyer, setWinBuyer] = useState("");
  const [winSource, setWinSource] = useState("");
  useEffect(() => {
    if (open) {
      setOutcome(preset);
      setNote("");
      setWinPrice("");
      setWinBuyer("");
      setWinSource("");
    }
  }, [open, preset]);
  const options =
    o.status === "sent"
      ? ["accepted", "rejected", "withdrawn", "expired"]
      : o.status === "countered"
        ? ["accepted", "rejected", "withdrawn"]
        : ["withdrawn"];
  const lost = ["rejected", "withdrawn", "expired"].includes(outcome);
  const submit = () =>
    action.mutate(
      {
        action: "respond",
        body: {
          outcome,
          note: note || null,
          winning_price: lost ? toNumber(winPrice) : null,
          winning_buyer: lost ? winBuyer || null : null,
          winning_price_source: lost && toNumber(winPrice) ? winSource || null : null,
        },
      },
      {
        onSuccess: () => {
          toast.success(outcome === "accepted" ? "Offer accepted — opportunity advanced toward under contract" : `Outcome recorded: ${outcome}`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record outcome"
      description={o.origin === "seller" && outcome === "accepted" ? "Accepting the counterparty counter is a named approval within your offer limit." : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={outcome === "accepted" ? "primary" : "secondary"} loading={action.isPending} onClick={submit}>Record</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Outcome" className="col-span-2">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} options={options.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))} />
        </Field>
        <Field label="Note" className="col-span-2"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {lost && (
          <>
            <Field label="Winning price ($)" hint="If discoverable"><Input inputMode="decimal" value={winPrice} onChange={(e) => setWinPrice(e.target.value)} /></Field>
            <Field label="Winning buyer"><Input value={winBuyer} onChange={(e) => setWinBuyer(e.target.value)} /></Field>
            <Field label="Source of winning price" className="col-span-2"><Input value={winSource} onChange={(e) => setWinSource(e.target.value)} placeholder="e.g. broker call, recorded deed" /></Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

function WinningPriceDialog({ o, open, onOpenChange }: { o: Offer; open: boolean; onOpenChange: (v: boolean) => void }) {
  const action = useOfferAction(o.id);
  const [price, setPrice] = useState("");
  const [buyer, setBuyer] = useState("");
  const [source, setSource] = useState("");
  useEffect(() => {
    if (open) {
      setPrice(o.winning_price?.toString() ?? "");
      setBuyer(o.winning_buyer ?? "");
      setSource(o.winning_price_source ?? "");
    }
  }, [open, o]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Winning price"
      description="Capture what the property traded for when it becomes known."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!toNumber(price) || !source.trim()}
            loading={action.isPending}
            onClick={() =>
              action.mutate(
                { action: "winning-price", body: { winning_price: toNumber(price), winning_buyer: buyer || null, winning_price_source: source } },
                { onSuccess: () => { toast.success("Winning price recorded"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Winning price ($)" required><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Winning buyer"><Input value={buyer} onChange={(e) => setBuyer(e.target.value)} /></Field>
        <Field label="Source" required className="col-span-2"><Input value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function OfferDetail({ id }: { id: string }) {
  const router = useRouter();
  const { can } = useAuth();
  const { data: o, isLoading, error } = useOffer(id);
  const { data: versions = [] } = useOfferVersions(id);
  const action = useOfferAction(id);
  const del = useDeleteOffer();
  const [sheet, setSheet] = useState<null | "edit" | "counter" | "record_counter">(null);
  const [sending, setSending] = useState(false);
  const [responding, setResponding] = useState<string | null>(null);
  const [winning, setWinning] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !o) {
    return <EmptyState title="Offer not found" description={errorMessage(error)} action={<Link href="/offers"><Button>Back to offers</Button></Link>} />;
  }

  const edit = can("offers", "edit");
  const latest = o.is_latest;
  const lost = ["rejected", "expired", "withdrawn"].includes(o.status);
  const submit = () =>
    action.mutate(
      { action: "submit" },
      {
        onSuccess: (r) => toast.success(r.status === "approved" ? "Within thresholds — approved" : `Routed for ${r.approvals_required} approval(s)`),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const primary = (() => {
    if (!edit || !latest) return null;
    if (o.status === "draft" && o.origin === "buyer")
      return (
        <>
          <Button onClick={() => setSheet("edit")}><Pencil /> Edit terms</Button>
          <Button variant="primary" onClick={submit} loading={action.isPending}>Submit for approval</Button>
        </>
      );
    if (o.status === "approved")
      return (
        <>
          <Link href={`/offers/${o.id}/loi`}><Button><FileText /> LOI</Button></Link>
          <Button variant="primary" onClick={() => setSending(true)}><Send /> Send</Button>
        </>
      );
    if (o.status === "sent")
      return (
        <>
          <Button onClick={() => setSheet("record_counter")}><GitBranch /> Record counter</Button>
          <Button variant="primary" onClick={() => setResponding("accepted")}>Record response</Button>
        </>
      );
    if (o.status === "countered" && o.origin === "seller")
      return (
        <>
          <Button onClick={() => setResponding("rejected")}>Reject</Button>
          <Button onClick={() => setSheet("counter")}><GitBranch /> Counter</Button>
          {can("offers", "approve") && <Button variant="primary" onClick={() => setResponding("accepted")}><Check /> Accept counter</Button>}
        </>
      );
    if (lost)
      return (
        <>
          <Button onClick={() => setWinning(true)}>Winning price</Button>
          <Button onClick={() => setSheet("counter")}><GitBranch /> Re-engage with counter</Button>
        </>
      );
    return null;
  })();

  const canWithdraw = edit && latest && ["draft", "pending_approval", "approved"].includes(o.status);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Offers", href: "/offers" }, { label: `${o.opportunity_title ?? "Offer"} · v${o.version}` }]}
        title={`${formatCurrency(o.price)} · v${o.version}`}
        description={
          <>
            <Link href={`/pipeline/${o.opportunity_id}`} className="hover:text-ink hover:underline">{o.opportunity_title}</Link>
            {o.property_label ? ` · ${o.property_label}` : ""}
          </>
        }
        meta={
          <>
            <OfferStatusBadge status={o.status} />
            <Badge tone={o.origin === "seller" ? "sky" : "outline"}>{ORIGIN_LABELS[o.origin]}</Badge>
            {!latest && <Badge tone="neutral">Superseded by a later version</Badge>}
            <DueChip o={o} />
          </>
        }
        actions={
          <>
            {o.has_loi && o.status !== "approved" && (
              <Link href={`/offers/${o.id}/loi`}><Button><FileText /> LOI as sent</Button></Link>
            )}
            {primary}
            {(canWithdraw || (o.status === "draft" && o.version === 1 && can("offers", "delete"))) && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions"><MoreHorizontal /></Button>
                </MenuTrigger>
                <MenuContent>
                  {canWithdraw && <MenuItem onSelect={() => setResponding("withdrawn")}>Withdraw offer</MenuItem>}
                  {o.status === "draft" && o.version === 1 && can("offers", "delete") && (
                    <MenuItem icon={<Trash2 />} destructive onSelect={() => setDeleting(true)}>Delete draft</MenuItem>
                  )}
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      {o.status === "expired" && (
        <div className="mb-5 rounded-lg border border-negative/30 bg-negative-soft p-3 text-sm">
          <p className="font-medium text-negative">Expired {o.expired_at ? formatRelative(o.expired_at) : ""} without a response</p>
          <p className="mt-0.5 text-ink-2">An escalation task was created. Re-engage with a counter, or record the winning price if it becomes known.</p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <TermsCard o={o} />
          <DeltaCard o={o} versions={versions} />
          <Card>
            <CardHeader title="Activity" />
            <CardBody>
              <RecordTimeline entityType="offer" entityId={o.id} />
            </CardBody>
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Underwriting basis" description="Offers stay tied to an approved model" />
            <CardBody>
              <FieldGrid cols={1}>
                <FieldItem label="Approved model">
                  <Link href={`/underwriting/${o.uw_model_id}`} className="text-accent hover:underline">
                    Model{o.uw_model_version != null ? ` v${o.uw_model_version}` : ""}
                  </Link>
                </FieldItem>
                <FieldItem label="Model purchase price">{o.model_price != null ? formatCurrency(o.model_price) : null}</FieldItem>
                <FieldItem label="Deviation from model"><DeviationText value={o.deviation_pct} /></FieldItem>
                {typeof o.model_outputs.going_in_cap === "number" && (
                  <FieldItem label="Going-in cap (model)">
                    {formatPercent((o.model_outputs.going_in_cap as number) < 1 ? (o.model_outputs.going_in_cap as number) * 100 : (o.model_outputs.going_in_cap as number), 2)}
                  </FieldItem>
                )}
              </FieldGrid>
            </CardBody>
          </Card>
          {o.origin === "buyer" && <ApprovalPanel o={o} />}
          <Card>
            <CardHeader title="Response clock" />
            <CardBody>
              <FieldGrid cols={1}>
                <FieldItem label="Sent">{o.sent_at ? `${formatDateTime(o.sent_at)}${o.sent_to ? ` · ${o.sent_to}` : ""}` : null}</FieldItem>
                <FieldItem label="Response due">{o.response_due_at ? formatDateTime(o.response_due_at) : null}</FieldItem>
                <FieldItem label="Responded">{o.responded_at ? formatDateTime(o.responded_at) : null}</FieldItem>
                {o.response_note && <FieldItem label="Response note">{o.response_note}</FieldItem>}
                {o.winning_price != null && (
                  <FieldItem label="Winning price">
                    {formatCurrency(o.winning_price)}
                    {o.winning_buyer ? ` · ${o.winning_buyer}` : ""}
                    {o.winning_price_source ? ` (${o.winning_price_source})` : ""}
                  </FieldItem>
                )}
              </FieldGrid>
            </CardBody>
          </Card>
          <VersionTimeline o={o} versions={versions} />
        </div>
      </div>

      {sheet && (
        <OfferTermsSheet
          open={!!sheet}
          onOpenChange={(v) => !v && setSheet(null)}
          offer={o}
          mode={sheet}
          onSaved={(n) => n.id !== o.id && router.push(`/offers/${n.id}`)}
        />
      )}
      <SendDialog o={o} open={sending} onOpenChange={setSending} />
      <RespondDialog o={o} open={!!responding} onOpenChange={(v) => !v && setResponding(null)} preset={responding ?? "accepted"} />
      <WinningPriceDialog o={o} open={winning} onOpenChange={setWinning} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this draft?"
        description="Only an unsent first draft can be deleted. Sent offers are withdrawn instead and always retained."
        confirmLabel="Delete"
        destructive
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(o.id, {
            onSuccess: () => {
              toast.success("Draft deleted");
              router.replace("/offers");
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

export default function OfferPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <OfferDetail id={params.id} />
    </Suspense>
  );
}
