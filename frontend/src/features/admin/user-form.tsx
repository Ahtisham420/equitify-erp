"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useRoles, useSaveUser, useTeams, type AdminUser, type UserInput } from "./api";

interface FormState {
  full_name: string;
  email: string;
  job_title: string;
  phone: string;
  role_id: string;
  team_id: string;
  manager_id: string | null;
  password: string;
  is_service: boolean;
}

function toForm(u?: AdminUser | null, serviceDefault = false): FormState {
  return {
    full_name: u?.full_name ?? "",
    email: u?.email ?? "",
    job_title: u?.job_title ?? "",
    phone: u?.phone ?? "",
    role_id: u?.role.id ?? "",
    team_id: u?.team_id ?? "",
    manager_id: u?.manager_id ?? null,
    password: "",
    is_service: u?.is_service ?? serviceDefault,
  };
}

export function UserFormSheet({
  open,
  onOpenChange,
  user,
  serviceDefault,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user?: AdminUser | null;
  serviceDefault?: boolean;
  onSaved?: (u: AdminUser) => void;
}) {
  const [form, setForm] = useState<FormState>(toForm(user, serviceDefault));
  const { data: roles = [] } = useRoles();
  const { data: teams = [] } = useTeams();
  const save = useSaveUser(user?.id);
  const editing = !!user;

  useEffect(() => {
    if (open) setForm(toForm(user, serviceDefault));
  }, [open, user, serviceDefault]);

  useEffect(() => {
    if (!editing && form.is_service && !form.role_id) {
      const svc = roles.find((r) => r.key === "service");
      if (svc) setForm((f) => ({ ...f, role_id: svc.id }));
    }
  }, [editing, form.is_service, form.role_id, roles]);

  const bind = (key: keyof Omit<FormState, "manager_id" | "is_service">) => ({
    id: key,
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: UserInput = {
      full_name: form.full_name.trim(),
      job_title: form.job_title.trim() || null,
      phone: form.phone.trim() || null,
      role_id: form.role_id,
      team_id: form.team_id || null,
      manager_id: form.manager_id,
    };
    if (!editing) {
      data.email = form.email.trim();
      data.is_service = form.is_service;
    }
    if (form.password) data.password = form.password;
    save.mutate(data, {
      onSuccess: (u) => {
        toast.success(editing ? "User updated" : form.is_service ? "Service user created" : "User created");
        onOpenChange(false);
        onSaved?.(u);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const passwordRequired = !editing && !form.is_service;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit user" : "New user"}
      description={editing ? user?.email : "Access is granted through the role. Human users enroll in MFA on first sign-in."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" loading={save.isPending}>
            {editing ? "Save changes" : "Create user"}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="space-y-6">
        {!editing && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">Account type</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: false, title: "Person", body: "Signs in with password and MFA" },
                { value: true, title: "Service integration", body: "API credentials only, no sign-in" },
              ].map((o) => (
                <button
                  key={String(o.value)}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, is_service: o.value, password: "" }))}
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-left transition-colors",
                    form.is_service === o.value ? "border-ink bg-subtle" : "border-line hover:bg-subtle",
                  )}
                >
                  <p className="text-sm font-medium text-ink">{o.title}</p>
                  <p className="text-xs text-ink-3">{o.body}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <section className="grid grid-cols-2 gap-3">
          <Field label={form.is_service ? "Integration name" : "Full name"} required className="col-span-2">
            <Input {...bind("full_name")} required />
          </Field>
          {!editing && (
            <Field label="Email" required className="col-span-2" hint={form.is_service ? "Used only as an identifier for the integration." : undefined}>
              <Input type="email" {...bind("email")} required />
            </Field>
          )}
          {!form.is_service && (
            <>
              <Field label="Job title"><Input {...bind("job_title")} /></Field>
              <Field label="Phone"><Input {...bind("phone")} /></Field>
            </>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3">
          <h4 className="col-span-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">Access</h4>
          <Field label="Role" required>
            <Select {...bind("role_id")} required placeholder="Select role" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
          </Field>
          <Field label="Team">
            <Select {...bind("team_id")} placeholder="No team" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          {!form.is_service && (
            <Field label="Manager" className="col-span-2">
              <UserPicker value={form.manager_id} onChange={(id) => setForm((f) => ({ ...f, manager_id: id }))} placeholder="No manager" />
            </Field>
          )}
        </section>

        {!form.is_service && (
          <section className="grid grid-cols-2 gap-3">
            <h4 className="col-span-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">{editing ? "Reset password" : "Password"}</h4>
            <Field
              label={editing ? "New password" : "Initial password"}
              required={passwordRequired}
              className="col-span-2"
              hint={editing ? "Leave blank to keep the current password. Setting one signs the user out everywhere." : "At least 8 characters. Share it securely."}
            >
              <Input type="password" autoComplete="new-password" minLength={8} {...bind("password")} required={passwordRequired} />
            </Field>
          </section>
        )}
      </form>
    </Sheet>
  );
}
