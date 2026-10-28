import { z } from "zod";

import {
  CONTRACT_STATUSES, CONTRACT_TYPES, DECISION_KINDS, DD_STATUSES, ESTOPPEL_KINDS, ESTOPPEL_STATUSES, EXCEPTION_KINDS,
  EXCEPTION_SOURCES, EXCEPTION_STATUSES, REPORT_STATUSES, REPORT_TYPES, RISK_CATEGORIES, RISK_DECISIONS, RISK_STATUSES,
  SEVERITIES,
} from "./schema";

const contractStatus = z.enum(CONTRACT_STATUSES);
const contractType = z.enum(CONTRACT_TYPES);
const severity = z.enum(SEVERITIES);
const ddStatus = z.enum(DD_STATUSES);
const reportType = z.enum(REPORT_TYPES);
const reportStatus = z.enum(REPORT_STATUSES);
const exceptionKind = z.enum(EXCEPTION_KINDS);
const exceptionSource = z.enum(EXCEPTION_SOURCES);
const exceptionStatus = z.enum(EXCEPTION_STATUSES);
const estoppelKind = z.enum(ESTOPPEL_KINDS);
const estoppelStatus = z.enum(ESTOPPEL_STATUSES);
const riskCategory = z.enum(RISK_CATEGORIES);
const riskStatus = z.enum(RISK_STATUSES);
const riskDecision = z.enum(RISK_DECISIONS);
const decisionKind = z.enum(DECISION_KINDS);

const uuid = () => z.string().uuid();
const day = () => z.string().date();

// --------------------------------------------------------------------------- contracts

export const party = z.object({
  role: z.string().max(40),
  name: z.string().min(1).max(200),
  person_id: uuid().nullish(),
  organization_id: uuid().nullish(),
  notes: z.string().nullish(),
});
export type Party = z.infer<typeof party>;

const contractFields = {
  contract_type: contractType.default("purchase_sale"),
  document_id: uuid().nullish(),
  offer_id: uuid().nullish(),
  opportunity_id: uuid().nullish(),
  property_id: uuid().nullish(),
  owner_id: uuid().nullish(),
  effective_on: day().nullish(),
  executed_on: day().nullish(),
  purchase_price: z.number().min(0).nullish(),
  earnest_money: z.number().min(0).nullish(),
  additional_deposit: z.number().min(0).nullish(),
  parties: z.array(party).default([]),
  key_terms: z.record(z.string(), z.any()).default({}),
  calendar_id: uuid().nullish(),
  attorney_person_id: uuid().nullish(),
  attorney_organization_id: uuid().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};

export const contractCreate = z.object({ ...contractFields, title: z.string().max(255).nullish() });
export type ContractCreate = z.infer<typeof contractCreate>;

