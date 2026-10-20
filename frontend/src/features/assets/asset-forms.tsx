"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { StatCard } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, titleCase, toNumber } from "@/lib/utils";

import {
  ASSET_STATUSES,
  CATEGORY_LABELS,
  DIMENSIONS,
  FIN_CATEGORIES,
  MILESTONE_STATUSES,
  TRIGGER_LABELS,
  useAddFinancial,
  useAssetSettings,
  useBulkFinancials,
  useDeleteLimit,
  useExplainVariance,
  useResolveWatch,
  useReviewVariance,
  useSaveAsset,
  useSaveAssetSettings,
  useSaveLimit,
  useSaveMilestone,
  type Asset,
  type AssetInput,
  type AssetSettings,
  type ConcentrationLimit,
  type Dimension,
  type FinCategory,
  type FinancialInput,
  type Metric,
  type Milestone,
  type Variance,
  type WatchEntry,
} from "./api";

/* ------------------------------------------------------------------ shared display helpers */

export const STATUS_LABELS: Record<string, string> = { active: "Active", held_for_sale: "Held for sale", disposed: "Disposed" };

export function AssetStatusBadge({ status }: { status: string }) {
  if (status === "held_for_sale") return <Badge tone="amber" dot>Held for sale</Badge>;
  if (status === "disposed") return <Badge tone="neutral" dot>Disposed</Badge>;
  return <StatusBadge status={status} />;
}

const VARIANCE_TONES: Record<string, { tone: "amber" | "blue" | "green" | "red"; label: string }> = {
  required: { tone: "amber", label: "Explanation required" },
  submitted: { tone: "blue", label: "Submitted" },
  accepted: { tone: "green", label: "Accepted" },
  rejected: { tone: "red", label: "Rejected" },
};

export function VarianceStatusBadge({ status }: { status: string }) {
  const t = VARIANCE_TONES[status] ?? { tone: "amber" as const, label: titleCase(status) };
  return <Badge tone={t.tone} dot>{t.label}</Badge>;
}

export function MilestoneStatusBadge({ status }: { status: string }) {
  if (status === "missed") return <Badge tone="red" dot>Missed</Badge>;
  if (status === "planned") return <Badge tone="neutral" dot>Planned</Badge>;
  return <StatusBadge status={status} />;
}

export function coverageTone(v: number | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  return v < 1 ? "text-negative" : v < 1.25 ? "text-caution" : undefined;
}

/** Formats a KPI by key. Percent values arrive as 0–100. */
export function formatMetric(key: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  switch (key) {
    case "value":
    case "noi":
    case "debt":
      return formatCurrency(value, { compact: true });
    case "occupancy":
    case "leverage":
      return formatPercent(value, 1);
    case "yield_on_cost":
      return formatPercent(value, 2);
    case "wale":
      return `${formatNumber(value, 1)} yrs`;
    case "coverage":
      return `${formatNumber(value, 2)}x`;
    default:
      return formatNumber(value, 2);
  }
}

const METRIC_LABELS: Record<string, string> = {
  value: "Value", noi: "NOI (TTM)", occupancy: "Occupancy", wale: "WALE", yield_on_cost: "Yield on cost",
  leverage: "Leverage", coverage: "Coverage (DSCR)", debt: "Debt",
};

