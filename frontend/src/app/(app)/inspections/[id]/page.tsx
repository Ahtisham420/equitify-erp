"use client";

import {
  Archive,
  ArrowRight,
  Ban,
  Camera,
  Check,
  CircleCheck,
  ClipboardList,
  LocateFixed,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Progress, Skeleton, TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatDateTime, formatNumber, formatRelative, titleCase } from "@/lib/utils";

import { RecordDocuments } from "@/features/documents/record-documents";
import {
  CATEGORY_LABELS,
  DOC_ENTITY,
  SEVERITIES,
  WO_CATEGORIES,
  categoryLabel,
  useAddFinding,
  useArchiveInspection,
  useFindingWorkOrder,
  useInspection,
  useInspectionStatus,
  useRecordResponses,
  useUpdateFinding,
  useUpdateInspection,
  type Finding,
  type Inspection,
  type ItemResponse,
  type TemplateItem,
} from "@/features/maintenance/api";
import { MaintenanceBadge, toastApiError } from "@/features/maintenance/work-order-form";

type Result = "pass" | "fail" | "na";
type Draft = { result: Result | null; note: string | null };

const RESULT_OPTIONS: { value: Result; label: string; active: string }[] = [
  { value: "pass", label: "Pass", active: "border-positive bg-positive-soft text-positive" },
  { value: "fail", label: "Fail", active: "border-negative bg-negative-soft text-negative" },
  { value: "na", label: "N/A", active: "border-line-strong bg-muted text-ink" },
];

const SEVERITY_TONES: Record<string, Tone> = { low: "neutral", medium: "amber", high: "red", critical: "red" };

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge tone={SEVERITY_TONES[severity] ?? "neutral"} dot>
      {severity === "critical" ? "Critical" : titleCase(severity)}
    </Badge>
  );
}

/* ------------------------------------------------------------------ geolocation */

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

