"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Avatar } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/utils";

import { ROLE_LABELS, ROLES, useAffiliationMutations, type Affiliation, type EntityKind } from "./api";
import { OrganizationPicker, PersonPicker } from "./pickers";

/** Person ↔ organization roles. `mode` is the record being viewed. */
export function AffiliationsCard({ mode, ownerId, items }: { mode: EntityKind; ownerId: string; items: Affiliation[] }) {
  const { can } = useAuth();
  const m = useAffiliationMutations();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ other: "", role: "principal", title: "", started_on: "" });

  const submit = () =>
    m.create.mutate(
      {
        person_id: mode === "person" ? ownerId : form.other,
        organization_id: mode === "person" ? form.other : ownerId,
        role: form.role,
        title: form.title.trim() || null,
        started_on: form.started_on || null,
      },
      {
        onSuccess: () => {
          toast.success("Affiliation added");
          setOpen(false);
          setForm({ other: "", role: "principal", title: "", started_on: "" });
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const end = (a: Affiliation) =>
    m.update.mutate(
      { id: a.id, body: { is_current: false } },
      { onSuccess: () => toast.success("Marked as former"), onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <Card>
      <CardHeader
        title={mode === "person" ? "Organizations & roles" : "People"}
        actions={
          can("contacts", "edit") && (
            <Button size="xs" onClick={() => setOpen(true)}>
              <Plus className="!size-3.5" /> Add
            </Button>
          )
        }
      />
      <CardBody className="p-0">
        {items.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">{mode === "person" ? "Not linked to any organization." : "No people linked yet."}</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((a) => {
              const name = mode === "person" ? a.organization_name : a.person_name;
              const href = mode === "person" ? `/organizations/${a.organization_id}` : `/people/${a.person_id}`;
              return (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Avatar name={name} size={26} />
                  <div className="min-w-0 flex-1">
                    <Link href={href} className="block truncate text-sm font-medium text-ink hover:underline">{name ?? "—"}</Link>
                    <p className="truncate text-xs text-ink-3">
                      {[a.title, a.started_on ? `since ${formatDate(a.started_on)}` : null, a.ended_on ? `ended ${formatDate(a.ended_on)}` : null]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </p>
                  </div>
                  <Badge tone={a.is_current ? "blue" : "outline"}>{ROLE_LABELS[a.role] ?? a.role}</Badge>
                  {!a.is_current && <Badge tone="neutral">Former</Badge>}
                  {can("contacts", "edit") && a.is_current && (
                    <Menu>
                      <MenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="Affiliation actions">
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem onSelect={() => end(a)}>Mark as former</MenuItem>
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
        open={open}
        onOpenChange={setOpen}
        title={mode === "person" ? "Link to organization" : "Add person to organization"}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.other} loading={m.create.isPending} onClick={submit}>
              Add
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={mode === "person" ? "Organization" : "Person"} className="col-span-2">
            {mode === "person" ? (
              <OrganizationPicker value={form.other || null} onChange={(id) => setForm((f) => ({ ...f, other: id ?? "" }))} />
            ) : (
              <PersonPicker value={form.other || null} onChange={(id) => setForm((f) => ({ ...f, other: id ?? "" }))} />
            )}
          </Field>
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
          </Field>
          <Field label="Since"><Input type="date" value={form.started_on} onChange={(e) => setForm((f) => ({ ...f, started_on: e.target.value }))} /></Field>
          <Field label="Title" className="col-span-2"><Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Managing member" /></Field>
        </div>
      </Dialog>
    </Card>
  );
}
