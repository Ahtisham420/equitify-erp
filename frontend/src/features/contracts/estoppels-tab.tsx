"use client";

import { AlertTriangle, CheckCircle2, FileSignature, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, titleCase, toNumber } from "@/lib/utils";

import {
  ESTOPPEL_KINDS,
  ESTOPPEL_STATUS_TONES,
  ESTOPPEL_STATUSES,
  useDeleteEstoppel,
  useEstoppels,
  useResolveEstoppel,
  useSaveEstoppel,
  type Contract,
  type Estoppel,
} from "./api";
import { EntityPickerDocument } from "./reports-tab";

function flagged(e: Estoppel, field: string) {
  return e.discrepancies.some((d) => d.field === field);
}

function Compare({ e, field, expected, reported }: { e: Estoppel; field: string; expected: string; reported: string }) {
  const bad = flagged(e, field);
  return (
    <div className="whitespace-nowrap text-xs tabular">
      <p className="text-ink-2">{expected}</p>
      <p className={cn(bad ? "font-medium text-negative" : "text-ink-3")}>
        {reported}
        {bad && <AlertTriangle className="ml-1 inline size-3" />}
      </p>
    </div>
  );
}

const columns: Column<Estoppel>[] = [
  {
    id: "tenant",
    header: "Tenant",
    cell: (e) => (
      <div className="min-w-[160px]">
        <p className="font-medium text-ink">{e.tenant_name}</p>
        <p className="text-xs text-ink-3">{e.kind.toUpperCase()}</p>
      </div>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (e) => (
      <Badge tone={ESTOPPEL_STATUS_TONES[e.status] ?? "neutral"} dot>
        {titleCase(e.status)}
      </Badge>
    ),
  },
  {
    id: "dates",
    header: "Requested / received",
    cell: (e) => (
      <div className="whitespace-nowrap text-xs tabular">
        <p className="text-ink-2">{formatDate(e.requested_on)}</p>
        <p className="text-ink-3">{formatDate(e.received_on)}</p>
      </div>
    ),
  },
  {
    id: "rent",
    header: (
      <Tooltip content="Lease / rent roll above, tenant-reported below">
        <span>Monthly rent</span>
      </Tooltip>
    ),
    cell: (e) => <Compare e={e} field="monthly_rent" expected={formatCurrency(e.expected_monthly_rent)} reported={formatCurrency(e.reported_monthly_rent)} />,
  },
  {
    id: "expiration",
    header: "Expiration",
    cell: (e) => <Compare e={e} field="expiration_on" expected={formatDate(e.expected_expiration_on)} reported={formatDate(e.reported_expiration_on)} />,
  },
  {
    id: "deposit",
    header: "Deposit",
    cell: (e) => <Compare e={e} field="security_deposit" expected={formatCurrency(e.expected_security_deposit)} reported={formatCurrency(e.reported_security_deposit)} />,
  },
  {
    id: "flag",
    header: "Discrepancy",
    cell: (e) =>
      e.has_discrepancy ? (
        e.discrepancy_resolved_at ? (
          <Tooltip content={e.discrepancy_resolution}>
            <Badge tone="green">
              <CheckCircle2 className="size-3" /> Resolved
            </Badge>
          </Tooltip>
        ) : (
          <Tooltip content={e.discrepancies.map((d) => d.label).join(", ")}>
            <Badge tone="red">
              <AlertTriangle className="size-3" /> {e.discrepancies.length} mismatch{e.discrepancies.length === 1 ? "" : "es"}
            </Badge>
          </Tooltip>
        )
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
];

const NUM_FIELDS = ["expected_monthly_rent", "expected_security_deposit", "reported_monthly_rent", "reported_security_deposit"];

function EstoppelSheet({ open, onOpenChange, contractId, item }: { open: boolean; onOpenChange: (o: boolean) => void; contractId: string; item: Estoppel | null }) {
  const save = useSaveEstoppel(contractId);
  const remove = useDeleteEstoppel();
  const [v, setV] = useState<Record<string, unknown>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setV(item ? { ...item } : { kind: "estoppel", status: "requested", tenant_name: "" });
  }, [open, item]);

  const set = (k: string, value: unknown) => setV((s) => ({ ...s, [k]: value }));
  const str = (k: string) => (v[k] === null || v[k] === undefined ? "" : String(v[k]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = {
      kind: v.kind, tenant_name: str("tenant_name").trim(), status: v.status, lease_id: v.lease_id ?? null,
      requested_on: v.requested_on || null, due_on: v.due_on || null, received_on: v.received_on || null,
      expected_expiration_on: v.expected_expiration_on || null, reported_expiration_on: v.reported_expiration_on || null,
      reported_landlord_default: v.reported_landlord_default ?? null, reported_notes: str("reported_notes").trim() || null,
      document_id: v.document_id ?? null, notes: str("notes").trim() || null,
    };
    for (const f of NUM_FIELDS) data[f] = toNumber(str(f));
    save.mutate(
      { id: item?.id, data },
      {
        onSuccess: (r) => {
          toast[r.has_discrepancy && !r.discrepancy_resolved_at ? "warning" : "success"](
            r.has_discrepancy && !r.discrepancy_resolved_at ? "Saved — tenant-reported values do not match the lease" : "Saved",
          );
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const pair = (label: string, expKey: string, repKey: string, type: "money" | "date") => (
    <div className="col-span-2 grid grid-cols-[140px_1fr_1fr] items-center gap-2">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      <Input type={type === "date" ? "date" : "text"} inputMode={type === "money" ? "decimal" : undefined} value={str(expKey)} onChange={(e) => set(expKey, e.target.value)} aria-label={`${label} expected`} />
      <Input type={type === "date" ? "date" : "text"} inputMode={type === "money" ? "decimal" : undefined} value={str(repKey)} onChange={(e) => set(repKey, e.target.value)} aria-label={`${label} reported`} />
    </div>
  );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={item ? `${item.kind.toUpperCase()} · ${item.tenant_name}` : "New estoppel / SNDA"}
      description="Both the lease or rent-roll values and the tenant-reported values are kept; mismatches are flagged."
      footer={
        <>
          {item && (
            <Button variant="ghost" className="mr-auto text-negative" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Remove
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="estoppel-form" loading={save.isPending} disabled={!str("tenant_name").trim()}>
            Save
          </Button>
        </>
      }
    >
      <form id="estoppel-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Tenant" required className="col-span-2">
          <Input value={str("tenant_name")} onChange={(e) => set("tenant_name", e.target.value)} />
        </Field>
        <Field label="Kind">
          <Select value={str("kind")} onChange={(e) => set("kind", e.target.value)} options={ESTOPPEL_KINDS.map((k) => ({ value: k, label: k.toUpperCase() }))} />
        </Field>
        <Field label="Status">
          <Select value={str("status")} onChange={(e) => set("status", e.target.value)} options={ESTOPPEL_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
        <Field label="Requested">
          <Input type="date" value={str("requested_on")} onChange={(e) => set("requested_on", e.target.value)} />
        </Field>
        <Field label="Due">
          <Input type="date" value={str("due_on")} onChange={(e) => set("due_on", e.target.value)} />
        </Field>
        <Field label="Received">
          <Input type="date" value={str("received_on")} onChange={(e) => set("received_on", e.target.value)} />
        </Field>
        <Field label="Lease record ID" hint="Prefills expected values from the lease when linked">
          <Input value={str("lease_id")} onChange={(e) => set("lease_id", e.target.value.trim() || null)} placeholder="Optional" />
        </Field>

        <div className="col-span-2 mt-2 grid grid-cols-[140px_1fr_1fr] gap-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">
          <span />
          <span>Lease / rent roll</span>
          <span>Tenant reported</span>
        </div>
        {pair("Monthly rent", "expected_monthly_rent", "reported_monthly_rent", "money")}
        {pair("Lease expiration", "expected_expiration_on", "reported_expiration_on", "date")}
        {pair("Security deposit", "expected_security_deposit", "reported_security_deposit", "money")}
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <Checkbox checked={v.reported_landlord_default === true} onChange={(c) => set("reported_landlord_default", c)} label="Landlord default" />
          Tenant reports a landlord default or offset claim
        </label>
        <Field label="Tenant remarks" className="col-span-2">
          <Textarea value={str("reported_notes")} onChange={(e) => set("reported_notes", e.target.value)} />
        </Field>
        <Field label="Signed document" className="col-span-2">
          <EntityPickerDocument value={v.document_id as string | null} onChange={(id) => set("document_id", id)} />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea value={str("notes")} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Remove this record?"
        description="It is archived and kept in the audit trail."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          item &&
          remove.mutate(item.id, {
            onSuccess: () => {
              setConfirmDelete(false);
              onOpenChange(false);
              toast.success("Removed");
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </Sheet>
  );
}

export function EstoppelsTab({ contract }: { contract: Contract }) {
  const { can } = useAuth();
  const { data, isLoading } = useEstoppels(contract.id);
  const resolve = useResolveEstoppel();
  const [editing, setEditing] = useState<Estoppel | null>(null);
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState<Estoppel | null>(null);
  const [note, setNote] = useState("");
  const editable = can("contracts", "edit");
  const rows = data ?? [];
  const unresolved = rows.filter((e) => e.has_discrepancy && !e.discrepancy_resolved_at);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          {rows.length ? `${rows.filter((e) => ["received", "approved"].includes(e.status)).length} of ${rows.length} received.` : "Estoppel certificates and SNDAs by tenant."}
        </p>
        {editable && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Add tenant
          </Button>
        )}
      </div>

      {unresolved.length > 0 && (
        <div className="space-y-2 rounded-lg border border-negative/30 bg-negative-soft px-4 py-3">
          <p className="text-sm font-medium text-negative">Discrepancies between tenant certificates and the lease</p>
          <ul className="space-y-1.5">
            {unresolved.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-ink">
                  <span className="font-medium">{e.tenant_name}</span>
                  <span className="text-ink-2">
                    {" "}
                    · {e.discrepancies.map((d) => `${d.label}: expected ${String(d.expected)}, reported ${String(d.reported)}`).join("; ")}
                  </span>
                </span>
                {editable && (
                  <Button
                    size="xs"
                    onClick={() => {
                      setNote("");
                      setResolving(e);
                    }}
                  >
                    Resolve…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          dense
          onRowClick={editable ? (e) => setEditing(e) : undefined}
          rowClassName={(e) => (e.has_discrepancy && !e.discrepancy_resolved_at ? "bg-negative-soft/30" : undefined)}
          empty={<EmptyState icon={<FileSignature />} title="No estoppels or SNDAs" description="Add each tenant to track requests, returns and discrepancies." />}
        />
      </Card>

      <EstoppelSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} contractId={contract.id} item={editing} />

      <Dialog
        open={!!resolving}
        onOpenChange={(o) => !o && setResolving(null)}
        title="Resolve discrepancy"
        description={resolving ? `${resolving.tenant_name} — explain how the mismatch was resolved (e.g. amendment found, seller correction).` : undefined}
        footer={
          <>
            <Button onClick={() => setResolving(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!note.trim()}
              loading={resolve.isPending}
              onClick={() =>
                resolving &&
                resolve.mutate(
                  { id: resolving.id, note: note.trim() },
                  { onSuccess: () => { toast.success("Discrepancy resolved"); setResolving(null); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              Resolve
            </Button>
          </>
        }
      >
        <Field label="Resolution" required>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
