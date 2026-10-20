"use client";

import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Archive,
  ArrowRight,
  Ban,
  Calculator,
  Check,
  CheckCircle2,
  Circle,
  FileText,
  Gavel,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker } from "@/components/data/entity-picker";
import { EmptyState, FieldGrid, FieldItem, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Checkbox, Skeleton, TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { RecordDocuments } from "@/features/documents/record-documents";
import { useUrlState } from "@/hooks/use-url-state";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, isOverdue, titleCase, toNumber } from "@/lib/utils";

import {
  PROJECT_FLOW,
  useArchiveProject,
  useProject,
  useProjectAction,
  useSaveProject,
  useVendorCompliance,
  type Bid,
  type BudgetEntry,
  type ChangeOrder,
  type Draw,
  type Project,
  type ProjectApproval,
  type Recoverability,
  type VendorListItem,
} from "@/features/operations/api";
import { ProjectFormSheet, ProjectStatusBadge, categoryLabel } from "@/features/operations/project-form";
import { ComplianceBadge, serviceLabel } from "@/features/operations/vendor-form";

/* ================================================================== helpers */

interface Failure {
  message: string;
  reasons: string[];
}

function toFailure(e: unknown): Failure {
  let reasons: string[] = [];
  if (e instanceof ApiError && e.detail && typeof e.detail === "object" && !Array.isArray(e.detail)) {
    const r = (e.detail as { reasons?: unknown }).reasons;
    if (Array.isArray(r)) reasons = r.map(String);
  }
  return { message: errorMessage(e), reasons };
}

const today = () => format(new Date(), "yyyy-MM-dd");

function signedCurrency(n: number): string {
  if (n === 0) return formatCurrency(0);
  return `${n > 0 ? "+" : "−"}${formatCurrency(Math.abs(n))}`;
}

const BID_TONES: Record<string, Tone> = { submitted: "sky", shortlisted: "blue", awarded: "green", rejected: "red", withdrawn: "neutral" };
const DRAW_TONES: Record<string, Tone> = { requested: "amber", approved: "blue", paid: "green", rejected: "red" };
const ENTRY_TONES: Record<string, Tone> = { original: "neutral", change_order: "blue", revision: "amber" };

function ToneBadge({ status, tones }: { status: string; tones: Record<string, Tone> }) {
  return (
    <Badge tone={tones[status] ?? "neutral"} dot>
      {titleCase(status)}
    </Badge>
  );
}

/** Wraps a project mutation with consistent toasts and 422/403 handling. */
function useAct(projectId: string) {
  const m = useProjectAction(projectId);
  const run = (path: string, body: unknown, success: string, opts: { onDone?: () => void; onFail?: (f: Failure) => void } = {}) =>
    m.mutate(
      { path, body },
      {
        onSuccess: () => {
          toast.success(success);
          opts.onDone?.();
        },
        onError: (e) => {
          const f = toFailure(e);
          if (opts.onFail) opts.onFail(f);
          else toast.error(f.message, { description: f.reasons.length ? f.reasons.join(" · ") : undefined });
        },
      },
    );
  return { run, pending: m.isPending };
}

function FailurePanel({ failure }: { failure: Failure | null }) {
  if (!failure) return null;
  return (
    <div className="flex gap-2.5 rounded-lg border border-negative/30 bg-negative-soft px-3 py-2.5 text-sm">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-negative" />
      <div className="min-w-0">
        <p className="font-medium text-negative">{failure.message}</p>
        {failure.reasons.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-2">
            {failure.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Notice({ tone = "caution", children }: { tone?: "caution" | "info"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-sm",
        tone === "caution" ? "border-caution/30 bg-caution-soft text-ink-2" : "border-line bg-subtle/60 text-ink-2",
      )}
    >
      {children}
    </div>
  );
}

function ActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  noteLabel = "Note",
  notePlaceholder,
  noteRequired,
  hideNote,
  confirmDisabled,
  pending,
  failure,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  noteLabel?: string;
  notePlaceholder?: string;
  noteRequired?: boolean;
  hideNote?: boolean;
  confirmDisabled?: boolean;
  pending?: boolean;
  failure?: Failure | null;
  onConfirm: (note: string) => void;
  children?: ReactNode;
}) {
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) setNote("");
  }, [open]);
  const blocked = !!confirmDisabled || (!!noteRequired && !note.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? "danger" : "primary"} disabled={blocked} loading={pending} onClick={() => onConfirm(note.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        {!hideNote && (
          <Field label={noteLabel} required={noteRequired}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={notePlaceholder} />
          </Field>
        )}
        <FailurePanel failure={failure ?? null} />
      </div>
    </Dialog>
  );
}

interface DocsTarget {
  entityType: string;
  entityId: string;
  title: string;
  description?: string;
}

function DocsDialog({ target, onClose }: { target: DocsTarget | null; onClose: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()} title={target?.title ?? "Documents"} description={target?.description} className="max-w-3xl">
      {target && <RecordDocuments entityType={target.entityType} entityId={target.entityId} />}
    </Dialog>
  );
}

function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/** A disabled control with the reason it is disabled shown on hover. */
function Blocked({ reason, children }: { reason: ReactNode; children: ReactNode }) {
  return (
    <Tooltip content={reason}>
      <span className="inline-flex">{children}</span>
    </Tooltip>
  );
}

/* ================================================================== header pieces */

