"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { EntityPicker, PropertyPicker, UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { titleCase, toNumber } from "@/lib/utils";

import { OrganizationPicker, PersonPicker } from "@/features/contacts/pickers";

import {
  ANCHOR_LABELS,
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPES,
  PARTY_ROLES,
  TERM_FIELDS,
  useCalendars,
  useExecuteContract,
  useSaveContract,
  type Contract,
  type ContractInput,
  type Party,
} from "./api";

interface OpportunityLite { id: string; title: string; stage: string }
interface DocumentLite { id: string; title: string | null; filename: string | null; doc_class?: string | null }

function numberOrNull(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function ContractFormSheet({
  open,
  onOpenChange,
  contract,
  propertyId,
  opportunityId,
  offerId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contract?: Contract;
  propertyId?: string;
  opportunityId?: string;
  offerId?: string;
}) {
  const router = useRouter();
  const save = useSaveContract(contract?.id);
  const { data: calendars } = useCalendars();
  const [v, setV] = useState<ContractInput>({});
  const [terms, setTerms] = useState<Record<string, string>>({});
  const [businessDays, setBusinessDays] = useState(false);
  const [closingFrom, setClosingFrom] = useState("feasibility_expiry");
  const [parties, setParties] = useState<Party[]>([]);

  useEffect(() => {
    if (!open) return;
    const c = contract;
    setV(
      c
        ? {
            title: c.title, contract_type: c.contract_type, property_id: c.property_id, opportunity_id: c.opportunity_id,
            document_id: c.document_id, owner_id: c.owner_id, effective_on: c.effective_on, executed_on: c.executed_on,
            purchase_price: c.purchase_price, earnest_money: c.earnest_money, additional_deposit: c.additional_deposit,
            calendar_id: c.calendar_id, attorney_person_id: c.attorney_person_id, attorney_organization_id: c.attorney_organization_id,
            notes: c.notes,
          }
        : { contract_type: "purchase_sale", property_id: propertyId ?? null, opportunity_id: opportunityId ?? null, offer_id: offerId ?? null },
    );
    const kt = (c?.key_terms ?? {}) as Record<string, unknown>;
    setTerms(Object.fromEntries(TERM_FIELDS.map((f) => [f.key, numberOrNull(kt[f.key])])));
    setBusinessDays(kt.business_days === true);
    setClosingFrom(typeof kt.closing_from === "string" ? kt.closing_from : "feasibility_expiry");
    setParties(c?.parties ?? [{ role: "buyer", name: "" }, { role: "seller", name: "" }]);
  }, [open, contract, propertyId, opportunityId, offerId]);

  const set = <K extends keyof ContractInput>(k: K, value: ContractInput[K]) => setV((s) => ({ ...s, [k]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const keyTerms: Record<string, unknown> = { ...((contract?.key_terms ?? {}) as Record<string, unknown>) };
    for (const f of TERM_FIELDS) {
      const n = toNumber(terms[f.key] ?? "");
      if (n === null) delete keyTerms[f.key];
      else keyTerms[f.key] = Math.round(n);
    }
    keyTerms.business_days = businessDays;
    keyTerms.closing_from = closingFrom;
    const body: ContractInput = {
      ...v,
      title: v.title?.trim() || undefined,
      key_terms: keyTerms,
      parties: parties.filter((p) => p.name.trim()).map((p) => ({ ...p, name: p.name.trim() })),
    };
    save.mutate(body, {
      onSuccess: (c) => {
        toast.success(contract ? "Contract updated" : "Contract created");
        onOpenChange(false);
        if (!contract) router.push(`/contracts/${c.id}`);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const executed = contract && contract.status !== "draft";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={contract ? "Edit contract" : "New contract"}
      description={
        executed
          ? "Changing terms or dates recomputes proposed deadlines. Confirmed deadlines are never overwritten; differences are flagged for review."
          : "Record the agreement, its parties and the terms that drive the critical-date engine."
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="contract-form" loading={save.isPending}>
            {contract ? "Save changes" : "Create contract"}
          </Button>
        </>
      }
    >
      <form id="contract-form" onSubmit={submit} className="space-y-6">
        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Agreement</h4>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title" hint="Defaults to the property name" className="col-span-2">
              <Input value={v.title ?? ""} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Type">
              <Select value={v.contract_type ?? "purchase_sale"} onChange={(e) => set("contract_type", e.target.value)} options={CONTRACT_TYPES.map((t) => ({ value: t, label: CONTRACT_TYPE_LABELS[t] }))} />
            </Field>
            <Field label="Coordinator (owner)">
              <UserPicker value={v.owner_id} onChange={(id) => set("owner_id", id)} />
            </Field>
            <Field label="Property" className="col-span-2">
              <PropertyPicker value={v.property_id} onChange={(id) => set("property_id", id)} />
            </Field>
            <Field label="Opportunity" className="col-span-2">
              <EntityPicker<OpportunityLite>
                endpoint="/opportunities"
                value={v.opportunity_id}
                onChange={(id) => set("opportunity_id", id)}
                placeholder="Link an opportunity"
                toOption={(o) => ({ id: o.id, label: o.title, sublabel: titleCase(o.stage) })}
              />
            </Field>
            <Field label="Source document" hint="The executed agreement from Documents" className="col-span-2">
              <EntityPicker<DocumentLite>
                endpoint="/documents"
                value={v.document_id}
                onChange={(id) => set("document_id", id)}
                placeholder="Link the contract document"
                toOption={(d) => ({ id: d.id, label: d.title || d.filename || "Document", sublabel: d.doc_class ? titleCase(d.doc_class) : undefined })}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Dates and money</h4>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Effective date">
              <Input type="date" value={v.effective_on ?? ""} onChange={(e) => set("effective_on", e.target.value || null)} />
            </Field>
            <Field label="Execution date">
              <Input type="date" value={v.executed_on ?? ""} onChange={(e) => set("executed_on", e.target.value || null)} />
            </Field>
            <Field label="Purchase price">
              <Input inputMode="decimal" value={numberOrNull(v.purchase_price)} onChange={(e) => set("purchase_price", toNumber(e.target.value))} />
            </Field>
            <Field label="Earnest money">
              <Input inputMode="decimal" value={numberOrNull(v.earnest_money)} onChange={(e) => set("earnest_money", toNumber(e.target.value))} />
            </Field>
            <Field label="Additional deposit">
              <Input inputMode="decimal" value={numberOrNull(v.additional_deposit)} onChange={(e) => set("additional_deposit", toNumber(e.target.value))} />
            </Field>
            <Field label="Holiday calendar" hint="Used for business-day deadlines">
              <Select
                value={v.calendar_id ?? ""}
                onChange={(e) => set("calendar_id", e.target.value || null)}
                placeholder="Default (US federal)"
                options={(calendars ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Key terms (date engine)</h4>
          <p className="text-xs text-ink-3">Day counts from the agreement. Blank core terms use market defaults and are flagged for verification.</p>
          <div className="grid grid-cols-2 gap-3">
            {TERM_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <Input inputMode="numeric" value={terms[f.key] ?? ""} onChange={(e) => setTerms((s) => ({ ...s, [f.key]: e.target.value }))} />
              </Field>
            ))}
            <Field label="Closing counted from">
              <Select
                value={closingFrom}
                onChange={(e) => setClosingFrom(e.target.value)}
                options={["feasibility_expiry", "effective_on", "executed_on"].map((k) => ({ value: k, label: ANCHOR_LABELS[k] }))}
              />
            </Field>
            <Field label="Day convention">
              <label className="flex h-8 items-center gap-2 text-sm">
                <Checkbox checked={businessDays} onChange={setBusinessDays} label="Business days" /> Count all periods in business days
              </label>
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Parties</h4>
            <Button size="xs" variant="ghost" onClick={() => setParties((p) => [...p, { role: "other", name: "" }])}>
              <Plus /> Add party
            </Button>
          </div>
          {parties.map((p, i) => (
            <div key={i} className="grid grid-cols-[130px_1fr_auto] items-start gap-2">
              <Select
                value={p.role}
                onChange={(e) => setParties((ps) => ps.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                options={PARTY_ROLES.map((r) => ({ value: r, label: titleCase(r) }))}
              />
              <div className="space-y-1.5">
                <Input value={p.name} placeholder="Name as it appears in the agreement" onChange={(e) => setParties((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <OrganizationPicker
                  value={p.organization_id ?? null}
                  onChange={(id) => setParties((ps) => ps.map((x, j) => (j === i ? { ...x, organization_id: id } : x)))}
                  placeholder="Link organization (optional)"
                />
              </div>
              <Button size="icon-sm" variant="ghost" aria-label="Remove party" onClick={() => setParties((ps) => ps.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Counsel and notes</h4>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Attorney">
              <PersonPicker value={v.attorney_person_id} onChange={(id) => set("attorney_person_id", id)} />
            </Field>
            <Field label="Law firm">
              <OrganizationPicker value={v.attorney_organization_id} onChange={(id) => set("attorney_organization_id", id)} />
            </Field>
            <Field label="Notes" className="col-span-2">
              <Textarea value={v.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </div>
        </section>
      </form>
    </Sheet>
  );
}

export function ExecuteDialog({ open, onOpenChange, contract }: { open: boolean; onOpenChange: (o: boolean) => void; contract: Contract }) {
  const execute = useExecuteContract(contract.id);
  const [effective, setEffective] = useState("");
  const [executed, setExecuted] = useState("");

  useEffect(() => {
    if (open) {
      setEffective(contract.effective_on ?? "");
      setExecuted(contract.executed_on ?? "");
    }
  }, [open, contract]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark contract executed"
      description="Execution generates candidate critical dates from the key terms and the DD checklist for this property type. Every generated date stays proposed until someone confirms it against the signed agreement."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!effective}
            loading={execute.isPending}
            onClick={() =>
              execute.mutate(
                { effective_on: effective || null, executed_on: executed || null },
                {
                  onSuccess: () => {
                    toast.success("Contract executed. Review the proposed dates.");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Mark executed
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Effective date" required>
          <Input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
        </Field>
        <Field label="Execution date" hint="Defaults to the effective date">
          <Input type="date" value={executed} onChange={(e) => setExecuted(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
