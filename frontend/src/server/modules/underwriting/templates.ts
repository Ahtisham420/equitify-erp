/**
 * Property-type templates that seed the assumption structure of a new underwriting model (spec module 12).
 *
 * Template defaults are deliberately left *unsourced* (`source: None`) so the analyst must confirm or source every
 * material assumption before approval; values copied from records (property, spaces, leases, comps) carry a source.
 */
import { randomUUID } from "node:crypto";

import { isoDate, firstOfMonth, type Obj, type PyDate } from "./pyutil";

export const TEMPLATES: Record<string, { label: string; model_type: string }> = {
  stnl: { label: "Single-tenant net lease", model_type: "income" },
  multi_tenant_retail: { label: "Multi-tenant retail", model_type: "income" },
  gas_convenience: { label: "Gas / convenience", model_type: "income" },
  medical: { label: "Medical", model_type: "income" },
  ground_lease: { label: "Ground lease", model_type: "income" },
  land: { label: "Land", model_type: "land" },
};

// Suggested template per property type.
export const PROPERTY_TYPE_TEMPLATE: Record<string, string> = {
  stnl: "stnl",
  retail: "multi_tenant_retail",
  multi_tenant_retail: "multi_tenant_retail",
  gas_convenience: "gas_convenience",
  medical: "medical",
  ground_lease: "ground_lease",
  land: "land",
};

interface LeaseDefaults {
  recovery_type: string;
  escalation_pct: number;
  renewal: number;
  downtime: number;
  term: number;
  ti_new: number;
  ti_renewal: number;
  lc_new: number;
  lc_renewal: number;
  free: number;
}

export const LEASE_DEFAULTS: Record<string, LeaseDefaults> = {
  stnl: { recovery_type: "nnn", escalation_pct: 1.5, renewal: 75, downtime: 9, term: 10, ti_new: 10, ti_renewal: 0, lc_new: 4, lc_renewal: 2, free: 3 },
  multi_tenant_retail: { recovery_type: "nnn", escalation_pct: 3, renewal: 65, downtime: 6, term: 5, ti_new: 15, ti_renewal: 5, lc_new: 6, lc_renewal: 3, free: 3 },
  gas_convenience: { recovery_type: "nnn", escalation_pct: 1.5, renewal: 80, downtime: 12, term: 10, ti_new: 25, ti_renewal: 0, lc_new: 4, lc_renewal: 2, free: 3 },
  medical: { recovery_type: "base_year", escalation_pct: 3, renewal: 70, downtime: 9, term: 7, ti_new: 45, ti_renewal: 15, lc_new: 6, lc_renewal: 3, free: 4 },
  ground_lease: { recovery_type: "nnn", escalation_pct: 1, renewal: 90, downtime: 12, term: 20, ti_new: 0, ti_renewal: 0, lc_new: 0, lc_renewal: 0, free: 0 },
};

// [name, category, recoverable]
export const EXPENSE_LINES: Record<string, Array<[string, string, boolean]>> = {
  stnl: [],
  multi_tenant_retail: [
    ["Real estate taxes", "tax", true],
    ["Insurance", "insurance", true],
    ["Common area maintenance", "cam", true],
    ["Utilities", "utilities", true],
    ["Non-recoverable repairs", "repairs", false],
  ],
  gas_convenience: [["Environmental monitoring", "other", false]],
  medical: [
    ["Real estate taxes", "tax", true],
    ["Insurance", "insurance", true],
    ["Common area maintenance", "cam", true],
    ["Utilities", "utilities", true],
    ["Janitorial", "other", true],
  ],
  ground_lease: [],
};

interface Settings {
  vacancy: number;
  credit: number;
  mgmt: number;
  mgmt_rec: boolean;
  reserves: number;
  stab: number;
  ltv: number;
  dscr: number;
  dy: number;
}

