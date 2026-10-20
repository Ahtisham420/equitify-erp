"use client";

import { useQuery } from "@tanstack/react-query";
import { Ban, Download, Eye, FileText, FolderPlus, Pencil, Plus, ShieldAlert, UserPlus } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, formatNumber } from "@/lib/utils";

import { label, opts, useMutate } from "@/features/brokerage/api";
import { OffersTable } from "@/features/brokerage/listing-panels";
import { DocumentPicker, RecordSheet, State, party, type FieldSpec } from "@/features/brokerage/ui";
import { FINANCING_TYPES, ROOM_STATUSES, type Access, type Analytics, type Folder, type Room } from "@/features/dealroom/api";

const KEY = "dealroom";

const OFFER_FIELDS: FieldSpec[] = [
  { key: "buyer_entity", label: "Buyer entity", type: "text", full: true },
  { key: "submitter_organization_id", label: "Submitting organization", type: "organization" },
  { key: "submitter_person_id", label: "Submitting contact", type: "person" },
  { key: "submitter_name", label: "Submitter name", type: "text" },
  { key: "submitter_email", label: "Submitter email", type: "text" },
  { key: "price", label: "Price", type: "number", required: true, suffix: "$" },
  { key: "earnest_money", label: "Earnest money", type: "number", suffix: "$" },
  { key: "due_diligence_days", label: "Due diligence (days)", type: "number" },
  { key: "closing_days", label: "Closing (days)", type: "number" },
  { key: "financing_type", label: "Financing", type: "select", options: opts(FINANCING_TYPES) },
  { key: "expires_at", label: "Offer expires", type: "datetime" },
  { key: "contingencies", label: "Contingencies", type: "tags", full: true },
  { key: "document_id", label: "LOI / offer document", type: "document", full: true },
  { key: "terms", label: "Other terms", type: "textarea" },
];

const ROOM_EDIT_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", type: "text", required: true, full: true },
  { key: "owner_id", label: "Room owner", type: "user" },
  { key: "requires_nda", label: "Confidentiality", type: "checkbox", placeholder: "Require a signed NDA for access" },
  { key: "allow_offers", label: "Offers", type: "checkbox", placeholder: "Accept offers through the room" },
  { key: "offer_deadline", label: "Offer deadline", type: "datetime" },
  { key: "description", label: "Description", type: "textarea" },
];

