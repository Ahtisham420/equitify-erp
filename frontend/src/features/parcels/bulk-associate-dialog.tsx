"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/features/properties/api";

import { PARCEL_RELATIONSHIPS, useBulkAssociate, type BulkAssociateInput, type BulkAssociateResult } from "./api";

type Mode = "existing" | "new";

/** Select many parcels -> link them to an existing property or a new one. Always previews before applying. */
export function BulkAssociateDialog({
  open,
  onOpenChange,
  parcelIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  parcelIds: string[];
  onDone?: (propertyId: string) => void;
}) {
  const { can } = useAuth();
  const bulk = useBulkAssociate();
  const [mode, setMode] = useState<Mode>("existing");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState("");
  const [np, setNp] = useState({ address_line: "", city: "", state: "", county: "", property_type: "land" });
  const [preview, setPreview] = useState<BulkAssociateResult | null>(null);

  useEffect(() => {
    if (open) {
      setPreview(null);
      setPropertyId(null);
      setRelationship("");
      setMode("existing");
      setNp({ address_line: "", city: "", state: "", county: "", property_type: "land" });
    }
  }, [open]);

  // Any input change invalidates the preview: bulk actions are applied only after a fresh preview.
  useEffect(() => setPreview(null), [mode, propertyId, relationship, np]);

  const ready = mode === "existing" ? !!propertyId : !!np.address_line.trim();

  const body = (isPreview: boolean): BulkAssociateInput => ({
    parcel_ids: parcelIds,
    property_id: mode === "existing" ? propertyId : null,
    new_property:
      mode === "new"
        ? {
            address_line: np.address_line.trim(),
            city: np.city.trim() || null,
            state: np.state.trim() || null,
            county: np.county.trim() || null,
            property_type: np.property_type,
            status: "tracked",
            tags: [],
          }
        : null,
    relationship: relationship || null,
    preview: isPreview,
  });

  const run = (isPreview: boolean) =>
    bulk.mutate(body(isPreview), {
      onSuccess: (r) => {
        if (r.preview) setPreview(r);
        else {
          toast.success(`${r.linked} parcel${r.linked === 1 ? "" : "s"} linked`);
          onOpenChange(false);
          if (r.property_id) onDone?.(r.property_id);
        }
      },
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409) toast.error("A property with this address already exists. Link to it instead.");
        else toast.error(errorMessage(e));
      },
    });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      title={`Associate ${parcelIds.length} parcel${parcelIds.length === 1 ? "" : "s"} with a property`}
      description="Preview the result, then confirm. Existing links are kept."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ready} loading={bulk.isPending && !preview} onClick={() => run(true)}>
            Preview
          </Button>
          <Button variant="primary" disabled={!ready || !preview} loading={bulk.isPending && !!preview} onClick={() => run(false)}>
            {mode === "new" ? "Create property & link" : "Link parcels"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-1 rounded-md border border-line bg-subtle p-0.5 text-sm">
          {(["existing", "new"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={m === "new" && !can("properties", "create")}
              onClick={() => setMode(m)}
              className={`h-7 flex-1 rounded px-2 font-medium disabled:opacity-40 ${mode === m ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink"}`}
            >
              {m === "existing" ? "Existing property" : "New property"}
            </button>
          ))}
        </div>

        {mode === "existing" ? (
          <Field label="Property">
            <PropertyPicker value={propertyId} onChange={(id) => setPropertyId(id)} />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Street address" required className="col-span-2">
              <Input value={np.address_line} onChange={(e) => setNp((s) => ({ ...s, address_line: e.target.value }))} />
            </Field>
            <Field label="City">
              <Input value={np.city} onChange={(e) => setNp((s) => ({ ...s, city: e.target.value }))} />
            </Field>
            <Field label="State">
              <Input value={np.state} maxLength={40} onChange={(e) => setNp((s) => ({ ...s, state: e.target.value }))} />
            </Field>
            <Field label="County">
              <Input value={np.county} onChange={(e) => setNp((s) => ({ ...s, county: e.target.value }))} />
            </Field>
            <Field label="Property type">
              <Select
                value={np.property_type}
                onChange={(e) => setNp((s) => ({ ...s, property_type: e.target.value }))}
                options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }))}
              />
            </Field>
          </div>
        )}

        <Field label="Relationship" hint="Automatic: the first parcel becomes primary if the property has none; the rest are assemblage.">
          <Select
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="Automatic"
            options={PARCEL_RELATIONSHIPS.map((r) => ({ value: r, label: titleCase(r) }))}
          />
        </Field>

        {preview && (
          <div className="rounded-lg border border-line">
            <div className="flex flex-wrap items-center gap-3 border-b border-line bg-subtle/60 px-3 py-2 text-xs text-ink-2">
              <span className="tabular">
                <span className="font-medium text-ink">{formatNumber(preview.parcels.length)}</span> parcels
              </span>
              <span className="tabular">
                <span className="font-medium text-ink">{formatNumber(preview.total_acreage, 2)}</span> ac total
              </span>
              {preview.contiguous === true && <Badge tone="green">Contiguous</Badge>}
              {preview.contiguous === false && <Badge tone="amber">Not contiguous</Badge>}
              {preview.missing_ids.length > 0 && <Badge tone="red">{preview.missing_ids.length} not found</Badge>}
            </div>
            <div className="max-h-56 overflow-y-auto scrollbar-thin">
              <table className="w-full text-sm">
                <tbody>
                  {preview.parcels.map((p) => (
                    <tr key={p.id} className="border-b border-line last:border-0">
                      <td className="px-3 py-1.5">
                        <Link href={`/parcels/${p.id}`} className="font-mono text-xs text-accent hover:underline">
                          {p.apn}
                        </Link>
                        <span className="ml-2 text-xs text-ink-3">{p.county}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular text-ink-2">{formatNumber(p.acreage, 2)} ac</td>
                      <td className="px-3 py-1.5">
                        {p.already_linked ? <Badge tone="outline">Already linked</Badge> : <Badge tone="blue">{titleCase(p.relationship)}</Badge>}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-ink-3">
                        {p.linked_elsewhere.length > 0 && `Also on ${p.linked_elsewhere.length} other propert${p.linked_elsewhere.length === 1 ? "y" : "ies"}`}
                        {!p.has_geometry && " · No geometry"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
