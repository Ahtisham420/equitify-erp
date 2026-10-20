"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EntityPicker, UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, titleCase } from "@/lib/utils";

import { bulkPath, type BulkAction, type BulkResult } from "@/features/map/api";

const TITLES: Record<BulkAction, string> = {
  opportunities: "Create opportunities",
  territory: "Assign to territory",
  sequence: "Enroll owners in a sequence",
  export: "Export mailing list",
};

const ELIGIBLE_LABEL: Record<BulkAction, string> = {
  opportunities: "Opportunities to create",
  territory: "Properties to add",
  sequence: "People to enroll",
  export: "Mailing rows",
};

const DONE_LABEL: Record<BulkAction, string> = {
  opportunities: "created",
  territory: "added",
  sequence: "enrolled",
  export: "exported",
};

interface TerritoryLite { id: string; name: string; rule_type: string }
interface SequenceLite { id: string; name: string; status: string }

function downloadCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "caution" | "positive" }) {
  return (
    <div className="rounded-lg border border-line bg-subtle/60 px-3 py-2">
      <p className="text-xs text-ink-3">{label}</p>
      <p className={tone === "caution" ? "text-lg font-semibold text-caution tabular" : tone === "positive" ? "text-lg font-semibold text-positive tabular" : "text-lg font-semibold text-ink tabular"}>
        {formatNumber(value)}
      </p>
    </div>
  );
}

/**
 * Every map bulk action is previewed first (counts, skips with reasons, compliance/permission warnings) and only
 * applied on an explicit confirmation. The server re-checks permissions and eligibility on apply.
 */
