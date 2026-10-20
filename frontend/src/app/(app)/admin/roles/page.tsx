"use client";

import { Plus, ShieldHalf } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";

import { EmptyState, PageHeader } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { useAuth } from "@/lib/auth";
import { cn, pluralize } from "@/lib/utils";

import { useRoles } from "@/features/admin/api";
import { CreateRoleDialog, RoleEditor } from "@/features/admin/role-editor";

function RolesView() {
  const { can } = useAuth();
  const url = useUrlState();
  const { data: roles = [], isLoading } = useRoles();
  const [creating, setCreating] = useState(false);
  const selectedId = url.get("role") ?? roles[0]?.id;
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0];

  return (
    <>
      <PageHeader
        title="Roles & access"
        description="Role profiles define module permissions and approval authority. Every change is audited."
        actions={
          can("users", "approve") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              New role
            </Button>
          )
        }
      />

      {isLoading ? (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      ) : roles.length === 0 ? (
        <EmptyState icon={<ShieldHalf />} title="No roles" description="Create a role to start granting access." />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[280px_1fr]">
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {roles.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => url.set({ role: r.id })}
                    className={cn(
                      "flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left transition-colors",
                      selected?.id === r.id ? "bg-subtle" : "hover:bg-subtle/60",
                    )}
                  >
                    <div className="min-w-0">
                      <p className={cn("truncate text-sm", selected?.id === r.id ? "font-medium text-ink" : "text-ink-2")}>{r.name}</p>
                      <p className="text-xs text-ink-3">{pluralize(r.user_count, "user")}</p>
                    </div>
                    {r.is_system && <Badge tone="outline">System</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {selected && (
            <div className="space-y-2">
              <div className="flex justify-end">
                <Link href={`/admin/users?role_id=${selected.id}`} className="text-xs font-medium text-accent hover:underline">
                  View {pluralize(selected.user_count, "user")} with this role
                </Link>
              </div>
              <RoleEditor role={selected} />
            </div>
          )}
        </div>
      )}

      <CreateRoleDialog open={creating} onOpenChange={setCreating} roles={roles} onCreated={(r) => url.set({ role: r.id })} />
    </>
  );
}

export default function RolesPage() {
  return (
    <Suspense>
      <RolesView />
    </Suspense>
  );
}
