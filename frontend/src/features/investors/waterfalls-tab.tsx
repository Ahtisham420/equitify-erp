"use client";

import { ArrowDown, ArrowUp, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber, titleCase, toNumber } from "@/lib/utils";

import { HURDLE_TYPES, TIER_LABELS, TIER_TYPES, useAssetOptions, useSaveWaterfall, useWaterfalls, type Tier, type Waterfall } from "./api";

/* Tier values are edited in percent and stored as fractions (shares) or percent (IRR hurdles). */
interface TierDraft {
  tier_type: string;
  name: string;
  hurdle_type: string;
  hurdle_value: string;
  lp_pct: string;
  gp_pct: string;
  catch_up_rate: string;
  catch_up_target: string;
}

const STANDARD: TierDraft[] = [
  { tier_type: "return_of_capital", name: "", hurdle_type: "none", hurdle_value: "", lp_pct: "100", gp_pct: "0", catch_up_rate: "100", catch_up_target: "20" },
  { tier_type: "preferred_return", name: "", hurdle_type: "none", hurdle_value: "", lp_pct: "100", gp_pct: "0", catch_up_rate: "100", catch_up_target: "20" },
  { tier_type: "catch_up", name: "", hurdle_type: "none", hurdle_value: "", lp_pct: "100", gp_pct: "0", catch_up_rate: "100", catch_up_target: "20" },
  { tier_type: "split", name: "80/20 to 15% IRR", hurdle_type: "irr", hurdle_value: "15", lp_pct: "80", gp_pct: "20", catch_up_rate: "100", catch_up_target: "20" },
  { tier_type: "split", name: "70/30 thereafter", hurdle_type: "none", hurdle_value: "", lp_pct: "70", gp_pct: "30", catch_up_rate: "100", catch_up_target: "20" },
];

const toDraft = (t: Tier): TierDraft => ({
  tier_type: t.tier_type,
  name: t.name ?? "",
  hurdle_type: t.hurdle_type,
  hurdle_value: t.hurdle_value != null ? String(t.hurdle_value) : "",
  lp_pct: String(Math.round(t.lp_share * 10000) / 100),
  gp_pct: String(Math.round(t.gp_share * 10000) / 100),
  catch_up_rate: String(Math.round(t.catch_up_rate * 10000) / 100),
  catch_up_target: String(Math.round(t.catch_up_target * 10000) / 100),
});

function describeTier(t: Tier) {
  if (t.tier_type === "split") {
    const hurdle = t.hurdle_type === "irr" ? ` until ${formatNumber(t.hurdle_value, 2)}% LP IRR` : t.hurdle_type === "equity_multiple" ? ` until ${formatNumber(t.hurdle_value, 2)}x LP multiple` : " thereafter";
    return `${formatNumber(t.lp_share * 100, 2)}% LP / ${formatNumber(t.gp_share * 100, 2)}% GP${hurdle}`;
  }
  if (t.tier_type === "catch_up") return `${formatNumber(t.catch_up_rate * 100, 2)}% to GP until GP holds ${formatNumber(t.catch_up_target * 100, 2)}% of profit`;
  if (t.tier_type === "preferred_return") return "Accrued unpaid preferred return, pro rata";
  return "Unreturned capital, pro rata";
}

