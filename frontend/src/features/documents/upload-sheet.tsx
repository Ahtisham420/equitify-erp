"use client";

import { FileUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { DOC_CLASSES, DOC_CLASS_LABELS, LINK_TYPE_LABELS, formatBytes, useDocumentsMeta, useUploadDocument, useUploadVersion, type DocumentDetail } from "./api";
import { RecordPicker, isValidRecordId } from "./link-dialog";

const DEFAULT_MAX_MB = 50;

export function DropZone({
  files,
  onFiles,
  multiple,
  maxMb,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  maxMb: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const accept = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list);
    const tooBig = picked.filter((f) => f.size > maxMb * 1024 * 1024);
    if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(", ")} exceed${tooBig.length === 1 ? "s" : ""} the ${maxMb} MB limit`);
    const ok = picked.filter((f) => f.size <= maxMb * 1024 * 1024 && f.size > 0);
    onFiles(multiple ? [...files, ...ok] : ok.slice(0, 1));
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          accept(e.dataTransfer.files);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center transition-colors",
          over ? "border-accent bg-accent-soft/50" : "border-line-strong bg-subtle/40 hover:bg-subtle",
        )}
      >
        <FileUp className="size-5 text-ink-3" />
        <span className="text-sm font-medium text-ink">Drop {multiple ? "files" : "a file"} here or click to browse</span>
        <span className="text-xs text-ink-3">Up to {maxMb} MB per file. Files are stored privately and opened through expiring links.</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          accept(e.target.files);
          e.target.value = "";
        }}
      />
      {files.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
              <span className="text-xs text-ink-3 tabular">{formatBytes(f.size)}</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${f.name}`} onClick={() => onFiles(files.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function warnDuplicates(d: DocumentDetail) {
  if (d.duplicates.length) {
    toast.warning(`${d.filename} matches an existing file`, {
      description: `Identical content: ${d.duplicates.map((x) => `${x.title} (v${x.version})`).join(", ")}`,
    });
  }
}

export function UploadDocumentSheet({
  open,
  onOpenChange,
  entityType,
  entityId,
  defaultClass,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType?: string;
  entityId?: string;
  defaultClass?: string;
  onUploaded?: (docs: DocumentDetail[]) => void;
}) {
  const { can } = useAuth();
  const { data: meta } = useDocumentsMeta();
  const upload = useUploadDocument();
  const maxMb = meta?.max_upload_mb ?? DEFAULT_MAX_MB;
  const preset = !!(entityType && entityId);

  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [docClass, setDocClass] = useState(defaultClass ?? "");
  const [description, setDescription] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [retention, setRetention] = useState("");
  const [tags, setTags] = useState("");
  const [linkType, setLinkType] = useState("property");
  const [linkId, setLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setTitle("");
      setDocClass(defaultClass ?? "");
      setDescription("");
      setSensitive(false);
      setRetention("");
      setTags("");
      setLinkType("property");
      setLinkId(null);
    }
  }, [open, defaultClass]);

  const submit = async () => {
    if (!files.length) return;
    setBusy(true);
    const done: DocumentDetail[] = [];
    const link = preset ? { entity_type: entityType, entity_id: entityId } : isValidRecordId(linkId) ? { entity_type: linkType, entity_id: linkId } : {};
    for (const file of files) {
      try {
        const d = await upload.mutateAsync({
          file,
          title: files.length === 1 ? title.trim() || undefined : undefined,
          doc_class: docClass || undefined,
          description: description.trim() || undefined,
          is_sensitive: sensitive || undefined,
          retention_until: retention || undefined,
          tags: tags.trim() || undefined,
          ...link,
        });
        warnDuplicates(d);
        done.push(d);
      } catch (e) {
        toast.error(`${file.name}: ${errorMessage(e)}`);
      }
    }
    setBusy(false);
    if (done.length) {
      toast.success(done.length === 1 ? "Document uploaded" : `${done.length} documents uploaded`);
      onUploaded?.(done);
      onOpenChange(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Upload documents"
      description={preset ? `Files will be linked to this ${(LINK_TYPE_LABELS[entityType!] ?? entityType!).toLowerCase()}.` : "Classify, link and set retention while uploading."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!files.length} loading={busy} onClick={submit}>
            Upload{files.length > 1 ? ` ${files.length} files` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <DropZone files={files} onFiles={setFiles} multiple maxMb={maxMb} />
        {files.length <= 1 && (
          <Field label="Title" hint="Defaults to the file name.">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
          </Field>
        )}
        <Field label="Document class" hint={meta?.ai.available ? "Leave unset to let AI suggest a class." : undefined}>
          <Select
            value={docClass}
            onChange={(e) => setDocClass(e.target.value)}
            placeholder="Unclassified"
            options={DOC_CLASSES.map((c) => ({ value: c, label: DOC_CLASS_LABELS[c] }))}
          />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        {!preset && (
          <Field label="Link to record" hint="Optional. More links can be added later.">
            <RecordPicker
              entityType={linkType}
              entityId={linkId}
              onChange={(t, id) => {
                setLinkType(t);
                setLinkId(id);
              }}
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Retain until" hint="Deletion is blocked before this date.">
            <Input type="date" value={retention} onChange={(e) => setRetention(e.target.value)} />
          </Field>
          <Field label="Tags" hint="Comma separated.">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. original, executed" />
          </Field>
        </div>
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

export function VersionUploadDialog({
  documentId,
  open,
  onOpenChange,
  onUploaded,
}: {
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded?: (d: DocumentDetail) => void;
}) {
  const { data: meta } = useDocumentsMeta();
  const upload = useUploadVersion(documentId);
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    if (open) setFiles([]);
  }, [open]);

  const submit = () =>
    upload.mutate(files[0], {
      onSuccess: (d) => {
        warnDuplicates(d);
        toast.success(`Version ${d.version} uploaded`);
        onOpenChange(false);
        onUploaded?.(d);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Upload new version"
      description="The previous version is kept in the history. Links, retention and holds carry over."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!files.length} loading={upload.isPending} onClick={submit}>
            Upload version
          </Button>
        </>
      }
    >
      <DropZone files={files} onFiles={setFiles} maxMb={meta?.max_upload_mb ?? DEFAULT_MAX_MB} />
    </Dialog>
  );
}
