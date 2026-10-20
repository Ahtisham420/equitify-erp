"use client";

import { AlertTriangle, GitBranch, Lock, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";

import { OUTPUT_LABELS, TEMPLATE_LABELS, formatOutput, useNewVersion, useRecalculate, useSaveAssumptions, useUwModel, type Assumptions, type UwModel } from "@/features/underwriting/api";
import { AssumptionsEditor } from "@/features/underwriting/assumptions-editor";
import { CashFlowTab, PropertyLink, ReturnsTab, ScenariosTab, SensitivityTab, SimulationTab, VersionsTab } from "@/features/underwriting/workspace-tabs";

const HEADLINE = ["purchase_price", "noi_year1", "going_in_cap", "irr", "equity_multiple", "dscr"];
const LAND_HEADLINE = ["purchase_price", "exit_value", "profit", "irr", "equity_multiple", "peak_equity"];

function Workspace({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: model, isLoading, error } = useUwModel(id);
  const save = useSaveAssumptions(id);
  const recalc = useRecalculate(id);
  const newVersion = useNewVersion(id);
  const [draft, setDraft] = useState<Assumptions | null>(null);
  const [note, setNote] = useState("");
  const [confirmVersion, setConfirmVersion] = useState(false);
  const tab = url.get("tab") ?? "assumptions";

  useEffect(() => {
    if (model) setDraft(structuredClone(model.assumptions));
  }, [model]);

  const dirty = useMemo(() => !!model && !!draft && JSON.stringify(draft) !== JSON.stringify(model.assumptions), [draft, model]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !model) {
    return <EmptyState title="Model not found" description={errorMessage(error)} action={<Link href="/underwriting"><Button>Back to underwriting</Button></Link>} />;
  }

  const canEdit = can("underwriting", "edit");
  const editsCreateVersion = model.status !== "draft";
  const goTo = (m: UwModel) => {
    if (m.id !== id) router.push(`/underwriting/${m.id}${tab !== "assumptions" ? `?tab=${tab}` : ""}`);
  };

  const persist = () => {
    if (!draft) return;
    save.mutate(
      { assumptions: draft, change_note: note.trim() || null },
      {
        onSuccess: (m) => {
          toast.success(m.id !== id ? `Saved as new version ${m.version}` : "Assumptions saved and recalculated");
          setNote("");
          setConfirmVersion(false);
          goTo(m);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const headline = model.assumptions.model_type === "land" ? LAND_HEADLINE : HEADLINE;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Underwriting", href: "/underwriting" }, { label: model.name }]}
        title={model.name}
        meta={
          <>
            <Badge tone="outline">{TEMPLATE_LABELS[model.template] ?? model.template}</Badge>
            <span className="text-xs text-ink-3">Version {model.version}{!model.is_latest && " (not latest)"}</span>
            <StatusBadge status={model.status} />
            {model.is_locked && (
              <Badge tone="green">
                <Lock className="size-3" /> Locked
              </Badge>
            )}
            <PropertyLink model={model} />
            {model.opportunity_id && (
              <Link href={`/pipeline/${model.opportunity_id}`} className="text-xs text-accent hover:underline">
                {model.opportunity_label ?? "Opportunity"}
              </Link>
            )}
            {model.calculated_at && <span className="text-xs text-ink-3">Calculated {formatDateTime(model.calculated_at)}</span>}
          </>
        }
        actions={
          canEdit && (
            <>
              {model.status === "draft" && (
                <Button loading={recalc.isPending} onClick={() => recalc.mutate(undefined, { onSuccess: () => toast.success("Recalculated"), onError: (e) => toast.error(errorMessage(e)) })}>
                  <RefreshCw /> Recalculate
                </Button>
              )}
              <Button
                loading={newVersion.isPending}
                onClick={() => newVersion.mutate({ change_note: `Copied from v${model.version}` }, { onSuccess: (m) => { toast.success(`Version ${m.version} created`); goTo(m); }, onError: (e) => toast.error(errorMessage(e)) })}
              >
                <GitBranch /> New version
              </Button>
            </>
          )
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {headline.map((k) => (
          <StatCard key={k} label={OUTPUT_LABELS[k] ?? k} value={formatOutput(k, model.outputs[k])} />
        ))}
      </div>

      {model.unsourced.length > 0 && (
        <button
          onClick={() => url.set({ tab: "versions" })}
          className="mb-4 flex w-full items-center gap-2 rounded-lg border border-caution/30 bg-caution-soft px-4 py-2.5 text-left text-sm text-ink-2"
        >
          <AlertTriangle className="size-4 text-caution" />
          {model.unsourced.length} material assumptions are unsourced. Use the source chips to attach evidence.
        </button>
      )}

      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "assumptions" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "assumptions", label: "Assumptions" },
            { value: "cashflow", label: "Cash flow" },
            { value: "returns", label: "Returns" },
            { value: "scenarios", label: "Scenarios", count: model.scenarios.length },
            { value: "sensitivity", label: "Sensitivity" },
            { value: "simulation", label: "Simulation" },
            { value: "versions", label: "Versions & approval" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="assumptions">
          {model.is_locked && (
            <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-3">
              <Lock className="size-3.5" /> This version is approved and locked. Saving changes creates a new draft version.
            </p>
          )}
          {draft && <AssumptionsEditor value={draft} onChange={setDraft} readOnly={!canEdit} />}
          {canEdit && (
            <div className="sticky bottom-4 z-20 mt-4 flex items-center justify-end gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 shadow-pop backdrop-blur">
              <span className="mr-auto text-xs text-ink-3">{dirty ? "Unsaved changes" : "All changes saved"}</span>
              <Input className="w-72" placeholder="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button disabled={!dirty} onClick={() => setDraft(structuredClone(model.assumptions))}>
                Discard
              </Button>
              <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => (editsCreateVersion ? setConfirmVersion(true) : persist())}>
                <Save /> {editsCreateVersion ? "Save as new version" : "Save and recalculate"}
              </Button>
            </div>
          )}
        </TabPanel>
        <TabPanel value="cashflow">
          <CashFlowTab model={model} />
        </TabPanel>
        <TabPanel value="returns">
          <ReturnsTab model={model} />
        </TabPanel>
        <TabPanel value="scenarios">
          <ScenariosTab model={model} readOnly={!canEdit} onSaved={goTo} />
        </TabPanel>
        <TabPanel value="sensitivity">
          <SensitivityTab model={model} />
        </TabPanel>
        <TabPanel value="simulation">
          <SimulationTab model={model} />
        </TabPanel>
        <TabPanel value="versions">
          <VersionsTab model={model} onNavigate={(vid) => vid !== id && router.push(`/underwriting/${vid}?tab=versions`)} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="uw_model" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <Dialog
        open={confirmVersion}
        onOpenChange={setConfirmVersion}
        title="Save as a new version?"
        description={`Version ${model.version} is ${model.status}${model.is_locked ? " and locked" : ""}. Your changes will be saved as a new draft version; version ${model.version} stays unchanged.`}
        footer={
          <>
            <Button onClick={() => setConfirmVersion(false)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={persist}>
              Create new version
            </Button>
          </>
        }
      >
        <Field label="Change note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" />
        </Field>
      </Dialog>
    </>
  );
}

export default function UnderwritingModelPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <Workspace id={params.id} />
    </Suspense>
  );
}
