"use client";

import { CheckCircle2, FlaskConical, Plus, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDateTime, titleCase } from "@/lib/utils";

import { COMPONENT_KEYS, COMPONENT_LABELS, useConfigAction, useOutcomeSummary, useRecalibrate, useSaveConfig, useScoreConfigs, type ConfigInput, type ScoreConfig } from "./api";

const STATUS_TONES: Record<string, Tone> = { active: "green", proposed: "blue", draft: "neutral", retired: "outline", rejected: "red" };

function toInput(c: ScoreConfig | undefined, name?: string): ConfigInput {
  return {
    name: name ?? c?.name ?? "New weights",
    weights: { ...(c?.weights ?? {}) },
    band_thresholds: { high: c?.band_thresholds?.high ?? 0.75, medium: c?.band_thresholds?.medium ?? 0.5 },
    alert_threshold: c?.alert_threshold ?? 75,
    high_dollar_threshold: c?.high_dollar_threshold ?? 5_000_000,
    notes: c?.notes ?? null,
  };
}

function WeightEditor({ value, onChange, disabled, compare }: { value: ConfigInput; onChange: (v: ConfigInput) => void; disabled?: boolean; compare?: Record<string, number> }) {
  const valueKeys = COMPONENT_KEYS.filter((k) => k !== "negative_risk");
  const sum = valueKeys.reduce((a, k) => a + (value.weights[k] ?? 0), 0);
  const setW = (k: string, v: number) => onChange({ ...value, weights: { ...value.weights, [k]: Math.max(0, Math.min(1, v)) } });
  return (
    <div className="space-y-2">
      {COMPONENT_KEYS.map((k) => {
        const w = value.weights[k] ?? 0;
        const share = k === "negative_risk" ? null : sum > 0 ? Math.round((w / sum) * 100) : 0;
        const prev = compare?.[k];
        return (
          <div key={k} className="flex items-center gap-3">
            <span className="w-48 shrink-0 text-sm text-ink">{COMPONENT_LABELS[k]}</span>
            <input
              type="range"
              min={0}
              max={k === "negative_risk" ? 0.5 : 1}
              step={0.01}
              value={w}
              disabled={disabled}
              onChange={(e) => setW(k, Number(e.target.value))}
              className={cn("flex-1", k === "negative_risk" ? "accent-negative" : "accent-ink")}
              aria-label={`${COMPONENT_LABELS[k]} weight`}
            />
            <Input type="number" min={0} max={1} step={0.01} value={w} disabled={disabled} onChange={(e) => setW(k, Number(e.target.value))} className="w-20 text-right" />
            <span className="w-24 text-right text-xs text-ink-3 tabular">
              {share !== null ? `${share}% of value` : "penalty / pt"}
            </span>
            {compare && (
              <span className={cn("w-16 text-right text-xs tabular", prev === undefined ? "text-ink-3" : w > prev ? "text-positive" : w < prev ? "text-negative" : "text-ink-3")}>
                {prev === undefined ? "" : `was ${prev}`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RecalibrationBasis({ config }: { config: ScoreConfig }) {
  const comps = config.basis.components;
  if (!comps) return null;
  return (
    <div className="rounded-lg border border-line">
      <div className="border-b border-line px-3 py-2 text-xs text-ink-2">
        Based on {config.basis.samples} decided outcomes ({config.basis.won} won, {config.basis.lost} lost). Each weight moves by how well its component
        separated won from lost deals (capped at ±50%); value weights are renormalised to the previous total.
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th className="px-3 py-1.5 font-medium">Component</th>
            <th className="px-3 py-1.5 text-right font-medium">Won avg</th>
            <th className="px-3 py-1.5 text-right font-medium">Lost avg</th>
            <th className="px-3 py-1.5 text-right font-medium">Separation</th>
            <th className="px-3 py-1.5 text-right font-medium">Weight</th>
          </tr>
        </thead>
        <tbody>
          {COMPONENT_KEYS.map((k) => {
            const c = comps[k];
            if (!c) return null;
            return (
              <tr key={k} className="border-t border-line">
                <td className="px-3 py-1.5 text-ink">{COMPONENT_LABELS[k]}</td>
                <td className="px-3 py-1.5 text-right tabular">{c.won_mean}</td>
                <td className="px-3 py-1.5 text-right tabular">{c.lost_mean}</td>
                <td className={cn("px-3 py-1.5 text-right tabular", c.separation > 0 ? "text-positive" : c.separation < 0 ? "text-negative" : "text-ink-3")}>
                  {c.separation > 0 ? "+" : ""}
                  {c.separation}
                </td>
                <td className="px-3 py-1.5 text-right tabular">
                  {c.old_weight} → <span className="font-medium text-ink">{c.new_weight}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ConfigsTab() {
  const { can } = useAuth();
  const { data: configs, isLoading } = useScoreConfigs();
  const { data: summary } = useOutcomeSummary();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConfigInput | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newDraft, setNewDraft] = useState<ConfigInput | null>(null);
  const [activating, setActivating] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const action = useConfigAction();
  const recalibrate = useRecalibrate();

  const active = configs?.find((c) => c.status === "active");
  const selected = useMemo(() => configs?.find((c) => c.id === selectedId) ?? configs?.find((c) => c.status === "proposed") ?? active, [configs, selectedId, active]);
  const editable = !!selected && ["draft", "proposed"].includes(selected.status) && can("scoring", "edit");
  const save = useSaveConfig(selected?.id);
  const create = useSaveConfig(null);

  useEffect(() => {
    setDraft(selected ? toInput(selected) : null);
  }, [selected]);

  if (isLoading || !configs) return <Skeleton className="h-64 w-full" />;
  const dirty = !!selected && !!draft && JSON.stringify(toInput(selected)) !== JSON.stringify(draft);

  const proposeRecal = () =>
    recalibrate.mutate(undefined, {
      onSuccess: (c) => {
        toast.success(`Recalibration proposed as v${c.version}`);
        setSelectedId(c.id);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Versions"
            description="Prior configurations are retained."
            actions={
              can("scoring", "edit") ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setNewDraft(toInput(active, `Draft from v${active?.version ?? 1}`));
                    setNewOpen(true);
                  }}
                >
                  <Plus /> New draft
                </Button>
              ) : undefined
            }
          />
          <ul className="divide-y divide-line">
            {configs.map((c) => (
              <li key={c.id}>
                <button onClick={() => setSelectedId(c.id)} className={cn("flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-subtle/60", selected?.id === c.id && "bg-accent-soft/50")}>
                  <span className="w-8 text-sm font-semibold text-ink tabular">v{c.version}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{c.name}</span>
                    <span className="block text-xs text-ink-3">{titleCase(c.source)} · {formatDateTime(c.activated_at ?? c.created_at)}</span>
                  </span>
                  <Badge tone={STATUS_TONES[c.status] ?? "neutral"}>{titleCase(c.status)}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Recalibration" description="Proposes new weights from real outcomes. Activation needs approval." />
          <CardBody className="space-y-2 text-sm">
            {summary ? (
              <>
                <p className="text-ink-2">
                  {summary.won} won · {summary.lost} lost · {summary.open} open
                </p>
                <p className="text-xs text-ink-3">
                  Avg score at decision: won {summary.avg_score_won ?? "—"} · lost {summary.avg_score_lost ?? "—"}
                </p>
                {!summary.recalibration_ready && (
                  <p className="text-xs text-ink-3">
                    Needs {summary.min_required.total} decided outcomes with at least {summary.min_required.won} won and {summary.min_required.lost} lost.
                  </p>
                )}
              </>
            ) : (
              <Skeleton className="h-10 w-full" />
            )}
            {can("scoring", "edit") && (
              <Button className="w-full" disabled={!summary?.recalibration_ready} loading={recalibrate.isPending} onClick={proposeRecal}>
                <FlaskConical /> Propose recalibration
              </Button>
            )}
          </CardBody>
        </Card>
      </div>

      {selected && draft && (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                v{selected.version} · {selected.name}
                <Badge tone={STATUS_TONES[selected.status] ?? "neutral"}>{titleCase(selected.status)}</Badge>
              </span>
            }
            description={
              selected.status === "active"
                ? `Active since ${formatDateTime(selected.activated_at)}. Active and retired versions are read-only; create a draft to change weights.`
                : selected.status === "retired"
                  ? `Retired ${formatDateTime(selected.retired_at)}`
                  : selected.status === "rejected"
                    ? `Rejected: ${selected.rejected_reason ?? ""}`
                    : selected.based_on_version
                      ? `Based on v${selected.based_on_version}`
                      : "Draft"
            }
            actions={
              <>
                {editable && (
                  <Button
                    size="sm"
                    disabled={!dirty}
                    loading={save.isPending}
                    onClick={() => save.mutate(draft, { onSuccess: () => toast.success("Configuration saved"), onError: (e) => toast.error(errorMessage(e)) })}
                  >
                    Save
                  </Button>
                )}
                {["draft", "proposed"].includes(selected.status) && can("scoring", "approve") && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}>
                      <XCircle /> Reject
                    </Button>
                    <Button size="sm" variant="primary" disabled={dirty} onClick={() => setActivating(true)}>
                      <CheckCircle2 /> Approve and activate
                    </Button>
                  </>
                )}
              </>
            }
          />
          <CardBody className="space-y-5">
            {selected.source === "recalibration" && <RecalibrationBasis config={selected} />}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Component weights</p>
              <WeightEditor value={draft} onChange={setDraft} disabled={!editable} compare={selected.status !== "active" ? active?.weights : undefined} />
            </div>
            <fieldset disabled={!editable} className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="High band ≥" hint="Confidence">
                <Input type="number" min={0} max={1} step={0.05} value={draft.band_thresholds.high} onChange={(e) => setDraft({ ...draft, band_thresholds: { ...draft.band_thresholds, high: Number(e.target.value) } })} />
              </Field>
              <Field label="Medium band ≥" hint="Confidence">
                <Input type="number" min={0} max={1} step={0.05} value={draft.band_thresholds.medium} onChange={(e) => setDraft({ ...draft, band_thresholds: { ...draft.band_thresholds, medium: Number(e.target.value) } })} />
              </Field>
              <Field label="Alert threshold" hint="Score crossing alerts">
                <Input type="number" min={0} max={100} value={draft.alert_threshold} onChange={(e) => setDraft({ ...draft, alert_threshold: Number(e.target.value) })} />
              </Field>
              <Field label="High-dollar threshold" hint={formatCurrency(draft.high_dollar_threshold, { compact: true })}>
                <Input type="number" min={0} step={100000} value={draft.high_dollar_threshold} onChange={(e) => setDraft({ ...draft, high_dollar_threshold: Number(e.target.value) })} />
              </Field>
              <Field label="Name" className="col-span-2">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Notes" className="col-span-2">
                <Textarea rows={2} value={draft.notes ?? ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })} />
              </Field>
            </fieldset>
            <p className="text-xs text-ink-3">
              Score = weighted average of value components − risk × penalty weight. Confidence is never added to the score; it sets the band. At or above the
              high-dollar threshold (or with unknown value), automation cannot act on a score without human approval.
            </p>
          </CardBody>
        </Card>
      )}

      <Dialog
        open={newOpen}
        onOpenChange={setNewOpen}
        className="max-w-2xl"
        title="New draft configuration"
        description="Drafts do not affect scores until approved and activated."
        footer={
          <>
            <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!newDraft?.name.trim()}
              onClick={() =>
                newDraft &&
                create.mutate(newDraft, {
                  onSuccess: (c) => {
                    toast.success(`Draft v${c.version} created`);
                    setNewOpen(false);
                    setSelectedId(c.id);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              Create draft
            </Button>
          </>
        }
      >
        {newDraft && (
          <div className="space-y-4">
            <Field label="Name" required>
              <Input value={newDraft.name} onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })} />
            </Field>
            <WeightEditor value={newDraft} onChange={setNewDraft} compare={active?.weights} />
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={activating}
        onOpenChange={setActivating}
        title={`Activate v${selected?.version}`}
        description="The current active configuration is retired (kept for history) and every eligible property is rescored with these weights."
        confirmLabel="Approve and activate"
        loading={action.isPending}
        onConfirm={() =>
          selected &&
          action.mutate(
            { id: selected.id, action: "activate" },
            {
              onSuccess: () => {
                toast.success(`v${selected.version} is now active`);
                setActivating(false);
              },
              onError: (e) => toast.error(errorMessage(e)),
            },
          )
        }
      />

      <Dialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={`Reject v${selected?.version}`}
        footer={
          <>
            <Button onClick={() => setRejecting(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={rejectReason.trim().length < 3}
              loading={action.isPending}
              onClick={() =>
                selected &&
                action.mutate(
                  { id: selected.id, action: "reject", reason: rejectReason.trim() },
                  {
                    onSuccess: () => {
                      toast.success("Configuration rejected");
                      setRejecting(false);
                      setRejectReason("");
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              Reject
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea autoFocus value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
