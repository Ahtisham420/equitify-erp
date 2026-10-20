"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EntityPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";

import { LINK_TYPES, LINK_TYPE_LABELS, PICKER_ENDPOINTS, useAddLink } from "./api";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type + record selector. Types without a search endpoint accept a record ID. */
export function RecordPicker({
  entityType,
  entityId,
  onChange,
  types = LINK_TYPES as readonly string[],
}: {
  entityType: string;
  entityId: string | null;
  onChange: (entityType: string, entityId: string | null) => void;
  types?: readonly string[];
}) {
  const picker = PICKER_ENDPOINTS[entityType];
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2">
      <Select
        value={entityType}
        onChange={(e) => onChange(e.target.value, null)}
        options={types.map((t) => ({ value: t, label: LINK_TYPE_LABELS[t] ?? t }))}
      />
      {picker ? (
        <EntityPicker<Record<string, unknown> & { id: string }>
          key={entityType}
          endpoint={picker.endpoint}
          value={entityId}
          onChange={(id) => onChange(entityType, id)}
          placeholder={`Search ${(LINK_TYPE_LABELS[entityType] ?? entityType).toLowerCase()}…`}
          toOption={(r) => ({ id: r.id, label: picker.label(r) || r.id.slice(0, 8) })}
        />
      ) : (
        <Input
          value={entityId ?? ""}
          onChange={(e) => onChange(entityType, e.target.value.trim() || null)}
          placeholder="Record ID"
          aria-invalid={!!entityId && !UUID_RE.test(entityId)}
        />
      )}
    </div>
  );
}

export function isValidRecordId(id: string | null): id is string {
  return !!id && UUID_RE.test(id);
}

export function LinkRecordDialog({
  documentId,
  open,
  onOpenChange,
}: {
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [entityType, setEntityType] = useState("property");
  const [entityId, setEntityId] = useState<string | null>(null);
  const add = useAddLink();

  useEffect(() => {
    if (open) {
      setEntityType("property");
      setEntityId(null);
    }
  }, [open]);

  const submit = () => {
    if (!isValidRecordId(entityId)) return;
    add.mutate(
      { documentId, entity_type: entityType, entity_id: entityId },
      {
        onSuccess: () => {
          toast.success(`Linked to ${(LINK_TYPE_LABELS[entityType] ?? entityType).toLowerCase()}`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Link to a record"
      description="Links follow every version of this document."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!isValidRecordId(entityId)} loading={add.isPending} onClick={submit}>
            Link
          </Button>
        </>
      }
    >
      <Field label="Record">
        <RecordPicker
          entityType={entityType}
          entityId={entityId}
          onChange={(t, id) => {
            setEntityType(t);
            setEntityId(id);
          }}
        />
      </Field>
    </Dialog>
  );
}
