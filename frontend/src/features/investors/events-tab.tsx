"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Check, FileText, Plus, RotateCcw, Send, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, FieldGrid, FieldItem, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatDateTime, titleCase, toNumber } from "@/lib/utils";

import { CalcView } from "./allocation-table";
import {
  EVENT_STATUSES,
  EVENT_TONES,
  EVENT_TYPES,
  useAllocations,
  useCapitalEvent,
  useDefaultAllocation,
  useEventAction,
  useEventVersions,
  useFundAllocation,
  type Allocation,
  type EventListItem,
} from "./api";
import { EventWizard } from "./event-wizard";

export function StateBadge({ status }: { status: string }) {
  return (
    <Badge tone={EVENT_TONES[status] ?? "neutral"} dot>
      {titleCase(status)}
    </Badge>
  );
}

const columns: Column<EventListItem>[] = [
  {
    id: "name",
    header: "Event",
    sortKey: "name",
    cell: (e) => (
      <div className="min-w-[220px] max-w-[360px]">
        <p className="truncate font-medium text-ink">{e.name}</p>
        <p className="truncate text-xs text-ink-3">{e.asset_label ?? "—"}</p>
      </div>
    ),
  },
  { id: "type", header: "Type", sortKey: "event_type", cell: (e) => <span className="text-ink-2">{titleCase(e.event_type)}</span> },
  { id: "status", header: "Status", sortKey: "status", cell: (e) => <StateBadge status={e.status} /> },
  { id: "date", header: "Date", sortKey: "event_date", cell: (e) => <span className="whitespace-nowrap text-ink-2">{formatDate(e.event_date)}</span> },
  { id: "amount", header: "Amount", sortKey: "amount", align: "right", cell: (e) => formatCurrency(e.amount) },
  { id: "version", header: "Calc", align: "right", cell: (e) => <span className="text-xs text-ink-3">v{e.version}{e.approved_version ? ` · approved v${e.approved_version}` : ""}</span> },
];