export function BulkActionDialog({
  action,
  onClose,
  propertyIds,
  parcelIds,
}: {
  action: BulkAction | null;
  onClose: () => void;
  propertyIds: string[];
  parcelIds: string[];
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [territoryId, setTerritoryId] = useState<string | null>(null);
  const [sequenceId, setSequenceId] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [priority, setPriority] = useState("normal");
  const [override, setOverride] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);

  useEffect(() => {
    if (action) {
      setResult(null);
      setOverride("");
    }
  }, [action]);

  const body = (() => {
    const base = { property_ids: propertyIds, parcel_ids: parcelIds };
    switch (action) {
      case "opportunities":
        return { ...base, owner_id: ownerId, priority, source: "map", override_reason: override.trim() || null };
      case "territory":
        return territoryId ? { ...base, territory_id: territoryId } : null;
      case "sequence":
        return sequenceId ? { ...base, sequence_id: sequenceId, owner_id: ownerId } : null;
      case "export":
        return base;
      default:
        return null;
    }
  })();

  const preview = useQuery({
    queryKey: ["map", "bulk-preview", action, body],
    queryFn: () => api.post<BulkResult>(bulkPath(action!), { ...body, apply: false }),
    enabled: !!action && !!body && !result,
    retry: false,
  });

  const apply = useMutation({
    mutationFn: () => api.post<BulkResult>(bulkPath(action!), { ...body, apply: true }),
    onSuccess: (r) => {
      setResult(r);
      if (action === "export" && r.csv) downloadCsv(r.csv, r.filename || "mailing.csv");
      toast.success(`${formatNumber(r.done)} ${DONE_LABEL[action!]}${r.skipped.length ? `, ${formatNumber(r.skipped.length)} skipped` : ""}`);
      qc.invalidateQueries({ queryKey: ["map"] });
      if (action === "opportunities") qc.invalidateQueries({ queryKey: ["opportunities"] });
      if (action === "territory") qc.invalidateQueries({ queryKey: ["territories"] });
      if (action === "sequence") qc.invalidateQueries({ queryKey: ["sequences"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const shown = result ?? preview.data;
  const ready = !!body;
  const canApply = !!shown && !result && !shown.blocked && shown.eligible > 0;

  return (
    <Dialog
      open={!!action}
      onOpenChange={(o) => !o && onClose()}
      title={action ? TITLES[action] : ""}
      description={result ? "Done. Review anything that was skipped." : "Review the preview before applying. Nothing changes until you confirm."}
      className="max-w-xl"
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!canApply} loading={apply.isPending} onClick={() => apply.mutate()}>
              {action === "export" ? "Download CSV" : `Apply to ${formatNumber(shown?.eligible ?? 0)}`}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {!result && action === "opportunities" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Owner" hint="Defaults to you">
              <UserPicker value={ownerId} onChange={setOwnerId} placeholder="Me" />
            </Field>
            <Field label="Priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value)} options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: titleCase(p) }))} />
            </Field>
            {can("pipeline", "approve") && (
              <Field label="Gate override reason" hint="Only when sourced-stage requirements are not met" className="sm:col-span-2">
                <Textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        {!result && action === "territory" && (
          <Field label="Territory" required>
            <EntityPicker<TerritoryLite>
              endpoint="/territories"
              value={territoryId}
              onChange={(id) => setTerritoryId(id)}
              placeholder="Choose a territory"
              toOption={(t) => ({ id: t.id, label: t.name, sublabel: titleCase(t.rule_type) })}
            />
          </Field>
        )}
        {!result && action === "sequence" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sequence" required>
              <EntityPicker<SequenceLite>
                endpoint="/sequences"
                list
                value={sequenceId}
                onChange={(id) => setSequenceId(id)}
                placeholder="Choose a sequence"
                toOption={(s) => ({ id: s.id, label: s.name, sublabel: titleCase(s.status) })}
              />
            </Field>
            <Field label="Enrollment owner" hint="Defaults to you">
              <UserPicker value={ownerId} onChange={setOwnerId} placeholder="Me" />
            </Field>
          </div>
        )}

        {!ready && <p className="text-sm text-ink-3">Choose the options above to see a preview.</p>}
        {ready && preview.isLoading && !result && (
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        )}
        {preview.isError && !result && <p className="text-sm text-negative">{errorMessage(preview.error)}</p>}

        {shown && action && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Properties in selection" value={shown.properties} />
              {result ? (
                <Stat label={titleCase(DONE_LABEL[action])} value={shown.done} tone="positive" />
              ) : (
                <Stat label={ELIGIBLE_LABEL[action]} value={shown.eligible} />
              )}
              <Stat label="Skipped" value={shown.skipped.length} tone={shown.skipped.length ? "caution" : undefined} />
            </div>
            {typeof shown.details.territory_name === "string" && (
              <p className="text-sm text-ink-2">Territory: <span className="font-medium text-ink">{shown.details.territory_name}</span></p>
            )}
            {typeof shown.details.sequence_name === "string" && (
              <p className="text-sm text-ink-2">
                Sequence: <span className="font-medium text-ink">{shown.details.sequence_name}</span>
                {typeof shown.details.people === "number" && <> · {formatNumber(shown.details.people)} owner contacts found</>}
              </p>
            )}
            {shown.blocked && (
              <div className="flex gap-2 rounded-lg border border-negative/30 bg-negative-soft px-3 py-2 text-sm text-negative">
                <Ban className="mt-0.5 size-4 shrink-0" />
                <span>This action is blocked. {shown.warnings[0] ?? ""}</span>
              </div>
            )}
            {shown.warnings.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-caution/30 bg-caution-soft px-3 py-2 text-sm text-caution">
                {shown.warnings.map((w, i) => (
                  <li key={i} className="flex gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
            {shown.skipped.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-2">Skipped</p>
                <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line scrollbar-thin">
                  {shown.skipped.slice(0, 100).map((s, i) => (
                    <li key={`${s.id}-${i}`} className="flex items-start justify-between gap-3 px-3 py-1.5 text-sm">
                      <span className="truncate text-ink">{s.label ?? s.id}</span>
                      <span className="shrink-0 text-right text-xs text-ink-3">{s.reason}</span>
                    </li>
                  ))}
                </ul>
                {shown.skipped.length > 100 && <p className="mt-1 text-xs text-ink-3">And {formatNumber(shown.skipped.length - 100)} more</p>}
              </div>
            )}
            {action === "export" && shown.masked && !result && (
              <p className="text-xs text-ink-3">Street addresses will be restricted in the file for your role.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
