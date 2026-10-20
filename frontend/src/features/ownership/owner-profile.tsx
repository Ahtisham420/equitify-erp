"use client";

import { EyeOff, Lock, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState, FieldGrid, FieldItem, StatCard } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import { NOTE_CATEGORIES, nodeHref, useNoteMutations, useOwnerProfile, type OwnerKind, type OwnerNote, type PortfolioItem } from "./api";
import { EvidenceList } from "./evidence";
import { InterestSheet } from "./interest-sheet";
import { LinkSheet, relationPhrase } from "./link-sheet";

function portfolioColumns(showVia: boolean): Column<PortfolioItem & { id: string }>[] {
  const cols: Column<PortfolioItem & { id: string }>[] = [
    {
      id: "property",
      header: "Property",
      cell: (p) => (
        <div className="min-w-[200px]">
          <Link href={`/properties/${p.property_id}?tab=ownership`} className="font-medium text-ink hover:underline">{p.property_label}</Link>
          <p className="text-xs text-ink-3">{[p.city, p.state].filter(Boolean).join(", ") || "—"}{p.property_type ? ` · ${titleCase(p.property_type)}` : ""}</p>
        </div>
      ),
    },
    { id: "role", header: "Role", cell: (p) => <span className="text-ink-2">{titleCase(p.role)}</span> },
    { id: "pct", header: "Interest", align: "right", cell: (p) => formatPercent(p.interest_pct, 1) },
    { id: "period", header: "Held", cell: (p) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDate(p.effective_from)} – {p.effective_to ? formatDate(p.effective_to) : "present"}</span> },
    { id: "hold", header: "Years", align: "right", cell: (p) => formatNumber(p.hold_years, 1) },
    { id: "price", header: "Acquired", align: "right", cell: (p) => formatCurrency(p.acquired_price, { compact: true }) },
    { id: "fin", header: "Financing", cell: (p) => <span className="text-xs text-ink-2">{p.financing_type ? titleCase(p.financing_type) : "—"}</span> },
  ];
  if (showVia) {
    cols.splice(1, 0, {
      id: "via",
      header: "Through",
      cell: (p) => (p.via_id && p.via_kind ? <Link href={nodeHref(p.via_kind, p.via_id)} className="text-xs text-accent hover:underline">{p.via_label}</Link> : "—"),
    });
  }
  return cols;
}

const withId = (items: PortfolioItem[]) => items.map((p) => ({ ...p, id: p.interest_id }));

function NotesCard({ kind, id, notes, hidden }: { kind: OwnerKind; id: string; notes: OwnerNote[]; hidden: number }) {
  const { can } = useAuth();
  const m = useNoteMutations(kind, id);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ category: "preference", body: "", sensitive: false });

  return (
    <Card>
      <CardHeader
        title="Owner notes"
        description="Preferences, financing patterns, hold strategy, prior offers, advisors"
        actions={
          can("ownership", "edit") && (
            <Button size="xs" onClick={() => setOpen(true)}>
              <Plus className="!size-3.5" /> Add
            </Button>
          )
        }
      />
      <CardBody className="p-0">
        {notes.length === 0 && !hidden ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">No notes recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {notes.map((n) => (
              <li key={n.id} className="flex items-start gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Badge tone="outline">{titleCase(n.category)}</Badge>
                    {n.sensitive && (
                      <Badge tone="amber">
                        <Lock className="size-3" /> Sensitive · internal only
                      </Badge>
                    )}
                    <span className="text-xs text-ink-3">{formatRelative(n.created_at)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{n.body}</p>
                </div>
                {can("ownership", "edit") && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove note"
                    onClick={() => m.remove.mutate(n.id, { onSuccess: () => toast.success("Note removed"), onError: (e) => toast.error(errorMessage(e)) })}
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
            {hidden > 0 && (
              <li className="flex items-center gap-1.5 px-4 py-2 text-xs text-ink-3">
                <EyeOff className="size-3" /> {hidden} sensitive note{hidden === 1 ? "" : "s"} hidden for your role
              </li>
            )}
          </ul>
        )}
      </CardBody>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add owner note"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!form.body.trim()}
              loading={m.add.isPending}
              onClick={() =>
                m.add.mutate(
                  { category: form.category, body: form.body.trim(), sensitive: form.sensitive },
                  {
                    onSuccess: () => {
                      toast.success("Note added");
                      setOpen(false);
                      setForm({ category: "preference", body: "", sensitive: false });
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              Save note
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value, sensitive: f.sensitive || ["family", "circumstance"].includes(e.target.value) }))} options={NOTE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
          </Field>
          <Field label="Note"><Textarea rows={4} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} /></Field>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={form.sensitive} onChange={(v) => setForm((f) => ({ ...f, sensitive: v }))} />
            Sensitive personal circumstance — never included in exports or outbound messages
          </label>
          {["family", "advisor", "circumstance"].includes(form.category) && (
            <p className="text-xs text-ink-3">Record only information that was lawfully obtained.</p>
          )}
        </div>
      </Dialog>
    </Card>
  );
}

