"use client";

import { Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, toNumber } from "@/lib/utils";

import { ACTION_LABELS, APPROVAL_KINDS, grants, usePermissionCatalog, useSaveRole, type Role } from "./api";

type LimitMode = "none" | "limit" | "unlimited";
type LimitDraft = Record<string, { mode: LimitMode; amount: string }>;

function toLimitDraft(limits: Record<string, number | null>): LimitDraft {
  return Object.fromEntries(
    APPROVAL_KINDS.map((k) => {
      if (!(k.key in limits)) return [k.key, { mode: "none" as LimitMode, amount: "" }];
      const v = limits[k.key];
      return [k.key, v === null || v === undefined ? { mode: "unlimited" as LimitMode, amount: "" } : { mode: "limit" as LimitMode, amount: String(v) }];
    }),
  );
}

function fromLimitDraft(draft: LimitDraft, original: Record<string, number | null>): Record<string, number | null> {
  // Keep any non-standard kinds configured elsewhere untouched.
  const out: Record<string, number | null> = Object.fromEntries(
    Object.entries(original).filter(([k]) => !APPROVAL_KINDS.some((a) => a.key === k)),
  );
  for (const k of APPROVAL_KINDS) {
    const d = draft[k.key];
    if (d.mode === "unlimited") out[k.key] = null;
    else if (d.mode === "limit") out[k.key] = toNumber(d.amount) ?? 0;
  }
  return out;
}

/** Replace `*` action wildcards with explicit actions, drop empty modules and sort keys for stable comparison. */
function expand(perms: Record<string, string[]>, actions: string[]): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(perms)
      .filter(([, a]) => a.length > 0)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([m, a]) => [m, a.includes("*") ? [...actions] : actions.filter((x) => a.includes(x))]),
  );
}

