"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ClipboardCheck, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, MoreFilters, SearchInput, Toolbar, type FilterChip, type MoreFilterField } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Checkbox, Tooltip } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Params } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime, titleCase } from "@/lib/utils";

import {
  LINK_TYPE_LABELS,
  VALUE_STATUSES,
  VALUE_STATUS_LABELS,
  formatValue,
  recordHref,
  useExtractedValues,
  useReviewValue,
  type ExtractedValue,
  type ValueFacets,
} from "./api";
import { OriginBadge, ValueStatusBadge } from "./parts";

type Mode = "confirm" | "edit" | "reject";

function Citation({ v }: { v: ExtractedValue }) {
  const ref = [v.page ? `p. ${v.page}` : null, v.clause ? `§ ${v.clause}` : null].filter(Boolean).join(" · ");
  if (!ref && !v.citation_text) return <span className="text-ink-3">No citation</span>;
  return (
    <div className="max-w-[280px]">
      {ref && <p className="text-xs font-medium text-ink-2">{ref}</p>}
      {v.citation_text && (
        <Tooltip content={<span className="whitespace-pre-wrap">{v.citation_text}</span>}>
          <p className="line-clamp-2 cursor-help text-xs text-ink-3">&ldquo;{v.citation_text}&rdquo;</p>
        </Tooltip>
      )}
    </div>
  );
}

function CurrentValue({ v }: { v: ExtractedValue }) {
  if (!v.target_entity_type) return <span className="text-ink-3">No target</span>;
  if (v.conflict === null) return <span className="text-xs text-ink-3">Not compared</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("tabular", v.conflict ? "text-ink" : "text-ink-2")}>{formatValue(v.current_value)}</span>
      {v.conflict && v.status === "pending" && (
        <Badge tone="amber">
          <AlertTriangle className="size-3" /> Conflict
        </Badge>
      )}
    </span>
  );
}

