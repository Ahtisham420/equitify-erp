"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { titleCase } from "@/lib/utils";

import { useBuyboxMeta, useSaveBuyBox, type BuyBox } from "./api";

interface FormState {
  name: string;
  strategy: string;
  description: string;
  owner_id: string | null;
  active_from: string;
  active_to: string;
  is_active: boolean;
}

const toForm = (b?: BuyBox | null): FormState => ({
  name: b?.name ?? "",
  strategy: b?.strategy ?? "",
  description: b?.description ?? "",
  owner_id: b?.owner_id ?? null,
  active_from: b?.active_from ?? "",
  active_to: b?.active_to ?? "",
  is_active: b?.is_active ?? true,
});

export function BuyBoxFormSheet({ open, onOpenChange, buyBox }: { open: boolean; onOpenChange: (o: boolean) => void; buyBox?: BuyBox | null }) {
  const router = useRouter();
  const { data: meta } = useBuyboxMeta();
  const [form, setForm] = useState<FormState>(toForm(buyBox));
  const save = useSaveBuyBox(buyBox?.id);

  useEffect(() => {
    if (open) setForm(toForm(buyBox));
  }, [open, buyBox]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.active_from && form.active_to && form.active_to < form.active_from) {
      toast.error("Active until must be on or after active from");
      return;
    }
    save.mutate(
      {
        name: form.name.trim(),
        strategy: form.strategy.trim() || "other",
        description: form.description.trim() || null,
        owner_id: form.owner_id,
        active_from: form.active_from || null,
        active_to: form.active_to || null,
        is_active: form.is_active,
      },
      {
        onSuccess: (b) => {
          toast.success(buyBox ? "Buy box updated" : "Buy box created");
          onOpenChange(false);
          if (!buyBox) router.push(`/buy-boxes/${b.id}`);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={buyBox ? "Edit buy box" : "New buy box"}
      description={buyBox ? "Header changes do not create a new criteria version." : "Add criteria after creating the buy box."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="buybox-form" loading={save.isPending}>
            {buyBox ? "Save changes" : "Create buy box"}
          </Button>
        </>
      }
    >
      <form id="buybox-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Name" required className="col-span-2">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. Texas STNL under $5M" />
        </Field>
        <Field label="Strategy" required>
          <Input list="buybox-strategies" value={form.strategy} onChange={(e) => set("strategy", e.target.value)} required placeholder="e.g. stnl" />
          <datalist id="buybox-strategies">
            {meta?.strategies.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Owner">
          <UserPicker value={form.owner_id} onChange={(id) => set("owner_id", id)} placeholder="Defaults to you" />
        </Field>
        <Field label="Active from">
          <Input type="date" value={form.active_from} onChange={(e) => set("active_from", e.target.value)} />
        </Field>
        <Field label="Active until">
          <Input type="date" value={form.active_to} onChange={(e) => set("active_to", e.target.value)} />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={form.is_active} onChange={(v) => set("is_active", v)} />
          Active — new and changed properties are evaluated against this buy box
        </label>
        <Field label="Description" className="col-span-2">
          <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}
