"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Columns3, LineChart, List, Plus, Store, Target } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, SearchInput, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, FieldGrid, FieldItem, ListCard } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatRelative, isOverdue } from "@/lib/utils";

import { LISTING_TYPES, LOST_REASONS, MARKET_STATUSES, PROSPECT_STAGES, label, opts, useMutate, useUserNames, type Agreement, type Pitch, type Prospect } from "./api";
import { ENGAGEMENT_FIELDS, PROSPECT_FIELDS } from "./forms";
import { RecordSheet, Section, State, party } from "./ui";

const columns: Column<Prospect>[] = [
  {
    id: "title",
    header: "Prospect",
    sortKey: "title",
    cell: (p) => (
      <div className="min-w-[200px] max-w-[320px]">
        <p className="truncate font-medium text-ink">{p.title}</p>
        <p className="truncate text-xs text-ink-3">{party(p) ?? p.property_label ?? "—"}</p>
      </div>
    ),
  },
  { id: "stage", header: "Stage", sortKey: "stage", cell: (p) => <State value={p.stage} /> },
  { id: "market", header: "Market status", cell: (p) => <span className="text-ink-2">{label(p.market_status)}</span> },
  {
    id: "expiry",
    header: "Competitor expiry",
    sortKey: "competitor_expires_on",
    cell: (p) =>
      p.competitor_expires_on ? (
        <span className={cn("whitespace-nowrap text-xs", p.days_to_competitor_expiry != null && p.days_to_competitor_expiry <= 30 ? "font-medium text-caution" : "text-ink-2")}>
          {formatDate(p.competitor_expires_on)}
          {p.days_to_competitor_expiry != null && ` · ${p.days_to_competitor_expiry}d`}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "value", header: "Est. value", sortKey: "estimated_value", align: "right", cell: (p) => formatCurrency(p.estimated_value, { compact: true }) },
  { id: "pitches", header: "Pitches", align: "right", cell: (p) => <span title={p.last_pitched_on ? `Last ${formatDate(p.last_pitched_on)}` : undefined}>{p.pitch_count}</span> },
  {
    id: "next",
    header: "Next action",
    sortKey: "next_action_at",
    cell: (p) =>
      p.next_action_at ? (
        <span className={cn("text-xs", isOverdue(p.next_action_at) ? "font-medium text-negative" : "text-ink-2")}>
          {p.next_action ? `${p.next_action} · ` : ""}
          {formatDate(p.next_action_at)}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  { id: "agent", header: "Agent", cell: (p) => <span className="whitespace-nowrap text-ink-2">{p.agent_name ?? "—"}</span> },
  { id: "updated", header: "Updated", sortKey: "updated_at", cell: (p) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(p.updated_at)}</span> },
];

function Board({ onOpen, params }: { onOpen: (id: string) => void; params: Record<string, unknown> }) {
  const { stage: _s, page: _p, page_size: _ps, tab: _t, view: _v, prospect: _pr, ...rest } = params;
  const q = { ...(rest as Record<string, string>), page_size: 200, sort: "next_action_at" };
  const { data, isLoading } = useQuery({ queryKey: ["brokerage", "prospect-board", q], queryFn: () => api.get<Page<Prospect>>("/listing-prospects", q) });
  const by = (s: string) => (data?.items ?? []).filter((p) => p.stage === s);
  return (
    <div className="grid gap-3 lg:grid-cols-4">
      {PROSPECT_STAGES.map((s) => (
        <div key={s} className="flex min-h-[200px] flex-col rounded-lg border border-line bg-subtle/60">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <State value={s} />
            <span className="text-xs text-ink-3 tabular">{by(s).length}</span>
          </div>
          <div className="flex-1 space-y-2 p-2">
            {isLoading && <p className="px-1 text-xs text-ink-3">Loading…</p>}
            {by(s).map((p) => (
              <button key={p.id} onClick={() => onOpen(p.id)} className="block w-full rounded-md border border-line bg-surface p-2.5 text-left shadow-card hover:border-line-strong">
                <p className="truncate text-sm font-medium text-ink">{p.title}</p>
                <p className="truncate text-xs text-ink-3">{party(p) ?? p.property_label ?? "—"}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
                  {p.market_status !== "not_listed" && <Badge tone={p.market_status === "expiring" ? "amber" : "outline"}>{label(p.market_status)}</Badge>}
                  {p.estimated_value != null && <span className="tabular">{formatCurrency(p.estimated_value, { compact: true })}</span>}
                  {p.next_action_at && <span className={cn(isOverdue(p.next_action_at) && "font-medium text-negative")}>Next {formatDate(p.next_action_at)}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ prospect sheet */

function PitchDialog({ prospect, open, onOpenChange }: { prospect: Prospect; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [kind, setKind] = useState<"pitch" | "bov">("pitch");
  const [values, setValues] = useState<Record<string, string>>({});
  const add = useMutate((body: Record<string, unknown>) => api.post(`/listing-prospects/${prospect.id}/pitches`, body));
  const num = (k: string) => (values[k] ? Number(values[k].replace(/,/g, "")) : null);
  const submit = () =>
    add.mutate(
      {
        kind,
        pitched_on: values.pitched_on || null,
        bov_id: values.bov_id || null,
        recommended_price: num("recommended_price"),
        proposed_commission_rate: num("proposed_commission_rate"),
        value_low: kind === "pitch" ? num("value_low") : null,
        value_point: kind === "pitch" ? num("value_point") : null,
        value_high: kind === "pitch" ? num("value_high") : null,
        notes: values.notes || null,
      },
      {
        onSuccess: () => {
          toast.success(kind === "bov" ? "BOV recorded from comps valuation" : "Pitch recorded");
          onOpenChange(false);
          setValues({});
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  const set = (k: string) => (e: { target: { value: string } }) => setValues((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Record pitch"
      description="A BOV uses the property's comps valuation built from verified comparables."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as "pitch" | "bov")} options={[{ value: "pitch", label: "Listing pitch" }, { value: "bov", label: "Broker opinion of value (BOV)" }]} />
        </Field>
        <Field label="Pitched on">
          <Input type="date" value={values.pitched_on ?? ""} onChange={set("pitched_on")} />
        </Field>
        {kind === "bov" ? (
          <Field label="Comps valuation id" hint={<>Leave blank to use the latest valuation for the property. <Link href="/comps" className="text-accent hover:underline">Open comps</Link></>} className="col-span-2">
            <Input value={values.bov_id ?? ""} onChange={set("bov_id")} placeholder="Latest valuation" />
          </Field>
        ) : (
          <>
            <Field label="Value low">
              <Input inputMode="decimal" value={values.value_low ?? ""} onChange={set("value_low")} />
            </Field>
            <Field label="Value high">
              <Input inputMode="decimal" value={values.value_high ?? ""} onChange={set("value_high")} />
            </Field>
            <Field label="Point value">
              <Input inputMode="decimal" value={values.value_point ?? ""} onChange={set("value_point")} />
            </Field>
          </>
        )}
        <Field label="Recommended list price">
          <Input inputMode="decimal" value={values.recommended_price ?? ""} onChange={set("recommended_price")} />
        </Field>
        <Field label="Proposed commission %">
          <Input inputMode="decimal" value={values.proposed_commission_rate ?? ""} onChange={set("proposed_commission_rate")} />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea value={values.notes ?? ""} onChange={set("notes")} />
        </Field>
      </div>
    </Dialog>
  );
}

function MoveDialog({ prospect, open, onOpenChange }: { prospect: Prospect; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const [to, setTo] = useState(prospect.stage);
  const [lostReason, setLostReason] = useState("");
  const [reason, setReason] = useState("");
  const [unmet, setUnmet] = useState<string[]>([]);
  const move = useMutate((body: Record<string, unknown>) => api.post(`/listing-prospects/${prospect.id}/move`, body));
  const submit = () =>
    move.mutate(
      { to_stage: to, lost_reason: lostReason || null, reason: reason || null },
      {
        onSuccess: () => {
          toast.success(`Moved to ${label(to)}`);
          onOpenChange(false);
        },
        onError: (e) => {
          const d = (e as { detail?: { unmet?: string[] } }).detail;
          if (d?.unmet) setUnmet(d.unmet);
          toast.error(errorMessage(e));
        },
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Move prospect"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={to === prospect.stage} loading={move.isPending} onClick={submit}>
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Stage">
          <Select value={to} onChange={(e) => setTo(e.target.value)} options={opts(PROSPECT_STAGES)} />
        </Field>
        {to === "lost" && (
          <Field label="Lost reason" required>
            <Select value={lostReason} onChange={(e) => setLostReason(e.target.value)} options={opts(LOST_REASONS)} placeholder="Choose…" />
          </Field>
        )}
        {unmet.length > 0 && (
          <div className="rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-xs text-ink-2">
            <p className="font-medium text-negative">Requirements not met</p>
            <ul className="mt-1 list-disc pl-4">
              {unmet.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            {!can("brokerage", "approve") && <p className="mt-1">An approver can override with a reason.</p>}
          </div>
        )}
        <Field label={unmet.length ? "Override reason" : "Note"} hint={unmet.length ? "Overrides need brokerage approval permission and are audited." : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function ConvertDialog({ prospect, open, onOpenChange }: { prospect: Prospect; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [type, setType] = useState("sale");
  const [price, setPrice] = useState("");
  const [listedOn, setListedOn] = useState("");
  const convert = useMutate((body: Record<string, unknown>) => api.post<{ id: string }>(`/listing-prospects/${prospect.id}/convert`, body));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Convert to listing"
      description="Requires an active engagement agreement. The listing inherits the owner, agent and agreement."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={convert.isPending}
            onClick={() =>
              convert.mutate(
                { listing_type: type, [type === "lease" ? "asking_rent_psf" : "asking_price"]: price ? Number(price.replace(/,/g, "")) : null, listed_on: listedOn || null },
                { onSuccess: (l) => router.push(`/listings/${l.id}`), onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Create listing
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Listing type">
          <Select value={type} onChange={(e) => setType(e.target.value)} options={opts(LISTING_TYPES)} />
        </Field>
        <Field label={type === "lease" ? "Asking rent ($/SF/yr)" : "Asking price"}>
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Listed on" hint="Leave blank for a draft listing">
          <Input type="date" value={listedOn} onChange={(e) => setListedOn(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function ProspectSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const { data: p } = useQuery({ queryKey: ["brokerage", "prospect", id], queryFn: () => api.get<Prospect>(`/listing-prospects/${id}`) });
  const { data: pitches } = useQuery({ queryKey: ["brokerage", "pitches", id], queryFn: () => api.get<Pitch[]>(`/listing-prospects/${id}/pitches`) });
  const { data: agreements } = useQuery({ queryKey: ["brokerage", "engagements", id], queryFn: () => api.get<Page<Agreement>>("/engagement-agreements", { prospect_id: id, page_size: 50 }) });
  const [dialog, setDialog] = useState<"edit" | "pitch" | "move" | "convert" | "agreement" | null>(null);
  const [agreement, setAgreement] = useState<Agreement | null>(null);
  const update = useMutate((body: Record<string, unknown>) => api.patch(`/listing-prospects/${id}`, body));
  const saveAgreement = useMutate(({ aid, body }: { aid?: string; body: Record<string, unknown> }) =>
    aid ? api.patch(`/engagement-agreements/${aid}`, body) : api.post("/engagement-agreements", { ...body, prospect_id: id }),
  );
  const outcome = useMutate(({ pid, value }: { pid: string; value: string }) => api.patch(`/prospect-pitches/${pid}`, { outcome: value }));

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={p?.title ?? "Prospect"} description={p ? party(p) ?? p.property_label ?? undefined : undefined} className="max-w-2xl">
      {!p ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <State value={p.stage} />
            <Badge tone="outline">{label(p.market_status)}</Badge>
            {p.lost_reason && <span className="text-xs text-ink-3">Lost: {label(p.lost_reason)}</span>}
            <div className="ml-auto flex flex-wrap gap-1.5">
              {can("brokerage", "edit") && (
                <>
                  <Button size="sm" onClick={() => setDialog("edit")}>Edit</Button>
                  <Button size="sm" onClick={() => setDialog("move")}>
                    <ArrowRight /> Move
                  </Button>
                  <Button size="sm" onClick={() => setDialog("pitch")}>
                    <LineChart /> Pitch / BOV
                  </Button>
                </>
              )}
              {p.listing_id ? (
                <Link href={`/listings/${p.listing_id}`}>
                  <Button size="sm" variant="primary">
                    <Store /> Listing
                  </Button>
                </Link>
              ) : (
                can("brokerage", "create") && p.property_id && (
                  <Button size="sm" variant="primary" onClick={() => setDialog("convert")}>
                    <Store /> Convert to listing
                  </Button>
                )
              )}
            </div>
          </div>

          <FieldGrid cols={2}>
            <FieldItem label="Property">{p.property_id ? <Link href={`/properties/${p.property_id}`} className="text-accent hover:underline">{p.property_label ?? "Open"}</Link> : null}</FieldItem>
            <FieldItem label="Owner">{party(p)}</FieldItem>
            <FieldItem label="Agent">{p.agent_name}</FieldItem>
            <FieldItem label="Estimated value">{p.estimated_value != null ? formatCurrency(p.estimated_value) : null}</FieldItem>
            <FieldItem label="Competing broker">{p.competitor_broker}</FieldItem>
            <FieldItem label="Competitor price">{p.competitor_list_price != null ? formatCurrency(p.competitor_list_price) : null}</FieldItem>
            <FieldItem label="Competitor expires">{p.competitor_expires_on ? `${formatDate(p.competitor_expires_on)}${p.days_to_competitor_expiry != null ? ` (${p.days_to_competitor_expiry}d)` : ""}` : null}</FieldItem>
            <FieldItem label="Next action">{p.next_action_at ? `${p.next_action ?? "Follow up"} · ${formatDate(p.next_action_at)}` : null}</FieldItem>
          </FieldGrid>
          {p.notes && <p className="whitespace-pre-wrap text-sm text-ink-2">{p.notes}</p>}

          <Section title="Pitch history">
            {!pitches?.length ? (
              <p className="text-sm text-ink-3">No pitches yet.</p>
            ) : (
              <div className="divide-y divide-line rounded-lg border border-line">
                {pitches.map((x) => (
                  <div key={x.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        {x.kind === "bov" ? "BOV" : "Pitch"} · {formatDate(x.pitched_on)}
                      </p>
                      <p className="text-xs text-ink-3">
                        {x.value_point != null ? `Value ${formatCurrency(x.value_low, { compact: true })} – ${formatCurrency(x.value_high, { compact: true })} (point ${formatCurrency(x.value_point, { compact: true })})` : "No valuation"}
                        {x.recommended_price != null && ` · list at ${formatCurrency(x.recommended_price, { compact: true })}`}
                        {x.proposed_commission_rate != null && ` · ${x.proposed_commission_rate}% fee`}
                      </p>
                      {x.kind === "bov" && <p className="text-2xs text-ink-3">From comps valuation {x.valuation_method ? `(${label(x.valuation_method)})` : ""} {x.valuation_as_of ? `as of ${formatDate(x.valuation_as_of)}` : ""}</p>}
                      {x.notes && <p className="mt-0.5 text-xs text-ink-2">{x.notes}</p>}
                    </div>
                    {can("brokerage", "edit") ? (
                      <select value={x.outcome} onChange={(e) => outcome.mutate({ pid: x.id, value: e.target.value })} className="h-7 rounded-md border border-line-strong/80 bg-surface px-1.5 text-xs">
                        {["pending", "won", "lost", "no_decision"].map((o) => (
                          <option key={o} value={o}>
                            {label(o)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <State value={x.outcome} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Engagement agreements"
            actions={can("brokerage", "create") && (
              <Button size="xs" onClick={() => { setAgreement(null); setDialog("agreement"); }}>
                <Plus className="!size-3.5" /> Add
              </Button>
            )}
          >
            {!agreements?.items.length ? (
              <p className="text-sm text-ink-3">No engagement agreement yet. An active one is required to become engaged.</p>
            ) : (
              <div className="divide-y divide-line rounded-lg border border-line">
                {agreements.items.map((a) => (
                  <button key={a.id} onClick={() => { setAgreement(a); setDialog("agreement"); }} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-subtle">
                    <div>
                      <p className="text-sm text-ink">{label(a.exclusivity)}</p>
                      <p className="text-xs text-ink-3">
                        {a.commission_structure === "flat" ? formatCurrency(a.commission_flat) : a.commission_rate != null ? `${a.commission_rate}%` : "Commission not set"} · {formatDate(a.starts_on)} – {formatDate(a.expires_on)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {a.days_to_expiry != null && a.days_to_expiry <= 30 && a.status === "active" && <Badge tone="amber">Expires in {a.days_to_expiry}d</Badge>}
                      <State value={a.status} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <RecordSheet open={dialog === "edit"} onOpenChange={(o) => !o && setDialog(null)} title="Edit prospect" mode="edit" fields={PROSPECT_FIELDS} initial={p as unknown as Record<string, unknown>} onSubmit={(b) => update.mutateAsync(b)} />
          <RecordSheet
            open={dialog === "agreement"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={agreement ? "Engagement agreement" : "New engagement agreement"}
            description="Active agreements need a signed date, expiration and commission. Expiration becomes a critical date."
            mode={agreement ? "edit" : "create"}
            fields={ENGAGEMENT_FIELDS}
            initial={agreement ? (agreement as unknown as Record<string, unknown>) : { status: "draft", exclusivity: "exclusive_right", commission_structure: "percent", client_person_id: p.owner_person_id, client_organization_id: p.owner_organization_id }}
            onSubmit={(body) => saveAgreement.mutateAsync({ aid: agreement?.id, body })}
          />
          {dialog === "pitch" && <PitchDialog prospect={p} open onOpenChange={(o) => !o && setDialog(null)} />}
          {dialog === "move" && <MoveDialog prospect={p} open onOpenChange={(o) => !o && setDialog(null)} />}
          {dialog === "convert" && <ConvertDialog prospect={p} open onOpenChange={(o) => !o && setDialog(null)} />}
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ tab */

export function ProspectsTab() {
  const { can } = useAuth();
  const list = useListQuery<Prospect>("brokerage", "/listing-prospects");
  const { url } = list;
  const users = useUserNames();
  const [creating, setCreating] = useState(false);
  const create = useMutate((body: Record<string, unknown>) => api.post<Prospect>("/listing-prospects", body));
  const view = url.get("view") ?? "board";
  const openId = url.get("prospect");

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, view: _v, prospect: _pr, ...rest } = url.params;
    return rest;
  }, [url.params]);
  const { data: facets } = useQuery({
    queryKey: ["brokerage", "prospect-facets", filterParams],
    queryFn: () => api.get<{ stage: Record<string, number>; market_status: Record<string, number>; agent_id: Record<string, number> }>("/listing-prospects/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const chips: FilterChip[] = [];
  for (const [key, l] of [["stage", "Stage"], ["market_status", "Market"], ["agent_id", "Agent"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label: l, value: values.map((v) => (key === "agent_id" ? users[v] ?? "Agent" : label(v))).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (url.get("expiring_within_days")) chips.push({ key: "exp", label: "Competitor expiring within", value: `${url.get("expiring_within_days")} days`, onRemove: () => url.set({ expiring_within_days: null }) });

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <div className="flex rounded-md border border-line-strong/80 shadow-card">
                    <Button size="icon" variant={view === "board" ? "primary" : "ghost"} onClick={() => url.set({ view: "board" })} aria-label="Board">
                      <Columns3 />
                    </Button>
                    <Button size="icon" variant={view === "table" ? "primary" : "ghost"} onClick={() => url.set({ view: "table" })} aria-label="Table">
                      <List />
                    </Button>
                  </div>
                  <SavedViewsMenu module="brokerage" />
                  {can("brokerage", "create") && (
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Plus /> New prospect
                    </Button>
                  )}
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search prospects, brokers…" />
              {view === "table" && <FacetFilter label="Stage" options={PROSPECT_STAGES.map((s) => ({ value: s, label: label(s), count: facets?.stage[s] ?? 0 }))} selected={url.getAll("stage")} onChange={(v) => url.set({ stage: v })} />}
              <FacetFilter label="Market status" options={MARKET_STATUSES.map((s) => ({ value: s, label: label(s), count: facets?.market_status[s] ?? 0 }))} selected={url.getAll("market_status")} onChange={(v) => url.set({ market_status: v })} />
              <FacetFilter label="Agent" searchable options={Object.entries(facets?.agent_id ?? {}).map(([id, c]) => ({ value: id, label: users[id] ?? "Unknown", count: c }))} selected={url.getAll("agent_id")} onChange={(v) => url.set({ agent_id: v })} />
              <FacetFilter
                label="Competitor expiring"
                single
                options={[30, 60, 90].map((d) => ({ value: String(d), label: `Within ${d} days` }))}
                selected={url.get("expiring_within_days") ? [url.get("expiring_within_days")!] : []}
                onChange={(v) => url.set({ expiring_within_days: v[0] ?? null })}
              />
              <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-2.5 text-sm text-ink-2 shadow-card">
                <Checkbox checked={url.get("mine") === "true"} onChange={(c) => url.set({ mine: c || null })} />
                Mine
              </label>
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab"), view: url.get("view"), q: url.get("q") })} />
          </div>
        }
        footer={view === "table" ? <TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} /> : undefined}
      >
        {view === "board" ? (
          <div className="p-3">
            <Board params={url.params} onOpen={(pid) => url.set({ prospect: pid }, { resetPage: false })} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={list.data?.items}
            loading={list.isLoading}
            fetching={list.isFetching}
            sort={url.get("sort")}
            onSortChange={(sort) => url.set({ sort })}
            onRowClick={(p) => url.set({ prospect: p.id }, { resetPage: false })}
            empty={<EmptyState icon={<Target />} title="No listing prospects" description="Track owners you are pitching, including competitor listings that are about to expire." />}
          />
        )}
      </ListCard>
      {!list.isLoading && view === "board" && (list.data?.total ?? 0) === 0 && !chips.length && (
        <Card className="mt-3">
          <EmptyState icon={<Target />} title="No listing prospects yet" description="Prospect an owner already known to acquisitions, prepare a BOV from the shared comp database and convert to a listing." />
        </Card>
      )}
      <RecordSheet
        open={creating}
        onOpenChange={setCreating}
        title="New listing prospect"
        description="Link the owner relationship (person or organization) and the property."
        fields={PROSPECT_FIELDS}
        initial={{ market_status: "not_listed" }}
        onSubmit={async (b) => {
          const p = await create.mutateAsync(b);
          url.set({ prospect: p.id }, { resetPage: false });
        }}
      />
      {openId && <ProspectSheet id={openId} onClose={() => url.set({ prospect: null }, { resetPage: false })} />}
    </>
  );
}
