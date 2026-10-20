"use client";

import { Check, Circle, Info, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { ApiError, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  stageLabel,
  useGates,
  useMoveOpportunity,
  useOpportunity,
  usePipelineMeta,
  type GateErrorDetail,
  type Opportunity,
  type OpportunityInput,
  type ReactivationRule,
  type ReactivationTypeSpec,
  type Requirement,
  type Stage,
} from "./api";
import { StageFieldInput } from "./stage-fields";

/** Optional (non-gating) fields worth capturing when entering a stage. */
const EXTRA_FIELDS: Partial<Record<Stage, string[]>> = {
  screening: [],
  research: ["research_notes"],
  contact: ["next_action", "next_action_at"],
  dead: ["dead_notes"],
  nurture: ["nurture_cadence_days", "next_action"],
};

const filled = (v: unknown) => !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0));

export function ruleProblems(rule: ReactivationRule | null | undefined, types: ReactivationTypeSpec[]): string[] {
  if (!rule?.type) return ["Choose a reactivation trigger type"];
  const spec = types.find((t) => t.type === rule.type);
  if (!spec) return ["Unknown reactivation type"];
  const p = rule.params ?? {};
  const label = (k: string) => spec.params.find((x) => x.key === k)?.label ?? k;
  const out = spec.required.filter((k) => !filled(p[k])).map((k) => `${label(k)} is required`);
  if (spec.any_of.length && spec.any_of.every((k) => !filled(p[k]) || p[k] === false)) out.push(`Provide one of: ${spec.any_of.map((k) => label(k).toLowerCase()).join(", ")}`);
  return out;
}

