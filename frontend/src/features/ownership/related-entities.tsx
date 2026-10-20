"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { ConfidencePill } from "@/components/data/provenance";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { api, type Page } from "@/lib/api";
import { titleCase } from "@/lib/utils";

import { nodeHref, type Link as LinkT } from "./api";
import { relationPhrase } from "./link-sheet";

/** Entities and people related to a record through confirmed or suggested links. */
export function RelatedEntitiesCard({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["ownership", "links", "node", id],
    queryFn: () => api.get<Page<LinkT>>("/ownership/links", { node_id: id, status: ["confirmed", "suggested"], page_size: 50 }),
  });
  const links = data?.items ?? [];

  return (
    <Card>
      <CardHeader title="Related entities" description="Control and affiliation relationships" />
      <CardBody className="p-0">
        {isLoading ? (
          <Skeleton className="m-4 h-10" />
        ) : links.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-3">No related entities recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {links.map((l) => {
              const outgoing = l.from_id === id;
              const kind = outgoing ? l.to_kind : l.from_kind;
              const otherId = outgoing ? l.to_id : l.from_id;
              const label = outgoing ? l.to_label : l.from_label;
              return (
                <li key={l.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                  <Link href={nodeHref(kind, otherId)} className="min-w-0 flex-1 truncate font-medium text-ink hover:underline">{label ?? "—"}</Link>
                  <span className="text-xs text-ink-3">{outgoing ? `This ${relationPhrase(l.relationship)}` : titleCase(l.relationship)}</span>
                  <ConfidencePill value={l.confidence} />
                  {l.status === "suggested" && <Badge tone="amber">Suggested</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
