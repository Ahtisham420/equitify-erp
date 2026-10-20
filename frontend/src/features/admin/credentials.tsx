"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Copy, KeyRound, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatRelative } from "@/lib/utils";

import {
  ACTION_LABELS,
  useCreateCredential,
  useCredentials,
  usePermissionCatalog,
  useRevokeCredential,
  type AdminUser,
  type Credential,
  type CredentialCreated,
} from "./api";

function useServiceUsers(enabled: boolean) {
  return useQuery({
    queryKey: ["users", "service-options"],
    queryFn: async () => (await api.get<Page<AdminUser>>("/users", { is_service: true, page_size: 200 })).items,
    enabled,
    staleTime: 30_000,
  });
}

/** Least-privilege scope picker: one checkbox per module × action, stored as `module:action`. */
export function ScopeMatrix({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { data: catalog } = usePermissionCatalog();
  if (!catalog) return null;
  const toggle = (scope: string, on: boolean) => onChange(on ? [...value, scope] : value.filter((s) => s !== scope));
  return (
    <div className="overflow-x-auto rounded-lg border border-line scrollbar-thin">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-xs font-medium text-ink-3">
            <th className="border-b border-line bg-subtle px-3 py-2 text-left">Module</th>
            {catalog.actions.map((a) => (
              <th key={a} className="border-b border-line bg-subtle px-2 py-2 text-center">{ACTION_LABELS[a] ?? a}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(catalog.modules).map(([m, label]) => (
            <tr key={m}>
              <td className="whitespace-nowrap border-b border-line px-3 py-1.5 text-ink-2">{label}</td>
              {catalog.actions.map((a) => {
                const scope = `${m}:${a}`;
                return (
                  <td key={a} className="border-b border-line px-2 py-1.5">
                    <div className="flex justify-center">
                      <Checkbox checked={value.includes(scope)} onChange={(on) => toggle(scope, on)} label={`${label} ${a}`} />
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewKeyDialog({ created, onClose }: { created: CredentialCreated | null; onClose: () => void }) {
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.api_key);
      toast.success("API key copied");
    } catch {
      toast.error("Copy failed — select the key and copy it manually");
    }
  };
  return (
    <Dialog
      open={!!created}
      onOpenChange={(o) => !o && onClose()}
      title="Copy the API key now"
      description={created ? `Credential “${created.name}” was created.` : undefined}
      footer={
        <Button variant="primary" onClick={onClose}>
          I have stored the key
        </Button>
      }
    >
      {created && (
        <div className="space-y-3">
          <div className="flex gap-2 rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution" />
            <p className="text-ink-2">This is the only time the full key is shown. Store it in your secrets manager. If it is lost, revoke it and create a new one.</p>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all break-all rounded-md border border-line bg-subtle px-3 py-2 font-mono text-xs text-ink">{created.api_key}</code>
            <Button size="icon" onClick={copy} aria-label="Copy API key">
              <Copy />
            </Button>
          </div>
          <p className="text-xs text-ink-3">Send it in the <span className="font-mono">X-API-Key</span> header.</p>
        </div>
      )}
    </Dialog>
  );
}

function CreateCredentialDialog({
  open,
  onOpenChange,
  userId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId?: string;
  onCreated: (c: CredentialCreated) => void;
}) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(userId ?? "");
  const [scopes, setScopes] = useState<string[]>([]);
  const { data: serviceUsers = [] } = useServiceUsers(open && !userId);
  const create = useCreateCredential();

  useEffect(() => {
    if (open) {
      setName("");
      setOwner(userId ?? "");
      setScopes([]);
    }
  }, [open, userId]);

  const submit = () =>
    create.mutate(
      { name: name.trim(), user_id: owner, scopes },
      {
        onSuccess: (c) => {
          onOpenChange(false);
          onCreated(c);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New service credential"
      description="Grant only the modules and operations the integration needs."
      className="max-w-3xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !owner || scopes.length === 0} loading={create.isPending} onClick={submit}>
            Create credential
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Assessor nightly feed" />
          </Field>
          {!userId && (
            <Field label="Service user" required hint={serviceUsers.length === 0 ? "Create a service integration user first." : undefined}>
              <Select
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="Select service user"
                options={serviceUsers.filter((u) => u.status === "active").map((u) => ({ value: u.id, label: u.full_name }))}
              />
            </Field>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Scopes ({scopes.length})</p>
          <ScopeMatrix value={scopes} onChange={setScopes} />
        </div>
      </div>
    </Dialog>
  );
}

/** Service credentials, optionally limited to one service user. */
export function CredentialsPanel({ userId, userActive = true }: { userId?: string; userActive?: boolean }) {
  const { can } = useAuth();
  const { data = [], isLoading } = useCredentials(can("users", "view"));
  const { data: serviceUsers = [] } = useServiceUsers(!userId && can("users", "view"));
  const revoke = useRevokeCredential();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CredentialCreated | null>(null);
  const [revoking, setRevoking] = useState<Credential | null>(null);
  const canManage = can("users", "approve");

  const rows = userId ? data.filter((c) => c.user_id === userId) : data;
  const ownerName = (id: string) => serviceUsers.find((u) => u.id === id)?.full_name ?? "Service user";

  const columns: Column<Credential>[] = [
    {
      id: "name",
      header: "Credential",
      cell: (c) => (
        <div>
          <p className="font-medium text-ink">{c.name}</p>
          <p className="font-mono text-xs text-ink-3">eqf_{c.key_prefix}_••••</p>
        </div>
      ),
    },
    ...(userId
      ? []
      : [{ id: "owner", header: "Service user", cell: (c: Credential) => <Link href={`/admin/users/${c.user_id}`} className="text-ink-2 hover:text-ink hover:underline">{ownerName(c.user_id)}</Link> }]),
    {
      id: "scopes",
      header: "Scopes",
      cell: (c) => (
        <div className="flex max-w-[360px] flex-wrap gap-1">
          {c.scopes.slice(0, 6).map((s) => (
            <Badge key={s} tone="outline" className="font-mono">{s}</Badge>
          ))}
          {c.scopes.length > 6 && <Badge>+{c.scopes.length - 6}</Badge>}
        </div>
      ),
    },
    { id: "status", header: "Status", cell: (c) => (c.revoked_at ? <Badge tone="neutral" dot>Revoked {formatDate(c.revoked_at)}</Badge> : <Badge tone="green" dot>Active</Badge>) },
    { id: "used", header: "Last used", cell: (c) => <span className="whitespace-nowrap text-xs text-ink-3">{c.last_used_at ? formatRelative(c.last_used_at) : "Never"}</span> },
    { id: "created", header: "Created", cell: (c) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDate(c.created_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (c) =>
        canManage && !c.revoked_at ? (
          <Button size="xs" variant="ghost" className="text-negative" onClick={() => setRevoking(c)}>
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Service credentials"
        description="Scoped API keys for integrations. Keys are shown once at creation and stored only as a hash."
        actions={
          canManage &&
          userActive && (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New credential
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        rowClassName={(c) => (c.revoked_at ? "opacity-60" : undefined)}
        empty={<EmptyState icon={<KeyRound />} title="No credentials" description="Create a scoped credential for a service integration user." />}
      />
      <CreateCredentialDialog open={creating} onOpenChange={setCreating} userId={userId} onCreated={setCreated} />
      <NewKeyDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this credential?"
        description="Requests using this key are rejected immediately. This cannot be undone."
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast.success("Credential revoked");
              setRevoking(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </Card>
  );
}