export const contractUpdate = z
  .object({
    title: z.string().min(1).max(255).nullish(),
    contract_type: contractType.nullish(),
    status: contractStatus.nullish(),
    document_id: uuid().nullish(),
    offer_id: uuid().nullish(),
    opportunity_id: uuid().nullish(),
    property_id: uuid().nullish(),
    owner_id: uuid().nullish(),
    effective_on: day().nullish(),
    executed_on: day().nullish(),
    purchase_price: z.number().min(0).nullish(),
    earnest_money: z.number().min(0).nullish(),
    additional_deposit: z.number().min(0).nullish(),
    parties: z.array(party).nullish(),
    key_terms: z.record(z.string(), z.any()).nullish(),
    calendar_id: uuid().nullish(),
    attorney_person_id: uuid().nullish(),
    attorney_organization_id: uuid().nullish(),
    notes: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .strict();
export type ContractUpdate = z.infer<typeof contractUpdate>;

export const executeIn = z.object({ effective_on: day().nullish(), executed_on: day().nullish() });
export type ExecuteIn = z.infer<typeof executeIn>;

// --------------------------------------------------------------------------- critical dates

export const criticalDateCreate = z.object({
  related_type: z.string().min(1).max(40),
  related_id: uuid(),
  related_label: z.string().max(300).nullish(),
  property_id: uuid().nullish(),
  date_type: z.string().max(40).default("other"),
  label: z.string().min(1).max(300),
  due_on: day(),
  owner_id: uuid().nullish(),
  lead_days: z.number().int().min(0).max(365).default(14),
  is_blocking: z.boolean().default(false),
  notes: z.string().nullish(),
  key: z.string().max(80).nullish(),
});
export type CriticalDateCreate = z.infer<typeof criticalDateCreate>;

/** Due date changes go through /reschedule so the reason is kept. */
export const criticalDateUpdate = z
  .object({
    label: z.string().min(1).max(300).nullish(),
    date_type: z.string().max(40).nullish(),
    owner_id: uuid().nullish(),
    lead_days: z.number().int().min(0).max(365).nullish(),
    is_blocking: z.boolean().nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type CriticalDateUpdate = z.infer<typeof criticalDateUpdate>;

export const confirmIn = z.object({
  note: z.string().max(2000).nullish(),
  due_on: day().nullish(), // corrected value read from the source document
});
export type ConfirmIn = z.infer<typeof confirmIn>;

export const noteIn = z.object({ note: z.string().max(2000).nullish() });
export type NoteIn = z.infer<typeof noteIn>;

export const requiredNoteIn = z.object({ note: z.string().min(1).max(2000) });
export type RequiredNoteIn = z.infer<typeof requiredNoteIn>;

export const rescheduleIn = z.object({ due_on: day(), reason: z.string().min(1).max(2000) });
export type RescheduleIn = z.infer<typeof rescheduleIn>;

export const bulkDatesIn = z.object({
  ids: z.array(uuid()).min(1).max(200),
  action: z.enum(["confirm", "complete"]),
  note: z.string().max(2000).nullish(),
});
export type BulkDatesIn = z.infer<typeof bulkDatesIn>;

// --------------------------------------------------------------------------- calendars

export const holidayCalendarCreate = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
  description: z.string().nullish(),
  weekend_days: z.array(z.number().int()).default([5, 6]),
  copy_from_id: uuid().nullish(),
});
export type HolidayCalendarCreate = z.infer<typeof holidayCalendarCreate>;

export const holidayIn = z.object({ holiday_on: day(), name: z.string().min(1).max(160) });
export type HolidayIn = z.infer<typeof holidayIn>;

// --------------------------------------------------------------------------- DD

export const ddTemplateItem = z.object({
  key: z.string().min(1).max(80),
  category: z.string().max(60).default("general"),
  title: z.string().min(1).max(300),
  description: z.string().nullish(),
  severity: severity.nullish(),
  due_days: z.number().int().min(0).max(730).nullish(),
  depends_on: z.array(z.string()).default([]),
  report_type: reportType.nullish(),
});
export type DDTemplateItem = z.infer<typeof ddTemplateItem>;

export const ddTemplateCreate = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  property_types: z.array(z.string()).default([]),
  items: z.array(ddTemplateItem).default([]),
});
export type DDTemplateCreate = z.infer<typeof ddTemplateCreate>;

export const ddTemplateUpdate = z
  .object({
    name: z.string().min(1).max(160).nullish(),
    property_types: z.array(z.string()).nullish(),
    is_active: z.boolean().nullish(),
    items: z.array(ddTemplateItem).nullish(),
  })
  .strict();
export type DDTemplateUpdate = z.infer<typeof ddTemplateUpdate>;

export const applyTemplateIn = z.object({ template_id: uuid().nullish() });
export type ApplyTemplateIn = z.infer<typeof applyTemplateIn>;

export const ddItemCreate = z.object({
  category: z.string().max(60).default("general"),
  title: z.string().min(1).max(300),
  description: z.string().nullish(),
  owner_id: uuid().nullish(),
  status: ddStatus.default("not_started"),
  due_on: day().nullish(),
  depends_on: z.array(uuid()).default([]),
  source: z.string().max(30).default("manual"),
  findings: z.string().nullish(),
  severity: severity.nullish(),
  cost_impact: z.number().nullish(),
  resolution: z.string().nullish(),
});
export type DDItemCreate = z.infer<typeof ddItemCreate>;

export const ddItemUpdate = z
  .object({
    category: z.string().max(60).nullish(),
    title: z.string().min(1).max(300).nullish(),
    description: z.string().nullish(),
    owner_id: uuid().nullish(),
    status: ddStatus.nullish(),
    due_on: day().nullish(),
    depends_on: z.array(uuid()).nullish(),
    source: z.string().max(30).nullish(),
    findings: z.string().nullish(),
    severity: severity.nullish(),
    cost_impact: z.number().nullish(),
    resolution: z.string().nullish(),
  })
  .strict();
export type DDItemUpdate = z.infer<typeof ddItemUpdate>;

export const escalateIn = z.object({ note: z.string().min(1).max(2000) });
export type EscalateIn = z.infer<typeof escalateIn>;

// --------------------------------------------------------------------------- third-party reports

const reportFields = {
  vendor_organization_id: uuid().nullish(),
  vendor_name: z.string().max(200).nullish(),
  status: reportStatus.default("not_ordered"),
  ordered_on: day().nullish(),
  expected_on: day().nullish(),
  delivered_on: day().nullish(),
  cost: z.number().min(0).nullish(),
  findings: z.string().nullish(),
  severity: severity.nullish(),
  document_id: uuid().nullish(),
  owner_id: uuid().nullish(),
  notes: z.string().nullish(),
};

