"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { Badge, StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { formatCurrency, titleCase, toNumber } from "@/lib/utils";

import { PROJECT_CATEGORIES, useSaveProject, type Milestone, type Project, type ProjectInput, type ProjectUpdate } from "./api";

/* ------------------------------------------------------------------ shared bits */

const PROJECT_TONES: Record<string, Tone> = { pending_approval: "amber", bidding: "sky", awarded: "blue" };

export function ProjectStatusBadge({ status }: { status: string }) {
  const tone = PROJECT_TONES[status];
  if (tone) {
    return (
      <Badge tone={tone} dot>
        {titleCase(status)}
      </Badge>
    );
  }
  return <StatusBadge status={status} />;
}

export function categoryLabel(c: string): string {
  return c === "hvac" ? "HVAC" : c === "ada" ? "ADA" : titleCase(c);
}

/* ------------------------------------------------------------------ form */

interface MilestoneRow { key: string; label: string; due_on: string; completed_on: string }

interface FormState {
  property_id: string | null;
  name: string;
  category: string;
  scope: string;
  manager_id: string | null;
  original_budget: string;
  contingency: string;
  start_on: string;
  target_completion_on: string;
  useful_life_years: string;
  milestones: MilestoneRow[];
  warranty_expires_on: string;
  warranty_terms: string;
  notes: string;
}

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const blank = (v: string) => (v.trim() === "" ? null : v.trim());

let keySeq = 0;
function newKey(label: string): string {
  keySeq += 1;
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "milestone";
  return `${slug}_${Date.now().toString(36)}${keySeq}`;
}

