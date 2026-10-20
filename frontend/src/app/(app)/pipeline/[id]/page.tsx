"use client";

import { ArrowRight, Check, Circle, Info, MoreHorizontal, Pencil, ShieldAlert, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { RecordInteractions } from "@/features/outreach/record-interactions";
import { OpportunityOffersPanel } from "@/features/offers/opportunity-offers-panel";
import { RecordCriticalDates } from "@/features/contracts/record-critical-dates";
import { RecordDocuments } from "@/features/documents/record-documents";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import {
  DEAD_REASON_LABELS,
  PROGRESSION,
  STAGES,
  stageLabel,
  useDeleteOpportunity,
  useGates,
  useOpportunity,
  usePipelineMeta,
  useStageEvents,
  type Opportunity,
  type ReactivationRule,
  type ReactivationTypeSpec,
  type Stage,
} from "@/features/pipeline/api";
import { MoveStageDialog } from "@/features/pipeline/move-dialog";
import { OpportunityEditSheet } from "@/features/pipeline/opportunity-form";

function describeRule(rule: ReactivationRule | null, types: ReactivationTypeSpec[]): string {
  if (!rule?.type) return "—";
  const spec = types.find((t) => t.type === rule.type);
  const parts = Object.entries(rule.params ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
    .map(([k, v]) => {
      const p = spec?.params.find((x) => x.key === k);
      const shown = p?.type === "date" ? formatDate(String(v)) : p?.type === "select" ? titleCase(String(v)) : v === true ? "yes" : String(v);
      return `${p?.label ?? titleCase(k)}: ${shown}`;
    });
  return `${spec?.label ?? titleCase(rule.type)}${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
}

function StageStepper({ stage }: { stage: Stage }) {
  const idx = PROGRESSION.indexOf(stage);
  const off = idx === -1;
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <ol className="flex min-w-[860px] items-center">
        {PROGRESSION.map((s, i) => {
          const done = !off && i < idx;
          const current = s === stage;
          return (
            <li key={s} className="flex flex-1 items-center">
              <div className="flex flex-col items-center gap-1">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-2xs font-semibold",
                    current ? "border-ink bg-ink text-white" : done ? "border-positive bg-positive-soft text-positive" : "border-line-strong bg-surface text-ink-3",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("whitespace-nowrap text-2xs", current ? "font-semibold text-ink" : "text-ink-3")}>{stageLabel(s)}</span>
              </div>
              {i < PROGRESSION.length - 1 && <span className={cn("mx-1 mb-4 h-px flex-1", done ? "bg-positive/50" : "bg-line")} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function NextGate({ o, onMove }: { o: Opportunity; onMove: (s: Stage) => void }) {
  const { can } = useAuth();
  const { data, isLoading } = useGates(o.id);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  const next = data?.next_stage;
  const gate = data?.stages.find((s) => s.stage === next);
  if (!data || !next || !gate) {
    return (
      <Card>
        <CardHeader title="Next stage" />
        <CardBody className="text-sm text-ink-2">
          {o.stage === "closed"
            ? "Closed — this transaction record is immutable."
            : "Reactivate this opportunity by moving it to an active stage. The target stage's requirements apply."}
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader
        title={`Ready for ${stageLabel(next).toLowerCase()}?`}
        description={gate.ready ? "All requirements are met." : "These requirements block advancement."}
        actions={
          can("pipeline", "edit") && (
            <Button size="sm" variant={gate.ready ? "primary" : "secondary"} onClick={() => onMove(next)}>
              {gate.ready ? "Advance" : "Complete"} <ArrowRight />
            </Button>
          )
        }
      />
      <CardBody>
        <ul className="space-y-2">
          {gate.requirements.map((r) => (
            <li key={r.key} className="flex items-start gap-2 text-sm">
              {!r.blocking ? (
                <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
              ) : r.met ? (
                <Check className="mt-0.5 size-4 shrink-0 text-positive" />
              ) : r.fields.length ? (
                <Circle className="mt-0.5 size-4 shrink-0 text-caution" />
              ) : (
                <X className="mt-0.5 size-4 shrink-0 text-negative" />
              )}
              <div className="min-w-0">
                <p className="text-ink">{r.label}</p>
                {r.detail && <p className="text-xs text-ink-3">{r.detail}</p>}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function StageHistory({ id }: { id: string }) {
  const { data, isLoading } = useStageEvents(id);
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.length) return <p className="text-sm text-ink-3">No stage movements yet.</p>;
  return (
    <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-line">
      {data.map((e) => (
        <li key={e.id} className="relative flex gap-3">
          <Avatar name={e.actor_name ?? "System"} className="relative z-10 ring-4 ring-surface" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink">
              <span className="font-medium">{e.actor_name ?? "System"}</span>
              {e.from_stage ? (
                <>
                  <span className="text-ink-2">moved</span>
                  <StatusBadge status={e.from_stage} label={stageLabel(e.from_stage)} />
                  <ArrowRight className="size-3 text-ink-3" />
                </>
              ) : (
                <span className="text-ink-2">created in</span>
              )}
              <StatusBadge status={e.to_stage} label={stageLabel(e.to_stage)} />
              {e.override && (
                <Badge tone="red">
                  <ShieldAlert className="size-3" /> Override
                </Badge>
              )}
            </p>
            <p className="text-xs text-ink-3" title={formatDateTime(e.at)}>
              {formatRelative(e.at)}
            </p>
            {e.reason && <p className="mt-1 text-sm text-ink-2">{e.reason}</p>}
            {e.override && e.unmet.length > 0 && <p className="mt-0.5 text-xs text-ink-3">Unmet: {e.unmet.map((r) => r.label).join(", ")}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function OpportunityDetail({ id }: { id: string }) {
  const router = useRouter();
  const { can } = useAuth();
  const { data: o, isLoading, error } = useOpportunity(id);
  const { data: meta } = usePipelineMeta();
  const gates = useGates(id);
  const remove = useDeleteOpportunity();
  const [moveTo, setMoveTo] = useState<Stage | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !o) {
    return <EmptyState title="Opportunity not found" description={errorMessage(error)} action={<Link href="/pipeline"><Button>Back to pipeline</Button></Link>} />;
  }

  const editable = can("pipeline", "edit") && o.stage !== "closed";
  const next = gates.data?.next_stage ?? null;
  const types = meta?.reactivation_types ?? [];
  const overdue = !!o.next_action_at && isOverdue(o.next_action_at);

  const doDelete = () =>
    remove.mutate(id, {
      onSuccess: () => {
        toast.success("Opportunity deleted");
        router.replace("/pipeline");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Pipeline", href: "/pipeline" }, { label: o.title }]}
        title={o.title}
        description={
          o.property_id ? (
            <Link href={`/properties/${o.property_id}`} className="hover:underline">
              {[o.property_label, o.property_city, o.property_state].filter(Boolean).join(", ")}
            </Link>
          ) : undefined
        }
        meta={
          <>
            <StatusBadge status={o.stage} label={stageLabel(o.stage)} />
            <StatusBadge status={o.priority} label={`${titleCase(o.priority)} priority`} />
            <span className={cn("text-xs", o.stalled ? "font-medium text-caution" : "text-ink-3")}>
              {formatNumber(Math.floor(o.stage_age_days))} days in stage{o.stalled ? " · stalled" : ""}
            </span>
            {o.owner_name && (
              <span className="flex items-center gap-1 text-xs text-ink-3">
                <Avatar name={o.owner_name} size={18} /> {o.owner_name}
              </span>
            )}
          </>
        }
        actions={
          editable && (
            <>
              {next && (
                <Button variant="primary" onClick={() => setMoveTo(next)}>
                  Move to {stageLabel(next).toLowerCase()} <ArrowRight />
                </Button>
              )}
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent width={220}>
                  <MenuLabel>Move to stage</MenuLabel>
                  {STAGES.filter((s) => s !== o.stage && s !== "dead" && s !== "nurture").map((s) => (
                    <MenuItem key={s} onSelect={() => setMoveTo(s)}>
                      {stageLabel(s)}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  {o.stage !== "nurture" && <MenuItem onSelect={() => setMoveTo("nurture")}>Move to nurture…</MenuItem>}
                  {o.stage !== "dead" && (
                    <MenuItem destructive onSelect={() => setMoveTo("dead")}>
                      Mark as dead…
                    </MenuItem>
                  )}
                  {can("pipeline", "delete") && o.stage !== "dead" && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} destructive onSelect={() => setDeleting(true)}>
                        Delete opportunity
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            </>
          )
        }
      />

      <Card className="mb-5">
        <CardBody>
          <StageStepper stage={o.stage} />
        </CardBody>
      </Card>

      {o.stage === "dead" && (
        <div className="mb-5 rounded-lg border border-negative/30 bg-negative-soft px-4 py-3 text-sm">
          <p className="font-medium text-negative">
            Dead · {o.dead_reason ? DEAD_REASON_LABELS[o.dead_reason] : "No reason"}
            {o.price_gap != null && ` · price gap ${formatCurrency(o.price_gap)}`}
            {o.dead_at && <span className="font-normal text-ink-3"> · {formatDate(o.dead_at)}</span>}
          </p>
          {o.dead_notes && <p className="mt-0.5 text-ink-2">{o.dead_notes}</p>}
          <p className="mt-1 text-ink-2">
            <span className="text-ink-3">Reactivation rule:</span> {describeRule(o.reactivation_rule, types)}
          </p>
          <p className="mt-1 text-xs text-ink-3">Dead opportunities are retained and return with this context when the rule fires.</p>
        </div>
      )}
      {o.stage === "nurture" && (
        <div className="mb-5 rounded-lg border border-caution/30 bg-caution-soft px-4 py-3 text-sm">
          <p className="font-medium text-caution">
            Nurture · next touch {formatDate(o.next_touch_on)}
            {o.nurture_cadence_days ? ` · every ${o.nurture_cadence_days} days` : ""}
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Key fields" actions={editable && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil /> Edit</Button>} />
            <CardBody>
              <FieldGrid cols={3}>
                <FieldItem label="Next action">{o.next_action}</FieldItem>
                <FieldItem label="Next action due">
                  {o.next_action_at ? <span className={cn(overdue && "font-medium text-negative")}>{formatDateTime(o.next_action_at)}</span> : null}
                </FieldItem>
                <FieldItem label="Source">{o.source}</FieldItem>
                <FieldItem label="Primary contact">{o.primary_person_label ?? (o.primary_person_id ? "Linked" : null)}</FieldItem>
                <FieldItem label="Owner organization">{o.primary_organization_label ?? (o.primary_organization_id ? "Linked" : null)}</FieldItem>
                <FieldItem label="Research fields">{o.research_missing_fields.length ? o.research_missing_fields.map(titleCase).join(", ") : null}</FieldItem>
                <FieldItem label="Estimated value">{o.estimated_value != null ? formatCurrency(o.estimated_value) : null}</FieldItem>
                <FieldItem label="Cap rate">{o.cap_rate != null ? formatPercent(o.cap_rate, 2) : null}</FieldItem>
                <FieldItem label="Price expectation">{o.price_expectation != null ? formatCurrency(o.price_expectation) : null}</FieldItem>
                <FieldItem label="Offer price">{o.offer_price != null ? formatCurrency(o.offer_price) : null}</FieldItem>
                <FieldItem label="Offer sent">{o.offer_sent_at ? formatDate(o.offer_sent_at) : null}</FieldItem>
                <FieldItem label="Response due">
                  {o.response_due_at ? <span className={cn(isOverdue(o.response_due_at) && o.stage === "offer" && "font-medium text-negative")}>{formatDate(o.response_due_at)}</span> : null}
                </FieldItem>
                <FieldItem label="Contract executed">{o.contract_executed_on ? formatDate(o.contract_executed_on) : null}</FieldItem>
                <FieldItem label="DD deadline">{o.dd_deadline ? formatDate(o.dd_deadline) : null}</FieldItem>
                <FieldItem label="Closing date">{o.closing_date ? formatDate(o.closing_date) : null}</FieldItem>
                <FieldItem label="Closed price">{o.closed_price != null ? formatCurrency(o.closed_price) : null}</FieldItem>
                <FieldItem label="Closed on">{o.closed_on ? formatDate(o.closed_on) : null}</FieldItem>
                <FieldItem label="Created">{formatDateTime(o.created_at)}</FieldItem>
              </FieldGrid>
              {(o.underwriting_notes || o.research_notes || o.notes) && (
                <div className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
                  {o.underwriting_notes && (
                    <div>
                      <p className="text-xs text-ink-3">Underwriting notes</p>
                      <p className="whitespace-pre-wrap text-ink-2">{o.underwriting_notes}</p>
                    </div>
                  )}
                  {o.research_notes && (
                    <div>
                      <p className="text-xs text-ink-3">Research notes</p>
                      <p className="whitespace-pre-wrap text-ink-2">{o.research_notes}</p>
                    </div>
                  )}
                  {o.notes && (
                    <div>
                      <p className="text-xs text-ink-3">Notes</p>
                      <p className="whitespace-pre-wrap text-ink-2">{o.notes}</p>
                    </div>
                  )}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Stage history" description="Every movement and override, with actor and reason." />
            <CardBody>
              <StageHistory id={id} />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <NextGate o={o} onMove={setMoveTo} />
          {can("outreach") && (
            <RecordInteractions filter={{ opportunity_id: id }} />
          )}
          {can("offers") && <OpportunityOffersPanel opportunityId={id} />}
          {can("contracts") && <RecordCriticalDates relatedType="opportunity" relatedId={id} />}
          {can("documents") && <RecordDocuments entityType="opportunity" entityId={id} />}
          <Card>
            <CardHeader title="Activity" />
            <CardBody>
              <RecordTimeline entityType="opportunity" entityId={id} />
            </CardBody>
          </Card>
        </div>
      </div>

      <MoveStageDialog open={!!moveTo} onOpenChange={(v) => !v && setMoveTo(null)} opportunity={o} toStage={moveTo} />
      {editable && <OpportunityEditSheet open={editing} onOpenChange={setEditing} opportunity={o} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this opportunity?"
        description="Deleting is not normal workflow — consider marking it dead with a reactivation rule instead. The record is retained for audit."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={doDelete}
      />
    </>
  );
}

export default function OpportunityPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <OpportunityDetail id={params.id} />
    </Suspense>
  );
}
