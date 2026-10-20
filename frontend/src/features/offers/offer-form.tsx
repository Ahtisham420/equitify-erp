"use client";

import { format, isValid, parseISO } from "date-fns";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { EntityPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { cn, formatCurrency, formatDate, formatPercent, toNumber } from "@/lib/utils";

import {
  STRUCTURE_LABELS,
  STRUCTURES,
  useApprovedModels,
  useCounterOffer,
  useCreateOffer,
  useUpdateOffer,
  type Offer,
  type OfferTerms,
} from "./api";

type FormState = Record<string, string>;
type Flags = { financing_contingency: boolean; assignment_allowed: boolean };

const NUMBER_FIELDS = [
  "price", "earnest_money", "earnest_money_hard_days", "feasibility_days", "closing_days", "extension_count",
  "extension_days", "extension_cost", "financing_days", "title_survey_days", "exclusivity_days",
] as const;
const TEXT_FIELDS = ["structure", "title_survey_terms", "assignment_terms", "access_terms", "buyer_entity", "seller_name", "other_terms", "notes"] as const;

export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = parseISO(iso);
  return isValid(d) ? format(d, "yyyy-MM-dd'T'HH:mm") : "";
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toForm(o?: Partial<Offer> | null, opts: { keepExpiration?: boolean } = {}): FormState {
  const s: FormState = { structure: "all_cash" };
  if (!o) return s;
  for (const k of [...NUMBER_FIELDS, ...TEXT_FIELDS]) {
    const v = (o as unknown as Record<string, unknown>)[k];
    s[k] = v === null || v === undefined ? "" : String(v);
  }
  s.expiration_at = opts.keepExpiration ? toLocalInput(o.expiration_at) : "";
  return s;
}

function toTerms(form: FormState, flags: Flags): OfferTerms {
  const out: Record<string, unknown> = {};
  for (const k of NUMBER_FIELDS) out[k] = toNumber(form[k] ?? "");
  for (const k of TEXT_FIELDS) out[k] = form[k]?.trim() ? form[k].trim() : null;
  out.structure = form.structure || "all_cash";
  out.expiration_at = fromLocalInput(form.expiration_at ?? "");
  out.financing_contingency = flags.financing_contingency;
  out.assignment_allowed = flags.assignment_allowed;
  return out as OfferTerms;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function DeviationHint({ price, modelPrice }: { price: number | null; modelPrice: number | null | undefined }) {
  if (!price || !modelPrice) return null;
  const dev = ((price - modelPrice) / modelPrice) * 100;
  return (
    <p className={cn("text-xs", dev > 0 ? "text-caution" : "text-ink-3")}>
      {dev >= 0 ? "+" : ""}
      {formatPercent(dev, 2)} vs approved model price {formatCurrency(modelPrice)}
    </p>
  );
}

/** Term capture shared by create, edit-draft and counter sheets. */
function TermFields({
  form,
  setForm,
  flags,
  setFlags,
  modelPrice,
}: {
  form: FormState;
  setForm: (f: (prev: FormState) => FormState) => void;
  flags: Flags;
  setFlags: (f: (prev: Flags) => Flags) => void;
  modelPrice?: number | null;
}) {
  const bind = (key: string) => ({
    id: key,
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  return (
    <>
      <Section title="Price & structure">
        <Field label="Price ($)" required className="col-span-2" hint={<DeviationHint price={toNumber(form.price ?? "")} modelPrice={modelPrice} />}>
          <Input {...bind("price")} inputMode="decimal" required />
        </Field>
        <Field label="Structure" className="col-span-2">
          <Select {...bind("structure")} options={STRUCTURES.map((s) => ({ value: s, label: STRUCTURE_LABELS[s] }))} />
        </Field>
        <Field label="Earnest money ($)"><Input {...bind("earnest_money")} inputMode="decimal" /></Field>
        <Field label="Goes hard after (days)"><Input {...bind("earnest_money_hard_days")} inputMode="numeric" /></Field>
      </Section>

      <Section title="Periods">
        <Field label="Feasibility (days)"><Input {...bind("feasibility_days")} inputMode="numeric" /></Field>
        <Field label="Closing (days)"><Input {...bind("closing_days")} inputMode="numeric" /></Field>
        <Field label="Extensions"><Input {...bind("extension_count")} inputMode="numeric" /></Field>
        <Field label="Days per extension"><Input {...bind("extension_days")} inputMode="numeric" /></Field>
        <Field label="Cost per extension ($)"><Input {...bind("extension_cost")} inputMode="decimal" /></Field>
        <Field label="Exclusivity (days)"><Input {...bind("exclusivity_days")} inputMode="numeric" /></Field>
      </Section>

      <Section title="Contingencies & rights">
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={flags.financing_contingency} onChange={(v) => setFlags((f) => ({ ...f, financing_contingency: v }))} />
          Financing contingency
        </label>
        {flags.financing_contingency && (
          <Field label="Financing period (days)"><Input {...bind("financing_days")} inputMode="numeric" /></Field>
        )}
        <Field label="Title / survey review (days)" className={flags.financing_contingency ? undefined : "col-span-2"}>
          <Input {...bind("title_survey_days")} inputMode="numeric" />
        </Field>
        <Field label="Title / survey terms" className="col-span-2"><Textarea rows={2} {...bind("title_survey_terms")} /></Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={flags.assignment_allowed} onChange={(v) => setFlags((f) => ({ ...f, assignment_allowed: v }))} />
          Assignment permitted
        </label>
        <Field label="Assignment terms" className="col-span-2"><Input {...bind("assignment_terms")} /></Field>
        <Field label="Access / inspection rights" className="col-span-2"><Textarea rows={2} {...bind("access_terms")} /></Field>
      </Section>

      <Section title="Parties & expiration">
        <Field label="Buyer entity"><Input {...bind("buyer_entity")} /></Field>
        <Field label="Seller"><Input {...bind("seller_name")} /></Field>
        <Field label="Offer expires" className="col-span-2" hint="Also the default response due time when sent.">
          <Input type="datetime-local" {...bind("expiration_at")} />
        </Field>
        <Field label="Other terms" className="col-span-2"><Textarea rows={2} {...bind("other_terms")} /></Field>
        <Field label="Internal notes" className="col-span-2"><Textarea rows={2} {...bind("notes")} /></Field>
      </Section>
    </>
  );
}

interface OpportunityLite {
  id: string;
  title: string;
  stage: string;
  property_label: string | null;
  property_city: string | null;
}

/** New offer: an approved underwriting model must be picked first (offers cannot exist without one). */
export function OfferCreateSheet({
  open,
  onOpenChange,
  opportunityId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  opportunityId?: string;
  onCreated?: (o: Offer) => void;
}) {
  const [oppId, setOppId] = useState<string | null>(opportunityId ?? null);
  const [modelId, setModelId] = useState("");
  const [form, setForm] = useState<FormState>(toForm());
  const [flags, setFlags] = useState<Flags>({ financing_contingency: false, assignment_allowed: false });
  const models = useApprovedModels(oppId);
  const create = useCreateOffer();
  const model = useMemo(() => models.data?.find((m) => m.id === modelId), [models.data, modelId]);

  useEffect(() => {
    if (open) {
      setOppId(opportunityId ?? null);
      setModelId("");
      setForm(toForm());
      setFlags({ financing_contingency: false, assignment_allowed: false });
    }
  }, [open, opportunityId]);

  useEffect(() => {
    if (model?.purchase_price != null) setForm((f) => (f.price ? f : { ...f, price: String(model.purchase_price) }));
  }, [model]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const terms = toTerms(form, flags);
    if (!oppId || !modelId || !terms.price) return;
    create.mutate(
      { ...terms, opportunity_id: oppId, uw_model_id: modelId, price: terms.price },
      {
        onSuccess: (o) => {
          toast.success("Offer draft created");
          onOpenChange(false);
          onCreated?.(o);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const noModels = !!oppId && models.isSuccess && models.data.length === 0;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New offer"
      description="Terms stay traceable to the approved underwriting model they were prepared from."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="offer-create-form" loading={create.isPending} disabled={!oppId || !modelId}>
            Create draft
          </Button>
        </>
      }
    >
      <form id="offer-create-form" onSubmit={submit} className="space-y-6">
        <section className="space-y-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Basis</h4>
          {!opportunityId && (
            <Field label="Opportunity" required>
              <EntityPicker<OpportunityLite>
                endpoint="/opportunities"
                value={oppId}
                onChange={(id) => {
                  setOppId(id);
                  setModelId("");
                }}
                placeholder="Select opportunity"
                toOption={(o) => ({ id: o.id, label: o.title, sublabel: [o.property_label, o.property_city, o.stage.replace(/_/g, " ")].filter(Boolean).join(" · ") })}
              />
            </Field>
          )}
          <Field label="Approved underwriting model" required hint={models.isLoading && oppId ? "Loading approved models…" : undefined}>
            <Select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              disabled={!oppId || noModels}
              placeholder={oppId ? "Select an approved model" : "Select an opportunity first"}
              options={(models.data ?? []).map((m) => ({
                value: m.id,
                label: `${m.name ?? "Model"}${m.version != null ? ` v${m.version}` : ""} · ${formatCurrency(m.purchase_price)}${m.approved_at ? ` · approved ${formatDate(m.approved_at)}` : ""}`,
              }))}
            />
          </Field>
          {noModels && (
            <div className="rounded-lg border border-caution/30 bg-caution-soft p-3 text-sm">
              <p className="font-medium text-caution">No approved underwriting model</p>
              <p className="mt-0.5 text-ink-2">
                Offers can only be prepared from an approved model.{" "}
                <Link href="/underwriting" className="font-medium text-accent hover:underline">Open underwriting</Link>
              </p>
            </div>
          )}
        </section>

        {modelId && <TermFields form={form} setForm={setForm} flags={flags} setFlags={setFlags} modelPrice={model?.purchase_price} />}
      </form>
    </Sheet>
  );
}

/**
 * Edit a draft, prepare our counter (new version), or record the counterparty's counter verbatim.
 * Sent versions are never edited: counters always create a new version.
 */
export function OfferTermsSheet({
  open,
  onOpenChange,
  offer,
  mode,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  offer: Offer;
  mode: "edit" | "counter" | "record_counter";
  onSaved?: (o: Offer) => void;
}) {
  const [form, setForm] = useState<FormState>(toForm(offer, { keepExpiration: mode === "edit" }));
  const [flags, setFlags] = useState<Flags>({ financing_contingency: offer.financing_contingency, assignment_allowed: offer.assignment_allowed });
  const [respondedAt, setRespondedAt] = useState("");
  const [note, setNote] = useState("");
  const update = useUpdateOffer(offer.id);
  const counter = useCounterOffer(offer.id);

  useEffect(() => {
    if (open) {
      setForm(toForm(offer, { keepExpiration: mode === "edit" }));
      setFlags({ financing_contingency: offer.financing_contingency, assignment_allowed: offer.assignment_allowed });
      setRespondedAt(toLocalInput(new Date().toISOString()));
      setNote("");
    }
  }, [open, offer, mode]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const terms = toTerms(form, flags);
    if (!terms.price) return;
    const done = {
      onSuccess: (o: Offer) => {
        toast.success(mode === "edit" ? "Draft updated" : mode === "counter" ? `Counter draft v${o.version} created` : `Counterparty counter recorded as v${o.version}`);
        onOpenChange(false);
        onSaved?.(o);
      },
      onError: (err: unknown) => toast.error(errorMessage(err)),
    };
    if (mode === "edit") update.mutate(terms, done);
    else counter.mutate({ ...terms, origin: mode === "record_counter" ? "seller" : "buyer", response_note: note || null, responded_at: fromLocalInput(respondedAt) }, done);
  };

  const title = mode === "edit" ? `Edit draft v${offer.version}` : mode === "counter" ? `Our counter to v${offer.version}` : `Record counterparty counter to v${offer.version}`;
  const description =
    mode === "edit"
      ? "Drafts can change until they are submitted for approval."
      : mode === "counter"
        ? "Creates a new draft version. The previous version is retained unchanged."
        : "Enter the counterparty's terms exactly as received. Our sent version is marked countered and retained.";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="offer-terms-form" loading={update.isPending || counter.isPending}>
            {mode === "edit" ? "Save draft" : mode === "counter" ? "Create counter draft" : "Record counter"}
          </Button>
        </>
      }
    >
      <form id="offer-terms-form" onSubmit={submit} className="space-y-6">
        {mode === "record_counter" && (
          <Section title="Response">
            <Field label="Received at"><Input type="datetime-local" value={respondedAt} onChange={(e) => setRespondedAt(e.target.value)} /></Field>
            <Field label="Note" className="col-span-2"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </Section>
        )}
        <TermFields form={form} setForm={setForm} flags={flags} setFlags={setFlags} modelPrice={offer.model_price} />
      </form>
    </Sheet>
  );
}
