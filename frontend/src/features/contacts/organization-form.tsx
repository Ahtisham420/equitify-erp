"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/utils";

import { ORG_TYPE_LABELS, ORG_TYPES, RESPONSIVENESS, STRENGTHS, useSaveOrganization, type Organization } from "./api";
import { Section } from "./person-form";

type Dupe = { id: string; label: string; sublabel: string | null };

function toForm(o?: Organization | null): Record<string, string> {
  return {
    name: o?.name ?? "",
    legal_name: o?.legal_name ?? "",
    org_type: o?.org_type ?? "other",
    website: o?.website ?? "",
    domain: o?.domain ?? "",
    phone: o?.phone ?? "",
    mailing_address: o?.mailing_address ?? "",
    city: o?.city ?? "",
    state: o?.state ?? "",
    postal_code: o?.postal_code ?? "",
    state_of_formation: o?.state_of_formation ?? "",
    registered_agent: o?.registered_agent ?? "",
    owner_id: o?.owner_id ?? "",
    relationship_strength: o?.relationship_strength ?? "none",
    responsiveness: o?.responsiveness ?? "unknown",
    next_action: o?.next_action ?? "",
    preferences: String(o?.preferences?.summary ?? ""),
    source: o?.source ?? "",
    tags: o?.tags.join(", ") ?? "",
    notes: o?.notes ?? "",
  };
}

export function OrganizationFormSheet({
  open,
  onOpenChange,
  organization,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  organization?: Organization | null;
  onSaved?: (o: Organization) => void;
}) {
  const { can } = useAuth();
  const [form, setForm] = useState(toForm(organization));
  const [dupes, setDupes] = useState<Dupe[]>([]);
  const save = useSaveOrganization(organization?.id);
  const showSensitive = !organization || can("contacts", "view_sensitive");

  useEffect(() => {
    if (open) {
      setForm(toForm(organization));
      setDupes([]);
    }
  }, [open, organization]);

  const bind = (key: string) => ({
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const nul = (v: string) => (v.trim() === "" ? null : v.trim());

  const submit = (e: FormEvent, force = false) => {
    e.preventDefault();
    const data: Record<string, unknown> = {
      name: form.name.trim(),
      legal_name: nul(form.legal_name),
      org_type: form.org_type,
      website: nul(form.website),
      domain: nul(form.domain),
      city: nul(form.city),
      state: nul(form.state),
      state_of_formation: nul(form.state_of_formation),
      registered_agent: nul(form.registered_agent),
      owner_id: form.owner_id || null,
      relationship_strength: form.relationship_strength,
      responsiveness: form.responsiveness,
      next_action: nul(form.next_action),
      preferences: { ...(organization?.preferences ?? {}), summary: nul(form.preferences) },
      source: nul(form.source),
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      notes: nul(form.notes),
    };
    if (showSensitive) {
      data.phone = nul(form.phone);
      data.mailing_address = nul(form.mailing_address);
      data.postal_code = nul(form.postal_code);
    }
    save.mutate(
      { data, force },
      {
        onSuccess: (o) => {
          toast.success(organization ? "Organization updated" : "Organization created");
          onOpenChange(false);
          onSaved?.(o);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409 && err.detail && typeof err.detail === "object") {
            setDupes((err.detail as { duplicates?: Dupe[] }).duplicates ?? []);
          } else toast.error(errorMessage(err));
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={organization ? "Edit organization" : "New organization"}
      description={organization ? organization.name : "Name and domain are checked for likely duplicates on save."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="org-form" loading={save.isPending}>
            {organization ? "Save changes" : "Create organization"}
          </Button>
        </>
      }
    >
      <form id="org-form" onSubmit={(e) => submit(e)} className="space-y-6">
        {dupes.length > 0 && (
          <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
            <p className="font-medium text-caution">Possible duplicate</p>
            <p className="mt-0.5 text-ink-2">Open the existing record, or create anyway and the pair will be queued for duplicate review.</p>
            <ul className="mt-2 space-y-1">
              {dupes.map((d) => (
                <li key={d.id}>
                  <Link href={`/organizations/${d.id}`} className="font-medium text-accent hover:underline">{d.label}</Link>
                  {d.sublabel && <span className="text-ink-3"> · {d.sublabel}</span>}
                </li>
              ))}
            </ul>
            <Button size="sm" className="mt-3" onClick={(e) => submit(e as unknown as FormEvent, true)}>
              Create anyway
            </Button>
          </div>
        )}

        <Section title="Identity">
          <Field label="Operating name" required className="col-span-2"><Input {...bind("name")} required autoFocus /></Field>
          <Field label="Legal name" className="col-span-2"><Input {...bind("legal_name")} placeholder="e.g. Main Street Holdings, LLC" /></Field>
          <Field label="Type">
            <Select {...bind("org_type")} options={ORG_TYPES.map((t) => ({ value: t, label: ORG_TYPE_LABELS[t] }))} />
          </Field>
          <Field label="State of formation"><Input {...bind("state_of_formation")} /></Field>
          <Field label="Registered agent" className="col-span-2"><Input {...bind("registered_agent")} /></Field>
        </Section>

        <Section title="Contact & address">
          <Field label="Website"><Input {...bind("website")} placeholder="https://" /></Field>
          <Field label="Domain" hint="Derived from website if blank"><Input {...bind("domain")} /></Field>
          {showSensitive && <Field label="Main phone"><Input {...bind("phone")} /></Field>}
          {showSensitive ? (
            <Field label="Mailing address" className="col-span-2"><Input {...bind("mailing_address")} /></Field>
          ) : (
            <p className="col-span-2 text-xs text-ink-3">Phone and mailing address are restricted for your role.</p>
          )}
          <Field label="City"><Input {...bind("city")} /></Field>
          <Field label="State"><Input {...bind("state")} maxLength={40} /></Field>
          {showSensitive && <Field label="Postal code"><Input {...bind("postal_code")} /></Field>}
        </Section>

        <Section title="Relationship">
          <Field label="Relationship owner" className="col-span-2">
            <UserPicker value={form.owner_id || null} onChange={(id) => setForm((f) => ({ ...f, owner_id: id ?? "" }))} />
          </Field>
          <Field label="Relationship strength">
            <Select {...bind("relationship_strength")} options={STRENGTHS.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Responsiveness">
            <Select {...bind("responsiveness")} options={RESPONSIVENESS.map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Next action" className="col-span-2"><Input {...bind("next_action")} /></Field>
          <Field label="Preferences" hint="Investment criteria, markets, financing" className="col-span-2"><Textarea {...bind("preferences")} /></Field>
        </Section>

        <Section title="Record">
          <Field label="Source"><Input {...bind("source")} /></Field>
          <Field label="Tags" hint="Comma separated"><Input {...bind("tags")} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}