async function openDoc(roomId: string, docId: string, action: "view" | "download") {
  try {
    const r = await api.post<{ url: string | null }>(`/deal-rooms/${roomId}/documents/${docId}/open`, undefined, { action });
    if (r.url) window.open(r.url, "_blank", "noopener");
    else toast.message("Access logged. The document file is not available for preview.");
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

function Folders({ room }: { room: Room }) {
  const { can } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: [KEY, "folders", room.id], queryFn: () => api.get<Folder[]>(`/deal-rooms/${room.id}/folders`) });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [restricted, setRestricted] = useState(false);
  const create = useMutate((body: Record<string, unknown>) => api.post(`/deal-rooms/${room.id}/folders`, body), [KEY]);
  const patch = useMutate(({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/deal-room-folders/${id}`, body), [KEY]);
  const edit = can("dealroom", "edit");
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-2">Every view and download is logged. Counterparties only see folders included in their grant; restricted folders need an explicit grant.</p>
        {edit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <FolderPlus /> New folder
          </Button>
        )}
      </div>
      {!data?.length && <Card><EmptyState title="No folders" /></Card>}
      <div className="grid gap-3 lg:grid-cols-2">
        {data?.map((f) => (
          <Card key={f.id}>
            <CardHeader
              title={f.name}
              description={`${f.documents.length} document${f.documents.length === 1 ? "" : "s"}`}
              actions={
                <>
                  {f.is_restricted && <Badge tone="amber">Restricted</Badge>}
                  {edit && (
                    <Button size="xs" variant="ghost" onClick={() => patch.mutate({ id: f.id, body: { is_restricted: !f.is_restricted } })}>
                      {f.is_restricted ? "Unrestrict" : "Restrict"}
                    </Button>
                  )}
                </>
              }
            />
            <CardBody className="space-y-2">
              {f.documents.map((d) => (
                <div key={d.id} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
                  <FileText className="size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{d.title ?? d.filename ?? "Document"}</span>
                  <Button size="icon-sm" variant="ghost" aria-label="View" onClick={() => openDoc(room.id, d.id, "view")}>
                    <Eye />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Download" onClick={() => openDoc(room.id, d.id, "download")}>
                    <Download />
                  </Button>
                  {edit && f.document_ids.includes(d.id) && (
                    <Button size="icon-sm" variant="ghost" aria-label="Remove from folder" onClick={() => patch.mutate({ id: f.id, body: { document_ids: f.document_ids.filter((x) => x !== d.id) } })}>
                      <Ban />
                    </Button>
                  )}
                </div>
              ))}
              {edit && (
                <DocumentPicker
                  value={null}
                  onChange={(docId) => docId && !f.document_ids.includes(docId) && patch.mutate({ id: f.id, body: { document_ids: [...f.document_ids, docId] } }, { onSuccess: () => toast.success("Document shared in folder"), onError: (e) => toast.error(errorMessage(e)) })}
                  placeholder="Add document to folder…"
                />
              )}
            </CardBody>
          </Card>
        ))}
      </div>
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="New folder"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={create.isPending}
              onClick={() => create.mutate({ name, is_restricted: restricted, sort_order: (data?.length ?? 0) + 1 }, { onSuccess: () => { setAdding(false); setName(""); }, onError: (e) => toast.error(errorMessage(e)) })}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
            Restricted (only counterparties granted this folder explicitly)
          </label>
        </div>
      </Dialog>
    </div>
  );
}

function AccessPanel({ room }: { room: Room }) {
  const { can } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: [KEY, "access", room.id], queryFn: () => api.get<Access[]>(`/deal-rooms/${room.id}/access`) });
  const folders = useQuery({ queryKey: [KEY, "folders", room.id], queryFn: () => api.get<Folder[]>(`/deal-rooms/${room.id}/folders`) });
  const [granting, setGranting] = useState(false);
  const grant = useMutate((body: Record<string, unknown>) => api.post(`/deal-rooms/${room.id}/access`, body), [KEY]);
  const revoke = useMutate((id: string) => api.post(`/deal-room-access/${id}/revoke`), [KEY]);
  const folderName = (id: string) => folders.data?.find((f) => f.id === id)?.name ?? "Folder";
  const columns: Column<Access>[] = [
    { id: "who", header: "Counterparty", cell: (a) => <div><p className="font-medium text-ink">{party(a) ?? a.user_name ?? a.email ?? "—"}</p><p className="text-xs text-ink-3">{label(a.grantee_kind)}{a.user_name ? ` · portal user ${a.user_name}` : ""}</p></div> },
    { id: "status", header: "Access", cell: (a) => <State value={a.effective_status} /> },
    { id: "nda", header: "NDA", cell: (a) => (a.nda_status ? <State value={a.nda_status} /> : room.requires_nda ? <Badge tone="amber">Missing</Badge> : <span className="text-ink-3">n/a</span>) },
    { id: "folders", header: "Folders", cell: (a) => <span className="text-xs text-ink-2">{a.folder_ids.length ? a.folder_ids.map(folderName).join(", ") : "All unrestricted"}</span> },
    { id: "rights", header: "Rights", cell: (a) => <span className="text-xs text-ink-2">{["View", a.can_download && "Download", a.can_submit_offers && "Offers"].filter(Boolean).join(", ")}</span> },
    { id: "expires", header: "Expires", cell: (a) => <span className="text-xs text-ink-2">{a.expires_at ? formatDate(a.expires_at) : "No expiry"}</span> },
    { id: "last", header: "Last access", cell: (a) => <span className="text-xs text-ink-3">{a.last_accessed_at ? formatDateTime(a.last_accessed_at) : "—"}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (a) =>
        can("dealroom", "edit") && a.status === "active" ? (
          <Button size="xs" variant="ghost" onClick={() => revoke.mutate(a.id, { onSuccess: () => toast.success("Access revoked"), onError: (e) => toast.error(errorMessage(e)) })}>
            Revoke
          </Button>
        ) : null,
    },
  ];
  const grantFields: FieldSpec[] = [
    { key: "grantee_kind", label: "Grant to", type: "select", options: [{ value: "person", label: "Person" }, { value: "organization", label: "Organization" }, { value: "user", label: "Portal user" }], required: true },
    { key: "person_id", label: "Person", type: "person", show: (v) => v.grantee_kind !== "organization", hint: "For portal users, the person whose NDA covers them" },
    { key: "organization_id", label: "Organization", type: "organization" },
    { key: "user_id", label: "Portal user", type: "user", show: (v) => v.grantee_kind === "user" },
    { key: "email", label: "Email", type: "text" },
    { key: "folder_ids", label: "Folders", type: "multiselect", options: (folders.data ?? []).map((f) => ({ value: f.id, label: f.name + (f.is_restricted ? " (restricted)" : "") })), hint: "None selected = all unrestricted folders" },
    { key: "can_download", label: "Download", type: "checkbox", placeholder: "Allow downloads" },
    { key: "can_submit_offers", label: "Offers", type: "checkbox", placeholder: "Allow offer submission" },
    { key: "expires_at", label: "Access expires", type: "datetime" },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Counterparty access"
        description={room.requires_nda ? "This room requires a signed, unexpired NDA; access is re-checked on every request." : "No NDA required for this room."}
        actions={can("dealroom", "edit") && <Button size="sm" onClick={() => setGranting(true)}><UserPlus /> Grant access</Button>}
      />
      <DataTable columns={columns} data={data} loading={isLoading} dense rowClassName={(a) => (a.effective_status !== "active" ? "bg-subtle/40" : undefined)} empty={<EmptyState icon={<ShieldAlert />} title="No access granted" description="Grant counterparties access to specific folders once their NDA is signed." />} />
      <RecordSheet
        open={granting}
        onOpenChange={setGranting}
        title="Grant deal-room access"
        description={room.requires_nda ? "The counterparty must have a signed NDA (recorded under Deal rooms › Confidentiality agreements)." : undefined}
        fields={grantFields}
        initial={{ grantee_kind: "person", can_download: false, can_submit_offers: true, folder_ids: [] }}
        onSubmit={(b) => grant.mutateAsync({ ...b, can_download: b.can_download ?? false, can_submit_offers: b.can_submit_offers ?? false })}
      />
    </Card>
  );
}

function AnalyticsPanel({ room }: { room: Room }) {
  const { data, isLoading } = useQuery({ queryKey: [KEY, "analytics", room.id], queryFn: () => api.get<Analytics>(`/deal-rooms/${room.id}/analytics`) });
  if (isLoading || !data) return <Skeleton className="h-40 w-full" />;
  type Viewer = Analytics["by_viewer"][number] & { id: string };
  type Doc = Analytics["by_document"][number] & { id: string };
  const viewers: Viewer[] = data.by_viewer.map((v, i) => ({ ...v, id: `${v.viewer}-${i}` }));
  const docs: Doc[] = data.by_document.map((d) => ({ ...d, id: d.document_id }));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Views" value={formatNumber(data.total_views)} />
        <StatCard label="Downloads" value={formatNumber(data.total_downloads)} />
        <StatCard label="Unique viewers" value={formatNumber(data.unique_viewers)} />
        <StatCard label="Denied attempts" value={formatNumber(data.denied)} tone={data.denied ? "caution" : "default"} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="By viewer" />
          <DataTable<Viewer>
            dense
            data={viewers}
            columns={[
              { id: "viewer", header: "Viewer", cell: (v) => <span className="text-ink">{v.viewer}{v.internal && <span className="ml-1 text-2xs text-ink-3">(internal)</span>}</span> },
              { id: "views", header: "Views", align: "right", cell: (v) => v.views },
              { id: "dl", header: "Downloads", align: "right", cell: (v) => v.downloads },
              { id: "docs", header: "Docs", align: "right", cell: (v) => v.documents },
              { id: "last", header: "Last", cell: (v) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(v.last_at)}</span> },
            ]}
            empty={<EmptyState title="No activity yet" />}
          />
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="By document" />
          <DataTable<Doc>
            dense
            data={docs}
            columns={[
              { id: "title", header: "Document", cell: (d) => <span className="text-ink">{d.title ?? "Document"}</span> },
              { id: "views", header: "Views", align: "right", cell: (d) => d.views },
              { id: "dl", header: "Downloads", align: "right", cell: (d) => d.downloads },
              { id: "uv", header: "Viewers", align: "right", cell: (d) => d.unique_viewers },
            ]}
            empty={<EmptyState title="No document activity" />}
          />
        </Card>
      </div>
      <Card className="overflow-hidden">
        <CardHeader title="Access log" description="Who viewed what and when, including denied attempts" />
        <DataTable
          dense
          data={data.recent}
          columns={[
            { id: "at", header: "When", cell: (l) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(l.at)}</span> },
            { id: "who", header: "Who", cell: (l) => <span className="text-ink">{l.actor_name ?? "—"}{l.is_internal && <span className="ml-1 text-2xs text-ink-3">(internal)</span>}</span> },
            { id: "action", header: "Action", cell: (l) => <Badge tone={l.action === "denied" ? "red" : l.action === "download" ? "blue" : "neutral"}>{label(l.action)}</Badge> },
            { id: "doc", header: "Document", cell: (l) => <span className="text-ink-2">{l.document_title ?? "—"}</span> },
            { id: "detail", header: "Detail", cell: (l) => <span className="text-xs text-ink-3">{l.detail ?? ""}</span> },
          ]}
          empty={<EmptyState title="No access recorded" />}
        />
      </Card>
    </div>
  );
}

function RoomDetail({ id }: { id: string }) {
  const url = useUrlState();
  const { can } = useAuth();
  const { data: room, isLoading, error } = useQuery({ queryKey: [KEY, "room", id], queryFn: () => api.get<Room>(`/deal-rooms/${id}`) });
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const update = useMutate((body: Record<string, unknown>) => api.patch(`/deal-rooms/${id}`, body), [KEY, "brokerage"]);
  const submitOffer = useMutate((body: Record<string, unknown>) => api.post(`/deal-rooms/${id}/offers`, body), [KEY, "brokerage"]);
  const tab = url.get("tab") ?? "folders";

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !room) return <EmptyState title="Deal room not available" description={errorMessage(error)} action={<Link href="/tours?tab=rooms"><Button>Back to deal rooms</Button></Link>} />;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Tours", href: "/tours" }, { label: "Deal rooms", href: "/tours?tab=rooms" }, { label: room.name }]}
        title={room.name}
        description={room.description ?? room.property_label ?? undefined}
        meta={
          <>
            <State value={room.status} />
            {room.requires_nda ? <Badge tone="blue">NDA required</Badge> : <Badge tone="outline">No NDA</Badge>}
            {room.offer_deadline && <span className="text-xs text-ink-3">Offers due {formatDateTime(room.offer_deadline)}</span>}
            {room.listing_id && (
              <Link href={`/listings/${room.listing_id}`} className="text-xs font-medium text-accent hover:underline">
                Listing
              </Link>
            )}
          </>
        }
        actions={
          can("dealroom", "edit") && (
            <>
              <Select value={room.status} onChange={(e) => update.mutate({ status: e.target.value }, { onError: (err) => toast.error(errorMessage(err)) })} options={opts(ROOM_STATUSES)} className="w-32" />
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </>
          )
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Documents" value={formatNumber(room.document_count)} />
        <StatCard label="Active grants" value={formatNumber(room.grant_count)} />
        <StatCard label="Views & downloads" value={formatNumber(room.view_count)} hint={room.last_activity_at ? `Last ${formatDateTime(room.last_activity_at)}` : undefined} />
        <StatCard label="Offers" value={formatNumber(room.offer_count)} />
      </div>
      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "folders" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "folders", label: "Folders & documents" },
            { value: "access", label: "Access & NDAs", count: room.grant_count },
            { value: "analytics", label: "Access analytics" },
            { value: "offers", label: "Offer submissions", count: room.offer_count },
            { value: "audit", label: "Audit" },
          ]}
        />
        <TabPanel value="folders">
          <Folders room={room} />
        </TabPanel>
        <TabPanel value="access">
          <AccessPanel room={room} />
        </TabPanel>
        <TabPanel value="analytics">
          <AnalyticsPanel room={room} />
        </TabPanel>
        <TabPanel value="offers">
          <Card className="overflow-hidden">
            <CardHeader
              title="Offer submissions"
              description="Structured offers from counterparties; review status changes are audited"
              actions={can("dealroom", "create") && room.allow_offers && <Button size="sm" onClick={() => setRecording(true)}><Plus /> Record offer</Button>}
            />
            <OffersTable params={{ room_id: id }} />
          </Card>
        </TabPanel>
        <TabPanel value="audit">
          <Card>
            <CardBody>
              <RecordTimeline entityType="deal_room" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>
      <RecordSheet open={editing} onOpenChange={setEditing} title="Edit deal room" mode="edit" fields={ROOM_EDIT_FIELDS} initial={room as unknown as Record<string, unknown>} onSubmit={(b) => update.mutateAsync(b)} />
      <RecordSheet
        open={recording}
        onOpenChange={setRecording}
        title="Record offer"
        description="Use for offers received outside the portal. Counterparty portal users submit directly."
        fields={OFFER_FIELDS}
        onSubmit={(b) => submitOffer.mutateAsync(b)}
      />
    </>
  );
}

export default function DealRoomPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <RoomDetail id={params.id} />
    </Suspense>
  );
}
