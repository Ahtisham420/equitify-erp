"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, GitMerge, ScanSearch, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import { kindPath, useDuplicateMutations, useDuplicates, useMerges, type DuplicateItem, type EntityKind, type MergeItem } from "./api";

const COMPARE_FIELDS: Record<EntityKind, { key: string; label: string; mergeable: boolean }[]> = {
  person: [
    { key: "full_name", label: "Name", mergeable: true },
    { key: "title", label: "Title", mergeable: true },
    { key: "primary_email", label: "Primary email", mergeable: false },
    { key: "primary_phone", label: "Primary phone", mergeable: false },
    { key: "mailing_address", label: "Mailing address", mergeable: true },
    { key: "city", label: "City", mergeable: true },
    { key: "state", label: "State", mergeable: true },
    { key: "postal_code", label: "Postal code", mergeable: true },
    { key: "relationship_strength", label: "Relationship strength", mergeable: true },
    { key: "responsiveness", label: "Responsiveness", mergeable: true },
    { key: "next_action", label: "Next action", mergeable: true },
    { key: "tags", label: "Tags", mergeable: true },
    { key: "notes", label: "Notes", mergeable: true },
  ],
  organization: [
    { key: "name", label: "Name", mergeable: true },
    { key: "legal_name", label: "Legal name", mergeable: true },
    { key: "org_type", label: "Type", mergeable: true },
    { key: "website", label: "Website", mergeable: true },
    { key: "domain", label: "Domain", mergeable: true },
    { key: "phone", label: "Phone", mergeable: true },
    { key: "mailing_address", label: "Mailing address", mergeable: true },
    { key: "city", label: "City", mergeable: true },
    { key: "state", label: "State", mergeable: true },
    { key: "state_of_formation", label: "State of formation", mergeable: true },
    { key: "registered_agent", label: "Registered agent", mergeable: true },
    { key: "relationship_strength", label: "Relationship strength", mergeable: true },
    { key: "tags", label: "Tags", mergeable: true },
    { key: "notes", label: "Notes", mergeable: true },
  ],
};

type Rec = Record<string, unknown> & { id: string; contact_points?: unknown[]; affiliations?: unknown[]; members?: unknown[] };

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

function useRecord(kind: EntityKind, id: string | null) {
  return useQuery({ queryKey: [kindPath(kind), id], queryFn: () => api.get<Rec>(`/${kindPath(kind)}/${id}`), enabled: !!id });
}

