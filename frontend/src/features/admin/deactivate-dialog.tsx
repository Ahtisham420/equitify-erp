"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";

import { useDeactivateUser, type AdminUser } from "./api";

/** Departure workflow: revoke access immediately and hand records/tasks to another user. */
export function DeactivateDialog({ user, open, onOpenChange }: { user: AdminUser; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const deactivate = useDeactivateUser(user.id);

  useEffect(() => {
    if (open) {
      setReassignTo(user.manager_id);
      setReason("");
    }
  }, [open, user.manager_id]);

  const submit = () =>
    deactivate.mutate(
      { reassign_to_id: reassignTo, reason: reason.trim() || null },
      {
        onSuccess: () => {
          toast.success(`${user.full_name} deactivated`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Deactivate ${user.full_name}?`}
      description="Sign-in is blocked, all sessions end and service credentials are revoked immediately. History and audit records are preserved."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" loading={deactivate.isPending} disabled={reassignTo === user.id} onClick={submit}>
            Deactivate user
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!user.is_service && (
          <Field
            label="Reassign owned records and open tasks to"
            hint={reassignTo ? "Opportunities, tasks, territories and contacts owned by this user move to the selected user." : "Without a selection, records keep this user as owner and should be reassigned manually."}
            error={reassignTo === user.id ? "Choose a different user" : null}
          >
            <UserPicker value={reassignTo} onChange={setReassignTo} placeholder="Do not reassign" />
          </Field>
        )}
        <Field label="Reason">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Left the company on Oct 10" />
        </Field>
      </div>
    </Dialog>
  );
}
