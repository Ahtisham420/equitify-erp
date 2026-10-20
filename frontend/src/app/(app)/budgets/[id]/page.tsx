"use client";

import { Archive, ArrowRight, Check, Copy, Download, MoreHorizontal, Plus, Send, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, titleCase, toNumber } from "@/lib/utils";

import {
  BUDGET_CATEGORIES,
  useArchiveBudget,
  useBudget,
  useBudgetAction,
  type Budget,
  type Decision,
  type GridRow,
  type LineCell,
} from "@/features/operations/api";
import { OpsStatusBadge, Segmented } from "@/features/operations/insurance-tabs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type Category = GridRow["category"];
type View = "budget" | "reforecast" | "prior_actual" | "actual";

const VIEW_LABELS: Record<View, string> = { budget: "Budget", reforecast: "Reforecast", prior_actual: "Prior actual", actual: "Actual" };
const CATEGORY_TITLES: Record<Category, string> = { income: "Income", expense: "Expenses", capex: "Capital expenditures" };

/** Edits are kept as raw strings keyed by account + month until saved. */
type EditKey = `${string}|${number}`;
const ek = (account: string, month: number): EditKey => `${account}|${month}`;

interface WorkingRow {
  account: string;
  category: Category;
  budget: (number | null)[];
  reforecast: (number | null)[];
  prior_actual: (number | null)[];
  actual: (number | null)[];
  isNew: boolean;
  variance: number | null;
  variance_pct: number | null;
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((a, v) => a + (v ?? 0), 0);
const anyValue = (xs: (number | null)[]) => xs.some((v) => v !== null && v !== undefined);
const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatNumber(v, 0));

/** Disabled buttons swallow pointer events, so the tooltip sits on a wrapper. */
function Gate({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className="inline-flex rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
        {children}
      </span>
    </Tooltip>
  );
}

function CellInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.target.select()}
      className="h-7 w-[84px] rounded border border-transparent bg-transparent px-1.5 text-right text-sm tabular text-ink placeholder:text-ink-3 hover:border-line focus:border-accent focus:bg-surface focus:outline-none"
    />
  );
}

/* ------------------------------------------------------------------ dialogs */

function AddAccountDialog({
  open,
  onOpenChange,
  existing,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  existing: string[];
  onAdd: (account: string, category: Category) => void;
}) {
  const [account, setAccount] = useState("");
  const [category, setCategory] = useState<Category>("expense");
  useEffect(() => {
    if (open) {
      setAccount("");
      setCategory("expense");
    }
  }, [open]);
  const name = account.trim();
  const duplicate = existing.some((a) => a.toLowerCase() === name.toLowerCase());
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add account"
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name || duplicate}
            onClick={() => {
              onAdd(name, category);
              onOpenChange(false);
            }}
          >
            Add account
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="Account" required className="col-span-2" error={duplicate ? "This account is already in the budget" : null}>
          <Input autoFocus value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. Repairs & maintenance" maxLength={120} />
        </Field>
        <Field label="Category" required>
          <Select value={category} onChange={(e) => setCategory(e.target.value as Category)} options={BUDGET_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
        </Field>
      </div>
    </Dialog>
  );
}

