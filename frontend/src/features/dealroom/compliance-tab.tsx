"use client";

import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, CheckCircle2, FileCheck2, Megaphone, Plus, Radar, ScrollText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker } from "@/components/data/entity-picker";
import { FacetFilter, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, ListCard, StatCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Progress, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatDateTime, formatNumber } from "@/lib/utils";

import { label, opts, useMutate } from "@/features/brokerage/api";
import { DocumentPicker, RecordSheet, State, party, type FieldSpec } from "@/features/brokerage/ui";

import {
  AD_REVIEW_STATUSES,
  DELIVERY_METHODS,
  DISCLOSURE_STATUSES,
  DISCLOSURE_TYPES,
  FILE_ITEM_STATUSES,
  LICENSE_STATUSES,
  LICENSE_TYPES,
  type AdReview,
  type ComplianceSummary,
  type Disclosure,
  type FileItem,
  type License,
  type TxFile,
} from "./api";

const KEY = "dealroom";

interface DealLite { id: string; title: string; stage: string; side: string }
interface ListingLite { id: string; property_label: string | null; listing_type: string; status: string }

function DealPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  return (
    <EntityPicker<DealLite>
      endpoint="/brokerage-deals"
      value={value}
      onChange={(id) => onChange(id)}
      placeholder="Select brokerage deal"
      toOption={(d) => ({ id: d.id, label: d.title, sublabel: `${label(d.side)} · ${label(d.stage)}` })}
    />
  );
}

function ListingPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  return (
    <EntityPicker<ListingLite>
      endpoint="/listings"
      value={value}
      onChange={(id) => onChange(id)}
      placeholder="Select listing"
      toOption={(l) => ({ id: l.id, label: l.property_label ?? "Listing", sublabel: `${label(l.listing_type)} · ${label(l.status)}` })}
    />
  );
}

function footer(list: { page: number; pageSize: number; data?: { total: number }; url: ReturnType<typeof useUrlState> }) {
  return <TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => list.url.set({ page }, { resetPage: false })} onPageSize={(size) => list.url.set({ page_size: size })} />;
}

/* ================================================================== licenses */

const LICENSE_FIELDS: FieldSpec[] = [
  { key: "user_id", label: "Agent (user)", type: "user" },
  { key: "holder_name", label: "Holder name", type: "text", hint: "Defaults to the user's name" },
  { key: "license_type", label: "License type", type: "select", options: opts(LICENSE_TYPES), required: true },
  { key: "license_number", label: "License number", type: "text", required: true },
  { key: "state", label: "State", type: "text", required: true },
  { key: "status", label: "Status", type: "select", options: opts(LICENSE_STATUSES), required: true },
  { key: "issued_on", label: "Issued", type: "date" },
  { key: "expires_on", label: "Expires", type: "date", hint: "Creates a critical date; alerts start 60 days out" },
  { key: "ce_hours_required", label: "CE hours required", type: "number" },
  { key: "ce_hours_completed", label: "CE hours completed", type: "number" },
  { key: "sponsoring_broker", label: "Sponsoring broker", type: "text" },
  { key: "document_id", label: "License copy", type: "document", full: true },
  { key: "notes", label: "Notes", type: "textarea" },
];