/** Owner portfolio, hold/financing patterns, control relationships, notes and counterparty performance. */
export function OwnerProfileView({ kind, id, showTitle }: { kind: OwnerKind; id: string; showTitle?: boolean }) {
  const { can } = useAuth();
  const { data: p, isLoading, error } = useOwnerProfile(kind, id);
  const [addingInterest, setAddingInterest] = useState(false);
  const [addingLink, setAddingLink] = useState(false);

  if (isLoading) return <Skeleton className="h-72 w-full" />;
  if (error || !p) return <EmptyState title="Owner profile unavailable" description={errorMessage(error)} />;

  const perf = p.performance;
  const financing = Object.entries(p.financing_patterns).sort((a, b) => b[1] - a[1]);
  const prefSummary = (p.preferences?.summary as string | undefined) || null;

  return (
    <div className="space-y-5">
      {showTitle && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <Link href={nodeHref(kind, id)} className="text-lg font-semibold text-ink hover:underline">{p.label}</Link>
            <p className="text-sm text-ink-2">
              {[p.subtitle ? titleCase(p.subtitle) : null, [p.city, p.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Current properties" value={formatNumber(p.current.length)} />
        <StatCard label="Prior properties" value={formatNumber(p.prior.length)} />
        <StatCard label="Typical hold" value={p.typical_hold_years != null ? `${formatNumber(p.typical_hold_years, 1)} yrs` : "—"} hint="Median of completed holds" />
        <StatCard label="Current hold (avg)" value={p.average_current_hold_years != null ? `${formatNumber(p.average_current_hold_years, 1)} yrs` : "—"} />
        <StatCard label="Acquired value" value={formatCurrency(p.total_acquired_value, { compact: true })} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Portfolio"
          description="Current interests"
          actions={
            can("ownership", "create") && (
              <Button size="xs" onClick={() => setAddingInterest(true)}>
                <Plus className="!size-3.5" /> Add interest
              </Button>
            )
          }
        />
        <DataTable columns={portfolioColumns(false)} data={withId(p.current)} dense empty={<EmptyState title="No current properties" />} />
      </Card>

      {p.controlled.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Controlled through entities" description="Current properties of entities this owner manages, is a member, officer or director of, or parents" />
          <DataTable columns={portfolioColumns(true)} data={withId(p.controlled)} dense />
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Prior properties" description="Ended interests are retained as history" />
        <DataTable columns={portfolioColumns(false)} data={withId(p.prior)} dense empty={<EmptyState title="No prior ownership recorded" />} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Control & affiliation"
            actions={
              can("ownership", "create") && (
                <Button size="xs" onClick={() => setAddingLink(true)}>
                  <Plus className="!size-3.5" /> Add
                </Button>
              )
            }
          />
          <CardBody className="p-0">
            {p.links.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">No relationships recorded.</p>
            ) : (
              <ul className="divide-y divide-line">
                {p.links.map((l) => {
                  const outgoing = l.from_id === id;
                  const otherKind = outgoing ? l.to_kind : l.from_kind;
                  const otherId = outgoing ? l.to_id : l.from_id;
                  const otherLabel = outgoing ? l.to_label : l.from_label;
                  return (
                    <li key={l.id} className="space-y-1.5 px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="text-ink-2">{outgoing ? relationPhrase(l.relationship) : `has ${titleCase(l.relationship).toLowerCase()}`}</span>
                        <Link href={nodeHref(otherKind, otherId)} className="font-medium text-ink hover:underline">{otherLabel ?? "—"}</Link>
                        <ConfidencePill value={l.confidence} />
                        {l.status === "suggested" ? <Badge tone="amber">Needs review</Badge> : <StatusBadge status="verified" label="Confirmed" />}
                        {l.effective_to && <Badge tone="outline">Ended {formatDate(l.effective_to)}</Badge>}
                      </div>
                      <EvidenceList items={l.evidence} hidden={l.hidden_evidence} compact />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Counterparty performance" />
          <CardBody className="space-y-4">
            <FieldGrid cols={2}>
              <FieldItem label="Last touch">{perf.last_touch_at ? formatRelative(perf.last_touch_at) : null}</FieldItem>
              <FieldItem label="Relationship">{p.relationship_strength ? titleCase(p.relationship_strength) : null}</FieldItem>
              <FieldItem label="Response rate">{perf.response_rate != null ? formatPercent(perf.response_rate * 100, 0) : null}</FieldItem>
              <FieldItem label="Close rate">{perf.close_rate != null ? formatPercent(perf.close_rate * 100, 0) : null}</FieldItem>
              <FieldItem label="Interactions">{`${perf.interactions} (${perf.inbound} inbound)`}</FieldItem>
              <FieldItem label="Deals">{`${perf.opportunities} · ${perf.won} won · ${perf.lost} lost`}</FieldItem>
            </FieldGrid>
            {Object.keys(perf.source_attribution).length > 0 && (
              <div>
                <p className="mb-1 text-xs text-ink-3">Source attribution</p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(perf.source_attribution).map(([s, c]) => (
                    <Badge key={s} tone="outline">{titleCase(s)} · {c}</Badge>
                  ))}
                </div>
              </div>
            )}
            <div>
              <p className="mb-1 text-xs text-ink-3">Financing patterns</p>
              {financing.length ? (
                <div className="flex flex-wrap gap-1">
                  {financing.map(([f, c]) => (
                    <Badge key={f} tone="outline">{titleCase(f)} · {c}</Badge>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-ink-3">—</span>
              )}
            </div>
            {prefSummary && (
              <div>
                <p className="mb-1 text-xs text-ink-3">Preferences</p>
                <p className="whitespace-pre-wrap text-sm text-ink-2">{prefSummary}</p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <NotesCard kind={kind} id={id} notes={p.notes} hidden={p.hidden_notes} />
        <Card>
          <CardHeader title="Prior deals & conversations" />
          <CardBody className="p-0">
            {p.opportunities.length === 0 && p.recent_interactions.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">No deals or conversations recorded.</p>
            ) : (
              <ul className="divide-y divide-line">
                {p.opportunities.map((o) => (
                  <li key={o.id} className="flex items-center gap-2 px-4 py-2">
                    <Link href={`/pipeline/${o.id}`} className="min-w-0 flex-1 truncate text-sm text-ink hover:underline">{o.title ?? "Opportunity"}</Link>
                    <StatusBadge status={o.stage} />
                  </li>
                ))}
                {p.recent_interactions.map((i) => (
                  <li key={i.id} className="px-4 py-2">
                    <div className="flex items-center gap-2 text-xs text-ink-3">
                      <Badge tone="outline">{titleCase(i.channel)}</Badge>
                      {titleCase(i.direction)}
                      <span className="ml-auto">{formatRelative(i.occurred_at)}</span>
                    </div>
                    {i.summary && <p className="mt-0.5 line-clamp-2 text-sm text-ink-2">{i.summary}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <InterestSheet open={addingInterest} onOpenChange={setAddingInterest} owner={{ kind, id }} />
      <LinkSheet open={addingLink} onOpenChange={setAddingLink} from={{ kind, id }} />
    </div>
  );
}