export function ReviewDialog({ value, mode, onClose }: { value: ExtractedValue | null; mode: Mode; onClose: () => void }) {
  const review = useReviewValue();
  const [edited, setEdited] = useState("");
  const [note, setNote] = useState("");
  const [accept, setAccept] = useState(false);

  useEffect(() => {
    if (value) {
      setEdited(value.value === null || value.value === undefined ? "" : String(value.value));
      setNote("");
      setAccept(false);
    }
  }, [value]);

  if (!value) return null;
  const numeric = ["number", "money", "percent"].includes(value.value_type);
  const needsAccept = mode !== "reject" && !!value.conflict && value.applicable;

  const submit = () => {
    const parsed = numeric && edited.trim() !== "" && !Number.isNaN(Number(edited.replace(/,/g, ""))) ? Number(edited.replace(/,/g, "")) : edited.trim();
    const action =
      mode === "reject"
        ? { kind: "reject" as const, id: value.id, note: note || undefined }
        : mode === "edit"
          ? { kind: "edit" as const, id: value.id, value: parsed, accept_conflict: accept, note: note || undefined }
          : { kind: "confirm" as const, id: value.id, accept_conflict: accept, note: note || undefined };
    review.mutate(action, {
      onSuccess: (v) => {
        toast.success(`${titleCase(v.field)} ${VALUE_STATUS_LABELS[v.status].toLowerCase()}`);
        onClose();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const titles: Record<Mode, string> = { confirm: "Confirm extracted value", edit: "Edit and confirm", reject: "Reject extracted value" };

  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title={titles[mode]}
      description={`${titleCase(value.field)} · ${value.document_title ?? "Document"}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={mode === "reject" ? "danger" : "primary"}
            loading={review.isPending}
            disabled={(needsAccept && !accept) || (mode === "edit" && !edited.trim())}
            onClick={submit}
          >
            {mode === "reject" ? "Reject" : mode === "edit" ? "Save and confirm" : "Confirm"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-md border border-line bg-subtle/50 p-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-ink-3">
            <OriginBadge origin={value.origin} model={value.ai_model} />
            <span>Confidence</span>
            <ConfidencePill value={value.confidence} />
            {value.page && <span>· p. {value.page}</span>}
            {value.clause && <span>· § {value.clause}</span>}
          </div>
          {value.citation_text ? (
            <p className="whitespace-pre-wrap text-sm text-ink-2">&ldquo;{value.citation_text}&rdquo;</p>
          ) : (
            <p className="text-sm text-ink-3">No citation text was captured.</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border border-line p-3">
            <p className="text-xs text-ink-3">Extracted</p>
            <p className="mt-0.5 text-sm font-medium text-ink tabular">{formatValue(value.value)}</p>
          </div>
          <div className={cn("rounded-md border p-3", value.conflict ? "border-caution/40 bg-caution-soft/40" : "border-line")}>
            <p className="text-xs text-ink-3">
              Current on {value.target_label ?? (value.target_entity_type ? LINK_TYPE_LABELS[value.target_entity_type] ?? value.target_entity_type : "record")}
            </p>
            <p className="mt-0.5 text-sm font-medium text-ink tabular">{value.target_entity_type ? formatValue(value.current_value) : "—"}</p>
          </div>
        </div>

        {mode === "edit" && (
          <Field label="Corrected value">
            <Input type={value.is_date ? "date" : "text"} inputMode={numeric ? "decimal" : undefined} value={edited} onChange={(e) => setEdited(e.target.value)} autoFocus />
          </Field>
        )}

        {mode !== "reject" && value.applicable && (
          <p className="text-xs text-ink-3">
            Confirming writes this value to the property with your name as verifier. Its provenance stays marked as {value.origin === "ai" ? "AI-derived" : "document-derived"} permanently.
          </p>
        )}
        {mode !== "reject" && value.is_date && (
          <p className="text-xs text-ink-3">Dates are never turned into critical deadlines automatically. Propose a critical date from the contract record after confirming.</p>
        )}

        {needsAccept && (
          <label className="flex items-start gap-2 rounded-md border border-caution/40 bg-caution-soft/40 p-3 text-sm text-ink">
            <Checkbox checked={accept} onChange={setAccept} label="Replace current value" className="mt-0.5" />
            <span>
              Replace the current value
              <span className="block text-xs text-ink-3">The existing value and its source stay in field history.</span>
            </span>
          </label>
        )}

        <Field label={mode === "reject" ? "Reason" : "Review note"}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </div>
    </Dialog>
  );
}

function useColumns(opts: { showDocument: boolean; onAct: (v: ExtractedValue, m: Mode) => void; canEdit: boolean }): Column<ExtractedValue>[] {
  return useMemo(() => {
    const cols: Column<ExtractedValue>[] = [
      {
        id: "field",
        header: "Field",
        sortKey: "field",
        cell: (v) => (
          <div className="min-w-[140px]">
            <p className="font-medium text-ink">{titleCase(v.field)}</p>
            <p className="flex items-center gap-1 text-xs text-ink-3">
              {titleCase(v.value_type)}
              {v.is_date && <Badge tone="outline">Date</Badge>}
            </p>
          </div>
        ),
      },
      {
        id: "value",
        header: "Extracted",
        cell: (v) => (
          <div className="max-w-[220px]">
            <p className="truncate text-ink tabular">{formatValue(v.value)}</p>
            {v.status === "edited" && <p className="truncate text-xs text-ink-3 line-through">{formatValue(v.original_value)}</p>}
          </div>
        ),
      },
      { id: "current", header: "Current", cell: (v) => <CurrentValue v={v} /> },
      { id: "citation", header: "Citation", cell: (v) => <Citation v={v} /> },
      { id: "confidence", header: "Confidence", sortKey: "confidence", align: "right", cell: (v) => <ConfidencePill value={v.confidence} /> },
    ];
    if (opts.showDocument) {
      cols.push({
        id: "document",
        header: "Document",
        cell: (v) => (
          <Link href={`/documents/${v.document_id}`} className="block max-w-[200px] truncate text-ink-2 hover:text-ink hover:underline">
            {v.document_title ?? "Document"}
          </Link>
        ),
      });
    }
    cols.push(
      {
        id: "target",
        header: "Record",
        cell: (v) => {
          if (!v.target_entity_type || !v.target_entity_id) return <span className="text-ink-3">—</span>;
          const href = recordHref(v.target_entity_type, v.target_entity_id);
          const label = v.target_label ?? `${LINK_TYPE_LABELS[v.target_entity_type] ?? v.target_entity_type}`;
          return href ? (
            <Link href={href} className="block max-w-[180px] truncate text-ink-2 hover:text-ink hover:underline">
              {label}
            </Link>
          ) : (
            <span className="block max-w-[180px] truncate text-ink-2">{label}</span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        sortKey: "status",
        cell: (v) => (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1">
              <ValueStatusBadge status={v.status} />
              <OriginBadge origin={v.origin} model={v.ai_model} />
            </div>
            {v.reviewer_name && (
              <p className="whitespace-nowrap text-xs text-ink-3">
                {v.reviewer_name} · {formatDateTime(v.reviewed_at)}
              </p>
            )}
          </div>
        ),
      },
      {
        id: "actions",
        header: "",
        align: "right",
        cell: (v) =>
          v.status === "pending" && opts.canEdit ? (
            <div className="flex justify-end gap-1">
              <Button size="xs" onClick={() => opts.onAct(v, "confirm")}>
                <Check className="!size-3.5" /> Confirm
              </Button>
              <Button size="xs" variant="ghost" onClick={() => opts.onAct(v, "edit")} aria-label="Edit and confirm">
                <Pencil className="!size-3.5" />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => opts.onAct(v, "reject")} aria-label="Reject">
                <X className="!size-3.5" />
              </Button>
            </div>
          ) : null,
      },
    );
    return cols;
  }, [opts]);
}

/** Extracted values for one document (detail page). */
export function DocumentValues({ documentId }: { documentId: string }) {
  const { can } = useAuth();
  const [status, setStatus] = useState<string[]>([]);
  const [acting, setActing] = useState<{ v: ExtractedValue; m: Mode } | null>(null);
  const params: Params = { document_id: documentId, status, page_size: 200, sort: "field" };
  const { data, isLoading } = useExtractedValues(params);
  const opts = useMemo(() => ({ showDocument: false, canEdit: can("documents", "edit"), onAct: (v: ExtractedValue, m: Mode) => setActing({ v, m }) }), [can]);
  const columns = useColumns(opts);

  return (
    <div className="space-y-3">
      <FacetFilter
        label="Status"
        options={VALUE_STATUSES.map((s) => ({ value: s, label: VALUE_STATUS_LABELS[s] }))}
        selected={status}
        onChange={setStatus}
      />
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data?.items}
          loading={isLoading}
          dense
          empty={<EmptyState icon={<ClipboardCheck />} title="No extracted values" description="Run extraction, or add values by hand with their page and clause citation." />}
        />
      </Card>
      <ReviewDialog value={acting?.v ?? null} mode={acting?.m ?? "confirm"} onClose={() => setActing(null)} />
    </div>
  );
}

const MORE: MoreFilterField[] = [
  { type: "range", label: "Confidence (0–1)", minKey: "min_confidence", maxKey: "max_confidence" },
  {
    type: "select",
    label: "Origin",
    key: "origin",
    options: [
      { value: "ai", label: "AI" },
      { value: "manual", label: "Manual" },
    ],
  },
];

/** Workspace-wide verification queue (Documents → Verification tab). Filters live in the URL. */
export function VerificationQueue() {
  const { can } = useAuth();
  const url = useUrlState();
  const page = url.getNumber("page", 1);
  const pageSize = url.getNumber("page_size", 25);
  const statusSel = url.get("status") === null ? ["pending"] : url.getAll("status").filter((s) => s !== "all");
  const filterParams: Params = {
    q: url.get("q"),
    status: statusSel,
    field: url.getAll("field"),
    target_entity_type: url.getAll("target_entity_type"),
    origin: url.get("origin"),
    min_confidence: url.get("min_confidence"),
    max_confidence: url.get("max_confidence"),
  };
  const params: Params = { ...filterParams, page, page_size: pageSize, sort: url.get("sort") ?? "confidence" };
  const list = useExtractedValues(params);
  const { data: facets } = useQuery({
    queryKey: ["documents", "values", "facets", filterParams],
    queryFn: () => api.get<ValueFacets>("/documents/extracted-values/facets", filterParams),
    placeholderData: (prev) => prev,
  });
  const [acting, setActing] = useState<{ v: ExtractedValue; m: Mode } | null>(null);
  const opts = useMemo(() => ({ showDocument: true, canEdit: can("documents", "edit"), onAct: (v: ExtractedValue, m: Mode) => setActing({ v, m }) }), [can]);
  const columns = useColumns(opts);

  const chips: FilterChip[] = [];
  if (url.get("origin")) chips.push({ key: "origin", label: "Origin", value: url.get("origin") === "ai" ? "AI" : "Manual", onRemove: () => url.set({ origin: null }) });
  if (url.get("min_confidence")) chips.push({ key: "min_confidence", label: "Min confidence", value: url.get("min_confidence")!, onRemove: () => url.set({ min_confidence: null }) });
  if (url.get("max_confidence")) chips.push({ key: "max_confidence", label: "Max confidence", value: url.get("max_confidence")!, onRemove: () => url.set({ max_confidence: null }) });
  if (url.getAll("field").length) chips.push({ key: "field", label: "Field", value: url.getAll("field").map(titleCase).join(", "), onRemove: () => url.set({ field: null }) });

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2.5">
            <Toolbar>
              <SearchInput value={url.get("q") ?? ""} onChange={(q) => url.set({ q })} placeholder="Search field, citation, document…" />
              <FacetFilter
                label="Status"
                options={VALUE_STATUSES.map((s) => ({ value: s, label: VALUE_STATUS_LABELS[s], count: facets?.status[s] ?? 0 }))}
                selected={statusSel}
                onChange={(v) => url.set({ status: v.length ? v : ["all"] })}
              />
              <FacetFilter
                label="Field"
                searchable
                options={Object.entries(facets?.field ?? {}).sort((a, b) => b[1] - a[1]).map(([v, c]) => ({ value: v, label: titleCase(v), count: c }))}
                selected={url.getAll("field")}
                onChange={(v) => url.set({ field: v })}
              />
              <FacetFilter
                label="Record type"
                options={Object.entries(facets?.target_entity_type ?? {}).map(([v, c]) => ({ value: v, label: LINK_TYPE_LABELS[v] ?? titleCase(v), count: c }))}
                selected={url.getAll("target_entity_type")}
                onChange={(v) => url.set({ target_entity_type: v })}
              />
              <MoreFilters fields={MORE} values={url.params} onApply={(v) => url.set(v)} />
            </Toolbar>
            <FilterChips chips={chips} onClear={() => url.replaceAll({ tab: "verification", q: url.get("q"), status: url.getAll("status") })} />
          </div>
        }
        footer={
          <TableFooter
            page={page}
            pageSize={pageSize}
            total={list.data?.total ?? 0}
            onPage={(p) => url.set({ page: p }, { resetPage: false })}
            onPageSize={(s) => url.set({ page_size: s })}
          />
        }
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          sort={url.get("sort") ?? "confidence"}
          onSortChange={(sort) => url.set({ sort })}
          empty={
            <EmptyState
              icon={<ClipboardCheck />}
              title={statusSel.length === 1 && statusSel[0] === "pending" ? "Nothing waiting for review" : "No values match these filters"}
              description="Extracted values appear here with their page and clause citation until a named reviewer confirms, edits or rejects them."
            />
          }
        />
      </ListCard>
      <ReviewDialog value={acting?.v ?? null} mode={acting?.m ?? "confirm"} onClose={() => setActing(null)} />
    </>
  );
}
