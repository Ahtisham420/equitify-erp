"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";

import type { Interaction } from "./api";
import { InteractionComposer } from "./interaction-composer";

/** Reusable "Log interaction" panel for person / organization / property / opportunity pages. */
export function LogInteractionSheet({
  open,
  onOpenChange,
  defaults,
  onLogged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaults?: { person_id?: string; organization_id?: string; property_id?: string; opportunity_id?: string };
  onLogged?: (it: Interaction) => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Log interaction"
      description="Meaningful conversations need a next action with a date, or an explicit loop closure."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="log-interaction-form" loading={pending}>
            Log interaction
          </Button>
        </>
      }
    >
      {open && (
        <InteractionComposer
          formId="log-interaction-form"
          defaults={defaults}
          showLinks
          onPendingChange={setPending}
          onLogged={(it) => {
            onLogged?.(it);
            onOpenChange(false);
          }}
        />
      )}
    </Sheet>
  );
}
