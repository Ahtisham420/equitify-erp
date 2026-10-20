"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowRight,
  Ban,
  Check,
  CircleCheck,
  ClipboardCheck,
  FileText,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Scale,
  ShieldAlert,
  Star,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatPercent, formatRelative, titleCase, toNumber } from "@/lib/utils";

import { RecordDocuments } from "@/features/documents/record-documents";
import {
  DOC_ENTITY,
  RESPONSIBILITY,
  WO_FLOW,
  categoryLabel,
  useArchiveWorkOrder,
  useWorkOrder,
  useWorkOrderAction,
  type WorkOrder,
} from "@/features/maintenance/api";
import { MaintenanceBadge, VendorPicker, WorkOrderFormSheet, apiReasons, isPastDue, toastApiError } from "@/features/maintenance/work-order-form";
import { useVendorCompliance } from "@/features/operations/api";

interface TransitionBody {
  status: string;
  note?: string | null;
  completion_notes?: string | null;
  actual_cost?: number | null;
  evidence_document_ids?: string[];
  cancelled_reason?: string | null;
}

const STEP_LABELS: Record<string, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  completed: "Completed",
  verified: "Verified",
};

/* ------------------------------------------------------------------ small pieces */

function ReasonList({ reasons, title, tone = "negative" }: { reasons: string[]; title: string; tone?: "negative" | "caution" }) {
  return (
    <div className={cn("rounded-lg border p-3 text-sm", tone === "negative" ? "border-negative/30 bg-negative-soft" : "border-caution/30 bg-caution-soft")}>
      <p className={cn("flex items-center gap-1.5 font-medium", tone === "negative" ? "text-negative" : "text-caution")}>
        <ShieldAlert className="size-4" />
        {title}
      </p>
      {reasons.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink-2">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Disabled buttons swallow pointer events, so the tooltip sits on a wrapper. */
function Gate({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className="inline-flex rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
        {children}
      </span>
    </Tooltip>
  );
}

function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  required,
  confirmLabel,
  destructive,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  label: string;
  required?: boolean;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Back</Button>
          <Button variant={destructive ? "danger" : "primary"} disabled={required && !text.trim()} loading={loading} onClick={() => onConfirm(text.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label} required={required}>
        <Textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function StatusStepper({ wo }: { wo: WorkOrder }) {
  const history = wo.status_history ?? [];
  const reachedAt = (step: string) => [...history].reverse().find((h) => h.to === step)?.at ?? null;
  const cancelled = wo.status === "cancelled";
  const current = WO_FLOW.indexOf(wo.status as (typeof WO_FLOW)[number]);
  const lastReached = cancelled
    ? Math.max(-1, ...history.filter((h) => h.to !== "cancelled").map((h) => WO_FLOW.indexOf(h.to as (typeof WO_FLOW)[number])))
    : current;

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <ol className="flex min-w-[560px] items-start">
        {WO_FLOW.map((s, i) => {
          const done = cancelled ? i <= lastReached : i < current;
          const isCurrent = !cancelled && i === current;
          const at = i <= lastReached ? reachedAt(s) : null;
          return (
            <li key={s} className="flex flex-1 items-start">
              <div className="flex min-w-[84px] flex-col items-center gap-1 text-center">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-2xs font-semibold",
                    isCurrent
                      ? "border-ink bg-ink text-white"
                      : done
                        ? cancelled
                          ? "border-line-strong bg-muted text-ink-3"
                          : "border-positive bg-positive-soft text-positive"
                        : "border-line-strong bg-surface text-ink-3",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("whitespace-nowrap text-xs", isCurrent ? "font-semibold text-ink" : "text-ink-3")}>{STEP_LABELS[s]}</span>
                <span className="whitespace-nowrap text-2xs text-ink-3 tabular" title={at ? formatDateTime(at) : undefined}>
                  {at ? formatDate(at, "MMM d, h:mm a") : " "}
                </span>
              </div>
              {i < WO_FLOW.length - 1 && <span className={cn("mx-1 mt-3 h-px flex-1", done && !cancelled ? "bg-positive/50" : "bg-line")} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ dialogs */

function AssignDialog({ wo, open, onOpenChange }: { wo: WorkOrder; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [kind, setKind] = useState<"vendor" | "staff">("vendor");
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [serverReasons, setServerReasons] = useState<string[]>([]);
  const assign = useWorkOrderAction<{ assignee_type: "vendor" | "staff"; vendor_id?: string | null; assigned_user_id?: string | null }>(wo.id, "assign");
  const compliance = useVendorCompliance(kind === "vendor" ? vendorId : null);

  useEffect(() => {
    if (!open) return;
    setKind(wo.assignee_type ?? "vendor");
    setVendorId(wo.vendor_id);
    setUserId(wo.assigned_user_id);
    setServerReasons([]);
  }, [open, wo]);

  const blocked = kind === "vendor" && !!compliance.data && !compliance.data.compliant;
  const checking = kind === "vendor" && !!vendorId && compliance.isLoading;
  const ready = kind === "vendor" ? !!vendorId && !blocked && !checking : !!userId;

  const submit = () =>
    assign.mutate(
      kind === "vendor" ? { assignee_type: "vendor", vendor_id: vendorId } : { assignee_type: "staff", assigned_user_id: userId },
      {
        onSuccess: (r) => {
          toast.success(`Assigned to ${r.vendor_name ?? r.assignee_name ?? (kind === "vendor" ? "vendor" : "staff member")}`);
          onOpenChange(false);
        },
        onError: (e) => {
          const reasons = apiReasons(e);
          if (reasons.length) setServerReasons(reasons);
          else toast.error(errorMessage(e));
        },
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={wo.vendor_id || wo.assigned_user_id ? "Reassign work order" : "Assign work order"}
      description="Vendors must hold current credentials; a lapsed license or insurance certificate blocks assignment."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={assign.isPending} onClick={submit}>
            Assign
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Assignee type">
          {(["vendor", "staff"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => {
                setKind(k);
                setServerReasons([]);
              }}
              className={cn("h-8 rounded-md text-sm font-medium transition-colors", kind === k ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink")}
            >
              {k === "vendor" ? "Vendor" : "Staff member"}
            </button>
          ))}
        </div>

        {kind === "vendor" ? (
          <Field label="Vendor" required>
            <VendorPicker
              value={vendorId}
              onChange={(id) => {
                setVendorId(id);
                setServerReasons([]);
              }}
            />
          </Field>
        ) : (
          <Field label="Staff member" required hint="They receive a task linked to this work order.">
            <UserPicker value={userId} onChange={setUserId} />
          </Field>
        )}

        {kind === "vendor" && vendorId && checking && <p className="text-xs text-ink-3">Checking vendor credentials…</p>}
        {kind === "vendor" && compliance.data?.compliant && serverReasons.length === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-positive">
            <CircleCheck className="size-3.5" /> Credentials current
          </p>
        )}
        {blocked && <ReasonList title="Assignment blocked — vendor is not compliant" reasons={compliance.data?.reasons ?? []} />}
        {!blocked && serverReasons.length > 0 && <ReasonList title="Assignment blocked by the server" reasons={serverReasons} />}
      </div>
    </Dialog>
  );
}

function CompleteDialog({
  wo,
  open,
  onOpenChange,
  onRefresh,
  transition,
  loading,
}: {
  wo: WorkOrder;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRefresh: () => void;
  transition: (body: TransitionBody, message: string, onDone?: () => void) => void;
  loading: boolean;
}) {
  const { can } = useAuth();
  const [notes, setNotes] = useState("");
  const [cost, setCost] = useState("");
  const docsAvailable = can("documents");

  useEffect(() => {
    if (!open) return;
    setNotes(wo.completion_notes ?? "");
    setCost(wo.actual_cost != null ? String(wo.actual_cost) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Uploads happen in the documents module; poll the work order so the evidence count stays current.
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(onRefresh, 4000);
    return () => window.clearInterval(t);
  }, [open, onRefresh]);

  const actual = toNumber(cost);
  const missing: string[] = [];
  if (!notes.trim()) missing.push("completion notes");
  if (actual === null || actual < 0) missing.push("actual cost");
  if (docsAvailable && wo.evidence_count === 0) missing.push("at least one evidence file");

  const submit = () => transition({ status: "completed", completion_notes: notes.trim(), actual_cost: actual }, "Marked complete", () => onOpenChange(false));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Complete #${wo.number}`}
      description="Record what was done, the final cost and photo or document evidence. Verification requires evidence and the actual cost."
      className="max-w-2xl"
      footer={
        <>
          {missing.length > 0 && <span className="mr-auto self-center text-xs text-ink-3">Needs {missing.join(", ")}</span>}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={missing.length > 0} loading={loading} onClick={submit}>
            <Check /> Mark complete
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Completion notes" required>
          <Textarea autoFocus rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Work performed, parts replaced, follow-up needed…" />
        </Field>
        <Field label="Actual cost ($)" required hint={wo.estimate_amount != null ? `Estimate was ${formatCurrency(wo.estimate_amount)}` : undefined}>
          <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} className="max-w-[200px]" />
        </Field>
        <div className="space-y-2 rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">Completion evidence</p>
            <span className="flex items-center gap-2 text-xs text-ink-3">
              <span className="tabular">{wo.evidence_count} file{wo.evidence_count === 1 ? "" : "s"}</span>
              <Button size="xs" variant="ghost" onClick={onRefresh} aria-label="Refresh evidence count">
                <RefreshCw className="!size-3" />
              </Button>
            </span>
          </div>
          {docsAvailable ? (
            <RecordDocuments entityType={DOC_ENTITY.workOrderEvidence} entityId={wo.id} />
          ) : (
            <p className="text-xs text-ink-3">You do not have access to upload documents. Ask a colleague to attach evidence before verification.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ cards */

interface SpaceLite {
  id: string;
  suite: string | null;
  floor: string | number | null;
  tenant_name: string | null;
}

function DetailsCard({ wo, onEdit, editable }: { wo: WorkOrder; onEdit: () => void; editable: boolean }) {
  const space = useQuery({
    queryKey: ["properties", wo.property_id, "spaces", "lookup"],
    queryFn: () => api.get<SpaceLite[]>(`/properties/${wo.property_id}/spaces`),
    enabled: !!wo.space_id,
    staleTime: 5 * 60_000,
  });
  const org = useQuery({
    queryKey: ["organizations", wo.tenant_organization_id, "name"],
    queryFn: () => api.get<{ id: string; name: string }>(`/organizations/${wo.tenant_organization_id}`),
    enabled: !!wo.tenant_organization_id,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const s = space.data?.find((x) => x.id === wo.space_id);
  const overdue = isPastDue(wo.due_on, wo.status);

  return (
    <Card>
      <CardHeader
        title="Details"
        actions={
          editable && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil /> Edit
            </Button>
          )
        }
      />
      <CardBody className="space-y-4">
        {wo.description ? <p className="whitespace-pre-wrap text-sm text-ink-2">{wo.description}</p> : <p className="text-sm text-ink-3">No description.</p>}
        <FieldGrid cols={3}>
          <FieldItem label="Property">
            <Link href={`/properties/${wo.property_id}`} className="text-accent hover:underline">
              {wo.property_name ?? "Property"}
            </Link>
          </FieldItem>
          <FieldItem label="Space">{wo.space_id ? (s ? [s.suite ? `Suite ${s.suite}` : "Space", s.tenant_name].filter(Boolean).join(" · ") : "Linked space") : null}</FieldItem>
          <FieldItem label="System / asset">{wo.system}</FieldItem>
          <FieldItem label="Location">{wo.location_detail}</FieldItem>
          <FieldItem label="Category">{categoryLabel(wo.category)}</FieldItem>
          <FieldItem label="Due">{wo.due_on ? <span className={cn(overdue && "font-medium text-negative")}>{formatDate(wo.due_on)}{overdue ? " · overdue" : ""}</span> : null}</FieldItem>
          <FieldItem label="Requested by">{wo.requested_by_name}</FieldItem>
          <FieldItem label="Requester contact">{wo.requester_contact}</FieldItem>
          <FieldItem label="Tenant">{wo.tenant_organization_id ? org.data?.name ?? "Linked organization" : null}</FieldItem>
          <FieldItem label="Reported">{wo.reported_at ? formatDateTime(wo.reported_at) : null}</FieldItem>
          <FieldItem label="Created">{formatDateTime(wo.created_at)}</FieldItem>
          <FieldItem label="Last updated">{formatRelative(wo.updated_at)}</FieldItem>
        </FieldGrid>
      </CardBody>
    </Card>
  );
}

function AssignmentCard({ wo, onAssign, canAssign }: { wo: WorkOrder; onAssign: () => void; canAssign: boolean }) {
  const name = wo.assignee_type === "vendor" ? wo.vendor_name : wo.assignee_name;
  const lapsed = wo.vendor_compliance && !wo.vendor_compliance.compliant;
  return (
    <Card>
      <CardHeader
        title="Assignment"
        actions={
          canAssign && (
            <Button size="sm" variant="ghost" onClick={onAssign}>
              <UserPlus /> {name ? "Reassign" : "Assign"}
            </Button>
          )
        }
      />
      <CardBody className="space-y-3">
        {name ? (
          <div>
            <p className="text-xs text-ink-3">{wo.assignee_type === "vendor" ? "Vendor" : "Staff member"}</p>
            <p className="text-sm font-medium text-ink">
              {wo.assignee_type === "vendor" && wo.vendor_id ? (
                <Link href={`/vendors/${wo.vendor_id}`} className="hover:underline">
                  {name}
                </Link>
              ) : (
                name
              )}
            </p>
            {wo.assigned_at && <p className="text-xs text-ink-3">Assigned {formatRelative(wo.assigned_at)}</p>}
          </div>
        ) : (
          <p className="text-sm text-ink-3">Not assigned yet.</p>
        )}
        {wo.assignee_type === "vendor" && wo.vendor_compliance?.compliant && (
          <p className="flex items-center gap-1.5 text-xs text-positive">
            <CircleCheck className="size-3.5" /> Vendor credentials current
          </p>
        )}
        {lapsed && (
          <ReasonList
            title={["completed", "verified", "cancelled"].includes(wo.status) ? "Vendor credentials have since lapsed" : "Vendor credentials have lapsed — work cannot start"}
            reasons={wo.vendor_compliance?.reasons ?? []}
          />
        )}
      </CardBody>
    </Card>
  );
}

function CostsCard({ wo }: { wo: WorkOrder }) {
  const { can } = useAuth();
  const costs = useWorkOrderAction<{ estimate_amount?: number | null; actual_cost?: number | null; note?: string | null }>(wo.id, "costs");
  const approval = useWorkOrderAction<{ decision: "approved" | "rejected"; note?: string | null }>(wo.id, "approval");
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [form, setForm] = useState({ estimate: "", actual: "", note: "" });
  const locked = wo.status === "verified" || wo.status === "cancelled";
  const variance = wo.actual_cost != null && wo.estimate_amount != null ? wo.actual_cost - wo.estimate_amount : null;

  useEffect(() => {
    if (editing) setForm({ estimate: wo.estimate_amount != null ? String(wo.estimate_amount) : "", actual: wo.actual_cost != null ? String(wo.actual_cost) : "", note: "" });
  }, [editing, wo.estimate_amount, wo.actual_cost]);

  const saveCosts = () => {
    const estimate = toNumber(form.estimate);
    const actual = toNumber(form.actual);
    if ((estimate !== null && estimate < 0) || (actual !== null && actual < 0)) return toast.error("Costs cannot be negative");
    const body: { estimate_amount?: number | null; actual_cost?: number | null; note?: string | null } = { note: form.note.trim() || null };
    if (estimate !== wo.estimate_amount) body.estimate_amount = estimate;
    if (actual !== wo.actual_cost) body.actual_cost = actual;
    if (!("estimate_amount" in body) && !("actual_cost" in body)) return setEditing(false);
    costs.mutate(body, {
      onSuccess: (r) => {
        toast.success(r.approval_status === "pending" ? "Costs saved — estimate now needs approval" : "Costs saved");
        setEditing(false);
      },
      onError: (e) => toastApiError(e),
    });
  };

  const decide = (decision: "approved" | "rejected", note?: string) =>
    approval.mutate(
      { decision, note: note || null },
      {
        onSuccess: () => {
          toast.success(decision === "approved" ? "Estimate approved" : "Estimate rejected");
          setRejecting(false);
        },
        onError: (e) => toastApiError(e),
      },
    );

  return (
    <Card>
      <CardHeader
        title="Costs & approval"
        actions={
          can("maintenance", "edit") &&
          !locked && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil /> Edit costs
            </Button>
          )
        }
      />
      <CardBody className="space-y-4">
        {wo.approval_status === "pending" && (
          <div className="rounded-lg border border-caution/30 bg-caution-soft px-3 py-2.5 text-sm">
            <p className="font-medium text-caution">Awaiting cost approval</p>
            <p className="mt-0.5 text-ink-2">
              The estimate of {formatCurrency(wo.estimate_amount)} exceeds the {formatCurrency(wo.approval_threshold)} threshold. Work cannot start until it is approved.
            </p>
            {can("maintenance", "approve") && (
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" variant="primary" loading={approval.isPending && !rejecting} onClick={() => decide("approved")}>
                  <Check /> Approve
                </Button>
                <Button size="sm" onClick={() => setRejecting(true)}>
                  Reject…
                </Button>
              </div>
            )}
          </div>
        )}
        {wo.approval_status === "rejected" && (
          <div className="rounded-lg border border-negative/30 bg-negative-soft px-3 py-2.5 text-sm">
            <p className="font-medium text-negative">Estimate rejected</p>
            {wo.approval_note && <p className="mt-0.5 text-ink-2">{wo.approval_note}</p>}
            <p className="mt-0.5 text-xs text-ink-3">Revise the estimate to request approval again.</p>
          </div>
        )}
        <FieldGrid cols={3}>
          <FieldItem label="Estimate">{wo.estimate_amount != null ? formatCurrency(wo.estimate_amount) : null}</FieldItem>
          <FieldItem label="Approval threshold">{wo.approval_threshold != null ? formatCurrency(wo.approval_threshold) : null}</FieldItem>
          <FieldItem label="Approval">
            {wo.approval_status === "not_required" ? <span className="text-ink-3">Not required</span> : <MaintenanceBadge value={wo.approval_status} />}
          </FieldItem>
          <FieldItem label="Actual cost">{wo.actual_cost != null ? formatCurrency(wo.actual_cost) : null}</FieldItem>
          <FieldItem label="Variance">
            {variance != null ? <span className={cn(variance > 0 ? "text-negative" : variance < 0 ? "text-positive" : "text-ink")}>{variance > 0 ? "+" : ""}{formatCurrency(variance)}</span> : null}
          </FieldItem>
          <FieldItem label="Decided">{wo.approved_at && wo.approval_status !== "pending" ? formatDateTime(wo.approved_at) : null}</FieldItem>
        </FieldGrid>
        {wo.approval_note && wo.approval_status === "approved" && <p className="text-xs text-ink-3">Approval note: {wo.approval_note}</p>}
      </CardBody>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Edit costs"
        description="Raising the estimate above the threshold, or above an approved amount, sends it back for approval."
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" loading={costs.isPending} onClick={saveCosts}>
              Save costs
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Estimate ($)">
            <Input inputMode="decimal" value={form.estimate} onChange={(e) => setForm((f) => ({ ...f, estimate: e.target.value }))} />
          </Field>
          <Field label="Actual cost ($)">
            <Input inputMode="decimal" value={form.actual} onChange={(e) => setForm((f) => ({ ...f, actual: e.target.value }))} />
          </Field>
          <Field label="Note" className="col-span-2" hint="Recorded in the activity log">
            <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="e.g. Revised vendor quote" />
          </Field>
        </div>
      </Dialog>

      <ReasonDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject estimate?"
        description="The requester sees this note. Work cannot start until a revised estimate is approved."
        label="Reason"
        required
        confirmLabel="Reject estimate"
        destructive
        loading={approval.isPending}
        onConfirm={(note) => decide("rejected", note)}
      />
    </Card>
  );
}

function ResponsibilityCard({ wo }: { wo: WorkOrder }) {
  const { can } = useAuth();
  const determine = useWorkOrderAction<{ responsibility?: string; tenant_share_pct?: number | null; reason?: string }>(wo.id, "responsibility");
  const chargeback = useWorkOrderAction<undefined>(wo.id, "chargeback");
  const [overriding, setOverriding] = useState(false);
  const [form, setForm] = useState({ responsibility: "tenant", share: "", reason: "" });

  useEffect(() => {
    if (overriding) {
      setForm({
        responsibility: wo.tenant_responsibility === "undetermined" ? "tenant" : wo.tenant_responsibility,
        share: wo.tenant_share_pct != null ? String(wo.tenant_share_pct) : "",
        reason: "",
      });
    }
  }, [overriding, wo.tenant_responsibility, wo.tenant_share_pct]);

  const tenantPays = wo.tenant_responsibility === "tenant" || wo.tenant_responsibility === "shared";
  const share = wo.tenant_share_pct ?? (wo.tenant_responsibility === "tenant" ? 100 : wo.tenant_responsibility === "shared" ? 50 : 0);
  const chargeable = tenantPays && (wo.status === "completed" || wo.status === "verified") && !!wo.actual_cost;
  const preview = wo.actual_cost ? Math.round(wo.actual_cost * share) / 100 : null;

  const runDetermine = () =>
    determine.mutate(
      {},
      {
        onSuccess: (r) => toast.success(r.tenant_responsibility === "undetermined" ? "Could not determine from the lease" : `Responsibility: ${titleCase(r.tenant_responsibility)}`, { description: r.responsibility_reason ?? undefined }),
        onError: (e) => toastApiError(e),
      },
    );

  const saveOverride = () => {
    const pct = toNumber(form.share);
    if (pct !== null && (pct < 0 || pct > 100)) return toast.error("Tenant share must be between 0 and 100");
    determine.mutate(
      { responsibility: form.responsibility, tenant_share_pct: pct, reason: form.reason.trim() },
      {
        onSuccess: () => {
          toast.success("Responsibility recorded");
          setOverriding(false);
        },
        onError: (e) => toastApiError(e),
      },
    );
  };

  const runChargeback = () =>
    chargeback.mutate(undefined, {
      onSuccess: (r) => toast.success(`Chargeback of ${formatCurrency(r.chargeback_amount)} created`, { description: "Billing task created for receivables" }),
      onError: (e) => toastApiError(e),
    });

  return (
    <Card>
      <CardHeader
        title="Tenant responsibility"
        description="Determined from lease maintenance obligations, with the clauses relied on."
        actions={
          can("maintenance", "edit") && (
            <>
              <Button size="sm" variant="ghost" loading={determine.isPending && !overriding} onClick={runDetermine}>
                <Scale /> Determine from lease
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOverriding(true)}>
                Override
              </Button>
            </>
          )
        }
      />
      <CardBody className="space-y-4">
        <FieldGrid cols={3}>
          <FieldItem label="Result">
            <MaintenanceBadge value={wo.tenant_responsibility} />
          </FieldItem>
          <FieldItem label="Tenant share">{wo.tenant_share_pct != null ? formatPercent(wo.tenant_share_pct, 0) : null}</FieldItem>
          <FieldItem label="Method">{wo.responsibility_method ? (wo.responsibility_method === "lease_rules" ? "Lease rules" : "Manual") : null}</FieldItem>
        </FieldGrid>
        {wo.responsibility_reason && (
          <div>
            <p className="text-xs text-ink-3">Reason</p>
            <p className="text-sm text-ink-2">{wo.responsibility_reason}</p>
            {wo.responsibility_determined_at && <p className="mt-0.5 text-xs text-ink-3">{formatDateTime(wo.responsibility_determined_at)}</p>}
          </div>
        )}
        {wo.responsibility_basis.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-ink-3">Lease clauses cited</p>
            {wo.responsibility_basis.map((b, i) => (
              <div key={b.clause_id ?? i} className="rounded-md border border-line bg-subtle/60 p-2.5">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                  <MaintenanceBadge value={b.party} />
                  {b.clause_type && <span>{titleCase(b.clause_type)}</span>}
                  {b.clause_ref && <span>· {b.clause_ref}</span>}
                  {b.page != null && <span>· page {b.page}</span>}
                  {b.document_id && (
                    <span className="flex items-center gap-0.5">
                      · <FileText className="size-3" /> source document
                    </span>
                  )}
                </div>
                <blockquote className="mt-1.5 border-l-2 border-line-strong pl-2 text-sm text-ink-2">{b.excerpt}</blockquote>
              </div>
            ))}
          </div>
        )}

        {wo.chargeback_status !== "none" ? (
          <div className="rounded-lg border border-positive/30 bg-positive-soft px-3 py-2.5 text-sm">
            <p className="font-medium text-positive">Billing task created for receivables</p>
            <p className="mt-0.5 text-ink-2">
              Chargeback {formatCurrency(wo.chargeback_amount)}
              {wo.chargeback_status === "pending_manual" ? " · awaiting manual billing" : " · charge posted"}
            </p>
          </div>
        ) : chargeable ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm">
            <p className="text-ink-2">
              Tenant share of actual cost: <span className="font-medium text-ink tabular">{formatCurrency(preview)}</span>
            </p>
            {can("maintenance", "approve") && (
              <Button size="sm" variant="primary" loading={chargeback.isPending} onClick={runChargeback}>
                Create chargeback
              </Button>
            )}
          </div>
        ) : tenantPays ? (
          <p className="text-xs text-ink-3">A chargeback can be created once the work is completed with an actual cost.</p>
        ) : null}
      </CardBody>

      <Dialog
        open={overriding}
        onOpenChange={setOverriding}
        title="Record responsibility manually"
        description="A manual determination replaces the lease-rule result and is kept in the activity log with your reason."
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => setOverriding(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.reason.trim()} loading={determine.isPending} onClick={saveOverride}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Responsibility" required>
            <Select
              value={form.responsibility}
              onChange={(e) => setForm((f) => ({ ...f, responsibility: e.target.value }))}
              options={RESPONSIBILITY.map((r) => ({ value: r, label: titleCase(r) }))}
            />
          </Field>
          <Field label="Tenant share (%)" hint="Defaults by result">
            <Input inputMode="decimal" value={form.share} onChange={(e) => setForm((f) => ({ ...f, share: e.target.value }))} />
          </Field>
          <Field label="Reason" required className="col-span-2">
            <Textarea rows={3} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. Damage caused by tenant contractor" />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}

function SatisfactionCard({ wo }: { wo: WorkOrder }) {
  const { can } = useAuth();
  const rate = useWorkOrderAction<{ rating: number; comment?: string | null }>(wo.id, "satisfaction");
  const [rating, setRating] = useState<number>(wo.satisfaction_rating ?? 0);
  const [comment, setComment] = useState(wo.satisfaction_comment ?? "");
  const editable = can("maintenance", "edit");

  useEffect(() => {
    setRating(wo.satisfaction_rating ?? 0);
    setComment(wo.satisfaction_comment ?? "");
  }, [wo.satisfaction_rating, wo.satisfaction_comment]);

  const dirty = rating !== (wo.satisfaction_rating ?? 0) || comment !== (wo.satisfaction_comment ?? "");

  return (
    <Card>
      <CardHeader title="Tenant satisfaction" description="Rating from the requester once the work is done." />
      <CardBody className="space-y-3">
        <div className="flex gap-1" role="radiogroup" aria-label="Satisfaction rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} of 5`}
              disabled={!editable}
              onClick={() => setRating(n)}
              className={cn(
                "flex size-11 items-center justify-center rounded-md border transition-colors disabled:cursor-default",
                n <= rating ? "border-caution/40 bg-caution-soft text-caution" : "border-line bg-surface text-ink-3 hover:bg-subtle",
              )}
            >
              <Star className={cn("size-5", n <= rating && "fill-current")} />
            </button>
          ))}
        </div>
        <Textarea rows={2} value={comment} disabled={!editable} onChange={(e) => setComment(e.target.value)} placeholder="Comment from the tenant (optional)" />
        {editable && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={!rating || !dirty}
              loading={rate.isPending}
              onClick={() =>
                rate.mutate(
                  { rating, comment: comment.trim() || null },
                  { onSuccess: () => toast.success("Satisfaction recorded"), onError: (e) => toastApiError(e) },
                )
              }
            >
              Save rating
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function EvidenceCard({ wo, onRefresh }: { wo: WorkOrder; onRefresh: () => void }) {
  return (
    <Card>
      <CardHeader
        title="Completion evidence"
        description="Photos or documents proving the work. Required before the work order can be verified."
        actions={
          <span className="flex items-center gap-1.5">
            <Badge tone={wo.evidence_count ? "green" : "outline"}>
              {wo.evidence_count} file{wo.evidence_count === 1 ? "" : "s"}
            </Badge>
            <Button size="icon-sm" variant="ghost" aria-label="Refresh evidence count" onClick={onRefresh}>
              <RefreshCw />
            </Button>
          </span>
        }
      />
      <CardBody className="space-y-3">
        {wo.completion_notes && (
          <div>
            <p className="text-xs text-ink-3">Completion notes</p>
            <p className="whitespace-pre-wrap text-sm text-ink-2">{wo.completion_notes}</p>
            {wo.completed_at && <p className="mt-0.5 text-xs text-ink-3">Completed {formatDateTime(wo.completed_at)}</p>}
          </div>
        )}
        <RecordDocuments entityType={DOC_ENTITY.workOrderEvidence} entityId={wo.id} />
      </CardBody>
    </Card>
  );
}

function OriginCard({ wo }: { wo: WorkOrder }) {
  if (!wo.pm_schedule_id && !wo.inspection_id) return null;
  return (
    <Card>
      <CardHeader title="Origin" />
      <CardBody className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <MaintenanceBadge value={wo.source} />
          <span className="text-ink-3">{wo.source === "preventive" ? "Generated from a maintenance schedule" : "Created from an inspection finding"}</span>
        </div>
        {wo.pm_schedule_id && (
          <Link href="/work-orders?tab=pm" className="flex items-center gap-1 font-medium text-accent hover:underline">
            Preventive maintenance schedules <ArrowRight className="size-3.5" />
          </Link>
        )}
        {wo.inspection_id && (
          <Link href={`/inspections/${wo.inspection_id}`} className="flex items-center gap-1 font-medium text-accent hover:underline">
            <ClipboardCheck className="size-3.5" /> Open inspection <ArrowRight className="size-3.5" />
          </Link>
        )}
      </CardBody>
    </Card>
  );
}

function HistoryCard({ wo }: { wo: WorkOrder }) {
  const entries = [...(wo.status_history ?? [])].reverse();
  return (
    <Card>
      <CardHeader title="Status history" />
      <CardBody>
        {entries.length === 0 ? (
          <p className="text-sm text-ink-3">No status changes yet.</p>
        ) : (
          <ol className="space-y-3">
            {entries.map((h, i) => (
              <li key={`${h.at}-${i}`} className="text-sm">
                <p className="flex flex-wrap items-center gap-1.5">
                  {h.from && (
                    <>
                      <MaintenanceBadge value={h.from} />
                      <ArrowRight className="size-3 text-ink-3" />
                    </>
                  )}
                  <MaintenanceBadge value={h.to} />
                </p>
                <p className="mt-0.5 text-xs text-ink-3" title={formatDateTime(h.at)}>
                  {h.by_name ?? "System"} · {formatRelative(h.at)}
                </p>
                {h.note && <p className="mt-0.5 text-xs text-ink-2">{h.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

function WorkOrderDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: wo, isLoading, error, refetch } = useWorkOrder(id);
  const transitionMut = useWorkOrderAction<TransitionBody>(id, "transition");
  const archive = useArchiveWorkOrder();
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reworking, setReworking] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const tab = url.get("tab") ?? "overview";

  const refresh = useCallback(() => void refetch(), [refetch]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !wo) {
    return <EmptyState title="Work order not found" description={errorMessage(error)} action={<Link href="/work-orders"><Button>Back to work orders</Button></Link>} />;
  }

  const editPerm = can("maintenance", "edit");
  const t = wo.allowed_transitions ?? [];
  const closed = wo.status === "verified" || wo.status === "cancelled";
  const canAssign = editPerm && ["open", "assigned", "in_progress"].includes(wo.status);
  const vendorLapsed = !!wo.vendor_compliance && !wo.vendor_compliance.compliant;

  const startBlock =
    wo.approval_status === "pending"
      ? "The estimate is awaiting cost approval."
      : wo.approval_status === "rejected"
        ? "The estimate was rejected; revise it before starting."
        : vendorLapsed
          ? "The assigned vendor is not compliant."
          : null;
  const verifyBlock =
    wo.evidence_count === 0 && wo.actual_cost == null
      ? "Add completion evidence and record the actual cost first."
      : wo.evidence_count === 0
        ? "Add at least one photo or document as completion evidence first."
        : wo.actual_cost == null
          ? "Record the actual cost first."
          : null;

  const transition = (body: TransitionBody, message: string, onDone?: () => void) =>
    transitionMut.mutate(body, {
      onSuccess: () => {
        toast.success(message);
        onDone?.();
      },
      onError: (e) => toastApiError(e),
    });

  const doArchive = () =>
    archive.mutate(id, {
      onSuccess: () => {
        toast.success("Work order archived");
        router.replace("/work-orders");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const hasAssignee = !!(wo.vendor_id || wo.assigned_user_id);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Work orders", href: "/work-orders" }, { label: `#${wo.number}` }]}
        title={`#${wo.number} ${wo.title}`}
        description={
          <Link href={`/properties/${wo.property_id}`} className="hover:underline">
            {[wo.property_name, wo.system, wo.location_detail].filter(Boolean).join(" · ")}
          </Link>
        }
        meta={
          <>
            <MaintenanceBadge value={wo.status} />
            <StatusBadge status={wo.priority} label={`${titleCase(wo.priority)} priority`} />
            <Badge tone="outline">{categoryLabel(wo.category)}</Badge>
            <MaintenanceBadge value={wo.source} label={`From ${wo.source}`} />
            {wo.approval_status !== "not_required" && <MaintenanceBadge value={wo.approval_status} label={`Approval ${titleCase(wo.approval_status).toLowerCase()}`} />}
            {isPastDue(wo.due_on, wo.status) && <Badge tone="red">Overdue</Badge>}
          </>
        }
        actions={
          editPerm && (
            <>
              {wo.status === "open" && !hasAssignee && (
                <Button variant="primary" onClick={() => setAssigning(true)}>
                  <UserPlus /> Assign
                </Button>
              )}
              {t.includes("in_progress") && wo.status === "assigned" && (
                <Gate reason={startBlock}>
                  <Button variant="primary" disabled={!!startBlock} loading={transitionMut.isPending} onClick={() => transition({ status: "in_progress" }, "Work started")}>
                    <Play /> Start work
                  </Button>
                </Gate>
              )}
              {t.includes("completed") && (
                <Button variant="primary" onClick={() => setCompleting(true)}>
                  <Check /> Mark complete
                </Button>
              )}
              {t.includes("verified") && (
                <Gate reason={verifyBlock}>
                  <Button variant="primary" disabled={!!verifyBlock} loading={transitionMut.isPending} onClick={() => transition({ status: "verified" }, "Completion verified")}>
                    <CircleCheck /> Verify complete
                  </Button>
                </Gate>
              )}
              {wo.status === "cancelled" && t.includes("open") && (
                <Button variant="primary" loading={transitionMut.isPending} onClick={() => transition({ status: "open", note: "Reopened" }, "Work order reopened")}>
                  <RotateCcw /> Reopen
                </Button>
              )}
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent width={220}>
                  {!closed && (
                    <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                      Edit details
                    </MenuItem>
                  )}
                  {canAssign && (
                    <MenuItem icon={<UserPlus />} onSelect={() => setAssigning(true)}>
                      {hasAssignee ? "Reassign" : "Assign"}
                    </MenuItem>
                  )}
                  {(t.includes("open") && wo.status === "assigned") ||
                  (t.includes("assigned") && (wo.status === "in_progress" || (wo.status === "open" && hasAssignee))) ||
                  (t.includes("in_progress") && wo.status === "completed") ? (
                    <>
                      <MenuSeparator />
                      <MenuLabel>Move status</MenuLabel>
                    </>
                  ) : null}
                  {t.includes("assigned") && wo.status === "open" && hasAssignee && (
                    <MenuItem onSelect={() => transition({ status: "assigned" }, "Marked assigned")}>Mark assigned</MenuItem>
                  )}
                  {t.includes("open") && wo.status === "assigned" && (
                    <MenuItem onSelect={() => transition({ status: "open", note: "Returned to open" }, "Returned to open")}>Return to open</MenuItem>
                  )}
                  {t.includes("assigned") && wo.status === "in_progress" && (
                    <MenuItem onSelect={() => transition({ status: "assigned", note: "Paused" }, "Moved back to assigned")}>Pause (back to assigned)</MenuItem>
                  )}
                  {t.includes("in_progress") && wo.status === "completed" && (
                    <MenuItem icon={<RotateCcw />} onSelect={() => setReworking(true)}>
                      Reopen for rework…
                    </MenuItem>
                  )}
                  {t.includes("cancelled") && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Ban />} destructive onSelect={() => setCancelling(true)}>
                        Cancel work order…
                      </MenuItem>
                    </>
                  )}
                  {can("maintenance", "delete") && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                        Archive
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            </>
          )
        }
      />

      <Card className="mb-5">
        <CardBody>
          <StatusStepper wo={wo} />
        </CardBody>
      </Card>

      {wo.status === "cancelled" && (
        <div className="mb-5 rounded-lg border border-negative/30 bg-negative-soft px-4 py-3 text-sm">
          <p className="font-medium text-negative">Cancelled</p>
          <p className="mt-0.5 text-ink-2">{wo.cancelled_reason ?? "No reason recorded."}</p>
        </div>
      )}
      {wo.status === "completed" && verifyBlock && (
        <div className="mb-5 rounded-lg border border-caution/30 bg-caution-soft px-4 py-3 text-sm">
          <p className="font-medium text-caution">Ready to verify once evidence is complete</p>
          <p className="mt-0.5 text-ink-2">{verifyBlock}</p>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="overview">
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
              <DetailsCard wo={wo} editable={editPerm && !closed} onEdit={() => setEditing(true)} />
              <CostsCard wo={wo} />
              <ResponsibilityCard wo={wo} />
              <Card>
                <CardHeader title="Photos" description="Condition photos and documents from the request." />
                <CardBody>
                  <RecordDocuments entityType={DOC_ENTITY.workOrder} entityId={wo.id} />
                </CardBody>
              </Card>
              <EvidenceCard wo={wo} onRefresh={refresh} />
            </div>
            <div className="space-y-5">
              <AssignmentCard wo={wo} canAssign={canAssign} onAssign={() => setAssigning(true)} />
              {(wo.status === "completed" || wo.status === "verified") && <SatisfactionCard wo={wo} />}
              <OriginCard wo={wo} />
              <HistoryCard wo={wo} />
            </div>
          </div>
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="work_order" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      {editPerm && !closed && <WorkOrderFormSheet open={editing} onOpenChange={setEditing} workOrder={wo} />}
      {canAssign && <AssignDialog wo={wo} open={assigning} onOpenChange={setAssigning} />}
      <CompleteDialog wo={wo} open={completing} onOpenChange={setCompleting} onRefresh={refresh} transition={transition} loading={transitionMut.isPending} />
      <ReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={`Cancel #${wo.number}?`}
        description="The work order stays on record with your reason and can be reopened later."
        label="Cancellation reason"
        required
        confirmLabel="Cancel work order"
        destructive
        loading={transitionMut.isPending}
        onConfirm={(reason) => transition({ status: "cancelled", cancelled_reason: reason }, "Work order cancelled", () => setCancelling(false))}
      />
      <ReasonDialog
        open={reworking}
        onOpenChange={setReworking}
        title="Reopen for rework?"
        description="The work order returns to in progress. Existing evidence is kept."
        label="What needs rework"
        confirmLabel="Reopen"
        loading={transitionMut.isPending}
        onConfirm={(note) => transition({ status: "in_progress", note: note || "Reopened for rework" }, "Reopened for rework", () => setReworking(false))}
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this work order?"
        description="It is removed from lists but retained with its full history for audit."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={doArchive}
      />
    </>
  );
}

export default function WorkOrderPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <WorkOrderDetail id={params.id} />
    </Suspense>
  );
}
