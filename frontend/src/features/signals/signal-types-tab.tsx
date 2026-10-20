"use client";

import { Lock, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter } from "@/components/data/filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber } from "@/lib/utils";

import {
  CATEGORY_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  SIGNAL_CATEGORIES,
  halfLifeLabel,
  useSaveSignalSettings,
  useSaveSignalType,
  useSignalSettings,
  useSignalTypes,
  type SignalSettings,
  type SignalType,
} from "./api";
import { CategoryBadge, SeverityBadge } from "./components";

/** Decay curve preview: share of weight remaining after `days`. */
function remaining(halfLife: number | null, days: number) {
  return halfLife ? Math.round(100 * Math.pow(0.5, days / halfLife)) : 100;
}

function StackingSettings() {
  const { can } = useAuth();
  const { data, isLoading } = useSignalSettings();
  const save = useSaveSignalSettings();
  const [draft, setDraft] = useState<SignalSettings | null>(null);
  useEffect(() => setDraft(data ?? null), [data]);
  const editable = can("signals", "approve");

  if (isLoading || !draft) return <Skeleton className="h-32 w-full" />;
  const num = (k: keyof SignalSettings, v: string) => setDraft((d) => (d ? { ...d, [k]: Number(v) } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(data);

  return (
    <Card>
      <CardHeader
        title="Stacking and alert rules"
        description="Independent signals (different type and source) inside the window stack: they escalate priority and multiply the motivation index."
        actions={
          editable ? (
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate(draft, { onSuccess: () => toast.success("Signal rules saved"), onError: (e) => toast.error(errorMessage(e)) })}
            >
              Save rules
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <fieldset disabled={!editable} className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="Stacking window" hint="Days">
            <Input type="number" min={1} value={draft.window_days} onChange={(e) => num("window_days", e.target.value)} />
          </Field>
          <Field label="Signals to stack" hint="Independent signals">
            <Input type="number" min={2} max={10} value={draft.min_independent} onChange={(e) => num("min_independent", e.target.value)} />
          </Field>
          <Field label="Stack bonus" hint="Per extra signal (0.25 = +25%)">
            <Input type="number" min={0} max={2} step={0.05} value={draft.stack_bonus} onChange={(e) => num("stack_bonus", e.target.value)} />
          </Field>
          <Field label="Alert at severity" hint="Single-signal alerts">
            <Select value={String(draft.alert_min_severity)} onChange={(e) => num("alert_min_severity", e.target.value)} options={SEVERITIES.map((s) => ({ value: String(s), label: SEVERITY_LABELS[s] }))} />
          </Field>
          <Field label="Automation">
            <label className="flex h-8 items-center gap-2 text-sm text-ink">
              <Checkbox checked={draft.enabled} onChange={(v) => setDraft((d) => (d ? { ...d, enabled: v } : d))} label="Enabled" />
              Alerts enabled
            </label>
          </Field>
        </fieldset>
      </CardBody>
    </Card>
  );
}

const EMPTY: Omit<SignalType, "id" | "signal_count" | "updated_at"> = {
  key: "", label: "", category: "debt", description: null, default_severity: 3, half_life_days: 180, default_expiry_days: 365, is_sensitive: false, is_active: true,
};

function TypeDialog({ type, open, onOpenChange }: { type: SignalType | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const save = useSaveSignalType(type?.id);
  const [form, setForm] = useState(EMPTY);
  const [halfLife, setHalfLife] = useState("");
  const [expiry, setExpiry] = useState("");
  useEffect(() => {
    if (!open) return;
    const base = type ? { ...type } : { ...EMPTY };
    setForm(base);
    setHalfLife(base.half_life_days ? String(base.half_life_days) : "");
    setExpiry(base.default_expiry_days ? String(base.default_expiry_days) : "");
  }, [open, type]);
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const hl = halfLife ? Number(halfLife) : null;

  const submit = () => {
    const body = {
      label: form.label.trim(),
      description: form.description?.trim() || null,
      default_severity: form.default_severity,
      half_life_days: hl,
      default_expiry_days: expiry ? Number(expiry) : null,
      is_sensitive: form.is_sensitive,
      is_active: form.is_active,
      ...(type ? {} : { key: form.key.trim(), category: form.category }),
    };
    save.mutate(body, {
      onSuccess: () => {
        toast.success(type ? "Signal type updated" : "Signal type created");
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={type ? `Edit ${type.label}` : "New signal type"}
      description={type ? "Changing the half-life re-weights every signal of this type." : "Decay and defaults apply to new signals of this type."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!form.label.trim() || (!type && !/^[a-z0-9_]{2,}$/.test(form.key))} onClick={submit}>
            {type ? "Save" : "Create type"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Label" required>
            <Input value={form.label} onChange={(e) => set("label", e.target.value)} />
          </Field>
          <Field label="Key" required={!type} hint={type ? undefined : "Lowercase, digits, underscores"}>
            <Input value={form.key} disabled={!!type} onChange={(e) => set("key", e.target.value.toLowerCase())} />
          </Field>
          <Field label="Category">
            <Select value={form.category} disabled={!!type} onChange={(e) => set("category", e.target.value)} options={SIGNAL_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} />
          </Field>
          <Field label="Default severity">
            <Select value={String(form.default_severity)} onChange={(e) => set("default_severity", Number(e.target.value))} options={SEVERITIES.map((s) => ({ value: String(s), label: SEVERITY_LABELS[s] }))} />
          </Field>
          <Field label="Half-life (days)" hint="Blank = no decay">
            <Input type="number" min={1} value={halfLife} onChange={(e) => setHalfLife(e.target.value)} />
          </Field>
          <Field label="Default expiry (days)" hint="Blank = never expires">
            <Input type="number" min={1} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </Field>
        </div>
        <div className="rounded-md border border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
          Weight remaining: 90 days {remaining(hl, 90)}% · 6 months {remaining(hl, 182)}% · 1 year {remaining(hl, 365)}% · 2 years {remaining(hl, 730)}%
        </div>
        <Field label="Description">
          <Textarea value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} rows={2} />
        </Field>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={form.is_sensitive} onChange={(v) => set("is_sensitive", v)} label="Sensitive by default" />
            Sensitive by default
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={form.is_active} onChange={(v) => set("is_active", v)} label="Active" />
            Active
          </label>
        </div>
      </div>
    </Dialog>
  );
}

export function SignalTypesTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const { data, isLoading } = useSignalTypes();
  const [editing, setEditing] = useState<SignalType | null>(null);
  const [category, setCategory] = useState<string[]>([]);
  const rows = (data ?? []).filter((t) => !category.length || category.includes(t.category));
  const counts = (data ?? []).reduce<Record<string, number>>((a, t) => ({ ...a, [t.category]: (a[t.category] ?? 0) + 1 }), {});

  const columns: Column<SignalType>[] = [
    {
      id: "label",
      header: "Type",
      cell: (t) => (
        <div className="min-w-[200px]">
          <p className="flex items-center gap-1.5 font-medium text-ink">
            {t.label}
            {t.is_sensitive && <Lock className="size-3.5 text-caution" aria-label="Sensitive by default" />}
          </p>
          <p className="text-xs text-ink-3">{t.key}</p>
        </div>
      ),
    },
    { id: "category", header: "Category", cell: (t) => <CategoryBadge category={t.category} /> },
    { id: "severity", header: "Default severity", cell: (t) => <SeverityBadge severity={t.default_severity} /> },
    { id: "half_life", header: "Half-life", align: "right", cell: (t) => halfLifeLabel(t.half_life_days) },
    {
      id: "curve",
      header: "Weight at 1 yr",
      cell: (t) => (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-accent" style={{ width: `${remaining(t.half_life_days, 365)}%` }} />
          </div>
          <span className="text-xs text-ink-3 tabular">{remaining(t.half_life_days, 365)}%</span>
        </div>
      ),
    },
    { id: "expiry", header: "Expires after", align: "right", cell: (t) => (t.default_expiry_days ? `${formatNumber(t.default_expiry_days)} d` : "Never") },
    { id: "count", header: "Signals", align: "right", cell: (t) => formatNumber(t.signal_count) },
    { id: "active", header: "Status", cell: (t) => (t.is_active ? <Badge tone="green" dot>Active</Badge> : <Badge dot>Inactive</Badge>) },
  ];

  return (
    <div className="space-y-4">
      <StackingSettings />
      <div className="flex items-center justify-between">
        <FacetFilter label="Category" options={SIGNAL_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c], count: counts[c] ?? 0 }))} selected={category} onChange={setCategory} />
        {can("signals", "approve") && (
          <Button onClick={() => onCreatingChange(true)}>
            <Plus /> New type
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        <DataTable columns={columns} data={rows} loading={isLoading} onRowClick={can("signals", "approve") ? (t) => setEditing(t) : undefined} dense />
      </div>
      <TypeDialog type={editing} open={!!editing || creating} onOpenChange={(o) => { if (!o) { setEditing(null); onCreatingChange(false); } }} />
    </div>
  );
}
