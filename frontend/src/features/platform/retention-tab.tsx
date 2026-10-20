"use client";

import { Lock, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber, titleCase } from "@/lib/utils";

import { useLegalHolds, usePlatformMutation, useRetention, type LegalHold, type RetentionPolicy } from "./api";

const ENTITY_TYPES = [
  "document", "property", "person", "organization", "interaction", "opportunity", "offer", "contract", "closing",
  "lease", "loan", "asset", "audit_event", "ai_call", "webhook_delivery", "job_run",
];

export function RetentionTab() {
  const { can } = useAuth();
  const canAdmin = can("platform", "approve");
  const retention = useRetention();
  const [showReleased, setShowReleased] = useState(false);
  const holds = useLegalHolds(!showReleased);
  const [policy, setPolicy] = useState<RetentionPolicy | "new" | null>(null);
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);

  const policyCols: Column<RetentionPolicy>[] = [
    { id: "entity", header: "Record type", cell: (r) => <span className="font-medium text-ink">{titleCase(r.entity_type)}</span> },
    { id: "days", header: "Retain", align: "right", cell: (r) => `${formatNumber(r.retain_days)} days` },
    { id: "action", header: "At end of period", cell: (r) => <span className="text-ink-2">{r.action === "archive" ? "Archive" : "Queue for review"}</span> },
    { id: "desc", header: "Notes", cell: (r) => <span className="block max-w-[320px] truncate text-xs text-ink-3">{r.description ?? "—"}</span> },
    { id: "active", header: "Status", cell: (r) => (r.is_active ? <Badge tone="green" dot>Active</Badge> : <Badge>Inactive</Badge>) },
  ];

  const holdCols: Column<LegalHold>[] = [
    { id: "scope", header: "Scope", cell: (h) => <span className="font-medium text-ink">{titleCase(h.entity_type)}{h.entity_id ? <span className="ml-1.5 font-mono text-2xs text-ink-3">{h.entity_id.slice(0, 8)}</span> : <span className="ml-1.5 text-xs text-ink-3">(all records)</span>}</span> },
    { id: "matter", header: "Matter", cell: (h) => <span className="text-ink-2">{h.matter ?? "—"}</span> },
    { id: "reason", header: "Reason", cell: (h) => <span className="block max-w-[300px] truncate text-ink-2">{h.reason}</span> },
    { id: "placed", header: "Placed", cell: (h) => <span className="whitespace-nowrap text-ink-3">{formatDate(h.placed_at)} · {h.placed_by_name ?? "—"}</span> },
    {
      id: "state",
      header: "Status",
      cell: (h) => (h.released_at ? <Badge>Released {formatDate(h.released_at)}</Badge> : <Badge tone="red" dot>On hold</Badge>),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (h) =>
        canAdmin && !h.released_at ? (
          <Button size="xs" onClick={(e) => { e.stopPropagation(); setReleasing(h); }}>
            Release
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Retention policies"
          description="How long each record type is kept before it is archived or queued for review. Records under legal hold are never purged."
          actions={canAdmin ? <Button size="sm" onClick={() => setPolicy("new")}><Plus /> Policy</Button> : undefined}
        />
        <DataTable columns={policyCols} data={retention.data} loading={retention.isLoading} dense onRowClick={canAdmin ? (r) => setPolicy(r) : undefined} empty={<EmptyState title="No retention policies" description="Records are kept indefinitely until a policy is defined." />} />
      </Card>

      <Card>
        <CardHeader
          title="Legal holds"
          description="A hold blocks purge and destruction of the covered records until it is released with a reason."
          actions={
            <>
              <label className="flex items-center gap-1.5 text-xs text-ink-2">
                <Checkbox checked={showReleased} onChange={setShowReleased} label="Include released" /> Include released
              </label>
              {canAdmin && <Button size="sm" onClick={() => setPlacing(true)}><Lock /> Place hold</Button>}
            </>
          }
        />
        <DataTable columns={holdCols} data={holds.data} loading={holds.isLoading} dense empty={<EmptyState icon={<Lock />} title="No legal holds" />} />
      </Card>

      <PolicySheet policy={policy} onClose={() => setPolicy(null)} />
      <HoldSheet open={placing} onOpenChange={setPlacing} />
      <ReleaseDialog hold={releasing} onClose={() => setReleasing(null)} />
    </div>
  );
}

function PolicySheet({ policy, onClose }: { policy: RetentionPolicy | "new" | null; onClose: () => void }) {
  const existing = policy && policy !== "new" ? policy : null;
  const [entityType, setEntityType] = useState("");
  const [days, setDays] = useState("");
  const [action, setAction] = useState<"review" | "archive">("review");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const key = policy === null ? null : existing?.id ?? "new";
  if (key !== loadedFor) {
    setLoadedFor(key);
    setEntityType(existing?.entity_type ?? "");
    setDays(existing ? String(existing.retain_days) : "");
    setAction(existing?.action ?? "review");
    setDescription(existing?.description ?? "");
    setActive(existing?.is_active ?? true);
  }

  const save = usePlatformMutation(() =>
    api.post<RetentionPolicy>("/platform/retention", { entity_type: entityType, retain_days: Number(days), action, description: description || null, is_active: active }),
  );

  return (
    <Sheet
      open={policy !== null}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? `Retention · ${titleCase(existing.entity_type)}` : "New retention policy"}
      footer={
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={!entityType || !(Number(days) > 0)}
          onClick={() => save.mutate(undefined, { onSuccess: () => { toast.success("Policy saved"); onClose(); }, onError: (e) => toast.error(errorMessage(e)) })}
        >
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Record type" required>
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} disabled={!!existing} placeholder="Select record type" options={ENTITY_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} />
        </Field>
        <Field label="Retain for (days)" required hint={Number(days) > 0 ? `About ${formatNumber(Number(days) / 365, 1)} years` : undefined}>
          <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className="tabular" />
        </Field>
        <Field label="At end of period">
          <Select value={action} onChange={(e) => setAction(e.target.value as "review" | "archive")} options={[{ value: "review", label: "Queue for review" }, { value: "archive", label: "Archive" }]} />
        </Field>
        <Field label="Notes">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <Checkbox checked={active} onChange={setActive} label="Active" /> Active
        </label>
      </div>
    </Sheet>
  );
}

function HoldSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [matter, setMatter] = useState("");
  const [reason, setReason] = useState("");
  const validId = !entityId || /^[0-9a-f-]{36}$/i.test(entityId.trim());

  const save = usePlatformMutation(() =>
    api.post<LegalHold>("/platform/legal-holds", { entity_type: entityType, entity_id: entityId.trim() || null, matter: matter || null, reason }),
  );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Place legal hold"
      footer={
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={!entityType || reason.trim().length < 3 || !validId}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: () => {
                toast.success("Legal hold placed");
                setEntityId("");
                setMatter("");
                setReason("");
                onOpenChange(false);
              },
              onError: (e) => toast.error(errorMessage(e)),
            })
          }
        >
          Place hold
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Record type" required>
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="Select record type" options={ENTITY_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} />
        </Field>
        <Field label="Record ID" hint="Leave blank to hold every record of this type." error={validId ? null : "Enter a valid record ID"}>
          <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} className="font-mono text-xs" placeholder="00000000-0000-0000-0000-000000000000" />
        </Field>
        <Field label="Matter">
          <Input value={matter} onChange={(e) => setMatter(e.target.value)} placeholder="Litigation or investigation reference" />
        </Field>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </Field>
      </div>
    </Sheet>
  );
}

function ReleaseDialog({ hold, onClose }: { hold: LegalHold | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const release = usePlatformMutation((vars: { id: string; reason: string }) => api.post<LegalHold>(`/platform/legal-holds/${vars.id}/release`, { reason: vars.reason }));
  return (
    <Dialog
      open={!!hold}
      onOpenChange={(o) => !o && onClose()}
      title="Release legal hold"
      description="Releasing allows normal retention to apply again. The release is audited."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            loading={release.isPending}
            onClick={() =>
              hold &&
              release.mutate(
                { id: hold.id, reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast.success("Hold released");
                    setReason("");
                    onClose();
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Release
          </Button>
        </>
      }
    >
      <Field label="Reason" required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
      </Field>
    </Dialog>
  );
}
