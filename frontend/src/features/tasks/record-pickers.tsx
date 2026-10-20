"use client";

import { EntityPicker, PropertyPicker } from "@/components/data/entity-picker";

interface PersonLite { id: string; full_name?: string | null; first_name?: string | null; last_name?: string | null; title?: string | null; primary_email?: string | null }
interface OrgLite { id: string; name: string; city?: string | null; state?: string | null }
interface OpportunityLite { id: string; title: string; stage?: string | null }

export function personName(p: PersonLite): string {
  return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed contact";
}

type PickerProps = { value: string | null | undefined; onChange: (id: string | null, label: string | null) => void; placeholder?: string };

export function PersonPicker({ value, onChange, placeholder }: PickerProps) {
  return (
    <EntityPicker<PersonLite>
      endpoint="/people"
      value={value}
      onChange={(id, item) => onChange(id, item ? personName(item) : null)}
      placeholder={placeholder ?? "Select person"}
      toOption={(p) => ({ id: p.id, label: personName(p), sublabel: [p.title, p.primary_email].filter(Boolean).join(" · ") || undefined })}
    />
  );
}

export function OrganizationPicker({ value, onChange, placeholder }: PickerProps) {
  return (
    <EntityPicker<OrgLite>
      endpoint="/organizations"
      value={value}
      onChange={(id, item) => onChange(id, item?.name ?? null)}
      placeholder={placeholder ?? "Select organization"}
      toOption={(o) => ({ id: o.id, label: o.name, sublabel: [o.city, o.state].filter(Boolean).join(", ") || undefined })}
    />
  );
}

export function OpportunityPicker({ value, onChange, placeholder }: PickerProps) {
  return (
    <EntityPicker<OpportunityLite>
      endpoint="/opportunities"
      value={value}
      onChange={(id, item) => onChange(id, item?.title ?? null)}
      placeholder={placeholder ?? "Select opportunity"}
      toOption={(o) => ({ id: o.id, label: o.title, sublabel: o.stage ? o.stage.replace(/_/g, " ") : undefined })}
    />
  );
}

/** Picker for a polymorphic related record (property, person, organization, opportunity). */
export function RelatedRecordPicker({ type, value, onChange }: { type: string; value: string | null | undefined; onChange: (id: string | null, label: string | null) => void }) {
  if (type === "property")
    return <PropertyPicker value={value} onChange={(id, item) => onChange(id, item ? item.name || item.address_line : null)} />;
  if (type === "person") return <PersonPicker value={value} onChange={onChange} />;
  if (type === "organization") return <OrganizationPicker value={value} onChange={onChange} />;
  if (type === "opportunity") return <OpportunityPicker value={value} onChange={onChange} />;
  return null;
}
