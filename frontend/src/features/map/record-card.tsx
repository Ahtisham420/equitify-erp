"use client";

import { ExternalLink, Layers, Link2, Plus, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatCurrency, formatDate, formatNumber, formatPercent, formatRelative, titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";

import { useRecordCard, type AssemblageResult, type FeatureProps } from "@/features/map/api";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="truncate text-right text-ink tabular">{children}</span>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Map record card: property facts, owners, open opportunity and active signals for the clicked feature. */
export function RecordCardPanel({
  feature,
  onClose,
  onAddToSelection,
  onAssemblage,
  onAdjacent,
  assemblage,
  assemblageLoading,
}: {
  feature: FeatureProps;
  onClose: () => void;
  onAddToSelection: (propertyId: string) => void;
  onAssemblage: (parcelId: string) => void;
  onAdjacent: (parcelId: string) => void;
  assemblage: AssemblageResult | null;
  assemblageLoading: boolean;
}) {
  const { can } = useAuth();
  const target = feature.kind === "territory" ? null : { kind: feature.kind, id: feature.id };
  const { data: card, isLoading, error } = useRecordCard(target);

  if (feature.kind === "territory") {
    return (
      <Shell title={feature.label} subtitle="Territory" onClose={onClose}>
        <div className="space-y-1 px-4 pb-3">
          <Row label="Rule">{titleCase(String(feature.status ?? ""))}</Row>
          <Row label="Visibility">{titleCase(String(feature.visibility ?? ""))}</Row>
          <Row label="Members">{formatNumber(Number(feature.member_count ?? 0))}</Row>
        </div>
        <Footer>
          <Link href={`/territories/${feature.id}`} className="text-sm font-medium text-accent hover:underline">
            Open territory
          </Link>
        </Footer>
      </Shell>
    );
  }

  const p = card?.property;
  const parcel = card?.parcel;
  const title = p?.label ?? parcel?.situs_address ?? (parcel ? `APN ${parcel.apn}` : card?.comp?.label) ?? feature.label;

  return (
    <Shell title={title} subtitle={titleCase(feature.kind)} onClose={onClose}>
      {isLoading && (
        <div className="space-y-2 px-4 pb-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {error && <p className="px-4 pb-4 text-sm text-negative">{errorMessage(error)}</p>}

      {card && (
        <>
          {p && (
            <div className="px-4 pb-3">
              <p className="truncate text-sm text-ink-2">{[p.address_line, p.city, p.state].filter(Boolean).join(", ")}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusBadge status={p.status} />
                <Badge tone="outline">{PROPERTY_TYPE_LABELS[p.property_type] ?? titleCase(p.property_type)}</Badge>
              </div>
              <div className="mt-2.5">
                <Row label="Building">{p.building_area_sf ? `${formatNumber(p.building_area_sf)} SF` : "—"}</Row>
                <Row label="Land">{p.land_area_acres ? `${formatNumber(p.land_area_acres, 2)} ac` : "—"}</Row>
                <Row label="Asking">{formatCurrency(p.asking_price, { compact: true })}</Row>
                <Row label="Occupancy">{formatPercent(p.occupancy_pct, 0)}</Row>
              </div>
            </div>
          )}

          {card.comp && (
            <div className="px-4 pb-3">
              <p className="truncate text-sm text-ink-2">{[card.comp.address_line, card.comp.city, card.comp.state].filter(Boolean).join(", ")}</p>
              <div className="mt-2">
                <Row label="Sold">{formatDate(card.comp.sale_date)}</Row>
                <Row label="Price">{formatCurrency(card.comp.sale_price)}</Row>
                <Row label="Price / SF">{formatCurrency(card.comp.price_psf)}</Row>
                <Row label="Cap rate">{formatPercent(card.comp.cap_rate, 2)}</Row>
                <Row label="Verification"><StatusBadge status={card.comp.verification_status} /></Row>
              </div>
            </div>
          )}

          {card.observation && (
            <Section title="Field observation">
              <div className="flex items-center gap-2">
                <Badge tone="sky">{titleCase(card.observation.category)}</Badge>
                <span className="text-xs text-ink-3">{formatRelative(card.observation.observed_at)}{card.observation.created_by_name ? ` · ${card.observation.created_by_name}` : ""}</span>
              </div>
              {card.observation.note && <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink">{card.observation.note}</p>}
              {card.observation.photo_document_ids.length > 0 && (
                <p className="mt-1 text-xs text-ink-3">{card.observation.photo_document_ids.length} photo(s) in Documents</p>
              )}
            </Section>
          )}

          {parcel && (
            <Section title="Parcel">
              <Row label="APN">{parcel.apn}</Row>
              <Row label="County">{[parcel.county, parcel.state].filter(Boolean).join(", ")}</Row>
              <Row label="Acreage">{formatNumber(parcel.acreage, 2)}</Row>
            </Section>
          )}

          {card.owners !== null && p && (
            <Section title="Owners">
              {card.owners.length === 0 ? (
                <p className="text-sm text-ink-3">No current owner on record</p>
              ) : (
                <ul className="space-y-1">
                  {card.owners.map((o) => (
                    <li key={`${o.kind}-${o.id}`} className="flex items-center justify-between gap-2 text-sm">
                      <Link href={o.kind === "person" ? `/people/${o.id}` : `/organizations/${o.id}`} className="truncate text-ink hover:underline">
                        {o.name ?? "Unnamed"}
                      </Link>
                      <span className="shrink-0 text-xs text-ink-3">
                        {titleCase(o.role)}
                        {o.interest_pct != null ? ` · ${formatPercent(o.interest_pct, 0)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {card.opportunity && (
            <Section title="Opportunity">
              <Link href={`/pipeline/${card.opportunity.id}`} className="block truncate text-sm font-medium text-ink hover:underline">
                {card.opportunity.title}
              </Link>
              <div className="mt-1 flex items-center gap-2">
                <StatusBadge status={card.opportunity.stage} />
                {card.opportunity.next_action && <span className="truncate text-xs text-ink-3">Next: {card.opportunity.next_action}</span>}
              </div>
            </Section>
          )}

          {card.signals && card.signals.length > 0 && (
            <Section
              title="Signals"
              action={card.motivation_index != null ? <span className="text-xs text-ink-2 tabular">Motivation {formatNumber(card.motivation_index, 0)}</span> : undefined}
            >
              <ul className="space-y-1">
                {card.signals.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink">{s.title ?? titleCase(s.signal_type)}</span>
                    <Badge tone={s.severity >= 4 ? "red" : s.severity >= 3 ? "amber" : "neutral"}>
                      {titleCase(s.category)} · {s.severity}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {card.parcels.length > 0 && !parcel && (
            <Section title="Parcels">
              <p className="text-sm text-ink">{card.parcels.map((x) => x.apn).join(", ")}</p>
            </Section>
          )}

          {(parcel || card.parcels.length > 0) && can("parcels") && (
            <Section title="Assemblage">
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" loading={assemblageLoading} onClick={() => onAssemblage(parcel?.id ?? card.parcels[0].id)}>
                  <Layers /> Find contiguous, same owner
                </Button>
                <Button size="xs" onClick={() => onAdjacent(parcel?.id ?? card.parcels[0].id)}>
                  Show adjacent
                </Button>
              </div>
              {assemblage && (
                <div className="mt-2 text-sm">
                  {assemblage.result.owners_hidden ? (
                    <p className="text-ink-3">Ownership is hidden for your role.</p>
                  ) : assemblage.result.groups.length === 0 ? (
                    <p className="text-ink-3">No contiguous parcels share an owner.</p>
                  ) : (
                    assemblage.result.groups.map((g, i) => (
                      <p key={i} className="text-ink">
                        {g.owner.name ?? "Owner"}: {g.parcels.length} parcels · {formatNumber(g.total_acreage, 2)} ac
                      </p>
                    ))
                  )}
                </div>
              )}
            </Section>
          )}

          {card.viewer_links.length > 0 && (
            <Section title="External viewers">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {card.viewer_links.map((l) => (
                  <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                    {l.label}
                    <ExternalLink className="size-3" />
                  </a>
                ))}
              </div>
              <p className="mt-1 text-2xs text-ink-3">Convenience links only. Geometry on this map comes from the system of record.</p>
            </Section>
          )}

          <Footer>
            {p && (
              <Link href={`/properties/${p.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                <Link2 className="size-3.5" /> Open property
              </Link>
            )}
            {!p && parcel && (
              <Link href={`/parcels/${parcel.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                <Link2 className="size-3.5" /> Open parcel
              </Link>
            )}
            {p && (
              <Button size="sm" onClick={() => onAddToSelection(p.id)}>
                <Plus /> Add to selection
              </Button>
            )}
          </Footer>
        </>
      )}
    </Shell>
  );
}

function Shell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="flex max-h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop animate-pop-in">
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <p className="text-2xs font-medium uppercase tracking-wide text-ink-3">{subtitle}</p>
          <p className="truncate text-sm font-semibold text-ink">{title}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close card" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-2 border-t border-line bg-subtle/60 px-4 py-2.5">{children}</div>;
}
