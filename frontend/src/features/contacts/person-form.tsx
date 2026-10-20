"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/utils";

import { RESPONSIVENESS, STRENGTHS, useSavePerson, type Person } from "./api";

type Dupe = { id: string; label: string; sublabel: string | null };

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

const CHANNELS = [
  { value: "", label: "No preference" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "text", label: "Text message" },
  { value: "mail", label: "Mail" },
  { value: "in_person", label: "In person" },
];

function toLocalInput(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toForm(p?: Person | null): Record<string, string> {
  return {
    first_name: p?.first_name ?? "",
    last_name: p?.last_name ?? "",
    title: p?.title ?? "",
    emails: "",
    phones: "",
    mailing_address: p?.mailing_address ?? "",
    city: p?.city ?? "",
    state: p?.state ?? "",
    postal_code: p?.postal_code ?? "",
    owner_id: p?.owner_id ?? "",
    relationship_strength: p?.relationship_strength ?? "none",
    responsiveness: p?.responsiveness ?? "unknown",
    next_action: p?.next_action ?? "",
    next_action_at: toLocalInput(p?.next_action_at),
    preferred_channel: String(p?.contact_preferences?.preferred_channel ?? ""),
    best_time: String(p?.contact_preferences?.best_time ?? ""),
    preferences: String(p?.preferences?.summary ?? ""),
    source: p?.source ?? "",
    tags: p?.tags.join(", ") ?? "",
    notes: p?.notes ?? "",
  };
}

export function PersonFormSheet({
  open,
  onOpenChange,
  person,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  person?: Person | null;
  onSaved?: (p: Person) => void;
}) {
  const { can } = useAuth();
  const [form, setForm] = useState(toForm(person));
  const [dupes, setDupes] = useState<Dupe[]>([]);
  const save = useSavePerson(person?.id);
  const canSensitive = can("contacts", "view_sensitive");
  const showAddress = !person || canSensitive;

  useEffect(() => {
    if (open) {
      setForm(toForm(person));
      setDupes([]);
    }
  }, [open, person]);

  const bind = (key: string) => ({
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const nul = (v: string) => (v.trim() === "" ? null : v.trim());
  const list = (v: string) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  const submit = (e: FormEvent, force = false) => {
    e.preventDefault();
    const data: Record<string, unknown> = {
      first_name: nul(form.first_name),
      last_name: nul(form.last_name),
      title: nul(form.title),
      city: nul(form.city),
      state: nul(form.state),
      owner_id: form.owner_id || null,
      relationship_strength: form.relationship_strength,
      responsiveness: form.responsiveness,
      next_action: nul(form.next_action),
      next_action_at: form.next_action_at ? new Date(form.next_action_at).toISOString() : null,
      contact_preferences: { ...(person?.contact_preferences ?? {}), preferred_channel: form.preferred_channel || null, best_time: nul(form.best_time) },
      preferences: { ...(person?.preferences ?? {}), summary: nul(form.preferences) },
      source: nul(form.source),
      tags: list(form.tags),
      notes: nul(form.notes),
    };
    if (showAddress) {
      data.mailing_address = nul(form.mailing_address);
      data.postal_code = nul(form.postal_code);
    }
    if (!person) {
      data.emails = list(form.emails);
      data.phones = list(form.phones);
    } else if (!form.first_name.trim() && !form.last_name.trim()) {
      data.full_name = person.full_name;
    }
    save.mutate(
      { data, force },
      {
        onSuccess: (p) => {
          toast.success(person ? "Person updated" : "Person created");
          onOpenChange(false);
          onSaved?.(p);
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
      title={person ? "Edit person" : "New person"}
      description={person ? person.full_name : "Names, emails and phones are checked for likely duplicates on save."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="person-form" loading={save.isPending}>
            {person ? "Save changes" : "Create person"}
          </Button>
        </>
      }
    >
      <form id="person-form" onSubmit={(e) => submit(e)} className="space-y-6">
        {dupes.length > 0 && (
          <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
            <p className="font-medium text-caution">Possible duplicate</p>
            <p className="mt-0.5 text-ink-2">These people look similar. Open one instead, or create anyway and the pair will be queued for duplicate review.</p>
            <ul className="mt-2 space-y-1">
              {dupes.map((d) => (
                <li key={d.id}>
                  <Link href={`/people/${d.id}`} className="font-medium text-accent hover:underline">{d.label}</Link>
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
          <Field label="First name"><Input {...bind("first_name")} autoFocus /></Field>
          <Field label="Last name"><Input {...bind("last_name")} /></Field>
          <Field label="Title" className="col-span-2"><Input {...bind("title")} placeholder="e.g. Managing member" /></Field>
        </Section>

        {!person && (
          <Section title="Contact">
            <Field label="Emails" hint="Comma separated; first is primary" className="col-span-2"><Input {...bind("emails")} /></Field>
            <Field label="Phones" hint="Comma separated; first is primary" className="col-span-2"><Input {...bind("phones")} /></Field>
          </Section>
        )}

        <Section title="Mailing">
          {showAddress ? (
            <Field label="Mailing address" className="col-span-2"><Input {...bind("mailing_address")} /></Field>
          ) : (
            <p className="col-span-2 text-xs text-ink-3">Mailing address is restricted for your role.</p>
          )}
          <Field label="City"><Input {...bind("city")} /></Field>
          <Field label="State"><Input {...bind("state")} maxLength={40} /></Field>
          {showAddress && <Field label="Postal code"><Input {...bind("postal_code")} /></Field>}
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
          <Field label="Next action" className="col-span-2"><Input {...bind("next_action")} placeholder="e.g. Call about Q3 refinance" /></Field>
          <Field label="Next action date"><Input type="datetime-local" {...bind("next_action_at")} /></Field>
          <Field label="Preferred channel"><Select {...bind("preferred_channel")} options={CHANNELS} /></Field>
          <Field label="Best time to reach" className="col-span-2"><Input {...bind("best_time")} placeholder="e.g. Weekday mornings" /></Field>
          <Field label="Preferences" hint="Asset types, deal size, markets, financing" className="col-span-2"><Textarea {...bind("preferences")} /></Field>
        </Section>

        <Section title="Record">
          <Field label="Source"><Input {...bind("source")} placeholder="e.g. County deed, referral" /></Field>
          <Field label="Tags" hint="Comma separated"><Input {...bind("tags")} /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>
      </form>
    </Sheet>
  );
}
