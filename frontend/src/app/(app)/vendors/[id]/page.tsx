"use client";

import { Archive, Check, ExternalLink, MoreHorizontal, Pencil, Plus, ShieldAlert, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { RecordDocuments } from "@/features/documents/record-documents";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import {
  CREDENTIAL_LABELS,
  expiryTone,
  useAddReview,
  useArchiveVendor,
  useRemoveCredential,
  useVendor,
  type Certificate,
  type Credential,
  type Review,
  type Vendor,
  type VendorRate,
} from "@/features/operations/api";
import { CredentialSheet, CredentialStatusBadge } from "@/features/operations/credential-sheet";
import { ComplianceBadge, VendorFormSheet, VendorStatusBadge, serviceLabel } from "@/features/operations/vendor-form";

type WorkOrderRow = Vendor["work_orders"][number];
type BidRow = Vendor["bids"][number];

const BID_TONES: Record<string, Tone> = { submitted: "sky", shortlisted: "blue", awarded: "green", rejected: "red", withdrawn: "neutral" };
const CERT_TONES: Record<string, Tone> = { requested: "sky", compliant: "green", deficient: "red", expired: "neutral" };
const TONE_TEXT: Record<string, string> = { red: "text-negative", amber: "text-caution", green: "text-ink-2", neutral: "text-ink-3" };

function ToneBadge({ status, tones }: { status: string; tones: Record<string, Tone> }) {
  return (
    <Badge tone={tones[status] ?? "neutral"} dot>
      {titleCase(status)}
    </Badge>
  );
}

function daysLabel(days: number | null): string {
  if (days === null) return "";
  if (days < 0) return `${-days}d ago`;
  if (days === 0) return "today";
  return `in ${days}d`;
}

function Stars({ value, size = "size-3.5" }: { value: number | null | undefined; size?: string }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn(size, i <= Math.round(value) ? "fill-current text-caution" : "text-line-strong")} />
      ))}
    </span>
  );
}

