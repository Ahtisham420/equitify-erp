"use client";

import { useQuery } from "@tanstack/react-query";
import { BellRing, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { EntityPicker, PropertyPicker } from "@/components/data/entity-picker";
import { FacetFilter } from "@/components/data/filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/utils";

import { OwnerPicker } from "@/features/contacts/pickers";
import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS } from "@/features/properties/api";

import {
  CATEGORY_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  SIGNAL_CATEGORIES,
  useDeleteSubscription,
  useSaveSubscription,
  useSignalSubscriptions,
  useSignalTypes,
  type SignalSubscription,
  type SubscriptionInput,
} from "./api";

interface TerritoryLite { id: string; name: string }

const EMPTY: SubscriptionInput = {
  name: "", categories: [], signal_types: [], min_severity: 3, property_id: null, owner_kind: null, owner_id: null, territory_id: null,
  property_types: [], stacked_only: false, is_active: true,
};

function SubscriptionSheet({ sub, open, onOpenChange }: { sub: SignalSubscription | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const save = useSaveSubscription(sub?.id);
  const { data: types = [] } = useSignalTypes();
  const [form, setForm] = useState<SubscriptionInput>(EMPTY);
  useEffect(() => {
    if (open) setForm(sub ? { ...EMPTY, ...sub } : EMPTY);
  }, [open, sub]);
  const set = <K extends keyof SubscriptionInput>(k: K, v: SubscriptionInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () =>
    save.mutate(
      { ...form, name: form.name.trim(), owner_kind: form.owner_id ? form.owner_kind ?? "organization" : null },
      {
        onSuccess: () => {
          toast.success(sub ? "Subscription updated" : "Subscription created");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={sub ? sub.name : "New signal subscription"}
      description="You receive an alert when a new signal matches every condition you set."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.name.trim()} onClick={submit}>
            {sub ? "Save" : "Subscribe"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Debt distress in my territory" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <FacetFilter label="Categories" options={SIGNAL_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} selected={form.categories} onChange={(v) => set("categories", v)} />
          <FacetFilter label="Types" searchable options={types.map((t) => ({ value: t.key, label: t.label }))} selected={form.signal_types} onChange={(v) => set("signal_types", v)} />
          <FacetFilter label="Property types" options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }))} selected={form.property_types} onChange={(v) => set("property_types", v)} />
        </div>
        <Field label="Minimum severity">
          <Select value={String(form.min_severity)} onChange={(e) => set("min_severity", Number(e.target.value))} options={SEVERITIES.map((s) => ({ value: String(s), label: SEVERITY_LABELS[s] }))} />
        </Field>
        <Field label="Property" hint="Optional — only signals on this property">
          <PropertyPicker value={form.property_id} onChange={(id) => set("property_id", id)} />
        </Field>
        <Field label="Owner" hint="Optional — only signals linked to this owner">
          <OwnerPicker kind={form.owner_kind ?? "organization"} onKindChange={(k) => set("owner_kind", k)} value={form.owner_id} onChange={(id) => set("owner_id", id)} />
        </Field>
        <Field label="Territory" hint="Optional — only properties in this territory">
          <EntityPicker<TerritoryLite>
            endpoint="/territories/options"
            list
            value={form.territory_id}
            onChange={(id) => set("territory_id", id)}
            placeholder="Any territory"
            toOption={(t) => ({ id: t.id, label: t.name })}
          />
        </Field>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={form.stacked_only} onChange={(v) => set("stacked_only", v)} label="Stacked only" />
            Only when the signal stacks with other independent signals
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={form.is_active} onChange={(v) => set("is_active", v)} label="Active" />
            Active
          </label>
        </div>
      </div>
    </Sheet>
  );
}

export function SignalSubscriptionsTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { data, isLoading } = useSignalSubscriptions();
  const remove = useDeleteSubscription();
  const { data: territories = [] } = useQuery({
    queryKey: ["territories", "options"],
    queryFn: () => api.get<TerritoryLite[]>("/territories/options"),
    staleTime: 5 * 60_000,
  });
  const [editing, setEditing] = useState<SignalSubscription | null>(null);
  const [deleting, setDeleting] = useState<SignalSubscription | null>(null);

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <>
      {(data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<BellRing />}
            title="No signal subscriptions"
            description="Subscribe to categories, types, owners, properties or territories to be alerted when matching signals arrive."
            action={<Button variant="primary" onClick={() => onCreatingChange(true)}>New subscription</Button>}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {(data ?? []).map((s) => (
              <li key={s.id} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-subtle/60" onClick={() => setEditing(s)}>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">
                    {s.name}
                    {!s.is_active && <Badge>Paused</Badge>}
                    {s.stacked_only && <Badge tone="blue">Stacked only</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {[
                      s.categories.length ? s.categories.map((c) => CATEGORY_LABELS[c] ?? c).join(", ") : "All categories",
                      `severity ≥ ${s.min_severity}`,
                      s.signal_types.length ? `${s.signal_types.length} types` : null,
                      s.property_types.length ? s.property_types.map((t) => PROPERTY_TYPE_LABELS[t] ?? t).join(", ") : null,
                      s.territory_id ? territories.find((t) => t.id === s.territory_id)?.name ?? "Territory" : null,
                      s.property_id ? "One property" : null,
                      s.owner_id ? "One owner" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span className="text-xs text-ink-3">Since {formatDate(s.created_at)}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete subscription"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleting(s);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <SubscriptionSheet sub={editing} open={!!editing || creating} onOpenChange={(o) => { if (!o) { setEditing(null); onCreatingChange(false); } }} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete subscription"
        description={deleting?.name}
        confirmLabel="Delete"
        destructive
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
