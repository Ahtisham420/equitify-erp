"use client";

import { useQuery } from "@tanstack/react-query";
import { Flag, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { UserPicker } from "@/components/data/entity-picker";
import { EmptyState, ListCard } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRelative } from "@/lib/utils";

import { useFlags, usePlatformMutation, type FeatureFlag } from "./api";

interface RoleLite {
  id: string;
  key: string;
  name: string;
}

function useRoles() {
  return useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleLite[]>("/roles"), staleTime: 300_000 });
}

export function FlagsTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const canAdmin = can("platform", "approve");
  const { data, isLoading } = useFlags();
  const roles = useRoles();
  const [editing, setEditing] = useState<FeatureFlag | null>(null);
  const [pendingToggle, setPendingToggle] = useState<FeatureFlag | null>(null);
  const [reason, setReason] = useState("");
  const roleName = (key: string) => roles.data?.find((r) => r.key === key)?.name ?? key;

  const toggle = usePlatformMutation((vars: { flag: FeatureFlag; reason?: string }) =>
    api.patch<FeatureFlag>(`/platform/flags/${vars.flag.id}`, { enabled: !vars.flag.enabled, reason: vars.reason ?? null }),
  );

  const doToggle = (flag: FeatureFlag, why?: string) =>
    toggle.mutate(
      { flag, reason: why },
      {
        onSuccess: (f) => {
          toast.success(`${f.key} ${f.enabled ? "enabled" : "disabled"}`);
          setPendingToggle(null);
          setReason("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const columns: Column<FeatureFlag>[] = [
    {
      id: "key",
      header: "Flag",
      cell: (f) => (
        <div className="min-w-[220px]">
          <p className="flex items-center gap-1.5 font-mono text-xs font-medium text-ink">
            {f.key}
            {f.is_sensitive && (
              <Badge tone="amber">
                <ShieldAlert className="size-3" /> Sensitive
              </Badge>
            )}
          </p>
          {f.description && <p className="truncate text-xs text-ink-3">{f.description}</p>}
        </div>
      ),
    },
    {
      id: "rollout",
      header: "Rollout",
      cell: (f) =>
        f.rollout_roles.length === 0 && f.rollout_user_ids.length === 0 ? (
          <span className="text-ink-2">Everyone</span>
        ) : (
          <span className="text-ink-2">
            {[f.rollout_roles.map(roleName).join(", "), f.rollout_user_ids.length ? `${f.rollout_user_ids.length} user(s)` : ""].filter(Boolean).join(" · ")}
          </span>
        ),
    },
    { id: "updated", header: "Updated", cell: (f) => <span className="whitespace-nowrap text-ink-3">{formatRelative(f.updated_at)}</span> },
    {
      id: "enabled",
      header: "Enabled",
      align: "right",
      cell: (f) => (
        <div className="flex justify-end">
          <Checkbox
            checked={f.enabled}
            label={`Toggle ${f.key}`}
            onChange={() => {
              if (!canAdmin) return;
              if (f.is_sensitive) setPendingToggle(f);
              else doToggle(f);
            }}
          />
        </div>
      ),
    },
  ];

  return (
    <>
      <p className="mb-4 max-w-3xl text-sm text-ink-2">
        Money, date and permission-sensitive changes ship behind flags. Changing a sensitive flag requires a recorded reason and is written to the audit log.
      </p>
      <ListCard>
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          onRowClick={canAdmin ? (f) => setEditing(f) : undefined}
          empty={
            <EmptyState
              icon={<Flag />}
              title="No feature flags"
              description="Create a flag to stage a rollout by role or user."
              action={canAdmin ? <Button variant="primary" onClick={() => onCreatingChange(true)}>New flag</Button> : undefined}
            />
          }
        />
      </ListCard>
      <FlagSheet open={creating} onOpenChange={onCreatingChange} roles={roles.data ?? []} />
      <FlagSheet open={!!editing} onOpenChange={(o) => !o && setEditing(null)} flag={editing} roles={roles.data ?? []} />
      <Dialog
        open={!!pendingToggle}
        onOpenChange={(o) => !o && setPendingToggle(null)}
        title={pendingToggle ? `${pendingToggle.enabled ? "Disable" : "Enable"} ${pendingToggle.key}` : ""}
        description="This flag controls a money, date or permission-sensitive change. Record why it is changing."
        footer={
          <>
            <Button onClick={() => setPendingToggle(null)}>Cancel</Button>
            <Button variant="primary" disabled={reason.trim().length < 3} loading={toggle.isPending} onClick={() => pendingToggle && doToggle(pendingToggle, reason.trim())}>
              Confirm
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </Field>
      </Dialog>
    </>
  );
}

function FlagSheet({ open, onOpenChange, flag, roles }: { open: boolean; onOpenChange: (o: boolean) => void; flag?: FeatureFlag | null; roles: RoleLite[] }) {
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [rolloutRoles, setRolloutRoles] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setKey(flag?.key ?? "");
    setDescription(flag?.description ?? "");
    setEnabled(flag?.enabled ?? false);
    setSensitive(flag?.is_sensitive ?? false);
    setRolloutRoles(flag?.rollout_roles ?? []);
    setUsers(flag?.rollout_user_ids ?? []);
    setReason("");
  }, [open, flag]);

  const save = usePlatformMutation(() =>
    flag
      ? api.patch<FeatureFlag>(`/platform/flags/${flag.id}`, {
          description: description || null,
          enabled,
          is_sensitive: sensitive,
          rollout_roles: rolloutRoles,
          rollout_user_ids: users,
          reason: reason.trim() || null,
        })
      : api.post<FeatureFlag>("/platform/flags", {
          key,
          description: description || null,
          enabled,
          is_sensitive: sensitive,
          rollout_roles: rolloutRoles,
          rollout_user_ids: users,
        }),
  );

  const needsReason = !!flag && (flag.is_sensitive || sensitive);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={flag ? flag.key : "New feature flag"}
      footer={
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={(!flag && key.length < 2) || (needsReason && reason.trim().length < 3)}
          onClick={() =>
            save.mutate(undefined, {
              onSuccess: () => {
                toast.success(flag ? "Flag updated" : "Flag created");
                onOpenChange(false);
              },
              onError: (e) => toast.error(errorMessage(e)),
            })
          }
        >
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        {!flag && (
          <Field label="Key" required hint="Lowercase letters, numbers, dots, dashes and underscores.">
            <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="offers.new_approval_limits" className="font-mono text-xs" />
          </Field>
        )}
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <Checkbox checked={enabled} onChange={setEnabled} label="Enabled" /> Enabled
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <Checkbox checked={sensitive} onChange={setSensitive} label="Sensitive" /> Money, date or permission-sensitive change
        </label>
        <Field label="Roll out to roles" hint="Leave empty with no users to enable for everyone.">
          <div className="flex flex-wrap gap-1.5">
            {roles.map((r) => {
              const on = rolloutRoles.includes(r.key);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRolloutRoles((cur) => (on ? cur.filter((k) => k !== r.key) : [...cur, r.key]))}
                  className={on ? "rounded-md border border-ink bg-ink px-2 py-1 text-xs text-white" : "rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-subtle"}
                >
                  {r.name}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Roll out to users">
          <div className="space-y-2">
            <UserPicker value={null} onChange={(id) => id && setUsers((u) => (u.includes(id) ? u : [...u, id]))} placeholder="Add user" />
            {users.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {users.map((u) => (
                  <span key={u} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface pl-2 pr-1 font-mono text-2xs text-ink-2">
                    {u.slice(0, 8)}
                    <button type="button" aria-label="Remove user" onClick={() => setUsers((cur) => cur.filter((x) => x !== u))} className="rounded p-0.5 hover:bg-muted">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </Field>
        {needsReason && (
          <Field label="Reason for change" required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
        )}
      </div>
    </Sheet>
  );
}
