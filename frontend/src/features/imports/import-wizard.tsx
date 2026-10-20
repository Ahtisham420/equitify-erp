"use client";

import { AlertTriangle, ArrowLeft, ArrowRight, Check, ExternalLink, FileSpreadsheet, RotateCcw, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, StatCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/input";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatNumber, pluralize, titleCase } from "@/lib/utils";

import {
  ENTITY_LABELS,
  ENTITY_TYPES,
  entityHref,
  useCommitImport,
  useDataSourceOptions,
  useImportRows,
  useRollbackImport,
  useSaveMapping,
  useUploadImport,
  useValidateImport,
  type EntityType,
  type ImportJobDetail,
  type ImportRow,
} from "./api";
import { DataSourceFormSheet } from "./data-source-form";

export type Step = "upload" | "map" | "preview" | "commit" | "results";

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Map columns" },
  { key: "preview", label: "Validate & preview" },
  { key: "commit", label: "Commit" },
];

const ENTITY_MODULE: Record<string, string> = { property: "properties", person: "contacts", organization: "contacts" };

export function stepForJob(job?: ImportJobDetail | null): Step {
  if (!job) return "upload";
  if (job.status === "uploaded" || job.status === "mapped") return "map";
  if (job.status === "validated") return "preview";
  return "results";
}

/* ------------------------------------------------------------------ stepper */

