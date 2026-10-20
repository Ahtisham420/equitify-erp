"use client";

import { ArrowRight, Building2, Network, Route } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";

import { EmptyState } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";

import { OwnerPicker } from "@/features/contacts/pickers";

import { nodeHref, useWarmPaths, type OwnerKind, type WarmPath } from "./api";
import { OwnerProfileView } from "./owner-profile";

function PathView({ path }: { path: WarmPath }) {
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {path.steps.map((s, i) => (
          <Fragment key={`${s.kind}-${s.id}`}>
            <Link
              href={nodeHref(s.kind, s.id)}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 font-medium text-ink hover:bg-subtle"
            >
              {s.kind === "property" && <Building2 className="size-3 text-ink-3" />}
              {s.label}
            </Link>
            {i < path.steps.length - 1 && (
              <span className="flex items-center gap-1 text-xs text-ink-3">
                {s.relation_to_next}
                <ArrowRight className="size-3" />
              </span>
            )}
          </Fragment>
        ))}
      </div>
      <p className="text-xs text-ink-3">
        {path.length} hop{path.length === 1 ? "" : "s"}
        {path.start_reason ? ` · start: ${path.start_reason}` : ""}
      </p>
    </div>
  );
}

function WarmPaths({ kind, id }: { kind: OwnerKind; id: string }) {
  const [fromKind, setFromKind] = useState<OwnerKind>("person");
  const [fromId, setFromId] = useState<string | null>(null);
  const [depth, setDepth] = useState("3");
  const { data, isLoading, error } = useWarmPaths({
    target_kind: kind,
    target_id: id,
    from_kind: fromId ? fromKind : undefined,
    from_id: fromId ?? undefined,
    max_depth: Number(depth),
  });

  return (
    <Card>
      <CardHeader
        title="Warm introduction paths"
        description="Through confirmed relationships, organization roles and shared ownership. Without a starting contact, paths begin at people and organizations the team already knows."
      />
      <CardBody className="space-y-3 border-b border-line">
        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <Field label="Start from (optional)">
            <OwnerPicker kind={fromKind} onKindChange={setFromKind} value={fromId} onChange={setFromId} />
          </Field>
          <Field label="Max hops">
            <Select value={depth} onChange={(e) => setDepth(e.target.value)} options={["1", "2", "3", "4"].map((d) => ({ value: d, label: d }))} />
          </Field>
        </div>
      </CardBody>
      <div className="divide-y divide-line">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : error ? (
          <p className="px-4 py-6 text-sm text-negative">{errorMessage(error)}</p>
        ) : !data?.length ? (
          <EmptyState icon={<Route />} title="No warm path found" description="Confirm more relationships or widen the hop limit." />
        ) : (
          data.map((p, i) => <PathView key={i} path={p} />)
        )}
      </div>
    </Card>
  );
}

/** Pick a person or organization to see its control relationships, portfolio and warm paths. */
export function EntityExplorer() {
  const url = useUrlState();
  const kind = (url.get("kind") as OwnerKind | null) ?? "organization";
  const id = url.get("id");

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Person or organization" className="min-w-[320px] flex-1">
            <OwnerPicker kind={kind} onKindChange={(k) => url.set({ kind: k, id: null })} value={id} onChange={(v) => url.set({ id: v })} />
          </Field>
          {id && (
            <Link href={nodeHref(kind, id)}>
              <Button>Open record</Button>
            </Link>
          )}
        </CardBody>
      </Card>

      {!id ? (
        <Card>
          <EmptyState
            icon={<Network />}
            title="Choose an owner to explore"
            description="See who controls it, what it owns now and before, how long it holds, and the warmest path to reach it."
          />
        </Card>
      ) : (
        <>
          <OwnerProfileView kind={kind} id={id} showTitle />
          <WarmPaths kind={kind} id={id} />
        </>
      )}
    </div>
  );
}
