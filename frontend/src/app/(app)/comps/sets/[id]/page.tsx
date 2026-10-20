"use client";

import { Archive, CheckCircle2, FileText, Lock, MoreHorizontal, Pencil, Plus, RotateCcw, Scale, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Checkbox, Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber, titleCase, toNumber } from "@/lib/utils";

import { AdjustmentGrid } from "@/features/comps/adjustment-grid";
import {
  BASIS_LABELS,
  LEASE_BASES,
  SALE_BASES,
  VALUATION_METHOD_LABELS,
  formatMetric,
  useAddSetItems,
  useBovs,
  useCompSet,
  useGenerateBov,
  useUpdateCompSet,
  useValuationFromSet,
  type CompSet,
  type Valuation,
} from "@/features/comps/api";
import { CandidateSearchDialog } from "@/features/comps/candidate-search";
import { ValueRange } from "@/features/comps/value-range";
import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

const today = () => new Date().toISOString().slice(0, 10);

function EditSetDialog({ set, open, onOpenChange }: { set: CompSet; open: boolean; onOpenChange: (o: boolean) => void }) {
  const update = useUpdateCompSet(set.id);
  const [s, setS] = useState({ name: set.name, value_basis: set.value_basis, qty: String(set.subject_quantity ?? ""), qtySource: set.subject_quantity_source ?? "", notes: set.notes ?? "" });
  useEffect(() => {
    if (open) setS({ name: set.name, value_basis: set.value_basis, qty: String(set.subject_quantity ?? ""), qtySource: set.subject_quantity_source ?? "", notes: set.notes ?? "" });
  }, [open, set]);
  const bases = set.kind === "sale" ? SALE_BASES : LEASE_BASES;
  const qtyLabel = s.value_basis === "cap_rate" ? "Subject NOI ($)" : s.value_basis === "price_per_acre" ? "Subject acres" : s.value_basis === "price" ? "Quantity (1)" : "Subject SF";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit comp set"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                {
                  name: s.name.trim(),
                  value_basis: s.value_basis,
                  ...(s.value_basis === set.value_basis || s.qty.trim() !== String(set.subject_quantity ?? "") ? { subject_quantity: toNumber(s.qty), subject_quantity_source: s.qtySource || null } : {}),
                  notes: s.notes || null,
                },
                { onSuccess: () => { toast.success("Comp set updated"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input value={s.name} onChange={(e) => setS((x) => ({ ...x, name: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Value basis" hint="Changing the basis re-reads the subject quantity from the property unless you enter one.">
            <Select value={s.value_basis} onChange={(e) => setS((x) => ({ ...x, value_basis: e.target.value }))} options={bases.map((b) => ({ value: b, label: BASIS_LABELS[b] }))} />
          </Field>
          <Field label={qtyLabel}>
            <Input inputMode="decimal" value={s.qty} onChange={(e) => setS((x) => ({ ...x, qty: e.target.value }))} />
          </Field>
        </div>
        <Field label="Subject quantity source">
          <Input value={s.qtySource} onChange={(e) => setS((x) => ({ ...x, qtySource: e.target.value }))} placeholder="e.g. Rent roll dated 2026-09-30" />
        </Field>
        <Field label="Notes">
          <Textarea value={s.notes} onChange={(e) => setS((x) => ({ ...x, notes: e.target.value }))} />
        </Field>
      </div>
    </Dialog>
  );
}

function ValuationsForSet({ setId }: { setId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["valuations", "list", "set", setId],
    queryFn: () => api.get<Page<Valuation>>("/valuations", { comp_set_id: setId, page_size: 50, sort: "-as_of" }),
  });
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.items.length) return <EmptyState icon={<Scale />} title="No valuations from this set" description="Save a dated sales-comparison valuation or portfolio mark from the indicated range." />;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {data.items.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <div>
              <p className="font-medium text-ink">
                {formatCurrency(v.value_low, { compact: true })} – {formatCurrency(v.value_high, { compact: true })}
                <span className="ml-2 text-ink-2">point {formatCurrency(v.value_point, { compact: true })}</span>
              </p>
              <p className="text-xs text-ink-3">{[VALUATION_METHOD_LABELS[v.method], `as of ${formatDate(v.as_of)}`, v.analyst_name].filter(Boolean).join(" · ")}</p>
            </div>
            {v.is_mark && <Badge tone="blue">Portfolio mark</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function BovsForSet({ setId }: { setId: string }) {
  const { data, isLoading } = useBovs({ comp_set_id: setId, page_size: 50 });
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.items.length) return <EmptyState icon={<FileText />} title="No BOVs from this set" description="Generate a broker opinion of value from the same comps and adjustments." />;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {data.items.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <div>
              <Link href={`/comps/bov/${b.id}`} className="font-medium text-ink hover:underline">{b.title}</Link>
              <p className="text-xs text-ink-3">{[b.prepared_for, b.prepared_by_name, formatDate(b.generated_at)].filter(Boolean).join(" · ")}</p>
            </div>
            <StatusBadge status={b.status === "draft" ? "draft" : "completed"} label={titleCase(b.status)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CompSetDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: set, isLoading, error } = useCompSet(id);
  const update = useUpdateCompSet(id);
  const addItems = useAddSetItems(id);
  const fromSet = useValuationFromSet(id);
  const genBov = useGenerateBov(id);
  const [finding, setFinding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [valuing, setValuing] = useState(false);
  const [val, setVal] = useState({ as_of: today(), is_mark: false, notes: "" });
  const [bovOpen, setBovOpen] = useState(false);
  const [bov, setBov] = useState({ title: "", prepared_for: "", price: "", narrative: "" });
  const tab = url.get("tab") ?? "grid";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !set) {
    return <EmptyState title="Comp set not found" description={errorMessage(error)} action={<Link href="/comps?tab=sets"><Button>Back to comp sets</Button></Link>} />;
  }

  const editable = can("comps", "edit") && set.status === "draft";
  const ind = set.indicated ?? {};
  const included = set.items.filter((i) => i.included);
  const subject = set.subject ?? {};
  const qtyLabel = set.value_basis === "cap_rate" ? "Subject NOI" : set.value_basis === "price_per_acre" ? "Subject acres" : set.value_basis === "price" ? "Quantity" : "Subject SF";

  const archive = async () => {
    try {
      await api.delete(`/comp-sets/${id}`);
      toast.success("Comp set archived");
      router.replace("/comps?tab=sets");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Comparables", href: "/comps" }, { label: "Comp sets", href: "/comps?tab=sets" }, { label: set.name }]}
        title={set.name}
        meta={
          <>
            <Badge tone="outline">{set.kind === "sale" ? "Sale comps" : "Lease comps"}</Badge>
            {set.status === "final" ? (
              <Badge tone="green"><Lock className="size-3" /> Final</Badge>
            ) : (
              <StatusBadge status="draft" />
            )}
            <span className="text-xs text-ink-3">{BASIS_LABELS[set.value_basis] ?? titleCase(set.value_basis)}</span>
            {set.subject_property_id && (
              <Link href={`/properties/${set.subject_property_id}?tab=comps`} className="text-xs text-accent hover:underline">
                Subject: {set.subject_label}
              </Link>
            )}
          </>
        }
        actions={
          <>
            {editable && (
              <Button onClick={() => setFinding(true)}>
                <Search /> Find candidates
              </Button>
            )}
            {can("comps", "create") && set.kind === "sale" && (
              <Button onClick={() => { setVal({ as_of: today(), is_mark: false, notes: "" }); setValuing(true); }} disabled={ind.value_point == null}>
                <Scale /> Save valuation
              </Button>
            )}
            {can("comps", "create") && (
              <Button variant="primary" onClick={() => { setBov({ title: `Broker opinion of value — ${set.subject_label ?? set.name}`, prepared_for: "", price: "", narrative: "" }); setBovOpen(true); }} disabled={ind.value_point == null}>
                <FileText /> Generate BOV
              </Button>
            )}
            {can("comps", "edit") && (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {set.status === "draft" && <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>Edit set</MenuItem>}
                  {set.status === "draft" ? (
                    <MenuItem icon={<CheckCircle2 />} onSelect={() => update.mutate({ status: "final" }, { onSuccess: () => toast.success("Comp set finalized"), onError: (e) => toast.error(errorMessage(e)) })}>
                      Mark final
                    </MenuItem>
                  ) : (
                    <MenuItem icon={<RotateCcw />} onSelect={() => update.mutate({ status: "draft" }, { onSuccess: () => toast.success("Reopened as draft"), onError: (e) => toast.error(errorMessage(e)) })}>
                      Reopen as draft
                    </MenuItem>
                  )}
                  {can("comps", "delete") && <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>Archive set</MenuItem>}
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={set.kind === "sale" ? "Indicated value range" : "Indicated market rent"} description={ind.method ?? "Weighted mean of adjusted comps; range is the min–max adjusted comp"} />
          <CardBody className="space-y-4">
            {set.kind === "sale" ? (
              <ValueRange
                low={ind.value_low}
                high={ind.value_high}
                point={ind.value_point}
                marks={included.map((i) => ({ label: String(i.comp.label ?? "Comp"), value: i.adjusted_value }))}
              />
            ) : (
              <ValueRange
                low={ind.metric_low}
                high={ind.metric_high}
                point={ind.metric_point}
                marks={included.map((i) => ({ label: String(i.comp.label ?? "Comp"), value: i.adjusted_metric }))}
                format={(v) => formatMetric(v, set.value_basis)}
              />
            )}
            <div className="grid grid-cols-3 gap-3 border-t border-line pt-3 text-xs">
              <div>
                <p className="text-ink-3">{BASIS_LABELS[set.value_basis]} range</p>
                <p className="font-medium text-ink tabular">{formatMetric(ind.metric_low, set.value_basis)} – {formatMetric(ind.metric_high, set.value_basis)}</p>
              </div>
              <div>
                <p className="text-ink-3">Weighted point</p>
                <p className="font-medium text-ink tabular">{formatMetric(ind.metric_point, set.value_basis)}</p>
              </div>
              <div>
                <p className="text-ink-3">Comps used</p>
                <p className="font-medium text-ink tabular">{ind.count ?? 0} of {set.items.length}</p>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Subject" />
          <CardBody>
            <FieldGrid cols={2}>
              <FieldItem label="Property" className="col-span-2">{String(subject.name || subject.address_line || "—")}</FieldItem>
              <FieldItem label="Type">{subject.property_type ? PROPERTY_TYPE_LABELS[String(subject.property_type)] ?? titleCase(String(subject.property_type)) : "—"}</FieldItem>
              <FieldItem label="Location">{[subject.city, subject.state].filter(Boolean).join(", ") || "—"}</FieldItem>
              <FieldItem label="Building SF">{formatNumber(subject.building_area_sf as number | null)}</FieldItem>
              <FieldItem label="Acres">{formatNumber(subject.land_area_acres as number | null, 2)}</FieldItem>
              <FieldItem label="NOI">{formatCurrency(subject.noi as number | null)}</FieldItem>
              <FieldItem label="Year built">{subject.year_built ? String(subject.year_built) : "—"}</FieldItem>
              <FieldItem label={qtyLabel} className="col-span-2" extra={set.subject_quantity_source ? <span className="text-ink-3">· {set.subject_quantity_source}</span> : undefined}>
                {set.value_basis === "cap_rate" ? formatCurrency(set.subject_quantity) : formatNumber(set.subject_quantity, 2)}
              </FieldItem>
            </FieldGrid>
          </CardBody>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "grid" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "grid", label: "Adjustment grid", count: set.items.length },
            { value: "valuations", label: "Valuations" },
            { value: "bovs", label: "BOVs" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <TabPanel value="grid">
          {set.status === "final" && <p className="mb-3 text-xs text-ink-3">This set is final. Reopen it as draft to change comps or adjustments.</p>}
          <AdjustmentGrid set={set} editable={editable} />
          {editable && set.items.length === 0 && (
            <div className="mt-3 flex justify-center">
              <Button variant="primary" onClick={() => setFinding(true)}>
                <Plus /> Add comps
              </Button>
            </div>
          )}
        </TabPanel>
        <TabPanel value="valuations">
          <ValuationsForSet setId={id} />
        </TabPanel>
        <TabPanel value="bovs">
          <BovsForSet setId={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="comp_set" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <CandidateSearchDialog
        open={finding}
        onOpenChange={setFinding}
        compSetId={id}
        kind={set.kind}
        subjectPropertyId={set.subject_property_id}
        loading={addItems.isPending}
        onConfirm={(ids) =>
          addItems.mutate(ids, {
            onSuccess: () => { toast.success(`${ids.length} comps added`); setFinding(false); },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
      <EditSetDialog set={set} open={editing} onOpenChange={setEditing} />
      <Dialog
        open={valuing}
        onOpenChange={setValuing}
        title="Save sales-comparison valuation"
        description={`${formatCurrency(ind.value_low, { compact: true })} – ${formatCurrency(ind.value_high, { compact: true })}, point ${formatCurrency(ind.value_point, { compact: true })}. Included comps are stored as evidence.`}
        footer={
          <>
            <Button onClick={() => setValuing(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={fromSet.isPending}
              onClick={() =>
                fromSet.mutate(
                  { as_of: val.as_of, is_mark: val.is_mark, notes: val.notes || null },
                  { onSuccess: () => { toast.success(val.is_mark ? "Portfolio mark recorded" : "Valuation saved"); setValuing(false); url.set({ tab: "valuations" }); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="As of" required>
            <Input type="date" value={val.as_of} onChange={(e) => setVal((v) => ({ ...v, as_of: e.target.value }))} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={val.is_mark} onChange={(c) => setVal((v) => ({ ...v, is_mark: c }))} />
            Record as portfolio value mark
          </label>
          <Field label="Notes">
            <Textarea rows={2} value={val.notes} onChange={(e) => setVal((v) => ({ ...v, notes: e.target.value }))} />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={bovOpen}
        onOpenChange={setBovOpen}
        title="Generate broker opinion of value"
        description="The BOV snapshots this comp set, its adjustments and the indicated range."
        footer={
          <>
            <Button onClick={() => setBovOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!bov.title.trim()}
              loading={genBov.isPending}
              onClick={() =>
                genBov.mutate(
                  { title: bov.title.trim(), prepared_for: bov.prepared_for || null, recommended_list_price: toNumber(bov.price), narrative: bov.narrative || null },
                  { onSuccess: (b) => { toast.success("BOV generated"); router.push(`/comps/bov/${b.id}`); }, onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              Generate
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Title" required>
            <Input value={bov.title} onChange={(e) => setBov((b) => ({ ...b, title: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Prepared for">
              <Input value={bov.prepared_for} onChange={(e) => setBov((b) => ({ ...b, prepared_for: e.target.value }))} placeholder="Owner name" />
            </Field>
            <Field label="Recommended list price">
              <Input inputMode="decimal" value={bov.price} onChange={(e) => setBov((b) => ({ ...b, price: e.target.value }))} />
            </Field>
          </div>
          <Field label="Narrative">
            <Textarea rows={4} value={bov.narrative} onChange={(e) => setBov((b) => ({ ...b, narrative: e.target.value }))} placeholder="Market context and pricing rationale" />
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog open={archiving} onOpenChange={setArchiving} title="Archive this comp set?" description="Valuations and BOVs created from it are retained." confirmLabel="Archive" destructive onConfirm={archive} />
    </>
  );
}

export default function CompSetPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <CompSetDetail id={params.id} />
    </Suspense>
  );
}