function Licenses() {
  const { can } = useAuth();
  const list = useListQuery<License>(KEY, "/agent-licenses");
  const { url } = list;
  const [editing, setEditing] = useState<License | "new" | null>(null);
  const save = useMutate(({ id, body }: { id?: string; body: Record<string, unknown> }) => (id ? api.patch(`/agent-licenses/${id}`, body) : api.post("/agent-licenses", body)), [KEY]);
  const scan = useMutate(() => api.post<{ license_alerts: number; licenses_expired: number; disclosure_alerts: number }>("/agent-licenses/scan"), [KEY, "tasks"]);
  const columns: Column<License>[] = [
    { id: "holder", header: "Holder", sortKey: "holder_name", cell: (l) => <div><p className="font-medium text-ink">{l.holder_name}</p><p className="text-xs text-ink-3">{label(l.license_type)}</p></div> },
    { id: "number", header: "License", sortKey: "state", cell: (l) => <span className="font-mono text-xs text-ink-2">{l.state} {l.license_number}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (l) => <State value={l.status} /> },
    {
      id: "expires",
      header: "Expires",
      sortKey: "expires_on",
      cell: (l) => (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <span className={cn("text-xs", l.alert_level === "expired" ? "font-medium text-negative" : l.alert_level ? "font-medium text-caution" : "text-ink-2")}>{formatDate(l.expires_on)}</span>
          {l.alert_level && <Badge tone={l.alert_level === "warning" ? "amber" : "red"}>{l.alert_level === "expired" ? "Expired" : `${l.days_to_expiry}d`}</Badge>}
        </div>
      ),
    },
    {
      id: "ce",
      header: "CE hours",
      align: "right",
      cell: (l) => (l.ce_hours_required ? <span className={cn((l.ce_hours_completed ?? 0) < l.ce_hours_required && "text-caution")}>{formatNumber(l.ce_hours_completed ?? 0, 1)} / {formatNumber(l.ce_hours_required, 1)}</span> : "—"),
    },
    { id: "sponsor", header: "Sponsoring broker", cell: (l) => <span className="text-ink-2">{l.sponsoring_broker ?? "—"}</span> },
    { id: "copy", header: "Copy", cell: (l) => (l.document_id ? <Badge tone="green">On file</Badge> : <Badge tone="outline">Missing</Badge>) },
  ];
  return (
    <>
      <ListCard
        toolbar={
          <Toolbar
            right={
              <>
                {can("dealroom", "edit") && (
                  <Button
                    loading={scan.isPending}
                    onClick={() =>
                      scan.mutate(undefined, {
                        onSuccess: (r) => toast.success(`${r.license_alerts} license alerts, ${r.licenses_expired} newly expired, ${r.disclosure_alerts} disclosure alerts`),
                        onError: (e) => toast.error(errorMessage(e)),
                      })
                    }
                  >
                    <Radar /> Run expiration scan
                  </Button>
                )}
                {can("dealroom", "create") && (
                  <Button variant="primary" onClick={() => setEditing("new")}>
                    <Plus /> Add license
                  </Button>
                )}
              </>
            }
          >
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search holder, number…" />
            <FacetFilter label="Status" options={opts(LICENSE_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Expiring" single options={[30, 60, 90].map((d) => ({ value: String(d), label: `Within ${d} days` }))} selected={url.get("expiring_within_days") ? [url.get("expiring_within_days")!] : []} onChange={(v) => url.set({ expiring_within_days: v[0] ?? null })} />
          </Toolbar>
        }
        footer={footer(list)}
      >
        <DataTable columns={columns} data={list.data?.items} loading={list.isLoading} fetching={list.isFetching} sort={url.get("sort")} onSortChange={(sort) => url.set({ sort })} onRowClick={(l) => can("dealroom", "edit") && setEditing(l)} empty={<EmptyState icon={<BadgeCheck />} title="No licenses on file" description="Track broker and agent licenses; expirations raise alerts and critical dates." />} />
      </ListCard>
      <RecordSheet
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "Add license" : "Edit license"}
        mode={editing === "new" ? "create" : "edit"}
        fields={LICENSE_FIELDS}
        initial={editing && editing !== "new" ? (editing as unknown as Record<string, unknown>) : { license_type: "salesperson", status: "active" }}
        onSubmit={(body) => save.mutateAsync({ id: editing && editing !== "new" ? editing.id : undefined, body })}
      />
    </>
  );
}

/* ================================================================== disclosures */

const DISCLOSURE_FIELDS: FieldSpec[] = [
  { key: "disclosure_type", label: "Type", type: "select", options: opts(DISCLOSURE_TYPES), required: true },
  { key: "title", label: "Title", type: "text", hint: "Defaults to the type" },
  { key: "brokerage_deal_id", label: "Brokerage deal", type: "custom", render: (v, set) => <DealPicker value={(v as string) ?? null} onChange={set} /> },
  { key: "listing_id", label: "Listing", type: "custom", render: (v, set) => <ListingPicker value={(v as string) ?? null} onChange={set} /> },
  { key: "recipient_organization_id", label: "Recipient organization", type: "organization" },
  { key: "recipient_person_id", label: "Recipient contact", type: "person" },
  { key: "recipient_name", label: "Recipient name", type: "text" },
  { key: "due_on", label: "Due", type: "date", hint: "Creates a critical date and deadline alerts" },
  { key: "owner_id", label: "Owner", type: "user" },
  { key: "is_blocking", label: "Blocking", type: "checkbox", placeholder: "Blocks commission release until satisfied" },
  { key: "requires_acknowledgement", label: "Acknowledgement", type: "checkbox", placeholder: "Recipient must sign an acknowledgement" },
];

function DeliverDialog({ d, onClose }: { d: Disclosure; onClose: () => void }) {
  const [method, setMethod] = useState("email");
  const [doc, setDoc] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const deliver = useMutate((body: Record<string, unknown>) => api.post(`/disclosures/${d.id}/deliver`, body), [KEY]);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record delivery"
      description="Delivery evidence (document or note) is required."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={deliver.isPending} onClick={() => deliver.mutate({ delivery_method: method, evidence_document_id: doc, evidence_note: note || null }, { onSuccess: onClose, onError: (e) => toast.error(errorMessage(e)) })}>
            Record delivery
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)} options={opts(DELIVERY_METHODS)} />
        </Field>
        <Field label="Evidence document">
          <DocumentPicker value={doc} onChange={setDoc} />
        </Field>
        <Field label="Evidence note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Emailed to buyer counsel 3/4, read receipt on file" />
        </Field>
      </div>
    </Dialog>
  );
}

