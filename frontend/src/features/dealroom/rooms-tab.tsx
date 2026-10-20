"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderLock, Plus, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { useListQuery } from "@/hooks/use-list-query";
import { api, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber, formatRelative } from "@/lib/utils";

import { label, opts, useMutate } from "@/features/brokerage/api";
import { RecordSheet, State, party, type FieldSpec } from "@/features/brokerage/ui";

import { NDA_STATUSES, ROOM_STATUSES, type Nda, type Room } from "./api";

export const NDA_FIELDS: FieldSpec[] = [
  { key: "counterparty_kind", label: "Counterparty type", type: "select", options: opts(["person", "organization"]), required: true },
  { key: "person_id", label: "Person", type: "person", show: (v) => v.counterparty_kind !== "organization" },
  { key: "organization_id", label: "Organization", type: "organization" },
  { key: "status", label: "Status", type: "select", options: opts(NDA_STATUSES), required: true },
  { key: "sent_at", label: "Sent", type: "datetime" },
  { key: "signed_at", label: "Signed", type: "datetime" },
  { key: "expires_on", label: "Expires", type: "date" },
  { key: "signer_name", label: "Signer name", type: "text" },
  { key: "signer_email", label: "Signer email", type: "text" },
  { key: "document_id", label: "Signed NDA", type: "document", full: true },
  { key: "notes", label: "Notes", type: "textarea" },
];

const ROOM_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", type: "text", full: true, hint: "Defaults to the property name" },
  { key: "property_id", label: "Property", type: "property", full: true },
  { key: "status", label: "Status", type: "select", options: opts(ROOM_STATUSES), required: true },
  { key: "owner_id", label: "Room owner", type: "user" },
  { key: "requires_nda", label: "Confidentiality", type: "checkbox", placeholder: "Require a signed NDA for access" },
  { key: "allow_offers", label: "Offers", type: "checkbox", placeholder: "Accept offers through the room" },
  { key: "offer_deadline", label: "Offer deadline", type: "datetime" },
  { key: "description", label: "Description", type: "textarea" },
];

const columns: Column<Room>[] = [
  { id: "name", header: "Deal room", sortKey: "name", cell: (r) => <div className="min-w-[200px]"><p className="font-medium text-ink">{r.name}</p><p className="text-xs text-ink-3">{r.property_label ?? "—"}</p></div> },
  { id: "status", header: "Status", sortKey: "status", cell: (r) => <State value={r.status} /> },
  { id: "nda", header: "NDA", cell: (r) => (r.requires_nda ? <Badge tone="blue">Required</Badge> : <Badge tone="outline">Not required</Badge>) },
  { id: "grants", header: "Active grants", align: "right", cell: (r) => formatNumber(r.grant_count) },
  { id: "docs", header: "Documents", align: "right", cell: (r) => formatNumber(r.document_count) },
  { id: "views", header: "Views", align: "right", cell: (r) => formatNumber(r.view_count) },
  { id: "offers", header: "Offers", align: "right", cell: (r) => formatNumber(r.offer_count) },
  { id: "activity", header: "Last activity", cell: (r) => <span className="whitespace-nowrap text-xs text-ink-3">{r.last_activity_at ? formatRelative(r.last_activity_at) : "—"}</span> },
  { id: "owner", header: "Owner", cell: (r) => <span className="whitespace-nowrap text-ink-2">{r.owner_name ?? "—"}</span> },
];

function NdaRegister() {
  const { can } = useAuth();
  const [status, setStatus] = useState<string[]>([]);
  const [editing, setEditing] = useState<Nda | "new" | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["dealroom", "ndas", status], queryFn: () => api.get<Page<Nda>>("/ndas", { status, page_size: 100 }) });
  const save = useMutate(({ id, body }: { id?: string; body: Record<string, unknown> }) => (id ? api.patch(`/ndas/${id}`, body) : api.post("/ndas", body)), ["dealroom"]);
  const cols: Column<Nda>[] = [
    { id: "who", header: "Counterparty", cell: (n) => <span className="font-medium text-ink">{party(n) ?? "—"}</span> },
    { id: "status", header: "Status", cell: (n) => <State value={n.status} /> },
    { id: "effective", header: "Effective", cell: (n) => (n.is_effective ? <Badge tone="green">Yes</Badge> : <Badge tone="outline">No</Badge>) },
    { id: "signed", header: "Signed", cell: (n) => <span className="text-xs text-ink-2">{formatDate(n.signed_at)}</span> },
    { id: "expires", header: "Expires", cell: (n) => <span className="text-xs text-ink-2">{formatDate(n.expires_on)}</span> },
    { id: "signer", header: "Signer", cell: (n) => <span className="text-ink-2">{n.signer_name ?? "—"}</span> },
    { id: "doc", header: "Copy", cell: (n) => (n.document_id ? <Badge tone="green">On file</Badge> : <span className="text-ink-3">—</span>) },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Confidentiality agreements"
        description="NDA status per counterparty. Rooms that require an NDA only grant access to signed, unexpired NDAs."
        actions={
          <>
            <FacetFilter label="Status" options={opts(NDA_STATUSES)} selected={status} onChange={setStatus} />
            {can("dealroom", "create") && (
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus /> Record NDA
              </Button>
            )}
          </>
        }
      />
      <DataTable columns={cols} data={data?.items} loading={isLoading} dense onRowClick={(n) => can("dealroom", "edit") && setEditing(n)} empty={<EmptyState icon={<ShieldCheck />} title="No NDAs recorded" />} />
      <RecordSheet
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "Record NDA" : "Update NDA"}
        mode={editing === "new" ? "create" : "edit"}
        fields={NDA_FIELDS}
        initial={editing && editing !== "new" ? (editing as unknown as Record<string, unknown>) : { counterparty_kind: "person", status: "sent" }}
        onSubmit={(body) => save.mutateAsync({ id: editing && editing !== "new" ? editing.id : undefined, body })}
      />
    </Card>
  );
}

export function RoomsTab() {
  const router = useRouter();
  const { can } = useAuth();
  const list = useListQuery<Room>("dealroom", "/deal-rooms");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const create = useMutate((body: Record<string, unknown>) => api.post<Room>("/deal-rooms", body), ["dealroom", "brokerage"]);
  return (
    <div className="space-y-5">
      <ListCard
        toolbar={
          <Toolbar right={can("dealroom", "create") && <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New deal room</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search deal rooms…" />
            <FacetFilter label="Status" options={ROOM_STATUSES.map((s) => ({ value: s, label: label(s) }))} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
          </Toolbar>
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
          rowHref={(r) => `/tours/rooms/${r.id}`}
          empty={<EmptyState icon={<FolderLock />} title="No deal rooms" description="Open a deal room from a listing to share documents under controlled access." />}
        />
      </ListCard>
      <NdaRegister />
      <RecordSheet
        open={creating}
        onOpenChange={setCreating}
        title="New deal room"
        description="Default folders are created. Rooms opened from a listing inherit its access rules."
        fields={ROOM_FIELDS}
        initial={{ status: "draft", requires_nda: true, allow_offers: true }}
        onSubmit={async (b) => {
          const r = await create.mutateAsync({ ...b, requires_nda: b.requires_nda ?? false, allow_offers: b.allow_offers ?? false });
          router.push(`/tours/rooms/${r.id}`);
        }}
      />
    </div>
  );
}