function RatingInput({ value, onChange, optional }: { value: number | null; onChange: (v: number | null) => void; optional?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(i)}
          className="rounded p-0.5 hover:bg-muted"
          aria-label={`${i} of 5`}
          aria-pressed={value === i}
        >
          <Star className={cn("size-5", value !== null && i <= value ? "fill-current text-caution" : "text-line-strong")} />
        </button>
      ))}
      {optional && value !== null && (
        <button type="button" onClick={() => onChange(null)} className="ml-1 text-xs text-ink-3 hover:text-ink">
          Clear
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function Overview({ v }: { v: Vendor }) {
  const perf = v.performance;
  const rates = v.rates.map((r, i) => ({ ...r, id: String(i) }));
  const contracts = v.contracts.map((c, i) => ({ ...c, id: String(i) }));

  const rateColumns: Column<VendorRate & { id: string }>[] = [
    { id: "service", header: "Service", cell: (r) => <span className="font-medium">{r.service}</span> },
    { id: "unit", header: "Unit", cell: (r) => <span className="text-ink-2">{r.unit ? (r.unit === "sf" ? "Per SF" : `Per ${r.unit}`) : "—"}</span> },
    { id: "rate", header: "Rate", align: "right", cell: (r) => (r.rate != null ? formatCurrency(r.rate) : "—") },
    { id: "notes", header: "Notes", cell: (r) => <span className="text-ink-2">{r.notes ?? "—"}</span> },
  ];
  const contractColumns: Column<(typeof contracts)[number]>[] = [
    { id: "title", header: "Contract", cell: (c) => <span className="font-medium">{c.title}</span> },
    { id: "start", header: "Start", cell: (c) => <span className="text-ink-2">{formatDate(c.start_on)}</span> },
    {
      id: "end",
      header: "End",
      cell: (c) => {
        const ended = !!c.end_on && c.end_on < new Date().toISOString().slice(0, 10);
        return <span className={ended ? "text-ink-3" : "text-ink-2"}>{formatDate(c.end_on)}{ended ? " · ended" : ""}</span>;
      },
    },
    { id: "value", header: "Value", align: "right", cell: (c) => (c.value != null ? formatCurrency(c.value) : "—") },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total spend" value={formatCurrency(v.spend.total)} hint="Completed work orders and paid project draws" />
        <StatCard label="Spend year to date" value={formatCurrency(v.spend.ytd)} />
        <StatCard label="Work-order spend" value={formatCurrency(v.spend.work_orders_total)} />
        <StatCard label="Project spend" value={formatCurrency(v.spend.projects_total)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Profile" />
            <CardBody>
              <FieldGrid cols={3}>
                <FieldItem label="Primary contact">{v.primary_contact_name}</FieldItem>
                <FieldItem label="Email">{v.email ? <a href={`mailto:${v.email}`} className="text-accent hover:underline">{v.email}</a> : null}</FieldItem>
                <FieldItem label="Phone">{v.phone}</FieldItem>
                <FieldItem label="Address">{v.address}</FieldItem>
                <FieldItem label="Service area">{v.service_area}</FieldItem>
                <FieldItem label="Organization">
                  {v.organization_id ? (
                    <Link href={`/organizations/${v.organization_id}`} className="text-accent hover:underline">
                      View organization
                    </Link>
                  ) : null}
                </FieldItem>
                <FieldItem label="Requires insurance">{v.requires_insurance ? "Yes" : "No"}</FieldItem>
                <FieldItem label="Requires license">{v.requires_license ? "Yes" : "No"}</FieldItem>
                <FieldItem label="Tags">
                  {v.tags.length ? (
                    <span className="flex flex-wrap gap-1">
                      {v.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </span>
                  ) : null}
                </FieldItem>
              </FieldGrid>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Contacts" />
            {v.contacts.length ? (
              <ul className="divide-y divide-line">
                {v.contacts.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{c.name}</p>
                      {c.role && <p className="text-xs text-ink-3">{c.role}</p>}
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-ink-2">
                      {c.email && (
                        <a href={`mailto:${c.email}`} className="hover:underline">
                          {c.email}
                        </a>
                      )}
                      {c.phone && <span>{c.phone}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <CardBody className="text-sm text-ink-3">No additional contacts.</CardBody>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Rates" />
            <DataTable columns={rateColumns} data={rates} dense empty={<EmptyState title="No rates recorded" />} />
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Contracts" description="Executed contract files live on the documents tab." />
            <DataTable columns={contractColumns} data={contracts} dense empty={<EmptyState title="No contracts recorded" />} />
          </Card>

          {v.notes && (
            <Card>
              <CardHeader title="Notes" />
              <CardBody>
                <p className="whitespace-pre-wrap text-sm text-ink-2">{v.notes}</p>
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Performance" description="From reviews, completed work orders and bids" />
            <CardBody>
              <div className="mb-4 flex items-end justify-between">
                <div>
                  <p className="text-3xl font-semibold tracking-tight tabular">{perf.review_rating != null ? formatNumber(perf.review_rating, 1) : "—"}</p>
                  <p className="text-xs text-ink-3">{perf.review_count} reviews</p>
                </div>
                <Stars value={perf.review_rating} size="size-4" />
              </div>
              <FieldGrid cols={2}>
                <FieldItem label="Satisfaction avg">{perf.satisfaction_avg != null ? `${formatNumber(perf.satisfaction_avg, 2)} / 5` : null}</FieldItem>
                <FieldItem label="Completed work orders">{formatNumber(perf.completed_work_orders)}</FieldItem>
                <FieldItem label="On time">{perf.on_time_pct != null ? formatPercent(perf.on_time_pct, 0) : null}</FieldItem>
                <FieldItem label="Avg days to complete">{perf.avg_days_to_complete != null ? formatNumber(perf.avg_days_to_complete, 1) : null}</FieldItem>
                <FieldItem label="Bids won / submitted">{`${perf.bids_won} / ${perf.bids_submitted}`}</FieldItem>
                <FieldItem label="Win rate">{perf.bids_submitted ? formatPercent((100 * perf.bids_won) / perf.bids_submitted, 0) : null}</FieldItem>
              </FieldGrid>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Record" />
            <CardBody>
              <FieldGrid cols={1}>
                <FieldItem label="Next credential expiry">{v.next_expiry_on ? formatDate(v.next_expiry_on) : null}</FieldItem>
                <FieldItem label="Created">{formatDateTime(v.created_at)}</FieldItem>
                <FieldItem label="Last updated">{formatDateTime(v.updated_at)}</FieldItem>
              </FieldGrid>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ credentials */

function Credentials({ v }: { v: Vendor }) {
  const { can } = useAuth();
  const canEdit = can("operations", "edit");
  const remove = useRemoveCredential();
  const [sheet, setSheet] = useState<{ open: boolean; credential: Credential | null }>({ open: false, credential: null });
  const [removing, setRemoving] = useState<Credential | null>(null);

  const doRemove = () => {
    if (!removing) return;
    remove.mutate(removing.id, {
      onSuccess: () => {
        toast.success("Credential removed");
        setRemoving(null);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const columns: Column<Credential>[] = [
    { id: "kind", header: "Kind", cell: (c) => <span className="whitespace-nowrap text-ink-2">{CREDENTIAL_LABELS[c.kind] ?? titleCase(c.kind)}</span> },
    {
      id: "name",
      header: "Name",
      cell: (c) => (
        <div className="min-w-[160px]">
          <p className="font-medium text-ink">{c.name}</p>
          {c.issuer && <p className="text-xs text-ink-3">{c.issuer}</p>}
        </div>
      ),
    },
    { id: "number", header: "Number", cell: (c) => <span className="font-mono text-xs text-ink-2">{c.number ?? "—"}</span> },
    { id: "coverage", header: "Coverage", align: "right", cell: (c) => (c.coverage_amount != null ? formatCurrency(c.coverage_amount) : "—") },
    {
      id: "expires",
      header: "Expires",
      cell: (c) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <CredentialStatusBadge status={c.status} />
          <span className={cn("text-xs", TONE_TEXT[expiryTone(c.days_to_expiry)])}>
            {c.expires_on ? `${formatDate(c.expires_on)} · ${daysLabel(c.days_to_expiry)}` : "No expiry"}
          </span>
        </div>
      ),
    },
    {
      id: "verified",
      header: "Verified",
      cell: (c) =>
        c.verified_at ? (
          <span className="inline-flex items-center gap-1 text-xs text-positive" title={formatDateTime(c.verified_at)}>
            <Check className="size-3.5" /> Verified
          </span>
        ) : (
          <span className="text-xs text-ink-3">Unverified</span>
        ),
    },
    { id: "required", header: "Required", cell: (c) => (c.is_required ? <Badge tone="outline">Required</Badge> : <span className="text-xs text-ink-3">Optional</span>) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) =>
        canEdit ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Credential actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Pencil />} onSelect={() => setSheet({ open: true, credential: c })}>
                  Edit and documents
                </MenuItem>
                <MenuItem icon={<Trash2 />} destructive onSelect={() => setRemoving(c)}>
                  Remove
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        ) : null,
    },
  ];

  const certColumns: Column<Certificate>[] = [
    { id: "coverage", header: "Coverage", cell: (c) => <span className="font-medium">{titleCase(c.coverage_type)}</span> },
    { id: "carrier", header: "Carrier", cell: (c) => <span className="text-ink-2">{c.carrier ?? "—"}</span> },
    { id: "policy", header: "Policy #", cell: (c) => <span className="font-mono text-xs text-ink-2">{c.policy_number ?? "—"}</span> },
    { id: "limit", header: "Limit", align: "right", cell: (c) => (c.limit_amount != null ? formatCurrency(c.limit_amount) : "—") },
    {
      id: "expires",
      header: "Expires",
      cell: (c) => (
        <span className={cn("whitespace-nowrap text-xs", TONE_TEXT[expiryTone(c.days_to_expiry)])}>
          {c.expires_on ? `${formatDate(c.expires_on)} · ${daysLabel(c.days_to_expiry)}` : "—"}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (c) => (
        <div className="min-w-[120px]">
          <ToneBadge status={c.status} tones={CERT_TONES} />
          {c.deficiencies.length > 0 && <p className="mt-0.5 text-xs text-negative">{c.deficiencies.join("; ")}</p>}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <CardHeader
          title="Credentials"
          description="Licenses, certificates of insurance and tax forms. An expired required credential blocks assignments and awards."
          actions={
            canEdit && (
              <Button size="sm" variant="primary" onClick={() => setSheet({ open: true, credential: null })}>
                <Plus /> Add credential
              </Button>
            )
          }
        />
        <DataTable
          columns={columns}
          data={v.credentials}
          onRowClick={canEdit ? (c) => setSheet({ open: true, credential: c }) : undefined}
          rowClassName={(c) => (c.status === "expired" || c.status === "rejected" ? "bg-negative-soft/40" : undefined)}
          empty={<EmptyState title="No credentials on file" description="Add the vendor's insurance certificate, license and W-9." />}
        />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Insurance certificates"
          description="Certificates collected through insurance tracking also satisfy the insurance requirement."
          actions={
            <Link href="/insurance?tab=certificates">
              <Button size="sm" variant="ghost">
                Open certificates <ExternalLink />
              </Button>
            </Link>
          }
        />
        <DataTable columns={certColumns} data={v.certificates} dense empty={<EmptyState title="No certificates collected" />} />
      </Card>

      <CredentialSheet open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))} vendorId={v.id} credential={sheet.credential} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this credential?"
        description="The credential is archived and kept in the audit history. Compliance is re-evaluated immediately."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={doRemove}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ work orders, bids, reviews */

function WorkOrders({ v }: { v: Vendor }) {
  const columns: Column<WorkOrderRow>[] = [
    { id: "number", header: "#", width: 70, cell: (w) => <span className="text-ink-3 tabular">#{w.number}</span> },
    { id: "title", header: "Work order", cell: (w) => <span className="font-medium">{w.title}</span> },
    { id: "status", header: "Status", cell: (w) => <StatusBadge status={w.status} /> },
    { id: "cost", header: "Actual cost", align: "right", cell: (w) => (w.actual_cost != null ? formatCurrency(w.actual_cost) : "—") },
    { id: "rating", header: "Satisfaction", cell: (w) => <Stars value={w.satisfaction_rating} /> },
    { id: "completed", header: "Completed", cell: (w) => <span className="whitespace-nowrap text-ink-2">{formatDate(w.completed_at)}</span> },
    { id: "created", header: "Created", cell: (w) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(w.created_at)}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Work orders" description="Most recent 50 work orders assigned to this vendor." />
      <DataTable
        columns={columns}
        data={v.work_orders}
        rowHref={(w) => `/work-orders/${w.id}`}
        empty={<EmptyState title="No work orders" description="Work orders assigned to this vendor will appear here." />}
      />
    </Card>
  );
}

function Bids({ v }: { v: Vendor }) {
  const columns: Column<BidRow>[] = [
    {
      id: "project",
      header: "Project",
      cell: (b) => (
        <Link href={`/capital-projects/${b.project_id}`} className="font-medium text-ink hover:underline">
          {b.project_name ?? "Capital project"}
        </Link>
      ),
    },
    { id: "amount", header: "Amount", align: "right", cell: (b) => formatCurrency(b.amount) },
    { id: "status", header: "Status", cell: (b) => <ToneBadge status={b.status} tones={BID_TONES} /> },
    { id: "submitted", header: "Submitted", cell: (b) => <span className="whitespace-nowrap text-ink-2">{formatDate(b.submitted_on ?? b.created_at)}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Bid history" description={`${v.performance.bids_won} won of ${v.performance.bids_submitted} submitted`} />
      <DataTable
        columns={columns}
        data={v.bids}
        rowHref={(b) => `/capital-projects/${b.project_id}`}
        empty={<EmptyState title="No bids yet" description="Bids this vendor submits on capital projects appear here." />}
      />
    </Card>
  );
}

function Reviews({ v }: { v: Vendor }) {
  const { can } = useAuth();
  const add = useAddReview(v.id);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ rating: number | null; quality: number | null; timeliness: number | null; communication: number | null; comment: string }>({
    rating: null,
    quality: null,
    timeliness: null,
    communication: null,
    comment: "",
  });

  const openDialog = () => {
    setForm({ rating: null, quality: null, timeliness: null, communication: null, comment: "" });
    setOpen(true);
  };

  const submit = () => {
    if (!form.rating) return;
    add.mutate(
      { rating: form.rating, quality: form.quality, timeliness: form.timeliness, communication: form.communication, comment: form.comment.trim() || null },
      {
        onSuccess: () => {
          toast.success("Review added");
          setOpen(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const sub = (r: Review) =>
    (
      [
        ["Quality", r.quality],
        ["Timeliness", r.timeliness],
        ["Communication", r.communication],
      ] as const
    ).filter(([, val]) => val != null);

  return (
    <Card>
      <CardHeader
        title="Reviews"
        description={v.performance.review_rating != null ? `Average ${formatNumber(v.performance.review_rating, 1)} of 5 across ${v.performance.review_count} reviews` : "No reviews yet"}
        actions={
          can("operations", "edit") && (
            <Button size="sm" variant="primary" onClick={openDialog}>
              <Plus /> Add review
            </Button>
          )
        }
      />
      {v.reviews.length === 0 ? (
        <EmptyState icon={<Star />} title="No reviews yet" description="Rate the vendor after a job to build its performance record." />
      ) : (
        <ul className="divide-y divide-line">
          {v.reviews.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Stars value={r.rating} />
                  <span className="text-sm font-medium tabular">{r.rating} / 5</span>
                </div>
                <span className="text-xs text-ink-3" title={formatDateTime(r.created_at)}>
                  {formatRelative(r.created_at)}
                </span>
              </div>
              {sub(r).length > 0 && (
                <p className="mt-1 flex flex-wrap gap-3 text-xs text-ink-3">
                  {sub(r).map(([label, val]) => (
                    <span key={label}>
                      {label} <span className="font-medium text-ink-2 tabular">{val}</span>
                    </span>
                  ))}
                </p>
              )}
              {r.comment && <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink-2">{r.comment}</p>}
              {(r.work_order_id || r.project_id) && (
                <p className="mt-1 text-xs">
                  {r.work_order_id && (
                    <Link href={`/work-orders/${r.work_order_id}`} className="text-accent hover:underline">
                      Work order
                    </Link>
                  )}
                  {r.project_id && (
                    <Link href={`/capital-projects/${r.project_id}`} className="ml-3 text-accent hover:underline">
                      Capital project
                    </Link>
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add review"
        description="Reviews feed the vendor performance rating."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.rating} loading={add.isPending} onClick={submit}>
              Add review
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Overall" required>
            <RatingInput value={form.rating} onChange={(val) => setForm((f) => ({ ...f, rating: val }))} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Quality">
              <RatingInput optional value={form.quality} onChange={(val) => setForm((f) => ({ ...f, quality: val }))} />
            </Field>
            <Field label="Timeliness">
              <RatingInput optional value={form.timeliness} onChange={(val) => setForm((f) => ({ ...f, timeliness: val }))} />
            </Field>
            <Field label="Communication">
              <RatingInput optional value={form.communication} onChange={(val) => setForm((f) => ({ ...f, communication: val }))} />
            </Field>
          </div>
          <Field label="Comment">
            <Textarea value={form.comment} onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

function VendorDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: v, isLoading, error } = useVendor(id);
  const archive = useArchiveVendor();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
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
  if (error || !v) {
    return (
      <EmptyState
        title="Vendor not found"
        description={errorMessage(error)}
        action={
          <Link href="/vendors">
            <Button>Back to vendors</Button>
          </Link>
        }
      />
    );
  }

  const doArchive = () =>
    archive.mutate(id, {
      onSuccess: () => {
        toast.success("Vendor archived");
        router.replace("/vendors");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Vendors", href: "/vendors" }, { label: v.name }]}
        title={v.name}
        description={[v.primary_contact_name, v.email, v.phone].filter(Boolean).join(" · ") || undefined}
        meta={
          <>
            <VendorStatusBadge status={v.status} />
            <ComplianceBadge compliant={v.compliant} reasons={v.compliance_reasons} />
            {v.services.map((s) => (
              <Badge key={s} tone="outline">
                {serviceLabel(s)}
              </Badge>
            ))}
          </>
        }
        actions={
          <>
            {can("operations", "edit") && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            )}
            {can("operations", "delete") && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                    Archive vendor
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      {!v.compliant && (
        <div className="mb-5 flex gap-3 rounded-lg border border-negative/30 bg-negative-soft px-4 py-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-negative" />
          <div className="min-w-0">
            <p className="font-medium text-negative">Not compliant</p>
            <p className="text-ink-2">Assignment to work orders and project awards is blocked until resolved.</p>
            {v.compliance_reasons.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-ink-2">
                {v.compliance_reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {can("operations", "edit") && tab !== "credentials" && (
              <button onClick={() => url.set({ tab: "credentials" })} className="mt-2 text-xs font-medium text-accent hover:underline">
                Review credentials
              </button>
            )}
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(t) => url.set({ tab: t === "overview" ? null : t })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "credentials", label: "Credentials", count: v.credentials.length },
            { value: "work-orders", label: "Work orders", count: v.work_orders.length },
            { value: "bids", label: "Bids", count: v.bids.length },
            { value: "reviews", label: "Reviews", count: v.reviews.length },
            { value: "documents", label: "Documents" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="overview">
          <Overview v={v} />
        </TabPanel>
        <TabPanel value="credentials">
          <Credentials v={v} />
        </TabPanel>
        <TabPanel value="work-orders">
          <WorkOrders v={v} />
        </TabPanel>
        <TabPanel value="bids">
          <Bids v={v} />
        </TabPanel>
        <TabPanel value="reviews">
          <Reviews v={v} />
        </TabPanel>
        <TabPanel value="documents">
          <RecordDocuments entityType="vendor" entityId={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="vendor" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <VendorFormSheet open={editing} onOpenChange={setEditing} vendor={v} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this vendor?"
        description="The vendor is set inactive and removed from lists. Its credentials, work orders, bids and history are retained."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={doArchive}
      />
    </>
  );
}

export default function VendorPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <VendorDetail id={params.id} />
    </Suspense>
  );
}
