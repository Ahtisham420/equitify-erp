"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Download, FileStack, FileText, Link2, MoreHorizontal, Plus, Search, Sparkles, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, useColumnVisibility, type Column } from "@/components/data/data-table";
import { PropertyPicker } from "@/components/data/entity-picker";
import { ColumnsMenu, FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { BulkBar, BulkButton, EmptyState, ListCard, PageHeader } from "@/components/data/page";
import { SavedViewsMenu } from "@/components/data/saved-views";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, TabList, TabPanel, Tabs, Tooltip } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRelative, titleCase } from "@/lib/utils";

import {
  DOC_CLASSES,
  DOC_CLASS_LABELS,
  LINK_TYPE_LABELS,
  docClassLabel,
  downloadDocument,
  formatBytes,
  formatValue,
  useDeleteDocument,
  useDocumentsMeta,
  useDraft,
  useSummarize,
  type DocumentFacets,
  type DocumentListItem,
  type DraftResult,
  type SearchHit,
  type SummaryResult,
} from "@/features/documents/api";
import { LinkRecordDialog } from "@/features/documents/link-dialog";
import { DocFlags, ExtractionBadge, LinkChips } from "@/features/documents/parts";
import { UploadDocumentSheet, VersionUploadDialog } from "@/features/documents/upload-sheet";
import { VerificationQueue } from "@/features/documents/verification-queue";

const EXTRACTION_LABELS: Record<string, string> = {
  none: "Not extracted", queued: "Queued", running: "Extracting", completed: "Extracted", skipped: "Skipped", failed: "Failed",
};

const MORE: MoreFilterField[] = [
  { type: "select", label: "Legal hold", key: "legal_hold", options: [{ value: "true", label: "On hold" }, { value: "false", label: "Not on hold" }] },
  { type: "date-range", label: "Uploaded", minKey: "created_from", maxKey: "created_to" },
];

const CHIP_LABELS: Record<string, string> = { legal_hold: "Legal hold", created_from: "Uploaded after", created_to: "Uploaded before" };

function SummaryDialog({ result, onClose }: { result: SummaryResult | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!result}
      onOpenChange={(o) => !o && onClose()}
      title="Summary"
      description={result ? `${result.document_ids.length} document${result.document_ids.length === 1 ? "" : "s"}` : undefined}
      className="max-w-2xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {result && !result.ai_used ? (
        <EmptyState icon={<Sparkles />} title="AI summaries are not available" description={result.message ?? "No AI provider is configured."} />
      ) : (
        result && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm text-ink">{result.summary}</p>
            {result.citations.length > 0 && (
              <div className="space-y-1.5 border-t border-line pt-3">
                <p className="text-xs font-medium text-ink-3">Citations</p>
                {result.citations.map((c, i) => (
                  <p key={i} className="text-xs text-ink-2">
                    {c.document_id ? <Link href={`/documents/${c.document_id}`} className="font-medium hover:underline">Source</Link> : "Source"}
                    {c.page ? ` · p. ${c.page}` : ""}
                    {c.clause ? ` · § ${c.clause}` : ""}
                    {c.text ? ` — “${c.text}”` : ""}
                  </p>
                ))}
              </div>
            )}
            <p className="text-xs text-ink-3">AI-generated from {result.provider}. Verify against the cited documents before relying on it.</p>
          </div>
        )
      )}
    </Dialog>
  );
}

