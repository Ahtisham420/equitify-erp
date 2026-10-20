"use client";

import { Pencil, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, titleCase } from "@/lib/utils";

import { CHANNEL_LABELS, CHANNELS, RESTRICTIONS, useComplianceSettings, useRestrictions, useSaveRestriction, useSaveSettings, type Channel, type ComplianceSettings, type ProviderRestriction } from "./api";

type CapDraft = { count: string; period_days: string };

function capDraft(c?: { count: number; period_days: number }): CapDraft {
  return { count: c ? String(c.count) : "", period_days: c ? String(c.period_days) : "" };
}

function capValue(d: CapDraft) {
  if (d.count.trim() === "") return undefined;
  return { count: Math.max(0, Number(d.count) || 0), period_days: Math.max(1, Number(d.period_days) || 1) };
}

function CapInputs({ value, onChange, disabled }: { value: CapDraft; onChange: (v: CapDraft) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-2">
      <Input inputMode="numeric" value={value.count} onChange={(e) => onChange({ ...value, count: e.target.value })} className="w-20" disabled={disabled} placeholder="No cap" />
      <span>per</span>
      <Input inputMode="numeric" value={value.period_days} onChange={(e) => onChange({ ...value, period_days: e.target.value })} className="w-16" disabled={disabled} />
      <span>days</span>
    </div>
  );
}