function WaterfallSheet({ open, onOpenChange, waterfall }: { open: boolean; onOpenChange: (o: boolean) => void; waterfall: Waterfall | null }) {
  const save = useSaveWaterfall(waterfall?.id);
  const assets = useAssetOptions(open);
  const [name, setName] = useState("");
  const [assetId, setAssetId] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [tiers, setTiers] = useState<TierDraft[]>(STANDARD);

  useEffect(() => {
    if (!open) return;
    setName(waterfall?.name ?? "");
    setAssetId(waterfall?.asset_id ?? "");
    setDescription(waterfall?.description ?? "");
    setActive(waterfall?.is_active ?? true);
    setTiers(waterfall ? waterfall.tiers.map(toDraft) : STANDARD);
  }, [open, waterfall]);

  const update = (i: number, patch: Partial<TierDraft>) => setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const move = (i: number, d: -1 | 1) =>
    setTiers((ts) => {
      const next = [...ts];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x);
      return next;
    });

  const submit = () => {
    const body = {
      name: name.trim(),
      asset_id: assetId || null,
      description: description.trim() || null,
      is_active: active,
      tiers: tiers.map((t, i) => ({
        position: i + 1,
        name: t.name.trim() || null,
        tier_type: t.tier_type,
        hurdle_type: t.tier_type === "split" ? t.hurdle_type : "none",
        hurdle_value: t.tier_type === "split" && t.hurdle_type !== "none" ? toNumber(t.hurdle_value) : null,
        lp_share: (toNumber(t.lp_pct) ?? 0) / 100,
        gp_share: (toNumber(t.gp_pct) ?? 0) / 100,
        catch_up_rate: (toNumber(t.catch_up_rate) ?? 100) / 100,
        catch_up_target: (toNumber(t.catch_up_target) ?? 20) / 100,
      })),
    };
    save.mutate(body, {
      onSuccess: () => {
        toast.success(waterfall ? "Waterfall saved — tier changes create a new version" : "Waterfall created");
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-3xl"
      title={waterfall ? `Edit waterfall · v${waterfall.version}` : "New waterfall"}
      description="Tiers run in order. Calculations snapshot the version used; approved events are re-verified if the configuration changes."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || tiers.length === 0} loading={save.isPending} onClick={submit}>
            Save waterfall
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fund I standard 8% pref" />
          </Field>
          <Field label="Asset scope" hint="Leave empty to make it available to any asset">
            <Select value={assetId} onChange={(e) => setAssetId(e.target.value)} placeholder="Any asset" options={(assets.data ?? []).map((a) => ({ value: a.id, label: a.label }))} />
          </Field>
          <Field label="Description" className="col-span-2">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={active} onChange={setActive} /> Active
          </label>
        </div>

        <div className="space-y-2">
          {tiers.map((t, i) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <span className="w-5 text-sm font-medium text-ink-3 tabular">{i + 1}.</span>
                <Select className="w-48" value={t.tier_type} onChange={(e) => update(i, { tier_type: e.target.value })} options={TIER_TYPES.map((x) => ({ value: x, label: TIER_LABELS[x] }))} />
                <Input className="flex-1" value={t.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Label (optional)" />
                <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp />
                </Button>
                <Button size="icon-sm" variant="ghost" disabled={i === tiers.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))} aria-label="Remove tier">
                  <Trash2 />
                </Button>
              </div>
              {t.tier_type === "split" && (
                <div className="mt-2 grid grid-cols-4 gap-2 pl-7">
                  <Field label="LP %">
                    <Input inputMode="decimal" value={t.lp_pct} onChange={(e) => update(i, { lp_pct: e.target.value, gp_pct: String(Math.max(0, 100 - (toNumber(e.target.value) ?? 0))) })} />
                  </Field>
                  <Field label="GP %">
                    <Input inputMode="decimal" value={t.gp_pct} onChange={(e) => update(i, { gp_pct: e.target.value, lp_pct: String(Math.max(0, 100 - (toNumber(e.target.value) ?? 0))) })} />
                  </Field>
                  <Field label="Hurdle">
                    <Select value={t.hurdle_type} onChange={(e) => update(i, { hurdle_type: e.target.value })} options={HURDLE_TYPES.map((h) => ({ value: h, label: h === "none" ? "None (thereafter)" : h === "irr" ? "LP IRR" : "LP equity multiple" }))} />
                  </Field>
                  <Field label={t.hurdle_type === "irr" ? "IRR %" : t.hurdle_type === "equity_multiple" ? "Multiple (x)" : "Hurdle value"}>
                    <Input inputMode="decimal" disabled={t.hurdle_type === "none"} value={t.hurdle_value} onChange={(e) => update(i, { hurdle_value: e.target.value })} />
                  </Field>
                </div>
              )}
              {t.tier_type === "catch_up" && (
                <div className="mt-2 grid grid-cols-2 gap-2 pl-7">
                  <Field label="Share of tier to GP %" hint="100% = full catch-up">
                    <Input inputMode="decimal" value={t.catch_up_rate} onChange={(e) => update(i, { catch_up_rate: e.target.value })} />
                  </Field>
                  <Field label="GP target share of profit %">
                    <Input inputMode="decimal" value={t.catch_up_target} onChange={(e) => update(i, { catch_up_target: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          ))}
          <Button size="sm" onClick={() => setTiers((ts) => [...ts, { ...STANDARD[4], name: "" }])}>
            <Plus /> Add tier
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function WaterfallsTab() {
  const { can } = useAuth();
  const { data, isLoading } = useWaterfalls();
  const [editing, setEditing] = useState<Waterfall | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-2">Distribution waterfalls used by distribution and liquidation events.</p>
        {can("investors", "approve") && (
          <Button variant="primary" onClick={() => { setEditing(null); setOpen(true); }}>
            <Plus /> New waterfall
          </Button>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<Layers />} title="No waterfalls configured" description="Define return of capital, preferred return, catch-up and promote tiers." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((w) => (
            <Card key={w.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {w.name} <Badge tone="outline">v{w.version}</Badge> {!w.is_active && <Badge>Inactive</Badge>}
                  </span>
                }
                description={`${w.asset_label ?? "Any asset"} · updated ${formatDate(w.updated_at)}`}
                actions={
                  can("investors", "approve") && (
                    <Button size="xs" variant="ghost" onClick={() => { setEditing(w); setOpen(true); }}>
                      <Pencil className="!size-3.5" /> Edit
                    </Button>
                  )
                }
              />
              <ol className="divide-y divide-line">
                {w.tiers.map((t) => (
                  <li key={t.id ?? t.position} className="flex items-start gap-3 px-4 py-2 text-sm">
                    <span className="w-4 text-ink-3 tabular">{t.position}</span>
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{t.name || TIER_LABELS[t.tier_type] || titleCase(t.tier_type)}</p>
                      <p className="text-xs text-ink-3">{describeTier(t)}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {w.description && <p className="border-t border-line px-4 py-2 text-xs text-ink-3">{w.description}</p>}
            </Card>
          ))}
        </div>
      )}
      <WaterfallSheet open={open} onOpenChange={setOpen} waterfall={editing} />
    </div>
  );
}
