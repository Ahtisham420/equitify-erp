"use client";

import { Plus, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber } from "@/lib/utils";

import { useCreateTeam, useTeams, type Team } from "./api";

export function TeamsPanel() {
  const { can } = useAuth();
  const { data = [], isLoading } = useTeams();
  const create = useCreateTeam();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const columns: Column<Team>[] = [
    { id: "name", header: "Team", cell: (t) => <span className="font-medium text-ink">{t.name}</span> },
    { id: "description", header: "Description", cell: (t) => <span className="text-ink-2">{t.description ?? "—"}</span> },
    {
      id: "members",
      header: "Members",
      align: "right",
      cell: (t) => (
        <Link href={`/admin/users?team_id=${t.id}`} className="text-accent hover:underline">
          {formatNumber(t.member_count)}
        </Link>
      ),
    },
  ];

  const submit = () =>
    create.mutate(
      { name: name.trim(), description: description.trim() || null },
      {
        onSuccess: () => {
          toast.success("Team created");
          setOpen(false);
          setName("");
          setDescription("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Teams"
        description="Team membership drives team-visible saved views and ownership reporting."
        actions={
          can("users", "create") && (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              <Plus />
              New team
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        data={data}
        loading={isLoading}
        empty={<EmptyState icon={<Users />} title="No teams yet" description="Group users into teams such as Acquisitions or Asset Management." />}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New team"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={submit}>
              Create team
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acquisitions – Texas" />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
