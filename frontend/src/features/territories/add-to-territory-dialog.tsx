"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EntityPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";

import { RULE_LABELS, useAddTerritoryMembers, type TerritoryListItem } from "./api";

/** Manually assign selected properties (or the properties linked to selected parcels) to a territory. */
export function AddToTerritoryDialog({
  open,
  onOpenChange,
  propertyIds = [],
  parcelIds = [],
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  propertyIds?: string[];
  parcelIds?: string[];
  onDone?: () => void;
}) {
  const [territoryId, setTerritoryId] = useState<string | null>(null);
  const add = useAddTerritoryMembers();
  const count = propertyIds.length + parcelIds.length;

  useEffect(() => {
    if (open) setTerritoryId(null);
  }, [open]);

  const submit = () => {
    if (!territoryId) return;
    add.mutate(
      { territoryId, property_ids: propertyIds, parcel_ids: parcelIds },
      {
        onSuccess: (r) => {
          toast.success(`${r.added} propert${r.added === 1 ? "y" : "ies"} assigned to the territory`);
          onOpenChange(false);
          onDone?.();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Assign to territory"
      description={
        parcelIds.length
          ? `Properties linked to the ${count} selected parcel${count === 1 ? "" : "s"} are added as manual members.`
          : `${count} selected propert${count === 1 ? "y is" : "ies are"} added as manual members.`
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!territoryId} loading={add.isPending} onClick={submit}>
            Assign
          </Button>
        </>
      }
    >
      <Field label="Territory" hint="Only territories you can edit accept new members.">
        <EntityPicker<TerritoryListItem>
          endpoint="/territories/options"
          list
          value={territoryId}
          onChange={(id) => setTerritoryId(id)}
          placeholder="Select territory"
          toOption={(t) => ({ id: t.id, label: t.name, sublabel: `${RULE_LABELS[t.rule_type] ?? t.rule_type} · ${t.member_count} members` })}
        />
      </Field>
    </Dialog>
  );
}