function StatusStepper({ status }: { status: string }) {
  const idx = (PROJECT_FLOW as readonly string[]).indexOf(status);
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <ol className="flex min-w-[760px] items-center">
        {PROJECT_FLOW.map((s, i) => {
          const done = idx !== -1 && (i < idx || (s === "closed" && status === "closed"));
          const current = s === status && s !== "closed";
          return (
            <li key={s} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-1">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-2xs font-semibold",
                    current ? "border-ink bg-ink text-white" : done ? "border-positive bg-positive-soft text-positive" : "border-line-strong bg-surface text-ink-3",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("whitespace-nowrap text-2xs", current ? "font-semibold text-ink" : "text-ink-3")}>{titleCase(s)}</span>
              </div>
              {i < PROJECT_FLOW.length - 1 && <span className={cn("mx-1 mb-4 h-px flex-1", done ? "bg-positive/50" : "bg-line")} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function BudgetPanel({ p }: { p: Project }) {
  const scale = Math.max(p.current_budget, p.committed, p.spent, 1);
  const over = p.committed > p.current_budget + 0.005;
  const bars: { label: string; value: number; cls: string }[] = [
    { label: "Current budget", value: p.current_budget, cls: "bg-ink-3" },
    { label: "Committed", value: p.committed, cls: over ? "bg-negative" : "bg-accent" },
    { label: "Spent", value: p.spent, cls: "bg-caution" },
    { label: "Paid", value: p.paid, cls: "bg-positive" },
  ];
  const cards: { label: string; value: number; hint?: string; tone?: "negative" | "positive" | "caution" }[] = [
    { label: "Original budget", value: p.original_budget },
    { label: "Current budget", value: p.current_budget, hint: p.contingency ? `incl. ${formatCurrency(p.contingency)} contingency` : undefined },
    { label: "Committed", value: p.committed, hint: "Awarded contract" },
    { label: "Spent", value: p.spent, hint: "Approved and paid draws" },
    { label: "Paid", value: p.paid },
    { label: "Remaining", value: p.remaining, hint: "Current budget less committed", tone: p.remaining < 0 ? "negative" : undefined },
    { label: "Approved change orders", value: p.approved_change_orders, tone: p.approved_change_orders > 0 ? "caution" : undefined },
  ];
  return (
    <div className="mb-5 space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {cards.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            value={<span title={formatCurrency(c.value)}>{formatCurrency(c.value, { compact: Math.abs(c.value) >= 100_000 })}</span>}
            hint={c.hint}
            tone={c.tone}
          />
        ))}
      </div>
      <Card>
        <CardBody className="space-y-2">
          {bars.map((b) => (
            <div key={b.label} className="grid grid-cols-[120px_1fr_110px] items-center gap-3 text-xs">
              <span className="text-ink-3">{b.label}</span>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", b.cls)} style={{ width: `${Math.min(100, (100 * Math.max(0, b.value)) / scale)}%` }} />
              </div>
              <span className="text-right text-ink-2 tabular">{formatCurrency(b.value)}</span>
            </div>
          ))}
          {over && <p className="pt-1 text-xs text-negative">Committed amount exceeds the current budget.</p>}
        </CardBody>
      </Card>
    </div>
  );
}

/* ================================================================== overview */

function OverviewTab({ p }: { p: Project }) {
  const { can } = useAuth();
  const save = useSaveProject(p.id);
  const editable = can("operations", "edit") && !["closed", "cancelled"].includes(p.status);
  const done = p.milestones.filter((m) => m.completed_on).length;

  const toggle = (key: string, checked: boolean) =>
    save.mutate(
      { milestones: p.milestones.map((m) => (m.key === key ? { ...m, completed_on: checked ? today() : null } : m)) },
      { onError: (e) => toast.error(errorMessage(e)) },
    );

  const warrantyDays = p.warranty_expires_on ? Math.ceil((new Date(p.warranty_expires_on).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Scope" />
          <CardBody>
            {p.scope ? <p className="whitespace-pre-wrap text-sm text-ink-2">{p.scope}</p> : <p className="text-sm text-ink-3">No scope written yet.</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Milestones" description={p.milestones.length ? `${done} of ${p.milestones.length} complete` : undefined} />
          {p.milestones.length === 0 ? (
            <CardBody className="text-sm text-ink-3">No milestones. Add them from Edit.</CardBody>
          ) : (
            <ul className="divide-y divide-line">
              {p.milestones.map((m) => {
                const late = !m.completed_on && !!m.due_on && isOverdue(m.due_on);
                return (
                  <li key={m.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    {editable ? (
                      <Checkbox checked={!!m.completed_on} onChange={(c) => toggle(m.key, c)} label={`Complete ${m.label}`} />
                    ) : m.completed_on ? (
                      <CheckCircle2 className="size-4 text-positive" />
                    ) : (
                      <Circle className="size-4 text-ink-3" />
                    )}
                    <span className={cn("flex-1", m.completed_on ? "text-ink-3 line-through decoration-ink-3/40" : "text-ink")}>{m.label}</span>
                    <span className={cn("whitespace-nowrap text-xs", late ? "font-medium text-negative" : "text-ink-3")}>
                      {m.completed_on ? `Done ${formatDate(m.completed_on)}` : m.due_on ? `Due ${formatDate(m.due_on)}` : "No due date"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {p.notes && (
          <Card>
            <CardHeader title="Notes" />
            <CardBody>
              <p className="whitespace-pre-wrap text-sm text-ink-2">{p.notes}</p>
            </CardBody>
          </Card>
        )}
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <FieldGrid cols={1}>
              <FieldItem label="Property">
                <Link href={`/properties/${p.property_id}`} className="text-accent hover:underline">
                  {p.property_name ?? "View property"}
                </Link>
              </FieldItem>
              <FieldItem label="Category">{categoryLabel(p.category)}</FieldItem>
              <FieldItem label="Manager">{p.manager_name}</FieldItem>
              <FieldItem label="Contractor">
                {p.contractor_vendor_id ? (
                  <Link href={`/vendors/${p.contractor_vendor_id}`} className="text-accent hover:underline">
                    {p.contractor_name ?? "View vendor"}
                  </Link>
                ) : null}
              </FieldItem>
              <FieldItem label="Contract amount">{p.contract_amount != null ? formatCurrency(p.contract_amount) : null}</FieldItem>
              <FieldItem label="Contingency">{p.contingency != null ? formatCurrency(p.contingency) : null}</FieldItem>
              <FieldItem label="Start">{p.start_on ? formatDate(p.start_on) : null}</FieldItem>
              <FieldItem label="Target completion">
                {p.target_completion_on ? (
                  <span className={cn(isOverdue(p.target_completion_on) && !["completed", "closed", "cancelled"].includes(p.status) && "font-medium text-negative")}>
                    {formatDate(p.target_completion_on)}
                  </span>
                ) : null}
              </FieldItem>
              <FieldItem label="Actual completion">{p.actual_completion_on ? formatDate(p.actual_completion_on) : null}</FieldItem>
              <FieldItem label="Useful life">{p.useful_life_years != null ? `${p.useful_life_years} years` : null}</FieldItem>
              <FieldItem label="Budget approved">{p.budget_approved_at ? formatDateTime(p.budget_approved_at) : null}</FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Warranty" />
          <CardBody>
            <FieldGrid cols={1}>
              <FieldItem label="Expires">
                {p.warranty_expires_on ? (
                  <span className={cn(warrantyDays !== null && warrantyDays < 0 ? "text-ink-3" : warrantyDays !== null && warrantyDays <= 60 ? "text-caution" : "text-ink")}>
                    {formatDate(p.warranty_expires_on)}
                    {warrantyDays !== null && warrantyDays < 0 ? " · expired" : ""}
                  </span>
                ) : null}
              </FieldItem>
            </FieldGrid>
            {p.warranty_terms ? <p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">{p.warranty_terms}</p> : <p className="mt-3 text-xs text-ink-3">Warranty terms are recorded at completion.</p>}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/* ================================================================== bids */

interface BidForm {
  vendor_id: string | null;
  vendor: VendorListItem | null;
  amount: string;
  submitted_on: string;
  valid_until: string;
  duration_days: string;
  scope_notes: string;
}

function BidsTab({ p }: { p: Project }) {
  const { can } = useAuth();
  const { run, pending } = useAct(p.id);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<BidForm>({ vendor_id: null, vendor: null, amount: "", submitted_on: today(), valid_until: "", duration_days: "", scope_notes: "" });
  const [awarding, setAwarding] = useState<Bid | null>(null);
  const [rejecting, setRejecting] = useState<Bid | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [docs, setDocs] = useState<DocsTarget | null>(null);

  const open = ["approved", "bidding"].includes(p.status);
  const canAdd = can("operations", "edit") && open;
  const canAward = can("operations", "approve") && open;
  const bids = [...p.bids].sort((a, b) => a.amount - b.amount);

  const startAdd = () => {
    setForm({ vendor_id: null, vendor: null, amount: "", submitted_on: today(), valid_until: "", duration_days: "", scope_notes: "" });
    setFailure(null);
    setAdding(true);
  };

  const submitBid = () => {
    const amount = toNumber(form.amount);
    if (!form.vendor_id || amount === null || amount <= 0) return;
    run(
      `/capital-projects/${p.id}/bids`,
      {
        vendor_id: form.vendor_id,
        amount,
        submitted_on: form.submitted_on || null,
        valid_until: form.valid_until || null,
        duration_days: toNumber(form.duration_days),
        scope_notes: form.scope_notes.trim() || null,
      },
      "Bid recorded",
      { onDone: () => setAdding(false), onFail: setFailure },
    );
  };

  const setStatus = (b: Bid, status: "shortlisted" | "rejected" | "submitted" | "withdrawn", note?: string) =>
    run(`/project-bids/${b.id}/status`, { status, note: note || null }, `Bid ${status === "submitted" ? "restored" : status}`, {
      onDone: () => setRejecting(null),
    });

  const columns: Column<Bid>[] = [
    {
      id: "vendor",
      header: "Vendor",
      cell: (b) => (
        <div className="flex min-w-[200px] items-center gap-2">
          <Link href={`/vendors/${b.vendor_id}`} className="font-medium text-ink hover:underline">
            {b.vendor_name ?? "Vendor"}
          </Link>
          <ComplianceBadge compliant={b.vendor_compliant} reasons={b.vendor_compliance_reasons} />
        </div>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      cell: (b) => (
        <div className="whitespace-nowrap">
          <p className="font-medium">{formatCurrency(b.amount)}</p>
          {b.amount > p.current_budget && <p className="text-xs text-negative">Over budget</p>}
        </div>
      ),
    },
    { id: "submitted", header: "Submitted", cell: (b) => <span className="whitespace-nowrap text-ink-2">{formatDate(b.submitted_on)}</span> },
    {
      id: "valid",
      header: "Valid until",
      cell: (b) => (
        <span className={cn("whitespace-nowrap", b.valid_until && isOverdue(b.valid_until) && ["submitted", "shortlisted"].includes(b.status) ? "text-negative" : "text-ink-2")}>
          {formatDate(b.valid_until)}
        </span>
      ),
    },
    { id: "duration", header: "Duration", align: "right", cell: (b) => (b.duration_days != null ? `${formatNumber(b.duration_days)} days` : "—") },
    {
      id: "status",
      header: "Status",
      cell: (b) => (
        <div className="min-w-[110px]">
          <ToneBadge status={b.status} tones={BID_TONES} />
          {b.decision_note && <p className="mt-0.5 max-w-[220px] truncate text-xs text-ink-3" title={b.decision_note}>{b.decision_note}</p>}
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (b) => {
        const awardable = ["submitted", "shortlisted"].includes(b.status);
        const nonCompliant = b.vendor_compliant === false;
        return (
          <RowActions>
            {canAward && awardable &&
              (nonCompliant ? (
                <Blocked
                  reason={
                    <>
                      <p className="font-medium">Award blocked: vendor is not compliant</p>
                      {b.vendor_compliance_reasons.map((r) => (
                        <p key={r}>{r}</p>
                      ))}
                    </>
                  }
                >
                  <Button size="xs" disabled>
                    <Gavel className="!size-3.5" /> Award
                  </Button>
                </Blocked>
              ) : (
                <Button
                  size="xs"
                  onClick={() => {
                    setFailure(null);
                    setAwarding(b);
                  }}
                >
                  <Gavel className="!size-3.5" /> Award
                </Button>
              ))}
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Bid actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {can("operations", "edit") && b.status === "submitted" && <MenuItem onSelect={() => setStatus(b, "shortlisted")}>Shortlist</MenuItem>}
                {can("operations", "edit") && awardable && (
                  <MenuItem destructive onSelect={() => setRejecting(b)}>
                    Reject
                  </MenuItem>
                )}
                {can("operations", "edit") && b.status === "rejected" && open && <MenuItem onSelect={() => setStatus(b, "submitted")}>Restore</MenuItem>}
                <MenuItem icon={<FileText />} onSelect={() => setDocs({ entityType: "project_bid", entityId: b.id, title: `Bid documents · ${b.vendor_name ?? "Vendor"}` })}>
                  Documents
                </MenuItem>
              </MenuContent>
            </Menu>
          </RowActions>
        );
      },
    },
  ];

  const amount = toNumber(form.amount);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Bids"
        description={
          open
            ? "Lowest first. Only bids from compliant vendors can be awarded, and the award cannot exceed the approved budget."
            : p.status === "draft" || p.status === "pending_approval"
              ? "Bids are collected once the budget is approved."
              : "Bidding is closed for this project."
        }
        actions={
          canAdd && (
            <Button size="sm" variant="primary" onClick={startAdd}>
              <Plus /> Add bid
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        data={bids}
        rowClassName={(b) => (b.status === "awarded" ? "bg-positive-soft/40" : b.status === "rejected" || b.status === "withdrawn" ? "opacity-70" : undefined)}
        empty={<EmptyState icon={<Gavel />} title="No bids yet" description={open ? "Record each contractor bid as it arrives." : undefined} />}
      />

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add bid"
        description={`Current budget ${formatCurrency(p.current_budget)}`}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.vendor_id || amount === null || amount <= 0} loading={pending} onClick={submitBid}>
              Add bid
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor" required className="col-span-2">
            <EntityPicker<VendorListItem>
              endpoint="/vendors"
              value={form.vendor_id}
              onChange={(vid, item) => setForm((f) => ({ ...f, vendor_id: vid, vendor: item }))}
              placeholder="Select vendor"
              toOption={(v) => ({
                id: v.id,
                label: v.name,
                sublabel: [v.compliant ? "Compliant" : "Not compliant", ...v.services.slice(0, 3).map(serviceLabel)].join(" · "),
              })}
            />
          </Field>
          {form.vendor && !form.vendor.compliant && (
            <div className="col-span-2">
              <Notice>
                <p className="font-medium text-caution">This vendor is not compliant</p>
                <p className="text-xs">The bid can be recorded, but it cannot be awarded until resolved: {form.vendor.compliance_reasons.join("; ") || "missing credentials"}.</p>
              </Notice>
            </div>
          )}
          <Field label="Amount ($)" required>
            <Input value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} inputMode="decimal" />
          </Field>
          <Field label="Duration (days)">
            <Input value={form.duration_days} onChange={(e) => setForm((f) => ({ ...f, duration_days: e.target.value }))} inputMode="numeric" />
          </Field>
          <Field label="Submitted">
            <Input type="date" value={form.submitted_on} onChange={(e) => setForm((f) => ({ ...f, submitted_on: e.target.value }))} />
          </Field>
          <Field label="Valid until">
            <Input type="date" value={form.valid_until} onChange={(e) => setForm((f) => ({ ...f, valid_until: e.target.value }))} />
          </Field>
          <Field label="Scope notes" className="col-span-2">
            <Textarea value={form.scope_notes} onChange={(e) => setForm((f) => ({ ...f, scope_notes: e.target.value }))} placeholder="Inclusions, exclusions, alternates" />
          </Field>
          {amount !== null && amount > p.current_budget && (
            <div className="col-span-2">
              <Notice>This bid exceeds the current budget. It can be recorded, but awarding it requires a budget revision first.</Notice>
            </div>
          )}
          <p className="col-span-2 text-xs text-ink-3">Attach the bid document from the row menu after saving.</p>
          {failure && (
            <div className="col-span-2">
              <FailurePanel failure={failure} />
            </div>
          )}
        </div>
      </Dialog>

      <ActionDialog
        open={!!awarding}
        onOpenChange={(o) => !o && setAwarding(null)}
        title={`Award to ${awarding?.vendor_name ?? "vendor"}`}
        description="The contractor and contract amount are set from this bid and the project moves to awarded. Other open bids are marked not selected."
        confirmLabel="Award bid"
        pending={pending}
        failure={failure}
        onConfirm={(note) =>
          awarding &&
          run(`/project-bids/${awarding.id}/award`, { note: note || null }, "Bid awarded", {
            onDone: () => setAwarding(null),
            onFail: setFailure,
          })
        }
      >
        {awarding && (
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-subtle/60 p-3 text-sm">
            <div>
              <dt className="text-xs text-ink-3">Bid amount</dt>
              <dd className="font-medium tabular">{formatCurrency(awarding.amount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Current budget</dt>
              <dd className={cn("font-medium tabular", awarding.amount > p.current_budget && "text-negative")}>{formatCurrency(p.current_budget)}</dd>
            </div>
          </dl>
        )}
        {awarding && awarding.amount > p.current_budget && <Notice>The bid exceeds the approved budget. Revise the budget before awarding.</Notice>}
        <p className="text-xs text-ink-3">Your capital approval limit applies to the award amount.</p>
      </ActionDialog>

      <ActionDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title="Reject bid"
        description={rejecting ? `${rejecting.vendor_name ?? "Vendor"} · ${formatCurrency(rejecting.amount)}` : undefined}
        confirmLabel="Reject bid"
        destructive
        noteLabel="Reason"
        pending={pending}
        onConfirm={(note) => rejecting && setStatus(rejecting, "rejected", note)}
      />

      <DocsDialog target={docs} onClose={() => setDocs(null)} />
    </Card>
  );
}

/* ================================================================== change orders */

function ChangeOrdersTab({ p }: { p: Project }) {
  const { can } = useAuth();
  const { run, pending } = useAct(p.id);
  const [requesting, setRequesting] = useState(false);
  const [form, setForm] = useState({ title: "", amount: "", days_impact: "", reason: "", description: "" });
  const [deciding, setDeciding] = useState<{ co: ChangeOrder; decision: "approved" | "rejected" } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [docs, setDocs] = useState<DocsTarget | null>(null);

  const canRequest = can("operations", "edit") && ["awarded", "in_progress"].includes(p.status);
  const canDecide = can("operations", "approve");
  const pendingCount = p.change_orders.filter((c) => c.status === "pending").length;

  const startRequest = () => {
    setForm({ title: "", amount: "", days_impact: "", reason: "", description: "" });
    setFailure(null);
    setRequesting(true);
  };

  const submit = () => {
    const amount = toNumber(form.amount);
    if (!form.title.trim() || amount === null) return;
    run(
      `/capital-projects/${p.id}/change-orders`,
      {
        title: form.title.trim(),
        amount,
        days_impact: toNumber(form.days_impact),
        reason: form.reason.trim() || null,
        description: form.description.trim() || null,
      },
      "Change order requested",
      { onDone: () => setRequesting(false), onFail: setFailure },
    );
  };

  const columns: Column<ChangeOrder>[] = [
    { id: "number", header: "#", width: 60, cell: (c) => <span className="text-ink-3 tabular">#{c.number}</span> },
    {
      id: "title",
      header: "Change order",
      cell: (c) => (
        <div className="min-w-[200px] max-w-[360px]">
          <p className="truncate font-medium text-ink">{c.title}</p>
          {(c.reason || c.description) && <p className="truncate text-xs text-ink-3">{c.reason ?? c.description}</p>}
        </div>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      cell: (c) => <span className={cn("whitespace-nowrap font-medium", c.amount < 0 ? "text-positive" : "text-ink")}>{signedCurrency(c.amount)}</span>,
    },
    {
      id: "days",
      header: "Schedule",
      align: "right",
      cell: (c) => (c.days_impact ? <span className="whitespace-nowrap">{`${c.days_impact > 0 ? "+" : ""}${c.days_impact} days`}</span> : "—"),
    },
    { id: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
    {
      id: "decided",
      header: "Decided",
      cell: (c) =>
        c.decided_at ? (
          <div className="min-w-[110px]">
            <p className="whitespace-nowrap text-ink-2">{formatDate(c.decided_at)}</p>
            {c.decision_note && <p className="max-w-[220px] truncate text-xs text-ink-3" title={c.decision_note}>{c.decision_note}</p>}
          </div>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) => (
        <RowActions>
          {canDecide && c.status === "pending" && (
            <>
              <Button
                size="xs"
                onClick={() => {
                  setFailure(null);
                  setDeciding({ co: c, decision: "approved" });
                }}
              >
                <Check className="!size-3.5" /> Approve
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Reject"
                onClick={() => {
                  setFailure(null);
                  setDeciding({ co: c, decision: "rejected" });
                }}
              >
                <X className="!size-3.5" />
              </Button>
            </>
          )}
          <Button size="icon-sm" variant="ghost" aria-label="Documents" onClick={() => setDocs({ entityType: "change_order", entityId: c.id, title: `Change order #${c.number} documents` })}>
            <FileText />
          </Button>
        </RowActions>
      ),
    },
  ];

  const amount = toNumber(form.amount);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Change orders"
        description={`Approved change orders adjust the budget and contract and are recorded in the budget history. ${pendingCount ? `${pendingCount} pending.` : ""}`}
        actions={
          canRequest && (
            <Button size="sm" variant="primary" onClick={startRequest}>
              <Plus /> Request change order
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        data={p.change_orders}
        empty={<EmptyState title="No change orders" description="Change orders apply once the project is awarded or in progress." />}
      />

      <Dialog
        open={requesting}
        onOpenChange={setRequesting}
        title="Request change order"
        description="An approver is alerted. Use a negative amount for a credit."
        footer={
          <>
            <Button onClick={() => setRequesting(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.title.trim() || amount === null} loading={pending} onClick={submit}>
              Request
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Title" required className="col-span-2">
            <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </Field>
          <Field label="Amount ($)" required hint="Negative for a credit">
            <Input value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} inputMode="decimal" />
          </Field>
          <Field label="Schedule impact (days)">
            <Input value={form.days_impact} onChange={(e) => setForm((f) => ({ ...f, days_impact: e.target.value }))} inputMode="numeric" />
          </Field>
          <Field label="Reason" className="col-span-2">
            <Input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. Unforeseen deck damage" />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </Field>
          {failure && (
            <div className="col-span-2">
              <FailurePanel failure={failure} />
            </div>
          )}
        </div>
      </Dialog>

      <ActionDialog
        open={!!deciding}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding ? `${deciding.decision === "approved" ? "Approve" : "Reject"} change order #${deciding.co.number}` : "Change order"}
        description={
          deciding
            ? deciding.decision === "approved"
              ? `${signedCurrency(deciding.co.amount)} is added to the current budget (${formatCurrency(p.current_budget)}) and the contract amount${deciding.co.days_impact ? `; target completion moves ${deciding.co.days_impact} days` : ""}.`
              : "The change order is closed without affecting the budget."
            : undefined
        }
        confirmLabel={deciding?.decision === "approved" ? "Approve" : "Reject"}
        destructive={deciding?.decision === "rejected"}
        noteRequired={deciding?.decision === "rejected"}
        noteLabel={deciding?.decision === "rejected" ? "Reason" : "Note"}
        pending={pending}
        failure={failure}
        onConfirm={(note) =>
          deciding &&
          run(`/change-orders/${deciding.co.id}/decision`, { decision: deciding.decision, note: note || null }, `Change order ${deciding.decision}`, {
            onDone: () => setDeciding(null),
            onFail: setFailure,
          })
        }
      />

      <DocsDialog target={docs} onClose={() => setDocs(null)} />
    </Card>
  );
}

/* ================================================================== draws */

function DrawsTab({ p }: { p: Project }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { run, pending } = useAct(p.id);
  const compliance = useVendorCompliance(p.contractor_vendor_id);
  const [requesting, setRequesting] = useState(false);
  const [form, setForm] = useState({ amount: "", requested_on: today(), period_end_on: "", percent_complete: "", retainage: "", lien_waiver_type: "", notes: "" });
  const [deciding, setDeciding] = useState<{ draw: Draw; decision: "approved" | "rejected" } | null>(null);
  const [paying, setPaying] = useState<Draw | null>(null);
  const [pay, setPay] = useState({ paid_on: today(), payment_reference: "" });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [waiver, setWaiver] = useState<Draw | null>(null);

  const canRequest = can("operations", "edit") && ["awarded", "in_progress", "completed"].includes(p.status);
  const canDecide = can("operations", "approve");
  const drawn = p.draws.filter((d) => d.status !== "rejected").reduce((s, d) => s + d.amount, 0);
  const capacity = (p.contract_amount ?? 0) - drawn;
  const contractorBlocked = compliance.data && !compliance.data.compliant ? compliance.data.reasons : null;

  const startRequest = () => {
    setForm({ amount: "", requested_on: today(), period_end_on: "", percent_complete: "", retainage: "", lien_waiver_type: "", notes: "" });
    setFailure(null);
    setRequesting(true);
  };

  const submit = () => {
    const amount = toNumber(form.amount);
    if (amount === null || amount <= 0 || !form.requested_on) return;
    const pct = toNumber(form.percent_complete);
    if (pct !== null && (pct < 0 || pct > 100)) {
      toast.error("Percent complete must be between 0 and 100");
      return;
    }
    run(
      `/capital-projects/${p.id}/draws`,
      {
        amount,
        requested_on: form.requested_on,
        period_end_on: form.period_end_on || null,
        percent_complete: pct,
        retainage: toNumber(form.retainage),
        lien_waiver_type: form.lien_waiver_type || null,
        notes: form.notes.trim() || null,
      },
      "Draw requested",
      { onDone: () => setRequesting(false), onFail: setFailure },
    );
  };

  const closeWaiver = () => {
    setWaiver(null);
    qc.invalidateQueries({ queryKey: ["capital-projects", p.id] });
  };

  const columns: Column<Draw>[] = [
    { id: "number", header: "#", width: 60, cell: (d) => <span className="text-ink-3 tabular">#{d.number}</span> },
    {
      id: "requested",
      header: "Requested",
      cell: (d) => (
        <div className="whitespace-nowrap">
          <p className="text-ink-2">{formatDate(d.requested_on)}</p>
          {d.period_end_on && <p className="text-xs text-ink-3">Period to {formatDate(d.period_end_on)}</p>}
        </div>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      cell: (d) => (
        <div className="whitespace-nowrap">
          <p className="font-medium">{formatCurrency(d.amount)}</p>
          {d.retainage ? <p className="text-xs text-ink-3">Retainage {formatCurrency(d.retainage)}</p> : null}
        </div>
      ),
    },
    { id: "pct", header: "% complete", align: "right", cell: (d) => formatPercent(d.percent_complete, 0) },
    {
      id: "waiver",
      header: "Lien waiver",
      cell: (d) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {d.lien_waiver_on_file ? (
            <Badge tone="green" dot>
              On file{d.lien_waiver_type ? ` · ${titleCase(d.lien_waiver_type)}` : ""}
            </Badge>
          ) : (
            <Badge tone="amber" dot>
              Missing
            </Badge>
          )}
          <Button size="xs" variant="ghost" onClick={() => setWaiver(d)}>
            <FileText className="!size-3.5" /> Lien waiver
          </Button>
        </div>
      ),
    },
    { id: "status", header: "Status", cell: (d) => <ToneBadge status={d.status} tones={DRAW_TONES} /> },
    {
      id: "paid",
      header: "Paid",
      cell: (d) =>
        d.paid_on ? (
          <div className="whitespace-nowrap">
            <p className="text-ink-2">{formatDate(d.paid_on)}</p>
            {d.payment_reference && <p className="font-mono text-xs text-ink-3">{d.payment_reference}</p>}
          </div>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (d) => {
        if (!canDecide) return null;
        if (d.status === "requested") {
          const blockReason = !d.lien_waiver_on_file
            ? "Attach a lien waiver before approving this draw."
            : contractorBlocked
              ? `Contractor is not compliant: ${contractorBlocked.join("; ")}`
              : null;
          const approveBtn = (
            <Button
              size="xs"
              disabled={!!blockReason}
              onClick={() => {
                setFailure(null);
                setDeciding({ draw: d, decision: "approved" });
              }}
            >
              <Check className="!size-3.5" /> Approve
            </Button>
          );
          return (
            <RowActions>
              {blockReason ? <Blocked reason={blockReason}>{approveBtn}</Blocked> : approveBtn}
              <Button
                size="xs"
                variant="ghost"
                aria-label="Reject"
                onClick={() => {
                  setFailure(null);
                  setDeciding({ draw: d, decision: "rejected" });
                }}
              >
                <X className="!size-3.5" />
              </Button>
            </RowActions>
          );
        }
        if (d.status === "approved") {
          return (
            <RowActions>
              <Button
                size="xs"
                onClick={() => {
                  setFailure(null);
                  setPay({ paid_on: today(), payment_reference: "" });
                  setPaying(d);
                }}
              >
                Mark paid
              </Button>
            </RowActions>
          );
        }
        return null;
      },
    },
  ];

  const amount = toNumber(form.amount);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Draws"
        description="Approval requires a lien waiver on file and a compliant contractor. Draws cannot exceed the contract amount."
        actions={
          canRequest && (
            <Button size="sm" variant="primary" onClick={startRequest}>
              <Plus /> Request draw
            </Button>
          )
        }
      />
      {contractorBlocked && p.draws.some((d) => d.status === "requested") && (
        <div className="border-b border-line px-4 py-3">
          <FailurePanel failure={{ message: "Contractor is not compliant; draw approvals are blocked", reasons: contractorBlocked }} />
        </div>
      )}
      {p.contract_amount != null && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line bg-subtle/40 px-4 py-2 text-xs text-ink-3">
          <span>
            Contract <span className="font-medium text-ink-2 tabular">{formatCurrency(p.contract_amount)}</span>
          </span>
          <span>
            Drawn <span className="font-medium text-ink-2 tabular">{formatCurrency(drawn)}</span>
          </span>
          <span>
            Remaining to draw <span className="font-medium text-ink-2 tabular">{formatCurrency(capacity)}</span>
          </span>
        </div>
      )}
      <DataTable columns={columns} data={p.draws} empty={<EmptyState title="No draws" description="Draws apply once the project is awarded." />} />

      <Dialog
        open={requesting}
        onOpenChange={setRequesting}
        title="Request draw"
        description={`Up to ${formatCurrency(Math.max(0, capacity))} remains on the contract.`}
        footer={
          <>
            <Button onClick={() => setRequesting(false)}>Cancel</Button>
            <Button variant="primary" disabled={amount === null || amount <= 0 || !form.requested_on} loading={pending} onClick={submit}>
              Request draw
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount ($)" required>
            <Input value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} inputMode="decimal" />
          </Field>
          <Field label="Requested on" required>
            <Input type="date" value={form.requested_on} onChange={(e) => setForm((f) => ({ ...f, requested_on: e.target.value }))} />
          </Field>
          <Field label="Period end">
            <Input type="date" value={form.period_end_on} onChange={(e) => setForm((f) => ({ ...f, period_end_on: e.target.value }))} />
          </Field>
          <Field label="Percent complete">
            <Input value={form.percent_complete} onChange={(e) => setForm((f) => ({ ...f, percent_complete: e.target.value }))} inputMode="decimal" />
          </Field>
          <Field label="Retainage ($)">
            <Input value={form.retainage} onChange={(e) => setForm((f) => ({ ...f, retainage: e.target.value }))} inputMode="decimal" />
          </Field>
          <Field label="Lien waiver type">
            <Select
              value={form.lien_waiver_type}
              onChange={(e) => setForm((f) => ({ ...f, lien_waiver_type: e.target.value }))}
              placeholder="Not yet known"
              options={[
                { value: "conditional", label: "Conditional" },
                { value: "unconditional", label: "Unconditional" },
              ]}
            />
          </Field>
          <Field label="Notes" className="col-span-2">
            <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
          {amount !== null && amount > capacity + 0.005 && (
            <div className="col-span-2">
              <Notice>This amount exceeds what remains on the contract and will be refused.</Notice>
            </div>
          )}
          <p className="col-span-2 text-xs text-ink-3">After saving, attach the lien waiver with the Lien waiver button on the draw row.</p>
          {failure && (
            <div className="col-span-2">
              <FailurePanel failure={failure} />
            </div>
          )}
        </div>
      </Dialog>

      <ActionDialog
        open={!!deciding}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding ? `${deciding.decision === "approved" ? "Approve" : "Reject"} draw #${deciding.draw.number}` : "Draw"}
        description={
          deciding?.decision === "approved"
            ? `${formatCurrency(deciding.draw.amount)} becomes spent against the project. Requires a lien waiver on file, a compliant contractor and an amount within your capital approval limit.`
            : "The draw is closed and no longer counts against the contract."
        }
        confirmLabel={deciding?.decision === "approved" ? "Approve draw" : "Reject draw"}
        destructive={deciding?.decision === "rejected"}
        noteRequired={deciding?.decision === "rejected"}
        noteLabel={deciding?.decision === "rejected" ? "Reason" : "Note"}
        pending={pending}
        failure={failure}
        onConfirm={(note) =>
          deciding &&
          run(`/project-draws/${deciding.draw.id}/decision`, { decision: deciding.decision, note: note || null }, `Draw ${deciding.decision}`, {
            onDone: () => setDeciding(null),
            onFail: setFailure,
          })
        }
      />

      <Dialog
        open={!!paying}
        onOpenChange={(o) => !o && setPaying(null)}
        title={paying ? `Mark draw #${paying.number} paid` : "Mark paid"}
        description={paying ? formatCurrency(paying.amount) : undefined}
        footer={
          <>
            <Button onClick={() => setPaying(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!pay.paid_on}
              loading={pending}
              onClick={() =>
                paying &&
                run(`/project-draws/${paying.id}/pay`, { paid_on: pay.paid_on, payment_reference: pay.payment_reference.trim() || null }, "Draw marked paid", {
                  onDone: () => setPaying(null),
                  onFail: setFailure,
                })
              }
            >
              Mark paid
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid on" required>
            <Input type="date" value={pay.paid_on} onChange={(e) => setPay((s) => ({ ...s, paid_on: e.target.value }))} />
          </Field>
          <Field label="Payment reference">
            <Input value={pay.payment_reference} onChange={(e) => setPay((s) => ({ ...s, payment_reference: e.target.value }))} placeholder="Check or wire #" />
          </Field>
          {failure && (
            <div className="col-span-2">
              <FailurePanel failure={failure} />
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={!!waiver}
        onOpenChange={(o) => !o && closeWaiver()}
        title={waiver ? `Lien waiver · draw #${waiver.number}` : "Lien waiver"}
        description="Upload or link the contractor lien waiver for this draw. Approval requires a waiver on file."
        className="max-w-3xl"
      >
        {waiver && <RecordDocuments entityType="lien_waiver" entityId={waiver.id} />}
      </Dialog>
    </Card>
  );
}

/* ================================================================== budget history & approvals */

function BudgetHistoryTab({ p }: { p: Project }) {
  const { can } = useAuth();
  const { run, pending } = useAct(p.id);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ new_budget: "", reason: "" });
  const [failure, setFailure] = useState<Failure | null>(null);
  const canRevise = can("operations", "approve") && !["closed", "cancelled"].includes(p.status);

  const coNumber = (id: string | null) => (id ? p.change_orders.find((c) => c.id === id)?.number : undefined);

  const columns: Column<BudgetEntry>[] = [
    { id: "when", header: "When", cell: (e) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(e.recorded_at)}</span> },
    { id: "kind", header: "Kind", cell: (e) => <Badge tone={ENTRY_TONES[e.kind] ?? "neutral"}>{titleCase(e.kind)}</Badge> },
    { id: "before", header: "Before", align: "right", cell: (e) => <span className="text-ink-2">{formatCurrency(e.amount_before)}</span> },
    {
      id: "delta",
      header: "Change",
      align: "right",
      cell: (e) => <span className={cn("font-medium", e.delta > 0 ? "text-caution" : e.delta < 0 ? "text-positive" : "text-ink-3")}>{signedCurrency(e.delta)}</span>,
    },
    { id: "after", header: "After", align: "right", cell: (e) => <span className="font-medium">{formatCurrency(e.amount_after)}</span> },
    {
      id: "reason",
      header: "Reason",
      cell: (e) => {
        const n = coNumber(e.change_order_id);
        return (
          <span className="text-ink-2">
            {e.reason ?? "—"}
            {n !== undefined && !e.reason?.startsWith("CO #") ? ` (CO #${n})` : ""}
          </span>
        );
      },
    },
  ];

  const value = toNumber(form.new_budget);
  const belowCommitted = value !== null && p.contract_amount != null && value < p.contract_amount;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Budget history"
        description="Append-only. Every change to the current budget is recorded with its reason, actor and time."
        actions={
          canRevise && (
            <Button
              size="sm"
              onClick={() => {
                setForm({ new_budget: String(p.current_budget), reason: "" });
                setFailure(null);
                setOpen(true);
              }}
            >
              <Calculator /> Revise budget
            </Button>
          )
        }
      />
      <DataTable columns={columns} data={p.budget_history} empty={<EmptyState title="No budget entries" />} />

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Revise budget"
        description={`Current budget ${formatCurrency(p.current_budget)}. After approval, revisions are checked against your capital approval limit.`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={value === null || value < 0 || form.reason.trim().length < 3 || belowCommitted}
              loading={pending}
              onClick={() =>
                value !== null &&
                run(`/capital-projects/${p.id}/budget-revisions`, { new_budget: value, reason: form.reason.trim() }, "Budget revised", {
                  onDone: () => setOpen(false),
                  onFail: setFailure,
                })
              }
            >
              Revise budget
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field
            label="New budget ($)"
            required
            error={belowCommitted ? `Cannot be below the committed contract amount ${formatCurrency(p.contract_amount)}` : null}
            hint={value !== null ? `Change ${signedCurrency(value - p.current_budget)}` : undefined}
          >
            <Input value={form.new_budget} onChange={(e) => setForm((f) => ({ ...f, new_budget: e.target.value }))} inputMode="decimal" />
          </Field>
          <Field label="Reason" required hint="At least 3 characters; kept in the budget history">
            <Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
          </Field>
          <FailurePanel failure={failure} />
        </div>
      </Dialog>
    </Card>
  );
}

function ApprovalsTab({ p }: { p: Project }) {
  const reference = (a: ProjectApproval): string | null => {
    if (!a.reference_id) return null;
    if (a.stage === "award") {
      const b = p.bids.find((x) => x.id === a.reference_id);
      return b ? `Bid · ${b.vendor_name ?? "vendor"}` : "Bid";
    }
    if (a.stage === "change_order") {
      const c = p.change_orders.find((x) => x.id === a.reference_id);
      return c ? `CO #${c.number}` : "Change order";
    }
    if (a.stage === "draw") {
      const d = p.draws.find((x) => x.id === a.reference_id);
      return d ? `Draw #${d.number}` : "Draw";
    }
    return null;
  };

  const columns: Column<ProjectApproval>[] = [
    { id: "stage", header: "Stage", cell: (a) => <span className="font-medium">{titleCase(a.stage)}</span> },
    { id: "ref", header: "Reference", cell: (a) => <span className="text-ink-2">{reference(a) ?? "—"}</span> },
    { id: "decision", header: "Decision", cell: (a) => <StatusBadge status={a.decision} /> },
    { id: "amount", header: "Amount", align: "right", cell: (a) => (a.amount != null ? formatCurrency(a.amount) : "—") },
    { id: "by", header: "By", cell: (a) => <span className="whitespace-nowrap text-ink-2">{a.decided_by_name ?? "—"}</span> },
    { id: "when", header: "When", cell: (a) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(a.decided_at)}</span> },
    { id: "note", header: "Note", cell: (a) => <span className="text-ink-2">{a.note ?? "—"}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Approvals" description="Budget, award, change-order, draw and completion decisions with approver and amount." />
      <DataTable columns={columns} data={[...p.approvals].reverse()} empty={<EmptyState title="No approvals yet" />} />
    </Card>
  );
}

/* ================================================================== recoverability */

type LeaseRow = Recoverability["leases"][number] & { id: string };

function RecoverabilityTab({ p }: { p: Project }) {
  const { can } = useAuth();
  const { run, pending } = useAct(p.id);
  const [failure, setFailure] = useState<Failure | null>(null);
  const r = p.recoverability;

  const analyze = () => {
    setFailure(null);
    run(`/capital-projects/${p.id}/recoverability`, {}, "Recoverability analyzed", { onFail: setFailure });
  };

  const button = can("operations", "edit") && (
    <Button size="sm" variant={r ? "secondary" : "primary"} loading={pending} onClick={analyze}>
      {!pending && <Calculator />}
      {r ? "Re-analyze" : "Analyze against leases"}
    </Button>
  );

  const columns: Column<LeaseRow>[] = [
    { id: "tenant", header: "Tenant", cell: (l) => <span className="font-medium">{l.tenant_name ?? "Unnamed tenant"}</span> },
    { id: "type", header: "Lease type", cell: (l) => <span className="text-ink-2">{titleCase(l.lease_type)}</span> },
    { id: "sf", header: "RSF", align: "right", cell: (l) => formatNumber(l.rentable_sf) },
    { id: "share", header: "Share", align: "right", cell: (l) => formatPercent(l.share_pct, 2) },
    {
      id: "recoverable",
      header: "Recoverable",
      cell: (l) =>
        l.recoverable ? (
          <Badge tone="green" dot>
            Yes
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            No
          </Badge>
        ),
    },
    { id: "amount", header: "Amount", align: "right", cell: (l) => formatCurrency(l.recoverable_amount) },
    { id: "annual", header: "Annual", align: "right", cell: (l) => formatCurrency(l.annual_recovery) },
    { id: "reason", header: "Reason", cell: (l) => <span className="text-ink-2">{l.reason}</span> },
  ];

  return (
    <div className="space-y-5">
      {failure && (
        <div className="rounded-lg border border-caution/30 bg-caution-soft px-4 py-3 text-sm">
          <p className="font-medium text-caution">{failure.message}</p>
          {failure.reasons.length > 0 && <p className="mt-0.5 text-ink-2">{failure.reasons.join("; ")}</p>}
        </div>
      )}
      {!r ? (
        <Card>
          <EmptyState
            icon={<Calculator />}
            title="Not analyzed yet"
            description="Estimate how much of this project cost can be recovered from tenants under the active leases at the property, amortized over the useful life."
            action={button || undefined}
          />
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Recoverability"
              description={`Analyzed ${formatDateTime(p.recoverability_analyzed_at)} against ${r.lease_count} active leases`}
              actions={
                <>
                  {r.status === "recoverable" ? (
                    <Badge tone="green" dot>
                      Recoverable
                    </Badge>
                  ) : r.status === "no_leases" ? (
                    <Badge tone="neutral" dot>
                      No active leases
                    </Badge>
                  ) : (
                    <Badge tone="amber" dot>
                      Not recoverable
                    </Badge>
                  )}
                  {button}
                </>
              }
            />
            <CardBody>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Recoverable amount" value={formatCurrency(r.recoverable_amount)} hint={`of ${formatCurrency(r.project_cost)} project cost`} />
                <StatCard label="Recoverable share" value={formatPercent(r.recoverable_pct, 1)} />
                <StatCard label="Annual recovery" value={formatCurrency(r.annual_recovery)} hint={`Amortized over ${r.useful_life_years} years`} />
                <StatCard label="Useful life" value={`${r.useful_life_years} yrs`} hint={p.useful_life_years ? undefined : "Default; set on the project"} />
              </div>
            </CardBody>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title="By lease" />
            <DataTable
              columns={columns}
              data={r.leases.map((l) => ({ ...l, id: l.lease_id }))}
              empty={<EmptyState title="No active leases" description="There are no active leases at this property to recover costs from." />}
            />
          </Card>
        </>
      )}
    </div>
  );
}

/* ================================================================== page */

type HeaderAction = "submit" | "approve" | "reject" | "bidding" | "start" | "complete" | "close" | "cancel" | "draft" | "reopen";

const STATUS_FOR: Partial<Record<HeaderAction, string>> = {
  submit: "pending_approval",
  bidding: "bidding",
  start: "in_progress",
  complete: "completed",
  close: "closed",
  cancel: "cancelled",
  draft: "draft",
  reopen: "in_progress",
};

const ACTION_COPY: Record<HeaderAction, { title: string; description: string; confirm: string; success: string; noteLabel?: string; noteRequired?: boolean; destructive?: boolean }> = {
  submit: { title: "Submit for approval", description: "The current budget is sent to an approver.", confirm: "Submit", success: "Submitted for approval" },
  approve: { title: "Approve budget", description: "Approving opens the project for bidding. Your capital approval limit applies.", confirm: "Approve budget", success: "Budget approved" },
  reject: { title: "Reject budget", description: "The project returns to draft.", confirm: "Reject", success: "Budget rejected", noteLabel: "Reason", noteRequired: true, destructive: true },
  bidding: { title: "Open bidding", description: "Start collecting contractor bids.", confirm: "Open bidding", success: "Bidding opened" },
  start: { title: "Start work", description: "Moves the project to in progress. The awarded contractor must be compliant.", confirm: "Start work", success: "Work started" },
  complete: { title: "Mark complete", description: "Record completion and the warranty. A warranty expiry creates a critical date.", confirm: "Mark complete", success: "Project completed" },
  close: { title: "Close project", description: "Pending change orders and unpaid draws must be resolved first. Closed projects are read-only.", confirm: "Close project", success: "Project closed" },
  cancel: { title: "Cancel project", description: "Cancelled projects keep their bids, budget history and approvals.", confirm: "Cancel project", success: "Project cancelled", noteLabel: "Reason", noteRequired: true, destructive: true },
  draft: { title: "Return to draft", description: "Withdraws the approval request so the project can be changed.", confirm: "Return to draft", success: "Returned to draft" },
  reopen: { title: "Reopen project", description: "Moves the project back to in progress.", confirm: "Reopen", success: "Project reopened", noteLabel: "Reason" },
};

function ProjectDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: p, isLoading, error } = useProject(id);
  const { run, pending } = useAct(id);
  const archive = useArchiveProject();
  const contractorCompliance = useVendorCompliance(p?.contractor_vendor_id);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [dlg, setDlg] = useState<HeaderAction | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState({ actual: today(), warranty: "", terms: "" });
  const tab = url.get("tab") ?? "overview";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !p) {
    return (
      <EmptyState
        title="Project not found"
        description={errorMessage(error)}
        action={
          <Link href="/capital-projects">
            <Button>Back to capital projects</Button>
          </Link>
        }
      />
    );
  }

  const canEdit = can("operations", "edit");
  const canApprove = can("operations", "approve");
  const terminal = p.status === "closed" || p.status === "cancelled";
  const cancellable = ["draft", "pending_approval", "approved", "bidding", "awarded", "in_progress"].includes(p.status);

  const openAction = (a: HeaderAction) => {
    setFailure(null);
    if (a === "complete") setCompletion({ actual: today(), warranty: p.warranty_expires_on ?? "", terms: p.warranty_terms ?? "" });
    setDlg(a);
  };

  const confirmAction = (note: string) => {
    if (!dlg) return;
    const copy = ACTION_COPY[dlg];
    const opts = { onDone: () => setDlg(null), onFail: setFailure };
    if (dlg === "approve" || dlg === "reject") {
      run(`/capital-projects/${id}/budget-approval`, { decision: dlg === "approve" ? "approved" : "rejected", note: note || null }, copy.success, opts);
      return;
    }
    const body: Record<string, unknown> = { status: STATUS_FOR[dlg], note: note || null };
    if (dlg === "complete") {
      body.actual_completion_on = completion.actual || null;
      body.warranty_expires_on = completion.warranty || null;
      body.warranty_terms = completion.terms.trim() || null;
    }
    run(`/capital-projects/${id}/status`, body, copy.success, opts);
  };

  const doArchive = () =>
    archive.mutate(id, {
      onSuccess: () => {
        toast.success("Project archived");
        router.replace("/capital-projects");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const primary: ReactNode = (() => {
    switch (p.status) {
      case "draft":
        return canEdit ? (
          <Button variant="primary" onClick={() => openAction("submit")}>
            Submit for approval <ArrowRight />
          </Button>
        ) : null;
      case "pending_approval":
        return canApprove ? (
          <>
            <Button onClick={() => openAction("reject")}>
              <X /> Reject
            </Button>
            <Button variant="primary" onClick={() => openAction("approve")}>
              <Check /> Approve budget
            </Button>
          </>
        ) : null;
      case "approved":
        return canEdit ? (
          <Button variant="primary" onClick={() => openAction("bidding")}>
            Open bidding <ArrowRight />
          </Button>
        ) : null;
      case "bidding":
        return (
          <Button variant="primary" onClick={() => url.set({ tab: "bids" })}>
            <Gavel /> Review bids
          </Button>
        );
      case "awarded":
        return canEdit ? (
          <Button variant="primary" onClick={() => openAction("start")}>
            Start work <ArrowRight />
          </Button>
        ) : null;
      case "in_progress":
        return canEdit ? (
          <Button variant="primary" onClick={() => openAction("complete")}>
            <CheckCircle2 /> Mark complete
          </Button>
        ) : null;
      case "completed":
        return canEdit ? (
          <Button variant="primary" onClick={() => openAction("close")}>
            Close project
          </Button>
        ) : null;
      default:
        return null;
    }
  })();

  const menuItems: ReactNode[] = [];
  if (canEdit && p.status === "pending_approval") {
    menuItems.push(
      <MenuItem key="draft" icon={<RotateCcw />} onSelect={() => openAction("draft")}>
        Return to draft
      </MenuItem>,
    );
  }
  if (canEdit && p.status === "completed") {
    menuItems.push(
      <MenuItem key="reopen" icon={<RotateCcw />} onSelect={() => openAction("reopen")}>
        Reopen project
      </MenuItem>,
    );
  }
  if (canEdit && cancellable) {
    menuItems.push(
      <MenuItem key="cancel" icon={<Ban />} destructive onSelect={() => openAction("cancel")}>
        Cancel project
      </MenuItem>,
    );
  }
  if (can("operations", "delete") && (p.status === "draft" || p.status === "cancelled")) {
    if (menuItems.length) menuItems.push(<MenuSeparator key="sep" />);
    menuItems.push(
      <MenuItem key="archive" icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
        Archive project
      </MenuItem>,
    );
  }

  const copy = dlg ? ACTION_COPY[dlg] : null;
  const contractorReasons = contractorCompliance.data && !contractorCompliance.data.compliant ? contractorCompliance.data.reasons : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Capital projects", href: "/capital-projects" }, { label: p.name }]}
        title={p.name}
        description={
          <Link href={`/properties/${p.property_id}`} className="hover:underline">
            {p.property_name ?? "Property"}
          </Link>
        }
        meta={
          <>
            <ProjectStatusBadge status={p.status} />
            <Badge tone="outline">{categoryLabel(p.category)}</Badge>
            {p.manager_name && <span className="text-xs text-ink-3">Manager {p.manager_name}</span>}
            {p.contractor_name && <span className="text-xs text-ink-3">· Contractor {p.contractor_name}</span>}
            {p.pending_change_orders > 0 && <Badge tone="amber">{p.pending_change_orders} pending change orders</Badge>}
          </>
        }
        actions={
          <>
            {primary}
            {canEdit && !terminal && (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {menuItems.length > 0 && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent width={210}>{menuItems}</MenuContent>
              </Menu>
            )}
          </>
        }
      />

      <Card className="mb-5">
        <CardBody>
          <StatusStepper status={p.status} />
        </CardBody>
      </Card>

      {p.status === "cancelled" && (
        <div className="mb-5 rounded-lg border border-line bg-subtle px-4 py-3 text-sm">
          <p className="font-medium text-ink">Cancelled</p>
          <p className="text-ink-2">This project was cancelled. Its bids, budget history, approvals and documents are retained; see Activity for the reason.</p>
        </div>
      )}

      <BudgetPanel p={p} />

      <Tabs value={tab} onValueChange={(t) => url.set({ tab: t === "overview" ? null : t })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "bids", label: "Bids", count: p.bids.length },
            { value: "change-orders", label: "Change orders", count: p.change_orders.length },
            { value: "draws", label: "Draws", count: p.draws.length },
            { value: "budget", label: "Budget history" },
            { value: "approvals", label: "Approvals", count: p.approvals.length },
            { value: "recoverability", label: "Recoverability" },
            { value: "documents", label: "Documents" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="overview">
          <OverviewTab p={p} />
        </TabPanel>
        <TabPanel value="bids">
          <BidsTab p={p} />
        </TabPanel>
        <TabPanel value="change-orders">
          <ChangeOrdersTab p={p} />
        </TabPanel>
        <TabPanel value="draws">
          <DrawsTab p={p} />
        </TabPanel>
        <TabPanel value="budget">
          <BudgetHistoryTab p={p} />
        </TabPanel>
        <TabPanel value="approvals">
          <ApprovalsTab p={p} />
        </TabPanel>
        <TabPanel value="recoverability">
          <RecoverabilityTab p={p} />
        </TabPanel>
        <TabPanel value="documents">
          <RecordDocuments entityType="capital_project" entityId={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="capital_project" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <ActionDialog
        open={!!dlg}
        onOpenChange={(o) => !o && setDlg(null)}
        title={copy?.title ?? ""}
        description={copy?.description}
        confirmLabel={copy?.confirm ?? "Confirm"}
        destructive={copy?.destructive}
        noteLabel={copy?.noteLabel ?? "Note"}
        noteRequired={copy?.noteRequired}
        confirmDisabled={dlg === "complete" && !completion.actual}
        pending={pending}
        failure={failure}
        onConfirm={confirmAction}
      >
        {(dlg === "approve" || dlg === "submit") && (
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-subtle/60 p-3 text-sm">
            <div>
              <dt className="text-xs text-ink-3">Budget</dt>
              <dd className="font-medium tabular">{formatCurrency(p.current_budget)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Contingency</dt>
              <dd className="font-medium tabular">{formatCurrency(p.contingency)}</dd>
            </div>
          </dl>
        )}
        {dlg === "start" && contractorReasons && (
          <FailurePanel failure={{ message: "The contractor is not compliant; starting work will be refused", reasons: contractorReasons }} />
        )}
        {dlg === "close" && (p.pending_change_orders > 0 || p.draws.some((d) => d.status === "requested" || d.status === "approved")) && (
          <Notice>There are pending change orders or unpaid draws. Resolve them before closing.</Notice>
        )}
        {dlg === "complete" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Actual completion" required>
              <Input type="date" value={completion.actual} onChange={(e) => setCompletion((c) => ({ ...c, actual: e.target.value }))} />
            </Field>
            <Field label="Warranty expires">
              <Input type="date" value={completion.warranty} onChange={(e) => setCompletion((c) => ({ ...c, warranty: e.target.value }))} />
            </Field>
            <Field label="Warranty terms" className="col-span-2">
              <Textarea value={completion.terms} onChange={(e) => setCompletion((c) => ({ ...c, terms: e.target.value }))} placeholder="Coverage, duration, conditions" />
            </Field>
          </div>
        )}
      </ActionDialog>

      {!terminal && <ProjectFormSheet open={editing} onOpenChange={setEditing} project={p} />}
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this project?"
        description="Only draft or cancelled projects can be archived. The record and its history are retained."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={doArchive}
      />
    </>
  );
}

export default function CapitalProjectPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <ProjectDetail id={params.id} />
    </Suspense>
  );
}
