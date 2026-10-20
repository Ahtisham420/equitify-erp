"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText, Link2, Lock, LockOpen, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Unlink, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Checkbox, Skeleton, Spinner, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import {
  DOC_CLASSES,
  DOC_CLASS_LABELS,
  LINK_TYPE_LABELS,
  docClassLabel,
  downloadDocument,
  formatBytes,
  getSignedUrl,
  openDocumentInTab,
  recordHref,
  useAddManualValue,
  useDeleteDocument,
  useDocument,
  useDocumentAccessLog,
  useDocumentAICalls,
  useDocumentJobs,
  useDocumentsMeta,
  useDocumentVersions,
  useRemoveLink,
  useRequestExtraction,
  useSetDocumentText,
  useUpdateDocument,
  type AccessLogEntry,
  type AICallEntry,
  type DocumentDetail,
  type DocumentListItem,
  type ExtractedValue,
  type ExtractionJob,
} from "@/features/documents/api";
import { LinkRecordDialog, RecordPicker, isValidRecordId } from "@/features/documents/link-dialog";
import { DocFlags, ExtractionBadge, linkLabel } from "@/features/documents/parts";
import { VersionUploadDialog } from "@/features/documents/upload-sheet";
import { DocumentValues } from "@/features/documents/verification-queue";

/* ------------------------------------------------------------------ preview */