export const SETTINGS: Record<string, Settings> = {
  stnl: { vacancy: 0, credit: 0, mgmt: 1, mgmt_rec: false, reserves: 0.1, stab: 1, ltv: 60, dscr: 1.25, dy: 8 },
  multi_tenant_retail: { vacancy: 3, credit: 1, mgmt: 4, mgmt_rec: true, reserves: 0.2, stab: 2, ltv: 60, dscr: 1.3, dy: 9 },
  gas_convenience: { vacancy: 0, credit: 0, mgmt: 1, mgmt_rec: false, reserves: 0.25, stab: 1, ltv: 55, dscr: 1.3, dy: 9 },
  medical: { vacancy: 5, credit: 0.5, mgmt: 3.5, mgmt_rec: true, reserves: 0.25, stab: 2, ltv: 60, dscr: 1.3, dy: 9 },
  ground_lease: { vacancy: 0, credit: 0, mgmt: 0, mgmt_rec: false, reserves: 0, stab: 1, ltv: 65, dscr: 1.2, dy: 7 },
};

export const INCOME_SCENARIOS: Obj[] = [
  { key: "base", name: "Base", kind: "base", overrides: {} },
  {
    key: "downside", name: "Downside", kind: "downside",
    overrides: {
      "exit.exit_cap": { delta: 0.5 }, "revenue.general_vacancy_pct": { delta: 3 },
      "revenue.market_rent_growth_pct": { delta: -1 }, "leases.*.renewal_probability_pct": { delta: -20 },
      "financing.interest_rate": { delta: 0.5 },
    },
  },
  {
    key: "upside", name: "Upside", kind: "upside",
    overrides: {
      "exit.exit_cap": { delta: -0.25 }, "revenue.market_rent_growth_pct": { delta: 0.5 },
      "leases.*.renewal_probability_pct": { delta: 10 },
    },
  },
];
export const LAND_SCENARIOS: Obj[] = [
  { key: "base", name: "Base", kind: "base", overrides: {} },
  {
    key: "downside", name: "Downside", kind: "downside",
    overrides: {
      "land.bulk_price_per_usable_acre": { mult: 0.9 }, "land.entitlement_months": { delta: 6 },
      "land.entitlement_cost": { mult: 1.2 },
    },
  },
  { key: "upside", name: "Upside", kind: "upside", overrides: { "land.bulk_price_per_usable_acre": { mult: 1.1 } } },
];

/** Sourced value. */
export function sv(value: any = null, source: string | null = null, extra: Obj = {}): Obj {
  return { value, source, ...extra };
}

export const shortId = () => randomUUID().replace(/-/g, "").slice(0, 8);

export interface LeaseRowOpts {
  tenant?: string | null;
  suite?: string | null;
  space_id?: string | null;
  lease_id?: string | null;
  area_sf?: number | null;
  vacant?: boolean;
  base_rent_annual?: number | null;
  rent_source?: string | null;
  commencement_on?: string | null;
  expiration_on?: string | null;
  rent_steps?: any[] | null;
  source?: string | null;
}

export function leaseRow(template: string, o: LeaseRowOpts = {}): Obj {
  const d = LEASE_DEFAULTS[template] ?? LEASE_DEFAULTS.multi_tenant_retail;
  return {
    id: shortId(),
    tenant: o.tenant ?? null,
    suite: o.suite ?? null,
    space_id: o.space_id ?? null,
    lease_id: o.lease_id ?? null,
    row_source: o.source ?? null,
    area_sf: o.area_sf ?? null,
    vacant: o.vacant ?? false,
    commencement_on: o.commencement_on ?? null,
    expiration_on: o.expiration_on ?? null,
    base_rent_annual: sv(o.base_rent_annual ?? null, o.rent_source ?? null),
    rent_psf: null,
    rent_steps: o.rent_steps?.length ? o.rent_steps : [],
    escalation_pct: d.escalation_pct,
    recovery_type: d.recovery_type,
    expense_stop_psf: null,
    recovery_share_pct: null,
    fixed_recovery_annual: null,
    abatements: [],
    percentage_rent: { rate_pct: null, sales_annual: null, sales_growth_pct: null, breakpoint: null },
    options: [],
    renewal_probability_pct: sv(d.renewal),
    downtime_months: d.downtime,
    market_rent_psf: sv(null),
    new_lease_term_years: d.term,
    ti_new_psf: d.ti_new,
    ti_renewal_psf: d.ti_renewal,
    lc_new_pct: d.lc_new,
    lc_renewal_pct: d.lc_renewal,
    free_rent_new_months: d.free,
    tenant_credit: null,
  };
}

