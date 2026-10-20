"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";

import { uploadPhoto, type ObservationInput } from "@/features/map/api";

/**
 * Offline-first queue for field observations. Each item carries a device-generated `client_uuid`, so the
 * server stores it at most once however many times a flaky connection makes us re-send it.
 */
export const FIELD_QUEUE_KEY = "eqf_field_queue";

export interface QueuedPhoto {
  name: string;
  dataUrl: string;
  documentId?: string;
}

export interface QueuedObservation {
  client_uuid: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  observed_at: string;
  category: string;
  note: string | null;
  property_id: string | null;
  property_label?: string | null;
  photos: QueuedPhoto[];
  attempts: number;
  last_error?: string | null;
  photo_warning?: string | null;
}

export function newClientUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function read(): QueuedObservation[] {
  try {
    const raw = window.localStorage.getItem(FIELD_QUEUE_KEY);
    const items = raw ? (JSON.parse(raw) as QueuedObservation[]) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function write(items: QueuedObservation[]) {
  try {
    window.localStorage.setItem(FIELD_QUEUE_KEY, JSON.stringify(items));
  } catch {
    throw new Error("Device storage is full. Sync or remove queued observations, or attach fewer photos.");
  }
}

/** Downscales a captured photo to keep the offline queue within browser storage limits. */
export async function compressImage(file: File, maxSide = 1600, quality = 0.8): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the photo"));
    reader.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Unsupported image"));
      el.src = dataUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

const isOnline = () => typeof navigator === "undefined" || navigator.onLine;

export function useFieldQueue() {
  const qc = useQueryClient();
  const [items, setItems] = useState<QueuedObservation[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const busy = useRef(false);

  const save = useCallback((next: QueuedObservation[]) => {
    write(next);
    setItems(next);
  }, []);

  const update = useCallback((uuid: string, patch: Partial<QueuedObservation>) => {
    const next = read().map((i) => (i.client_uuid === uuid ? { ...i, ...patch } : i));
    save(next);
    return next.find((i) => i.client_uuid === uuid);
  }, [save]);

  const sync = useCallback(async () => {
    if (busy.current || !isOnline()) return { sent: 0, failed: 0 };
    busy.current = true;
    setSyncing(true);
    let sent = 0;
    let failed = 0;
    try {
      for (const queued of read()) {
        let item: QueuedObservation | undefined = queued;
        try {
          // Photos first (each upload is remembered, so a retry never uploads the same photo twice).
          for (let i = 0; item && i < item.photos.length; i++) {
            const current: QueuedObservation = item;
            const photo = current.photos[i];
            if (photo.documentId) continue;
            try {
              const id = await uploadPhoto(await dataUrlToBlob(photo.dataUrl), photo.name, current.property_id);
              const photos = current.photos.map((p, j) => (j === i ? { ...p, documentId: id } : p));
              item = update(current.client_uuid, { photos });
            } catch (e) {
              if (e instanceof ApiError && e.status === 403) {
                // No document permission: keep the observation, drop the photo upload.
                const photos = current.photos.filter((_, j) => j !== i);
                item = update(current.client_uuid, { photos, photo_warning: "Photos were not uploaded (no document permission)" });
                i--;
                continue;
              }
              throw e;
            }
          }
          if (!item) continue;
          const body: ObservationInput = {
            client_uuid: item.client_uuid,
            property_id: item.property_id,
            lat: item.lat,
            lng: item.lng,
            accuracy_m: item.accuracy_m,
            observed_at: item.observed_at,
            category: item.category,
            note: item.note,
            photo_document_ids: item.photos.map((p) => p.documentId).filter((x): x is string => !!x),
          };
          await api.post("/map/observations", body);
          save(read().filter((i) => i.client_uuid !== item!.client_uuid));
          sent++;
        } catch (e) {
          failed++;
          const status = e instanceof ApiError ? e.status : 0;
          update(queued.client_uuid, { attempts: (item?.attempts ?? queued.attempts) + 1, last_error: e instanceof Error ? e.message : "Sync failed" });
          // Lost connection: stop and wait for the next "online" event.
          if (status === 0) break;
        }
      }
    } finally {
      busy.current = false;
      setSyncing(false);
      if (sent) {
        qc.invalidateQueries({ queryKey: ["map", "layers"] });
        qc.invalidateQueries({ queryKey: ["map", "observations"] });
      }
    }
    return { sent, failed };
  }, [qc, save, update]);

  const add = useCallback(async (item: QueuedObservation) => {
    save([...read(), item]);
    if (isOnline()) return sync();
    return { sent: 0, failed: 0 };
  }, [save, sync]);

  const remove = useCallback((uuid: string) => save(read().filter((i) => i.client_uuid !== uuid)), [save]);

  useEffect(() => {
    setItems(read());
    setOnline(isOnline());
    const goOnline = () => {
      setOnline(true);
      void sync();
    };
    const goOffline = () => setOnline(false);
    const onStorage = (e: StorageEvent) => {
      if (e.key === FIELD_QUEUE_KEY) setItems(read());
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener("storage", onStorage);
    if (isOnline() && read().length) void sync();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("storage", onStorage);
    };
  }, [sync]);

  return { items, pending: items.length, syncing, online, add, sync, remove };
}