export const reportCreate = z.object({ ...reportFields, report_type: reportType });
export type ReportCreate = z.infer<typeof reportCreate>;

export const reportUpdate = z
  .object({
    ...reportFields,
    report_type: reportType.nullish(),
    status: reportStatus.nullish(),
  })
  .strict();
export type ReportUpdate = z.infer<typeof reportUpdate>;

// --------------------------------------------------------------------------- title & survey

const exceptionFields = {
  kind: exceptionKind.default("title_exception"),
  source: exceptionSource.default("title_commitment"),
  schedule_ref: z.string().max(80).nullish(),
  recording_ref: z.string().max(160).nullish(),
  severity: severity.nullish(),
  status: exceptionStatus.default("open"),
  objection_sent_on: day().nullish(),
  cure_due_on: day().nullish(),
  cure_response: z.string().nullish(),
  resolved_on: day().nullish(),
  attorney_person_id: uuid().nullish(),
  attorney_organization_id: uuid().nullish(),
  document_id: uuid().nullish(),
  notes: z.string().nullish(),
};

export const titleExceptionCreate = z.object({ ...exceptionFields, description: z.string().min(1) });
export type TitleExceptionCreate = z.infer<typeof titleExceptionCreate>;

export const titleExceptionUpdate = z
  .object({
    ...exceptionFields,
    kind: exceptionKind.nullish(),
    source: exceptionSource.nullish(),
    status: exceptionStatus.nullish(),
    description: z.string().min(1).nullish(),
  })
  .strict();
export type TitleExceptionUpdate = z.infer<typeof titleExceptionUpdate>;

// --------------------------------------------------------------------------- estoppels / SNDA

const estoppelFields = {
  kind: estoppelKind.default("estoppel"),
  lease_id: uuid().nullish(),
  status: estoppelStatus.default("not_requested"),
  requested_on: day().nullish(),
  due_on: day().nullish(),
  received_on: day().nullish(),
  expected_monthly_rent: z.number().nullish(),
  expected_expiration_on: day().nullish(),
  expected_security_deposit: z.number().nullish(),
  reported_monthly_rent: z.number().nullish(),
  reported_expiration_on: day().nullish(),
  reported_security_deposit: z.number().nullish(),
  reported_landlord_default: z.boolean().nullish(),
  reported_notes: z.string().nullish(),
  document_id: uuid().nullish(),
  notes: z.string().nullish(),
};

export const estoppelCreate = z.object({ ...estoppelFields, tenant_name: z.string().min(1).max(200) });
export type EstoppelCreate = z.infer<typeof estoppelCreate>;

export const estoppelUpdate = z
  .object({
    ...estoppelFields,
    kind: estoppelKind.nullish(),
    status: estoppelStatus.nullish(),
    tenant_name: z.string().min(1).max(200).nullish(),
  })
  .strict();
export type EstoppelUpdate = z.infer<typeof estoppelUpdate>;

// --------------------------------------------------------------------------- risks & decisions

export const riskCreate = z.object({
  title: z.string().min(1).max(300),
  description: z.string().nullish(),
  category: riskCategory.default("other"),
  severity: severity.default("medium"),
  source_type: z.string().max(40).nullish(),
  source_id: uuid().nullish(),
  owner_id: uuid().nullish(),
  cost_impact: z.number().nullish(),
  mitigation: z.string().nullish(),
  decision_required: z.boolean().nullish(), // defaults to true for high/critical
  decision_due_on: day().nullish(),
});
export type RiskCreate = z.infer<typeof riskCreate>;

export const riskUpdate = z
  .object({
    title: z.string().min(1).max(300).nullish(),
    description: z.string().nullish(),
    category: riskCategory.nullish(),
    severity: severity.nullish(),
    status: riskStatus.nullish(),
    owner_id: uuid().nullish(),
    cost_impact: z.number().nullish(),
    mitigation: z.string().nullish(),
    decision_required: z.boolean().nullish(),
    decision_due_on: day().nullish(),
  })
  .strict();
export type RiskUpdate = z.infer<typeof riskUpdate>;

export const riskDecideIn = z.object({ decision: riskDecision, reason: z.string().min(1).max(4000) });
export type RiskDecideIn = z.infer<typeof riskDecideIn>;

export const decisionCreate = z.object({
  kind: decisionKind,
  reasoning: z.string().min(1).max(8000),
  critical_date_id: uuid().nullish(),
  new_due_on: day().nullish(),
  effective_on: day().nullish(),
});
export type DecisionCreate = z.infer<typeof decisionCreate>;
