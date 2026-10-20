"use client";

import { Archive, ArrowDown, ArrowUp, ClipboardList, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber, formatRelative, titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from "@/features/properties/api";

import {
  CATEGORY_LABELS,
  WO_CATEGORIES,
  useArchiveTemplate,
  useInspectionTemplates,
  useSaveTemplate,
  type InspectionTemplate,
  type TemplateInput,
  type TemplateSection,
} from "./api";
import { toastApiError } from "./work-order-form";

/* ------------------------------------------------------------------ keys */

export function slugify(label: string, fallback = "item"): string {
  const s = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return s || fallback;
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key);
  return key;
}

/* ------------------------------------------------------------------ draft model */

let seq = 0;
const uid = () => `d${++seq}`;

interface DraftItem {
  uid: string;
  /** Existing key preserved on edit so earlier responses keep their meaning. */
  fixedKey: string | null;
  label: string;
  guidance: string;
  category: string;
}
interface DraftSection {
  uid: string;
  fixedKey: string | null;
  title: string;
  items: DraftItem[];
}

function toDraft(sections: TemplateSection[] | undefined): DraftSection[] {
  if (!sections?.length) return [{ uid: uid(), fixedKey: null, title: "General", items: [{ uid: uid(), fixedKey: null, label: "", guidance: "", category: "" }] }];
  return sections.map((s) => ({
    uid: uid(),
    fixedKey: s.key,
    title: s.title,
    items: s.items.map((i) => ({ uid: uid(), fixedKey: i.key, label: i.label, guidance: i.guidance ?? "", category: i.category ?? "" })),
  }));
}

/** Assigns final keys: preserved keys first, then slugs from labels, de-duplicated. */
function withKeys(draft: DraftSection[]): { sections: TemplateSection[]; itemKeys: Record<string, string>; sectionKeys: Record<string, string> } {
  const usedItems = new Set<string>();
  const usedSections = new Set<string>();
  const itemKeys: Record<string, string> = {};
  const sectionKeys: Record<string, string> = {};
  for (const s of draft) {
    if (s.fixedKey && !usedSections.has(s.fixedKey)) {
      usedSections.add(s.fixedKey);
      sectionKeys[s.uid] = s.fixedKey;
    }
    for (const i of s.items) {
      if (i.fixedKey && !usedItems.has(i.fixedKey)) {
        usedItems.add(i.fixedKey);
        itemKeys[i.uid] = i.fixedKey;
      }
    }
  }
  for (const s of draft) {
    if (!sectionKeys[s.uid]) sectionKeys[s.uid] = uniqueKey(slugify(s.title, "section"), usedSections);
    for (const i of s.items) {
      if (!itemKeys[i.uid]) itemKeys[i.uid] = uniqueKey(slugify(i.label), usedItems);
    }
  }
  const sections = draft.map((s) => ({
    key: sectionKeys[s.uid],
    title: s.title.trim(),
    items: s.items.map((i) => ({
      key: itemKeys[i.uid],
      label: i.label.trim(),
      guidance: i.guidance.trim() || null,
      category: i.category || null,
    })),
  }));
  return { sections, itemKeys, sectionKeys };
}

function validate(name: string, sections: TemplateSection[]): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push("Template name is required.");
  if (!sections.length) errors.push("Add at least one section.");
  let items = 0;
  const seen = new Set<string>();
  sections.forEach((s, si) => {
    if (!s.title) errors.push(`Section ${si + 1} needs a title.`);
    s.items.forEach((i, ii) => {
      items++;
      if (!i.label) errors.push(`${s.title || `Section ${si + 1}`}: item ${ii + 1} needs a label.`);
      if (seen.has(i.key)) errors.push(`Duplicate item key: ${i.key}`);
      seen.add(i.key);
    });
  });
  if (!items) errors.push("Add at least one checklist item.");
  return errors;
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/* ------------------------------------------------------------------ sheet */

