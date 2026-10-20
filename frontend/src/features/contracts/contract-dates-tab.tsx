"use client";

import { AlertTriangle, CalendarClock, Lock, Plus, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Avatar, Skeleton, Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatRelative } from "@/lib/utils";

import { describeRule, isOverdueDate, useContractDates, useGenerateDates, useProposeFromExtracted, type Contract, type CriticalDate } from "./api";
import { AddDateDialog, DateActionDialog, DateRowActions, DateStatusBadge, DueText, SourceBadge, type DateDialogKind } from "./critical-date-actions";

function DateRow({ d, onAction }: { d: CriticalDate; onAction: (kind: DateDialogKind) => void }) {
  const rule = describeRule(d.rule);
  return (
    <li className={cn("grid grid-cols-1 gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_200px_auto] md:items-center", isOverdueDate(d) && "bg-negative-soft/40")}>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {d.is_blocking && (
            <Tooltip content="Blocking deadline — escalates as critical">
              <Lock className="size-3.5 shrink-0 text-ink-3" />
            </Tooltip>
          )}
          <span className="truncate">{d.label}</span>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <DateStatusBadge status={d.status} />
          <SourceBadge d={d} />
          {rule && <span>{rule}</span>}
          {d.citation?.clause && <span>· § {d.citation.clause}</span>}
          {d.citation?.page != null && <span>· p. {d.citation.page}</span>}
        </div>
        {d.status !== "proposed" && d.confirmed_at && (
          <p className="mt-1 text-xs text-ink-3">
            <ShieldCheck className="mr-1 inline size-3 text-positive" />
            Confirmed {d.confirmed_by_name ? `by ${d.confirmed_by_name} ` : ""}
            {formatRelative(d.confirmed_at)}
            {d.confirm_note ? ` · ${d.confirm_note}` : ""}
          </p>
        )}
        {d.proposed_due_on && (
          <p className="mt-1 flex items-center gap-1 text-xs text-caution">
            <AlertTriangle className="size-3" /> New computed value {formatDate(d.proposed_due_on)} differs — review before relying on it.
          </p>
        )}
        {d.resolution_note && <p className="mt-1 text-xs text-ink-2">{d.resolution_note}</p>}
      </div>
      <div className="text-sm">
        <DueText d={d} />
        {d.original_due_on && d.original_due_on !== d.due_on && <p className="text-xs text-ink-3">Originally {formatDate(d.original_due_on)}</p>}
        {d.owner_name && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-3">
            <Avatar name={d.owner_name} size={16} /> {d.owner_name}
          </p>
        )}
      </div>
      <DateRowActions d={d} onAction={onAction} />
    </li>
  );
}

export function ContractDatesTab({ contract }: { contract: Contract }) {
  const { can } = useAuth();
  const { data, isLoading } = useContractDates(contract.id);
  const generate = useGenerateDates(contract.id);
  const propose = useProposeFromExtracted(contract.id);
  const [adding, setAdding] = useState(false);
  const [active, setActive] = useState<{ d: CriticalDate; kind: DateDialogKind } | null>(null);
  const editable = can("contracts", "edit") && !["closed", "terminated"].includes(contract.status);

  const rows = data ?? [];
  const proposed = rows.filter((d) => d.status === "proposed");
  const tracked = rows.filter((d) => d.status !== "proposed");

  const runGenerate = () =>
    generate.mutate(undefined, {
      onSuccess: (r) => toast.success(`${r.length} dates computed from the key terms`),
      onError: (e) => toast.error(errorMessage(e)),
    });
  const runPropose = () =>
    propose.mutate(undefined, {
      onSuccess: (r) => {
        if (r.proposed.length) toast.success(`${r.proposed.length} dates proposed from confirmed extraction`);
        else toast.message(r.message ?? "Nothing to propose");
        if (r.skipped.length) toast.warning(`Skipped: ${r.skipped.join("; ")}`);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-5">
      {editable && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {contract.status === "executed" && (
            <Button size="sm" onClick={runGenerate} loading={generate.isPending}>
              <RefreshCw /> Recompute from terms
            </Button>
          )}
          <Button size="sm" onClick={runPropose} loading={propose.isPending} disabled={!contract.effective_on}>
            <Sparkles /> Propose from document extraction
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add date
          </Button>
        </div>
      )}

      {proposed.length > 0 && (
        <Card className="border-caution/40">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Awaiting confirmation <Badge tone="amber">{proposed.length}</Badge>
              </span>
            }
            description="Generated and AI-proposed dates are candidates only. Verify each one against the signed agreement before it is relied on."
          />
          <ul className="divide-y divide-line">
            {proposed.map((d) => (
              <DateRow key={d.id} d={d} onAction={(kind) => setActive({ d, kind })} />
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title="Confirmed deadlines" description="Accountable owner, lead time and escalation apply to every open date." />
        {tracked.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title={rows.length ? "Nothing confirmed yet" : "No critical dates"}
            description={
              rows.length
                ? "Confirm the proposed dates above against the source contract."
                : contract.status === "draft"
                  ? "Dates are generated when the contract is marked executed."
                  : "Recompute from the key terms or add dates manually."
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {tracked.map((d) => (
              <DateRow key={d.id} d={d} onAction={(kind) => setActive({ d, kind })} />
            ))}
          </ul>
        )}
      </Card>

      <AddDateDialog open={adding} onOpenChange={setAdding} relatedType="contract" relatedId={contract.id} relatedLabel={contract.title} propertyId={contract.property_id} />
      <DateActionDialog date={active?.d ?? null} kind={active?.kind ?? null} onClose={() => setActive(null)} />
    </div>
  );
}