export function MoveStageDialog({
  opportunity,
  toStage,
  open,
  onOpenChange,
  onMoved,
}: {
  opportunity: { id: string; title: string; stage: Stage } | null;
  toStage: Stage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMoved?: (o: Opportunity) => void;
}) {
  const id = open && opportunity ? opportunity.id : null;
  const gates = useGates(id);
  const full = useOpportunity(id);
  const { data: meta } = usePipelineMeta();
  const move = useMoveOpportunity();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [overrideReason, setOverrideReason] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const types = meta?.reactivation_types ?? [];

  useEffect(() => {
    if (open) {
      setValues({});
      setOverrideReason("");
      setServerError(null);
    }
  }, [open, toStage, opportunity?.id]);

  const current = (f: string): unknown => (f in values ? values[f] : (full.data as unknown as Record<string, unknown> | undefined)?.[f]);
  const set = (f: string, v: unknown) => setValues((s) => ({ ...s, [f]: v }));

  const target = gates.data?.stages.find((s) => s.stage === toStage);
  const requirements = useMemo(() => {
    const reqs = [...(target?.requirements ?? [])];
    // Price gap becomes required as soon as the user picks "price gap" in this dialog.
    if (toStage === "dead" && current("dead_reason") === "price_gap" && !reqs.some((r) => r.key === "price_gap")) {
      reqs.splice(1, 0, { key: "price_gap", label: "Price gap amount", met: false, blocking: true, detail: null, fields: ["price_gap"] });
    }
    return toStage === "dead" && current("dead_reason") !== "price_gap" ? reqs.filter((r) => r.key !== "price_gap") : reqs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, toStage, values, full.data]);

  const satisfied = (r: Requirement): boolean => {
    const editable = r.fields.filter((f) => f !== "property_id");
    // Untouched requirements use the server's verdict (it may apply defaults, e.g. research fields).
    if (!editable.length || (r.met && !editable.some((f) => f in values))) return r.met;
    if (r.key === "reactivation_rule") return ruleProblems(current("reactivation_rule") as ReactivationRule | null, types).length === 0;
    if (r.key === "dead_reason") return filled(current("dead_reason"));
    return r.key === "owner_contact" ? editable.some((f) => filled(current(f))) : editable.every((f) => filled(current(f)));
  };

  const unmet = requirements.filter((r) => r.blocking && !satisfied(r));
  const fields = Array.from(new Set([...requirements.flatMap((r) => r.fields), ...(toStage ? EXTRA_FIELDS[toStage] ?? [] : [])])).filter((f) => f !== "property_id");
  const needsOverride = unmet.length > 0;
  const canOverride = gates.data?.can_override ?? false;
  const willCreateFollowUp = (toStage === "contact" || toStage === "negotiation") && !filled(current("next_action_at"));

  const submit = () => {
    if (!opportunity || !toStage) return;
    setServerError(null);
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) changed[k] = v;
    move.mutate(
      { id: opportunity.id, to_stage: toStage, fields: changed as OpportunityInput, override_reason: needsOverride ? overrideReason : null },
      {
        onSuccess: (o) => {
          toast.success(`Moved to ${stageLabel(toStage)}${needsOverride ? " (override recorded)" : ""}`);
          onOpenChange(false);
          onMoved?.(o);
        },
        onError: (e) => {
          const detail = e instanceof ApiError ? (e.detail as GateErrorDetail | null) : null;
          setServerError(detail?.message ?? errorMessage(e));
          gates.refetch();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      title={`Move to ${stageLabel(toStage)}`}
      description={opportunity ? `${opportunity.title} · currently ${stageLabel(opportunity.stage).toLowerCase()}` : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={needsOverride ? "danger" : "primary"}
            loading={move.isPending}
            disabled={!target || (needsOverride && (!canOverride || overrideReason.trim().length < 3))}
            onClick={submit}
          >
            {needsOverride ? "Override and move" : `Move to ${stageLabel(toStage)}`}
          </Button>
        </>
      }
    >
      {gates.isLoading || full.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !target ? (
        <p className="text-sm text-ink-2">This opportunity cannot move to {stageLabel(toStage).toLowerCase()}.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Entry requirements</p>
            <ul className="space-y-1.5">
              {requirements.map((r) => {
                const ok = satisfied(r);
                return (
                  <li key={r.key} className="flex items-start gap-2 text-sm">
                    {!r.blocking ? (
                      <Info className="mt-0.5 size-4 shrink-0 text-ink-3" />
                    ) : ok ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-positive" />
                    ) : r.fields.length ? (
                      <Circle className="mt-0.5 size-4 shrink-0 text-caution" />
                    ) : (
                      <X className="mt-0.5 size-4 shrink-0 text-negative" />
                    )}
                    <div className="min-w-0">
                      <p className={cn("text-ink", !ok && r.blocking && r.fields.length === 0 && "text-negative")}>
                        {r.label}
                        {!r.blocking && <span className="ml-1 text-xs text-ink-3">(informational)</span>}
                      </p>
                      {r.detail && <p className="text-xs text-ink-3">{r.detail}</p>}
                    </div>
                  </li>
                );
              })}
              {requirements.length === 0 && <li className="text-sm text-ink-3">No requirements for this stage.</li>}
            </ul>
          </div>

          {fields.length > 0 && (
            <div className="grid grid-cols-2 gap-3 border-t border-line pt-4">
              {fields.map((f) => (
                <StageFieldInput
                  key={f}
                  field={f}
                  value={current(f)}
                  onChange={(v) => set(f, v)}
                  types={types}
                  required={requirements.some((r) => r.blocking && r.fields.includes(f) && r.key !== "owner_contact")}
                />
              ))}
            </div>
          )}

          {willCreateFollowUp && (
            <p className="rounded-md border border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
              No dated next action is set — a follow-up task will be created for the owner.
            </p>
          )}

          {needsOverride && (
            <div className="space-y-2 rounded-md border border-negative/30 bg-negative-soft px-3 py-3">
              <p className="text-sm font-medium text-negative">
                {unmet.length} requirement{unmet.length === 1 ? "" : "s"} not met: {unmet.map((r) => r.label.toLowerCase()).join(", ")}
              </p>
              {canOverride ? (
                <Field label="Override reason" required hint="Overrides are audited with your name and this reason.">
                  <Textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                </Field>
              ) : (
                <p className="text-xs text-ink-2">Complete the requirements above. Moving without them needs pipeline approval permission.</p>
              )}
            </div>
          )}

          {serverError && <p className="text-sm text-negative">{serverError}</p>}
        </div>
      )}
    </Dialog>
  );
}
