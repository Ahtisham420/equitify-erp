"use client";

import { AlertTriangle, Check, MoreHorizontal, Network, Pencil, Plus, Square, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem } from "@/components/data/page";
import { ConfidencePill } from "@/components/data/provenance";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, Tooltip } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatNumber, formatPercent, titleCase } from "@/lib/utils";

import { nodeHref, useInterestMutations, usePropertyPanel, type Interest } from "./api";
import { EvidenceList } from "./evidence";
import { EndInterestDialog, InterestSheet } from "./interest-sheet";

function InterestActions({ i, onEdit, onEnd }: { i: Interest; onEdit: () => void; onEnd: () => void }) {
  const { can } = useAuth();
  const m = useInterestMutations();
  const verify = (state: "verified" | "rejected") =>
    m.verify.mutate({ id: i.id, state }, { onSuccess: () => toast.success(`Interest ${state}`), onError: (e) => toast.error(errorMessage(e)) });
  if (!can("ownership", "edit") && !can("ownership", "approve")) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Interest actions">
          <MoreHorizontal />
        </Button>
      </MenuTrigger>
      <MenuContent>
        {can("ownership", "edit") && (
          <MenuItem icon={<Pencil />} onSelect={onEdit}>
            Edit
          </MenuItem>
        )}
        {can("ownership", "edit") && i.is_current && (
          <MenuItem icon={<Square />} onSelect={onEnd}>
            End interest
          </MenuItem>
        )}
        {can("ownership", "approve") && i.verification !== "verified" && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Check />} onSelect={() => verify("verified")}>
              Mark verified
            </MenuItem>
          </>
        )}
        {can("ownership", "approve") && i.verification !== "rejected" && (
          <MenuItem icon={<X />} destructive onSelect={() => verify("rejected")}>
            Reject
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

/** Property ownership panel: current owners, history timeline, mismatch flags, hold period, control confidence. */
export function PropertyOwnershipTab({ propertyId }: { propertyId: string }) {
  const { can } = useAuth();
  const { data, isLoading, error } = usePropertyPanel(propertyId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Interest | null>(null);
  const [ending, setEnding] = useState<Interest | null>(null);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) return <EmptyState title="Ownership unavailable" description={errorMessage(error)} />;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Current owners"
              actions={
                can("ownership", "create") && (
                  <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus /> Add owner
                  </Button>
                )
              }
            />
            <CardBody className="p-0">
              {data.current_owners.length === 0 ? (
                <EmptyState icon={<Network />} title="No current owner recorded" description="Add the owner from a deed, tax roll or other source." />
              ) : (
                <ul className="divide-y divide-line">
                  {data.current_owners.map(({ interest: i, mailing_address, mailing_city, mailing_state, controllers }) => (
                    <li key={i.id} className="space-y-3 px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {i.owner_id ? (
                              <Link href={nodeHref(i.owner_kind, i.owner_id)} className="font-medium text-ink hover:underline">{i.owner_label ?? "—"}</Link>
                            ) : (
                              <span className="font-medium">{i.owner_label ?? "—"}</span>
                            )}
                            <Badge tone="outline">{titleCase(i.role)}</Badge>
                            {i.interest_pct != null && <span className="text-xs text-ink-2 tabular">{formatPercent(i.interest_pct, 1)}</span>}
                            <StatusBadge status={i.verification} />
                            {i.mismatch && (
                              <Tooltip content={`Owner mailing state (${i.owner_state}) differs from property state (${i.property_state})`}>
                                <span>
                                  <Badge tone="amber"><AlertTriangle className="size-3" /> Out-of-state owner</Badge>
                                </span>
                              </Tooltip>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-ink-3">
                            {[mailing_address ?? (data.masked ? "Mailing address restricted" : null), mailing_city, mailing_state].filter(Boolean).join(", ") || "No mailing address"}
                          </p>
                        </div>
                        <div className="text-right text-xs text-ink-3">
                          <p>Since {formatDate(i.effective_from)}</p>
                          {i.hold_years != null && <p className="tabular">{formatNumber(i.hold_years, 1)} yrs held</p>}
                        </div>
                        <InterestActions i={i} onEdit={() => setEditing(i)} onEnd={() => setEnding(i)} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
                        <span>Source: {i.source}</span>
                        <span className="flex items-center gap-1">Confidence <ConfidencePill value={i.confidence} /></span>
                        {i.acquired_price != null && <span>Acquired for {formatCurrency(i.acquired_price)}</span>}
                        {i.financing_type && <span>{titleCase(i.financing_type)}</span>}
                      </div>
                      <EvidenceList items={i.evidence} hidden={i.hidden_evidence} compact />
                      {controllers.length > 0 && (
                        <div className="rounded-md border border-line bg-subtle/50 px-3 py-2">
                          <p className="mb-1 text-xs font-medium text-ink-2">Controlled by</p>
                          <ul className="space-y-1">
                            {controllers.map((c) => (
                              <li key={c.link_id} className="flex items-center gap-2 text-sm">
                                <Link href={nodeHref(c.controller_kind, c.controller_id)} className="text-ink hover:underline">{c.controller_label ?? "—"}</Link>
                                <span className="text-xs text-ink-3">{titleCase(c.relationship)}</span>
                                <ConfidencePill value={c.confidence} />
                                {c.status === "suggested" && <Badge tone="amber">Needs review</Badge>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Ownership history" description="Time-bound interests; ended interests are retained" />
            <CardBody>
              {data.history.length === 0 ? (
                <p className="text-sm text-ink-3">No ownership recorded.</p>
              ) : (
                <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-line">
                  {data.history.map((i) => (
                    <li key={i.id} className="relative flex gap-3 pl-5">
                      <span className={cn("absolute left-0 top-1.5 size-[11px] rounded-full border-2 border-surface", i.is_current ? "bg-positive" : i.verification === "rejected" ? "bg-negative" : "bg-ink-3")} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className={cn("font-medium", i.verification === "rejected" ? "text-ink-3 line-through" : "text-ink")}>{i.owner_label ?? "—"}</span>
                          <span className="text-xs text-ink-3">{titleCase(i.role)}{i.interest_pct != null ? ` · ${formatPercent(i.interest_pct, 1)}` : ""}</span>
                          {i.is_current ? <Badge tone="green">Current</Badge> : <Badge tone="outline">Prior</Badge>}
                        </div>
                        <p className="text-xs text-ink-2">
                          {formatDate(i.effective_from)} – {i.effective_to ? formatDate(i.effective_to) : "present"}
                          {i.hold_years != null && ` · ${formatNumber(i.hold_years, 1)} yrs`}
                          {i.acquired_price != null && ` · bought ${formatCurrency(i.acquired_price, { compact: true })}`}
                          {i.disposed_price != null && ` · sold ${formatCurrency(i.disposed_price, { compact: true })}`}
                        </p>
                        {i.end_reason && <p className="text-xs text-ink-3">{i.end_reason}</p>}
                      </div>
                      <InterestActions i={i} onEdit={() => setEditing(i)} onEnd={() => setEnding(i)} />
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Ownership summary" />
          <CardBody>
            <FieldGrid cols={1}>
              <FieldItem label="Hold period">{data.hold_years != null ? `${formatNumber(data.hold_years, 1)} years` : null}</FieldItem>
              <FieldItem label="Acquired">
                {data.acquired_on ? `${formatDate(data.acquired_on)}${data.acquired_price != null ? ` · ${formatCurrency(data.acquired_price)}` : ""}` : null}
              </FieldItem>
              <FieldItem label="Mailing mismatch">
                {data.mismatch ? <Badge tone="amber">Owner mails outside {data.property_state ?? "property state"}</Badge> : data.current_owners.length ? "No" : null}
              </FieldItem>
              <FieldItem label="Controlling relationship confidence">
                {data.controlling_confidence != null ? <ConfidencePill value={data.controlling_confidence} /> : "No confirmed controller"}
              </FieldItem>
              {data.pending_suggestions > 0 && (
                <FieldItem label="Pending relationship suggestions">
                  <Link href="/ownership?tab=suggestions" className="text-accent hover:underline">{data.pending_suggestions} to review</Link>
                </FieldItem>
              )}
            </FieldGrid>
          </CardBody>
        </Card>
      </div>

      <InterestSheet open={adding} onOpenChange={setAdding} propertyId={propertyId} />
      <InterestSheet open={!!editing} onOpenChange={(o) => !o && setEditing(null)} interest={editing} />
      <EndInterestDialog interest={ending} onOpenChange={(o) => !o && setEnding(null)} />
    </div>
  );
}