function LibraryView() {
  const { can } = useAuth();
  const list = useListQuery<DocumentListItem>("documents", "/documents");
  const { url } = list;
  const [selected, setSelected] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [versionOf, setVersionOf] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DocumentListItem | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const del = useDeleteDocument();
  const summarize = useSummarize();

  const filterParams = useMemo(() => {
    const { page: _p, page_size: _s, sort: _o, tab: _t, ...rest } = url.params;
    return rest;
  }, [url.params]);

  const { data: facets } = useQuery({
    queryKey: ["documents", "facets", filterParams],
    queryFn: () => api.get<DocumentFacets>("/documents/facets", filterParams),
    placeholderData: (prev) => prev,
  });

  const download = async (id: string) => {
    try {
      await downloadDocument(id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<DocumentListItem>[] = useMemo(
    () => [
      {
        id: "title",
        header: "Document",
        sortKey: "title",
        cell: (d) => (
          <div className="min-w-[220px] max-w-[360px]">
            <p className="flex items-center gap-1.5 font-medium text-ink">
              <span className="truncate">{d.title}</span>
              {d.version > 1 && <Badge tone="outline">v{d.version}</Badge>}
            </p>
            <p className="truncate text-xs text-ink-3">{d.filename}</p>
          </div>
        ),
      },
      {
        id: "class",
        header: "Class",
        sortKey: "doc_class",
        hideable: true,
        cell: (d) => (
          <span className="flex items-center gap-1 whitespace-nowrap text-ink-2">
            {docClassLabel(d.doc_class)}
            {d.classification_source === "ai" && (
              <Tooltip content="Classified by AI">
                <Sparkles className="size-3 text-info" />
              </Tooltip>
            )}
          </span>
        ),
      },
      { id: "links", header: "Linked to", hideable: true, cell: (d) => <LinkChips links={d.links} /> },
      { id: "flags", header: "Controls", hideable: true, cell: (d) => <DocFlags doc={d} /> },
      {
        id: "extraction",
        header: "Extraction",
        hideable: true,
        cell: (d) => (
          <span className="flex items-center gap-1.5">
            <ExtractionBadge status={d.extraction_status} />
            {d.pending_values > 0 && <Badge tone="amber">{d.pending_values} to review</Badge>}
          </span>
        ),
      },
      { id: "size", header: "Size", sortKey: "size_bytes", align: "right", hideable: true, cell: (d) => <span className="text-ink-2">{formatBytes(d.size_bytes)}</span> },
      {
        id: "uploaded_by",
        header: "Uploaded by",
        hideable: true,
        defaultHidden: true,
        cell: (d) =>
          d.uploaded_by_name ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
              <Avatar name={d.uploaded_by_name} size={20} />
              {d.uploaded_by_name}
            </span>
          ) : (
            <span className="text-ink-3">—</span>
          ),
      },
      { id: "updated", header: "Updated", sortKey: "updated_at", hideable: true, cell: (d) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(d.updated_at)}</span> },
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
                <MenuItem icon={<Download />} onSelect={() => download(d.id)}>
                  Download
                </MenuItem>
                {can("documents", "edit") && (
                  <>
                    <MenuItem icon={<Upload />} onSelect={() => setVersionOf(d.id)}>
                      Upload new version
                    </MenuItem>
                    <MenuItem icon={<Link2 />} onSelect={() => setLinkFor(d.id)}>
                      Link to record
                    </MenuItem>
                  </>
                )}
                {can("documents", "delete") && (
                  <>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} destructive disabled={d.legal_hold} onSelect={() => setDeleting(d)}>
                      {d.legal_hold ? "On legal hold" : "Delete"}
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [can],
  );
  const cols = useColumnVisibility("documents", columns);

  const chips: FilterChip[] = Object.entries(CHIP_LABELS)
    .filter(([k]) => url.get(k))
    .map(([k, label]) => ({
      key: k,
      label,
      value: k === "legal_hold" ? (url.get(k) === "true" ? "On hold" : "Not on hold") : url.get(k)!,
      onRemove: () => url.set({ [k]: null }),
    }));
  const facetChip = (key: string, label: string, fmt: (v: string) => string) => {
    const values = url.getAll(key);
    if (values.length) chips.unshift({ key, label, value: values.map(fmt).join(", "), onRemove: () => url.set({ [key]: null }) });
  };
  facetChip("doc_class", "Class", (v) => DOC_CLASS_LABELS[v] ?? v);
  facetChip("sensitivity", "Sensitivity", titleCase);
  facetChip("linked_type", "Linked to", (v) => LINK_TYPE_LABELS[v] ?? v);
  facetChip("extraction_status", "Extraction", (v) => EXTRACTION_LABELS[v] ?? v);

  const filtered = chips.length > 0 || !!url.get("q");

  const runSummary = () =>
    summarize.mutate(
      { document_ids: selected, purpose: "document_set" },
      { onSuccess: setSummary, onError: (e) => toast.error(errorMessage(e)) },
    );

  const confirmDelete = () =>
    deleting &&
    del.mutate(deleting.id, {
      onSuccess: () => {
        toast.success("Document deleted");
        setDeleting(null);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar
              right={
                <>
                  <SavedViewsMenu module="documents" />
                  <ColumnsMenu columns={columns} hidden={cols.hidden} onToggle={cols.toggle} onReset={cols.reset} />
                  {can("documents", "create") && (
                    <Button variant="primary" onClick={() => setUploading(true)}>
                      <Plus /> Upload
                    </Button>
                  )}
                </>
              }
            >
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search title, file name, description…" />
              <FacetFilter
                label="Class"
                searchable
                options={DOC_CLASSES.map((c) => ({ value: c, label: DOC_CLASS_LABELS[c], count: facets?.doc_class[c] ?? 0 }))}
                selected={url.getAll("doc_class")}
                onChange={(v) => url.set({ doc_class: v })}
              />
              <FacetFilter
                label="Linked to"
                options={Object.entries(facets?.linked_type ?? {}).map(([v, c]) => ({ value: v, label: LINK_TYPE_LABELS[v] ?? titleCase(v), count: c }))}
                selected={url.getAll("linked_type")}
                onChange={(v) => url.set({ linked_type: v })}
              />
              {can("documents", "view_sensitive") && (
                <FacetFilter
                  label="Sensitivity"
                  options={[
                    { value: "sensitive", label: "Sensitive", count: facets?.sensitivity.sensitive ?? 0 },
                    { value: "standard", label: "Standard", count: facets?.sensitivity.standard ?? 0 },
                  ]}
                  selected={url.getAll("sensitivity")}
                  onChange={(v) => url.set({ sensitivity: v })}
                />
              )}
              <FacetFilter
                label="Extraction"
                options={Object.keys(EXTRACTION_LABELS).map((s) => ({ value: s, label: EXTRACTION_LABELS[s], count: facets?.extraction_status[s] ?? 0 }))}
                selected={url.getAll("extraction_status")}
                onChange={(v) => url.set({ extraction_status: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ q: url.get("q"), sort: url.get("sort") })} />
          </div>
        }
        footer={
          <TableFooter
            page={list.page}
            pageSize={list.pageSize}
            total={list.data?.total ?? 0}
            onPage={(page) => url.set({ page }, { resetPage: false })}
            onPageSize={(size) => url.set({ page_size: size })}
          />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort")}
          onSortChange={(sort) => url.set({ sort })}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          rowHref={(d) => `/documents/${d.id}`}
          hidden={cols.hidden}
          empty={
            <EmptyState
              icon={<FileText />}
              title={filtered ? "No documents match these filters" : "No documents yet"}
              description={filtered ? "Try removing a filter or broadening your search." : "Upload leases, contracts, reports and correspondence to keep them with their records."}
              action={
                can("documents", "create") && !filtered ? (
                  <Button variant="primary" onClick={() => setUploading(true)}>
                    <Plus /> Upload
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </ListCard>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <BulkButton icon={<Sparkles />} onClick={runSummary} disabled={summarize.isPending}>
          {summarize.isPending ? "Summarizing…" : "Summarize"}
        </BulkButton>
      </BulkBar>

      <UploadDocumentSheet open={uploading} onOpenChange={setUploading} />
      {versionOf && <VersionUploadDialog documentId={versionOf} open onOpenChange={(o) => !o && setVersionOf(null)} />}
      {linkFor && <LinkRecordDialog documentId={linkFor} open onOpenChange={(o) => !o && setLinkFor(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this document version?"
        description={
          deleting
            ? `${deleting.title} v${deleting.version} will be removed from lists. The audit and access history are kept. Documents under retention or legal hold cannot be deleted.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={del.isPending}
        onConfirm={confirmDelete}
      />
      <SummaryDialog result={summary} onClose={() => setSummary(null)} />
    </>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        terms.some((t) => t.toLowerCase() === p.toLowerCase()) ? (
          <mark key={i} className="rounded-sm bg-caution-soft px-0.5 text-ink">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function AssistView() {
  const url = useUrlState();
  const { data: meta } = useDocumentsMeta();
  const { can } = useAuth();
  const q = url.get("q") ?? "";
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  const { data: hits, isFetching } = useQuery({
    queryKey: ["documents", "search", q],
    queryFn: () => api.get<SearchHit[]>("/documents/search", { q }),
    enabled: q.trim().length > 0,
  });

  const draft = useDraft();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [kind, setKind] = useState<"outreach" | "offer" | "proposal" | "report">("outreach");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<DraftResult | null>(null);

  const generate = () =>
    propertyId &&
    draft.mutate(
      { kind, entity_type: "property", entity_id: propertyId, instructions: instructions.trim() || undefined },
      { onSuccess: setResult, onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-3">
        <SearchInput value={q} onChange={(v) => url.set({ q: v })} placeholder="Ask across documents, e.g. renewal option Dollar General" className="w-full" />
        <p className="text-xs text-ink-3">
          Results respect your permissions: sensitive documents and records in modules you cannot access are left out.
        </p>
        {!q.trim() ? (
          <Card>
            <EmptyState icon={<Search />} title="Search document contents" description="Matches titles, descriptions, document text and cited extracted values, with snippets and page references." />
          </Card>
        ) : hits && hits.length === 0 && !isFetching ? (
          <Card>
            <EmptyState title="No matches" description="Try different words. Only documents with stored text can match on contents." />
          </Card>
        ) : (
          <div className="space-y-2">
            {(hits ?? []).map((h) => (
              <Card key={h.document_id}>
                <CardBody className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/documents/${h.document_id}`} className="font-medium text-ink hover:underline">
                      {h.title}
                    </Link>
                    <Badge tone="outline">{docClassLabel(h.doc_class)}</Badge>
                    {h.is_sensitive && <Badge tone="amber">Sensitive</Badge>}
                    <span className="text-xs text-ink-3">Matched in {h.matched_in.join(", ")}</span>
                  </div>
                  {h.snippet && (
                    <p className="text-sm text-ink-2">
                      <Highlight text={h.snippet} terms={terms} />
                    </p>
                  )}
                  {h.citations.length > 0 && (
                    <ul className="space-y-1 border-l-2 border-line pl-3">
                      {h.citations.map((c, i) => (
                        <li key={i} className="text-xs text-ink-2">
                          <span className="font-medium text-ink-3">{[c.page ? `p. ${c.page}` : null, c.clause ? `§ ${c.clause}` : null].filter(Boolean).join(" · ") || "Citation"}</span>{" "}
                          <Highlight text={c.text ?? ""} terms={terms} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {h.links.length > 0 && <LinkChips links={h.links} max={4} />}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3 lg:col-span-2">
        <Card>
          <CardHeader
            title="Drafting assistance"
            description="Drafts use verified facts only: verified property fields and human-confirmed document values."
            actions={meta && <Badge tone={meta.ai.available ? "sky" : "outline"}>{meta.ai.available ? `AI · ${meta.ai.model}` : "Template mode"}</Badge>}
          />
          <CardBody className="space-y-3">
            {can("properties") ? (
              <>
                <Field label="Property">
                  <PropertyPicker value={propertyId} onChange={(id) => setPropertyId(id)} />
                </Field>
                <Field label="Draft type">
                  <Select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    options={[
                      { value: "outreach", label: "Owner outreach" },
                      { value: "offer", label: "Offer / LOI" },
                      { value: "proposal", label: "Brokerage proposal" },
                      { value: "report", label: "Property report" },
                    ]}
                  />
                </Field>
                <Field label="Notes for the draft">
                  <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} />
                </Field>
                <Button variant="primary" disabled={!propertyId} loading={draft.isPending} onClick={generate}>
                  <FileStack /> Generate draft
                </Button>
              </>
            ) : (
              <p className="text-sm text-ink-3">Drafting requires access to properties.</p>
            )}
          </CardBody>
        </Card>
        {result && (
          <Card>
            <CardHeader
              title="Draft"
              description={result.ai_used ? `Written with ${result.provider}. Review before sending.` : "Built from a template — AI drafting is not enabled."}
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(result.draft).then(() => toast.success("Copied"));
                  }}
                >
                  <Copy /> Copy
                </Button>
              }
            />
            <CardBody className="space-y-3">
              <Textarea value={result.draft} readOnly rows={14} className="font-mono text-xs" />
              <div>
                <p className="mb-1 text-xs font-medium text-ink-3">Sources</p>
                <ul className="space-y-0.5">
                  {result.sources.map((s) => (
                    <li key={s.field} className="flex justify-between gap-3 text-xs">
                      <span className="text-ink-2">{titleCase(s.field)}</span>
                      <span className="truncate text-right text-ink-3">
                        {formatValue(s.value)} · {s.source}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function DocumentsView() {
  const url = useUrlState();
  const tab = url.get("tab") ?? "library";
  const { data: meta } = useDocumentsMeta();
  const { data: pending } = useQuery({
    queryKey: ["documents", "values", "pending-count"],
    queryFn: () => api.get<{ total: number }>("/documents/extracted-values", { status: "pending", page_size: 1 }),
  });

  return (
    <>
      <PageHeader
        title="Documents"
        description="Private file storage with classification, versions, retention and record links. AI output is assistive and never authoritative until a named reviewer confirms it."
        meta={
          meta && (
            <Badge tone={meta.ai.available ? "sky" : "outline"}>
              <Sparkles className="size-3" />
              {meta.ai.available ? `AI provider: ${meta.ai.name}` : "AI provider not configured"}
            </Badge>
          )
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "library" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "library", label: "Library" },
            { value: "verification", label: "Verification", count: pending?.total },
            { value: "assist", label: "Search & drafting" },
          ]}
        />
        <TabPanel value="library">{tab === "library" && <LibraryView />}</TabPanel>
        <TabPanel value="verification">{tab === "verification" && <VerificationQueue />}</TabPanel>
        <TabPanel value="assist">{tab === "assist" && <AssistView />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense>
      <DocumentsView />
    </Suspense>
  );
}
