"use client";

import { AlertTriangle, CheckCircle2, Lock, Pencil, RefreshCw } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Progress, Skeleton, TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatDateTime, formatNumber, isOverdue, titleCase, toNumber } from "@/lib/utils";

import { useClosing, useClosingMutation, wireTone, type Closing } from "@/features/closing/api";
import { ChecklistPanel } from "@/features/closing/checklist-panel";
import { HandoffPanel, PostCloseAuditPanel, SnapshotView } from "@/features/closing/post-close";
import { SourcesUsesEditor } from "@/features/closing/sources-uses";
import { WirePanel } from "@/features/closing/wire-panel";

function EditSheet({ c, open, onOpenChange }: { c: Closing; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [f, setF] = useState({ scheduled_closing_on: "", hold_thesis: "", business_plan: "", target_hold_years: "", notes: "" });
  const [coordinator, setCoordinator] = useState<string | null>(null);
  const [manager, setManager] = useState<string | null>(null);
  const save = useClosingMutation(c.id, (body: unknown) => api.patch<Closing>(`/closings/${c.id}`, body));
  const frozen = c.status !== "open";

  useEffect(() => {
    if (open) {
      setF({
        scheduled_closing_on: c.scheduled_closing_on ?? "",
        hold_thesis: c.hold_thesis ?? "",
        business_plan: c.business_plan ?? "",
        target_hold_years: c.target_hold_years?.toString() ?? "",
        notes: c.notes ?? "",
      });
      setCoordinator(c.coordinator_id);
      setManager(c.manager_id);
    }
  }, [open, c]);

  const submit = () => {
    const body = frozen
      ? { notes: f.notes || null }
      : {
          scheduled_closing_on: f.scheduled_closing_on || null,
          hold_thesis: f.hold_thesis || null,
          business_plan: f.business_plan || null,
          target_hold_years: toNumber(f.target_hold_years),
          notes: f.notes || null,
          coordinator_id: coordinator,
          manager_id: manager,
        };
    save.mutate(body, { onSuccess: () => { toast.success("Closing updated"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Edit closing"
      description={frozen ? "Completed closings are frozen; only notes can change." : "Carry-forward fields travel to the asset at completion."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        {!frozen && (
          <>
            <Field label="Scheduled closing date"><Input type="date" value={f.scheduled_closing_on} onChange={(e) => setF({ ...f, scheduled_closing_on: e.target.value })} /></Field>
            <Field label="Closing coordinator"><UserPicker value={coordinator} onChange={setCoordinator} /></Field>
            <Field label="Responsible asset manager"><UserPicker value={manager} onChange={setManager} /></Field>
            <Field label="Hold thesis"><Textarea rows={3} value={f.hold_thesis} onChange={(e) => setF({ ...f, hold_thesis: e.target.value })} /></Field>
            <Field label="Business plan"><Textarea rows={3} value={f.business_plan} onChange={(e) => setF({ ...f, business_plan: e.target.value })} /></Field>
            <Field label="Target hold (years)"><Input inputMode="decimal" value={f.target_hold_years} onChange={(e) => setF({ ...f, target_hold_years: e.target.value })} /></Field>
          </>
        )}
        <Field label="Notes"><Textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Sheet>
  );
}

function CompleteDialog({ c, open, onOpenChange }: { c: Closing; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [closedOn, setClosedOn] = useState("");
  const [note, setNote] = useState("");
  const complete = useClosingMutation(c.id, (body: unknown) => api.post<Closing>(`/closings/${c.id}/complete`, body));
  useEffect(() => {
    if (open) {
      setClosedOn(c.scheduled_closing_on ?? new Date().toISOString().slice(0, 10));
      setNote("");
    }
  }, [open, c]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Complete closing"
      description="Writes the immutable transaction snapshot, creates the owned asset, generates the operations handoff and schedules the 90-day audit."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!closedOn}
            loading={complete.isPending}
            onClick={() =>
              complete.mutate(
                { closed_on: closedOn, note: note || null },
                {
                  onSuccess: (r) => {
                    toast.success(r.asset_pending ? "Closed — asset conversion pending retry" : "Closed — asset created and handed off");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            <CheckCircle2 /> Complete closing
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Closed on" required><Input type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} /></Field>
        <Field label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function Overview({ c, onTab }: { c: Closing; onTab: (t: string) => void }) {
  const blockingItems = c.blockers.filter((b) => b.key.startsWith("item:"));
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        {c.status === "open" && (
          <Card>
            <CardHeader
              title="Readiness"
              description={c.can_complete ? "All controls satisfied" : "The closing cannot complete until these are resolved"}
              actions={c.can_complete ? <Badge tone="green" dot>Ready</Badge> : <Badge tone="red" dot>{c.blockers.length} blocking</Badge>}
            />
            <CardBody className="space-y-2">
              {c.can_complete ? (
                <p className="text-sm text-ink-2">Blocking checklist items are done, wire instructions passed independent callback, and sources equal uses.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {c.blockers.map((b) => (
                    <li key={b.key} className="flex items-start gap-2">
                      <Lock className="mt-0.5 size-3.5 shrink-0 text-negative" />
                      <button
                        className="text-left text-ink hover:underline"
                        onClick={() => onTab(b.key === "wire" ? "wire" : b.key === "sources_uses" || b.key === "price" ? "sources" : "checklist")}
                      >
                        {b.label}
                        {b.detail && <span className="ml-1.5 text-xs text-ink-3">{titleCase(b.detail)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {blockingItems.length > 0 && <p className="pt-1 text-xs text-ink-3">{blockingItems.length} blocking checklist item(s) open.</p>}
            </CardBody>
          </Card>
        )}
        {c.asset_pending && (
          <div className="flex items-start gap-3 rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 text-caution" />
            <div>
              <p className="font-medium text-caution">Asset conversion pending</p>
              <p className="mt-0.5 text-ink-2">{c.asset_error ?? "The asset could not be created at completion."} Use Retry asset conversion once resolved.</p>
            </div>
          </div>
        )}
        <Card>
          <CardHeader title="Transaction" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Purchase price">{c.purchase_price != null ? formatCurrency(c.purchase_price) : null}</FieldItem>
              <FieldItem label="Basis">{c.basis != null ? formatCurrency(c.basis) : null}</FieldItem>
              <FieldItem label="Sources / uses">{c.total_sources != null || c.total_uses != null ? `${formatCurrency(c.total_sources)} / ${formatCurrency(c.total_uses)}` : null}</FieldItem>
              <FieldItem label="Scheduled">{formatDate(c.scheduled_closing_on)}</FieldItem>
              <FieldItem label="Closed on">{c.closed_on ? formatDate(c.closed_on) : null}</FieldItem>
              <FieldItem label="Completed">{c.completed_at ? formatDateTime(c.completed_at) : null}</FieldItem>
              <FieldItem label="Accepted offer">{c.offer_id ? <Link href={`/offers/${c.offer_id}`} className="text-accent hover:underline">Open offer</Link> : null}</FieldItem>
              <FieldItem label="Approved underwriting">{c.uw_model_id ? <Link href={`/underwriting/${c.uw_model_id}`} className="text-accent hover:underline">Open model</Link> : null}</FieldItem>
              <FieldItem label="Asset">{c.asset_id ? <Link href={`/assets/${c.asset_id}`} className="text-accent hover:underline">Open asset</Link> : c.asset_pending ? "Pending" : null}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Carried forward to the asset" description="Capital structure, hold thesis, approved underwriting and responsible manager" />
          <CardBody>
            <FieldGrid cols={2}>
              <FieldItem label="Asset manager">{c.manager_name}</FieldItem>
              <FieldItem label="Target hold">{c.target_hold_years != null ? `${formatNumber(c.target_hold_years, 1)} years` : null}</FieldItem>
              <FieldItem label="Equity">{c.capital_structure?.equity != null ? formatCurrency(c.capital_structure.equity) : null}</FieldItem>
              <FieldItem label="Debt">{c.capital_structure?.debt != null ? formatCurrency(c.capital_structure.debt) : null}</FieldItem>
            </FieldGrid>
            {(c.hold_thesis || c.business_plan) && (
              <dl className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
                {c.hold_thesis && (<div><dt className="text-xs text-ink-3">Hold thesis</dt><dd className="mt-0.5 whitespace-pre-wrap text-ink-2">{c.hold_thesis}</dd></div>)}
                {c.business_plan && (<div><dt className="text-xs text-ink-3">Business plan</dt><dd className="mt-0.5 whitespace-pre-wrap text-ink-2">{c.business_plan}</dd></div>)}
              </dl>
            )}
          </CardBody>
        </Card>
      </div>
      <div className="space-y-5">
        <Card>
          <CardHeader title="Controls" />
          <CardBody className="space-y-4 text-sm">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-ink-3">
                <span>Checklist</span>
                <span className="tabular">{c.items_done}/{c.items_total}</span>
              </div>
              <Progress value={c.items_total ? (c.items_done / c.items_total) * 100 : 0} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-2">Blocking items open</span>
              <Badge tone={c.blocking_open ? "red" : "green"}>{c.blocking_open}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-2">Wire verification</span>
              <Badge tone={wireTone(c.wire_status)} dot>{c.wire_status === "missing" ? "Not recorded" : titleCase(c.wire_status)}</Badge>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="People" />
          <CardBody>
            <FieldGrid cols={1}>
              <FieldItem label="Coordinator">{c.coordinator_name}</FieldItem>
              <FieldItem label="Asset manager">{c.manager_name}</FieldItem>
              <FieldItem label="90-day audit due">{c.audit_due_on ? formatDate(c.audit_due_on) : null}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>
        {c.notes && (
          <Card>
            <CardHeader title="Notes" />
            <CardBody><p className="whitespace-pre-wrap text-sm text-ink-2">{c.notes}</p></CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function ClosingDetail({ id }: { id: string }) {
  const url = useUrlState();
  const { can } = useAuth();
  const { data: c, isLoading, error } = useClosing(id);
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const retry = useClosingMutation(id, () => api.post<Closing>(`/closings/${id}/retry-asset`));
  const tab = url.get("tab") ?? "overview";
  const setTab = (v: string) => url.set({ tab: v === "overview" ? null : v });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !c) {
    return <EmptyState title="Closing not found" description={errorMessage(error)} action={<Link href="/closings"><Button>Back to closings</Button></Link>} />;
  }

  const completeReasons = c.status !== "open" ? `Closing is ${c.status}` : c.blockers.map((b) => b.label).join(" · ");
  const title = c.opportunity_title ?? "Closing";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Closings", href: "/closings" }, { label: title }]}
        title={title}
        description={
          <>
            <Link href={`/pipeline/${c.opportunity_id}`} className="hover:text-ink hover:underline">Opportunity</Link>
            {c.property_label ? <> · {c.property_id ? <Link href={`/properties/${c.property_id}`} className="hover:text-ink hover:underline">{c.property_label}</Link> : c.property_label}</> : null}
          </>
        }
        meta={
          <>
            <StatusBadge status={c.status} />
            {c.status === "open" && (c.can_complete ? <Badge tone="green" dot>Ready to close</Badge> : <Badge tone="red" dot><Lock className="size-3" />Blocked</Badge>)}
            {c.scheduled_closing_on && c.status === "open" && (
              <span className={isOverdue(c.scheduled_closing_on) ? "text-xs font-medium text-negative" : "text-xs text-ink-3"}>Scheduled {formatDate(c.scheduled_closing_on)}</span>
            )}
            {c.asset_pending && <Badge tone="amber">Asset pending</Badge>}
          </>
        }
        actions={
          <>
            {can("closing", "edit") && (
              <Button onClick={() => setEditing(true)}><Pencil /> Edit</Button>
            )}
            {c.asset_pending && can("closing", "edit") && (
              <Button loading={retry.isPending} onClick={() => retry.mutate(undefined, { onSuccess: (r) => toast[r.asset_pending ? "error" : "success"](r.asset_pending ? `Still pending: ${r.asset_error ?? "unknown error"}` : "Asset created"), onError: (e) => toast.error(errorMessage(e)) })}>
                <RefreshCw /> Retry asset conversion
              </Button>
            )}
            {c.status === "open" && can("closing", "approve") && (
              <Tooltip content={c.can_complete ? null : `Cannot complete: ${completeReasons}`}>
                <span>
                  <Button variant="primary" disabled={!c.can_complete} onClick={() => setCompleting(true)}>
                    <CheckCircle2 /> Complete closing
                  </Button>
                </span>
              </Tooltip>
            )}
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "checklist", label: "Checklist", count: c.blocking_open || undefined },
            { value: "wire", label: "Wire verification" },
            { value: "sources", label: "Sources & uses" },
            { value: "handoff", label: "Handoff" },
            { value: "snapshot", label: "Snapshot" },
            { value: "audit", label: "Post-close audit" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="overview"><Overview c={c} onTab={setTab} /></TabPanel>
        <TabPanel value="checklist"><ChecklistPanel closing={c} /></TabPanel>
        <TabPanel value="wire"><WirePanel closing={c} /></TabPanel>
        <TabPanel value="sources"><SourcesUsesEditor closing={c} /></TabPanel>
        <TabPanel value="handoff"><HandoffPanel closing={c} /></TabPanel>
        <TabPanel value="snapshot"><SnapshotView closing={c} /></TabPanel>
        <TabPanel value="audit"><PostCloseAuditPanel closing={c} /></TabPanel>
        <TabPanel value="activity">
          <Card><CardBody><RecordTimeline entityType="closing" entityId={c.id} /></CardBody></Card>
        </TabPanel>
      </Tabs>

      <EditSheet c={c} open={editing} onOpenChange={setEditing} />
      <CompleteDialog c={c} open={completing} onOpenChange={setCompleting} />
    </>
  );
}

export default function ClosingPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <ClosingDetail id={params.id} />
    </Suspense>
  );
}
