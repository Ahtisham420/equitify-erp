"use client";

import { Download, FileText, Link2, MoreHorizontal, Plus, Unlink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EntityPicker } from "@/components/data/entity-picker";
import { EmptyState } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRelative } from "@/lib/utils";

import {
  LINK_TYPE_LABELS,
  docClassLabel,
  downloadDocument,
  formatBytes,
  useAddLink,
  useRecordDocuments,
  useRemoveLink,
  type DocumentListItem,
} from "./api";
import { DocFlags } from "./parts";
import { UploadDocumentSheet } from "./upload-sheet";

async function openFile(id: string) {
  try {
    await downloadDocument(id);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

function LinkExistingDialog({
  entityType,
  entityId,
  open,
  onOpenChange,
}: {
  entityType: string;
  entityId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [docId, setDocId] = useState<string | null>(null);
  const add = useAddLink();
  const submit = () =>
    docId &&
    add.mutate(
      { documentId: docId, entity_type: entityType, entity_id: entityId },
      {
        onSuccess: () => {
          toast.success("Document linked");
          setDocId(null);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Link an existing document"
      description={`The document stays in the library and also appears on this ${(LINK_TYPE_LABELS[entityType] ?? entityType).toLowerCase()}.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!docId} loading={add.isPending} onClick={submit}>
            Link document
          </Button>
        </>
      }
    >
      <Field label="Document">
        <EntityPicker<DocumentListItem>
          endpoint="/documents"
          value={docId}
          onChange={(id) => setDocId(id)}
          placeholder="Search documents…"
          toOption={(d) => ({ id: d.id, label: d.title, sublabel: `${docClassLabel(d.doc_class)} · ${d.filename}` })}
        />
      </Field>
    </Dialog>
  );
}

/** Compact document list for any record page: upload (auto-linked), link existing, open, unlink. */
export function RecordDocuments({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { can } = useAuth();
  const { data, isLoading } = useRecordDocuments(entityType, entityId);
  const remove = useRemoveLink();
  const [uploading, setUploading] = useState(false);
  const [linking, setLinking] = useState(false);

  if (!can("documents")) return null;

  const unlink = (d: DocumentListItem) => {
    const lnk = d.links.find((l) => l.entity_type === entityType && l.entity_id === entityId);
    if (!lnk) return;
    remove.mutate(
      { documentId: d.id, linkId: lnk.id },
      { onSuccess: () => toast.success("Document unlinked"), onError: (e) => toast.error(errorMessage(e)) },
    );
  };

  const columns: Column<DocumentListItem>[] = [
    {
      id: "title",
      header: "Document",
      cell: (d) => (
        <div className="min-w-[200px] max-w-[360px]">
          <p className="flex items-center gap-1.5 truncate font-medium text-ink">
            <span className="truncate">{d.title}</span>
            {d.version > 1 && <Badge tone="outline">v{d.version}</Badge>}
          </p>
          <p className="truncate text-xs text-ink-3">
            {d.filename} · {formatBytes(d.size_bytes)}
          </p>
        </div>
      ),
    },
    { id: "class", header: "Class", cell: (d) => <span className="whitespace-nowrap text-ink-2">{docClassLabel(d.doc_class)}</span> },
    {
      id: "flags",
      header: "",
      cell: (d) => (
        <span className="flex items-center gap-1">
          <DocFlags doc={d} />
          {d.pending_values > 0 && <Badge tone="amber">{d.pending_values} to review</Badge>}
        </span>
      ),
    },
    { id: "updated", header: "Updated", cell: (d) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(d.updated_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (d) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Document actions">
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Download />} onSelect={() => openFile(d.id)}>
                Download
              </MenuItem>
              {can("documents", "edit") && (
                <MenuItem icon={<Unlink />} destructive onSelect={() => unlink(d)}>
                  Unlink from this record
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Files linked to this record. Each document can be linked to several records.</p>
        <div className="flex gap-2">
          {can("documents", "edit") && (
            <Button size="sm" onClick={() => setLinking(true)}>
              <Link2 /> Link existing
            </Button>
          )}
          {can("documents", "create") && (
            <Button size="sm" variant="primary" onClick={() => setUploading(true)}>
              <Plus /> Upload
            </Button>
          )}
        </div>
      </div>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          dense
          rowHref={(d) => `/documents/${d.id}`}
          empty={
            <EmptyState
              icon={<FileText />}
              title="No documents"
              description="Upload files or link documents already in the library."
              action={
                can("documents", "create") ? (
                  <Button variant="primary" onClick={() => setUploading(true)}>
                    <Plus /> Upload
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Card>
      <UploadDocumentSheet open={uploading} onOpenChange={setUploading} entityType={entityType} entityId={entityId} />
      <LinkExistingDialog entityType={entityType} entityId={entityId} open={linking} onOpenChange={setLinking} />
    </div>
  );
}