function AckDialog({ d, onClose }: { d: Disclosure; onClose: () => void }) {
  const [name, setName] = useState(d.recipient_name ?? "");
  const [doc, setDoc] = useState<string | null>(null);
  const ack = useMutate((body: Record<string, unknown>) => api.post(`/disclosures/${d.id}/acknowledge`, body), [KEY]);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={d.disclosure_type === "dual_agency" || d.disclosure_type === "intermediary" ? "Dual representation acknowledgement" : "Record acknowledgement"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={ack.isPending} onClick={() => ack.mutate({ acknowledged_by_name: name, acknowledgement_document_id: doc }, { onSuccess: onClose, onError: (e) => toast.error(errorMessage(e)) })}>
            Record acknowledgement
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Acknowledged by" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Signed acknowledgement">
          <DocumentPicker value={doc} onChange={setDoc} />
        </Field>
      </div>
    </Dialog>
  );
}

function Disclosures() {
  const { can } = useAuth();
  const list = useListQuery<Disclosure>(KEY, "/disclosures");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const [deliver, setDeliver] = useState<Disclosure | null>(null);
  const [ack, setAck] = useState<Disclosure | null>(null);
  const create = useMutate((body: Record<string, unknown>) => api.post("/disclosures", body), [KEY]);
  const waive = useMutate(({ id, reason }: { id: string; reason: string }) => api.post(`/disclosures/${id}/waive`, { reason }), [KEY]);
  const columns: Column<Disclosure>[] = [
    { id: "title", header: "Disclosure", sortKey: "title", cell: (d) => <div><p className="font-medium text-ink">{d.title}</p><p className="text-xs text-ink-3">{label(d.disclosure_type)}{d.property_label ? ` · ${d.property_label}` : ""}</p></div> },
    { id: "recipient", header: "Recipient", cell: (d) => <span className="text-ink-2">{party(d) ?? d.recipient_name ?? "—"}</span> },
    { id: "due", header: "Due", sortKey: "due_on", cell: (d) => <span className={cn("whitespace-nowrap text-xs", d.is_overdue ? "font-medium text-negative" : "text-ink-2")}>{formatDate(d.due_on)}{d.is_overdue ? " · overdue" : ""}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (d) => <State value={d.status} /> },
    { id: "evidence", header: "Evidence", cell: (d) => <span className="text-xs text-ink-2">{d.delivered_at ? `${label(d.delivery_method)} ${formatDate(d.delivered_at)}` : "—"}{d.acknowledged_at ? ` · ack by ${d.acknowledged_by_name}` : ""}</span> },
    { id: "blocking", header: "", cell: (d) => (d.is_blocking && !d.is_satisfied ? <Badge tone="red">Blocking</Badge> : d.is_satisfied ? <CheckCircle2 className="size-4 text-positive" /> : null) },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (d) =>
        d.status === "waived" ? null : (
          <div className="flex justify-end gap-1">
            {can("dealroom", "edit") && !d.delivered_at && <Button size="xs" onClick={() => setDeliver(d)}>Deliver</Button>}
            {can("dealroom", "edit") && d.requires_acknowledgement && d.delivered_at && d.status !== "acknowledged" && <Button size="xs" onClick={() => setAck(d)}>Acknowledge</Button>}
            {can("dealroom", "approve") && !d.is_satisfied && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  const reason = window.prompt("Reason for waiving this disclosure");
                  if (reason) waive.mutate({ id: d.id, reason }, { onError: (e) => toast.error(errorMessage(e)) });
                }}
              >
                Waive
              </Button>
            )}
          </div>
        ),
    },
  ];
  return (
    <>
      <ListCard
        toolbar={
          <Toolbar right={can("dealroom", "create") && <Button variant="primary" onClick={() => setCreating(true)}><Plus /> Required disclosure</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search disclosures…" />
            <FacetFilter label="Type" options={opts(DISCLOSURE_TYPES)} selected={url.getAll("disclosure_type")} onChange={(v) => url.set({ disclosure_type: v })} />
            <FacetFilter label="Status" options={opts(DISCLOSURE_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-sm text-ink-2 shadow-card">
              <Checkbox checked={url.get("overdue") === "true"} onChange={(c) => url.set({ overdue: c || null })} />
              Overdue
            </label>
          </Toolbar>
        }
        footer={footer(list)}
      >
        <DataTable columns={columns} data={list.data?.items} loading={list.isLoading} fetching={list.isFetching} sort={url.get("sort")} onSortChange={(sort) => url.set({ sort })} empty={<EmptyState icon={<ScrollText />} title="No required disclosures" description="Record agency, dual-representation and property disclosures with delivery evidence." />} />
      </ListCard>
      <RecordSheet open={creating} onOpenChange={setCreating} title="Required disclosure" description="Dual agency and intermediary disclosures require a signed acknowledgement by default." fields={DISCLOSURE_FIELDS} initial={{ disclosure_type: "agency", is_blocking: true }} onSubmit={(b) => create.mutateAsync(b)} />
      {deliver && <DeliverDialog d={deliver} onClose={() => setDeliver(null)} />}
      {ack && <AckDialog d={ack} onClose={() => setAck(null)} />}
    </>
  );
}

/* ================================================================== advertising review */

function DecisionDialog({ r, onClose }: { r: AdReview; onClose: () => void }) {
  const [checks, setChecks] = useState<Record<string, boolean>>(Object.fromEntries(r.checklist.map((c) => [c.key, c.checked])));
  const [notes, setNotes] = useState("");
  const decide = useMutate((status: string) => api.post(`/ad-reviews/${r.id}/decision`, { status, review_notes: notes || null, checklist: r.checklist.map((c) => ({ key: c.key, checked: !!checks[c.key] })) }), [KEY, "brokerage"]);
  const run = (status: string) => decide.mutate(status, { onSuccess: () => { toast.success(`Review ${label(status).toLowerCase()}`); onClose(); }, onError: (e) => toast.error(errorMessage(e)) });
  const all = r.checklist.every((c) => checks[c.key]);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Review: ${r.title}`}
      description={`Submitted by ${r.submitted_by_name ?? "—"} ${formatDateTime(r.submitted_at)}. Reviewers cannot approve their own submissions.`}
      footer={
        <>
          <Button onClick={() => run("rejected")} loading={decide.isPending}>Reject</Button>
          <Button onClick={() => run("changes_requested")} loading={decide.isPending}>Request changes</Button>
          <Button variant="primary" disabled={!all} loading={decide.isPending} onClick={() => run("approved")}>
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {r.content_summary && <p className="whitespace-pre-wrap text-sm text-ink-2">{r.content_summary}</p>}
        <ul className="space-y-1.5">
          {r.checklist.map((c) => (
            <li key={c.key} className="flex items-center gap-2 text-sm text-ink">
              <Checkbox checked={!!checks[c.key]} onChange={(v) => setChecks((s) => ({ ...s, [c.key]: v }))} />
              {c.label}
            </li>
          ))}
        </ul>
        <Field label="Notes" hint="Required when rejecting or requesting changes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

const AD_FIELDS: FieldSpec[] = [
  { key: "title", label: "Title", type: "text", required: true, full: true },
  { key: "listing_id", label: "Listing", type: "custom", render: (v, set) => <ListingPicker value={(v as string) ?? null} onChange={set} /> },
  { key: "channel", label: "Channel", type: "text", placeholder: "e.g. LoopNet, email, signage" },
  { key: "document_id", label: "Advertisement", type: "document", full: true },
  { key: "content_summary", label: "Content / copy", type: "textarea" },
];

function AdReviews() {
  const { can, user } = useAuth();
  const list = useListQuery<AdReview>(KEY, "/ad-reviews");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<AdReview | null>(null);
  const create = useMutate((body: Record<string, unknown>) => api.post("/ad-reviews", body), [KEY, "brokerage"]);
  const columns: Column<AdReview>[] = [
    { id: "title", header: "Advertisement", sortKey: "title", cell: (r) => <div><p className="font-medium text-ink">{r.title}</p><p className="text-xs text-ink-3">{r.channel ?? "—"}</p></div> },
    { id: "status", header: "Status", sortKey: "status", cell: (r) => <State value={r.status} /> },
    { id: "submitted", header: "Submitted", sortKey: "submitted_at", cell: (r) => <span className="whitespace-nowrap text-xs text-ink-2">{r.submitted_by_name ?? "—"} · {formatDate(r.submitted_at)}</span> },
    { id: "reviewer", header: "Reviewer", cell: (r) => <span className="whitespace-nowrap text-xs text-ink-2">{r.reviewer_name ? `${r.reviewer_name} · ${formatDate(r.reviewed_at)}` : "—"}</span> },
    { id: "notes", header: "Notes", cell: (r) => <span className="line-clamp-2 max-w-[280px] text-xs text-ink-2">{r.review_notes ?? "—"}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (r) => (r.status === "pending" && can("dealroom", "approve") && r.submitted_by_id !== user?.id ? <Button size="xs" onClick={() => setDeciding(r)}>Review</Button> : null),
    },
  ];
  return (
    <>
      <ListCard
        toolbar={
          <Toolbar right={can("dealroom", "create") && <Button variant="primary" onClick={() => setCreating(true)}><Plus /> Submit for review</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search advertisements…" />
            <FacetFilter label="Status" options={opts(AD_REVIEW_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
          </Toolbar>
        }
        footer={footer(list)}
      >
        <DataTable columns={columns} data={list.data?.items} loading={list.isLoading} fetching={list.isFetching} sort={url.get("sort")} onSortChange={(sort) => url.set({ sort })} empty={<EmptyState icon={<Megaphone />} title="No advertising reviews" description="Marketing must be approved by a reviewer before it is published or syndicated." />} />
      </ListCard>
      <RecordSheet open={creating} onOpenChange={setCreating} title="Submit advertising for review" fields={AD_FIELDS} onSubmit={(b) => create.mutateAsync(b)} />
      {deciding && <DecisionDialog r={deciding} onClose={() => setDeciding(null)} />}
    </>
  );
}

/* ================================================================== transaction files */

function ItemRow({ item }: { item: FileItem }) {
  const { can } = useAuth();
  const [note, setNote] = useState(item.evidence_note ?? "");
  const patch = useMutate((body: Record<string, unknown>) => api.patch(`/transaction-file-items/${item.id}`, body), [KEY, "brokerage"]);
  const run = (body: Record<string, unknown>) => patch.mutate(body, { onError: (e) => toast.error(errorMessage(e)) });
  const approver = can("dealroom", "approve");
  const statuses = FILE_ITEM_STATUSES.filter((s) => approver || !["approved", "waived", "rejected"].includes(s));
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {item.is_satisfied ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" /> : <span className="mt-1 size-3 shrink-0 rounded-full border-2 border-line-strong" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">
            {item.label}
            {item.is_required ? <span className="ml-1 text-negative">*</span> : <span className="ml-1 text-2xs text-ink-3">optional</span>}
          </p>
          <p className="text-xs text-ink-3">
            {label(item.category)}
            {item.document_title ? ` · ${item.document_title}` : ""}
            {item.waived_reason ? ` · waived: ${item.waived_reason}` : ""}
          </p>
        </div>
        {can("dealroom", "edit") ? (
          <select
            value={item.status}
            onChange={(e) => {
              const status = e.target.value;
              if (status === "waived") {
                const reason = window.prompt("Reason for waiving this item");
                if (reason) run({ status, waived_reason: reason });
              } else run({ status, evidence_note: note || undefined });
            }}
            className="h-7 rounded-md border border-line-strong/80 bg-surface px-1.5 text-xs"
          >
            {!statuses.includes(item.status as (typeof FILE_ITEM_STATUSES)[number]) && <option value={item.status}>{label(item.status)}</option>}
            {statuses.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        ) : (
          <State value={item.status} />
        )}
      </div>
      {can("dealroom", "edit") && (
        <div className="flex gap-2 pl-6">
          <div className="flex-1">
            <DocumentPicker value={item.document_id} onChange={(id) => run({ document_id: id })} placeholder="Attach evidence document…" />
          </div>
          <Input className="flex-1" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (item.evidence_note ?? "") && run({ evidence_note: note || null })} placeholder="Evidence note" />
        </div>
      )}
    </li>
  );
}

function FileSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const { data: f } = useQuery({ queryKey: [KEY, "file", id], queryFn: () => api.get<TxFile>(`/transaction-files/${id}`) });
  const [adding, setAdding] = useState(false);
  const [itemLabel, setItemLabel] = useState("");
  const add = useMutate((body: Record<string, unknown>) => api.post(`/transaction-files/${id}/items`, body), [KEY]);
  const approve = useMutate(() => api.post(`/transaction-files/${id}/approve`), [KEY, "brokerage", "commissions"]);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={f?.deal_title ?? "Transaction file"} description={f ? `${label(f.template_key)} side · ${label(f.deal_stage)} · ${f.agent_name ?? "No agent"}` : undefined} className="max-w-2xl">
      {!f ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-3">
              <Progress value={f.completeness_pct} className="flex-1" />
              <span className="text-sm font-semibold tabular">{formatNumber(f.completeness_pct, 0)}%</span>
              <State value={f.status} />
            </div>
            <p className="text-xs text-ink-3">
              {f.required_done} of {f.required_total} required items satisfied.{" "}
              {f.complete ? "Commission release is allowed." : "Commission release is blocked until every required item and blocking disclosure is satisfied."}
            </p>
            {f.blockers.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                {f.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {can("dealroom", "approve") && f.complete && f.status !== "approved" && (
              <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => approve.mutate(undefined, { onSuccess: () => toast.success("Transaction file approved"), onError: (e) => toast.error(errorMessage(e)) })}>
                <FileCheck2 /> Approve file
              </Button>
            )}
            {f.approved_at && <p className="text-xs text-positive">Approved {formatDateTime(f.approved_at)}</p>}
          </div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {f.items.map((i) => (
              <ItemRow key={`${i.id}-${i.status}-${i.document_id}`} item={i} />
            ))}
          </ul>
          {can("dealroom", "edit") &&
            (adding ? (
              <div className="flex gap-2">
                <Input autoFocus value={itemLabel} onChange={(e) => setItemLabel(e.target.value)} placeholder="Checklist item" />
                <Button
                  variant="primary"
                  disabled={!itemLabel.trim()}
                  loading={add.isPending}
                  onClick={() => add.mutate({ label: itemLabel, category: "other", is_required: true }, { onSuccess: () => { setItemLabel(""); setAdding(false); }, onError: (e) => toast.error(errorMessage(e)) })}
                >
                  Add
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add checklist item
              </Button>
            ))}
        </div>
      )}
    </Sheet>
  );
}

function TransactionFiles() {
  const list = useListQuery<TxFile>(KEY, "/transaction-files");
  const { url } = list;
  const openId = url.get("file");
  const columns: Column<TxFile>[] = [
    { id: "deal", header: "Deal", sortKey: "deal", cell: (f) => <div><p className="font-medium text-ink">{f.deal_title ?? "Deal"}</p><p className="text-xs text-ink-3">{label(f.template_key)} · {label(f.deal_stage)}</p></div> },
    {
      id: "complete",
      header: "Completeness",
      width: 220,
      cell: (f) => (
        <div className="flex items-center gap-2">
          <Progress value={f.completeness_pct} className="w-24" />
          <span className="text-xs tabular text-ink-2">
            {f.required_done}/{f.required_total}
          </span>
        </div>
      ),
    },
    { id: "status", header: "File", sortKey: "status", cell: (f) => <State value={f.status} /> },
    { id: "release", header: "Commission release", cell: (f) => (f.complete ? <Badge tone="green">Allowed</Badge> : <Badge tone="red">Blocked</Badge>) },
    { id: "blockers", header: "Outstanding", cell: (f) => <span className="line-clamp-2 max-w-[320px] text-xs text-ink-2">{f.blockers.join("; ") || "—"}</span> },
    { id: "agent", header: "Agent", cell: (f) => <span className="whitespace-nowrap text-ink-2">{f.agent_name ?? "—"}</span> },
  ];
  return (
    <>
      <ListCard
        toolbar={
          <Toolbar>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search deals…" />
            <FacetFilter label="File status" options={opts(["open", "complete", "approved"])} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-sm text-ink-2 shadow-card">
              <Checkbox checked={url.get("mine") === "true"} onChange={(c) => url.set({ mine: c || null })} />
              My deals
            </label>
          </Toolbar>
        }
        footer={footer(list)}
      >
        <DataTable columns={columns} data={list.data?.items} loading={list.isLoading} fetching={list.isFetching} sort={url.get("sort")} onSortChange={(sort) => url.set({ sort })} onRowClick={(f) => url.set({ file: f.id }, { resetPage: false })} empty={<EmptyState icon={<FileCheck2 />} title="No transaction files" description="A file opens automatically when a brokerage deal goes under contract." />} />
      </ListCard>
      {openId && <FileSheet id={openId} onClose={() => url.set({ file: null }, { resetPage: false })} />}
    </>
  );
}

/* ================================================================== tab */

export function ComplianceTab() {
  const url = useUrlState();
  const section = url.get("section") ?? "licenses";
  const { data: s } = useQuery({ queryKey: [KEY, "compliance-summary"], queryFn: () => api.get<ComplianceSummary>("/dealroom/compliance-summary") });
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Licenses expiring" value={s?.licenses_expiring ?? "—"} hint="Within 60 days" tone={s?.licenses_expiring ? "caution" : "default"} />
        <StatCard label="Licenses expired" value={s?.licenses_expired ?? "—"} tone={s?.licenses_expired ? "negative" : "default"} />
        <StatCard label="Open disclosures" value={s?.disclosures_open ?? "—"} />
        <StatCard label="Overdue disclosures" value={s?.disclosures_overdue ?? "—"} tone={s?.disclosures_overdue ? "negative" : "default"} />
        <StatCard label="Ads awaiting review" value={s?.ad_reviews_pending ?? "—"} />
        <StatCard label="Incomplete files" value={s?.files_incomplete ?? "—"} tone={s?.files_incomplete ? "caution" : "default"} />
      </div>
      <Tabs value={section} onValueChange={(v) => url.replaceAll({ tab: "compliance", section: v === "licenses" ? null : v })}>
        <TabList
          className="mb-4"
          tabs={[
            { value: "licenses", label: "Licenses" },
            { value: "disclosures", label: "Disclosures" },
            { value: "ads", label: "Advertising review" },
            { value: "files", label: "Transaction files" },
          ]}
        />
        <TabPanel value="licenses">
          <Licenses />
        </TabPanel>
        <TabPanel value="disclosures">
          <Disclosures />
        </TabPanel>
        <TabPanel value="ads">
          <AdReviews />
        </TabPanel>
        <TabPanel value="files">
          <TransactionFiles />
        </TabPanel>
      </Tabs>
    </div>
  );
}
