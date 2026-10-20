"use client";

import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Fragment, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { titleCase } from "@/lib/utils";

import { getPath, setPath, type Assumptions, type ExpenseRow, type LeaseRow, type SV } from "./api";
import { FormSection, NumField, NumInput, SVField, SourceChip } from "./fields";

const uid = () => Math.random().toString(16).slice(2, 10);
const RECOVERY = ["nnn", "base_year", "fixed", "gross"].map((v) => ({ value: v, label: v === "nnn" ? "NNN (pro-rata)" : v === "base_year" ? "Base year / stop" : titleCase(v) }));
const EXPENSE_CATEGORIES = ["tax", "insurance", "cam", "utilities", "repairs", "management", "other"].map((v) => ({ value: v, label: v === "cam" ? "CAM" : titleCase(v) }));

function blankLease(): LeaseRow {
  return {
    id: uid(), tenant: null, suite: null, space_id: null, lease_id: null, row_source: "manual", area_sf: null, vacant: false,
    commencement_on: null, expiration_on: null, base_rent_annual: { value: null, source: null }, rent_psf: null, rent_steps: [],
    escalation_pct: 2, recovery_type: "nnn", expense_stop_psf: null, recovery_share_pct: null, fixed_recovery_annual: null,
    abatements: [], percentage_rent: { rate_pct: null, sales_annual: null, sales_growth_pct: null, breakpoint: null }, options: [],
    renewal_probability_pct: { value: 65, source: null }, downtime_months: 6, market_rent_psf: { value: null, source: null },
    new_lease_term_years: 5, ti_new_psf: 0, ti_renewal_psf: 0, lc_new_pct: 6, lc_renewal_pct: 3, free_rent_new_months: 0, tenant_credit: null,
  };
}

const cellInput = "h-7 w-full rounded border border-transparent bg-transparent px-1.5 text-sm hover:border-line focus:border-accent/60 focus:bg-surface focus:outline-none disabled:hover:border-transparent";