function TemplateSheet({ open, onOpenChange, template }: { open: boolean; onOpenChange: (o: boolean) => void; template: InspectionTemplate | null }) {
  const [name, setName] = useState("");
  const [propertyType, setPropertyType] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [draft, setDraft] = useState<DraftSection[]>(() => toDraft(undefined));
  const [errors, setErrors] = useState<string[]>([]);
  const save = useSaveTemplate(template?.id);

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? "");
    setPropertyType(template?.property_type ?? "");
    setDescription(template?.description ?? "");
    setActive(template?.is_active ?? true);
    setDraft(toDraft(template?.sections));
    setErrors([]);
  }, [open, template]);

  const keyed = useMemo(() => withKeys(draft), [draft]);
  const itemTotal = draft.reduce((n, s) => n + s.items.length, 0);

  const updateSection = (uidValue: string, patch: Partial<DraftSection>) =>
    setDraft((d) => d.map((s) => (s.uid === uidValue ? { ...s, ...patch } : s)));
  const updateItem = (sectionUid: string, itemUid: string, patch: Partial<DraftItem>) =>
    setDraft((d) => d.map((s) => (s.uid === sectionUid ? { ...s, items: s.items.map((i) => (i.uid === itemUid ? { ...i, ...patch } : i)) } : s)));
  const addItem = (sectionUid: string) =>
    setDraft((d) => d.map((s) => (s.uid === sectionUid ? { ...s, items: [...s.items, { uid: uid(), fixedKey: null, label: "", guidance: "", category: "" }] } : s)));
  const removeItem = (sectionUid: string, itemUid: string) =>
    setDraft((d) => d.map((s) => (s.uid === sectionUid ? { ...s, items: s.items.filter((i) => i.uid !== itemUid) } : s)));
  const moveItem = (sectionUid: string, index: number, delta: number) =>
    setDraft((d) => d.map((s) => (s.uid === sectionUid ? { ...s, items: move(s.items, index, delta) } : s)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validate(name, keyed.sections);
    setErrors(found);
    if (found.length) return;
    const body: TemplateInput = {
      name: name.trim(),
      property_type: propertyType || null,
      description: description.trim() || null,
      sections: keyed.sections,
      is_active: active,
    };
    save.mutate(body, {
      onSuccess: (t) => {
        toast.success(template ? (t.version !== template.version ? `Template updated to v${t.version}` : "Template updated") : "Template created");
        onOpenChange(false);
      },
      onError: (err) => toastApiError(err),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      title={template ? `Edit ${template.name}` : "New inspection template"}
      description={
        template
          ? `Currently v${template.version}. Changing sections or items publishes a new version; inspections already created keep the version they started with.`
          : "Checklist used for field inspections. Item keys are generated from labels."
      }
      footer={
        <>
          <span className="mr-auto self-center text-xs text-ink-3 tabular">
            {draft.length} section{draft.length === 1 ? "" : "s"} · {itemTotal} item{itemTotal === 1 ? "" : "s"}
          </span>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="template-form" loading={save.isPending}>
            {template ? "Save template" : "Create template"}
          </Button>
        </>
      }
    >
      <form id="template-form" onSubmit={submit} className="space-y-5">
        {errors.length > 0 && (
          <div className="rounded-lg border border-negative/30 bg-negative-soft p-3 text-sm">
            <p className="font-medium text-negative">Fix these before saving</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
              {errors.map((er) => (
                <li key={er}>{er}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required htmlFor="tpl-name" className="col-span-2">
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="e.g. Retail center quarterly walk" />
          </Field>
          <Field label="Property type" htmlFor="tpl-type" hint="Leave as any type to offer it for every property">
            <Select
              id="tpl-type"
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value)}
              placeholder="Any type"
              options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] ?? titleCase(t) }))}
            />
          </Field>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={active} onChange={setActive} />
              Active — available for new inspections
            </label>
          </div>
          <Field label="Description" htmlFor="tpl-description" className="col-span-2">
            <Textarea id="tpl-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-3">
          {draft.map((s, si) => (
            <section key={s.uid} className="rounded-lg border border-line bg-subtle/40">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <span className="text-xs font-medium text-ink-3 tabular">{si + 1}</span>
                <Input
                  aria-label="Section title"
                  value={s.title}
                  onChange={(e) => updateSection(s.uid, { title: e.target.value })}
                  placeholder="Section title"
                  maxLength={160}
                  className="flex-1 font-medium"
                />
                <Button size="icon-sm" variant="ghost" aria-label="Move section up" disabled={si === 0} onClick={() => setDraft((d) => move(d, si, -1))}>
                  <ArrowUp />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Move section down" disabled={si === draft.length - 1} onClick={() => setDraft((d) => move(d, si, 1))}>
                  <ArrowDown />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Remove section" onClick={() => setDraft((d) => d.filter((x) => x.uid !== s.uid))}>
                  <Trash2 />
                </Button>
              </div>
              <div className="space-y-2 p-3">
                {s.items.length === 0 && <p className="text-xs text-ink-3">No items in this section yet.</p>}
                {s.items.map((i, ii) => (
                  <div key={i.uid} className="rounded-md border border-line bg-surface p-2.5">
                    <div className="flex items-start gap-2">
                      <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
                        <Input
                          aria-label="Item label"
                          value={i.label}
                          onChange={(e) => updateItem(s.uid, i.uid, { label: e.target.value })}
                          placeholder="Checklist item, e.g. Exit signs illuminated"
                          maxLength={200}
                          className="sm:col-span-2"
                        />
                        <Select
                          aria-label="Item category"
                          value={i.category}
                          onChange={(e) => updateItem(s.uid, i.uid, { category: e.target.value })}
                          placeholder="No category"
                          options={WO_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? titleCase(c) }))}
                        />
                        <Input
                          aria-label="Guidance"
                          value={i.guidance}
                          onChange={(e) => updateItem(s.uid, i.uid, { guidance: e.target.value })}
                          placeholder="Guidance for the inspector (optional)"
                          className="sm:col-span-3"
                        />
                      </div>
                      <div className="flex shrink-0 flex-col gap-0.5">
                        <Button size="icon-sm" variant="ghost" aria-label="Move item up" disabled={ii === 0} onClick={() => moveItem(s.uid, ii, -1)}>
                          <ArrowUp />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Move item down" disabled={ii === s.items.length - 1} onClick={() => moveItem(s.uid, ii, 1)}>
                          <ArrowDown />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Remove item" onClick={() => removeItem(s.uid, i.uid)}>
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                    <p className="mt-1.5 font-mono text-2xs text-ink-3">key: {keyed.itemKeys[i.uid]}</p>
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={() => addItem(s.uid)}>
                  <Plus /> Add item
                </Button>
              </div>
            </section>
          ))}
          <Button size="sm" onClick={() => setDraft((d) => [...d, { uid: uid(), fixedKey: null, title: "", items: [{ uid: uid(), fixedKey: null, label: "", guidance: "", category: "" }] }])}>
            <Plus /> Add section
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ tab */

export function InspectionTemplatesTab() {
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const { data, isLoading, isFetching } = useInspectionTemplates(q ? { q } : {});
  const [editing, setEditing] = useState<InspectionTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<InspectionTemplate | null>(null);
  const archive = useArchiveTemplate();

  const doArchive = () => {
    if (!archiving) return;
    archive.mutate(archiving.id, {
      onSuccess: () => {
        toast.success("Template archived");
        setArchiving(null);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const columns: Column<InspectionTemplate>[] = [
    {
      id: "name",
      header: "Template",
      cell: (t) => (
        <div className="min-w-[200px] max-w-[360px]">
          <p className="truncate font-medium text-ink">{t.name}</p>
          {t.description && <p className="truncate text-xs text-ink-3">{t.description}</p>}
        </div>
      ),
    },
    {
      id: "type",
      header: "Property type",
      cell: (t) => (t.property_type ? <Badge tone="outline">{PROPERTY_TYPE_LABELS[t.property_type] ?? titleCase(t.property_type)}</Badge> : <span className="text-ink-3">Any type</span>),
    },
    { id: "version", header: "Version", align: "right", cell: (t) => `v${t.version}` },
    { id: "sections", header: "Sections", align: "right", cell: (t) => formatNumber(t.sections.length) },
    { id: "items", header: "Items", align: "right", cell: (t) => formatNumber(t.item_count) },
    { id: "active", header: "Status", cell: (t) => <StatusBadge status={t.is_active ? "active" : "inactive"} /> },
    { id: "updated", header: "Updated", cell: (t) => <span className="whitespace-nowrap text-xs text-ink-3">{formatRelative(t.updated_at)}</span> },
    {
      id: "actions",
      header: "",
      align: "right",
      width: 48,
      cell: (t) =>
        can("maintenance", "edit") || can("maintenance", "delete") ? (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Template actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {can("maintenance", "edit") && (
                  <MenuItem icon={<Pencil />} onSelect={() => setEditing(t)}>
                    Edit template
                  </MenuItem>
                )}
                {can("maintenance", "delete") && (
                  <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(t)}>
                    Archive
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-ink-2">Checklists by property type. Inspections snapshot the template version they were created from.</p>
        {can("maintenance", "create") && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New template
          </Button>
        )}
      </div>
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Search templates…" shortcut={false} className="w-64" />
      </Toolbar>
      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={data}
          loading={isLoading}
          fetching={isFetching}
          onRowClick={can("maintenance", "edit") ? (t) => setEditing(t) : undefined}
          empty={
            <EmptyState
              icon={<ClipboardList />}
              title={q ? "No templates match" : "No inspection templates yet"}
              description="Templates define the sections and items inspectors check on site."
              action={
                can("maintenance", "create") && !q ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus /> New template
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Card>

      <TemplateSheet
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false);
            setEditing(null);
          }
        }}
        template={editing}
      />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this template?"
        description="It will no longer be offered for new inspections. Existing inspections keep their checklist."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={doArchive}
      />
    </div>
  );
}