export function Stepper({ current, reachable, onSelect }: { current: Step; reachable: Step[]; onSelect: (s: Step) => void }) {
  const order = STEPS.map((s) => s.key);
  const currentIndex = current === "results" ? STEPS.length : order.indexOf(current);
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-2">
      {STEPS.map((s, i) => {
        const done = i < currentIndex;
        const active = s.key === current;
        const clickable = reachable.includes(s.key) && !active;
        return (
          <li key={s.key} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-6 bg-line-strong" />}
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onSelect(s.key)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-sm",
                active ? "font-medium text-ink" : done ? "text-ink-2" : "text-ink-3",
                clickable && "hover:bg-muted",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-2xs font-semibold tabular",
                  active ? "border-ink bg-ink text-white" : done ? "border-positive bg-positive text-white" : "border-line-strong text-ink-3",
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              {s.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ 1 upload */

export function UploadStep() {
  const router = useRouter();
  const { can } = useAuth();
  const { data: sources = [], isLoading } = useDataSourceOptions();
  const upload = useUploadImport();
  const [entityType, setEntityType] = useState<EntityType>("property");
  const [sourceId, setSourceId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) {
      toast.error("Upload a CSV file");
      return;
    }
    setFile(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const submit = () => {
    if (!file || !sourceId) return;
    upload.mutate(
      { file, entityType, dataSourceId: sourceId },
      {
        onSuccess: (job) => {
          toast.success(`${pluralize(job.row_count, "row")} staged`);
          router.replace(`/imports/${job.id}`);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Card>
      <CardHeader title="Upload a file" description="Rows are staged only. Nothing is written to records until you commit." />
      <CardBody className="space-y-5">
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">What does this file contain?</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {ENTITY_TYPES.map((t) => {
              const allowed = can(ENTITY_MODULE[t], "create");
              return (
                <button
                  key={t}
                  type="button"
                  disabled={!allowed}
                  onClick={() => setEntityType(t)}
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-50",
                    entityType === t ? "border-ink bg-subtle font-medium text-ink" : "border-line text-ink-2 hover:bg-subtle",
                  )}
                >
                  {ENTITY_LABELS[t]}
                  {!allowed && <span className="block text-xs font-normal text-ink-3">No create permission</span>}
                </button>
              );
            })}
          </div>
        </div>

        <Field
          label="Data source"
          required
          hint={
            sources.length === 0 && !isLoading ? (
              <span className="text-caution">Register the provider and its license terms before importing its data.</span>
            ) : (
              "Imported values are recorded with this source as their provenance."
            )
          }
        >
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              placeholder={isLoading ? "Loading…" : "Select a licensed source"}
              options={sources.map((s) => ({ value: s.id, label: s.provider }))}
            />
            {can("imports", "create") && (
              <Button onClick={() => setAddingSource(true)}>New source</Button>
            )}
          </div>
        </Field>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => input.current?.click()}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
            dragging ? "border-accent bg-accent-soft/40" : "border-line-strong bg-subtle/50 hover:bg-subtle",
          )}
        >
          <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          {file ? (
            <>
              <FileSpreadsheet className="mb-2 size-6 text-ink-2" />
              <p className="text-sm font-medium text-ink">{file.name}</p>
              <p className="text-xs text-ink-3">{formatNumber(file.size / 1024, 1)} KB · click to choose a different file</p>
            </>
          ) : (
            <>
              <Upload className="mb-2 size-6 text-ink-3" />
              <p className="text-sm font-medium text-ink">Drop a CSV file here, or click to browse</p>
              <p className="text-xs text-ink-3">First row must contain column headers. Up to 10,000 rows and 15 MB.</p>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Link href="/imports">
            <Button>Cancel</Button>
          </Link>
          <Button variant="primary" disabled={!file || !sourceId} loading={upload.isPending} onClick={submit}>
            Upload & map columns
            <ArrowRight />
          </Button>
        </div>
      </CardBody>
      <DataSourceFormSheet open={addingSource} onOpenChange={setAddingSource} onSaved={(s) => s.is_active && setSourceId(s.id)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ 2 map */

export function MapStep({ job, onDone }: { job: ImportJobDetail; onDone: () => void }) {
  const { can } = useAuth();
  const [mapping, setMapping] = useState<Record<string, string | null>>(job.column_mapping);
  const saveMapping = useSaveMapping(job.id);
  const validate = useValidateImport(job.id);
  const editable = can("imports", "create");

  useEffect(() => setMapping(job.column_mapping), [job.column_mapping]);

  const used = new Set(Object.values(mapping).filter(Boolean) as string[]);
  const required = job.fields.filter((f) => f.required);
  const nameMapped = job.entity_type !== "person" || ["full_name", "first_name", "last_name"].some((k) => used.has(k));
  const missing = required.filter((f) => !used.has(f.key));
  const ready = missing.length === 0 && nameMapped;

  const choose = (header: string, key: string) => {
    setMapping((m) => {
      const next = { ...m };
      if (key) for (const h of Object.keys(next)) if (next[h] === key) next[h] = null;
      next[header] = key || null;
      return next;
    });
  };

  const run = async () => {
    try {
      await saveMapping.mutateAsync(mapping);
      const result = await validate.mutateAsync(undefined);
      toast.success(`Dry run complete · ${formatNumber(result.counts.valid ?? 0)} valid rows`);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const options = [
    { value: "", label: "Don't import" },
    ...job.fields.map((f) => ({ value: f.key, label: `${f.label}${f.required ? " *" : ""}` })),
  ];

  return (
    <Card>
      <CardHeader
        title="Map columns"
        description={`Match each column in ${job.filename} to a ${ENTITY_LABELS[job.entity_type]?.toLowerCase() ?? "record"} field. Suggestions come from the header names.`}
        actions={
          editable && (
            <Button size="sm" variant="ghost" onClick={() => setMapping(job.suggested_mapping)}>
              <RotateCcw />
              Reset to suggested
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5 text-xs">
        <span className="text-ink-3">Required:</span>
        {required.map((f) => (
          <Badge key={f.key} tone={used.has(f.key) ? "green" : "red"}>
            {used.has(f.key) ? <Check className="size-3" /> : <X className="size-3" />}
            {f.label}
          </Badge>
        ))}
        {job.entity_type === "person" && (
          <Badge tone={nameMapped ? "green" : "red"}>
            {nameMapped ? <Check className="size-3" /> : <X className="size-3" />}
            Full name or first/last name
          </Badge>
        )}
        <span className="ml-auto text-ink-3">{pluralize(used.size, "field")} mapped of {pluralize(job.headers.length, "column")}</span>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-ink-3">
              <th className="border-b border-line bg-subtle px-4 py-2">CSV column</th>
              <th className="border-b border-line bg-subtle px-3 py-2">Sample values</th>
              <th className="w-72 border-b border-line bg-subtle px-3 py-2">Imports into</th>
            </tr>
          </thead>
          <tbody>
            {job.headers.map((h) => {
              const samples = job.sample.map((r) => r[h]).filter((v) => v && v.trim()).slice(0, 3);
              const value = mapping[h] ?? "";
              const suggested = job.suggested_mapping[h];
              return (
                <tr key={h} className={cn(!value && "bg-subtle/40")}>
                  <td className="border-b border-line px-4 py-2 font-medium text-ink">{h}</td>
                  <td className="border-b border-line px-3 py-2">
                    {samples.length ? (
                      <div className="flex max-w-[420px] flex-wrap gap-1">
                        {samples.map((s, i) => (
                          <span key={i} className="max-w-[180px] truncate rounded bg-muted px-1.5 py-0.5 text-xs text-ink-2" title={s}>
                            {s}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-ink-3">Empty in sample</span>
                    )}
                  </td>
                  <td className="border-b border-line px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Select className="flex-1" value={value} disabled={!editable} onChange={(e) => choose(h, e.target.value)} options={options} />
                      {value && value === suggested && <Badge tone="sky">Suggested</Badge>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-xs text-ink-3">
          {ready ? "Validation is a dry run: it checks every row and previews duplicates without writing anything." : "Map the required fields to continue."}
        </p>
        <Button variant="primary" disabled={!ready || !editable} loading={saveMapping.isPending || validate.isPending} onClick={run}>
          Validate {formatNumber(job.row_count)} rows
          <ArrowRight />
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ rows table */

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return formatNumber(value, 2);
  return String(value);
}

const ROW_FILTERS: Record<"preview" | "results", string[]> = {
  preview: ["valid", "invalid", "duplicate"],
  results: ["created", "updated", "skipped", "invalid"],
};

export function ImportRowsTable({ job, mode }: { job: ImportJobDetail; mode: "preview" | "results" }) {
  const url = useUrlState();
  const status = url.get("row_status");
  const page = url.getNumber("row_page", 1);
  const pageSize = url.getNumber("row_page_size", 25);
  const rows = useImportRows(job.id, { status, page, page_size: pageSize, q: url.get("row_q") });

  const keyFields = useMemo(() => {
    const mapped = new Set(Object.values(job.column_mapping).filter(Boolean));
    return job.fields.filter((f) => mapped.has(f.key)).slice(0, 4);
  }, [job.column_mapping, job.fields]);

  const counts = job.counts as Record<string, number | undefined>;

  const columns: Column<ImportRow>[] = [
    { id: "row", header: "Row", align: "right", width: 60, cell: (r) => <span className="text-ink-3">{r.row_number}</span> },
    { id: "status", header: "Status", width: 110, cell: (r) => <StatusBadge status={r.status} /> },
    ...keyFields.map<Column<ImportRow>>((f) => {
      const header = Object.keys(job.column_mapping).find((h) => job.column_mapping[h] === f.key);
      return {
        id: f.key,
        header: f.label,
        cell: (r) => {
          const converted = r.mapped?.[f.key];
          const value = converted !== undefined ? display(converted) : display(header ? r.raw[header] : null);
          return (
            <span className={cn("block max-w-[220px] truncate", converted !== undefined ? "text-ink-2" : "text-ink-3")} title={value}>
              {value}
            </span>
          );
        },
      };
    }),
    {
      id: "issues",
      header: "Details",
      cell: (r) => {
        const link = r.created_entity_id ?? r.duplicate_of_id;
        return (
          <div className="min-w-[220px] space-y-0.5">
            {r.errors.map((e, i) => (
              <p key={i} className={cn("text-xs", r.status === "invalid" ? "text-negative" : "text-ink-2")}>
                {e.column && <span className="font-medium">{e.column}: </span>}
                {e.message}
              </p>
            ))}
            {r.previous_values && Object.keys(r.previous_values).length > 0 && (
              <p className="text-xs text-ink-2">Changed: {Object.keys(r.previous_values).map(titleCase).join(", ")}</p>
            )}
            {link && (
              <Link href={entityHref(job.entity_type, link)} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                {r.created_entity_id ? "Open record" : "View existing record"}
                <ExternalLink className="size-3" />
              </Link>
            )}
          </div>
        );
      },
    },
  ];

  const filters = ROW_FILTERS[mode];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        {[null, ...filters].map((s) => (
          <button
            key={s ?? "all"}
            type="button"
            onClick={() => url.set({ row_status: s, row_page: null })}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm",
              status === s ? "bg-muted font-medium text-ink" : "text-ink-2 hover:bg-muted/60",
            )}
          >
            {s ? titleCase(s) : "All rows"}
            <span className="text-xs text-ink-3 tabular">{formatNumber(s ? counts[s] ?? 0 : job.row_count)}</span>
          </button>
        ))}
      </div>
      <DataTable
        columns={columns}
        data={rows.data?.items}
        loading={rows.isLoading}
        fetching={rows.isFetching}
        dense
        rowClassName={(r) => (r.status === "invalid" ? "bg-negative-soft/30" : r.status === "duplicate" ? "bg-caution-soft/30" : undefined)}
        empty={<EmptyState title="No rows in this view" description="Choose another status filter." />}
      />
      <TableFooter
        page={page}
        pageSize={pageSize}
        total={rows.data?.total ?? 0}
        onPage={(p) => url.set({ row_page: p }, { resetPage: false })}
        onPageSize={(size) => url.set({ row_page_size: size, row_page: null })}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ 3 preview */

export function PreviewStep({ job, onBack, onNext }: { job: ImportJobDetail; onBack: () => void; onNext: () => void }) {
  const c = job.counts;
  const writable = (c.valid ?? 0) + (c.existing_duplicates ?? 0);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Rows in file" value={formatNumber(c.total ?? job.row_count)} hint={`Validated ${formatDate(job.validated_at)}`} />
        <StatCard label="Valid" value={formatNumber(c.valid ?? 0)} tone="positive" hint="Will be created on commit" />
        <StatCard label="Invalid" value={formatNumber(c.invalid ?? 0)} tone={(c.invalid ?? 0) > 0 ? "negative" : "default"} hint="Skipped; fix the file and re-import" />
        <StatCard
          label="Duplicates"
          value={formatNumber(c.duplicate ?? 0)}
          tone={(c.duplicate ?? 0) > 0 ? "caution" : "default"}
          hint={`${formatNumber(c.existing_duplicates ?? 0)} match existing · ${formatNumber(c.file_duplicates ?? 0)} repeated in file`}
        />
      </div>
      <ImportRowsTable job={job} mode="preview" />
      <div className="flex justify-between">
        <Button onClick={onBack}>
          <ArrowLeft />
          Back to mapping
        </Button>
        <Button variant="primary" disabled={writable === 0} onClick={onNext}>
          Continue to commit
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 4 commit */

export function CommitStep({ job, onBack, onDone }: { job: ImportJobDetail; onBack: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const module = ENTITY_MODULE[job.entity_type];
  const canUpdate = can(module, "edit");
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [confirming, setConfirming] = useState(false);
  const commit = useCommitImport(job.id);
  const c = job.counts;
  const existing = c.existing_duplicates ?? 0;
  const creates = c.valid ?? 0;
  const updates = mode === "update" ? existing : 0;

  const run = () =>
    commit.mutate(mode, {
      onSuccess: (r) => {
        setConfirming(false);
        if (r.status === "failed") toast.error(r.error ?? "Import failed");
        else toast.success(`Import committed · ${formatNumber(r.counts.created ?? 0)} created, ${formatNumber(r.counts.updated ?? 0)} updated`);
        onDone();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <Card>
      <CardHeader title="Commit import" description="Writes the validated rows to records. Every change is audited and can be rolled back." />
      <CardBody className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Will be created" value={formatNumber(creates)} />
          <StatCard label="Will be updated" value={formatNumber(updates)} />
          <StatCard label="Will be skipped" value={formatNumber((c.invalid ?? 0) + (c.file_duplicates ?? 0) + (existing - updates))} />
        </div>

        {existing > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-2">{pluralize(existing, "row")} match existing records. What should happen to them?</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { value: "skip", title: "Skip them", body: "Existing records are left untouched." },
                  { value: "update", title: "Update existing records", body: "Changed values are written as new sourced facts; prior values stay in history." },
                ] as const
              ).map((o) => {
                const disabled = o.value === "update" && !canUpdate;
                return (
                  <button
                    key={o.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => setMode(o.value)}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
                      mode === o.value ? "border-ink bg-subtle" : "border-line hover:bg-subtle",
                    )}
                  >
                    <p className="text-sm font-medium text-ink">{o.title}</p>
                    <p className="text-xs text-ink-3">{disabled ? "Requires edit permission" : o.body}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-line bg-subtle/60 p-3 text-sm text-ink-2">
          Values are recorded with source <span className="font-medium text-ink">{job.data_source_name ?? "—"}</span>, observed today, and
          stay <span className="font-medium text-ink">unverified</span> until someone verifies them in the data quality backlog.
        </div>

        <div className="flex justify-between">
          <Button onClick={onBack}>
            <ArrowLeft />
            Back to preview
          </Button>
          <Button variant="primary" disabled={creates + updates === 0} onClick={() => setConfirming(true)}>
            Commit import
          </Button>
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Commit this import?"
        description={`${pluralize(creates, "record")} will be created${updates ? ` and ${pluralize(updates, "record")} updated` : ""}. You can roll the import back afterwards.`}
        confirmLabel="Commit"
        loading={commit.isPending}
        onConfirm={run}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ results */

export function ResultsView({ job }: { job: ImportJobDetail }) {
  const { can } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const rollback = useRollbackImport(job.id);
  const c = job.counts;
  const canRollback = (job.status === "committed" || job.status === "failed") && can("imports", "edit") && can(ENTITY_MODULE[job.entity_type], "edit");

  const run = () =>
    rollback.mutate(undefined, {
      onSuccess: (r) => {
        setConfirming(false);
        toast.success(`Import rolled back · ${formatNumber(r.counts.reverted ?? 0)} records reverted`);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <div className="space-y-5">
      {job.status === "failed" && (
        <div className="flex gap-3 rounded-lg border border-negative/30 bg-negative-soft p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" />
          <div>
            <p className="font-medium text-negative">The import stopped before finishing</p>
            <p className="mt-0.5 text-ink-2">{job.error ?? "Unknown error"}. Rows written before the failure are listed below and can be rolled back.</p>
          </div>
        </div>
      )}
      {job.status === "rolled_back" && (
        <div className="rounded-lg border border-line bg-subtle/60 p-3 text-sm text-ink-2">
          Rolled back {formatDate(job.rolled_back_at)} · {pluralize(c.reverted ?? 0, "record")} reverted.
          {(c.rollback_conflicts ?? 0) > 0 && (
            <span className="text-caution"> {pluralize(c.rollback_conflicts ?? 0, "record")} had later edits that were kept (see row details).</span>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Created" value={formatNumber(c.created ?? 0)} tone="positive" />
        <StatCard label="Updated" value={formatNumber(c.updated ?? 0)} />
        <StatCard label="Skipped" value={formatNumber(c.skipped ?? 0)} hint="Duplicates and unchanged rows" />
        <StatCard label="Invalid" value={formatNumber(c.invalid ?? 0)} tone={(c.invalid ?? 0) > 0 ? "negative" : "default"} />
      </div>

      {canRollback && (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Roll back this import</p>
              <p className="text-xs text-ink-3">Archives created records and restores previous values on updated ones. Values edited since the import are kept.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              <RotateCcw />
              Roll back
            </Button>
          </CardBody>
        </Card>
      )}

      <ImportRowsTable job={job} mode="results" />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Roll back this import?"
        description={`${pluralize(c.created ?? 0, "created record")} will be archived and ${pluralize(c.updated ?? 0, "updated record")} restored to their previous values. This is audited and cannot be re-committed.`}
        confirmLabel="Roll back"
        destructive
        loading={rollback.isPending}
        onConfirm={run}
      />
    </div>
  );
}