export interface SeedOpts {
  start: PyDate;
  purchase_price?: number | null;
  price_source?: string | null;
  total_area_sf?: number | null;
  area_source?: string | null;
  gross_acres?: number | null;
  acres_source?: string | null;
}

/** Blank assumption structure for a template. */
export function seed(template: string, o: SeedOpts): Obj {
  if (!(template in TEMPLATES)) template = "multi_tenant_retail";
  const common: Obj = {
    template,
    model_type: TEMPLATES[template].model_type,
    acquisition: {
      purchase_price: sv(o.purchase_price ?? null, o.price_source ?? null),
      closing_cost_pct: sv(1.5),
      analysis_start: isoDate(firstOfMonth(o.start)),
      hold_years: sv(10),
      stabilized_year: 1,
    },
    capex: [],
  };
  if (template === "land") {
    return {
      ...common,
      financing: { use_debt: false, ltv_max: sv(50), interest_rate: sv(8.0), loan_fee_pct: 1.0 },
      land: {
        gross_acres: sv(o.gross_acres ?? null, o.acres_source ?? null),
        usable_acres: sv(null), detention_acres: 0, floodplain_acres: 0, row_acres: 0, frontage_ft: null,
        utilities_available: [], entitlement_status: null, entitlement_cost: sv(null), entitlement_months: 9,
        utilities_cost: sv(null), site_work_cost: sv(null), detention_cost: 0, development_months: 6,
        exit_method: "bulk_sale", bulk_price_per_usable_acre: sv(null), bulk_sale_price: null,
        lots: [], absorption_months: 18, ground_lease_rent_annual: sv(null),
        ground_lease_escalation_pct: 1.5, ground_lease_cap: sv(null), bts_sale_price: null,
        construction_months: 9, selling_cost_pct: 3, carry_tax_annual: null,
        carry_insurance_annual: null, carry_other_annual: null,
      },
      scenarios_seed: LAND_SCENARIOS,
    };
  }
  const s = SETTINGS[template];
  return {
    ...common,
    acquisition: { ...common.acquisition, stabilized_year: s.stab },
    financing: {
      use_debt: true, ltv_max: sv(s.ltv), dscr_min: sv(s.dscr), debt_yield_min: sv(s.dy),
      interest_rate: sv(6.5), amortization_years: 25, io_years: 0, loan_fee_pct: 1.0,
      loan_amount_override: null,
    },
    exit: { exit_cap: sv(null), selling_cost_pct: 2.0, exit_noi_basis: "forward" },
    revenue: {
      general_vacancy_pct: sv(s.vacancy), credit_loss_pct: s.credit, other_income: 0,
      market_rent_growth_pct: sv(2.5), total_area_sf: o.total_area_sf ?? null, total_area_source: o.area_source ?? null,
    },
    expense_settings: {
      mgmt_fee_pct: sv(s.mgmt), mgmt_recoverable: s.mgmt_rec, expense_growth_pct: 3.0,
      reserves_psf: s.reserves, structural_reserve_annual: 0,
      tax_reassessment: { enabled: false, assessment_ratio_pct: 100, tax_rate_pct: 2.0 },
      insurance_repricing: { enabled: false, new_annual_amount: null, change_pct: 0 },
    },
    leases: [],
    expenses: EXPENSE_LINES[template].map(([name, cat, rec]) => ({
      id: shortId(), name, category: cat, annual_amount: sv(0), growth_pct: null, recoverable: rec,
    })),
    scenarios_seed: INCOME_SCENARIOS,
  };
}
