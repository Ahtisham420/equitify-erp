"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, FileSignature, FileText, GitCompareArrows, Plus, Search, UserPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, FieldGrid, FieldItem, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Progress } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatRelative } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

import { AGREEMENT_STATUSES, MATCH_STATUSES, PROPOSAL_KINDS, PROPOSAL_STATUSES, RECRUIT_STAGES, REQUIREMENT_STATUSES, label, opts, useMutate, type Agreement, type Match, type Proposal, type Recruit, type Requirement } from "./api";
import { PROPOSAL_FIELDS, RECRUIT_FIELDS, REP_FIELDS, REQUIREMENT_FIELDS } from "./forms";
import { RecordSheet, Section, State, party } from "./ui";

function useTable<T>(path: string) {
  return useListQuery<T>("brokerage", path);
}

function Footer({ list }: { list: { page: number; pageSize: number; data?: { total: number }; url: ReturnType<typeof useUrlState> } }) {
  const { url } = list;
  return <TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />;
}

function MineToggle({ value, onChange, text = "Mine" }: { value: boolean; onChange: (v: boolean) => void; text?: string }) {
  return (
    <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-sm text-ink-2 shadow-card">
      <Checkbox checked={value} onChange={onChange} />
      {text}
    </label>
  );
}

/* ================================================================== representation agreements */