function DecisionDialog({
  open,
  onOpenChange,
  decision,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  decision: Decision;
  loading: boolean;
  onConfirm: (note: string | null) => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) setNote("");
  }, [open]);
  const returning = decision === "rejected";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={returning ? "Return budget to draft?" : "Approve budget?"}
      description={
        returning
          ? "The budget goes back to draft so it can be revised. The note is kept with the approval history."
          : "Approving locks this version. Any previously approved version for the same year is superseded."
      }
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Back</Button>
          <Button variant={returning ? "danger" : "primary"} disabled={returning && !note.trim()} loading={loading} onClick={() => onConfirm(note.trim() || null)}>
            {returning ? "Return to draft" : "Approve"}
          </Button>
        </>
      }
    >
      <Field label="Note" required={returning}>
        <Textarea autoFocus rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function NewVersionDialog({ open, onOpenChange, budget }: { open: boolean; onOpenChange: (o: boolean) => void; budget: Budget }) {
  const router = useRouter();
  const create = useBudgetAction<{ kind: "original" | "reforecast"; name?: string | null }>(budget.id, "versions");
  const [kind, setKind] = useState<"original" | "reforecast">("reforecast");
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) {
      setKind("reforecast");
      setName("");
    }
  }, [open]);
  const submit = () =>
    create.mutate(
      { kind, name: name.trim() || null },
      {
        onSuccess: (b) => {
          toast.success(`Version ${b.version} created`);
          onOpenChange(false);
          router.push(`/budgets/${b.id}`);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New budget version"
      description={`Copies every line from v${budget.version} into a new draft. The current version is kept unchanged.`}
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Create version
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Type">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "reforecast", label: "Reforecast" },
              { value: "original", label: "Revised budget" },
            ]}
          />
        </Field>
        <Field label="Name" hint="Optional">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the budget name and version" />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ grid */

function BudgetGrid({
  rows,
  view,
  editable,
  showActual,
  editValue,
  onEdit,
  onRemove,
}: {
  rows: WorkingRow[];
  view: View;
  editable: boolean;
  showActual: boolean;
  editValue: (row: WorkingRow, month: number) => string;
  onEdit: (row: WorkingRow, month: number, value: string) => void;
  onRemove: (row: WorkingRow) => void;
}) {
  const monthValues = (r: WorkingRow): (number | null)[] => {
    if (view === "budget") return r.budget;
    if (view === "reforecast") return r.reforecast;
    if (view === "prior_actual") return r.prior_actual;
    return r.actual;
  };
  const cellEditable = editable && (view === "budget" || view === "reforecast");
  const groups = BUDGET_CATEGORIES.map((c) => ({ category: c as Category, rows: rows.filter((r) => r.category === c) })).filter((g) => g.rows.length > 0);

  const columnTotals = (rs: WorkingRow[]) => MONTHS.map((_, m) => rs.reduce((a, r) => a + (monthValues(r)[m] ?? 0), 0));
  const noiMonths = MONTHS.map((_, m) => {
    const inc = rows.filter((r) => r.category === "income").reduce((a, r) => a + (monthValues(r)[m] ?? 0), 0);
    const exp = rows.filter((r) => r.category === "expense").reduce((a, r) => a + (monthValues(r)[m] ?? 0), 0);
    return inc - exp;
  });

  const th = "whitespace-nowrap px-2 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-ink-3";
  const td = "whitespace-nowrap px-2 py-1 text-right text-sm tabular";
  const sticky = "sticky left-0 z-10 bg-surface";

  const summaryCells = (r: WorkingRow) => {
    const rf = anyValue(r.reforecast) ? MONTHS.reduce((a, _, m) => a + (r.reforecast[m] ?? r.budget[m] ?? 0), 0) : null;
    return (
      <>
        <td className={cn(td, "border-l border-line font-medium text-ink")}>{money(sum(monthValues(r)))}</td>
        <td className={cn(td, "text-ink-2")}>{money(sum(r.budget))}</td>
        <td className={cn(td, "text-ink-2")}>{money(rf)}</td>
        <td className={cn(td, "text-ink-2")}>{anyValue(r.prior_actual) ? money(sum(r.prior_actual)) : "—"}</td>
        {showActual && (
          <>
            <td className={cn(td, "text-ink-2")}>{anyValue(r.actual) ? money(sum(r.actual)) : "—"}</td>
            <td className={cn(td, r.variance == null ? "text-ink-3" : varianceClass(r.category, r.variance))}>
              {r.variance == null ? "—" : `${r.variance > 0 ? "+" : ""}${money(r.variance)}`}
              {r.variance_pct != null && <span className="ml-1 text-xs text-ink-3">{formatPercent(r.variance_pct, 0)}</span>}
            </td>
          </>
        )}
      </>
    );
  };

  const totalsRow = (label: string, values: number[], strong = false) => (
    <tr className={cn("border-t border-line", strong ? "bg-subtle font-semibold" : "bg-subtle/60 font-medium")}>
      <td className={cn("whitespace-nowrap px-3 py-1.5 text-sm text-ink", sticky, "bg-subtle")}>{label}</td>
      {values.map((v, m) => (
        <td key={m} className={cn(td, "py-1.5 text-ink", v < 0 && "text-negative")}>
          {money(v)}
        </td>
      ))}
      <td className={cn(td, "border-l border-line py-1.5 text-ink", values.reduce((a, v) => a + v, 0) < 0 && "text-negative")}>{money(values.reduce((a, v) => a + v, 0))}</td>
      <td colSpan={showActual ? 5 : 3} />
    </tr>
  );

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="min-w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className={cn(th, sticky, "min-w-[200px] px-3 text-left")}>Account</th>
            {MONTHS.map((m) => (
              <th key={m} className={th}>
                {m}
              </th>
            ))}
            <th className={cn(th, "border-l border-line")}>{VIEW_LABELS[view]} total</th>
            <th className={th}>Budget</th>
            <th className={th}>Reforecast</th>
            <th className={th}>Prior actual</th>
            {showActual && (
              <>
                <th className={th}>Actual</th>
                <th className={th}>
                  <Tooltip content="Actual minus plan (reforecast where set, otherwise budget) for months with actuals; reflects saved values.">
                    <span>Variance</span>
                  </Tooltip>
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g.category}>
              <tr className="border-t border-line">
                <td colSpan={MONTHS.length + (showActual ? 7 : 5)} className="bg-surface px-3 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  {CATEGORY_TITLES[g.category]}
                </td>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.account} className="group border-t border-line/60 hover:bg-subtle/50">
                  <td className={cn("whitespace-nowrap px-3 py-1 text-sm text-ink group-hover:bg-subtle/50", sticky)}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="max-w-[220px] truncate" title={r.account}>
                        {r.account}
                        {r.isNew && <span className="ml-1.5 text-xs text-ink-3">new</span>}
                      </span>
                      {editable && (
                        <button
                          type="button"
                          aria-label={`Remove ${r.account}`}
                          onClick={() => onRemove(r)}
                          className="rounded p-0.5 text-ink-3 opacity-0 hover:bg-muted hover:text-negative focus:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </span>
                  </td>
                  {MONTHS.map((_, m) =>
                    cellEditable ? (
                      <td key={m} className="px-0.5 py-0.5 text-right">
                        <CellInput
                          value={editValue(r, m + 1)}
                          placeholder={view === "reforecast" ? money(r.budget[m]) : undefined}
                          onChange={(v) => onEdit(r, m + 1, v)}
                        />
                      </td>
                    ) : (
                      <td key={m} className={cn(td, monthValues(r)[m] == null ? "text-ink-3" : "text-ink-2")}>
                        {money(monthValues(r)[m])}
                      </td>
                    ),
                  )}
                  {summaryCells(r)}
                </tr>
              ))}
              {totalsRow(`Total ${g.category === "capex" ? "capex" : g.category}`, columnTotals(g.rows))}
            </GroupRows>
          ))}
          {totalsRow("Net operating income", noiMonths, true)}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Over plan is bad for expenses/capex and good for income. */