/** Side-by-side compare; the chosen survivor keeps its values unless a field is taken from the other record. */
export function CompareDialog({
  kind,
  pair,
  onOpenChange,
}: {
  kind: EntityKind;
  pair: { a: string; b: string; reviewId?: string } | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [survivor, setSurvivor] = useState<"a" | "b">("a");
  const [take, setTake] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const m = useDuplicateMutations(kind);
  const a = useRecord(kind, pair?.a ?? null);
  const b = useRecord(kind, pair?.b ?? null);

  useEffect(() => {
    setSurvivor("a");
    setTake([]);
    setReason("");
  }, [pair]);

  const keep = survivor === "a" ? a.data : b.data;
  const other = survivor === "a" ? b.data : a.data;
  const label = (r?: Rec) => String((kind === "person" ? r?.full_name : r?.name) ?? "—");

  const doMerge = () => {
    if (!keep || !other) return;
    m.merge.mutate(
      { survivor_id: keep.id, merged_id: other.id, take_from_merged: take, review_id: pair?.reviewId, reason: reason.trim() || undefined },
      {
        onSuccess: (r) => {
          toast.success(`Merged ${r.merged_label ?? "record"} into ${r.survivor_label ?? "survivor"}. You can reverse this from merge history.`);
          setConfirming(false);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const fields = COMPARE_FIELDS[kind];
  const loading = a.isLoading || b.isLoading;

  return (
    <Dialog
      open={!!pair}
      onOpenChange={onOpenChange}
      title="Compare records"
      description="Choose which record survives. Linked phones, emails, roles, ownership, deals and interactions move to the survivor. The merge is recorded and can be reversed."
      className="max-w-3xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!keep || !other} onClick={() => setConfirming(true)}>
            <GitMerge /> Merge into {label(keep)}
          </Button>
        </>
      }
    >
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : !a.data || !b.data ? (
        <EmptyState title="One of these records is no longer available" description="It may have been merged or archived already." />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-[150px_1fr_1fr] items-center gap-2 text-sm">
            <span />
            {(["a", "b"] as const).map((side) => {
              const r = side === "a" ? a.data! : b.data!;
              const active = survivor === side;
              return (
                <button
                  key={side}
                  type="button"
                  onClick={() => {
                    setSurvivor(side);
                    setTake([]);
                  }}
                  className={cn("rounded-md border px-3 py-2 text-left", active ? "border-ink bg-subtle" : "border-line hover:bg-subtle/60")}
                >
                  <span className="block truncate font-medium text-ink">{label(r)}</span>
                  <span className="text-xs text-ink-3">{active ? "Survivor" : "Will be merged"}</span>
                </button>
              );
            })}
          </div>
          <div className="divide-y divide-line rounded-md border border-line">
            {fields.map((f) => {
              const va = a.data![f.key];
              const vb = b.data![f.key];
              const differ = show(va) !== show(vb);
              const otherSide = survivor === "a" ? "b" : "a";
              const taking = take.includes(f.key);
              return (
                <div key={f.key} className="grid grid-cols-[150px_1fr_1fr] items-start gap-2 px-3 py-2 text-sm">
                  <span className="text-xs text-ink-3">{f.label}</span>
                  {(["a", "b"] as const).map((side) => {
                    const v = side === "a" ? va : vb;
                    const chosen = differ && ((side === survivor && !taking) || (side === otherSide && taking));
                    const selectable = differ && f.mergeable && show(v) !== "—";
                    return (
                      <button
                        key={side}
                        type="button"
                        disabled={!selectable}
                        onClick={() => setTake((t) => (side === otherSide ? Array.from(new Set([...t, f.key])) : t.filter((k) => k !== f.key)))}
                        className={cn(
                          "min-w-0 rounded px-2 py-1 text-left",
                          differ ? "text-ink" : "text-ink-3",
                          chosen && "bg-accent-soft ring-1 ring-inset ring-accent/30",
                          selectable && !chosen && "hover:bg-subtle",
                        )}
                      >
                        <span className="block break-words">{show(v)}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <div className="grid grid-cols-[150px_1fr_1fr] gap-2 px-3 py-2 text-sm">
              <span className="text-xs text-ink-3">Linked records</span>
              {[a.data, b.data].map((r, i) => (
                <span key={i} className="px-2 text-xs text-ink-2">
                  {r?.contact_points?.length ?? 0} contact points · {(r?.affiliations ?? r?.members)?.length ?? 0} affiliations
                </span>
              ))}
            </div>
          </div>
          <p className="text-xs text-ink-3">Click a value on the other record to carry it onto the survivor.</p>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for merge (optional)" />
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Merge these records?"
        description={`${label(other)} will be merged into ${label(keep)}. A full snapshot is kept and the merge can be reversed from merge history.`}
        confirmLabel="Merge"
        loading={m.merge.isPending}
        onConfirm={doMerge}
      />
    </Dialog>
  );
}

function QueueRow({ item, kind, onCompare }: { item: DuplicateItem; kind: EntityKind; onCompare: () => void }) {
  const { can } = useAuth();
  const m = useDuplicateMutations(kind);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/${kindPath(kind)}/${item.a_id}`} className="truncate font-medium text-ink hover:underline">{item.a_label ?? "—"}</Link>
          <ArrowLeftRight className="size-3.5 shrink-0 text-ink-3" />
          <Link href={`/${kindPath(kind)}/${item.b_id}`} className="truncate font-medium text-ink hover:underline">{item.b_label ?? "—"}</Link>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {item.reasons.map((r, i) => (
            <Badge key={i} tone="outline">
              {r.type === "name" ? "Same name" : r.type === "created_despite_match" ? "Created despite match" : `Shared ${r.type}`}
              {r.value && r.type !== "name" ? `: ${r.value}` : ""}
            </Badge>
          ))}
        </div>
      </div>
      <span className="text-xs font-medium tabular text-ink-2">{Math.round(item.score * 100)}%</span>
      {item.status === "open" && can("contacts", "edit") && (
        <>
          <Button size="sm" onClick={onCompare}>Compare</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => m.dismiss.mutate(item.id, { onSuccess: () => toast.success("Marked as not duplicates"), onError: (e) => toast.error(errorMessage(e)) })}
          >
            Not duplicates
          </Button>
        </>
      )}
      {item.status !== "open" && <StatusBadge status={item.status === "merged" ? "completed" : "closed"} label={titleCase(item.status)} />}
    </li>
  );
}

export function MergeHistory({ kind, recordId }: { kind: EntityKind; recordId?: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useMerges(kind, recordId);
  const m = useDuplicateMutations(kind);
  const [target, setTarget] = useState<MergeItem | null>(null);

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.length) return <EmptyState icon={<GitMerge />} title="No merges yet" description="Merged records and their reversals are listed here." />;

  return (
    <>
      <ul className="divide-y divide-line">
        {data.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate">
                <span className="font-medium text-ink">{r.merged_label ?? "Record"}</span>
                <span className="text-ink-3"> merged into </span>
                <Link href={`/${kindPath(kind)}/${r.survivor_id}`} className="font-medium text-ink hover:underline">{r.survivor_label ?? "—"}</Link>
              </p>
              <p className="text-xs text-ink-3" title={formatDateTime(r.merged_at)}>
                {formatRelative(r.merged_at)} · {r.repointed_count} linked rows moved{r.reason ? ` · ${r.reason}` : ""}
              </p>
            </div>
            {r.status === "reversed" ? (
              <Badge tone="neutral">Reversed {formatRelative(r.reversed_at)}</Badge>
            ) : (
              can("contacts", "edit") && (
                <Button size="sm" onClick={() => setTarget(r)}>
                  <Undo2 /> Unmerge
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Reverse this merge?"
        description={`${target?.merged_label ?? "The merged record"} will be restored and its linked rows moved back. Field values taken during the merge are returned to the survivor's previous values.`}
        confirmLabel="Unmerge"
        loading={m.unmerge.isPending}
        onConfirm={() =>
          target &&
          m.unmerge.mutate(target.id, {
            onSuccess: () => {
              toast.success("Merge reversed");
              setTarget(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

export function DuplicateReviewSheet({ kind, open, onOpenChange }: { kind: EntityKind; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const [tab, setTab] = useState("open");
  const [pair, setPair] = useState<{ a: string; b: string; reviewId?: string } | null>(null);
  const status = tab === "history" ? "open" : tab;
  const { data, isLoading } = useDuplicates(kind, status, open && tab !== "history");
  const m = useDuplicateMutations(kind);
  const noun = kind === "person" ? "people" : "organizations";
  const items = useMemo(() => data ?? [], [data]);

  const scan = () =>
    m.scan.mutate(undefined, {
      onSuccess: (r) => toast.success(`Scanned ${r.scanned} ${noun}; ${r.new_candidates} new likely duplicates`),
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Review duplicate ${noun}`}
      description="Likely duplicates by normalized name and shared email, phone or domain. Nothing is merged automatically."
      className="max-w-2xl"
    >
      <Tabs value={tab} onValueChange={setTab}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <TabList
            tabs={[
              { value: "open", label: "Queue", count: tab === "open" ? items.length : undefined },
              { value: "dismissed", label: "Dismissed" },
              { value: "merged", label: "Merged" },
              { value: "history", label: "Merge history" },
            ]}
          />
          {can("contacts", "edit") && (
            <Button size="sm" onClick={scan} loading={m.scan.isPending}>
              <ScanSearch /> Scan for duplicates
            </Button>
          )}
        </div>
        {(["open", "dismissed", "merged"] as const).map((s) => (
          <TabPanel key={s} value={s}>
            <div className="overflow-hidden rounded-lg border border-line">
              {isLoading ? (
                <Skeleton className="m-4 h-16" />
              ) : items.length === 0 ? (
                <EmptyState title={s === "open" ? "No likely duplicates in the queue" : `Nothing ${s}`} description={s === "open" ? "Run a scan to look for new candidates." : undefined} />
              ) : (
                <ul className="divide-y divide-line">
                  {items.map((d) => (
                    <QueueRow key={d.id} item={d} kind={kind} onCompare={() => setPair({ a: d.a_id, b: d.b_id, reviewId: d.id })} />
                  ))}
                </ul>
              )}
            </div>
          </TabPanel>
        ))}
        <TabPanel value="history">
          <div className="overflow-hidden rounded-lg border border-line">
            <MergeHistory kind={kind} />
          </div>
        </TabPanel>
      </Tabs>
      <CompareDialog kind={kind} pair={pair} onOpenChange={(o) => !o && setPair(null)} />
    </Sheet>
  );
}