export function PermissionMatrix({
  permissions,
  onChange,
  readOnly,
}: {
  permissions: Record<string, string[]>;
  onChange: (p: Record<string, string[]>) => void;
  readOnly?: boolean;
}) {
  const { data: catalog } = usePermissionCatalog();
  if (!catalog) return null;
  const { modules, actions } = catalog;

  const set = (module: string, next: string[]) => {
    const p = expand(permissions, actions);
    if (next.length) p[module] = actions.filter((a) => next.includes(a));
    else delete p[module];
    onChange(p);
  };
  const current = (module: string) => actions.filter((a) => grants(permissions, module, a));

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-xs font-medium text-ink-3">
            <th className="sticky left-0 border-b border-line bg-subtle px-4 py-2 text-left">Module</th>
            <th className="border-b border-line bg-subtle px-2 py-2 text-center">All</th>
            {actions.map((a) => (
              <th key={a} className="border-b border-line bg-subtle px-2 py-2 text-center">{ACTION_LABELS[a] ?? a}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(modules).map(([m, label]) => {
            const granted = current(m);
            const all = granted.length === actions.length;
            return (
              <tr key={m} className="hover:bg-subtle/60">
                <td className="sticky left-0 whitespace-nowrap border-b border-line bg-surface px-4 py-1.5 text-ink">{label}</td>
                <td className="border-b border-line px-2 py-1.5">
                  <div className="flex justify-center">
                    {readOnly ? (
                      <span className={cn("size-1.5 rounded-full", all ? "bg-ink" : "bg-transparent")} />
                    ) : (
                      <Checkbox
                        checked={all}
                        indeterminate={!all && granted.length > 0}
                        onChange={(on) => set(m, on ? actions : [])}
                        label={`All ${label}`}
                      />
                    )}
                  </div>
                </td>
                {actions.map((a) => {
                  const on = granted.includes(a);
                  return (
                    <td key={a} className="border-b border-line px-2 py-1.5">
                      <div className="flex justify-center">
                        <Checkbox
                          checked={on}
                          onChange={(v) => !readOnly && set(m, v ? [...granted, a] : granted.filter((x) => x !== a))}
                          label={`${label} ${a}`}
                          className={readOnly ? "pointer-events-none opacity-60" : undefined}
                        />
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RoleEditor({ role }: { role: Role }) {
  const { can } = useAuth();
  const { data: catalog } = usePermissionCatalog();
  const save = useSaveRole(role.id);
  const locked = role.key === "admin";
  const editable = can("users", "approve") && !locked;
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [permissions, setPermissions] = useState(role.permissions);
  const [limits, setLimits] = useState<LimitDraft>(toLimitDraft(role.approval_limits));

  useEffect(() => {
    setName(role.name);
    setDescription(role.description ?? "");
    setPermissions(role.permissions);
    setLimits(toLimitDraft(role.approval_limits));
  }, [role]);

  const payload = useMemo(
    () => ({
      name: name.trim(),
      description: description.trim() || null,
      permissions: catalog ? expand(permissions, catalog.actions) : permissions,
      approval_limits: fromLimitDraft(limits, role.approval_limits),
    }),
    [name, description, permissions, limits, role.approval_limits, catalog],
  );
  const original = useMemo(
    () => JSON.stringify({
      name: role.name,
      description: role.description,
      permissions: catalog ? expand(role.permissions, catalog.actions) : role.permissions,
      approval_limits: fromLimitDraft(toLimitDraft(role.approval_limits), role.approval_limits),
    }),
    [role, catalog],
  );
  const dirty = JSON.stringify(payload) !== original;

  const submit = () =>
    save.mutate(payload, {
      onSuccess: () => toast.success(`${payload.name} saved`),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const reset = () => {
    setName(role.name);
    setDescription(role.description ?? "");
    setPermissions(role.permissions);
    setLimits(toLimitDraft(role.approval_limits));
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              {role.name}
              {role.is_system && <Badge tone="outline">System</Badge>}
              {locked && (
                <Badge tone="neutral">
                  <Lock className="size-3" /> Read-only
                </Badge>
              )}
            </span>
          }
          description={`${role.user_count} user${role.user_count === 1 ? "" : "s"} · key ${role.key}`}
          actions={
            editable && (
              <>
                <Button size="sm" disabled={!dirty} onClick={reset}>
                  Discard
                </Button>
                <Button size="sm" variant="primary" disabled={!dirty || !payload.name} loading={save.isPending} onClick={submit}>
                  Save role
                </Button>
              </>
            )
          }
        />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea rows={1} value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {locked && (
            <p className="text-xs text-ink-3 sm:col-span-2">The administrator role always has full access and unlimited approval authority. It cannot be edited.</p>
          )}
          {dirty && editable && (
            <p className="text-xs text-caution sm:col-span-2">Unsaved changes. Permission changes apply to every user with this role and are recorded in the audit log.</p>
          )}
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Module permissions" description="Enforced on every API request, independently of the interface." />
        <PermissionMatrix permissions={locked ? { "*": ["*"] } : permissions} onChange={setPermissions} readOnly={!editable} />
      </Card>

      <Card>
        <CardHeader title="Approval authority" description="Maximum amount this role can approve. No authority means approvals must go to someone else." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {APPROVAL_KINDS.map((k) => {
            const d = locked ? { mode: "unlimited" as LimitMode, amount: "" } : limits[k.key];
            const setD = (patch: Partial<{ mode: LimitMode; amount: string }>) => setLimits((l) => ({ ...l, [k.key]: { ...l[k.key], ...patch } }));
            return (
              <div key={k.key} className="space-y-2">
                <Field label={k.label}>
                  <Select
                    value={d.mode}
                    disabled={!editable}
                    onChange={(e) => setD({ mode: e.target.value as LimitMode })}
                    options={[
                      { value: "none", label: "No authority" },
                      { value: "limit", label: "Up to an amount" },
                      { value: "unlimited", label: "Unlimited" },
                    ]}
                  />
                </Field>
                {d.mode === "limit" && (
                  <Input
                    inputMode="decimal"
                    value={d.amount}
                    disabled={!editable}
                    onChange={(e) => setD({ amount: e.target.value })}
                    leading={<span className="text-xs">$</span>}
                    placeholder="Amount"
                    className="tabular"
                  />
                )}
              </div>
            );
          })}
        </CardBody>
      </Card>
    </div>
  );
}

export function CreateRoleDialog({
  open,
  onOpenChange,
  roles,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  roles: Role[];
  onCreated: (r: Role) => void;
}) {
  const save = useSaveRole();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [copyFrom, setCopyFrom] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setKey("");
      setKeyTouched(false);
      setDescription("");
      setCopyFrom("");
    }
  }, [open]);

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);

  const submit = () => {
    const base = roles.find((r) => r.id === copyFrom);
    save.mutate(
      {
        key,
        name: name.trim(),
        description: description.trim() || null,
        permissions: base && base.key !== "admin" ? base.permissions : {},
        approval_limits: base && base.key !== "admin" ? base.approval_limits : {},
      },
      {
        onSuccess: (r) => {
          toast.success("Role created");
          onOpenChange(false);
          onCreated(r);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New role"
      description="Start empty or copy permissions from an existing role, then adjust the matrix."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || key.length < 2} loading={save.isPending} onClick={submit}>
            Create role
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(slug(e.target.value));
            }}
            placeholder="e.g. Regional Acquisitions Lead"
          />
        </Field>
        <Field label="Key" required hint="Lowercase letters, numbers and underscores. Cannot be changed later.">
          <Input
            value={key}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60));
            }}
            className="font-mono"
          />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Copy permissions from">
          <Select
            value={copyFrom}
            onChange={(e) => setCopyFrom(e.target.value)}
            placeholder="Start with no access"
            options={roles.filter((r) => r.key !== "admin").map((r) => ({ value: r.id, label: r.name }))}
          />
        </Field>
      </div>
    </Dialog>
  );
}