function LeaseDetails({ lease, onChange, readOnly }: { lease: LeaseRow; onChange: (patch: Partial<LeaseRow>) => void; readOnly: boolean }) {
  const pr = lease.percentage_rent ?? { rate_pct: null, sales_annual: null, sales_growth_pct: null, breakpoint: null };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Recoveries</p>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Type">
            <Select disabled={readOnly} value={lease.recovery_type} onChange={(e) => onChange({ recovery_type: e.target.value })} options={RECOVERY} />
          </Field>
          <NumField label="Expense stop" suffix="$/SF" value={lease.expense_stop_psf} readOnly={readOnly} onChange={(n) => onChange({ expense_stop_psf: n })} />
          <NumField label="Pro-rata share" suffix="%" value={lease.recovery_share_pct} readOnly={readOnly} onChange={(n) => onChange({ recovery_share_pct: n })} />
          <NumField label="Fixed recovery" suffix="$/yr" value={lease.fixed_recovery_annual} readOnly={readOnly} onChange={(n) => onChange({ fixed_recovery_annual: n })} />
          <NumField label="Rent" suffix="$/SF/yr" value={lease.rent_psf} readOnly={readOnly} onChange={(n) => onChange({ rent_psf: n })} hint="Used when annual rent is blank" />
        </div>
        <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Percentage rent</p>
        <div className="grid grid-cols-4 gap-2">
          <NumField label="Rate" suffix="%" value={pr.rate_pct} readOnly={readOnly} onChange={(n) => onChange({ percentage_rent: { ...pr, rate_pct: n } })} />
          <NumField label="Sales" suffix="$/yr" value={pr.sales_annual} readOnly={readOnly} onChange={(n) => onChange({ percentage_rent: { ...pr, sales_annual: n } })} />
          <NumField label="Sales growth" suffix="%" value={pr.sales_growth_pct} readOnly={readOnly} onChange={(n) => onChange({ percentage_rent: { ...pr, sales_growth_pct: n } })} />
          <NumField label="Breakpoint" suffix="$" value={pr.breakpoint} readOnly={readOnly} onChange={(n) => onChange({ percentage_rent: { ...pr, breakpoint: n } })} hint="Natural if blank" />
        </div>
        <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Rollover (new lease / renewal)</p>
        <div className="grid grid-cols-4 gap-2">
          <NumField label="TI new" suffix="$/SF" value={lease.ti_new_psf} readOnly={readOnly} onChange={(n) => onChange({ ti_new_psf: n })} />
          <NumField label="TI renewal" suffix="$/SF" value={lease.ti_renewal_psf} readOnly={readOnly} onChange={(n) => onChange({ ti_renewal_psf: n })} />
          <NumField label="LC new" suffix="%" value={lease.lc_new_pct} readOnly={readOnly} onChange={(n) => onChange({ lc_new_pct: n })} />
          <NumField label="LC renewal" suffix="%" value={lease.lc_renewal_pct} readOnly={readOnly} onChange={(n) => onChange({ lc_renewal_pct: n })} />
          <NumField label="Free rent new" suffix="mo" value={lease.free_rent_new_months} readOnly={readOnly} onChange={(n) => onChange({ free_rent_new_months: n })} />
          <NumField label="New term" suffix="yrs" value={lease.new_lease_term_years} readOnly={readOnly} onChange={(n) => onChange({ new_lease_term_years: n })} />
        </div>
      </div>
      <div className="space-y-3">
        <ListEditor
          title="Rent steps"
          readOnly={readOnly}
          rows={lease.rent_steps ?? []}
          blank={{ start_on: "", annual_rent: null }}
          onChange={(rent_steps) => onChange({ rent_steps })}
          columns={[
            { key: "start_on", label: "Starts", type: "date" },
            { key: "annual_rent", label: "Annual rent", type: "number" },
          ]}
        />
        <ListEditor
          title="Abatements"
          readOnly={readOnly}
          rows={lease.abatements ?? []}
          blank={{ start_on: "", end_on: "", pct: 100 }}
          onChange={(abatements) => onChange({ abatements })}
          columns={[
            { key: "start_on", label: "From", type: "date" },
            { key: "end_on", label: "To", type: "date" },
            { key: "pct", label: "% abated", type: "number" },
          ]}
        />
        <ListEditor
          title="Renewal options"
          readOnly={readOnly}
          rows={lease.options ?? []}
          blank={{ term_years: 5, rent_change_pct: 10 }}
          onChange={(options) => onChange({ options })}
          columns={[
            { key: "term_years", label: "Term (yrs)", type: "number" },
            { key: "rent_change_pct", label: "Rent change %", type: "number" },
          ]}
        />
      </div>
    </div>
  );
}