/** KPI cards; every card drills to the record(s) the number is computed from. */
export function MetricCards({ metrics, keys, className }: { metrics: Record<string, Metric>; keys: string[]; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-4", className)}>
      {keys.map((k) => {
        const m = metrics[k];
        if (!m) return null;
        const src = m.source ?? m.drill[0]?.label;
        const tone = k === "coverage" && m.value !== null ? (m.value < 1 ? "negative" : m.value < 1.25 ? "caution" : "default") : "default";
        return (
          <StatCard
            key={k}
            label={METRIC_LABELS[k] ?? m.label ?? titleCase(k)}
            value={formatMetric(k, m.value)}
            href={m.drill[0]?.href}
            tone={tone}
            hint={src ? `Source: ${src}${m.drill.length > 1 ? ` +${m.drill.length - 1}` : ""}` : "No source data"}
          />
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ asset form */

type FormState = Record<string, string>;
const TEXT_FIELDS = ["status", "acquired_on", "value_as_of", "hold_thesis", "business_plan", "target_exit_on", "notes"] as const;
const NUMBER_FIELDS = ["basis", "equity_invested", "current_value", "target_hold_years", "exit_cap_rate"] as const;
const MATERIAL = ["basis", "current_value", "acquired_on", "exit_cap_rate", "target_hold_years", "equity_invested"];

function toForm(a?: Asset | null): FormState {
  const s: FormState = { status: "active" };
  if (!a) return s;
  for (const k of [...TEXT_FIELDS, ...NUMBER_FIELDS]) {
    const v = (a as unknown as Record<string, unknown>)[k];
    s[k] = v === null || v === undefined ? "" : String(v);
  }
  return s;
}

export function AssetFormSheet({
  open,
  onOpenChange,
  asset,
  propertyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  asset?: Asset | null;
  propertyId?: string;
  onSaved?: (a: Asset) => void;
}) {
  const [form, setForm] = useState<FormState>(toForm(asset));
  const [property, setProperty] = useState<string | null>(propertyId ?? null);
  const [manager, setManager] = useState<string | null>(asset?.manager_id ?? null);
  const [source, setSource] = useState({ source: "Manual entry", observed_on: "", confidence: "80", verified: false });
  const save = useSaveAsset(asset?.id);

  useEffect(() => {
    if (open) {
      setForm(toForm(asset));
      setProperty(asset?.property_id ?? propertyId ?? null);
      setManager(asset?.manager_id ?? null);
    }
  }, [open, asset, propertyId]);

  const bind = (key: string) => ({
    id: key,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const materialChanged = !asset || MATERIAL.some((k) => (form[k] ?? "") !== toForm(asset)[k]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!asset && !property) {
      toast.error("Select a property");
      return;
    }
    const data: Record<string, unknown> = {};
    for (const k of TEXT_FIELDS) {
      const v = form[k]?.trim() ?? "";
      if (asset || v) data[k] = v === "" ? null : v;
    }
    for (const k of NUMBER_FIELDS) {
      const n = toNumber(form[k] ?? "");
      if (asset || n !== null) data[k] = n;
    }
    data.status = form.status || "active";
    data.manager_id = manager;
    if (!asset) data.property_id = property;
    data.provenance = {
      source: source.source.trim() || "Manual entry",
      observed_on: source.observed_on || null,
      confidence: Math.min(100, Math.max(0, Number(source.confidence) || 0)) / 100,
      verified: source.verified,
    };
    save.mutate(data as AssetInput, {
      onSuccess: (a) => {
        toast.success(asset ? "Asset updated" : "Asset record created");
        onOpenChange(false);
        onSaved?.(a);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={asset ? "Edit asset" : "New asset record"}
      description={asset ? asset.property_label : "An owned property tracked against its business plan and acquisition underwriting."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="asset-form" loading={save.isPending}>
            {asset ? "Save changes" : "Create asset"}
          </Button>
        </>
      }
    >
      <form id="asset-form" onSubmit={submit} className="space-y-6">
        <Section title="Record">
          {!asset && (
            <Field label="Property" required className="col-span-2">
              <PropertyPicker value={property} onChange={(id) => setProperty(id)} />
            </Field>
          )}
          <Field label="Status">
            <Select {...bind("status")} options={ASSET_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
          </Field>
          <Field label="Asset manager">
            <UserPicker value={manager} onChange={setManager} />
          </Field>
          <Field label="Acquired on"><Input type="date" {...bind("acquired_on")} /></Field>
          <Field label="Basis ($)"><Input {...bind("basis")} inputMode="decimal" /></Field>
          <Field label="Equity invested ($)"><Input {...bind("equity_invested")} inputMode="decimal" /></Field>
          <Field label="Current value ($)"><Input {...bind("current_value")} inputMode="decimal" /></Field>
          <Field label="Value as of"><Input type="date" {...bind("value_as_of")} /></Field>
        </Section>

        <Section title="Business plan">
          <Field label="Hold thesis" className="col-span-2"><Textarea {...bind("hold_thesis")} /></Field>
          <Field label="Business plan" className="col-span-2"><Textarea rows={4} {...bind("business_plan")} /></Field>
          <Field label="Target hold (years)"><Input {...bind("target_hold_years")} inputMode="decimal" /></Field>
          <Field label="Exit cap rate (%)"><Input {...bind("exit_cap_rate")} inputMode="decimal" /></Field>
          <Field label="Target exit date"><Input type="date" {...bind("target_exit_on")} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>

        {materialChanged && (
          <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
            <div>
              <h4 className="text-sm font-medium">Source of these facts</h4>
              <p className="text-xs text-ink-3">Basis, value, acquisition date, equity, hold and exit assumptions keep this source, date and confidence in their history.</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Source" className="col-span-3">
                <Input value={source.source} onChange={(e) => setSource((s) => ({ ...s, source: e.target.value }))} />
              </Field>
              <Field label="Observed on" className="col-span-2">
                <Input type="date" value={source.observed_on} onChange={(e) => setSource((s) => ({ ...s, observed_on: e.target.value }))} />
              </Field>
              <Field label="Confidence %">
                <Input inputMode="numeric" value={source.confidence} onChange={(e) => setSource((s) => ({ ...s, confidence: e.target.value }))} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={source.verified} onChange={(v) => setSource((s) => ({ ...s, verified: v }))} />
              I verified these values against the source
            </label>
          </section>
        )}
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ financials */

interface ParsedRow {
  line: number;
  data: FinancialInput | null;
  raw: string[];
  errors: string[];
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === "\t") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function normPeriod(v: string): string | null {
  const m = v.trim().match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/) ?? null;
  if (m) {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? `${m[1]}-${String(mo).padStart(2, "0")}-01` : null;
  }
  const us = v.trim().match(/^(\d{1,2})\/(\d{4})$/);
  if (us) {
    const mo = Number(us[1]);
    return mo >= 1 && mo <= 12 ? `${us[2]}-${String(mo).padStart(2, "0")}-01` : null;
  }
  return null;
}

function normCategory(v: string): FinCategory | null {
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((FIN_CATEGORIES as readonly string[]).includes(k)) return k as FinCategory;
  const byLabel = Object.entries(CATEGORY_LABELS).find(([, label]) => label.toLowerCase() === v.trim().toLowerCase());
  return byLabel && (FIN_CATEGORIES as readonly string[]).includes(byLabel[0]) ? (byLabel[0] as FinCategory) : null;
}

function normAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replace(/[$,\s]/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

function validate(line: number, raw: string[], period: unknown, account: unknown, category: unknown, amount: unknown, notes: unknown): ParsedRow {
  const errors: string[] = [];
  const p = typeof period === "string" ? normPeriod(period) : null;
  if (!p) errors.push("period must be YYYY-MM");
  const acct = typeof account === "string" ? account.trim() : "";
  if (!acct) errors.push("account is required");
  else if (acct.length > 120) errors.push("account is too long");
  const cat = typeof category === "string" ? normCategory(category) : null;
  if (!cat) errors.push(`category must be one of ${FIN_CATEGORIES.join(", ")}`);
  const amt = normAmount(amount);
  if (amt === null) errors.push("amount must be a number");
  const n = typeof notes === "string" && notes.trim() ? notes.trim() : null;
  return { line, raw, errors, data: errors.length ? null : { period: p!, account: acct, category: cat!, amount: amt!, notes: n } };
}

export function parseFinancialText(text: string): { rows: ParsedRow[]; error: string | null } {
  const t = text.trim();
  if (!t) return { rows: [], error: null };
  if (t.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(t);
    } catch (e) {
      return { rows: [], error: `Invalid JSON: ${(e as Error).message}` };
    }
    if (!Array.isArray(arr)) return { rows: [], error: "JSON must be an array of rows" };
    return {
      error: null,
      rows: arr.map((o, i) => {
        const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
        const raw = [r.period, r.account, r.category, r.amount].map((x) => (x === undefined || x === null ? "" : String(x)));
        return validate(i + 1, raw, r.period, r.account, r.category, r.amount, r.notes);
      }),
    };
  }
  const lines = t.split(/\r?\n/).map((l, i) => ({ l, i: i + 1 })).filter((x) => x.l.trim());
  if (lines.length && /^\s*period\b/i.test(lines[0].l)) lines.shift();
  return {
    error: null,
    rows: lines.map(({ l, i }) => {
      const cells = splitCsv(l);
      const v = validate(i, cells, cells[0], cells[1], cells[2], cells[3], cells.slice(4).join(", "));
      if (cells.length < 4) v.errors.unshift("expected period, account, category, amount");
      return v.errors.length ? { ...v, data: null } : v;
    }),
  };
}

export function FinancialEntrySheet({ open, onOpenChange, assetId }: { open: boolean; onOpenChange: (o: boolean) => void; assetId: string }) {
  const [mode, setMode] = useState("single");
  const [single, setSingle] = useState({ period: "", account: "", category: "income", amount: "", notes: "" });
  const [text, setText] = useState("");
  const add = useAddFinancial(assetId);
  const bulk = useBulkFinancials(assetId);
  const parsed = useMemo(() => parseFinancialText(text), [text]);
  const valid = parsed.rows.filter((r) => r.data);
  const invalid = parsed.rows.filter((r) => !r.data);

  useEffect(() => {
    if (open) {
      setSingle({ period: new Date().toISOString().slice(0, 7), account: "", category: "income", amount: "", notes: "" });
      setText("");
    }
  }, [open]);

  const submitSingle = (e: FormEvent) => {
    e.preventDefault();
    const amount = toNumber(single.amount);
    if (!single.period || !single.account.trim() || amount === null) {
      toast.error("Period, account and amount are required");
      return;
    }
    add.mutate(
      { period: `${single.period}-01`, account: single.account.trim(), category: single.category as FinCategory, amount, notes: single.notes.trim() || null },
      {
        onSuccess: () => {
          toast.success("Financial entry saved");
          setSingle((s) => ({ ...s, account: "", amount: "", notes: "" }));
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const submitBulk = () =>
    bulk.mutate(
      { rows: valid.map((r) => r.data!), source: "import" },
      {
        onSuccess: (r) => {
          toast.success(`${formatNumber(r.rows)} rows: ${r.created} created, ${r.superseded} superseded, ${r.unchanged} unchanged`);
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add financials"
      description="Monthly actuals by account. A new amount for an existing period and account supersedes the prior value, which is kept in history."
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          {mode === "single" ? (
            <Button variant="primary" type="submit" form="fin-single" loading={add.isPending}>
              Save entry
            </Button>
          ) : (
            <Button variant="primary" disabled={!valid.length || invalid.length > 0 || !!parsed.error} loading={bulk.isPending} onClick={submitBulk}>
              Import {formatNumber(valid.length)} rows
            </Button>
          )}
        </>
      }
    >
      <Tabs value={mode} onValueChange={setMode}>
        <TabList tabs={[{ value: "single", label: "Single entry" }, { value: "bulk", label: "Bulk paste" }]} className="mb-4" />
        <TabPanel value="single">
          <form id="fin-single" onSubmit={submitSingle} className="grid grid-cols-2 gap-3">
            <Field label="Period" required>
              <Input type="month" value={single.period} onChange={(e) => setSingle((s) => ({ ...s, period: e.target.value }))} required />
            </Field>
            <Field label="Category" required>
              <Select value={single.category} onChange={(e) => setSingle((s) => ({ ...s, category: e.target.value }))} options={FIN_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} />
            </Field>
            <Field label="Account" required className="col-span-2" hint="e.g. Base rent, CAM recoveries, Property tax, Insurance">
              <Input value={single.account} onChange={(e) => setSingle((s) => ({ ...s, account: e.target.value }))} maxLength={120} required />
            </Field>
            <Field label="Amount ($)" required>
              <Input inputMode="decimal" value={single.amount} onChange={(e) => setSingle((s) => ({ ...s, amount: e.target.value }))} required />
            </Field>
            <Field label="Notes" className="col-span-2">
              <Textarea value={single.notes} onChange={(e) => setSingle((s) => ({ ...s, notes: e.target.value }))} rows={2} />
            </Field>
          </form>
        </TabPanel>
        <TabPanel value="bulk" className="space-y-3">
          <Field label="Rows" hint="CSV: period,account,category,amount[,notes] — one row per line, header optional. Or a JSON array of {period, account, category, amount, notes}.">
            <Textarea
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="font-mono text-xs"
              placeholder={"period,account,category,amount,notes\n2026-01,Base rent,income,42500\n2026-01,Property tax,expense,6100"}
            />
          </Field>
          {parsed.error && <p className="text-sm text-negative">{parsed.error}</p>}
          {parsed.rows.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-ink-3">
                <span className="font-medium text-ink">{formatNumber(valid.length)}</span> valid
                {invalid.length > 0 && (
                  <>
                    {" · "}
                    <span className="font-medium text-negative">{formatNumber(invalid.length)} with errors</span> — fix them to import
                  </>
                )}
              </p>
              <div className="max-h-80 overflow-auto rounded-md border border-line scrollbar-thin">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-subtle text-ink-3">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Line</th>
                      <th className="px-2 py-1.5 text-left font-medium">Period</th>
                      <th className="px-2 py-1.5 text-left font-medium">Account</th>
                      <th className="px-2 py-1.5 text-left font-medium">Category</th>
                      <th className="px-2 py-1.5 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 300).map((r) => (
                      <tr key={r.line} className={cn("border-t border-line", !r.data && "bg-negative-soft/60")}>
                        <td className="px-2 py-1 text-ink-3 tabular">{r.line}</td>
                        {r.data ? (
                          <>
                            <td className="px-2 py-1">{formatDate(r.data.period, "MMM yyyy")}</td>
                            <td className="px-2 py-1">{r.data.account}</td>
                            <td className="px-2 py-1 text-ink-2">{CATEGORY_LABELS[r.data.category]}</td>
                            <td className="px-2 py-1 text-right tabular">{formatCurrency(r.data.amount)}</td>
                          </>
                        ) : (
                          <td colSpan={4} className="px-2 py-1">
                            <span className="text-ink-2">{r.raw.join(" · ") || "(empty)"}</span>
                            <span className="ml-2 text-negative">{r.errors.join("; ")}</span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsed.rows.length > 300 && <p className="text-xs text-ink-3">Showing the first 300 rows.</p>}
            </div>
          )}
        </TabPanel>
      </Tabs>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ milestones */

export function MilestoneSheet({
  open,
  onOpenChange,
  assetId,
  milestone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  assetId: string;
  milestone?: Milestone | null;
}) {
  const [f, setF] = useState({ title: "", description: "", due_on: "", status: "planned" });
  const [owner, setOwner] = useState<string | null>(null);
  const save = useSaveMilestone(assetId);

  useEffect(() => {
    if (open) {
      setF({ title: milestone?.title ?? "", description: milestone?.description ?? "", due_on: milestone?.due_on ?? "", status: milestone?.status ?? "planned" });
      setOwner(milestone?.owner_id ?? null);
    }
  }, [open, milestone]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        id: milestone?.id,
        data: { title: f.title.trim(), description: f.description.trim() || null, owner_id: owner, due_on: f.due_on || null, status: f.status },
      },
      {
        onSuccess: () => {
          toast.success(milestone ? "Milestone updated" : "Milestone added");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={milestone ? "Edit milestone" : "New milestone"}
      description="Business plan milestones with an owner and due date create follow-up tasks."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="milestone-form" loading={save.isPending} disabled={!f.title.trim()}>
            {milestone ? "Save changes" : "Add milestone"}
          </Button>
        </>
      }
    >
      <form id="milestone-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Title" required className="col-span-2">
          <Input value={f.title} onChange={(e) => setF((s) => ({ ...s, title: e.target.value }))} maxLength={200} required />
        </Field>
        <Field label="Description" className="col-span-2">
          <Textarea value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} />
        </Field>
        <Field label="Owner">
          <UserPicker value={owner} onChange={setOwner} />
        </Field>
        <Field label="Due date">
          <Input type="date" value={f.due_on} onChange={(e) => setF((s) => ({ ...s, due_on: e.target.value }))} />
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={(e) => setF((s) => ({ ...s, status: e.target.value }))} options={MILESTONE_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Field>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ variances */

export interface VarianceTarget {
  period: string;
  window: "month" | "ttm";
  basis: "budget" | "underwriting";
  account: string;
  actual: number | null;
  benchmark: number | null;
  variance?: number | null;
  variance_pct?: number | null;
  explanation?: string | null;
}

function VarianceFacts({ t }: { t: VarianceTarget }) {
  const variance = t.variance ?? (t.actual !== null && t.benchmark !== null ? t.actual - t.benchmark : null);
  return (
    <dl className="mb-4 grid grid-cols-3 gap-x-4 gap-y-2 rounded-lg border border-line bg-subtle/60 p-3 text-sm">
      <div className="col-span-3">
        <dt className="text-xs text-ink-3">Account</dt>
        <dd className="font-medium text-ink">{t.account}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-3">Window</dt>
        <dd>{t.window === "ttm" ? "Trailing 12 months" : "Month"} to {formatDate(t.period, "MMM yyyy")}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-3">Basis</dt>
        <dd>{t.basis === "budget" ? "Budget" : "Underwriting"}</dd>
      </div>
      <div />
      <div>
        <dt className="text-xs text-ink-3">Actual</dt>
        <dd className="tabular">{formatCurrency(t.actual)}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-3">Benchmark</dt>
        <dd className="tabular">{formatCurrency(t.benchmark)}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-3">Variance</dt>
        <dd className="tabular">
          {formatCurrency(variance)}
          {t.variance_pct !== null && t.variance_pct !== undefined && <span className="text-ink-3"> · {formatPercent(t.variance_pct, 1)}</span>}
        </dd>
      </div>
    </dl>
  );
}

export function ExplainVarianceDialog({
  open,
  onOpenChange,
  assetId,
  target,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  assetId: string;
  target: VarianceTarget | null;
}) {
  const [text, setText] = useState("");
  const explain = useExplainVariance(assetId);

  useEffect(() => {
    if (open) setText(target?.explanation ?? "");
  }, [open, target]);

  const submit = () => {
    if (!target) return;
    explain.mutate(
      { period: target.period, window: target.window, basis: target.basis, account: target.account, actual: target.actual, benchmark: target.benchmark, explanation: text.trim() },
      {
        onSuccess: () => {
          toast.success("Explanation submitted for review");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Explain variance"
      description="Explanations are reviewed by an approver and kept with the period."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={text.trim().length < 3} loading={explain.isPending} onClick={submit}>
            Submit explanation
          </Button>
        </>
      }
    >
      {target && <VarianceFacts t={target} />}
      <Field label="Explanation" required>
        <Textarea autoFocus rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="What drove the variance, and is it timing or permanent?" />
      </Field>
    </Dialog>
  );
}

export function ReviewVarianceDialog({ open, onOpenChange, variance }: { open: boolean; onOpenChange: (o: boolean) => void; variance: Variance | null }) {
  const { can } = useAuth();
  const [note, setNote] = useState("");
  const review = useReviewVariance();

  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  const decide = (decision: "accepted" | "rejected") => {
    if (!variance) return;
    review.mutate(
      { id: variance.id, decision, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(decision === "accepted" ? "Explanation accepted" : "Explanation rejected");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const allowed = can("assets", "approve");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Review explanation"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" disabled={!allowed || (!note.trim())} loading={review.isPending} onClick={() => decide("rejected")}>
            Reject
          </Button>
          <Button variant="primary" disabled={!allowed} loading={review.isPending} onClick={() => decide("accepted")}>
            Accept
          </Button>
        </>
      }
    >
      {variance && (
        <>
          <VarianceFacts t={variance} />
          <div className="mb-4">
            <p className="text-xs text-ink-3">Explanation{variance.owner_name ? ` · ${variance.owner_name}` : ""}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{variance.explanation ?? "—"}</p>
          </div>
        </>
      )}
      <Field label="Review note" hint="Required when rejecting.">
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {!allowed && <p className="mt-2 text-xs text-caution">Reviewing explanations requires approval permission.</p>}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ concentration limits */

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export function LimitSheet({
  open,
  onOpenChange,
  limit,
  defaultDimension,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  limit?: ConcentrationLimit | null;
  defaultDimension?: Dimension;
}) {
  const [f, setF] = useState({ dimension: "tenant" as Dimension, key: "", max_pct: "", severity: "medium", is_active: true, notes: "" });
  const [deleting, setDeleting] = useState(false);
  const save = useSaveLimit();
  const remove = useDeleteLimit();

  useEffect(() => {
    if (open)
      setF({
        dimension: limit?.dimension ?? defaultDimension ?? "tenant",
        key: limit?.key ?? "",
        max_pct: limit ? String(limit.max_pct) : "",
        severity: limit?.severity ?? "medium",
        is_active: limit?.is_active ?? true,
        notes: limit?.notes ?? "",
      });
  }, [open, limit, defaultDimension]);

  const max = toNumber(f.max_pct);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (max === null || max <= 0 || max > 100) {
      toast.error("Maximum must be between 0 and 100%");
      return;
    }
    save.mutate(
      { id: limit?.id, data: { dimension: f.dimension, key: f.key.trim() || null, max_pct: max, severity: f.severity, is_active: f.is_active, notes: f.notes.trim() || null } },
      {
        onSuccess: () => {
          toast.success(limit ? "Limit updated" : "Limit created");
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={limit ? "Edit concentration limit" : "New concentration limit"}
        description="Exposure above the maximum share raises an alert when limits are checked."
        footer={
          <>
            {limit && (
              <Button variant="ghost" className="mr-auto text-negative" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="limit-form" loading={save.isPending}>
              {limit ? "Save changes" : "Create limit"}
            </Button>
          </>
        }
      >
        <form id="limit-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
          <Field label="Dimension" required>
            <Select value={f.dimension} onChange={(e) => setF((s) => ({ ...s, dimension: e.target.value as Dimension }))} options={DIMENSIONS.map((d) => ({ value: d, label: titleCase(d) }))} />
          </Field>
          <Field label="Maximum share (%)" required>
            <Input inputMode="decimal" value={f.max_pct} onChange={(e) => setF((s) => ({ ...s, max_pct: e.target.value }))} required />
          </Field>
          <Field label="Specific item" hint="Leave blank to apply to every item in the dimension." className="col-span-2">
            <Input value={f.key} onChange={(e) => setF((s) => ({ ...s, key: e.target.value }))} placeholder="e.g. Dollar General, TX" />
          </Field>
          <Field label="Severity">
            <Select value={f.severity} onChange={(e) => setF((s) => ({ ...s, severity: e.target.value }))} options={SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={f.is_active} onChange={(v) => setF((s) => ({ ...s, is_active: v }))} /> Active
            </label>
          </div>
          <Field label="Notes" className="col-span-2">
            <Textarea value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} rows={2} />
          </Field>
        </form>
      </Sheet>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this limit?"
        description="The limit stops being checked. Past alerts are kept."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          limit &&
          remove.mutate(limit.id, {
            onSuccess: () => {
              toast.success("Limit deleted");
              setDeleting(false);
              onOpenChange(false);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ watchlist */

export function ResolveWatchDialog({ open, onOpenChange, entry }: { open: boolean; onOpenChange: (o: boolean) => void; entry: WatchEntry | null }) {
  const [status, setStatus] = useState<"resolved" | "dismissed">("resolved");
  const [note, setNote] = useState("");
  const resolve = useResolveWatch();

  useEffect(() => {
    if (open) {
      setStatus("resolved");
      setNote("");
    }
  }, [open]);

  const submit = () => {
    if (!entry) return;
    resolve.mutate(
      { id: entry.id, status, note: note.trim() },
      {
        onSuccess: () => {
          toast.success(status === "resolved" ? "Watchlist entry resolved" : "Watchlist entry dismissed");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Close watchlist entry"
      description={entry ? `${TRIGGER_LABELS[entry.trigger] ?? titleCase(entry.trigger)} · ${entry.asset_label ?? "Asset"}` : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={note.trim().length < 3} loading={resolve.isPending} onClick={submit}>
            {status === "resolved" ? "Resolve" : "Dismiss"}
          </Button>
        </>
      }
    >
      {entry?.detail && <p className="mb-3 rounded-md border border-line bg-subtle/60 px-3 py-2 text-sm text-ink-2">{entry.detail}</p>}
      <div className="grid gap-3">
        <Field label="Outcome">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as "resolved" | "dismissed")}
            options={[
              { value: "resolved", label: "Resolved — the condition was addressed" },
              { value: "dismissed", label: "Dismissed — not a real concern" },
            ]}
          />
        </Field>
        <Field label="Note" required hint="A scan reopens the entry if the condition is still present.">
          <Textarea autoFocus rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ settings */

const SETTING_FIELDS: { key: keyof AssetSettings; label: string; hint?: string; int?: boolean }[] = [
  { key: "variance_pct", label: "Variance threshold (%)", hint: "Flag when the variance is at least this share of the benchmark…" },
  { key: "variance_amount", label: "Variance threshold ($)", hint: "…and at least this amount." },
  { key: "watch_min_dscr", label: "Minimum coverage (DSCR)" },
  { key: "watch_min_occupancy", label: "Minimum occupancy (%)" },
  { key: "maturity_months", label: "Debt maturity window (months)", int: true },
  { key: "persistent_variance_months", label: "Persistent variance (months)", int: true },
  { key: "maintenance_backlog", label: "Open work order backlog", int: true },
  { key: "maintenance_overdue_days", label: "Work order overdue (days)", int: true },
];

export function AssetSettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const { data } = useAssetSettings();
  const save = useSaveAssetSettings();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open && data) setForm(Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, String(data[f.key] ?? "")])));
  }, [open, data]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const out: Record<string, number> = {};
    for (const f of SETTING_FIELDS) {
      const n = toNumber(form[f.key] ?? "");
      if (n === null) {
        toast.error(`${f.label} is required`);
        return;
      }
      out[f.key] = f.int ? Math.round(n) : n;
    }
    save.mutate(out as unknown as AssetSettings, {
      onSuccess: () => {
        toast.success("Asset settings saved");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const allowed = can("assets", "approve");
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Asset management settings"
      description="Variance flags and watchlist triggers used across the portfolio."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="asset-settings" disabled={!allowed || !data} loading={save.isPending}>
            Save settings
          </Button>
        </>
      }
    >
      <form id="asset-settings" onSubmit={submit} className="space-y-6">
        <Section title="Variance">
          {SETTING_FIELDS.slice(0, 2).map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Input inputMode="decimal" value={form[f.key] ?? ""} disabled={!allowed} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
            </Field>
          ))}
        </Section>
        <Section title="Watchlist triggers">
          {SETTING_FIELDS.slice(2).map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              <Input inputMode="decimal" value={form[f.key] ?? ""} disabled={!allowed} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
            </Field>
          ))}
        </Section>
        {!allowed && <p className="text-xs text-caution">Changing settings requires approval permission.</p>}
      </form>
    </Sheet>
  );
}
