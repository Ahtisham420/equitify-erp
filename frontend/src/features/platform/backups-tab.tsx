"use client";

import { DatabaseBackup } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, ListCard, StatCard } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatNumber, formatRelative, toNumber } from "@/lib/utils";

import { useBackups, usePlatformMutation, type BackupRecord } from "./api";

function bytes(n: number | null) {
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${formatNumber(v, 1)} ${units[i]}`;
}

function minutes(target: number | null, achieved: number | null) {
  if (target === null && achieved === null) return "—";
  return `${achieved === null ? "—" : formatNumber(achieved, 1)} / ${target === null ? "—" : formatNumber(target)} min`;
}

const columns: Column<BackupRecord>[] = [
  { id: "when", header: "Performed", cell: (b) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(b.performed_at)}</span> },
  { id: "kind", header: "Type", cell: (b) => <span className="text-ink">{b.kind === "backup" ? "Backup" : "Restoration test"}</span> },
  { id: "env", header: "Environment", cell: (b) => <span className="text-ink-2">{b.environment}</span> },
  { id: "result", header: "Result", cell: (b) => <StatusBadge status={b.result === "success" ? "success" : b.result === "failed" ? "failed" : "pending"} label={b.result === "partial" ? "Partial" : undefined} /> },
  { id: "flags", header: "Protection", cell: (b) => <span className="flex gap-1">{b.encrypted ? <Badge tone="green">Encrypted</Badge> : <Badge tone="red">Unencrypted</Badge>}{b.point_in_time && <Badge tone="blue">PITR</Badge>}</span> },
  { id: "rpo", header: "RPO achieved / target", align: "right", cell: (b) => minutes(b.rpo_target_minutes, b.achieved_rpo_minutes) },
  { id: "rto", header: "RTO achieved / target", align: "right", cell: (b) => minutes(b.rto_target_minutes, b.achieved_rto_minutes) },
  {
    id: "targets",
    header: "Targets",
    cell: (b) => (b.meets_targets === null ? <span className="text-ink-3">—</span> : b.meets_targets ? <Badge tone="green" dot>Met</Badge> : <Badge tone="red" dot>Missed</Badge>),
  },
  { id: "size", header: "Size", align: "right", cell: (b) => bytes(b.size_bytes) },
  { id: "ref", header: "Reference", cell: (b) => <span className="block max-w-[200px] truncate font-mono text-2xs text-ink-3">{b.reference ?? "—"}</span> },
];

export function BackupsTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { data, isLoading } = useBackups();
  const lastBackup = data?.find((b) => b.kind === "backup" && b.result === "success");
  const lastTest = data?.find((b) => b.kind === "restore_test");
  const testAge = lastTest ? (Date.now() - new Date(lastTest.performed_at).getTime()) / 86_400_000 : null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Last successful backup" value={lastBackup ? formatRelative(lastBackup.performed_at) : "None"} tone={lastBackup ? "default" : "caution"} hint={lastBackup?.environment} />
        <StatCard
          label="Last restoration test"
          value={lastTest ? formatRelative(lastTest.performed_at) : "None"}
          tone={testAge === null || testAge > 90 ? "caution" : lastTest?.meets_targets === false ? "negative" : "positive"}
          hint="Backups must be restoration-tested at least quarterly"
        />
        <StatCard
          label="Latest test vs RPO / RTO"
          value={lastTest?.meets_targets === null || !lastTest ? "—" : lastTest.meets_targets ? "Met" : "Missed"}
          tone={lastTest?.meets_targets === false ? "negative" : "default"}
          hint={lastTest ? `RPO ${minutes(lastTest.rpo_target_minutes, lastTest.achieved_rpo_minutes)} · RTO ${minutes(lastTest.rto_target_minutes, lastTest.achieved_rto_minutes)}` : undefined}
        />
      </div>
      <ListCard>
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          dense
          empty={
            <EmptyState
              icon={<DatabaseBackup />}
              title="No backups recorded"
              description="Log encrypted backups and scheduled restoration tests with their recovery point and recovery time results."
              action={<Button variant="primary" onClick={() => onCreatingChange(true)}>Record backup</Button>}
            />
          }
        />
      </ListCard>
      <BackupSheet open={creating} onOpenChange={onCreatingChange} />
    </div>
  );
}

function BackupSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [kind, setKind] = useState<"backup" | "restore_test">("backup");
  const [environment, setEnvironment] = useState("production");
  const [result, setResult] = useState("success");
  const [reference, setReference] = useState("");
  const [encrypted, setEncrypted] = useState(true);
  const [pitr, setPitr] = useState(false);
  const [size, setSize] = useState("");
  const [rpoTarget, setRpoTarget] = useState("");
  const [rtoTarget, setRtoTarget] = useState("");
  const [rpo, setRpo] = useState("");
  const [rto, setRto] = useState("");
  const [notes, setNotes] = useState("");

  const save = usePlatformMutation(() =>
    api.post<BackupRecord>("/platform/backups", {
      kind,
      environment,
      result,
      reference: reference || null,
      encrypted,
      point_in_time: pitr,
      size_bytes: toNumber(size),
      rpo_target_minutes: toNumber(rpoTarget),
      rto_target_minutes: toNumber(rtoTarget),
      achieved_rpo_minutes: toNumber(rpo),
      achieved_rto_minutes: toNumber(rto),
      notes: notes || null,
    }),
  );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Record backup or restoration test"
      footer={
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: () => { toast.success("Recorded"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) })}
        >
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value as "backup" | "restore_test")} options={[{ value: "backup", label: "Backup" }, { value: "restore_test", label: "Restoration test" }]} />
          </Field>
          <Field label="Environment" required>
            <Select value={environment} onChange={(e) => setEnvironment(e.target.value)} options={[{ value: "production", label: "Production" }, { value: "staging", label: "Staging" }, { value: "development", label: "Development" }]} />
          </Field>
          <Field label="Result" required>
            <Select value={result} onChange={(e) => setResult(e.target.value)} options={[{ value: "success", label: "Success" }, { value: "partial", label: "Partial" }, { value: "failed", label: "Failed" }]} />
          </Field>
          <Field label="Size (bytes)">
            <Input value={size} onChange={(e) => setSize(e.target.value)} className="tabular" />
          </Field>
        </div>
        <Field label="Reference" hint="Snapshot ID, bucket path or ticket.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm text-ink"><Checkbox checked={encrypted} onChange={setEncrypted} label="Encrypted" /> Encrypted</label>
          <label className="flex items-center gap-2 text-sm text-ink"><Checkbox checked={pitr} onChange={setPitr} label="Point-in-time recovery" /> Point-in-time recovery</label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="RPO target (min)"><Input value={rpoTarget} onChange={(e) => setRpoTarget(e.target.value)} className="tabular" /></Field>
          <Field label="RTO target (min)"><Input value={rtoTarget} onChange={(e) => setRtoTarget(e.target.value)} className="tabular" /></Field>
          {kind === "restore_test" && (
            <>
              <Field label="RPO achieved (min)"><Input value={rpo} onChange={(e) => setRpo(e.target.value)} className="tabular" /></Field>
              <Field label="RTO achieved (min)"><Input value={rto} onChange={(e) => setRto(e.target.value)} className="tabular" /></Field>
            </>
          )}
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
      </div>
    </Sheet>
  );
}
