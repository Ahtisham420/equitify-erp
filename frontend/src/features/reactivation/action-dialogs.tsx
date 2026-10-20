"use client";

import { Check, Circle, Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { ApiError, errorMessage } from "@/lib/api";

import { stageLabel, useGates, type GateErrorDetail } from "@/features/pipeline/api";
import { StageFieldInput } from "@/features/pipeline/stage-fields";

import { useItemAction, useReactivationMeta, type ReactivationItem } from "./api";

const filled = (v: unknown) => !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0));

export function ReactivateDialog({ item, onOpenChange }: { item: ReactivationItem | null; onOpenChange: (o: boolean) => void }) {
  const { data: meta } = useReactivationMeta();
  const gates = useGates(item?.opportunity_id);
  const run = useItemAction();
  const [stage, setStage] = useState("contact");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [note, setNote] = useState("");
  const [override, setOverride] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (item) {
      setStage(item.original_context.last_stage && meta?.reactivate_stages.includes(item.original_context.last_stage) ? item.original_context.last_stage : "contact");
      setValues({});
      setNote("");
      setOverride("");
      setServerError(null);
    }
  }, [item, meta]);

  const target = gates.data?.stages.find((s) => s.stage === stage);
  const reqs = useMemo(() => target?.requirements ?? [], [target]);
  const satisfied = (r: (typeof reqs)[number]) => {
    const editable = r.fields.filter((f) => f !== "property_id");
    if (!editable.length || (r.met && !editable.some((f) => f in values))) return r.met;
    return r.key === "owner_contact" ? editable.some((f) => filled(values[f])) : editable.every((f) => filled(values[f]));
  };
  const unmet = reqs.filter((r) => r.blocking && !satisfied(r));
  const fields = Array.from(new Set(reqs.filter((r) => r.blocking && !r.met).flatMap((r) => r.fields))).filter((f) => f !== "property_id");
  const canOverride = gates.data?.can_override ?? false;

  const submit = () => {
    if (!item) return;
    setServerError(null);
    run.mutate(
      { id: item.id, action: "reactivate", body: { to_stage: stage, fields: values, note: note.trim() || null, override_reason: unmet.length ? override.trim() : null } },
      {
        onSuccess: () => {
          toast.success(`Reactivated to ${stageLabel(stage)}`);
          onOpenChange(false);
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
      open={!!item}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      title="Reactivate opportunity"
      description={item ? `${item.opportunity_title ?? "Opportunity"} returns to the pipeline with its history; stage requirements apply.` : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={unmet.length ? "danger" : "primary"}
            loading={run.isPending}
            disabled={!target || (unmet.length > 0 && (!canOverride || override.trim().length < 3))}
            onClick={submit}
          >
            {unmet.length ? "Override and reactivate" : `Reactivate to ${stageLabel(stage)}`}
          </Button>
        </>
      }
    >
      {gates.isLoading || !meta ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="space-y-4">
          <Field label="Move to stage" required>
            <Select value={stage} onChange={(e) => setStage(e.target.value)} options={meta.reactivate_stages.map((s) => ({ value: s, label: stageLabel(s) }))} />
          </Field>
          <ul className="space-y-1.5">
            {reqs.map((r) => {
              const ok = satisfied(r);
              return (
                <li key={r.key} className="flex items-start gap-2 text-sm">
                  {!r.blocking ? <Info className="mt-0.5 size-4 text-ink-3" /> : ok ? <Check className="mt-0.5 size-4 text-positive" /> : <Circle className="mt-0.5 size-4 text-caution" />}
                  <div>
                    <p className="text-ink">{r.label}</p>
                    {r.detail && <p className="text-xs text-ink-3">{r.detail}</p>}
                  </div>
                </li>
              );
            })}
            {reqs.length === 0 && <li className="text-sm text-ink-3">No entry requirements for this stage.</li>}
          </ul>
          {fields.length > 0 && (
            <div className="grid grid-cols-2 gap-3 border-t border-line pt-4">
              {fields.map((f) => (
                <StageFieldInput key={f} field={f} value={values[f]} onChange={(v) => setValues((s) => ({ ...s, [f]: v }))} required />
              ))}
            </div>
          )}
          <Field label="Note" hint="Why this deal is worth another look">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </Field>
          {unmet.length > 0 && (
            <div className="space-y-2 rounded-md border border-negative/30 bg-negative-soft px-3 py-3">
              <p className="text-sm font-medium text-negative">Not met: {unmet.map((r) => r.label.toLowerCase()).join(", ")}</p>
              {canOverride ? (
                <Field label="Override reason" required hint="Overrides are audited with your name and this reason.">
                  <Textarea value={override} onChange={(e) => setOverride(e.target.value)} />
                </Field>
              ) : (
                <p className="text-xs text-ink-2">Complete the requirements above, choose another stage, or ask someone with pipeline approval.</p>
              )}
            </div>
          )}
          {serverError && <p className="text-sm text-negative">{serverError}</p>}
        </div>
      )}
    </Dialog>
  );
}

function inDays(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function SnoozeDialog({ item, onOpenChange }: { item: ReactivationItem | null; onOpenChange: (o: boolean) => void }) {
  const run = useItemAction();
  const [until, setUntil] = useState(inDays(30));
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (item) {
      setUntil(inDays(30));
      setReason("");
    }
  }, [item]);
  return (
    <Dialog
      open={!!item}
      onOpenChange={onOpenChange}
      title="Snooze"
      description="The item leaves the queue and returns on the chosen date."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!until || until <= inDays(0)}
            loading={run.isPending}
            onClick={() =>
              item &&
              run.mutate(
                { id: item.id, action: "snooze", body: { until, reason: reason.trim() || null } },
                { onSuccess: () => { toast.success("Snoozed"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Snooze
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {[7, 30, 90, 180].map((n) => (
            <Button key={n} size="sm" variant={until === inDays(n) ? "primary" : "secondary"} onClick={() => setUntil(inDays(n))}>
              {n} days
            </Button>
          ))}
        </div>
        <Field label="Until" required>
          <Input type="date" min={inDays(1)} value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
      </div>
    </Dialog>
  );
}

export function DismissDialog({ item, onOpenChange }: { item: ReactivationItem | null; onOpenChange: (o: boolean) => void }) {
  const run = useItemAction();
  const [reason, setReason] = useState("");
  const [rearm, setRearm] = useState(true);
  useEffect(() => {
    if (item) {
      setReason("");
      setRearm(true);
    }
  }, [item]);
  return (
    <Dialog
      open={!!item}
      onOpenChange={onOpenChange}
      title="Dismiss"
      description="Dismissals are counted as trigger noise so triggers can be tuned. The dead opportunity is retained."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            loading={run.isPending}
            onClick={() =>
              item &&
              run.mutate(
                { id: item.id, action: "dismiss", body: { reason: reason.trim(), rearm } },
                { onSuccess: () => { toast.success("Dismissed"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Dismiss
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Reason" required>
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Change is not material, owner still not selling" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <Checkbox checked={rearm} onChange={setRearm} label="Keep watching" />
          Keep watching — re-arm the same trigger from today
        </label>
      </div>
    </Dialog>
  );
}