function Preview({ doc }: { doc: DocumentDetail }) {
  const { data: meta } = useDocumentsMeta();
  const inlineable = !!meta?.inline_types.includes(doc.mime_type);
  const { data: src, isLoading, error } = useQuery({
    queryKey: ["documents", doc.id, "preview-url", doc.version],
    queryFn: () => getSignedUrl(doc.id, true),
    enabled: inlineable,
    staleTime: 8 * 60_000,
    refetchInterval: 8 * 60_000,
  });

  if (!meta) return <Skeleton className="h-[480px] w-full" />;
  if (!inlineable) {
    return (
      <EmptyState
        icon={<FileText />}
        title="No inline preview for this file type"
        description={`${doc.mime_type} files open through a download link.`}
        action={
          <Button onClick={() => downloadDocument(doc.id).catch((e) => toast.error(errorMessage(e)))}>
            <Download /> Download
          </Button>
        }
      />
    );
  }
  if (isLoading || !src) {
    return error ? <EmptyState title="Preview unavailable" description={errorMessage(error)} /> : (
      <div className="flex h-[480px] items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (doc.mime_type.startsWith("image/")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={doc.title} className="mx-auto max-h-[720px] max-w-full object-contain" />;
  }
  return <iframe src={src} title={doc.title} className="h-[720px] w-full rounded-b-lg bg-surface" />;
}

/* ------------------------------------------------------------------ metadata sheet */

function MetadataSheet({ doc, open, onOpenChange }: { doc: DocumentDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const save = useUpdateDocument(doc.id);
  const [title, setTitle] = useState(doc.title);
  const [docClass, setDocClass] = useState(doc.doc_class);
  const [description, setDescription] = useState(doc.description ?? "");
  const [tags, setTags] = useState(doc.tags.join(", "));
  const [retention, setRetention] = useState(doc.retention_until ?? "");
  const [sensitive, setSensitive] = useState(doc.is_sensitive);

  useEffect(() => {
    if (open) {
      setTitle(doc.title);
      setDocClass(doc.doc_class);
      setDescription(doc.description ?? "");
      setTags(doc.tags.join(", "));
      setRetention(doc.retention_until ?? "");
      setSensitive(doc.is_sensitive);
    }
    // Reset only when the sheet opens, so background refetches do not discard edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () =>
    save.mutate(
      {
        title: title.trim(),
        doc_class: docClass,
        description: description.trim() || null,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        retention_until: retention || null,
        ...(can("documents", "view_sensitive") ? { is_sensitive: sensitive } : {}),
      },
      {
        onSuccess: () => {
          toast.success("Document updated");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Edit document details"
      description="Changes apply to every version of this document."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim()} loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
        </Field>
        <Field label="Document class" hint={doc.classification_source === "ai" ? "Currently set by AI. Saving a different class marks it as manual." : undefined}>
          <Select value={docClass} onChange={(e) => setDocClass(e.target.value)} options={DOC_CLASSES.map((c) => ({ value: c, label: DOC_CLASS_LABELS[c] }))} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <Field label="Tags" hint="Comma separated.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="Retain until" hint={can("documents", "approve") ? "Deletion is blocked before this date." : "Shortening or clearing retention requires approval permission."}>
          <Input type="date" value={retention} onChange={(e) => setRetention(e.target.value)} />
        </Field>
        {can("documents", "view_sensitive") && (
          <label className="flex items-start gap-2 text-sm text-ink">
            <Checkbox checked={sensitive} onChange={setSensitive} label="Sensitive" className="mt-0.5" />
            <span>
              Sensitive document
              <span className="block text-xs text-ink-3">Only users with sensitive-document access can see it.</span>
            </span>
          </label>
        )}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ text */

function TextCard({ doc }: { doc: DocumentDetail }) {
  const { can } = useAuth();
  const setText = useSetDocumentText(doc.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <Card>
      <CardHeader
        title="Document text"
        description={
          doc.has_text
            ? `Source: ${doc.text_source === "file" ? "read from the file" : doc.text_source === "manual" ? "entered manually" : doc.text_source ?? "unknown"}. Used for search and extraction.`
            : "No text stored. Paste the document text to enable content search and extraction."
        }
        actions={
          can("documents", "edit") && (
            <Button
              size="sm"
              onClick={() => {
                setDraft(doc.text_content ?? "");
                setEditing(true);
              }}
            >
              <Pencil /> {doc.has_text ? "Edit text" : "Add text"}
            </Button>
          )
        }
      />
      {doc.has_text && (
        <CardBody>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-2 scrollbar-thin">{doc.text_content}</pre>
        </CardBody>
      )}
      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Document text"
        description="Paste the text of the document. A text extractor can supply this automatically in a later release."
        className="max-w-3xl"
        footer={
          <>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={setText.isPending}
              onClick={() =>
                setText.mutate(draft, {
                  onSuccess: () => {
                    toast.success("Text saved");
                    setEditing(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              Save text
            </Button>
          </>
        }
      >
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={18} className="font-mono text-xs" />
      </Dialog>
    </Card>
  );
}

/* ------------------------------------------------------------------ extraction */

function ExtractDialog({ doc, open, onOpenChange }: { doc: DocumentDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: meta } = useDocumentsMeta();
  const run = useRequestExtraction(doc.id);
  const first = doc.links.find((l) => l.entity_type === "property") ?? doc.links[0];
  const [targetType, setTargetType] = useState(first?.entity_type ?? "property");
  const [targetId, setTargetId] = useState<string | null>(first?.entity_id ?? null);

  useEffect(() => {
    if (open) {
      setTargetType(first?.entity_type ?? "property");
      setTargetId(first?.entity_id ?? null);
    }
  }, [open, first?.entity_type, first?.entity_id]);

  const submit = () =>
    run.mutate(isValidRecordId(targetId) ? { target_entity_type: targetType, target_entity_id: targetId } : {}, {
      onSuccess: (job) => {
        toast.success(job.status === "queued" ? "Extraction queued" : `Extraction ${job.status}`);
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run extraction"
      description="Runs in the background. Extracted values land in the verification queue with page and clause citations."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} onClick={submit}>
            <Sparkles /> Run extraction
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {meta && !meta.ai.available && (
          <p className="rounded-md border border-line bg-subtle/60 p-3 text-xs text-ink-2">
            No AI provider is configured, so the job will be recorded as skipped. You can still add values manually with citations.
          </p>
        )}
        {!doc.has_text && <p className="rounded-md border border-line bg-subtle/60 p-3 text-xs text-ink-2">This document has no stored text yet. Add the text first for extraction to find anything.</p>}
        <Field label="Compare against and apply to" hint="Values are compared with this record. Property fields can be applied after confirmation.">
          <RecordPicker entityType={targetType} entityId={targetId} onChange={(t, id) => { setTargetType(t); setTargetId(id); }} />
        </Field>
      </div>
    </Dialog>
  );
}

function ManualValueDialog({ doc, open, onOpenChange }: { doc: DocumentDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: meta } = useDocumentsMeta();
  const add = useAddManualValue(doc.id);
  const first = doc.links.find((l) => l.entity_type === "property") ?? doc.links[0];
  const [field, setField] = useState("");
  const [valueType, setValueType] = useState<ExtractedValue["value_type"]>("text");
  const [value, setValue] = useState("");
  const [page, setPage] = useState("");
  const [clause, setClause] = useState("");
  const [citation, setCitation] = useState("");
  const [targetType, setTargetType] = useState(first?.entity_type ?? "property");
  const [targetId, setTargetId] = useState<string | null>(first?.entity_id ?? null);

  const schema = useMemo(() => {
    const own = meta?.schemas[doc.doc_class] ?? [];
    const prop = targetType === "property" ? meta?.schemas._property ?? [] : [];
    const seen = new Set<string>();
    return [...own, ...prop].filter((f) => {
      if (seen.has(f.field)) return false;
      seen.add(f.field);
      return true;
    });
  }, [meta, doc.doc_class, targetType]);

  useEffect(() => {
    if (open) {
      setField("");
      setValue("");
      setPage("");
      setClause("");
      setCitation("");
      setValueType("text");
      setTargetType(first?.entity_type ?? "property");
      setTargetId(first?.entity_id ?? null);
    }
  }, [open, first?.entity_type, first?.entity_id]);

  const pickField = (f: string) => {
    setField(f);
    const def = schema.find((s) => s.field === f);
    if (def) setValueType(def.type);
  };

  const submit = () => {
    const numeric = ["number", "money", "percent"].includes(valueType);
    const parsed = numeric && !Number.isNaN(Number(value.replace(/,/g, ""))) ? Number(value.replace(/,/g, "")) : value.trim();
    add.mutate(
      {
        field: field.trim(),
        value: parsed,
        value_type: valueType,
        page: page ? Number(page) : null,
        clause: clause.trim() || null,
        citation_text: citation.trim() || null,
        ...(isValidRecordId(targetId) ? { target_entity_type: targetType, target_entity_id: targetId } : {}),
      },
      {
        onSuccess: () => {
          toast.success("Value added for review");
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
      title="Add a cited value"
      description="Abstract a value by hand with its page and clause. It goes through the same review as AI output."
      className="max-w-xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!field.trim() || !value.trim()} loading={add.isPending} onClick={submit}>
            Add value
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Record" hint="Optional. Property fields can be applied after confirmation.">
          <RecordPicker entityType={targetType} entityId={targetId} onChange={(t, id) => { setTargetType(t); setTargetId(id); }} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Field" required>
            {schema.length ? (
              <Select value={field} onChange={(e) => pickField(e.target.value)} placeholder="Select field" options={schema.map((s) => ({ value: s.field, label: s.label }))} />
            ) : (
              <Input value={field} onChange={(e) => setField(e.target.value.toLowerCase().replace(/\s+/g, "_"))} placeholder="e.g. base_rent_annual" />
            )}
          </Field>
          <Field label="Type">
            <Select
              value={valueType}
              onChange={(e) => setValueType(e.target.value as ExtractedValue["value_type"])}
              options={["text", "number", "money", "percent", "date"].map((t) => ({ value: t, label: titleCase(t) }))}
            />
          </Field>
        </div>
        <Field label="Value" required>
          <Input type={valueType === "date" ? "date" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Page">
            <Input inputMode="numeric" value={page} onChange={(e) => setPage(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Clause / section">
            <Input value={clause} onChange={(e) => setClause(e.target.value)} placeholder="e.g. 4.2(b)" />
          </Field>
        </div>
        <Field label="Quoted text">
          <Textarea value={citation} onChange={(e) => setCitation(e.target.value)} rows={3} />
        </Field>
      </div>
    </Dialog>
  );
}

const JOB_TONES: Record<string, "green" | "red" | "neutral" | "sky" | "blue"> = { completed: "green", failed: "red", skipped: "neutral", queued: "sky", running: "blue" };

function JobsCard({ id }: { id: string }) {
  const { data } = useDocumentJobs(id);
  if (!data?.length) return null;
  const columns: Column<ExtractionJob>[] = [
    { id: "status", header: "Status", cell: (j) => <Badge tone={JOB_TONES[j.status] ?? "neutral"} dot>{titleCase(j.status)}</Badge> },
    { id: "message", header: "Result", cell: (j) => <span className="text-xs text-ink-2">{j.message ?? "—"}</span> },
    { id: "provider", header: "Provider", cell: (j) => <span className="text-xs text-ink-3">{j.provider ? `${j.provider}${j.model && j.model !== j.provider ? ` · ${j.model}` : ""}` : "—"}</span> },
    { id: "values", header: "Values", align: "right", cell: (j) => j.values_count },
    { id: "created", header: "Requested", cell: (j) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(j.created_at)}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Extraction runs" description="AI calls never block the document workflow; unavailable providers mark runs as skipped." />
      <DataTable columns={columns} data={data} dense />
    </Card>
  );
}

function AICallsCard({ id }: { id: string }) {
  const { data } = useDocumentAICalls(id);
  if (!data?.items.length) return null;
  const columns: Column<AICallEntry>[] = [
    { id: "purpose", header: "Purpose", cell: (c) => <span className="text-ink">{titleCase(c.purpose.replace(":", " "))}</span> },
    { id: "model", header: "Model", cell: (c) => <span className="text-xs text-ink-2">{c.provider}{c.model ? ` · ${c.model}` : ""}</span> },
    { id: "tokens", header: "Tokens in / out", align: "right", cell: (c) => `${c.input_tokens ?? "—"} / ${c.output_tokens ?? "—"}` },
    { id: "latency", header: "Latency", align: "right", cell: (c) => `${c.latency_ms} ms` },
    { id: "status", header: "Status", cell: (c) => <Badge tone={c.status === "ok" ? "green" : "red"}>{c.status === "ok" ? "OK" : "Error"}</Badge> },
    { id: "hash", header: "Prompt hash", cell: (c) => <span className="font-mono text-2xs text-ink-3">{c.prompt_hash.slice(0, 12)}</span> },
    { id: "at", header: "When", cell: (c) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(c.created_at)}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="AI call log" description="Prompt, model and output logging for AI provenance." />
      <DataTable columns={columns} data={data.items} dense />
    </Card>
  );
}

/* ------------------------------------------------------------------ tabs */

function VersionsTab({ id }: { id: string }) {
  const { data, isLoading } = useDocumentVersions(id);
  const columns: Column<DocumentListItem>[] = [
    {
      id: "version",
      header: "Version",
      cell: (v) => (
        <span className="flex items-center gap-1.5 font-medium">
          v{v.version}
          {v.id === id && <Badge tone="blue">Viewing</Badge>}
        </span>
      ),
    },
    { id: "file", header: "File", cell: (v) => <span className="block max-w-[280px] truncate text-ink-2">{v.filename}</span> },
    { id: "size", header: "Size", align: "right", cell: (v) => formatBytes(v.size_bytes) },
    {
      id: "by",
      header: "Uploaded by",
      cell: (v) =>
        v.uploaded_by_name ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
            <Avatar name={v.uploaded_by_name} size={20} /> {v.uploaded_by_name}
          </span>
        ) : (
          "—"
        ),
    },
    { id: "at", header: "Uploaded", cell: (v) => <span className="whitespace-nowrap text-xs text-ink-3">{formatDateTime(v.created_at)}</span> },
    {
      id: "dl",
      header: "",
      align: "right",
      cell: (v) => (
        <Button size="xs" variant="ghost" onClick={() => downloadDocument(v.id).catch((e) => toast.error(errorMessage(e)))}>
          <Download className="!size-3.5" /> Download
        </Button>
      ),
    },
  ];
  return (
    <Card className="overflow-hidden">
      <DataTable columns={columns} data={data} loading={isLoading} dense rowHref={(v) => `/documents/${v.id}`} empty={<EmptyState title="No versions" />} />
    </Card>
  );
}

function LinksTab({ doc }: { doc: DocumentDetail }) {
  const { can } = useAuth();
  const remove = useRemoveLink();
  const [linking, setLinking] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-2">Records this document belongs to. Links apply to every version.</p>
        {can("documents", "edit") && (
          <Button size="sm" onClick={() => setLinking(true)}>
            <Link2 /> Link to record
          </Button>
        )}
      </div>
      <Card>
        {doc.links.length === 0 ? (
          <EmptyState icon={<Link2 />} title="Not linked to any record" description="Link this document to a property, contact, opportunity or other record." />
        ) : (
          <ul className="divide-y divide-line">
            {doc.links.map((l) => {
              const href = recordHref(l.entity_type, l.entity_id);
              return (
                <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Badge tone="outline">{LINK_TYPE_LABELS[l.entity_type] ?? titleCase(l.entity_type)}</Badge>
                  {href ? (
                    <Link href={href} className="min-w-0 flex-1 truncate text-sm text-ink hover:underline">
                      {linkLabel(l)}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{linkLabel(l)}</span>
                  )}
                  <span className="text-xs text-ink-3">{formatRelative(l.created_at)}</span>
                  {can("documents", "edit") && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Unlink"
                      onClick={() =>
                        remove.mutate(
                          { documentId: doc.id, linkId: l.id },
                          { onSuccess: () => toast.success("Unlinked"), onError: (e) => toast.error(errorMessage(e)) },
                        )
                      }
                    >
                      <Unlink />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <LinkRecordDialog documentId={doc.id} open={linking} onOpenChange={setLinking} />
    </div>
  );
}

function AccessTab({ id }: { id: string }) {
  const { data, isLoading } = useDocumentAccessLog(id);
  const columns: Column<AccessLogEntry>[] = [
    { id: "action", header: "Access", cell: (a) => <Badge tone={a.action === "download" ? "blue" : a.action === "preview" ? "sky" : "neutral"}>{titleCase(a.action)}</Badge> },
    {
      id: "user",
      header: "User",
      cell: (a) =>
        a.user_name ? (
          <span className="flex items-center gap-1.5 text-ink-2">
            <Avatar name={a.user_name} size={20} /> {a.user_name}
          </span>
        ) : (
          <span className="text-ink-3">Signed link</span>
        ),
    },
    { id: "ip", header: "IP address", cell: (a) => <span className="font-mono text-xs text-ink-3">{a.ip_address ?? "—"}</span> },
    { id: "at", header: "When", cell: (a) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(a.occurred_at)}</span> },
  ];
  return (
    <Card className="overflow-hidden">
      <DataTable columns={columns} data={data} loading={isLoading} dense empty={<EmptyState title="No access recorded yet" />} />
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

function DocumentDetailView({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: doc, isLoading, error } = useDocument(id);
  const update = useUpdateDocument(id);
  const del = useDeleteDocument();
  const [editing, setEditing] = useState(false);
  const [versioning, setVersioning] = useState(false);
  const [linking, setLinking] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const tab = url.get("tab") ?? "overview";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (error || !doc) {
    return <EmptyState title="Document not available" description={errorMessage(error)} action={<Link href="/documents"><Button>Back to documents</Button></Link>} />;
  }

  const toggleHold = () =>
    update.mutate(
      { legal_hold: !doc.legal_hold },
      {
        onSuccess: () => {
          toast.success(doc.legal_hold ? "Legal hold released" : "Legal hold placed");
          setHoldOpen(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const remove = () =>
    del.mutate(doc.id, {
      onSuccess: () => {
        toast.success("Document deleted");
        router.replace("/documents");
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const canEdit = can("documents", "edit");
  const canRelease = can("documents", "approve");

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Documents", href: "/documents" }, { label: doc.title }]}
        title={doc.title}
        description={`${doc.filename} · ${formatBytes(doc.size_bytes)} · uploaded ${formatRelative(doc.created_at)}${doc.uploaded_by_name ? ` by ${doc.uploaded_by_name}` : ""}`}
        meta={
          <>
            <Badge tone="outline">
              {docClassLabel(doc.doc_class)}
              {doc.classification_source === "ai" && <Sparkles className="size-3 text-info" />}
            </Badge>
            <Badge tone={doc.is_latest ? "neutral" : "amber"}>v{doc.version}{doc.is_latest ? "" : " · superseded"}</Badge>
            <DocFlags doc={doc} />
            <ExtractionBadge status={doc.extraction_status} />
            {!doc.is_latest && (
              <Link href={`/documents/${doc.parent_document_id ?? doc.id}?tab=versions`} className="text-xs text-accent hover:underline">
                View versions
              </Link>
            )}
          </>
        }
        actions={
          <>
            <Button onClick={() => openDocumentInTab(doc.id).catch((e) => toast.error(errorMessage(e)))}>
              <ExternalLink /> Open
            </Button>
            <Button onClick={() => downloadDocument(doc.id).catch((e) => toast.error(errorMessage(e)))}>
              <Download /> Download
            </Button>
            {canEdit && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {(canEdit || can("documents", "delete")) && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent width={220}>
                  {canEdit && (
                    <>
                      <MenuItem icon={<Upload />} onSelect={() => setVersioning(true)}>
                        Upload new version
                      </MenuItem>
                      <MenuItem icon={<Link2 />} onSelect={() => setLinking(true)}>
                        Link to record
                      </MenuItem>
                      <MenuItem icon={<Sparkles />} onSelect={() => setExtracting(true)}>
                        Run extraction
                      </MenuItem>
                      <MenuItem icon={<Plus />} onSelect={() => setAdding(true)}>
                        Add cited value
                      </MenuItem>
                      <MenuSeparator />
                      {doc.legal_hold ? (
                        <MenuItem icon={<LockOpen />} disabled={!canRelease} onSelect={() => setHoldOpen(true)}>
                          {canRelease ? "Release legal hold" : "Release requires approval"}
                        </MenuItem>
                      ) : (
                        <MenuItem icon={<Lock />} onSelect={() => setHoldOpen(true)}>
                          Place legal hold
                        </MenuItem>
                      )}
                    </>
                  )}
                  {can("documents", "delete") && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} destructive disabled={!doc.can_delete} onSelect={() => setDeleting(true)}>
                        {doc.delete_blocked_reason ?? "Delete version"}
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      {doc.duplicates.length > 0 && (
        <div className="mb-4 rounded-md border border-caution/40 bg-caution-soft/40 px-3 py-2 text-sm text-ink-2">
          Identical file content also stored as{" "}
          {doc.duplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ", "}
              <Link href={`/documents/${d.id}`} className="font-medium text-ink hover:underline">
                {d.title} (v{d.version})
              </Link>
            </span>
          ))}
          .
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "values", label: "Extracted values", count: doc.pending_values || undefined },
            { value: "versions", label: "Versions" },
            { value: "links", label: "Links", count: doc.links.length },
            { value: "access", label: "Access log" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="overview">
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
              <Card className="overflow-hidden">
                <CardHeader title="Preview" description="Opened through a short-lived signed link. Each preview is recorded in the access log." />
                <Preview doc={doc} />
              </Card>
              <TextCard doc={doc} />
            </div>
            <div className="space-y-5">
              <Card>
                <CardHeader title="Details" />
                <CardBody>
                  <FieldGrid cols={1}>
                    <FieldItem label="Class">
                      {docClassLabel(doc.doc_class)}
                      {doc.classification_source === "ai" && doc.classification_confidence != null
                        ? ` · AI ${Math.round(doc.classification_confidence * 100)}%`
                        : ""}
                    </FieldItem>
                    <FieldItem label="Description">{doc.description}</FieldItem>
                    <FieldItem label="Tags">
                      {doc.tags.length ? (
                        <span className="flex flex-wrap gap-1">
                          {doc.tags.map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                        </span>
                      ) : null}
                    </FieldItem>
                    <FieldItem label="File type">{doc.mime_type}</FieldItem>
                    <FieldItem label="SHA-256">
                      <span className="font-mono text-xs">{doc.sha256.slice(0, 24)}…</span>
                    </FieldItem>
                  </FieldGrid>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Retention & access" />
                <CardBody>
                  <FieldGrid cols={1}>
                    <FieldItem label="Retain until">{doc.retention_until ? formatDate(doc.retention_until) : null}</FieldItem>
                    <FieldItem label="Legal hold">{doc.legal_hold ? "On hold — cannot be deleted" : "None"}</FieldItem>
                    <FieldItem label="Sensitivity">{doc.is_sensitive ? "Sensitive — restricted access" : "Standard"}</FieldItem>
                    <FieldItem label="Deletion">{doc.delete_blocked_reason ?? "Allowed"}</FieldItem>
                  </FieldGrid>
                </CardBody>
              </Card>
              <Card>
                <CardHeader
                  title="Linked records"
                  actions={
                    canEdit && (
                      <Button size="xs" variant="ghost" onClick={() => setLinking(true)}>
                        <Plus className="!size-3.5" /> Link
                      </Button>
                    )
                  }
                />
                <CardBody>
                  {doc.links.length ? (
                    <ul className="space-y-1.5">
                      {doc.links.map((l) => {
                        const href = recordHref(l.entity_type, l.entity_id);
                        return (
                          <li key={l.id} className="flex items-center gap-2 text-sm">
                            <span className="w-24 shrink-0 text-xs text-ink-3">{LINK_TYPE_LABELS[l.entity_type] ?? titleCase(l.entity_type)}</span>
                            {href ? (
                              <Link href={href} className="truncate text-ink hover:underline">
                                {linkLabel(l)}
                              </Link>
                            ) : (
                              <span className="truncate text-ink">{linkLabel(l)}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-sm text-ink-3">Not linked to any record.</p>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </TabPanel>
        <TabPanel value="values">
          <div className="space-y-5">
            {canEdit && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus /> Add cited value
                </Button>
                <Button size="sm" variant="primary" onClick={() => setExtracting(true)}>
                  <Sparkles /> Run extraction
                </Button>
              </div>
            )}
            <DocumentValues documentId={doc.id} />
            <JobsCard id={doc.id} />
            <AICallsCard id={doc.id} />
          </div>
        </TabPanel>
        <TabPanel value="versions">
          <div className="space-y-3">
            {canEdit && (
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setVersioning(true)}>
                  <Upload /> Upload new version
                </Button>
              </div>
            )}
            <VersionsTab id={doc.id} />
          </div>
        </TabPanel>
        <TabPanel value="links">
          <LinksTab doc={doc} />
        </TabPanel>
        <TabPanel value="access">
          <AccessTab id={doc.id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="document" entityId={doc.id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <MetadataSheet doc={doc} open={editing} onOpenChange={setEditing} />
      <VersionUploadDialog documentId={doc.id} open={versioning} onOpenChange={setVersioning} onUploaded={(d) => router.push(`/documents/${d.id}`)} />
      <LinkRecordDialog documentId={doc.id} open={linking} onOpenChange={setLinking} />
      <ExtractDialog doc={doc} open={extracting} onOpenChange={setExtracting} />
      <ManualValueDialog doc={doc} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={holdOpen}
        onOpenChange={setHoldOpen}
        title={doc.legal_hold ? "Release legal hold?" : "Place legal hold?"}
        description={
          doc.legal_hold
            ? "The document can be deleted again once its retention period has passed."
            : "Every version of this document is protected from deletion until the hold is released by an approver."
        }
        confirmLabel={doc.legal_hold ? "Release hold" : "Place hold"}
        loading={update.isPending}
        onConfirm={toggleHold}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this version?"
        description="It is removed from lists; the previous version becomes current. Audit and access history are kept."
        confirmLabel="Delete"
        destructive
        loading={del.isPending}
        onConfirm={remove}
      />
    </>
  );
}

export default function DocumentPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <DocumentDetailView id={params.id} />
    </Suspense>
  );
}