export function EventsTab() {
  const { can } = useAuth();
  const list = useListQuery<EventListItem>("investors", "/investors/capital-events");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const openId = url.get("event");

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, event: _e, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["investors", "event-facets", filterParams],
    queryFn: () => api.get<{ event_type: Record<string, number>; status: Record<string, number> }>("/investors/capital-events/facets", filterParams),
    placeholderData: (p) => p,
  });

  const chips: FilterChip[] = [];
  for (const [key, label] of [["event_type", "Type"], ["status", "Status"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map(titleCase).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="investors" />
                  {can("investors", "create") && (
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Plus />
                      New capital event
                    </Button>
                  )}
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search events…" />
              <FacetFilter label="Type" options={EVENT_TYPES.map((v) => ({ value: v, label: titleCase(v), count: facets?.event_type?.[v] ?? 0 }))} selected={url.getAll("event_type")} onChange={(v) => url.set({ event_type: v })} />
              <FacetFilter label="Status" options={EVENT_STATUSES.map((v) => ({ value: v, label: titleCase(v), count: facets?.status?.[v] ?? 0 }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: "events", q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={(e) => url.set({ event: e.id }, { resetPage: false })}
          empty={<EmptyState icon={<ArrowLeftRight />} title={chips.length || url.get("q") ? "No events match these filters" : "No capital events yet"} description="Calls, distributions and liquidations are calculated from the stored waterfall and routed for approval." />}
        />
      </ListCard>

      <EventWizard open={creating} onOpenChange={setCreating} onCreated={(id) => url.set({ event: id }, { resetPage: false })} />
      <EventSheet id={openId} onClose={() => url.set({ event: null }, { resetPage: false })} />
    </>
  );
}

export function FundDialog({ item, onClose }: { item: Allocation | null; onClose: () => void }) {
  const fund = useFundAllocation();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const outstanding = item ? item.amount - item.funded_amount : 0;
  return (
    <Dialog
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      title={`Confirm funding — ${item?.partner_name ?? ""}`}
      description={`Outstanding ${formatCurrency(outstanding)} of ${formatCurrency(item?.amount)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={fund.isPending}
            onClick={() =>
              item &&
              fund.mutate(
                { id: item.id, amount: toNumber(amount) ?? outstanding, funded_on: date, reference: reference || null },
                {
                  onSuccess: () => {
                    toast.success("Funding recorded in the capital account");
                    setAmount("");
                    setReference("");
                    onClose();
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Record funding
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount received">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(outstanding.toFixed(2))} />
        </Field>
        <Field label="Received on">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Wire reference" className="col-span-2">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function CallItems({ eventId }: { eventId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useAllocations({ event_id: eventId });
  const setDefault = useDefaultAllocation();
  const [funding, setFunding] = useState<Allocation | null>(null);
  const [notice, setNotice] = useState<Allocation | null>(null);

  const cols: Column<Allocation>[] = [
    { id: "partner", header: "Partner", cell: (a) => <span className="font-medium">{a.partner_name}</span> },
    { id: "status", header: "Status", cell: (a) => <div className="flex items-center gap-1"><StateBadge status={a.status} />{a.penalty_flag && <Badge tone="red">Penalty</Badge>}</div> },
    { id: "amount", header: "Called", align: "right", cell: (a) => formatCurrency(a.amount) },
    { id: "funded", header: "Funded", align: "right", cell: (a) => formatCurrency(a.funded_amount) },
    { id: "due", header: "Due", cell: (a) => <span className="whitespace-nowrap text-ink-2">{formatDate(a.due_on)}{a.days_late > 0 ? <span className="ml-1 text-negative">· {a.days_late}d late</span> : null}</span> },
    { id: "interest", header: "Late interest", align: "right", cell: (a) => formatCurrency(Math.max(a.late_interest, a.accrued_late_interest)) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (a) => (
        <div className="flex justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={() => setNotice(a)}>
            <FileText className="!size-3.5" /> Notice
          </Button>
          {can("investors", "edit") && !["funded", "reversed"].includes(a.status) && (
            <Button size="xs" onClick={() => setFunding(a)}>
              <Check className="!size-3.5" /> Fund
            </Button>
          )}
          {can("investors", "approve") && !["funded", "reversed"].includes(a.status) && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                setDefault.mutate(
                  { id: a.id, default_flag: !a.default_flag },
                  { onSuccess: () => toast.success(a.default_flag ? "Default cleared" : "Marked in default"), onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              {a.default_flag ? "Clear default" : "Mark default"}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader title="Call notices & funding" description="Funding confirmations post contributions to capital accounts." />
        <DataTable columns={cols} data={data} loading={isLoading} dense empty={<EmptyState title="No call items" />} />
      </Card>
      <FundDialog item={funding} onClose={() => setFunding(null)} />
      <Dialog open={!!notice} onOpenChange={(o) => !o && setNotice(null)} title="Capital call notice" className="max-w-2xl">
        <pre className="whitespace-pre-wrap rounded-md border border-line bg-subtle p-3 font-mono text-xs text-ink">{notice?.notice_text}</pre>
      </Dialog>
    </>
  );
}

function DistributionRecords({ eventId }: { eventId: string }) {
  const { data, isLoading } = useAllocations({ event_id: eventId });
  const cols: Column<Allocation>[] = [
    { id: "partner", header: "Partner", cell: (a) => <span className="font-medium">{a.partner_name}</span> },
    { id: "status", header: "Status", cell: (a) => <StateBadge status={a.status} /> },
    { id: "paid_on", header: "Paid on", cell: (a) => formatDate(a.paid_on) },
    { id: "tiers", header: "Components", cell: (a) => <span className="text-xs text-ink-2">{a.tiers.map((t) => `${titleCase(t.component)} ${formatCurrency(t.amount)}`).join(" · ")}</span> },
    { id: "amount", header: "Amount", align: "right", cell: (a) => formatCurrency(a.amount) },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Distribution records" />
      <DataTable columns={cols} data={data} loading={isLoading} dense empty={<EmptyState title="No distribution records" />} />
    </Card>
  );
}

function EventSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const { data: e, isLoading } = useCapitalEvent(id);
  const versions = useEventVersions(id);
  const action = useEventAction(id ?? "");
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [reversing, setReversing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [showVersions, setShowVersions] = useState(false);

  const run = (name: "submit" | "approve" | "reject" | "post" | "reverse" | "recalculate", body?: unknown, msg?: string) =>
    action.mutate(
      { action: name, body },
      {
        onSuccess: () => {
          toast.success(msg ?? "Done");
          setDecision(null);
          setReversing(false);
          setNote("");
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  const discard = async () => {
    try {
      await api.delete(`/investors/capital-events/${id}`);
      toast.success("Draft discarded");
      setDiscarding(false);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const name = (uid: string | null) => (uid && e?.actor_names[uid]) || "—";

  return (
    <Sheet
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      className="max-w-5xl"
      title={e?.name ?? "Capital event"}
      description={e ? `${titleCase(e.event_type)} · ${e.asset_label ?? ""} · ${formatDate(e.event_date)}` : undefined}
      footer={
        e && (
          <>
            {["draft", "rejected"].includes(e.status) && can("investors", "edit") && (
              <>
                <Button variant="ghost" onClick={() => setDiscarding(true)}>
                  <Trash2 /> Discard
                </Button>
                <Button loading={action.isPending} onClick={() => run("recalculate", undefined, "Recalculated against current capital accounts")}>
                  <RotateCcw /> Recalculate
                </Button>
                <Button variant="primary" loading={action.isPending} onClick={() => run("submit", undefined, "Submitted for approval")}>
                  <Send /> Submit for approval
                </Button>
              </>
            )}
            {e.status === "pending_approval" && e.can_approve && (
              <>
                <Button onClick={() => setDecision("reject")}>
                  <X /> Reject
                </Button>
                <Button variant="primary" onClick={() => setDecision("approve")}>
                  <Check /> Approve v{e.version}
                </Button>
              </>
            )}
            {e.status === "approved" && can("investors", "approve") && (
              <Button variant="primary" loading={action.isPending} onClick={() => run("post", undefined, e.event_type === "call" ? "Notices issued" : "Posted to capital accounts")}>
                {e.event_type === "call" ? "Issue notices" : "Post to capital accounts"}
              </Button>
            )}
            {e.status === "posted" && can("investors", "approve") && (
              <Button variant="danger" onClick={() => setReversing(true)}>
                Reverse
              </Button>
            )}
          </>
        )
      }
    >
      {isLoading || !e ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-60" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge status={e.status} />
            <Badge tone="outline">Calc v{e.version}</Badge>
            {e.approved_version && <Badge tone="blue">Approved v{e.approved_version}</Badge>}
            <span className="ml-auto text-xl font-semibold tabular">{formatCurrency(e.amount)}</span>
          </div>
          {e.status === "pending_approval" && !e.can_approve && can("investors", "approve") && (
            <p className="rounded-md border border-line bg-subtle px-3 py-2 text-sm text-ink-2">A different approver must review a capital event you submitted.</p>
          )}

          <CalcView calc={e.calc} eventType={e.event_type} />

          {e.status === "posted" && (e.event_type === "call" ? <CallItems eventId={e.id} /> : <DistributionRecords eventId={e.id} />)}

          <Card>
            <CardHeader title="Review trail" actions={<Button size="xs" variant="ghost" onClick={() => setShowVersions((v) => !v)}>{showVersions ? "Hide" : "Show"} versions ({versions.data?.length ?? 0})</Button>} />
            <CardBody>
              <FieldGrid cols={3}>
                <FieldItem label="Created by">{name(e.created_by_id)}</FieldItem>
                <FieldItem label="Submitted">{e.submitted_at ? `${name(e.submitted_by_id)} · ${formatDateTime(e.submitted_at)}` : null}</FieldItem>
                <FieldItem label="Decision">{e.approved_at ? `${name(e.approved_by_id)} · ${formatDateTime(e.approved_at)}` : e.status === "rejected" ? "Rejected" : null}</FieldItem>
                <FieldItem label="Decision note">{e.decision_note}</FieldItem>
                <FieldItem label="Posted">{e.posted_at ? `${name(e.posted_by_id)} · ${formatDateTime(e.posted_at)}` : null}</FieldItem>
                <FieldItem label="Due date">{e.due_on ? formatDate(e.due_on) : null}</FieldItem>
                {e.reversed_at && <FieldItem label="Reversed">{`${formatDateTime(e.reversed_at)} — ${e.reversal_reason ?? ""}`}</FieldItem>}
                {e.notes && <FieldItem label="Notes" className="col-span-3">{e.notes}</FieldItem>}
              </FieldGrid>
              {showVersions && (
                <div className="mt-4 divide-y divide-line rounded-md border border-line">
                  {(versions.data ?? []).map((v) => (
                    <div key={v.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span>
                        Version {v.version} <span className="text-xs text-ink-3">· {formatDateTime(v.created_at)}</span>
                      </span>
                      <span className="text-xs text-ink-2 tabular">
                        {formatCurrency(v.amount)} · {v.calc.allocations?.length ?? 0} partners{v.calc.waterfall ? ` · waterfall v${v.calc.waterfall.version}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      <Dialog
        open={!!decision}
        onOpenChange={(o) => !o && setDecision(null)}
        title={decision === "approve" ? `Approve calculation v${e?.version}` : "Reject calculation"}
        description={decision === "approve" ? "The calculation is re-verified against current capital accounts before approval." : "The event returns to the preparer for changes."}
        footer={
          <>
            <Button onClick={() => setDecision(null)}>Cancel</Button>
            <Button variant={decision === "approve" ? "primary" : "danger"} loading={action.isPending} onClick={() => decision && run(decision, { note: note || null }, decision === "approve" ? "Approved" : "Rejected")}>
              {decision === "approve" ? "Approve" : "Reject"}
            </Button>
          </>
        }
      >
        <Field label="Note">
          <Textarea value={note} onChange={(ev) => setNote(ev.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={reversing}
        onOpenChange={setReversing}
        title="Reverse posted event"
        description="Capital account entries are never deleted; reversing entries are posted with your reason."
        footer={
          <>
            <Button onClick={() => setReversing(false)}>Cancel</Button>
            <Button variant="danger" disabled={note.trim().length < 3} loading={action.isPending} onClick={() => run("reverse", { reason: note.trim() }, "Event reversed")}>
              Post reversing entries
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea value={note} onChange={(ev) => setNote(ev.target.value)} />
        </Field>
      </Dialog>

      <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title="Discard this draft?" description="The calculation history is retained in the audit log." confirmLabel="Discard" destructive onConfirm={discard} />
    </Sheet>
  );
}
