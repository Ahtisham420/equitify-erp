"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { EntityPicker, UserPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";

import { useCreateClosing, type Closing } from "./api";

interface OpportunityLite {
  id: string;
  title: string;
  stage: string;
  property_label: string | null;
}

export function ClosingCreateSheet({
  open,
  onOpenChange,
  opportunityId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  opportunityId?: string;
  onCreated?: (c: Closing) => void;
}) {
  const [oppId, setOppId] = useState<string | null>(opportunityId ?? null);
  const [date, setDate] = useState("");
  const [coordinator, setCoordinator] = useState<string | null>(null);
  const [manager, setManager] = useState<string | null>(null);
  const create = useCreateClosing();

  useEffect(() => {
    if (open) {
      setOppId(opportunityId ?? null);
      setDate("");
      setCoordinator(null);
      setManager(null);
    }
  }, [open, opportunityId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!oppId) return;
    create.mutate(
      { opportunity_id: oppId, scheduled_closing_on: date || null, coordinator_id: coordinator, manager_id: manager },
      {
        onSuccess: (c) => {
          toast.success("Closing opened with the standard checklist");
          onOpenChange(false);
          onCreated?.(c);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) toast.error("This opportunity already has a closing");
          else toast.error(errorMessage(err));
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Open closing"
      description="Closings open automatically when an opportunity reaches the closing stage; open one manually here."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="closing-form" loading={create.isPending} disabled={!oppId}>
            Open closing
          </Button>
        </>
      }
    >
      <form id="closing-form" onSubmit={submit} className="space-y-4">
        {!opportunityId && (
          <Field label="Opportunity" required>
            <EntityPicker<OpportunityLite>
              endpoint="/opportunities"
              value={oppId}
              onChange={(id) => setOppId(id)}
              placeholder="Select opportunity"
              toOption={(o) => ({ id: o.id, label: o.title, sublabel: [o.property_label, o.stage.replace(/_/g, " ")].filter(Boolean).join(" · ") })}
            />
          </Field>
        )}
        <Field label="Scheduled closing date" hint="Defaults to the opportunity closing date.">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Closing coordinator" hint="Defaults to the opportunity owner.">
          <UserPicker value={coordinator} onChange={setCoordinator} />
        </Field>
        <Field label="Responsible asset manager" hint="Receives the operations handoff and the 90-day audit.">
          <UserPicker value={manager} onChange={setManager} />
        </Field>
      </form>
    </Sheet>
  );
}