export function RepAgreementsTab() {
  const { can } = useAuth();
  const list = useTable<Agreement>("/rep-agreements");
  const { url } = list;
  const [editing, setEditing] = useState<Agreement | "new" | null>(null);
  const save = useMutate(({ id, body }: { id?: string; body: Record<string, unknown> }) => (id ? api.patch(`/rep-agreements/${id}`, body) : api.post("/rep-agreements", body)));

  const columns: Column<Agreement>[] = [
    { id: "client", header: "Client", cell: (a) => <span className="font-medium text-ink">{party(a) ?? "—"}</span> },
    { id: "kind", header: "Representation", sortKey: "kind", cell: (a) => <span className="text-ink-2">{label(a.kind)}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (a) => <State value={a.status} /> },
    { id: "excl", header: "Exclusivity", cell: (a) => <span className="text-ink-2">{label(a.exclusivity)}</span> },
    { id: "comm", header: "Commission", align: "right", cell: (a) => (a.commission_structure === "flat" ? formatCurrency(a.commission_flat) : a.commission_rate != null ? `${a.commission_rate}%` : "—") },
    {
      id: "term",
      header: "Term",
      sortKey: "expires_on",
      cell: (a) => (
        <span className={cn("whitespace-nowrap text-xs", a.status === "active" && a.days_to_expiry != null && a.days_to_expiry <= 30 ? "font-medium text-caution" : "text-ink-2")}>
          {formatDate(a.starts_on)} – {formatDate(a.expires_on)}
          {a.status === "active" && a.days_to_expiry != null && a.days_to_expiry >= 0 && ` · ${a.days_to_expiry}d left`}
        </span>
      ),
    },
    { id: "territory", header: "Territory", cell: (a) => <span className="text-ink-2">{a.territory ?? "—"}</span> },
    { id: "agent", header: "Agent", cell: (a) => <span className="whitespace-nowrap text-ink-2">{a.agent_name ?? "—"}</span> },
    { id: "doc", header: "Signed copy", cell: (a) => (a.document_id ? <Badge tone="green">On file</Badge> : <Badge tone="outline">Missing</Badge>) },
  ];

  return (
    <>
      <ListCard
        toolbar={
          <Toolbar right={can("brokerage", "create") && <Button variant="primary" onClick={() => setEditing("new")}><Plus /> New agreement</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search territory, notes…" />
            <FacetFilter label="Representation" options={opts(["buyer", "tenant"])} selected={url.getAll("kind")} onChange={(v) => url.set({ kind: v })} />
            <FacetFilter label="Status" options={opts(AGREEMENT_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <MineToggle value={url.get("mine") === "true"} onChange={(c) => url.set({ mine: c || null })} />
          </Toolbar>
        }
        footer={<Footer list={list} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={(a) => can("brokerage", "edit") && setEditing(a)}
          empty={<EmptyState icon={<FileSignature />} title="No representation agreements" description="Track buyer and tenant representation terms, exclusivity and expiration." />}
        />
      </ListCard>
      <RecordSheet
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "New representation agreement" : "Representation agreement"}
        description="Active agreements need a signed date, expiration and commission. Expiration becomes a critical date."
        mode={editing === "new" ? "create" : "edit"}
        fields={REP_FIELDS}
        initial={editing && editing !== "new" ? (editing as unknown as Record<string, unknown>) : { kind: "buyer", status: "draft", exclusivity: "exclusive_right", commission_structure: "percent" }}
        onSubmit={(body) => save.mutateAsync({ id: editing && editing !== "new" ? editing.id : undefined, body })}
      />
    </>
  );
}

/* ================================================================== requirements & matches */

function criteriaSummary(r: Requirement) {
  const parts: string[] = [];
  if (r.property_types.length) parts.push(r.property_types.map((t) => PROPERTY_TYPE_LABELS[t] ?? t).join(", "));
  if (r.min_size_sf != null || r.max_size_sf != null) parts.push(`${formatNumber(r.min_size_sf) ?? "—"}–${formatNumber(r.max_size_sf)} SF`);
  if (r.min_price != null || r.max_price != null) parts.push(`${formatCurrency(r.min_price, { compact: true })}–${formatCurrency(r.max_price, { compact: true })}`);
  const geo = [...r.cities, ...r.counties, ...r.states];
  if (geo.length) parts.push(geo.join(", "));
  if (r.radius_miles) parts.push(`${r.radius_miles} mi radius`);
  return parts.join(" · ") || "Any property";
}

function MatchesSheet({ requirement, onClose }: { requirement: Requirement; onClose: () => void }) {
  const { can } = useAuth();
  const [status, setStatus] = useState<string[]>([]);
  const { data, isLoading } = useQuery({
    queryKey: ["brokerage", "matches", requirement.id, status],
    queryFn: () => api.get<Match[]>(`/requirements/${requirement.id}/matches`, { status }),
  });
  const run = useMutate(() => api.post<{ added: number; total: number }>(`/requirements/${requirement.id}/match`));
  const setMatch = useMutate(({ id, value }: { id: string; value: string }) => api.patch(`/requirement-matches/${id}`, { status: value }));
  const columns: Column<Match>[] = [
    { id: "property", header: "Property", cell: (m) => <Link href={`/properties/${m.property_id}`} className="font-medium text-ink hover:underline">{m.property_label}</Link> },
    { id: "loc", header: "Location", cell: (m) => <span className="text-ink-2">{[m.property_city, m.property_state].filter(Boolean).join(", ") || "—"}</span> },
    { id: "type", header: "Type", cell: (m) => <span className="text-ink-2">{m.property_type ? PROPERTY_TYPE_LABELS[m.property_type] ?? m.property_type : "—"}</span> },
    { id: "sf", header: "SF", align: "right", cell: (m) => formatNumber(m.building_area_sf) },
    { id: "price", header: "Asking", align: "right", cell: (m) => formatCurrency(m.asking_price, { compact: true }) },
    { id: "listed", header: "", cell: (m) => (m.listing_id ? <Link href={`/listings/${m.listing_id}`}><Badge tone="amber">Listed</Badge></Link> : null) },
    {
      id: "status",
      header: "Status",
      cell: (m) =>
        can("brokerage", "edit") ? (
          <select value={m.status} onClick={(e) => e.stopPropagation()} onChange={(e) => setMatch.mutate({ id: m.id, value: e.target.value })} className="h-7 rounded-md border border-line-strong/80 bg-surface px-1.5 text-xs">
            {MATCH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        ) : (
          <State value={m.status} />
        ),
    },
  ];
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={requirement.name} description={criteriaSummary(requirement)} className="max-w-3xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FacetFilter label="Status" options={opts(MATCH_STATUSES)} selected={status} onChange={setStatus} />
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-3">{requirement.last_matched_at ? `Last matched ${formatRelative(requirement.last_matched_at)}` : "Never matched"}</span>
            {can("brokerage", "edit") && (
              <Button
                size="sm"
                variant="primary"
                loading={run.isPending}
                onClick={() => run.mutate(undefined, { onSuccess: (r) => toast.success(`${r.added} new matches (${r.total} properties meet the profile)`), onError: (e) => toast.error(errorMessage(e)) })}
              >
                <Search /> Run match
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-line">
          <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState icon={<GitCompareArrows />} title="No matched properties" description="Run the match against the shared property database." />} />
        </div>
      </div>
    </Sheet>
  );
}

export function RequirementsTab() {
  const { can } = useAuth();
  const list = useTable<Requirement>("/requirements");
  const { url } = list;
  const [editing, setEditing] = useState<Requirement | "new" | null>(null);
  const [matching, setMatching] = useState<Requirement | null>(null);
  const save = useMutate(({ id, body }: { id?: string; body: Record<string, unknown> }) => (id ? api.patch(`/requirements/${id}`, body) : api.post("/requirements", body)));

  const columns: Column<Requirement>[] = [
    { id: "name", header: "Requirement", sortKey: "name", cell: (r) => <div className="min-w-[200px]"><p className="font-medium text-ink">{r.name}</p><p className="text-xs text-ink-3">{party(r) ?? "—"}</p></div> },
    { id: "side", header: "Side", cell: (r) => <span className="text-ink-2">{label(r.side)}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (r) => <State value={r.status} /> },
    { id: "criteria", header: "Criteria", cell: (r) => <span className="line-clamp-2 max-w-[360px] text-xs text-ink-2">{criteriaSummary(r)}</span> },
    { id: "matches", header: "Matches", align: "right", cell: (r) => formatNumber(r.match_count) },
    { id: "agent", header: "Agent", cell: (r) => <span className="whitespace-nowrap text-ink-2">{r.agent_name ?? "—"}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button size="xs" onClick={() => setMatching(r)}>
            <GitCompareArrows className="!size-3.5" /> Matches
          </Button>
          {can("brokerage", "edit") && (
            <Button size="xs" variant="ghost" onClick={() => setEditing(r)}>
              Edit
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
          <Toolbar right={can("brokerage", "create") && <Button variant="primary" onClick={() => setEditing("new")}><Plus /> New requirement</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search requirements…" />
            <FacetFilter label="Status" options={opts(REQUIREMENT_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <FacetFilter label="Side" options={opts(["buyer", "tenant"])} selected={url.getAll("side")} onChange={(v) => url.set({ side: v })} />
            <MineToggle value={url.get("mine") === "true"} onChange={(c) => url.set({ mine: c || null })} />
          </Toolbar>
        }
        footer={<Footer list={list} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          empty={<EmptyState icon={<Search />} title="No requirement profiles" description="Capture what a buyer or tenant needs, then match it against the property database." />}
        />
      </ListCard>
      <RecordSheet
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "New requirement profile" : "Edit requirement profile"}
        mode={editing === "new" ? "create" : "edit"}
        fields={REQUIREMENT_FIELDS}
        initial={editing && editing !== "new" ? (editing as unknown as Record<string, unknown>) : { side: "buyer", status: "active", property_types: [] }}
        onSubmit={(body) => save.mutateAsync({ id: editing && editing !== "new" ? editing.id : undefined, body })}
      />
      {matching && <MatchesSheet requirement={matching} onClose={() => setMatching(null)} />}
    </>
  );
}

/* ================================================================== proposals */

export function ProposalsTab() {
  const { can } = useAuth();
  const list = useTable<Proposal>("/proposals");
  const { url } = list;
  const [editing, setEditing] = useState<Proposal | "new" | null>(null);
  const [revising, setRevising] = useState<Proposal | null>(null);
  const save = useMutate(({ id, body }: { id?: string; body: Record<string, unknown> }) => (id ? api.patch(`/proposals/${id}`, body) : api.post("/proposals", body)));
  const revise = useMutate(({ id, body }: { id: string; body: Record<string, unknown> }) => api.post(`/proposals/${id}/revise`, body));

  const columns: Column<Proposal>[] = [
    { id: "title", header: "Proposal", sortKey: "title", cell: (p) => <div className="min-w-[200px]"><p className={cn("font-medium", p.status === "superseded" ? "text-ink-3 line-through decoration-ink-3/40" : "text-ink")}>{p.title}</p><p className="text-xs text-ink-3">{label(p.kind)} · v{p.version}</p></div> },
    { id: "recipient", header: "Recipient", cell: (p) => <span className="text-ink-2">{party(p) ?? "—"}</span> },
    { id: "property", header: "Property", cell: (p) => <span className="text-ink-2">{p.property_label ?? "—"}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (p) => <State value={p.status} /> },
    { id: "price", header: "Terms", align: "right", cell: (p) => (p.price != null ? formatCurrency(p.price, { compact: true }) : p.rent_psf != null ? `$${formatNumber(p.rent_psf, 2)}/SF` : "—") },
    { id: "sent", header: "Sent", sortKey: "sent_on", cell: (p) => <span className="text-xs text-ink-2">{formatDate(p.sent_on)}</span> },
    { id: "due", header: "Response due", cell: (p) => <span className="text-xs text-ink-2">{formatDate(p.response_due_on)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (p) =>
        can("brokerage", "edit") && p.status !== "superseded" ? (
          <div className="flex justify-end gap-1">
            <Button size="xs" onClick={() => setRevising(p)}>
              <ArrowRight className="!size-3.5" /> Revise
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(p)}>
              Edit
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <ListCard
        toolbar={
          <Toolbar right={can("brokerage", "create") && <Button variant="primary" onClick={() => setEditing("new")}><Plus /> New proposal</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search proposals…" />
            <FacetFilter label="Kind" options={opts(PROPOSAL_KINDS)} selected={url.getAll("kind")} onChange={(v) => url.set({ kind: v })} />
            <FacetFilter label="Status" options={opts(PROPOSAL_STATUSES)} selected={url.getAll("status")} onChange={(v) => url.set({ status: v })} />
            <MineToggle value={url.get("mine") === "true"} onChange={(c) => url.set({ mine: c || null })} />
          </Toolbar>
        }
        footer={<Footer list={list} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          rowClassName={(p) => (p.status === "superseded" ? "bg-subtle/40" : undefined)}
          empty={<EmptyState icon={<FileText />} title="No proposals" description="Listing, purchase and lease proposals are kept with every revision." />}
        />
      </ListCard>
      <RecordSheet
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === "new" ? "New proposal" : "Edit proposal"}
        mode={editing === "new" ? "create" : "edit"}
        fields={PROPOSAL_FIELDS}
        initial={editing && editing !== "new" ? (editing as unknown as Record<string, unknown>) : { kind: "listing_proposal", status: "draft" }}
        onSubmit={(body) => save.mutateAsync({ id: editing && editing !== "new" ? editing.id : undefined, body })}
      />
      <RecordSheet
        open={!!revising}
        onOpenChange={(o) => !o && setRevising(null)}
        title={`Revise "${revising?.title ?? ""}"`}
        description="Creates the next version as a draft; the current version is kept as superseded history."
        mode="edit"
        submitLabel="Create revision"
        fields={PROPOSAL_FIELDS.filter((f) => !["kind", "status", "sent_on"].includes(f.key))}
        initial={revising ? (revising as unknown as Record<string, unknown>) : {}}
        onSubmit={(body) => (revising ? revise.mutateAsync({ id: revising.id, body }) : Promise.resolve())}
      />
    </>
  );
}

/* ================================================================== recruiting */

function RecruitSheet({ recruit, onClose }: { recruit: Recruit; onClose: () => void }) {
  const { can } = useAuth();
  const { data: r = recruit } = useQuery({ queryKey: ["brokerage", "recruit", recruit.id], queryFn: () => api.get<Recruit>(`/recruits/${recruit.id}`) });
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState(r.stage);
  const [reason, setReason] = useState("");
  const update = useMutate((body: Record<string, unknown>) => api.patch(`/recruits/${r.id}`, body));
  const move = useMutate((body: Record<string, unknown>) => api.post(`/recruits/${r.id}/move`, body));
  const toggle = useMutate(({ key, done }: { key: string; done: boolean }) => api.post(`/recruits/${r.id}/checklist/${key}`, { done }));
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={r.full_name} description={[r.current_brokerage, r.specialty].filter(Boolean).join(" · ") || undefined}>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <State value={r.stage} />
          {can("brokerage", "edit") && (
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
              <Button size="sm" variant="primary" onClick={() => { setTo(r.stage); setMoving(true); }}>
                <ArrowRight /> Move
              </Button>
            </div>
          )}
        </div>
        <FieldGrid cols={2}>
          <FieldItem label="Email">{r.email}</FieldItem>
          <FieldItem label="Phone">{r.phone}</FieldItem>
          <FieldItem label="Experience">{r.years_experience != null ? `${r.years_experience} yrs` : null}</FieldItem>
          <FieldItem label="Annual production">{r.annual_production != null ? formatCurrency(r.annual_production) : null}</FieldItem>
          <FieldItem label="License">{[r.license_state, r.license_number].filter(Boolean).join(" ") || null}</FieldItem>
          <FieldItem label="Recruiter">{r.recruiter_name}</FieldItem>
          <FieldItem label="Start date">{r.start_on ? formatDate(r.start_on) : null}</FieldItem>
          <FieldItem label="Source">{r.source}</FieldItem>
        </FieldGrid>
        <Section title="Onboarding checklist" actions={r.onboarding.length ? <span className="text-xs text-ink-3 tabular">{formatNumber(r.onboarding_pct, 0)}%</span> : undefined}>
          {!r.onboarding.length ? (
            <p className="text-sm text-ink-3">The checklist starts when the recruit is hired.</p>
          ) : (
            <div className="space-y-2">
              <Progress value={r.onboarding_pct} />
              <ul className="divide-y divide-line rounded-lg border border-line">
                {r.onboarding.map((i) => (
                  <li key={i.key} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox checked={i.done} onChange={(done) => can("brokerage", "edit") && toggle.mutate({ key: i.key, done }, { onError: (e) => toast.error(errorMessage(e)) })} />
                    <span className={cn("flex-1 text-sm", i.done ? "text-ink-3 line-through decoration-ink-3/40" : "text-ink")}>{i.label}</span>
                    {i.done && <span className="text-2xs text-ink-3">{i.done_by} · {formatDate(i.done_at)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
        {r.notes && <p className="whitespace-pre-wrap text-sm text-ink-2">{r.notes}</p>}
      </div>
      <RecordSheet open={editing} onOpenChange={setEditing} title="Edit recruit" mode="edit" fields={RECRUIT_FIELDS} initial={r as unknown as Record<string, unknown>} onSubmit={(b) => update.mutateAsync(b)} />
      <Dialog
        open={moving}
        onOpenChange={setMoving}
        title="Move recruit"
        description="Activating an agent requires a completed onboarding checklist."
        footer={
          <>
            <Button onClick={() => setMoving(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={move.isPending}
              disabled={to === r.stage}
              onClick={() => move.mutate({ to_stage: to, reason: reason || null }, { onSuccess: () => { toast.success(`Moved to ${label(to)}`); setMoving(false); }, onError: (e) => toast.error(errorMessage(e)) })}
            >
              Move
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Stage">
            <Select value={to} onChange={(e) => setTo(e.target.value)} options={opts(RECRUIT_STAGES)} />
          </Field>
          <Field label="Note / override reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </Sheet>
  );
}

export function RecruitingTab() {
  const { can } = useAuth();
  const list = useTable<Recruit>("/recruits");
  const { url } = list;
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Recruit | null>(null);
  const create = useMutate((body: Record<string, unknown>) => api.post("/recruits", body));
  const columns: Column<Recruit>[] = [
    { id: "name", header: "Name", sortKey: "full_name", cell: (r) => <div><p className="font-medium text-ink">{r.full_name}</p><p className="text-xs text-ink-3">{r.current_brokerage ?? "—"}</p></div> },
    { id: "stage", header: "Stage", sortKey: "stage", cell: (r) => <State value={r.stage} /> },
    { id: "spec", header: "Specialty", cell: (r) => <span className="text-ink-2">{r.specialty ?? "—"}</span> },
    { id: "prod", header: "Production", sortKey: "annual_production", align: "right", cell: (r) => formatCurrency(r.annual_production, { compact: true }) },
    { id: "onb", header: "Onboarding", cell: (r) => (r.onboarding.length ? <div className="flex items-center gap-2"><Progress value={r.onboarding_pct} className="w-16" /><span className="text-xs text-ink-3 tabular">{formatNumber(r.onboarding_pct, 0)}%</span></div> : <span className="text-ink-3">—</span>) },
    { id: "next", header: "Next action", sortKey: "next_action_at", cell: (r) => <span className="text-xs text-ink-2">{formatDate(r.next_action_at)}</span> },
    { id: "recruiter", header: "Recruiter", cell: (r) => <span className="whitespace-nowrap text-ink-2">{r.recruiter_name ?? "—"}</span> },
    { id: "check", header: "", cell: (r) => (r.stage === "active" ? <Check className="size-4 text-positive" /> : null) },
  ];
  return (
    <>
      <ListCard
        toolbar={
          <Toolbar right={can("brokerage", "create") && <Button variant="primary" onClick={() => setCreating(true)}><UserPlus /> New recruit</Button>}>
            <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search recruits…" />
            <FacetFilter label="Stage" options={opts(RECRUIT_STAGES)} selected={url.getAll("stage")} onChange={(v) => url.set({ stage: v })} />
          </Toolbar>
        }
        footer={<Footer list={list} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          onRowClick={setOpen}
          empty={<EmptyState icon={<UserPlus />} title="No recruits" description="Track agent candidates from first contact through onboarding." />}
        />
      </ListCard>
      <RecordSheet open={creating} onOpenChange={setCreating} title="New recruit" fields={RECRUIT_FIELDS} onSubmit={(b) => create.mutateAsync(b)} />
      {open && <RecruitSheet recruit={open} onClose={() => setOpen(null)} />}
    </>
  );
}
