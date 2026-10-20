"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter } from "@/components/data/filters";
import { EmptyState } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";

import { fromLocalInput } from "@/features/tasks/api";

import { CHANNEL_LABELS, CHANNELS, EVENT_LABELS, useConsent, useOptOut, useSuppress, type ConsentEvent } from "./api";

function ChannelValue({ channel, value, onChannel, onValue }: { channel: string; value: string; onChannel: (v: string) => void; onValue: (v: string) => void }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2">
      <Field label="Channel">
        <Select value={channel} onChange={(e) => onChannel(e.target.value)} options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
      </Field>
      <Field label={channel === "email" ? "Email address" : "Phone number"} required>
        <Input value={value} onChange={(e) => onValue(e.target.value)} />
      </Field>
    </div>
  );
}

function OptOutCard({ initial }: { initial: { channel: string; value: string } }) {
  const [channel, setChannel] = useState(initial.channel);
  const [value, setValue] = useState(initial.value);
  const [source, setSource] = useState("");
  const [evidence, setEvidence] = useState("");
  const optOut = useOptOut();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    optOut.mutate(
      { channel, value: value.trim(), source: source.trim(), evidence: evidence.trim() || null },
      {
        onSuccess: (r) => {
          toast.success(`Opt-out recorded · ${r.propagated} other contact point(s) suppressed · ${r.enrollments_exited} sequence(s) exited`);
          setValue("");
          setSource("");
          setEvidence("");
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };
  return (
    <Card>
      <CardHeader title="Record opt-out" description="Takes effect immediately on every channel for the person and exits active sequences." />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <ChannelValue channel={channel} value={value} onChannel={setChannel} onValue={setValue} />
          <Field label="Source" required hint="Where the request came from, e.g. “Verbal on call”, “Reply STOP”">
            <Input value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
          <Field label="Evidence">
            <Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={2} />
          </Field>
          <Button type="submit" variant="danger" loading={optOut.isPending} disabled={value.trim().length < 3 || source.trim().length < 2}>
            Record opt-out
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function ConsentCard({ initial }: { initial: { channel: string; value: string } }) {
  const { can } = useAuth();
  const [channel, setChannel] = useState(initial.channel);
  const [value, setValue] = useState(initial.value);
  const [state, setState] = useState<"granted" | "revoked">("granted");
  const [source, setSource] = useState("");
  const [evidence, setEvidence] = useState("");
  const [lift, setLift] = useState(false);
  const consent = useConsent();
  const approver = can("compliance", "approve");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    consent.mutate(
      { channel, value: value.trim(), state, source: source.trim(), evidence: evidence.trim() || null, lift_suppression: lift },
      {
        onSuccess: () => {
          toast.success(state === "granted" ? "Consent recorded" : "Consent revoked");
          setValue("");
          setSource("");
          setEvidence("");
          setLift(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };
  return (
    <Card>
      <CardHeader title="Record consent" description="Consent events are permanent. Reversing an opt-out or suppression requires approval and evidence." />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <ChannelValue channel={channel} value={value} onChannel={setChannel} onValue={setValue} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Consent">
              <Select value={state} onChange={(e) => setState(e.target.value as "granted" | "revoked")} options={[{ value: "granted", label: "Granted" }, { value: "revoked", label: "Revoked" }]} />
            </Field>
            <Field label="Source" required>
              <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Signed web form" />
            </Field>
          </div>
          <Field label="Evidence" required={lift} hint={lift ? "Required: describe the recorded consent (document, recording, form id)." : undefined}>
            <Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={2} />
          </Field>
          {state === "granted" && (
            <label className="flex items-start gap-2 text-sm text-ink-2">
              <Checkbox checked={lift} onChange={setLift} className="mt-0.5" />
              <span>
                Lift existing suppression / opt-out for this value
                {!approver && <span className="block text-xs text-caution">Requires compliance approval permission.</span>}
              </span>
            </label>
          )}
          <Button type="submit" variant="primary" loading={consent.isPending} disabled={value.trim().length < 3 || source.trim().length < 2 || (lift && (!approver || evidence.trim().length < 10))}>
            Record consent
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function SuppressCard({ initial }: { initial: { channel: string; value: string } }) {
  const [channel, setChannel] = useState(initial.channel);
  const [value, setValue] = useState(initial.value);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const suppress = useSuppress();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    suppress.mutate(
      { channel, value: value.trim(), reason: reason.trim(), until: fromLocalInput(until) },
      {
        onSuccess: () => {
          toast.success("Value suppressed");
          setValue("");
          setReason("");
          setUntil("");
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };
  return (
    <Card>
      <CardHeader title="Internal suppression" description="Blocks outreach to a value without a consent change." />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <ChannelValue channel={channel} value={value} onChannel={setChannel} onValue={setValue} />
          <Field label="Reason" required>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Until" hint="Leave empty for indefinite">
            <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          <Button type="submit" loading={suppress.isPending} disabled={value.trim().length < 3 || reason.trim().length < 2}>
            Suppress
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

const eventColumns: Column<ConsentEvent>[] = [
  { id: "when", header: "When", cell: (e) => <span className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(e.occurred_at)}</span> },
  {
    id: "event",
    header: "Event",
    cell: (e) => (
      <Badge tone={e.event_type === "consent_granted" || e.event_type === "suppression_lifted" ? "green" : e.event_type === "dnc_scrubbed" ? "sky" : "red"}>
        {EVENT_LABELS[e.event_type] ?? e.event_type}
      </Badge>
    ),
  },
  { id: "value", header: "Value", cell: (e) => <span className="text-ink">{e.normalized_value} <span className="text-xs text-ink-3">· {e.channel}</span></span> },
  { id: "source", header: "Source", cell: (e) => <span className="text-ink-2">{e.source ?? "—"}</span> },
  { id: "evidence", header: "Evidence", cell: (e) => <p className="line-clamp-2 max-w-[320px] text-xs text-ink-2">{e.evidence ?? "—"}</p> },
  { id: "actor", header: "By", cell: (e) => <span className="text-ink-2">{e.actor_name ?? "System"}</span> },
];

function EventsLog() {
  const [page, setPage] = useState(1);
  const [types, setTypes] = useState<string[]>([]);
  const { data, isLoading } = useQuery({
    queryKey: ["compliance", "events", page, types],
    queryFn: () => api.get<Page<ConsentEvent>>("/compliance/events", { page, page_size: 25, event_type: types }),
  });
  return (
    <Card>
      <CardHeader
        title="Consent & opt-out history"
        description="Immutable log of every consent, opt-out and suppression change."
        actions={<FacetFilter label="Event" options={Object.entries(EVENT_LABELS).map(([value, label]) => ({ value, label }))} selected={types} onChange={(v) => { setTypes(v); setPage(1); }} />}
      />
      <DataTable columns={eventColumns} data={data?.items} loading={isLoading} empty={<EmptyState title="No consent events yet" />} />
      <TableFooter page={page} pageSize={25} total={data?.total ?? 0} onPage={setPage} />
    </Card>
  );
}

export function ConsentTab() {
  const { can } = useAuth();
  const url = useUrlState();
  const initial = { channel: url.get("channel") ?? "phone", value: url.get("value") ?? "" };
  const canOptOut = can("compliance", "edit") || can("outreach", "create");
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-5 lg:grid-cols-3">
        {canOptOut && <OptOutCard initial={initial} />}
        {can("compliance", "edit") && <ConsentCard initial={initial} />}
        {canOptOut && <SuppressCard initial={initial} />}
      </div>
      <EventsLog />
    </div>
  );
}