function varianceClass(category: Category, v: number) {
  if (v === 0) return "text-ink-2";
  const good = category === "income" ? v > 0 : v < 0;
  return good ? "text-positive" : "text-negative";
}

/* ------------------------------------------------------------------ page */

function BudgetDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: budget, isLoading, error } = useBudget(id);
  const saveLines = useBudgetAction<{ cells: LineCell[]; remove_accounts: string[] }>(id, "lines");
  const loadPrior = useBudgetAction<undefined>(id, "load-prior-actuals");
  const submit = useBudgetAction<undefined>(id, "submit");
  const approval = useBudgetAction<{ decision: Decision; note?: string | null }>(id, "approval");
  const archive = useArchiveBudget();

  const [view, setView] = useState<View>("budget");
  const [edits, setEdits] = useState<Record<EditKey, string>>({});
  const [rfEdits, setRfEdits] = useState<Record<EditKey, string>>({});
  const [added, setAdded] = useState<{ account: string; category: Category }[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [versioning, setVersioning] = useState(false);
  const [confirmPrior, setConfirmPrior] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const tab = url.get("tab") ?? "grid";

  const reset = () => {
    setEdits({});
    setRfEdits({});
    setAdded([]);
    setRemoved([]);
  };
  useEffect(() => {
    reset();
    setView("budget");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (budget?.kind === "reforecast" && budget.status === "draft") setView("reforecast");
  }, [budget?.kind, budget?.status]);

  const rows = useMemo<WorkingRow[]>(() => {
    if (!budget) return [];
    const parse = (raw: string | undefined, fallback: number | null) => {
      if (raw === undefined) return fallback;
      if (raw.trim() === "") return null;
      return toNumber(raw);
    };
    const base: WorkingRow[] = budget.rows
      .filter((r) => !removed.includes(r.account))
      .map((r) => ({
        account: r.account,
        category: r.category,
        budget: r.budget.map((v, m) => parse(edits[ek(r.account, m + 1)], v) ?? 0),
        reforecast: r.reforecast.map((v, m) => parse(rfEdits[ek(r.account, m + 1)], v)),
        prior_actual: r.prior_actual,
        actual: r.actual,
        isNew: false,
        variance: r.variance,
        variance_pct: r.variance_pct,
      }));
    const empty = () => MONTHS.map(() => null as number | null);
    const extra: WorkingRow[] = added.map((a) => ({
      account: a.account,
      category: a.category,
      budget: MONTHS.map((_, m) => parse(edits[ek(a.account, m + 1)], 0) ?? 0),
      reforecast: MONTHS.map((_, m) => parse(rfEdits[ek(a.account, m + 1)], null)),
      prior_actual: empty(),
      actual: empty(),
      isNew: true,
      variance: null,
      variance_pct: null,
    }));
    const order: Record<Category, number> = { income: 0, expense: 1, capex: 2 };
    return [...base, ...extra].sort((a, b) => order[a.category] - order[b.category] || a.account.localeCompare(b.account));
  }, [budget, edits, rfEdits, added, removed]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (error || !budget) {
    return <EmptyState title="Budget not found" description={errorMessage(error)} action={<Link href="/budgets"><Button>Back to budgets</Button></Link>} />;
  }

  const editPerm = can("operations", "edit");
  const draft = budget.status === "draft";
  const editable = editPerm && draft;
  const dirtyCount = Object.keys(edits).length + Object.keys(rfEdits).length + added.length + removed.length;
  const invalid = [...Object.values(edits), ...Object.values(rfEdits)].some((v) => v.trim() !== "" && toNumber(v) === null);

  const sourceRow = (account: string) => budget.rows.find((r) => r.account === account);
  const editValue = (r: WorkingRow, month: number) => {
    const key = ek(r.account, month);
    if (view === "reforecast") {
      if (key in rfEdits) return rfEdits[key];
      const v = sourceRow(r.account)?.reforecast[month - 1];
      return v == null ? "" : String(v);
    }
    if (key in edits) return edits[key];
    const v = r.isNew ? null : sourceRow(r.account)?.budget[month - 1];
    return v == null || (r.isNew && v === 0) ? "" : String(v);
  };
  const onEdit = (r: WorkingRow, month: number, value: string) => {
    const key = ek(r.account, month);
    if (view === "reforecast") setRfEdits((e) => ({ ...e, [key]: value }));
    else setEdits((e) => ({ ...e, [key]: value }));
  };
  const onRemove = (r: WorkingRow) => {
    if (r.isNew) setAdded((a) => a.filter((x) => x.account !== r.account));
    else setRemoved((x) => [...x, r.account]);
    const drop = (e: Record<EditKey, string>) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(`${r.account}|`))) as Record<EditKey, string>;
    setEdits(drop);
    setRfEdits(drop);
  };

  const save = () => {
    if (invalid) return toast.error("Some cells are not valid numbers");
    const category = (account: string): Category => rows.find((r) => r.account === account)?.category ?? "expense";
    const cells = new Map<EditKey, LineCell>();
    const cell = (key: EditKey) => {
      const [account, m] = [key.slice(0, key.lastIndexOf("|")), Number(key.slice(key.lastIndexOf("|") + 1))];
      const existing = cells.get(key) ?? { account, category: category(account), month: m };
      cells.set(key, existing);
      return existing;
    };
    for (const [key, raw] of Object.entries(edits) as [EditKey, string][]) cell(key).amount = toNumber(raw) ?? 0;
    for (const [key, raw] of Object.entries(rfEdits) as [EditKey, string][]) cell(key).reforecast_amount = raw.trim() === "" ? null : toNumber(raw);
    // New accounts without any value still need a line so the account is kept.
    for (const a of added) {
      if (![...cells.keys()].some((k) => k.startsWith(`${a.account}|`))) cells.set(ek(a.account, 1), { account: a.account, category: a.category, month: 1, amount: 0 });
    }
    saveLines.mutate(
      { cells: [...cells.values()], remove_accounts: removed },
      {
        onSuccess: () => {
          reset();
          toast.success("Budget saved");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const runPrior = () =>
    loadPrior.mutate(undefined, {
      onSuccess: () => {
        setConfirmPrior(false);
        toast.success("Prior-year actuals loaded");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const runSubmit = () =>
    submit.mutate(undefined, { onSuccess: () => toast.success("Submitted for approval"), onError: (e) => toast.error(errorMessage(e)) });

  const decide = (decision: Decision, note: string | null) =>
    approval.mutate(
      { decision, note },
      {
        onSuccess: () => {
          setDeciding(null);
          toast.success(decision === "approved" ? "Budget approved" : "Returned to draft");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const doArchive = () =>
    archive.mutate(id, {
      onSuccess: () => {
        toast.success("Budget archived");
        router.replace("/budgets");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const submitBlock = dirtyCount > 0 ? "Save your changes before submitting." : budget.rows.length === 0 ? "Add budget lines before submitting." : null;
  const hasPrior = budget.rows.some((r) => anyValue(r.prior_actual));
  const totals = {
    income: rows.filter((r) => r.category === "income").reduce((a, r) => a + sum(r.budget), 0),
    expense: rows.filter((r) => r.category === "expense").reduce((a, r) => a + sum(r.budget), 0),
    capex: rows.filter((r) => r.category === "capex").reduce((a, r) => a + sum(r.budget), 0),
  };
  const noi = totals.income - totals.expense;
  const versions = [...budget.versions].sort((a, b) => b.version - a.version);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Budgets", href: "/budgets" }, { label: `FY${budget.fiscal_year} v${budget.version}` }]}
        title={budget.name}
        description={
          <Link href={`/properties/${budget.property_id}`} className="hover:underline">
            {[budget.property_name, `Fiscal year ${budget.fiscal_year}`].filter(Boolean).join(" · ")}
          </Link>
        }
        meta={
          <>
            <OpsStatusBadge status={budget.status} />
            <Badge tone="outline">v{budget.version}</Badge>
            {budget.kind === "reforecast" && <Badge tone="sky">Reforecast</Badge>}
          </>
        }
        actions={
          <>
            {editable && (
              <Gate reason={submitBlock}>
                <Button variant="primary" disabled={!!submitBlock} loading={submit.isPending} onClick={runSubmit}>
                  <Send /> Submit for approval
                </Button>
              </Gate>
            )}
            {budget.status === "submitted" && can("operations", "approve") && (
              <>
                <Button onClick={() => setDeciding("rejected")}>
                  <Undo2 /> Return
                </Button>
                <Button variant="primary" onClick={() => setDeciding("approved")}>
                  <Check /> Approve
                </Button>
              </>
            )}
            {(can("operations", "create") || can("operations", "delete") || editable) && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent width={220}>
                  {editable && (
                    <MenuItem icon={<Download />} onSelect={() => setConfirmPrior(true)}>
                      Load prior-year actuals
                    </MenuItem>
                  )}
                  {can("operations", "create") && (
                    <MenuItem icon={<Copy />} onSelect={() => setVersioning(true)}>
                      New version / reforecast
                    </MenuItem>
                  )}
                  {can("operations", "delete") && (draft || budget.status === "submitted") && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                        Archive
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      {budget.status === "draft" && budget.approval_note && (
        <div className="mb-5 rounded-lg border border-caution/30 bg-caution-soft px-4 py-3 text-sm">
          <p className="font-medium text-caution">Returned for revision</p>
          <p className="mt-0.5 text-ink-2">{budget.approval_note}</p>
        </div>
      )}
      {budget.status === "submitted" && (
        <div className="mb-5 rounded-lg border border-line bg-subtle px-4 py-3 text-sm text-ink-2">
          Submitted {budget.submitted_at ? formatDateTime(budget.submitted_at) : ""} and awaiting approval. Lines are locked while under review.
        </div>
      )}
      {(budget.status === "approved" || budget.status === "superseded") && (
        <div className="mb-5 rounded-lg border border-line bg-subtle px-4 py-3 text-sm text-ink-2">
          {budget.status === "approved" ? "Approved" : "Superseded"} versions are locked. Create a new version or reforecast to make changes.
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Income" value={formatCurrency(totals.income, { compact: true })} />
        <StatCard label="Expenses" value={formatCurrency(totals.expense, { compact: true })} />
        <StatCard label="NOI" value={formatCurrency(noi, { compact: true })} tone={noi < 0 ? "negative" : "default"} />
        <StatCard label="Capex" value={formatCurrency(totals.capex, { compact: true })} />
      </div>

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "grid" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "grid", label: "Budget grid" },
            { value: "versions", label: "Versions", count: versions.length },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="grid">
          <Card>
            <CardHeader
              title="Monthly budget by account"
              description={
                view === "reforecast"
                  ? "Reforecast values replace the budget for that month in variance; leave blank to keep the budget."
                  : view === "budget"
                    ? editable
                      ? "Type amounts directly into the grid. Totals update as you edit."
                      : "Budgeted amounts by month."
                    : view === "prior_actual"
                      ? "Prior-year actuals loaded into this budget (read-only)."
                      : "Actuals from the asset financials (read-only)."
              }
              actions={
                <>
                  <Segmented
                    value={view}
                    onChange={setView}
                    options={(["budget", "reforecast", "prior_actual", ...(budget.actuals_available ? (["actual"] as const) : [])] as View[]).map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
                  />
                  {editable && (
                    <Button size="sm" onClick={() => setAdding(true)}>
                      <Plus /> Account
                    </Button>
                  )}
                </>
              }
            />
            {rows.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="No budget lines yet"
                  description={editable ? "Add accounts, or load prior-year actuals as a starting point." : "This budget has no lines."}
                  action={
                    editable ? (
                      <div className="flex gap-2">
                        <Button onClick={() => setConfirmPrior(true)}>
                          <Download /> Load prior actuals
                        </Button>
                        <Button variant="primary" onClick={() => setAdding(true)}>
                          <Plus /> Add account
                        </Button>
                      </div>
                    ) : undefined
                  }
                />
              </CardBody>
            ) : (
              <BudgetGrid
                rows={rows}
                view={view}
                editable={editable}
                showActual={budget.actuals_available}
                editValue={editValue}
                onEdit={onEdit}
                onRemove={onRemove}
              />
            )}
            {!hasPrior && rows.length > 0 && view === "prior_actual" && <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">No prior-year actuals have been loaded.</p>}
          </Card>
        </TabPanel>

        <TabPanel value="versions">
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Versions"
                description="Every version for this property and fiscal year. Only one version can be approved at a time."
                actions={
                  can("operations", "create") && (
                    <Button size="sm" onClick={() => setVersioning(true)}>
                      <Copy /> New version
                    </Button>
                  )
                }
              />
              <CardBody className="p-0">
                <ul className="divide-y divide-line">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <Link href={`/budgets/${v.id}`} className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-subtle", v.id === budget.id && "bg-subtle/60")}>
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm font-medium text-ink">
                            <span className="tabular">v{v.version}</span>
                            <span className="truncate">{v.name}</span>
                            {v.id === budget.id && <span className="text-xs font-normal text-ink-3">(viewing)</span>}
                          </p>
                          <p className="text-xs text-ink-3">
                            {titleCase(v.kind)} · updated {formatDate(v.updated_at)}
                            {v.approved_at ? ` · approved ${formatDate(v.approved_at)}` : ""}
                          </p>
                        </div>
                        <span className="flex items-center gap-3">
                          <span className="text-right text-xs text-ink-3">
                            NOI <span className="font-medium text-ink tabular">{formatCurrency(v.noi, { compact: true })}</span>
                          </span>
                          <OpsStatusBadge status={v.status} />
                          <ArrowRight className="size-3.5 text-ink-3" />
                        </span>
                      </Link>
                    </li>
                  ))}
                  {versions.length === 0 && <li className="px-4 py-3 text-sm text-ink-3">No other versions.</li>}
                </ul>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Details" />
              <CardBody>
                <FieldGrid cols={2}>
                  <FieldItem label="Property">
                    <Link href={`/properties/${budget.property_id}`} className="text-accent hover:underline">
                      {budget.property_name ?? "Property"}
                    </Link>
                  </FieldItem>
                  <FieldItem label="Fiscal year">{budget.fiscal_year}</FieldItem>
                  <FieldItem label="Kind">{titleCase(budget.kind)}</FieldItem>
                  <FieldItem label="Created">{formatDate(budget.created_at)}</FieldItem>
                  <FieldItem label="Submitted">{budget.submitted_at ? formatDateTime(budget.submitted_at) : null}</FieldItem>
                  <FieldItem label="Approved">{budget.approved_at ? formatDateTime(budget.approved_at) : null}</FieldItem>
                  <FieldItem label="Superseded">{budget.superseded_at ? formatDateTime(budget.superseded_at) : null}</FieldItem>
                  <FieldItem label="Actuals">{budget.actuals_available ? "Available" : "None yet"}</FieldItem>
                </FieldGrid>
                {budget.parent_budget_id && (
                  <Link href={`/budgets/${budget.parent_budget_id}`} className="mt-4 flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                    Previous version <ArrowRight className="size-3.5" />
                  </Link>
                )}
                {budget.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-ink-2">{budget.notes}</p>}
                {budget.approval_note && budget.status !== "draft" && <p className="mt-3 text-xs text-ink-3">Approval note: {budget.approval_note}</p>}
              </CardBody>
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="budget" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      {editable && dirtyCount > 0 && (
        <div className="sticky bottom-3 z-20 mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-pop">
            <span className="text-sm text-ink-2">
              <span className="font-medium text-ink tabular">{dirtyCount}</span> unsaved change{dirtyCount === 1 ? "" : "s"}
              {invalid && <span className="ml-2 text-negative">Some cells are not valid numbers</span>}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={reset}>
                Discard
              </Button>
              <Button variant="primary" disabled={invalid} loading={saveLines.isPending} onClick={save}>
                Save budget
              </Button>
            </div>
          </div>
        </div>
      )}

      <AddAccountDialog
        open={adding}
        onOpenChange={setAdding}
        existing={rows.map((r) => r.account)}
        onAdd={(account, category) => {
          setRemoved((x) => x.filter((a) => a !== account));
          if (!budget.rows.some((r) => r.account === account)) setAdded((a) => [...a, { account, category }]);
        }}
      />
      <DecisionDialog open={deciding !== null} onOpenChange={(o) => !o && setDeciding(null)} decision={deciding ?? "approved"} loading={approval.isPending} onConfirm={(note) => deciding && decide(deciding, note)} />
      <NewVersionDialog open={versioning} onOpenChange={setVersioning} budget={budget} />
      <ConfirmDialog
        open={confirmPrior}
        onOpenChange={setConfirmPrior}
        title="Load prior-year actuals?"
        description={`Pulls FY${budget.fiscal_year - 1} actuals from the asset financials. Accounts and months without a budget line are created from those actuals; existing lines keep their amounts and gain the prior-actual reference.`}
        confirmLabel="Load actuals"
        loading={loadPrior.isPending}
        onConfirm={runPrior}
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this budget version?"
        description="It is removed from lists but retained with its history for audit."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={doArchive}
      />
    </>
  );
}

export default function BudgetPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <BudgetDetail id={params.id} />
    </Suspense>
  );
}