function toForm(p?: Project | null, defaults?: Partial<ProjectInput>): FormState {
  return {
    property_id: p?.property_id ?? defaults?.property_id ?? null,
    name: p?.name ?? defaults?.name ?? "",
    category: p?.category ?? defaults?.category ?? "other",
    scope: str(p?.scope ?? defaults?.scope),
    manager_id: p?.manager_id ?? defaults?.manager_id ?? null,
    original_budget: str(p?.original_budget ?? defaults?.original_budget),
    contingency: str(p?.contingency ?? defaults?.contingency),
    start_on: str(p?.start_on ?? defaults?.start_on),
    target_completion_on: str(p?.target_completion_on ?? defaults?.target_completion_on),
    useful_life_years: str(p?.useful_life_years ?? defaults?.useful_life_years),
    milestones: (p?.milestones ?? defaults?.milestones ?? []).map((m) => ({
      key: m.key,
      label: m.label,
      due_on: str(m.due_on),
      completed_on: str(m.completed_on),
    })),
    warranty_expires_on: str(p?.warranty_expires_on),
    warranty_terms: str(p?.warranty_terms),
    notes: str(p?.notes ?? defaults?.notes),
  };
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
        {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function ProjectFormSheet({
  open,
  onOpenChange,
  project,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  project?: Project | null;
  defaults?: Partial<ProjectInput>;
  onSaved?: (p: Project) => void;
}) {
  const [form, setForm] = useState<FormState>(toForm(project, defaults));
  const save = useSaveProject(project?.id);
  const editing = !!project;

  useEffect(() => {
    if (open) setForm(toForm(project, defaults));
    // defaults is usually an inline object; only reset when the sheet opens or the record changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const bind = (
    key: "name" | "scope" | "original_budget" | "contingency" | "start_on" | "target_completion_on" | "useful_life_years" | "warranty_expires_on" | "warranty_terms" | "notes",
  ) => ({
    id: `project-${key}`,
    value: form[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
  });

  const setMilestone = (i: number, patch: Partial<MilestoneRow>) =>
    set("milestones", form.milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error("Project name is required");
    if (form.start_on && form.target_completion_on && form.target_completion_on < form.start_on) {
      return toast.error("Target completion is before the start date");
    }
    const life = toNumber(form.useful_life_years);
    if (life !== null && (life < 1 || life > 100 || !Number.isInteger(life))) return toast.error("Useful life must be a whole number of years between 1 and 100");
    const contingency = toNumber(form.contingency);
    if (contingency !== null && contingency < 0) return toast.error("Contingency cannot be negative");

    const milestones: Milestone[] = form.milestones
      .filter((m) => m.label.trim())
      .map((m) => ({ key: m.key || newKey(m.label), label: m.label.trim(), due_on: m.due_on || null, completed_on: m.completed_on || null }));

    const common = {
      name: form.name.trim(),
      category: form.category,
      scope: blank(form.scope),
      manager_id: form.manager_id,
      contingency,
      start_on: form.start_on || null,
      target_completion_on: form.target_completion_on || null,
      milestones,
      useful_life_years: life,
      notes: blank(form.notes),
    };

    let data: ProjectInput | ProjectUpdate;
    if (editing) {
      data = { ...common, warranty_expires_on: form.warranty_expires_on || null, warranty_terms: blank(form.warranty_terms) };
    } else {
      const budget = toNumber(form.original_budget);
      if (!form.property_id) return toast.error("Select a property");
      if (budget === null || budget < 0) return toast.error("Enter the original budget");
      data = { ...common, property_id: form.property_id, original_budget: budget };
    }

    save.mutate(data, {
      onSuccess: (p) => {
        toast.success(editing ? "Project updated" : "Project created as draft");
        onOpenChange(false);
        onSaved?.(p);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit capital project" : "New capital project"}
      description={editing ? project?.name : "Projects start as drafts and move through budget approval, bidding, award and execution."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="project-form" loading={save.isPending}>
            {editing ? "Save changes" : "Create project"}
          </Button>
        </>
      }
    >
      <form id="project-form" onSubmit={submit} className="space-y-6">
        <Section title="Project">
          <div className="grid grid-cols-2 gap-3">
            {!editing && (
              <Field label="Property" required className="col-span-2">
                <PropertyPicker value={form.property_id} onChange={(id) => set("property_id", id)} />
              </Field>
            )}
            <Field label="Name" required className="col-span-2">
              <Input {...bind("name")} required placeholder="e.g. Roof replacement – building A" />
            </Field>
            <Field label="Category">
              <Select value={form.category} onChange={(e) => set("category", e.target.value)} options={PROJECT_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))} />
            </Field>
            <Field label="Project manager" hint={editing ? undefined : "Defaults to you"}>
              <UserPicker value={form.manager_id} onChange={(id) => set("manager_id", id)} />
            </Field>
            <Field label="Scope" className="col-span-2">
              <Textarea {...bind("scope")} rows={4} placeholder="Work to be performed, specifications, exclusions" />
            </Field>
          </div>
        </Section>

        <Section
          title="Budget"
          description={
            editing
              ? "Budget changes after creation are recorded as budget revisions or approved change orders on the project."
              : "The original budget is recorded as the first entry in the append-only budget history."
          }
        >
          <div className="grid grid-cols-2 gap-3">
            {editing ? (
              <Field label="Current budget">
                <Input value={formatCurrency(project?.current_budget)} disabled />
              </Field>
            ) : (
              <Field label="Original budget ($)" required>
                <Input {...bind("original_budget")} inputMode="decimal" required />
              </Field>
            )}
            <Field label="Contingency ($)">
              <Input {...bind("contingency")} inputMode="decimal" />
            </Field>
            <Field label="Useful life (years)" hint="Used to amortize recoverable cost">
              <Input {...bind("useful_life_years")} inputMode="numeric" />
            </Field>
          </div>
        </Section>

        <Section title="Schedule">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <Input type="date" {...bind("start_on")} />
            </Field>
            <Field label="Target completion">
              <Input type="date" {...bind("target_completion_on")} />
            </Field>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-ink-2">Milestones</p>
            {form.milestones.length === 0 && <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-xs text-ink-3">No milestones yet.</p>}
            {form.milestones.map((m, i) => (
              <div key={m.key || i} className="flex items-start gap-2 rounded-md border border-line bg-subtle/50 p-2">
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                  <Input value={m.label} onChange={(e) => setMilestone(i, { label: e.target.value })} placeholder="Milestone" aria-label="Milestone label" className="col-span-2" />
                  <div>
                    <p className="mb-1 text-2xs text-ink-3">Due</p>
                    <Input type="date" value={m.due_on} onChange={(e) => setMilestone(i, { due_on: e.target.value })} aria-label="Milestone due date" />
                  </div>
                  <div>
                    <p className="mb-1 text-2xs text-ink-3">Completed</p>
                    <Input type="date" value={m.completed_on} onChange={(e) => setMilestone(i, { completed_on: e.target.value })} aria-label="Milestone completed date" />
                  </div>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label="Remove milestone" onClick={() => set("milestones", form.milestones.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => set("milestones", [...form.milestones, { key: newKey("milestone"), label: "", due_on: "", completed_on: "" }])}>
              <Plus /> Add milestone
            </Button>
          </div>
        </Section>

        {editing && (
          <Section title="Warranty">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Warranty expires">
                <Input type="date" {...bind("warranty_expires_on")} />
              </Field>
              <Field label="Warranty terms" className="col-span-2">
                <Textarea {...bind("warranty_terms")} />
              </Field>
            </div>
          </Section>
        )}

        <Section title="Notes">
          <Textarea {...bind("notes")} />
        </Section>
      </form>
    </Sheet>
  );
}
