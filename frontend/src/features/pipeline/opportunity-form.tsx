"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { stageLabel, useCreateOpportunity, useUpdateOpportunity, type GateErrorDetail, type Opportunity, type OpportunityInput, type Requirement } from "./api";
import { StageFieldInput } from "./stage-fields";

const CREATE_FIELDS = ["owner_id", "priority", "source", "primary_person_id", "primary_organization_id", "next_action", "next_action_at", "price_expectation", "estimated_value", "notes"];

/** Key fields that can be edited outside a stage move. */
const EDIT_GROUPS: { title: string; fields: string[] }[] = [
  { title: "General", fields: ["title", "owner_id", "priority", "source", "next_action", "next_action_at"] },
  { title: "Owner & contact", fields: ["primary_person_id", "primary_organization_id"] },
  { title: "Research & underwriting", fields: ["research_missing_fields", "research_notes", "estimated_value", "cap_rate", "underwriting_notes"] },
  { title: "Negotiation & offer", fields: ["price_expectation", "offer_price", "offer_sent_at", "response_due_at"] },
  { title: "Contract & closing", fields: ["contract_executed_on", "dd_deadline", "closing_date", "closed_price", "closed_on"] },
  { title: "Nurture", fields: ["next_touch_on", "nurture_cadence_days"] },
  { title: "Notes", fields: ["notes"] },
];

export function OpportunityCreateSheet({ open, onOpenChange, propertyId }: { open: boolean; onOpenChange: (o: boolean) => void; propertyId?: string }) {
  const router = useRouter();
  const { can } = useAuth();
  const create = useCreateOpportunity();
  const [property, setProperty] = useState<string | null>(propertyId ?? null);
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({ priority: "normal" });
  const [existing, setExisting] = useState<GateErrorDetail["existing"]>([]);
  const [unmet, setUnmet] = useState<Requirement[]>([]);
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    if (open) {
      setProperty(propertyId ?? null);
      setTitle("");
      setValues({ priority: "normal" });
      setExisting([]);
      setUnmet([]);
      setOverrideReason("");
    }
  }, [open, propertyId]);

  const submit = (e: FormEvent | null, force = false) => {
    e?.preventDefault();
    if (!property) {
      toast.error("Choose a property");
      return;
    }
    create.mutate(
      { data: { ...(values as OpportunityInput), title: title.trim() || undefined, property_id: property, override_reason: overrideReason.trim() || null }, force },
      {
        onSuccess: (o) => {
          toast.success("Opportunity created");
          onOpenChange(false);
          router.push(`/pipeline/${o.id}`);
        },
        onError: (err) => {
          const detail = err instanceof ApiError ? (err.detail as GateErrorDetail | null) : null;
          if (err instanceof ApiError && err.status === 409 && detail?.existing) setExisting(detail.existing);
          else if (err instanceof ApiError && (err.status === 422 || err.status === 403) && detail?.unmet) {
            setUnmet(detail.unmet);
            toast.error(detail.message ?? "Sourcing requirements are not met");
          } else toast.error(errorMessage(err));
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New opportunity"
      description="Opportunities start in Sourced. The property is checked for duplicates and evaluated against active buy boxes."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="opportunity-form" loading={create.isPending}>
            Create opportunity
          </Button>
        </>
      }
    >
      <form id="opportunity-form" onSubmit={(e) => submit(e)} className="space-y-4">
        {existing && existing.length > 0 && (
          <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
            <p className="font-medium text-caution">This property is already in the pipeline</p>
            <ul className="mt-2 space-y-1">
              {existing.map((x) => (
                <li key={x.id}>
                  <Link href={`/pipeline/${x.id}`} className="font-medium text-accent hover:underline">
                    {x.title}
                  </Link>{" "}
                  <span className="text-ink-3">· {stageLabel(x.stage)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-2">Reactivate or continue the existing opportunity so its history is kept.</p>
            {can("pipeline", "approve") && (
              <Button size="sm" className="mt-3" onClick={() => submit(null, true)}>
                Create a separate opportunity anyway
              </Button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Property" required className="col-span-2">
            {propertyId ? <p className="text-sm text-ink-2">Linked to this property</p> : <PropertyPicker value={property} onChange={(id) => setProperty(id)} />}
          </Field>
          <Field label="Title" hint="Defaults to the property name" className="col-span-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {CREATE_FIELDS.map((f) => (
            <StageFieldInput key={f} field={f} value={values[f]} onChange={(v) => setValues((s) => ({ ...s, [f]: v }))} />
          ))}
        </div>

        {unmet.length > 0 && (
          <div className="space-y-2 rounded-md border border-negative/30 bg-negative-soft px-3 py-3">
            <p className="text-sm font-medium text-negative">Sourcing requirements not met</p>
            <ul className="list-disc pl-5 text-xs text-ink-2">
              {unmet.map((r) => (
                <li key={r.key}>
                  {r.label}
                  {r.detail ? ` — ${r.detail}` : ""}
                </li>
              ))}
            </ul>
            {can("pipeline", "approve") ? (
              <Field label="Override reason" required hint="Recorded in the stage history and audit log.">
                <Textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
              </Field>
            ) : (
              <p className="text-xs text-ink-2">Activate a buy box for this property type, or ask an approver to create it with an override.</p>
            )}
          </div>
        )}
      </form>
    </Sheet>
  );
}

export function OpportunityEditSheet({ open, onOpenChange, opportunity }: { open: boolean; onOpenChange: (o: boolean) => void; opportunity: Opportunity }) {
  const update = useUpdateOpportunity(opportunity.id);
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (open) setValues({});
  }, [open]);

  const current = (f: string) => (f in values ? values[f] : (opportunity as unknown as Record<string, unknown>)[f]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!Object.keys(values).length) {
      onOpenChange(false);
      return;
    }
    update.mutate(values as OpportunityInput, {
      onSuccess: () => {
        toast.success("Opportunity updated");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Edit opportunity"
      description="Data required by the current stage cannot be removed. Every change is audited."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="opportunity-edit-form" loading={update.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="opportunity-edit-form" onSubmit={submit} className="space-y-6">
        {EDIT_GROUPS.map((g) => (
          <section key={g.title} className="space-y-3">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{g.title}</h4>
            <div className="grid grid-cols-2 gap-3">
              {g.fields.map((f) => (
                <StageFieldInput key={f} field={f} value={current(f)} onChange={(v) => setValues((s) => ({ ...s, [f]: v }))} />
              ))}
            </div>
          </section>
        ))}
      </form>
    </Sheet>
  );
}
