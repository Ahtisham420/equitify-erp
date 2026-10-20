"use client";

import { Copy, Lock, Mail, MoreHorizontal, Phone, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Checkbox, Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/utils";

import { PHONE_TYPES, useContactPointMutations, type ComplianceState, type ContactPoint, type EntityKind } from "./api";

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied");
  } catch {
    toast.error("Could not copy to clipboard");
  }
}

export function ContactPointsCard({
  kind,
  ownerId,
  points,
  compliance = [],
  masked,
}: {
  kind: EntityKind;
  ownerId: string;
  points: ContactPoint[];
  compliance?: ComplianceState[];
  masked: boolean;
}) {
  const { can } = useAuth();
  const m = useContactPointMutations(kind, ownerId);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: "phone", value: "", label: "", phone_type: "mobile", is_primary: false, source: "" });
  const canEdit = can("contacts", "edit");
  const canSensitive = can("contacts", "view_sensitive");

  const run = (p: Promise<unknown>, msg: string) => p.then(() => toast.success(msg)).catch((e) => toast.error(errorMessage(e)));

  const submit = () =>
    m.add.mutate(
      {
        kind: form.kind,
        value: form.value.trim(),
        label: form.label.trim() || null,
        phone_type: form.kind === "phone" ? form.phone_type : null,
        is_primary: form.is_primary,
        source: form.source.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success("Contact point added");
          setAdding(false);
          setForm((f) => ({ ...f, value: "", label: "", is_primary: false }));
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const status = (cp: ContactPoint) => compliance.find((c) => c.channel === cp.kind && c.value === cp.value);

  return (
    <Card>
      <CardHeader
        title="Phones & emails"
        description={masked ? "Values are masked for your role" : undefined}
        actions={
          canEdit && (
            <Button size="xs" onClick={() => setAdding(true)}>
              <Plus className="!size-3.5" /> Add
            </Button>
          )
        }
      />
      <CardBody className="p-0">
        {points.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">No phones or emails on file.</p>
        ) : (
          <ul className="divide-y divide-line">
            {points.map((cp) => {
              const comp = status(cp);
              const Icon = cp.kind === "email" ? Mail : Phone;
              return (
                <li key={cp.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon className="size-4 shrink-0 text-ink-3" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-sm text-ink">{cp.value}</span>
                      {cp.masked && <Lock className="size-3 text-ink-3" />}
                      {cp.is_primary && <Badge tone="blue">Primary</Badge>}
                      {cp.phone_type && cp.phone_type !== "unknown" && <Badge tone="outline">{titleCase(cp.phone_type)}</Badge>}
                    </div>
                    <p className="truncate text-xs text-ink-3">{[cp.label, cp.source].filter(Boolean).join(" · ") || "—"}</p>
                  </div>
                  {comp && (
                    <Tooltip content={comp.reasons.length ? comp.reasons.join("; ") : comp.allowed ? "No restriction on file" : "Blocked"}>
                      <span>
                        <Badge tone={comp.allowed ? "green" : "red"} dot>{comp.allowed ? "Contactable" : "Do not contact"}</Badge>
                      </span>
                    </Tooltip>
                  )}
                  <Tooltip content={cp.masked ? "Masked values cannot be copied" : "Copy"}>
                    <span>
                      <Button size="icon-sm" variant="ghost" disabled={cp.masked} onClick={() => copy(cp.value)} aria-label="Copy">
                        <Copy />
                      </Button>
                    </span>
                  </Tooltip>
                  {canEdit && (
                    <Menu>
                      <MenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="Contact point actions">
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        {!cp.is_primary && canSensitive && (
                          <MenuItem icon={<Star />} onSelect={() => run(m.update.mutateAsync({ id: cp.id, body: { is_primary: true } }), "Primary updated")}>
                            Make primary
                          </MenuItem>
                        )}
                        {cp.kind === "phone" && canSensitive &&
                          PHONE_TYPES.filter((t) => t !== cp.phone_type).map((t) => (
                            <MenuItem key={t} onSelect={() => run(m.update.mutateAsync({ id: cp.id, body: { phone_type: t } }), "Phone type updated")}>
                              Mark as {t}
                            </MenuItem>
                          ))}
                        <MenuItem icon={<Trash2 />} destructive onSelect={() => run(m.remove.mutateAsync(cp.id), "Contact point removed")}>
                          Remove
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add phone or email"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.value.trim()} loading={m.add.isPending} onClick={submit}>
              Add
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))} options={[{ value: "phone", label: "Phone" }, { value: "email", label: "Email" }]} />
          </Field>
          {form.kind === "phone" ? (
            <Field label="Phone type">
              <Select value={form.phone_type} onChange={(e) => setForm((f) => ({ ...f, phone_type: e.target.value }))} options={PHONE_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} />
            </Field>
          ) : (
            <div />
          )}
          <Field label={form.kind === "phone" ? "Phone number" : "Email address"} className="col-span-2">
            <Input autoFocus value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
          </Field>
          <Field label="Label"><Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Office, Personal" /></Field>
          <Field label="Source"><Input value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} placeholder="e.g. Skip trace" /></Field>
          <label className="col-span-2 flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={form.is_primary} onChange={(v) => setForm((f) => ({ ...f, is_primary: v }))} />
            Make this the primary {form.kind}
          </label>
        </div>
      </Dialog>
    </Card>
  );
}
