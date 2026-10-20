"use client";

import { EntityPicker } from "@/components/data/entity-picker";

import { ORG_TYPE_LABELS, type EntityKind } from "./api";

interface PersonLite { id: string; full_name: string; title: string | null; city: string | null; state: string | null }
interface OrgLite { id: string; name: string; org_type: string; city: string | null; state: string | null }

export function PersonPicker(props: { value: string | null | undefined; onChange: (id: string | null) => void; placeholder?: string }) {
  return (
    <EntityPicker<PersonLite>
      endpoint="/people"
      value={props.value}
      onChange={(id) => props.onChange(id)}
      placeholder={props.placeholder ?? "Select person"}
      toOption={(p) => ({ id: p.id, label: p.full_name, sublabel: [p.title, p.city, p.state].filter(Boolean).join(" · ") || undefined })}
    />
  );
}

export function OrganizationPicker(props: { value: string | null | undefined; onChange: (id: string | null) => void; placeholder?: string }) {
  return (
    <EntityPicker<OrgLite>
      endpoint="/organizations"
      value={props.value}
      onChange={(id) => props.onChange(id)}
      placeholder={props.placeholder ?? "Select organization"}
      toOption={(o) => ({ id: o.id, label: o.name, sublabel: [ORG_TYPE_LABELS[o.org_type] ?? o.org_type, o.city, o.state].filter(Boolean).join(" · ") })}
    />
  );
}

/** Person or organization picker with a kind switch. */
export function OwnerPicker({
  kind,
  onKindChange,
  value,
  onChange,
}: {
  kind: EntityKind;
  onKindChange: (k: EntityKind) => void;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="flex gap-2">
      <select
        value={kind}
        onChange={(e) => {
          // Clear first so a parent that writes both to the URL ends with the new kind.
          onChange(null);
          onKindChange(e.target.value as EntityKind);
        }}
        className="h-8 shrink-0 rounded-md border border-line-strong/80 bg-surface px-2 text-sm text-ink shadow-card focus:outline-none"
        aria-label="Record type"
      >
        <option value="organization">Organization</option>
        <option value="person">Person</option>
      </select>
      <div className="min-w-0 flex-1">
        {kind === "person" ? <PersonPicker value={value} onChange={onChange} /> : <OrganizationPicker value={value} onChange={onChange} />}
      </div>
    </div>
  );
}