function SettingsForm({ s, isAdmin }: { s: ComplianceSettings; isAdmin: boolean }) {
  const save = useSaveSettings();
  const [start, setStart] = useState(s.quiet_hours.start);
  const [end, setEnd] = useState(s.quiet_hours.end);
  const [qhChannels, setQhChannels] = useState<string[]>(s.quiet_hours.channels ?? []);
  const [offset, setOffset] = useState(String(s.quiet_hours.default_utc_offset ?? -6));
  const [perContact, setPerContact] = useState<CapDraft>(capDraft(s.frequency_caps.per_contact));
  const [channelCaps, setChannelCaps] = useState<Record<Channel, CapDraft>>({
    phone: capDraft(s.channel_caps.phone),
    sms: capDraft(s.channel_caps.sms),
    email: capDraft(s.channel_caps.email),
  });
  const [scrubDays, setScrubDays] = useState(String(s.scrub_validity_days));
  const [niDays, setNiDays] = useState(String(s.not_interested_suppression_days));
  const [reviewedAt, setReviewedAt] = useState(s.counsel_reviewed_at ?? "");
  const [reviewedBy, setReviewedBy] = useState(s.counsel_reviewed_by ?? "");

  const submit = () => {
    const caps: Partial<Record<Channel, { count: number; period_days: number }>> = {};
    for (const c of CHANNELS) {
      const v = capValue(channelCaps[c]);
      if (v) caps[c] = v;
    }
    const pc = capValue(perContact);
    save.mutate(
      {
        quiet_hours: { start, end, channels: qhChannels, default_utc_offset: Number(offset) || 0 },
        frequency_caps: pc ? { per_contact: pc } : {},
        channel_caps: caps,
        scrub_validity_days: Math.max(1, Number(scrubDays) || 31),
        not_interested_suppression_days: Math.max(0, Number(niDays) || 0),
        counsel_reviewed_at: reviewedAt || null,
        counsel_reviewed_by: reviewedBy.trim() || null,
      },
      { onSuccess: () => toast.success("Compliance settings saved"), onError: (e) => toast.error(errorMessage(e)) },
    );
  };

  return (
    <Card>
      <CardHeader
        title="Send-time rules"
        description={`Last changed ${formatDateTime(s.updated_at)}. Legal configuration must be reviewed by counsel before production campaigns.`}
        actions={
          isAdmin ? (
            <Button size="sm" variant="primary" loading={save.isPending} onClick={submit}>
              Save settings
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <fieldset disabled={!isAdmin} className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Quiet hours</h4>
            <div className="flex items-end gap-2">
              <Field label="Contact allowed from">
                <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="Until">
                <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </div>
            <p className="text-xs text-ink-3">Evaluated in the local time of the record&apos;s state; otherwise the default offset below.</p>
            <Field label="Default UTC offset (hours)">
              <Input inputMode="decimal" value={offset} onChange={(e) => setOffset(e.target.value)} className="w-24" />
            </Field>
            <div className="flex gap-4">
              {CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm text-ink-2">
                  <Checkbox checked={qhChannels.includes(c)} onChange={(on) => setQhChannels((cs) => (on ? [...cs, c] : cs.filter((x) => x !== c)))} />
                  {CHANNEL_LABELS[c]}
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Frequency & channel caps</h4>
            <Field label="Per contact (all channels)">
              <CapInputs value={perContact} onChange={setPerContact} disabled={!isAdmin} />
            </Field>
            {CHANNELS.map((c) => (
              <Field key={c} label={`${CHANNEL_LABELS[c]} per number/address`}>
                <CapInputs value={channelCaps[c]} onChange={(v) => setChannelCaps((cc) => ({ ...cc, [c]: v }))} disabled={!isAdmin} />
              </Field>
            ))}
          </section>

          <section className="space-y-3">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Scrubs & suppression</h4>
            <Field label="DNC scrub validity (days)" hint="Calls and texts are blocked once a scrub is older than this.">
              <Input inputMode="numeric" value={scrubDays} onChange={(e) => setScrubDays(e.target.value)} className="w-24" />
            </Field>
            <Field label="Suppress after “not interested” (days)" hint="0 disables automatic suppression.">
              <Input inputMode="numeric" value={niDays} onChange={(e) => setNiDays(e.target.value)} className="w-24" />
            </Field>
          </section>

          <section className="space-y-3">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Counsel review</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Reviewed on">
                <Input type="date" value={reviewedAt} onChange={(e) => setReviewedAt(e.target.value)} />
              </Field>
              <Field label="Reviewed by">
                <Input value={reviewedBy} onChange={(e) => setReviewedBy(e.target.value)} />
              </Field>
            </div>
            {!s.counsel_reviewed_at && <Badge tone="amber">Not yet reviewed by counsel</Badge>}
          </section>
        </fieldset>
        {!isAdmin && <p className="mt-4 text-xs text-ink-3">Only administrators can change compliance settings.</p>}
      </CardBody>
    </Card>
  );
}

function RestrictionDialog({ open, onOpenChange, restriction }: { open: boolean; onOpenChange: (o: boolean) => void; restriction: ProviderRestriction | null }) {
  const [form, setForm] = useState({ provider: "", restriction: "no_export", block_export: false, notes: "", is_active: true });
  const save = useSaveRestriction(restriction?.id);
  useEffect(() => {
    if (open) setForm(restriction ? { ...restriction, notes: restriction.notes ?? "" } : { provider: "", restriction: "no_export", block_export: false, notes: "", is_active: true });
  }, [open, restriction]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={restriction ? "Edit provider restriction" : "Flag provider restriction"}
      description="Exports that include data from this provider show a warning, or are blocked."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!form.provider.trim()}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { provider: form.provider.trim(), restriction: form.restriction, block_export: form.block_export, notes: form.notes.trim() || null, is_active: form.is_active },
                {
                  onSuccess: () => {
                    toast.success("Restriction saved");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Provider" required>
          <Input value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))} disabled={!!restriction} />
        </Field>
        <Field label="Restriction">
          <Select value={form.restriction} onChange={(e) => setForm((f) => ({ ...f, restriction: e.target.value }))} options={RESTRICTIONS.map((r) => ({ value: r, label: titleCase(r) }))} />
        </Field>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={form.block_export} onChange={(v) => setForm((f) => ({ ...f, block_export: v }))} />
          Block exports (not just warn)
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={form.is_active} onChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
          Active
        </label>
      </div>
    </Dialog>
  );
}

export function SettingsTab() {
  const { user, can } = useAuth();
  const isAdmin = !!user?.permissions["*"]?.includes("*");
  const { data: settings, isLoading } = useComplianceSettings();
  const { data: restrictions = [] } = useRestrictions();
  const [editing, setEditing] = useState<ProviderRestriction | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-5">
      {isLoading || !settings ? <Skeleton className="h-64 w-full" /> : <SettingsForm key={settings.updated_at} s={settings} isAdmin={isAdmin} />}

      <Card>
        <CardHeader
          title="Enrichment provider restrictions"
          description="Usage restrictions on purchased or enriched data; drives export warnings and blocks."
          actions={
            can("compliance", "edit") ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> Flag provider
              </Button>
            ) : undefined
          }
        />
        {restrictions.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">No provider restrictions flagged.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-subtle text-left text-xs text-ink-3">
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-3 py-2 font-medium">Restriction</th>
                <th className="px-3 py-2 font-medium">Export</th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {restrictions.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 font-medium text-ink">{r.provider}</td>
                  <td className="px-3 py-2 text-ink-2">{titleCase(r.restriction)}</td>
                  <td className="px-3 py-2">{r.block_export ? <Badge tone="red">Blocked</Badge> : <Badge tone="amber">Warn</Badge>}</td>
                  <td className="max-w-[320px] truncate px-3 py-2 text-xs text-ink-2">{r.notes ?? "—"}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.is_active ? "active" : "inactive"} /></td>
                  <td className="px-3 py-2 text-right">
                    {can("compliance", "edit") && (
                      <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(r)}>
                        <Pencil />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <RestrictionDialog open={creating || !!editing} onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }} restriction={editing} />
    </div>
  );
}
