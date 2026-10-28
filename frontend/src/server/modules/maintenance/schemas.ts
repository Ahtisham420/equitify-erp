import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().date();
const datetime = z.coerce.date();

const source = z.enum(["tenant", "staff", "inspection", "preventive"]);
const priority = z.enum(["low", "normal", "high", "urgent"]);
const severity = z.enum(["low", "medium", "high", "critical"]);
const responsibility = z.enum(["undetermined", "tenant", "landlord", "shared"]);

// ---------------------------------------------------------------- work orders

export const workOrderCreate = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  source: source.default("staff"),
  category: z.string().default("general"),
  priority: priority.default("normal"),
  property_id: uuid,
  asset_id: uuid.nullish(),
  space_id: uuid.nullish(),
  lease_id: uuid.nullish(),
  system: z.string().nullish(),
  location_detail: z.string().nullish(),
  requested_by_name: z.string().nullish(),
  requester_contact: z.string().nullish(),
  tenant_organization_id: uuid.nullish(),
  reported_at: datetime.nullish(),
  due_on: date.nullish(),
  estimate_amount: z.number().min(0).nullish(),
  photo_document_ids: z.array(uuid).default([]),
});
export type WorkOrderCreate = z.infer<typeof workOrderCreate>;

export const workOrderUpdate = z
  .object({
    title: z.string().min(1).max(200).nullish(),
    description: z.string().nullish(),
    category: z.string().nullish(),
    priority: priority.nullish(),
    asset_id: uuid.nullish(),
    space_id: uuid.nullish(),
    lease_id: uuid.nullish(),
    system: z.string().nullish(),
    location_detail: z.string().nullish(),
    requested_by_name: z.string().nullish(),
    requester_contact: z.string().nullish(),
    tenant_organization_id: uuid.nullish(),
    due_on: date.nullish(),
    photo_document_ids: z.array(uuid).nullish(),
  })
  .strict();
export type WorkOrderUpdate = z.infer<typeof workOrderUpdate>;

export const assignIn = z.object({
  assignee_type: z.enum(["vendor", "staff"]),
  vendor_id: uuid.nullish(),
  assigned_user_id: uuid.nullish(),
});
export type AssignIn = z.infer<typeof assignIn>;

export const transitionIn = z.object({
  status: z.enum(["open", "assigned", "in_progress", "completed", "verified", "cancelled"]),
  note: z.string().nullish(),
  completion_notes: z.string().nullish(),
  actual_cost: z.number().min(0).nullish(),
  evidence_document_ids: z.array(uuid).default([]),
  cancelled_reason: z.string().nullish(),
});
export type TransitionIn = z.infer<typeof transitionIn>;

export const costIn = z.object({
  estimate_amount: z.number().min(0).nullish(),
  actual_cost: z.number().min(0).nullish(),
  note: z.string().nullish(),
});
export type CostIn = z.infer<typeof costIn>;

export const approvalIn = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().nullish(),
});

/** Empty body = determine from lease obligations; otherwise a manual determination with a reason. */
export const responsibilityIn = z.object({
  responsibility: responsibility.nullish(),
  tenant_share_pct: z.number().min(0).max(100).nullish(),
  reason: z.string().nullish(),
});
export type ResponsibilityIn = z.infer<typeof responsibilityIn>;

export const satisfactionIn = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullish(),
});

export const evidenceIn = z.object({
  document_ids: z.array(uuid).min(1),
});

export const bulkWorkOrderIn = z.object({
  ids: z.array(uuid).min(1).max(500),
  priority: priority.nullish(),
  assigned_user_id: uuid.nullish(),
});

export const settingsIn = z.object({
  approval_threshold: z.number().min(0),
  finding_auto_wo_severity: severity.default("high"),
  pm_default_lead_days: z.number().int().min(0).max(180).default(14),
});
export type SettingsIn = z.infer<typeof settingsIn>;

// ---------------------------------------------------------------- preventive maintenance

export const pmScheduleIn = z.object({
  property_id: uuid,
  asset_id: uuid.nullish(),
  system: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  category: z.string().default("general"),
  priority: priority.default("normal"),
  frequency: z.enum(["weekly", "monthly", "quarterly", "semiannual", "annual", "custom"]).default("quarterly"),
  interval_days: z.number().int().min(1).max(3650).nullish(),
  lead_days: z.number().int().min(0).max(180).default(14),
  last_service_on: date.nullish(),
  next_service_on: date,
  default_vendor_id: uuid.nullish(),
  default_assignee_id: uuid.nullish(),
  estimate_amount: z.number().min(0).nullish(),
  is_active: z.boolean().default(true),
});
export type PMScheduleIn = z.infer<typeof pmScheduleIn>;

// ---------------------------------------------------------------- inspections

// Python dumps unset optionals as null; keep the stored section JSON the same shape.
export const templateItem = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(200),
    guidance: z.string().nullish(),
    category: z.string().nullish(),
  })
  .transform((v) => ({ key: v.key, label: v.label, guidance: v.guidance ?? null, category: v.category ?? null }));

export const templateSection = z.object({
  key: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  items: z.array(templateItem).default([]),
});

export const templateIn = z.object({
  name: z.string().min(1).max(160),
  property_type: z.string().nullish(),
  description: z.string().nullish(),
  sections: z.array(templateSection).default([]),
  is_active: z.boolean().default(true),
});
export type TemplateIn = z.infer<typeof templateIn>;

export const inspectionCreate = z.object({
  template_id: uuid,
  property_id: uuid,
  asset_id: uuid.nullish(),
  inspector_id: uuid.nullish(),
  scheduled_on: date.nullish(),
});
export type InspectionCreate = z.infer<typeof inspectionCreate>;

export const inspectionUpdate = z
  .object({
    inspector_id: uuid.nullish(),
    scheduled_on: date.nullish(),
    summary: z.string().nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
  })
  .strict();
export type InspectionUpdate = z.infer<typeof inspectionUpdate>;

export const responseIn = z.object({
  item_key: z.string(),
  result: z.enum(["pass", "fail", "na"]).nullish(),
  note: z.string().nullish(),
});
export type ResponseIn = z.infer<typeof responseIn>;

export const responsesIn = z.object({
  responses: z.array(responseIn).min(1),
});

export const inspectionStatusIn = z.object({
  status: z.enum(["in_progress", "completed", "cancelled"]),
  summary: z.string().nullish(),
});

export const findingIn = z.object({
  item_key: z.string().nullish(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  category: z.string().default("general"),
  severity: severity.default("medium"),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  location_accuracy_m: z.number().min(0).nullish(),
  captured_at: datetime.nullish(),
  photo_document_ids: z.array(uuid).default([]),
});
export type FindingIn = z.infer<typeof findingIn>;

export const findingUpdate = z
  .object({
    title: z.string().min(1).max(200).nullish(),
    description: z.string().nullish(),
    category: z.string().nullish(),
    severity: severity.nullish(),
    status: z.enum(["open", "resolved", "deferred"]).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    location_accuracy_m: z.number().nullish(),
    photo_document_ids: z.array(uuid).nullish(),
  })
  .strict();
export type FindingUpdate = z.infer<typeof findingUpdate>;
