"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";

import { useAddEnrichment, useEnrichments, type Enrichment, type EntityKind } from "./api";

function restrictionText(r: Record<string, unknown>) {
  return Object.entries(r)
    .filter(([, v]) => v !== null && v !== false && v !== "")
    .map(([k, v]) => (v === true ? titleCase(k) : `${titleCase(k)}: ${String(v)}`));
}

const columns: Column<Enrichment>[] = [
  { id: "provider", header: "Provider", cell: (e) => <span className="font-medium">{e.provider}</span> },
  { id: "date", header: "Date", cell: (e) => <span className="whitespace-nowrap text-ink-2">{formatDate(e.enriched_at)}</span> },
  { id: "cost", header: "Cost", align: "right", cell: (e) => (e.cost != null ? formatCurrency(e.cost) : "—") },
  { id: "reliability", header: "Reliability", align: "right", cell: (e) => (e.reliability != null ? <ConfidencePill value={e.reliability} /> : "—") },
  { id: "fields", header: "Fields", cell: (e) => <span className="text-xs text-ink-2">{e.fields.length ? e.fields.map((f) => titleCase(f)).join(", ") : "—"}</span> },
  {
    id: "restrictions",
    header: "Restrictions",
    cell: (e) => {
      const r = restrictionText(e.restrictions ?? {});
      return r.length ? (
        <div className="flex flex-wrap gap-1">
          {r.map((x) => (
            <Badge key={x} tone="amber">{x}</Badge>
          ))}
        </div>
      ) : (
        <span className="text-xs text-ink-3">None</span>
      );
    },
  },
];

export function EnrichmentsCard({ kind, id }: { kind: EntityKind; id: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useEnrichments(kind, id);
  const add = useAddEnrichment(kind, id);
  const [open, setOpen] = useState(false);
  const blank = { provider: "", enriched_at: "", cost: "", reliability: "", fields: "", restrictions: "", notes: "" };
  const [form, setForm] = useState(blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    const rel = toNumber(form.reliability);
    add.mutate(
      {
        provider: form.provider.trim(),
        enriched_at: form.enriched_at ? new Date(form.enriched_at).toISOString() : null,
        cost: toNumber(form.cost),
        reliability: rel === null ? null : Math.min(100, Math.max(0, rel)) / 100,
        fields: form.fields.split(",").map((x) => x.trim()).filter(Boolean),
        restrictions: Object.fromEntries(form.restrictions.split(",").map((x) => x.trim()).filter(Boolean).map((x) => [x.toLowerCase().replace(/\s+/g, "_"), true])),
        notes: form.notes.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success("Enrichment recorded");
          setOpen(false);
          setForm(blank);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Contact enrichment"
        description="Provider, date, cost, reliability and usage restrictions for each pull"
        actions={
          can("contacts", "edit") && (
            <Button size="xs" onClick={() => setOpen(true)}>
              <Plus className="!size-3.5" /> Record
            </Button>
          )
        }
      />
      <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No enrichment on record" />} />

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Record enrichment"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.provider.trim()} loading={add.isPending} onClick={submit}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Provider" required className="col-span-2"><Input autoFocus value={form.provider} onChange={set("provider")} /></Field>
          <Field label="Enriched on"><Input type="date" value={form.enriched_at} onChange={set("enriched_at")} /></Field>
          <Field label="Cost ($)"><Input inputMode="decimal" value={form.cost} onChange={set("cost")} /></Field>
          <Field label="Reliability (%)"><Input inputMode="numeric" value={form.reliability} onChange={set("reliability")} /></Field>
          <Field label="Fields returned" hint="Comma separated"><Input value={form.fields} onChange={set("fields")} placeholder="phone, email" /></Field>
          <Field label="Restrictions" hint="Comma separated, e.g. no marketing, internal use only" className="col-span-2">
            <Input value={form.restrictions} onChange={set("restrictions")} />
          </Field>
          <Field label="Notes" className="col-span-2"><Textarea value={form.notes} onChange={set("notes")} /></Field>
        </div>
      </Dialog>
    </Card>
  );
}
