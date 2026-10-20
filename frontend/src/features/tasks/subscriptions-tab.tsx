"use client";

import { useQuery } from "@tanstack/react-query";
import { BellRing, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker, UserPicker } from "@/components/data/entity-picker";
import { EmptyState, ListCard } from "@/components/data/page";
import type { SavedView } from "@/components/data/saved-views";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/features/properties/api";

import { ALERT_SEVERITIES, useDeleteSubscription, useRules, useSaveSubscription, useSubscriptions, type Subscription, type SubscriptionInput } from "./api";

const CHANNEL_LABELS: Record<string, string> = { in_app: "In-app", email: "Email", digest: "Daily digest" };

const EMPTY: SubscriptionInput = {
  name: "",
  territory_id: null,
  property_types: [],
  tenant: null,
  owner_id: null,
  saved_view_id: null,
  rule_keys: [],
  min_severity: "low",
  channel: "in_app",
  is_active: true,
};

function SubscriptionSheet({ open, onOpenChange, sub }: { open: boolean; onOpenChange: (o: boolean) => void; sub: Subscription | null }) {
  const [form, setForm] = useState<SubscriptionInput>(EMPTY);
  const save = useSaveSubscription(sub?.id);
  const { data: rules = [] } = useRules();
  const { data: views = [] } = useQuery({
    queryKey: ["saved-views", "properties"],
    queryFn: () => api.get<SavedView[]>("/saved-views", { module: "properties" }),
    enabled: open,
  });

  useEffect(() => {
    if (open) setForm(sub ? { ...EMPTY, ...sub } : EMPTY);
  }, [open, sub]);

  const set = <K extends keyof SubscriptionInput>(k: K, v: SubscriptionInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = (k: "property_types" | "rule_keys", v: string, on: boolean) =>
    set(k, on ? [...form[k], v] : form[k].filter((x) => x !== v));

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={sub ? "Edit subscription" : "New alert subscription"}
      description="Receive alerts that match a territory, property type, tenant, owner or saved property view."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!form.name.trim()}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { ...form, name: form.name.trim(), tenant: form.tenant?.trim() || null },
                {
                  onSuccess: () => {
                    toast.success("Subscription saved");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Save subscription
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. DFW retail — high severity" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Delivery">
            <Select value={form.channel} onChange={(e) => set("channel", e.target.value as SubscriptionInput["channel"])} options={Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }))} />
          </Field>
          <Field label="Minimum severity">
            <Select value={form.min_severity} onChange={(e) => set("min_severity", e.target.value)} options={ALERT_SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Territory">
            <EntityPicker<{ id: string; name: string }>
              endpoint="/territories"
              value={form.territory_id}
              onChange={(id) => set("territory_id", id)}
              placeholder="Any territory"
              toOption={(t) => ({ id: t.id, label: t.name })}
            />
          </Field>
          <Field label="Record owner">
            <UserPicker value={form.owner_id} onChange={(id) => set("owner_id", id)} placeholder="Any owner" />
          </Field>
          <Field label="Tenant" hint="Matches tenant names on the property's spaces">
            <Input value={form.tenant ?? ""} onChange={(e) => set("tenant", e.target.value)} placeholder="Any tenant" />
          </Field>
          <Field label="Saved property view">
            <Select value={form.saved_view_id ?? ""} onChange={(e) => set("saved_view_id", e.target.value || null)} placeholder="None" options={views.map((v) => ({ value: v.id, label: v.name }))} />
          </Field>
        </div>
        <Field label="Property types" hint="Leave empty for all types">
          <div className="grid grid-cols-2 gap-1.5 rounded-md border border-line p-2.5">
            {PROPERTY_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm text-ink-2">
                <Checkbox checked={form.property_types.includes(t)} onChange={(on) => toggleIn("property_types", t, on)} />
                {PROPERTY_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Automation rules" hint="Leave empty for alerts from any rule">
          <div className="space-y-1.5 rounded-md border border-line p-2.5">
            {rules.map((r) => (
              <label key={r.key} className="flex items-center gap-2 text-sm text-ink-2">
                <Checkbox checked={form.rule_keys.includes(r.key)} onChange={(on) => toggleIn("rule_keys", r.key, on)} />
                {r.name}
              </label>
            ))}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={form.is_active} onChange={(v) => set("is_active", v)} />
          Active
        </label>
      </div>
    </Sheet>
  );
}

export function SubscriptionsTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { user } = useAuth();
  const isAdmin = !!user?.permissions["*"]?.includes("*");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const { data, isLoading } = useSubscriptions(scope);
  const remove = useDeleteSubscription();
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [deleting, setDeleting] = useState<Subscription | null>(null);

  const columns: Column<Subscription>[] = [
    {
      id: "name",
      header: "Subscription",
      cell: (s) => (
        <div className="min-w-[220px]">
          <p className="font-medium text-ink">{s.name}</p>
          {scope === "all" && <p className="text-xs text-ink-3">{s.subscriber_name}</p>}
        </div>
      ),
    },
    {
      id: "filters",
      header: "Matches",
      cell: (s) => {
        const parts = [
          s.property_types.length ? s.property_types.map((t) => PROPERTY_TYPE_LABELS[t] ?? t).join(", ") : null,
          s.territory_id ? "Territory" : null,
          s.tenant ? `Tenant “${s.tenant}”` : null,
          s.owner_id ? "Owner" : null,
          s.saved_view_id ? "Saved view" : null,
          s.rule_keys.length ? `${s.rule_keys.length} rule(s)` : null,
        ].filter(Boolean);
        return <span className="text-ink-2">{parts.length ? parts.join(" · ") : "All alerts"}</span>;
      },
    },
    { id: "severity", header: "Min. severity", cell: (s) => <StatusBadge status={s.min_severity} /> },
    { id: "channel", header: "Delivery", cell: (s) => <Badge tone="outline">{CHANNEL_LABELS[s.channel]}</Badge> },
    { id: "active", header: "Status", cell: (s) => <StatusBadge status={s.is_active ? "active" : "inactive"} /> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (s) => (
        <div className="flex justify-end gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(s)}>
            <Pencil />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={() => setDeleting(s)}>
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <ListCard
        toolbar={
          isAdmin ? (
            <div className="inline-flex rounded-md border border-line bg-surface p-0.5 shadow-card">
              {(["mine", "all"] as const).map((s) => (
                <button key={s} onClick={() => setScope(s)} className={`h-7 rounded px-3 text-sm font-medium ${scope === s ? "bg-ink text-white" : "text-ink-2 hover:bg-muted"}`}>
                  {s === "mine" ? "My subscriptions" : "Everyone"}
                </button>
              ))}
            </div>
          ) : undefined
        }
      >
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          onRowClick={(s) => setEditing(s)}
          empty={
            <EmptyState
              icon={<BellRing />}
              title="No subscriptions"
              description="Subscribe to alerts for a territory, property type, tenant, owner or saved view."
              action={
                <Button variant="primary" onClick={() => onCreatingChange(true)}>
                  <Plus /> New subscription
                </Button>
              }
            />
          }
        />
      </ListCard>
      <SubscriptionSheet open={creating || !!editing} onOpenChange={(o) => { if (!o) { onCreatingChange(false); setEditing(null); } }} sub={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete subscription?"
        description={deleting?.name}
        destructive
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Subscription deleted");
              setDeleting(null);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}
