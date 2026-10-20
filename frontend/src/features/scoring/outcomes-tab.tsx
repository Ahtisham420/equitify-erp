"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, Toolbar, type FilterChip } from "@/components/data/filters";
import { EmptyState, ListCard, StatCard } from "@/components/data/page";
import { PropertyPicker } from "@/components/data/entity-picker";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, titleCase } from "@/lib/utils";

import { BANDS, BAND_LABELS, useOutcomeSummary, type Outcome } from "./api";
import { BandBadge } from "./components";

const RESULT_TONES: Record<string, Tone> = { won: "green", lost: "red", open: "blue" };

const columns: Column<Outcome>[] = [
  {
    id: "property",
    header: "Property",
    cell: (o) => (
      <div className="min-w-[200px]">
        <Link href={`/properties/${o.property_id}`} className="font-medium text-ink hover:underline">
          {o.property_label ?? "Property"}
        </Link>
        {o.opportunity_id && (
          <p className="text-xs text-ink-3">
            <Link href={`/pipeline/${o.opportunity_id}`} className="hover:underline">
              Opportunity
            </Link>
          </p>
        )}
      </div>
    ),
  },
  { id: "disposition", header: "Disposition", cell: (o) => <StatusBadge status={o.disposition} /> },
  { id: "decided", header: "Decided", sortKey: "decided_at", cell: (o) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(o.decided_at)}</span> },
  { id: "score", header: "Score at decision", sortKey: "score_at_decision", align: "right", cell: (o) => (o.score_at_decision === null ? "Unscored" : Math.round(o.score_at_decision)) },
  { id: "band", header: "Band", cell: (o) => (o.band_at_decision ? <BandBadge band={o.band_at_decision} /> : <span className="text-ink-3">—</span>) },
  { id: "result", header: "Result", cell: (o) => <Badge tone={RESULT_TONES[o.result] ?? "neutral"} dot>{titleCase(o.result)}</Badge> },
  { id: "elapsed", header: "Elapsed", sortKey: "elapsed_days", align: "right", cell: (o) => (o.elapsed_days === null ? "—" : `${formatNumber(o.elapsed_days, 1)} d`) },
  { id: "version", header: "Config", align: "right", cell: (o) => (o.config_version ? `v${o.config_version}` : "—") },
  { id: "source", header: "Source", cell: (o) => <span className="text-xs text-ink-3">{titleCase(o.source)}</span> },
];

function LogOutcomeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [disposition, setDisposition] = useState("passed");
  const [result, setResult] = useState("lost");
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () => api.post<Outcome>("/scoring/outcomes", { property_id: propertyId, disposition, result, notes: notes.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scoring"] });
      toast.success("Outcome logged with the current score");
      onOpenChange(false);
      setPropertyId(null);
      setNotes("");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Log outcome"
      description="Records a decision with the property's current score, for measuring and recalibrating the model."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!propertyId || !disposition.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Log outcome
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Property" required>
          <PropertyPicker value={propertyId} onChange={(id) => setPropertyId(id)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Disposition" required hint="e.g. passed, pursued, offer">
            <Input value={disposition} onChange={(e) => setDisposition(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Result">
            <Select value={result} onChange={(e) => setResult(e.target.value)} options={["open", "won", "lost"].map((r) => ({ value: r, label: titleCase(r) }))} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </div>
    </Dialog>
  );
}

export function OutcomesTab({ logging, onLoggingChange }: { logging: boolean; onLoggingChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const list = useListQuery<Outcome>("scoring", "/scoring/outcomes");
  const { url } = list;
  const { data: summary } = useOutcomeSummary();
  const { data: facets } = useQuery({
    queryKey: ["scoring", "outcomes", "facets"],
    queryFn: () => api.get<{ result: Record<string, number>; disposition: Record<string, number>; band: Record<string, number> }>("/scoring/outcomes/facets"),
  });

  const chips: FilterChip[] = [];
  for (const [key, label] of [["result", "Result"], ["disposition", "Disposition"], ["band", "Band"]] as const) {
    const v = url.getAll(key);
    if (v.length) chips.push({ key, label, value: v.map(titleCase).join(", "), onRemove: () => url.set({ [key]: null }) });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Decisions logged" value={formatNumber(summary?.total ?? 0)} hint={`${summary?.open ?? 0} still open`} />
        <StatCard label="Won" value={formatNumber(summary?.won ?? 0)} tone="positive" hint={`Avg score ${summary?.avg_score_won ?? "—"}`} />
        <StatCard label="Lost" value={formatNumber(summary?.lost ?? 0)} tone="negative" hint={`Avg score ${summary?.avg_score_lost ?? "—"}`} />
        <StatCard label="Recalibration" value={summary?.recalibration_ready ? "Ready" : "Not yet"} hint="Needs enough won and lost outcomes" />
      </div>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar right={can("scoring", "edit") ? <Button onClick={() => onLoggingChange(true)}>Log outcome</Button> : undefined}>
              <FacetFilter label="Result" options={["open", "won", "lost"].map((r) => ({ value: r, label: titleCase(r), count: facets?.result?.[r] ?? 0 }))} selected={url.getAll("result")} onChange={(v) => url.set({ result: v })} />
              <FacetFilter label="Disposition" options={Object.entries(facets?.disposition ?? {}).map(([k, c]) => ({ value: k, label: titleCase(k), count: c }))} selected={url.getAll("disposition")} onChange={(v) => url.set({ disposition: v })} />
              <FacetFilter label="Band" options={BANDS.map((b) => ({ value: b, label: BAND_LABELS[b], count: facets?.band?.[b] ?? 0 }))} selected={url.getAll("band")} onChange={(v) => url.set({ band: v })} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: url.get("tab") })} />
          </div>
        }
        footer={
          <TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(page) => url.set({ page }, { resetPage: false })} onPageSize={(size) => url.set({ page_size: size })} />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          empty={<EmptyState icon={<ClipboardList />} title="No outcomes yet" description="Decisions are logged automatically when opportunities are pursued, die or close." />}
        />
      </ListCard>
      <LogOutcomeDialog open={logging} onOpenChange={onLoggingChange} />
    </div>
  );
}
