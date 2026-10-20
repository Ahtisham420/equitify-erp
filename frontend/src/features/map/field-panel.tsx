"use client";

import { Camera, Crosshair, MapPin, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Spinner } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatNumber, formatRelative, titleCase } from "@/lib/utils";

import { compressImage, newClientUuid, type QueuedObservation, type QueuedPhoto, type useFieldQueue } from "@/features/map/field-queue";

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: number;
}

const DEFAULT_CATEGORIES = ["general", "vacancy", "signage", "condition", "construction", "tenant", "access", "other"];

/** Capture dialog: current GPS fix + category + note + photos, stored in the offline queue. */
export function ObservationDialog({
  open,
  onOpenChange,
  fix,
  geoError,
  onLocate,
  property,
  categories,
  queue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fix: GeoFix | null;
  geoError: string | null;
  onLocate: () => void;
  property: { id: string; label: string } | null;
  categories?: string[];
  queue: ReturnType<typeof useFieldQueue>;
}) {
  const [category, setCategory] = useState("general");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<QueuedPhoto[]>([]);
  const [linkProperty, setLinkProperty] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setCategory("general");
      setNote("");
      setPhotos([]);
      setLinkProperty(true);
    }
  }, [open]);

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const next = await Promise.all(Array.from(files).slice(0, 6).map(async (f, i) => ({
        name: f.name || `photo-${Date.now()}-${i}.jpg`,
        dataUrl: await compressImage(f),
      })));
      setPhotos((p) => [...p, ...next].slice(0, 6));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const save = async () => {
    if (!fix) return;
    setBusy(true);
    const item: QueuedObservation = {
      client_uuid: newClientUuid(),
      lat: fix.lat,
      lng: fix.lng,
      accuracy_m: fix.accuracy,
      observed_at: new Date().toISOString(),
      category,
      note: note.trim() || null,
      property_id: linkProperty && property ? property.id : null,
      property_label: linkProperty && property ? property.label : null,
      photos: photos.map((p) => ({ ...p, name: p.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg" })),
      attempts: 0,
    };
    try {
      const result = await queue.add(item);
      if (result.sent) toast.success("Observation saved");
      else toast.success("Observation queued — it will sync when you are back online");
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const options = (categories?.length ? categories : DEFAULT_CATEGORIES).map((c) => ({ value: c, label: titleCase(c) }));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add observation"
      description="Captured with your current location. Saved on this device first, then synced."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!fix} loading={busy} onClick={save}>
            Save observation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-subtle px-3 py-2.5">
          <div className="min-w-0 text-sm">
            <p className="flex items-center gap-1.5 font-medium text-ink">
              <MapPin className="size-4 text-ink-3" />
              {fix ? `${fix.lat.toFixed(6)}, ${fix.lng.toFixed(6)}` : geoError ? "Location unavailable" : "Locating…"}
            </p>
            <p className="mt-0.5 text-xs text-ink-3">
              {fix
                ? `Accuracy ±${formatNumber(fix.accuracy ?? 0)} m · ${formatRelative(new Date(fix.at))}`
                : geoError ?? "Allow location access to capture coordinates."}
            </p>
          </div>
          <Button size="sm" onClick={onLocate}>
            {fix || geoError ? <Crosshair /> : <Spinner className="size-3.5" />}
            Refresh
          </Button>
        </div>

        {property && (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={linkProperty} onChange={setLinkProperty} label="Link to selected property" />
            Link to {property.label}
          </label>
        )}
        {!property && <p className="text-xs text-ink-3">The nearest property within about 75 m is linked automatically.</p>}

        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} options={options} />
        </Field>
        <Field label="Note">
          <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you see? Vacancy, signage, condition, activity…" />
        </Field>

        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Photos</p>
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={i} className="relative size-16 overflow-hidden rounded-md border border-line bg-subtle">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.dataUrl} alt={`Photo ${i + 1}`} className="size-full object-cover" />
                <button
                  onClick={() => setPhotos((all) => all.filter((_, j) => j !== i))}
                  className="absolute right-0.5 top-0.5 rounded bg-ink/70 p-0.5 text-white"
                  aria-label="Remove photo"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {photos.length < 6 && (
              <label className="flex size-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line-strong text-2xs text-ink-3 hover:bg-subtle">
                <Camera className="size-4" />
                Add
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    void addPhotos(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Pending queue with per-item errors; lets the user retry or discard items the server rejected. */
export function QueueDialog({ open, onOpenChange, queue }: { open: boolean; onOpenChange: (o: boolean) => void; queue: ReturnType<typeof useFieldQueue> }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pending observations"
      description={queue.online ? "These will sync automatically." : "You are offline. These will sync when the connection returns."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            variant="primary"
            disabled={!queue.online || !queue.pending}
            loading={queue.syncing}
            onClick={async () => {
              const r = await queue.sync();
              if (r.sent) toast.success(`${r.sent} observation${r.sent === 1 ? "" : "s"} synced`);
              if (r.failed) toast.error(`${r.failed} could not be synced`);
            }}
          >
            <RefreshCw />
            Sync now
          </Button>
        </>
      }
    >
      {queue.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-3">Nothing waiting to sync.</p>
      ) : (
        <ul className="divide-y divide-line">
          {queue.items.map((i) => (
            <li key={i.client_uuid} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge tone="sky">{titleCase(i.category)}</Badge>
                  <span className="text-xs text-ink-3">{formatRelative(i.observed_at)}</span>
                  {i.photos.length > 0 && <span className="text-xs text-ink-3 tabular">{i.photos.length} photo{i.photos.length === 1 ? "" : "s"}</span>}
                </div>
                <p className="mt-1 truncate text-sm text-ink">{i.note || "No note"}</p>
                {i.property_label && <p className="truncate text-xs text-ink-3">{i.property_label}</p>}
                {i.last_error && <p className="mt-0.5 text-xs text-negative">{i.last_error}</p>}
                {i.photo_warning && <p className="mt-0.5 text-xs text-caution">{i.photo_warning}</p>}
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Discard" onClick={() => queue.remove(i.client_uuid)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
