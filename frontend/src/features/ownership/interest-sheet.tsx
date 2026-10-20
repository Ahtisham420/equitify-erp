"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { titleCase, toNumber } from "@/lib/utils";

import { OwnerPicker } from "@/features/contacts/pickers";

import { FINANCING_TYPES, INTEREST_ROLES, useInterestMutations, type Evidence, type Interest, type OwnerKind } from "./api";
import { cleanEvidence, EvidenceEditor } from "./evidence";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

/** Add or edit an ownership interest. Ending an interest is a separate, explicit action. */
export function InterestSheet({
  open,
  onOpenChange,
  propertyId,
  owner,
  interest,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  propertyId?: string;
  owner?: { kind: OwnerKind; id: string };
  interest?: Interest | null;
}) {
  const m = useInterestMutations();
  const [prop, setProp] = useState<string | null>(propertyId ?? null);
  const [ownerKind, setOwnerKind] = useState<OwnerKind>(owner?.kind ?? "organization");
  const [ownerId, setOwnerId] = useState<string | null>(owner?.id ?? null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProp(interest?.property_id ?? propertyId ?? null);
    setOwnerKind(interest?.owner_kind ?? owner?.kind ?? "organization");
    setOwnerId(interest?.owner_id ?? owner?.id ?? null);
    setEvidence(interest?.evidence ?? []);
    setVerified(false);
    setForm({
      role: interest?.role ?? "fee_owner",
      interest_pct: interest?.interest_pct != null ? String(interest.interest_pct) : "100",
      effective_from: interest?.effective_from ?? "",
      acquired_price: interest?.acquired_price != null ? String(interest.acquired_price) : "",
      financing_type: interest?.financing_type ?? "",
      deed_reference: interest?.deed_reference ?? "",
      source: interest?.source ?? "Manual entry",
      observed_on: interest?.observed_on ?? "",
      confidence: interest ? String(Math.round(interest.confidence * 100)) : "80",
      notes: interest?.notes ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interest, propertyId, owner?.kind, owner?.id]);

  const bind = (k: string) => ({ value: form[k] ?? "", onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })) });

  const submit = () => {
    const body: Record<string, unknown> = {
      interest_pct: toNumber(form.interest_pct ?? ""),
      role: form.role,
      effective_from: form.effective_from || null,
      acquired_price: toNumber(form.acquired_price ?? ""),
      financing_type: form.financing_type || null,
      deed_reference: form.deed_reference?.trim() || null,
      evidence: cleanEvidence(evidence),
      source: form.source?.trim() || "Manual entry",
      observed_on: form.observed_on || null,
      confidence: Math.min(100, Math.max(0, Number(form.confidence) || 0)) / 100,
      notes: form.notes?.trim() || null,
    };
    const opts = {
      onSuccess: () => {
        toast.success(interest ? "Interest updated" : "Ownership interest added");
        onOpenChange(false);
      },
      onError: (e: unknown) => toast.error(errorMessage(e)),
    };
    if (interest) m.update.mutate({ id: interest.id, body }, opts);
    else m.create.mutate({ ...body, property_id: prop, owner_kind: ownerKind, owner_id: ownerId, verified }, opts);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={interest ? "Edit ownership interest" : "Add ownership interest"}
      description={interest ? `${interest.owner_label ?? "Owner"} · ${interest.property_label ?? ""}` : "Each change keeps its source, date and confidence in the interest's history."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!interest && (!prop || !ownerId)} loading={m.create.isPending || m.update.isPending} onClick={submit}>
            {interest ? "Save changes" : "Add interest"}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {!interest && (
          <Section title="Owner & property">
            {!propertyId && (
              <Field label="Property" required className="col-span-2">
                <PropertyPicker value={prop} onChange={(id) => setProp(id)} />
              </Field>
            )}
            <Field label="Owner" required className="col-span-2">
              <OwnerPicker kind={ownerKind} onKindChange={setOwnerKind} value={ownerId} onChange={setOwnerId} />
            </Field>
          </Section>
        )}
        <Section title="Interest">
          <Field label="Role"><Select {...bind("role")} options={INTEREST_ROLES.map((r) => ({ value: r, label: titleCase(r) }))} /></Field>
          <Field label="Interest (%)"><Input inputMode="decimal" {...bind("interest_pct")} /></Field>
          <Field label="Effective from"><Input type="date" {...bind("effective_from")} /></Field>
          <Field label="Acquisition price ($)"><Input inputMode="decimal" {...bind("acquired_price")} /></Field>
          <Field label="Financing">
            <Select {...bind("financing_type")} placeholder="Unknown" options={FINANCING_TYPES.filter((f) => f !== "unknown").map((f) => ({ value: f, label: titleCase(f) }))} />
          </Field>
          <Field label="Deed reference"><Input {...bind("deed_reference")} placeholder="Book / page or instrument #" /></Field>
          <Field label="Notes" className="col-span-2"><Textarea {...bind("notes")} /></Field>
        </Section>
        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Evidence</h4>
          <EvidenceEditor value={evidence} onChange={setEvidence} />
        </section>
        <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Source" className="col-span-3"><Input {...bind("source")} /></Field>
            <Field label="Observed on" className="col-span-2"><Input type="date" {...bind("observed_on")} /></Field>
            <Field label="Confidence %"><Input inputMode="numeric" {...bind("confidence")} /></Field>
          </div>
          {!interest && (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={verified} onChange={setVerified} />
              I verified this against the source document
            </label>
          )}
        </section>
      </div>
    </Sheet>
  );
}

/** Ending an interest sets its end date; the record is kept as ownership history. */
export function EndInterestDialog({ interest, onOpenChange }: { interest: Interest | null; onOpenChange: (o: boolean) => void }) {
  const m = useInterestMutations();
  const [form, setForm] = useState({ effective_to: "", disposed_price: "", reason: "", source: "Manual entry" });

  useEffect(() => {
    if (interest) setForm({ effective_to: new Date().toISOString().slice(0, 10), disposed_price: "", reason: "", source: "Manual entry" });
  }, [interest]);

  const submit = () =>
    interest &&
    m.end.mutate(
      {
        id: interest.id,
        body: { effective_to: form.effective_to, disposed_price: toNumber(form.disposed_price), reason: form.reason.trim() || null, source: form.source.trim() || "Manual entry" },
      },
      {
        onSuccess: () => {
          toast.success("Interest ended and kept in history");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={!!interest}
      onOpenChange={onOpenChange}
      title="End ownership interest"
      description={`${interest?.owner_label ?? "Owner"} — the interest stays in the ownership history with this end date.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!form.effective_to} loading={m.end.isPending} onClick={submit}>
            End interest
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="End date" required><Input type="date" value={form.effective_to} onChange={(e) => setForm((f) => ({ ...f, effective_to: e.target.value }))} /></Field>
        <Field label="Disposition price ($)"><Input inputMode="decimal" value={form.disposed_price} onChange={(e) => setForm((f) => ({ ...f, disposed_price: e.target.value }))} /></Field>
        <Field label="Reason" className="col-span-2"><Input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. Sold to new owner, deed recorded" /></Field>
        <Field label="Source" className="col-span-2"><Input value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} /></Field>
      </div>
    </Dialog>
  );
}