function getPosition(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Location is not available on this device"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location permission was denied"
              : err.code === err.TIMEOUT
                ? "Timed out getting your location"
                : "Could not determine your location",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

function useLocate() {
  const [locating, setLocating] = useState(false);
  const locate = async (): Promise<Fix | null> => {
    setLocating(true);
    try {
      return await getPosition();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not determine your location");
      return null;
    } finally {
      setLocating(false);
    }
  };
  return { locate, locating };
}

function coords(lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/* ------------------------------------------------------------------ small pieces */

/** Disabled buttons swallow pointer events, so the tooltip sits on a wrapper. */
function Gate({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className="inline-flex rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
        {children}
      </span>
    </Tooltip>
  );
}

function ResultButtons({ value, disabled, onChange }: { value: Result | null; disabled: boolean; onChange: (v: Result | null) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:w-[264px] sm:shrink-0" role="radiogroup" aria-label="Result">
      {RESULT_OPTIONS.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(on ? null : o.value)}
            className={cn(
              "h-11 rounded-md border text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-80",
              on ? o.active : "border-line bg-surface text-ink-2 hover:bg-subtle",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ finding dialog */

interface ItemRef {
  key: string;
  label: string;
  section: string;
  category?: string | null;
}

function FindingDialog({
  inspection,
  open,
  onOpenChange,
  itemKey,
  items,
  onLogged,
}: {
  inspection: Inspection;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  itemKey: string | null;
  items: ItemRef[];
  onLogged: (itemKey: string | null) => void;
}) {
  const add = useAddFinding(inspection.id);
  const { locate, locating } = useLocate();
  const [form, setForm] = useState({ item: "", title: "", description: "", severity: "medium", category: "general" });
  const [fix, setFix] = useState<Fix | null>(null);

  useEffect(() => {
    if (!open) return;
    const item = items.find((i) => i.key === itemKey);
    setForm({
      item: item?.key ?? "",
      title: item ? `Failed: ${item.label}` : "",
      description: item ? inspection.responses[item.key]?.note ?? "" : "",
      severity: "medium",
      category: item?.category && (WO_CATEGORIES as readonly string[]).includes(item.category) ? item.category : "general",
    });
    setFix(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemKey]);

  const captureFix = async () => {
    const f = await locate();
    if (f) setFix(f);
  };

  const submit = () => {
    if (!form.title.trim()) return;
    add.mutate(
      {
        item_key: form.item || null,
        title: form.title.trim(),
        description: form.description.trim() || null,
        severity: form.severity,
        category: form.category,
        latitude: fix?.latitude ?? null,
        longitude: fix?.longitude ?? null,
        location_accuracy_m: fix?.accuracy ?? null,
        captured_at: new Date().toISOString(),
      },
      {
        onSuccess: (r) => {
          toast.success("Finding logged", r.auto_created ? { description: "A work order was created automatically for this severity." } : undefined);
          onLogged(form.item || null);
          onOpenChange(false);
        },
        onError: (e) => toastApiError(e),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Log finding"
      description="Record a deficiency. High-severity findings open a work order automatically; photos can be attached once it is logged."
      className="max-w-lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!form.title.trim()} loading={add.isPending} onClick={submit}>
            Log finding
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Checklist item" hint="Optional — linking marks the item as failed">
          <Select
            value={form.item}
            onChange={(e) => {
              const item = items.find((i) => i.key === e.target.value);
              setForm((f) => ({
                ...f,
                item: e.target.value,
                title: f.title || (item ? `Failed: ${item.label}` : ""),
                category: item?.category && (WO_CATEGORIES as readonly string[]).includes(item.category) ? item.category : f.category,
              }));
            }}
            placeholder="Not linked to an item"
            options={items.map((i) => ({ value: i.key, label: `${i.section} · ${i.label}` }))}
          />
        </Field>
        <Field label="Title" required>
          <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Cracked parking lot surface near entrance" />
        </Field>
        <Field label="Severity" required>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Severity">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={form.severity === s}
                onClick={() => setForm((f) => ({ ...f, severity: s }))}
                className={cn(
                  "h-11 rounded-md border text-sm font-medium transition-colors",
                  form.severity === s
                    ? s === "low"
                      ? "border-line-strong bg-muted text-ink"
                      : s === "medium"
                        ? "border-caution bg-caution-soft text-caution"
                        : "border-negative bg-negative-soft text-negative"
                    : "border-line bg-surface text-ink-2 hover:bg-subtle",
                )}
              >
                {titleCase(s)}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Category">
          <Select
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            options={WO_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? titleCase(c) }))}
          />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="What was observed, extent, location on site…" />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
          <div className="min-w-0 text-sm">
            <p className="font-medium text-ink">Location</p>
            <p className="text-xs text-ink-3 tabular">
              {fix ? `${coords(fix.latitude, fix.longitude)}${fix.accuracy != null ? ` · ±${formatNumber(fix.accuracy)} m` : ""}` : "Not captured"}
            </p>
          </div>
          <Button size="sm" loading={locating} onClick={() => void captureFix()}>
            <LocateFixed /> {fix ? "Update location" : "Use my location"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ findings */

function FindingRow({ finding: f, inspectionId, editable }: { finding: Finding; inspectionId: string; editable: boolean }) {
  const { can } = useAuth();
  const toWO = useFindingWorkOrder(inspectionId);
  const update = useUpdateFinding(inspectionId);
  const [photos, setPhotos] = useState(false);

  const setStatus = (status: "open" | "resolved" | "deferred") =>
    update.mutate({ id: f.id, status }, { onSuccess: () => toast.success(`Finding ${status === "open" ? "reopened" : status}`), onError: (e) => toastApiError(e) });

  const createWO = () =>
    toWO.mutate(f.id, {
      onSuccess: (wo) => toast.success(`Work order #${wo.number} created`),
      onError: (e) => toastApiError(e),
    });

  const loc = coords(f.latitude, f.longitude);

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={f.severity} />
            <MaintenanceBadge value={f.status} />
            <Badge tone="outline">{categoryLabel(f.category)}</Badge>
          </div>
          <p className="text-sm font-medium text-ink">{f.title}</p>
          {(f.section_title || f.item_label) && <p className="text-xs text-ink-3">{[f.section_title, f.item_label].filter(Boolean).join(" · ")}</p>}
          {f.description && <p className="whitespace-pre-wrap text-sm text-ink-2">{f.description}</p>}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
            {f.captured_at && <span title={formatDateTime(f.captured_at)}>{formatRelative(f.captured_at)}</span>}
            {loc && (
              <a
                href={`https://www.openstreetmap.org/?mlat=${f.latitude}&mlon=${f.longitude}#map=19/${f.latitude}/${f.longitude}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 tabular hover:text-ink hover:underline"
              >
                <MapPin className="size-3" /> {loc}
                {f.location_accuracy_m != null ? ` ±${formatNumber(f.location_accuracy_m)} m` : ""}
              </a>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {f.work_order_id ? (
            <Link href={`/work-orders/${f.work_order_id}`} className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm font-medium text-accent hover:underline">
              <Wrench className="size-3.5" /> Work order <ArrowRight className="size-3.5" />
            </Link>
          ) : (
            can("maintenance", "create") &&
            f.status !== "resolved" && (
              <Button size="sm" loading={toWO.isPending} onClick={createWO}>
                <Wrench /> Create work order
              </Button>
            )
          )}
          {can("documents") && (
            <Button size="sm" variant="ghost" onClick={() => setPhotos((p) => !p)} aria-expanded={photos}>
              <Camera /> Photos
            </Button>
          )}
          {editable && f.status !== "work_order_created" && (
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Finding actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent width={180}>
                {f.status !== "resolved" && (
                  <MenuItem icon={<CircleCheck />} onSelect={() => setStatus("resolved")}>
                    Mark resolved
                  </MenuItem>
                )}
                {f.status !== "deferred" && <MenuItem onSelect={() => setStatus("deferred")}>Defer</MenuItem>}
                {f.status !== "open" && <MenuItem onSelect={() => setStatus("open")}>Reopen</MenuItem>}
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>
      {photos && (
        <div className="mt-3 rounded-lg border border-line p-3">
          <RecordDocuments entityType={DOC_ENTITY.finding} entityId={f.id} />
        </div>
      )}
    </li>
  );
}

function FindingsCard({ inspection, editable, onAdd }: { inspection: Inspection; editable: boolean; onAdd: () => void }) {
  const order = (s: string) => SEVERITIES.length - SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]);
  const findings = [...inspection.findings].sort((a, b) => order(a.severity) - order(b.severity) || a.created_at.localeCompare(b.created_at));
  return (
    <Card>
      <CardHeader
        title={`Findings${findings.length ? ` (${findings.length})` : ""}`}
        description="Deficiencies found on site, with severity, location and follow-up work orders."
        actions={
          editable && (
            <Button size="sm" onClick={onAdd}>
              <Plus /> Add finding
            </Button>
          )
        }
      />
      <CardBody>
        {findings.length === 0 ? (
          <p className="text-sm text-ink-3">No findings logged.</p>
        ) : (
          <ul className="divide-y divide-line">
            {findings.map((f) => (
              <FindingRow key={f.id} finding={f} inspectionId={inspection.id} editable={editable} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ checklist */

function ChecklistItem({
  item,
  response,
  editable,
  hasFinding,
  onChange,
  onLogFinding,
}: {
  item: TemplateItem;
  response: Draft;
  editable: boolean;
  hasFinding: boolean;
  onChange: (d: Draft) => void;
  onLogFinding: () => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const showNote = noteOpen || !!response.note || response.result === "fail";
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            {item.label}
            {!response.result && editable && <span className="ml-1.5 text-xs font-normal text-caution">Unanswered</span>}
          </p>
          {item.guidance && <p className="mt-0.5 text-xs text-ink-3">{item.guidance}</p>}
        </div>
        <ResultButtons value={response.result} disabled={!editable} onChange={(result) => onChange({ ...response, result })} />
      </div>
      {showNote ? (
        <Textarea
          rows={2}
          value={response.note ?? ""}
          disabled={!editable}
          onChange={(e) => onChange({ ...response, note: e.target.value })}
          placeholder={response.result === "fail" ? "What failed? Location, extent…" : "Note (optional)"}
          className="text-base sm:text-sm"
        />
      ) : null}
      {editable && (
        <div className="flex flex-wrap gap-1.5">
          {!showNote && (
            <Button size="sm" variant="ghost" onClick={() => setNoteOpen(true)}>
              <MessageSquare /> Add note
            </Button>
          )}
          {response.result === "fail" && !hasFinding && (
            <Button size="sm" variant="ghost" onClick={onLogFinding}>
              <ShieldAlert /> Log finding
            </Button>
          )}
          {hasFinding && <span className="inline-flex h-7 items-center text-xs text-ink-3">Finding logged</span>}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ complete dialog */

function CompleteDialog({
  open,
  onOpenChange,
  inspection,
  unsaved,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inspection: Inspection;
  unsaved: number;
  loading: boolean;
  onConfirm: (summary: string | null) => void;
}) {
  const [summary, setSummary] = useState("");
  useEffect(() => {
    if (open) setSummary(inspection.summary ?? "");
  }, [open, inspection.summary]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Complete inspection?"
      description="Failed items without a finding are logged automatically, and findings at or above the configured severity open work orders. The checklist is then locked."
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Back</Button>
          <Button variant="primary" loading={loading} onClick={() => onConfirm(summary.trim() || null)}>
            <Check /> Complete inspection
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {unsaved > 0 && <p className="text-xs text-ink-3">Your {unsaved} unsaved answer{unsaved === 1 ? "" : "s"} will be saved first.</p>}
        <Field label="Summary" hint="Overall condition and key follow-ups">
          <Textarea autoFocus rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ page */

function InspectionDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: insp, isLoading, error } = useInspection(id);
  const save = useRecordResponses(id);
  const statusMut = useInspectionStatus(id);
  const update = useUpdateInspection(id);
  const archive = useArchiveInspection();
  const { locate, locating } = useLocate();

  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [findingFor, setFindingFor] = useState<{ open: boolean; itemKey: string | null }>({ open: false, itemKey: null });
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showUnanswered, setShowUnanswered] = useState(false);
  const tab = url.get("tab") ?? "checklist";

  // Drop local edits if the inspection is reloaded for a different record.
  useEffect(() => setEdits({}), [id]);

  const items = useMemo<ItemRef[]>(
    () => (insp?.sections ?? []).flatMap((s) => s.items.map((i) => ({ key: i.key, label: i.label, section: s.title, category: i.category }))),
    [insp?.sections],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (error || !insp) {
    return <EmptyState title="Inspection not found" description={errorMessage(error)} action={<Link href="/inspections"><Button>Back to inspections</Button></Link>} />;
  }

  const editPerm = can("maintenance", "edit");
  const open = insp.status === "scheduled" || insp.status === "in_progress";
  const editable = editPerm && open;

  const responseFor = (key: string): Draft => {
    if (edits[key]) return edits[key];
    const r: ItemResponse | undefined = insp.responses?.[key];
    return { result: r?.result ?? null, note: r?.note ?? null };
  };
  const setResponse = (key: string, d: Draft) => setEdits((e) => ({ ...e, [key]: d }));

  const dirtyKeys = Object.keys(edits).filter((k) => {
    const s = insp.responses?.[k];
    return (s?.result ?? null) !== edits[k].result || (s?.note ?? "") !== (edits[k].note ?? "");
  });
  const unanswered = items.filter((i) => !responseFor(i.key).result);
  const counts = items.reduce(
    (acc, i) => {
      const r = responseFor(i.key).result;
      if (r) acc[r] += 1;
      return acc;
    },
    { pass: 0, fail: 0, na: 0 },
  );
  const total = items.length;
  const answered = total - unanswered.length;
  const pct = total ? Math.round((answered / total) * 100) : 0;
  const findingKeys = new Set(insp.findings.map((f) => f.item_key).filter(Boolean) as string[]);

  const completeBlock = !open
    ? null
    : total === 0
      ? "This checklist has no items."
      : unanswered.length > 0
        ? `${unanswered.length} of ${total} checklist item${total === 1 ? "" : "s"} still need${unanswered.length === 1 ? "s" : ""} an answer.`
        : null;

  const responsesBody = () =>
    dirtyKeys.map((k) => ({ item_key: k, result: edits[k].result, note: (edits[k].note ?? "").trim() || null }));

  const saveResponses = () =>
    save.mutate(responsesBody(), {
      onSuccess: () => {
        setEdits({});
        toast.success("Responses saved");
      },
      onError: (e) => toastApiError(e),
    });

  const complete = async (summary: string | null) => {
    try {
      if (dirtyKeys.length) {
        await save.mutateAsync(responsesBody());
        setEdits({});
      }
      const r = await statusMut.mutateAsync({ status: "completed", summary });
      setCompleting(false);
      const wos = r.findings.filter((f) => f.work_order_id).length;
      toast.success("Inspection completed", wos ? { description: `${wos} finding${wos === 1 ? "" : "s"} linked to work orders.` } : undefined);
    } catch (e) {
      toastApiError(e);
    }
  };

  const setStatus = (status: "in_progress" | "cancelled", message: string, onDone?: () => void) =>
    statusMut.mutate(
      { status },
      {
        onSuccess: () => {
          toast.success(message);
          onDone?.();
        },
        onError: (e) => toastApiError(e),
      },
    );

  const captureLocation = async () => {
    const f = await locate();
    if (!f) return;
    update.mutate({ latitude: f.latitude, longitude: f.longitude }, { onSuccess: () => toast.success("Location recorded"), onError: (e) => toastApiError(e) });
  };

  const doArchive = () =>
    archive.mutate(id, {
      onSuccess: () => {
        toast.success("Inspection archived");
        router.replace("/inspections");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const openFinding = (itemKey: string | null) => setFindingFor({ open: true, itemKey });
  const onFindingLogged = (itemKey: string | null) => {
    // The server marks the linked item as failed; keep any local note but align the result.
    if (itemKey && edits[itemKey]) setResponse(itemKey, { ...edits[itemKey], result: "fail" });
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Inspections", href: "/inspections" }, { label: insp.template_name ?? "Inspection" }]}
        title={insp.template_name ?? "Inspection"}
        description={
          <Link href={`/properties/${insp.property_id}`} className="hover:underline">
            {[insp.property_name, insp.scheduled_on ? `Scheduled ${formatDate(insp.scheduled_on)}` : null].filter(Boolean).join(" · ")}
          </Link>
        }
        meta={
          <>
            <MaintenanceBadge value={insp.status} />
            {insp.score != null && <Badge tone={insp.score >= 80 ? "green" : insp.score >= 50 ? "amber" : "red"}>Score {formatNumber(insp.score)}</Badge>}
            {insp.open_finding_count > 0 && <Badge tone="amber">{insp.open_finding_count} open finding{insp.open_finding_count === 1 ? "" : "s"}</Badge>}
          </>
        }
        actions={
          editPerm && (
            <>
              {insp.status === "scheduled" && (
                <Button loading={statusMut.isPending && !completing} onClick={() => setStatus("in_progress", "Inspection started")}>
                  <Play /> Start
                </Button>
              )}
              {open && (
                <Gate reason={completeBlock}>
                  <Button variant="primary" disabled={!!completeBlock} onClick={() => setCompleting(true)}>
                    <Check /> Complete
                  </Button>
                </Gate>
              )}
              {(open || can("maintenance", "delete")) && (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon" aria-label="More actions">
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent width={200}>
                    {open && (
                      <MenuItem icon={<LocateFixed />} onSelect={() => void captureLocation()}>
                        Record my location
                      </MenuItem>
                    )}
                    {open && (
                      <MenuItem icon={<Ban />} destructive onSelect={() => setCancelling(true)}>
                        Cancel inspection…
                      </MenuItem>
                    )}
                    {can("maintenance", "delete") && (
                      <>
                        {open && <MenuSeparator />}
                        <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>
                          Archive
                        </MenuItem>
                      </>
                    )}
                  </MenuContent>
                </Menu>
              )}
            </>
          )
        }
      />

      <Card className="mb-5">
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-ink tabular">
              {answered} of {total} answered
            </span>
            <span className="flex flex-wrap gap-3 text-xs text-ink-3 tabular">
              <span className="text-positive">{counts.pass} pass</span>
              <span className="text-negative">{counts.fail} fail</span>
              <span>{counts.na} n/a</span>
            </span>
          </div>
          <Progress value={pct} tone="accent" />
          {open && completeBlock && unanswered.length > 0 && (
            <div className="rounded-lg border border-caution/30 bg-caution-soft px-3 py-2.5 text-sm">
              <p className="font-medium text-caution">Completion is blocked</p>
              <p className="mt-0.5 text-ink-2">{completeBlock} Every item must be marked pass, fail or N/A before the inspection can be completed.</p>
              <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => setShowUnanswered((s) => !s)}>
                {showUnanswered ? "Hide unanswered items" : "Show unanswered items"}
              </button>
              {showUnanswered && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                  {unanswered.map((i) => (
                    <li key={i.key}>
                      {i.section} · {i.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {insp.status === "cancelled" && <p className="text-sm text-ink-3">This inspection was cancelled; the checklist is read-only.</p>}
          {insp.status === "completed" && insp.completed_at && <p className="text-sm text-ink-3">Completed {formatDateTime(insp.completed_at)}; the checklist is locked.</p>}
        </CardBody>
      </Card>

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "checklist" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "checklist", label: "Checklist" },
            { value: "findings", label: "Findings", count: insp.findings.length },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="checklist">
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
              {insp.sections.length === 0 ? (
                <Card>
                  <CardBody>
                    <EmptyState icon={<ClipboardList />} title="No checklist items" description="The template used for this inspection has no sections." />
                  </CardBody>
                </Card>
              ) : (
                insp.sections.map((s) => {
                  const done = s.items.filter((i) => responseFor(i.key).result).length;
                  return (
                    <Card key={s.key}>
                      <CardHeader title={s.title} actions={<span className="text-xs text-ink-3 tabular">{done}/{s.items.length}</span>} />
                      <CardBody>
                        <ul className="divide-y divide-line">
                          {s.items.map((i) => (
                            <ChecklistItem
                              key={i.key}
                              item={i}
                              response={responseFor(i.key)}
                              editable={editable}
                              hasFinding={findingKeys.has(i.key)}
                              onChange={(d) => setResponse(i.key, d)}
                              onLogFinding={() => openFinding(i.key)}
                            />
                          ))}
                        </ul>
                      </CardBody>
                    </Card>
                  );
                })
              )}
            </div>
            <div className="space-y-5">
              <Card>
                <CardHeader title="Details" />
                <CardBody>
                  <FieldGrid cols={2}>
                    <FieldItem label="Property">
                      <Link href={`/properties/${insp.property_id}`} className="text-accent hover:underline">
                        {insp.property_name ?? "Property"}
                      </Link>
                    </FieldItem>
                    <FieldItem label="Template">{insp.template_name ? `${insp.template_name}${insp.template_version ? ` · v${insp.template_version}` : ""}` : null}</FieldItem>
                    <FieldItem label="Inspector">{insp.inspector_name}</FieldItem>
                    <FieldItem label="Scheduled">{insp.scheduled_on ? formatDate(insp.scheduled_on) : null}</FieldItem>
                    <FieldItem label="Started">{insp.started_at ? formatDateTime(insp.started_at) : null}</FieldItem>
                    <FieldItem label="Completed">{insp.completed_at ? formatDateTime(insp.completed_at) : null}</FieldItem>
                  </FieldGrid>
                  {insp.summary && (
                    <div className="mt-4">
                      <p className="text-xs text-ink-3">Summary</p>
                      <p className="whitespace-pre-wrap text-sm text-ink-2">{insp.summary}</p>
                    </div>
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Location" description="Where the inspection was performed." />
                <CardBody className="space-y-3">
                  <p className="flex items-center gap-1.5 text-sm text-ink-2 tabular">
                    <MapPin className="size-4 text-ink-3" />
                    {coords(insp.latitude, insp.longitude) ?? <span className="text-ink-3">Not recorded</span>}
                  </p>
                  {editable && (
                    <Button className="h-11 w-full sm:h-8 sm:w-auto" loading={locating || update.isPending} onClick={() => void captureLocation()}>
                      <LocateFixed /> Use my location
                    </Button>
                  )}
                </CardBody>
              </Card>
              <FindingsCard inspection={insp} editable={editPerm && insp.status !== "cancelled"} onAdd={() => openFinding(null)} />
            </div>
          </div>
        </TabPanel>
        <TabPanel value="findings">
          <FindingsCard inspection={insp} editable={editPerm && insp.status !== "cancelled"} onAdd={() => openFinding(null)} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="inspection" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      {editable && dirtyKeys.length > 0 && (
        <div className="sticky bottom-3 z-20 mt-5">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-pop">
            <span className="text-sm text-ink-2">
              <span className="font-medium text-ink tabular">{dirtyKeys.length}</span> unsaved answer{dirtyKeys.length === 1 ? "" : "s"}
            </span>
            <div className="flex gap-2">
              <Button className="h-11 sm:h-8" variant="ghost" onClick={() => setEdits({})}>
                Discard
              </Button>
              <Button className="h-11 sm:h-8" variant="primary" loading={save.isPending} onClick={saveResponses}>
                Save responses
              </Button>
            </div>
          </div>
        </div>
      )}

      <FindingDialog
        inspection={insp}
        open={findingFor.open}
        onOpenChange={(o) => setFindingFor((f) => ({ ...f, open: o }))}
        itemKey={findingFor.itemKey}
        items={items}
        onLogged={onFindingLogged}
      />
      <CompleteDialog
        open={completing}
        onOpenChange={setCompleting}
        inspection={insp}
        unsaved={dirtyKeys.length}
        loading={save.isPending || statusMut.isPending}
        onConfirm={(summary) => void complete(summary)}
      />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this inspection?"
        description="Answers and findings are kept for the record, but the checklist can no longer be changed."
        confirmLabel="Cancel inspection"
        destructive
        loading={statusMut.isPending}
        onConfirm={() => setStatus("cancelled", "Inspection cancelled", () => setCancelling(false))}
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this inspection?"
        description="It is removed from lists but retained with its full history for audit."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={doArchive}
      />
    </>
  );
}

export default function InspectionPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <InspectionDetail id={params.id} />
    </Suspense>
  );
}