function ListEditor<T extends Record<string, unknown>>({
  title,
  rows,
  blank,
  columns,
  onChange,
  readOnly,
}: {
  title: string;
  rows: T[];
  blank: T;
  columns: { key: keyof T & string; label: string; type: "date" | "number" | "text" }[];
  onChange: (rows: T[]) => void;
  readOnly: boolean;
}) {
  const set = (i: number, key: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</p>
        {!readOnly && (
          <Button size="xs" variant="ghost" onClick={() => onChange([...rows, { ...blank }])}>
            <Plus /> Add
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-3">None</p>
      ) : (
        <div className="space-y-1">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5">
              {columns.map((c) =>
                c.type === "number" ? (
                  <NumInput key={c.key} placeholder={c.label} value={(r[c.key] as number | null) ?? null} disabled={readOnly} onChange={(n) => set(i, c.key, n)} className="h-7" />
                ) : (
                  <Input key={c.key} type={c.type === "date" ? "date" : "text"} placeholder={c.label} value={String(r[c.key] ?? "")} disabled={readOnly} onChange={(e) => set(i, c.key, e.target.value)} className="h-7" />
                ),
              )}
              {!readOnly && (
                <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LeasesTable({ leases, onChange, readOnly }: { leases: LeaseRow[]; onChange: (rows: LeaseRow[]) => void; readOnly: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const upd = (i: number, patch: Partial<LeaseRow>) => onChange(leases.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const head = "whitespace-nowrap border-b border-line bg-subtle px-2 py-2 text-left text-xs font-medium text-ink-3";
  const totalArea = leases.reduce((s, l) => s + (l.area_sf ?? 0), 0);
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-line scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className={head} />
              <th className={head}>Tenant</th>
              <th className={head}>Suite</th>
              <th className={`${head} text-right`}>SF</th>
              <th className={head}>Vacant</th>
              <th className={head}>Commenced</th>
              <th className={head}>Expires</th>
              <th className={`${head} text-right`}>Annual rent</th>
              <th className={`${head} text-right`}>Esc. %</th>
              <th className={`${head} text-right`}>Renew %</th>
              <th className={`${head} text-right`}>Downtime mo</th>
              <th className={`${head} text-right`}>Market $/SF</th>
              <th className={head} />
            </tr>
          </thead>
          <tbody>
            {leases.map((l, i) => {
              const expanded = open === l.id;
              return (
                <Fragment key={l.id}>
                  <tr className={l.vacant ? "bg-subtle/40" : undefined}>
                    <td className="border-b border-line px-1">
                      <button type="button" className="rounded p-0.5 text-ink-3 hover:bg-muted" onClick={() => setOpen(expanded ? null : l.id)} aria-label="Lease details">
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                    </td>
                    <td className="min-w-[140px] border-b border-line px-1">
                      <input className={cellInput} disabled={readOnly} value={l.tenant ?? ""} placeholder={l.vacant ? "Vacant" : "Tenant"} onChange={(e) => upd(i, { tenant: e.target.value || null })} />
                      {l.row_source && l.row_source !== "manual" && <p className="px-1.5 text-2xs text-ink-3">From {l.row_source}</p>}
                    </td>
                    <td className="w-20 border-b border-line px-1">
                      <input className={cellInput} disabled={readOnly} value={l.suite ?? ""} onChange={(e) => upd(i, { suite: e.target.value || null })} />
                    </td>
                    <td className="w-24 border-b border-line px-1">
                      <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly} value={l.area_sf} onChange={(n) => upd(i, { area_sf: n })} />
                    </td>
                    <td className="border-b border-line px-2">
                      <Checkbox checked={!!l.vacant} onChange={(v) => !readOnly && upd(i, { vacant: v })} label="Vacant" />
                    </td>
                    <td className="border-b border-line px-1">
                      <input type="date" className={cellInput} disabled={readOnly || l.vacant} value={l.commencement_on ?? ""} onChange={(e) => upd(i, { commencement_on: e.target.value || null })} />
                    </td>
                    <td className="border-b border-line px-1">
                      <input type="date" className={cellInput} disabled={readOnly || l.vacant} value={l.expiration_on ?? ""} onChange={(e) => upd(i, { expiration_on: e.target.value || null })} />
                    </td>
                    <td className="min-w-[150px] border-b border-line px-1">
                      <div className="flex items-center gap-1">
                        <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly || l.vacant} value={l.base_rent_annual?.value ?? null} onChange={(n) => upd(i, { base_rent_annual: { ...(l.base_rent_annual ?? {}), value: n } })} />
                        <SourceChip value={l.base_rent_annual} readOnly={readOnly} onChange={(sv: SV) => upd(i, { base_rent_annual: sv })} />
                      </div>
                    </td>
                    <td className="w-16 border-b border-line px-1">
                      <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly} value={l.escalation_pct} onChange={(n) => upd(i, { escalation_pct: n })} />
                    </td>
                    <td className="min-w-[120px] border-b border-line px-1">
                      <div className="flex items-center gap-1">
                        <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly || l.vacant} value={l.renewal_probability_pct?.value ?? null} onChange={(n) => upd(i, { renewal_probability_pct: { ...(l.renewal_probability_pct ?? {}), value: n } })} />
                        <SourceChip value={l.renewal_probability_pct} readOnly={readOnly} onChange={(sv: SV) => upd(i, { renewal_probability_pct: sv })} />
                      </div>
                    </td>
                    <td className="w-16 border-b border-line px-1">
                      <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly} value={l.downtime_months} onChange={(n) => upd(i, { downtime_months: n })} />
                    </td>
                    <td className="min-w-[130px] border-b border-line px-1">
                      <div className="flex items-center gap-1">
                        <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly} value={l.market_rent_psf?.value ?? null} onChange={(n) => upd(i, { market_rent_psf: { ...(l.market_rent_psf ?? {}), value: n } })} />
                        <SourceChip value={l.market_rent_psf} readOnly={readOnly} onChange={(sv: SV) => upd(i, { market_rent_psf: sv })} />
                      </div>
                    </td>
                    <td className="border-b border-line px-1 text-right">
                      {!readOnly && (
                        <Button size="icon-sm" variant="ghost" aria-label="Remove lease" onClick={() => onChange(leases.filter((_, j) => j !== i))}>
                          <Trash2 />
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={13} className="border-b border-line bg-subtle/30 px-4 py-4">
                        <LeaseDetails lease={l} readOnly={readOnly} onChange={(patch) => upd(i, patch)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {leases.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-3">No tenant rows. Add leases manually; the lease module will seed them once available.</p>}
      </div>
      <div className="flex items-center justify-between text-xs text-ink-3">
        <span className="tabular">{leases.length} rows · {new Intl.NumberFormat("en-US").format(totalArea)} SF</span>
        {!readOnly && (
          <Button size="sm" onClick={() => onChange([...leases, blankLease()])}>
            <Plus /> Add lease row
          </Button>
        )}
      </div>
    </div>
  );
}

function ExpensesTable({ rows, onChange, readOnly }: { rows: ExpenseRow[]; onChange: (rows: ExpenseRow[]) => void; readOnly: boolean }) {
  const upd = (i: number, patch: Partial<ExpenseRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const head = "border-b border-line bg-subtle px-2 py-2 text-left text-xs font-medium text-ink-3";
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-line scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className={head}>Line item</th>
              <th className={head}>Category</th>
              <th className={`${head} text-right`}>Annual amount</th>
              <th className={`${head} text-right`}>Growth %</th>
              <th className={head}>Recoverable</th>
              <th className={head} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td className="min-w-[180px] border-b border-line px-1">
                  <input className={cellInput} disabled={readOnly} value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
                </td>
                <td className="w-40 border-b border-line px-1 py-1">
                  <Select disabled={readOnly} value={r.category} onChange={(e) => upd(i, { category: e.target.value })} options={EXPENSE_CATEGORIES} />
                </td>
                <td className="min-w-[180px] border-b border-line px-1">
                  <div className="flex items-center gap-1">
                    <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly} value={r.annual_amount?.value ?? null} onChange={(n) => upd(i, { annual_amount: { ...(r.annual_amount ?? {}), value: n } })} />
                    <SourceChip value={r.annual_amount} readOnly={readOnly} onChange={(sv: SV) => upd(i, { annual_amount: sv })} />
                  </div>
                </td>
                <td className="w-24 border-b border-line px-1">
                  <NumInput className={`${cellInput} text-right tabular`} disabled={readOnly} value={r.growth_pct} placeholder="Default" onChange={(n) => upd(i, { growth_pct: n })} />
                </td>
                <td className="border-b border-line px-2">
                  <Checkbox checked={r.recoverable} onChange={(v) => !readOnly && upd(i, { recoverable: v })} label="Recoverable" />
                </td>
                <td className="border-b border-line px-1 text-right">
                  {!readOnly && (
                    <Button size="icon-sm" variant="ghost" aria-label="Remove line" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => onChange([...rows, { id: uid(), name: "New expense", category: "other", annual_amount: { value: null, source: null }, growth_pct: null, recoverable: false }])}>
            <Plus /> Add line item
          </Button>
        </div>
      )}
    </div>
  );
}

/** Sectioned assumption forms. Every material input shows a source chip; unsourced values are flagged in amber. */
export function AssumptionsEditor({ value, onChange, readOnly }: { value: Assumptions; onChange: (a: Assumptions) => void; readOnly: boolean }) {
  const g = (path: string) => getPath(value, path);
  const set = (path: string) => (v: unknown) => onChange(setPath(value, path, v));
  const sv = (path: string, label: string, suffix?: string, hint?: string) => (
    <SVField label={label} suffix={suffix} hint={hint} value={g(path)} readOnly={readOnly} onChange={set(path)} />
  );
  const num = (path: string, label: string, suffix?: string, hint?: string) => (
    <NumField label={label} suffix={suffix} hint={hint} value={g(path)} readOnly={readOnly} onChange={set(path)} />
  );
  const bool = (path: string, label: string) => (
    <label className="flex items-center gap-2 pt-6 text-sm text-ink">
      <Checkbox checked={!!g(path)} onChange={(v) => !readOnly && set(path)(v)} />
      {label}
    </label>
  );
  const isLand = value.model_type === "land";

  return (
    <div className="space-y-4">
      <FormSection title="Acquisition">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {sv("acquisition.purchase_price", "Purchase price", "$")}
          {sv("acquisition.closing_cost_pct", "Closing costs", "%")}
          <Field label="Analysis start">
            <Input type="date" disabled={readOnly} value={String(g("acquisition.analysis_start") ?? "")} onChange={(e) => set("acquisition.analysis_start")(e.target.value || null)} />
          </Field>
          {sv("acquisition.hold_years", "Hold period", "yrs")}
          {!isLand && num("acquisition.stabilized_year", "Stabilized year")}
        </div>
      </FormSection>

      <FormSection title="Financing" description={isLand ? "Optional land loan: price × LTV, interest-only, repaid at final sale." : "Loan = min(price × LTV, NOI / (DSCR × constant), NOI / debt yield)."}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {bool("financing.use_debt", "Use debt")}
          {sv("financing.ltv_max", "Max LTV", "%")}
          {!isLand && sv("financing.dscr_min", "Min DSCR", "x")}
          {!isLand && sv("financing.debt_yield_min", "Min debt yield", "%")}
          {sv("financing.interest_rate", "Interest rate", "%")}
          {!isLand && num("financing.amortization_years", "Amortization", "yrs")}
          {!isLand && num("financing.io_years", "Interest-only", "yrs")}
          {num("financing.loan_fee_pct", "Loan fee", "%")}
          {!isLand && num("financing.loan_amount_override", "Loan override", "$", "Leave blank to size")}
        </div>
      </FormSection>

      {isLand ? (
        <>
          <FormSection title="Site" description="Usable acres = gross − detention − floodplain − right-of-way unless entered.">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {sv("land.gross_acres", "Gross acres")}
              {sv("land.usable_acres", "Usable acres")}
              {num("land.detention_acres", "Detention", "ac")}
              {num("land.floodplain_acres", "Floodplain", "ac")}
              {num("land.row_acres", "Right-of-way", "ac")}
              {num("land.frontage_ft", "Frontage", "ft")}
              <Field label="Entitlement status">
                <Input disabled={readOnly} value={String(g("land.entitlement_status") ?? "")} onChange={(e) => set("land.entitlement_status")(e.target.value || null)} placeholder="e.g. Zoned C-2, plat pending" />
              </Field>
              <Field label="Utilities available" className="md:col-span-2">
                <Input
                  disabled={readOnly}
                  value={((g("land.utilities_available") as string[] | undefined) ?? []).join(", ")}
                  onChange={(e) => set("land.utilities_available")(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                  placeholder="Water, sewer, electric, gas"
                />
              </Field>
            </div>
          </FormSection>
          <FormSection title="Entitlement and development">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {sv("land.entitlement_cost", "Entitlement cost", "$")}
              {num("land.entitlement_months", "Entitlement", "mo")}
              {sv("land.utilities_cost", "Utilities", "$")}
              {sv("land.site_work_cost", "Site work", "$")}
              {num("land.detention_cost", "Detention cost", "$")}
              {num("land.development_months", "Development", "mo")}
              {num("land.carry_tax_annual", "Carry: taxes", "$/yr")}
              {num("land.carry_insurance_annual", "Carry: insurance", "$/yr")}
              {num("land.carry_other_annual", "Carry: other", "$/yr")}
            </div>
          </FormSection>
          <FormSection title="Exit">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Field label="Exit method">
                <Select
                  disabled={readOnly}
                  value={String(g("land.exit_method") ?? "bulk_sale")}
                  onChange={(e) => set("land.exit_method")(e.target.value)}
                  options={["bulk_sale", "parcelization", "ground_lease", "build_to_suit"].map((v) => ({ value: v, label: titleCase(v) }))}
                />
              </Field>
              {num("land.selling_cost_pct", "Selling costs", "%")}
              {g("land.exit_method") === "parcelization" ? (
                num("land.absorption_months", "Absorption", "mo")
              ) : g("land.exit_method") === "ground_lease" ? (
                <>
                  {sv("land.ground_lease_rent_annual", "Ground rent", "$/yr")}
                  {num("land.ground_lease_escalation_pct", "Rent escalation", "%/yr")}
                  {sv("land.ground_lease_cap", "Ground lease cap", "%")}
                </>
              ) : g("land.exit_method") === "build_to_suit" ? (
                <>
                  {num("land.bts_sale_price", "Build-to-suit sale", "$")}
                  {num("land.construction_months", "Construction", "mo")}
                </>
              ) : (
                <>
                  {sv("land.bulk_price_per_usable_acre", "Price per usable acre", "$")}
                  {num("land.bulk_sale_price", "Or bulk price", "$")}
                </>
              )}
            </div>
            {g("land.exit_method") === "parcelization" && (
              <div className="mt-4">
                <ListEditor
                  title="Parcelization lots"
                  readOnly={readOnly}
                  rows={(g("land.lots") as Record<string, unknown>[] | undefined) ?? []}
                  blank={{ name: "", acres: null, price_per_acre: null, price: null }}
                  onChange={set("land.lots")}
                  columns={[
                    { key: "name", label: "Lot", type: "text" },
                    { key: "acres", label: "Acres", type: "number" },
                    { key: "price_per_acre", label: "$ / acre", type: "number" },
                    { key: "price", label: "Or price", type: "number" },
                  ]}
                />
              </div>
            )}
          </FormSection>
        </>
      ) : (
        <>
          <FormSection title="Exit">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {sv("exit.exit_cap", "Exit cap rate", "%")}
              {num("exit.selling_cost_pct", "Selling costs", "%")}
              <Field label="Exit NOI basis">
                <Select disabled={readOnly} value={String(g("exit.exit_noi_basis") ?? "forward")} onChange={(e) => set("exit.exit_noi_basis")(e.target.value)} options={[{ value: "forward", label: "Forward 12 months" }, { value: "trailing", label: "Trailing 12 months" }]} />
              </Field>
            </div>
          </FormSection>

          <FormSection title="Revenue">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {sv("revenue.general_vacancy_pct", "General vacancy", "%")}
              {num("revenue.credit_loss_pct", "Credit loss", "%")}
              {sv("revenue.market_rent_growth_pct", "Market rent growth", "%/yr")}
              {num("revenue.other_income", "Other income", "$/yr")}
              {num("revenue.total_area_sf", "Total area", "SF", "Defaults to sum of rows")}
            </div>
          </FormSection>

          <FormSection title="Tenants and leases" description="Rent steps, recoveries, stops, abatements, percentage rent, options, expirations, renewal probability, downtime and TI/LC per row.">
            <LeasesTable leases={(value.leases ?? []) as LeaseRow[]} readOnly={readOnly} onChange={(rows) => onChange({ ...value, leases: rows })} />
          </FormSection>

          <FormSection title="Operating expenses">
            <ExpensesTable rows={(value.expenses ?? []) as ExpenseRow[]} readOnly={readOnly} onChange={(rows) => onChange({ ...value, expenses: rows })} />
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              {sv("expense_settings.mgmt_fee_pct", "Management fee", "% EGR")}
              {bool("expense_settings.mgmt_recoverable", "Management recoverable")}
              {num("expense_settings.expense_growth_pct", "Default growth", "%/yr")}
              {num("expense_settings.reserves_psf", "Reserves", "$/SF/yr")}
              {num("expense_settings.structural_reserve_annual", "Structural reserve", "$/yr")}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              {bool("expense_settings.tax_reassessment.enabled", "Reassess taxes on sale")}
              {num("expense_settings.tax_reassessment.assessment_ratio_pct", "Assessment ratio", "% of price")}
              {num("expense_settings.tax_reassessment.tax_rate_pct", "Tax rate", "%")}
              {bool("expense_settings.insurance_repricing.enabled", "Reprice insurance")}
              {num("expense_settings.insurance_repricing.new_annual_amount", "New premium", "$/yr")}
            </div>
          </FormSection>
        </>
      )}

      <FormSection title="Capital expenditures" description="One-off capital and structural obligations below NOI, by analysis year.">
        <ListEditor
          title="Capex"
          readOnly={readOnly}
          rows={(value.capex ?? []) as Record<string, unknown>[]}
          blank={{ year: 1, amount: null, description: "" }}
          onChange={(rows) => onChange({ ...value, capex: rows as Assumptions["capex"] })}
          columns={[
            { key: "year", label: "Year", type: "number" },
            { key: "amount", label: "Amount", type: "number" },
            { key: "description", label: "Description", type: "text" },
          ]}
        />
      </FormSection>
    </div>
  );
}
