"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Download, GitPullRequest, Plus, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, MoreFilters, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Params } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRelative, titleCase } from "@/lib/utils";

import { LINK_RELATIONSHIPS, nodeHref, useLinkMutations, type Link as LinkT, type LinkFacets } from "./api";
import { EvidenceList } from "./evidence";
import { ConfirmLinkDialog, LinkSheet, relationPhrase } from "./link-sheet";

const STATUSES = ["suggested", "confirmed", "rejected"];
const MORE: MoreFilterField[] = [
  { type: "select", label: "Origin", key: "suggested_by", options: [{ value: "engine", label: "Suggestion engine" }, { value: "user", label: "Entered by a user" }] },
  { type: "number", label: "Minimum confidence (0–1)", key: "min_confidence" },
];

export function LinkReviewQueue() {
  const { can } = useAuth();
  const m = useLinkMutations();
  const [confirming, setConfirming] = useState<LinkT | null>(null);
  const [rejecting, setRejecting] = useState<LinkT | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [adding, setAdding] = useState(false);

  const statusSelected = useUrlState().getAll("status");
  const hasStatus = statusSelected.length > 0;
  const extra = useMemo<Params>(() => (hasStatus ? {} : { status: "suggested" }), [hasStatus]);
  const list = useListQuery<LinkT>("ownership-links", "/ownership/links", extra);
  const { url } = list;

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return { ...rest, ...extra };
  }, [url.params, extra]);

  const { data: facets } = useQuery({
    queryKey: ["ownership", "link-facets", filterParams],
    queryFn: () => api.get<LinkFacets>("/ownership/links/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const run = () =>
    m.suggest.mutate(undefined, {
      onSuccess: (r) => toast.success(`${r.created} new suggestions, ${r.updated} refreshed`),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const exportCsv = async () => {
    try {
      await api.download("/ownership/links/export", filterParams, "entity-relationships.csv");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const chips: FilterChip[] = [];
  for (const [key, label] of [["status", "Status"], ["relationship", "Relationship"]] as const) {
    const values = url.getAll(key);
    if (values.length) chips.push({ key, label, value: values.map(titleCase).join(", "), onRemove: () => url.set({ [key]: null }) });
  }
  if (url.get("suggested_by")) chips.push({ key: "suggested_by", label: "Origin", value: titleCase(url.get("suggested_by")), onRemove: () => url.set({ suggested_by: null }) });
  if (url.get("min_confidence")) chips.push({ key: "min_confidence", label: "Confidence ≥", value: url.get("min_confidence")!, onRemove: () => url.set({ min_confidence: null }) });

  const columns: Column<LinkT>[] = [
    {
      id: "link",
      header: "Relationship",
      cell: (l) => (
        <div className="min-w-[280px] max-w-[420px]">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <Link href={nodeHref(l.from_kind, l.from_id)} className="font-medium text-ink hover:underline">{l.from_label ?? "—"}</Link>
            <span className="flex items-center gap-1 text-xs text-ink-3">
              <ArrowRight className="size-3" /> {relationPhrase(l.relationship)} <ArrowRight className="size-3" />
            </span>
            <Link href={nodeHref(l.to_kind, l.to_id)} className="font-medium text-ink hover:underline">{l.to_label ?? "—"}</Link>
          </div>
          <p className="text-xs text-ink-3">
            {titleCase(l.from_kind)} → {titleCase(l.to_kind)} · {l.suggested_by === "engine" ? "Suggested by engine" : l.source} · {formatRelative(l.created_at)}
          </p>
        </div>
      ),
    },
    { id: "evidence", header: "Evidence", cell: (l) => <div className="max-w-[360px]"><EvidenceList items={l.evidence} hidden={l.hidden_evidence} /></div> },
    { id: "confidence", header: "Confidence", sortKey: "confidence", align: "right", cell: (l) => <ConfidencePill value={l.confidence} /> },
    {
      id: "status",
      header: "Status",
      sortKey: "status",
      cell: (l) =>
        l.status === "suggested" ? <Badge tone="amber" dot>Needs review</Badge> : <StatusBadge status={l.status === "confirmed" ? "verified" : "rejected"} label={titleCase(l.status)} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (l) =>
        l.status === "suggested" && can("ownership", "edit") ? (
          <div className="flex justify-end gap-1">
            <Button size="xs" onClick={() => setConfirming(l)}>
              <Check className="!size-3.5" /> Confirm
            </Button>
            <Button size="xs" variant="ghost" onClick={() => { setRejecting(l); setRejectNote(""); }} aria-label="Reject">
              <X className="!size-3.5" />
            </Button>
          </div>
        ) : l.review_note ? (
          <span className="text-xs text-ink-3">{l.review_note}</span>
        ) : null,
    },
  ];

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="ownership" />
                  {can("ownership", "export") && (
                    <Button onClick={exportCsv}>
                      <Download /> Export
                    </Button>
                  )}
                  {can("ownership", "edit") && (
                    <Button onClick={run} loading={m.suggest.isPending}>
                      <Sparkles /> Find suggestions
                    </Button>
                  )}
                  {can("ownership", "create") && (
                    <Button variant="primary" onClick={() => setAdding(true)}>
                      <Plus /> Add relationship
                    </Button>
                  )}
                </>
              }
            >
              <FacetFilter
                label="Status"
                options={STATUSES.map((s) => ({ value: s, label: titleCase(s), count: facets?.status[s] ?? 0 }))}
                selected={statusSelected.length ? statusSelected : ["suggested"]}
                onChange={(v) => url.set({ status: v.length ? v : STATUSES })}
              />
              <FacetFilter
                label="Relationship"
                options={LINK_RELATIONSHIPS.map((r) => ({ value: r, label: titleCase(r), count: facets?.relationship[r] ?? 0 }))}
                selected={url.getAll("relationship")}
                onChange={(v) => url.set({ relationship: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab") })} />
          </div>
        }
        footer={
          <TableFooter
            page={list.page}
            pageSize={list.pageSize}
            total={list.data?.total ?? 0}
            onPage={(page) => url.set({ page }, { resetPage: false })}
            onPageSize={(size) => url.set({ page_size: size })}
          />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          empty={
            <EmptyState
              icon={<GitPullRequest />}
              title="Nothing to review"
              description="Run the suggestion engine to propose relationships from shared mailing addresses, phones, email domains and registered agents."
            />
          }
        />
      </ListCard>

      <ConfirmLinkDialog link={confirming} onOpenChange={(o) => !o && setConfirming(null)} />
      <Dialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title="Reject suggestion"
        description="Rejected suggestions are kept so the engine does not propose them again."
        footer={
          <>
            <Button onClick={() => setRejecting(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={m.reject.isPending}
              onClick={() =>
                rejecting &&
                m.reject.mutate(
                  { id: rejecting.id, note: rejectNote.trim() || undefined },
                  { onSuccess: () => { toast.success("Suggestion rejected"); setRejecting(null); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              Reject
            </Button>
          </>
        }
      >
        <Input autoFocus value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Reason (optional)" />
      </Dialog>
      <LinkSheet open={adding} onOpenChange={setAdding} />
    </>
  );
}
