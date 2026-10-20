"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, MessageSquarePlus, Pencil, Route, Trash2, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { EmptyState, FieldGrid, FieldItem, PageHeader, StatCard } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatDateTime, formatNumber } from "@/lib/utils";

import { INTEREST_LEVELS, label, opts, useMutate } from "@/features/brokerage/api";
import { RecordSheet, State, party } from "@/features/brokerage/ui";
import { OrganizationPicker, PersonPicker } from "@/features/contacts/pickers";
import { TOUR_STATUSES, type Feedback, type Participant, type Stop, type Tour } from "@/features/dealroom/api";
import { TOUR_FIELDS } from "@/features/dealroom/tours-tab";

const KEY = "dealroom";

function FeedbackDialog({ tour, stop, open, onOpenChange }: { tour: Tour; stop: Stop | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [person, setPerson] = useState<string | null>(tour.client_person_id);
  const save = useMutate((body: Record<string, unknown>) => api.post(`/tours/${tour.id}/feedback`, body), [KEY, "brokerage", "tasks"]);
  const set = (k: string) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Feedback${stop ? `: ${stop.property_label ?? "stop"}` : ""}`}
      description="A follow-up task is created automatically and the showing is recorded on the listing."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  stop_id: stop?.id ?? null,
                  person_id: person,
                  rating: v.rating ? Number(v.rating) : null,
                  interest_level: v.interest_level || null,
                  feedback: v.feedback || null,
                  objections: v.objections || null,
                  next_action: v.next_action || null,
                  next_action_at: v.next_action_at ? new Date(v.next_action_at).toISOString() : null,
                },
                {
                  onSuccess: () => {
                    toast.success("Feedback saved; follow-up task created");
                    onOpenChange(false);
                    setV({});
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Save feedback
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="From" className="col-span-2">
          <PersonPicker value={person} onChange={setPerson} />
        </Field>
        <Field label="Interest">
          <Select value={v.interest_level ?? ""} onChange={set("interest_level")} options={opts(INTEREST_LEVELS)} placeholder="—" />
        </Field>
        <Field label="Rating (1–5)">
          <Select value={v.rating ?? ""} onChange={set("rating")} options={["1", "2", "3", "4", "5"].map((n) => ({ value: n, label: n }))} placeholder="—" />
        </Field>
        <Field label="Feedback" className="col-span-2">
          <Textarea value={v.feedback ?? ""} onChange={set("feedback")} />
        </Field>
        <Field label="Objections" className="col-span-2">
          <Textarea rows={2} value={v.objections ?? ""} onChange={set("objections")} />
        </Field>
        <Field label="Next action">
          <Input value={v.next_action ?? ""} onChange={set("next_action")} placeholder="Follow up with client" />
        </Field>
        <Field label="Due">
          <Input type="datetime-local" value={v.next_action_at ?? ""} onChange={set("next_action_at")} />
        </Field>
      </div>
    </Dialog>
  );
}

function ParticipantDialog({ tour, open, onOpenChange }: { tour: Tour; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [kind, setKind] = useState<Participant["kind"]>("external");
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const save = useMutate((participants: Participant[]) => api.patch(`/tours/${tour.id}`, { participants }), [KEY]);
  const add = async () => {
    let display = name.trim();
    if (!display && id && kind !== "external") {
      const path = kind === "person" ? `/people/${id}` : kind === "organization" ? `/organizations/${id}` : null;
      if (path) {
        const rec = await api.get<{ full_name?: string; name?: string }>(path).catch(() => null);
        display = rec?.full_name ?? rec?.name ?? "";
      }
    }
    if (!display) {
      toast.error("Name is required");
      return;
    }
    save.mutate([...tour.participants, { kind, id, name: display, email: email || null, role: role || null }], {
      onSuccess: () => {
        onOpenChange(false);
        setName("");
        setEmail("");
        setRole("");
        setId(null);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add participant"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={add}>
            Add
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <Select value={kind} onChange={(e) => { setKind(e.target.value as Participant["kind"]); setId(null); }} options={[{ value: "external", label: "External" }, { value: "person", label: "Contact" }, { value: "organization", label: "Organization" }]} />
        </Field>
        <Field label="Role">
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Decision maker" />
        </Field>
        {kind === "person" && (
          <Field label="Contact" className="col-span-2">
            <PersonPicker value={id} onChange={setId} />
          </Field>
        )}
        {kind === "organization" && (
          <Field label="Organization" className="col-span-2">
            <OrganizationPicker value={id} onChange={setId} />
          </Field>
        )}
        <Field label="Name" hint={kind !== "external" ? "Defaults to the selected record" : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function TourDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const tour = useQuery({ queryKey: [KEY, "tour", id], queryFn: () => api.get<Tour>(`/tours/${id}`) });
  const stops = useQuery({ queryKey: [KEY, "stops", id], queryFn: () => api.get<Stop[]>(`/tours/${id}/stops`) });
  const feedback = useQuery({ queryKey: [KEY, "feedback", id], queryFn: () => api.get<Feedback[]>(`/tours/${id}/feedback`) });
  const [editing, setEditing] = useState(false);
  const [participant, setParticipant] = useState(false);
  const [fbStop, setFbStop] = useState<Stop | null | undefined>(undefined);
  const update = useMutate((body: Record<string, unknown>) => api.patch(`/tours/${id}`, body), [KEY]);
  const optimize = useMutate(() => api.post<{ total_distance_miles: number; unlocated: number }>(`/tours/${id}/optimize`), [KEY]);
  const addStop = useMutate((property_id: string) => api.post(`/tours/${id}/stops`, { property_id }), [KEY]);
  const patchStop = useMutate(({ sid, body }: { sid: string; body: Record<string, unknown> }) => api.patch(`/tour-stops/${sid}`, body), [KEY]);
  const removeStop = useMutate((sid: string) => api.delete(`/tour-stops/${sid}`), [KEY]);
  const editable = can("dealroom", "edit");

  if (tour.isLoading) return <Skeleton className="h-64 w-full" />;
  if (tour.error || !tour.data) return <EmptyState title="Tour not found" description={errorMessage(tour.error)} action={<Link href="/tours"><Button>Back to tours</Button></Link>} />;
  const t = tour.data;
  const rows = stops.data ?? [];
  const err = (e: unknown) => toast.error(errorMessage(e));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Tours", href: "/tours" }, { label: t.title }]}
        title={t.title}
        description={[formatDate(t.scheduled_on, "EEEE, MMM d, yyyy"), t.start_time, party(t)].filter(Boolean).join(" · ")}
        meta={
          <>
            <State value={t.status} />
            {t.agent_name && <span className="text-xs text-ink-3">Agent: {t.agent_name}</span>}
          </>
        }
        actions={
          editable && (
            <>
              <Select value={t.status} onChange={(e) => update.mutate({ status: e.target.value }, { onError: err })} options={opts(TOUR_STATUSES)} className="w-36" />
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </>
          )
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Stops" value={rows.length} />
        <StatCard label="Route distance" value={t.total_distance_miles != null ? `${formatNumber(t.total_distance_miles, 1)} mi` : "—"} hint={t.optimized_at ? `Optimized ${formatDateTime(t.optimized_at)}` : "Not optimized"} />
        <StatCard label="Participants" value={t.participants.length} />
        <StatCard label="Feedback captured" value={feedback.data?.length ?? 0} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader
              title="Itinerary"
              description={t.start_label ? `Starting from ${t.start_label}` : "Ordered by nearest-neighbour route over property coordinates"}
              actions={
                editable && (
                  <Button
                    size="sm"
                    loading={optimize.isPending}
                    onClick={() =>
                      optimize.mutate(undefined, {
                        onSuccess: (r) => toast.success(`Route optimized: ${formatNumber(r.total_distance_miles, 1)} mi${r.unlocated ? `; ${r.unlocated} stop(s) without coordinates placed last` : ""}`),
                        onError: err,
                      })
                    }
                  >
                    <Route /> Optimize route
                  </Button>
                )
              }
            />
            {rows.length === 0 ? (
              <EmptyState title="No stops yet" description="Add properties to build the itinerary." />
            ) : (
              <ol className="divide-y divide-line">
                {rows.map((s, i) => (
                  <li key={s.id} className={cn("flex items-start gap-3 px-4 py-3", s.status === "skipped" && "opacity-60")}>
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-white tabular">{s.sequence}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/properties/${s.property_id}`} className="font-medium text-ink hover:underline">
                          {s.property_label}
                        </Link>
                        <State value={s.status} />
                        {s.listing_id && (
                          <Link href={`/listings/${s.listing_id}`}>
                            <Badge tone="amber">Listed</Badge>
                          </Link>
                        )}
                        {!s.has_location && <Badge tone="outline">No coordinates</Badge>}
                      </div>
                      <p className="text-xs text-ink-3">{s.address}</p>
                      <p className="mt-0.5 text-xs text-ink-2">
                        {s.distance_from_prev_miles != null ? `${formatNumber(s.distance_from_prev_miles, 1)} mi from ${i === 0 ? "start" : "previous stop"}` : i === 0 ? "First stop" : "Distance unknown"}
                        {s.arrive_time && ` · arrive ${s.arrive_time}`} · {s.duration_minutes} min
                      </p>
                      {s.access_notes && <p className="mt-0.5 text-xs text-ink-2">{s.access_notes}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {can("dealroom", "edit") && (
                        <Button size="xs" onClick={() => setFbStop(s)}>
                          <MessageSquarePlus className="!size-3.5" /> Feedback
                        </Button>
                      )}
                      {editable && (
                        <>
                          <select
                            value={s.status}
                            onChange={(e) => patchStop.mutate({ sid: s.id, body: { status: e.target.value } }, { onError: err })}
                            className="h-6 rounded border border-line-strong/80 bg-surface px-1 text-xs"
                            aria-label="Stop status"
                          >
                            {["planned", "visited", "skipped"].map((x) => (
                              <option key={x} value={x}>
                                {label(x)}
                              </option>
                            ))}
                          </select>
                          <Button size="icon-sm" variant="ghost" disabled={i === 0} aria-label="Move up" onClick={() => patchStop.mutate({ sid: s.id, body: { sequence: s.sequence - 1 } }, { onError: err })}>
                            <ArrowUp />
                          </Button>
                          <Button size="icon-sm" variant="ghost" disabled={i === rows.length - 1} aria-label="Move down" onClick={() => patchStop.mutate({ sid: s.id, body: { sequence: s.sequence + 1 } }, { onError: err })}>
                            <ArrowDown />
                          </Button>
                          <Button size="icon-sm" variant="ghost" aria-label="Remove stop" onClick={() => removeStop.mutate(s.id, { onError: err })}>
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {editable && (
              <div className="border-t border-line p-3">
                <PropertyPicker value={null} onChange={(pid) => pid && addStop.mutate(pid, { onSuccess: () => toast.success("Stop added"), onError: err })} placeholder="Add a property stop…" />
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Showing feedback" actions={editable && <Button size="sm" onClick={() => setFbStop(null)}><MessageSquarePlus /> Capture feedback</Button>} />
            {!feedback.data?.length ? (
              <EmptyState title="No feedback yet" description="Capture reactions per stop; each one creates a follow-up task." />
            ) : (
              <ul className="divide-y divide-line">
                {feedback.data.map((f) => (
                  <li key={f.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{f.property_label ?? "Property"}</span>
                      {f.interest_level && <State value={f.interest_level} text={`${label(f.interest_level)} interest`} />}
                      {f.rating != null && <Badge tone="outline">{f.rating}/5</Badge>}
                      <span className="ml-auto text-xs text-ink-3">{f.person_label ?? ""} · {formatDateTime(f.created_at)}</span>
                    </div>
                    {f.feedback && <p className="mt-1 text-sm text-ink-2">{f.feedback}</p>}
                    {f.objections && <p className="mt-0.5 text-xs text-ink-2">Objections: {f.objections}</p>}
                    <p className="mt-1 text-xs text-ink-3">
                      Follow-up: {f.next_action ?? "Follow up with client"}
                      {f.next_action_at ? ` · due ${formatDate(f.next_action_at)}` : ""}
                      {f.follow_up_task_id ? " · task created" : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Participants" actions={editable && <Button size="xs" onClick={() => setParticipant(true)}><UserPlus className="!size-3.5" /> Add</Button>} />
            <CardBody>
              {!t.participants.length ? (
                <p className="text-sm text-ink-3">No participants recorded.</p>
              ) : (
                <ul className="space-y-2">
                  {t.participants.map((p, i) => (
                    <li key={`${p.name}-${i}`} className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm text-ink">
                          {p.kind === "person" && p.id ? <Link href={`/people/${p.id}`} className="hover:underline">{p.name}</Link> : p.kind === "organization" && p.id ? <Link href={`/organizations/${p.id}`} className="hover:underline">{p.name}</Link> : p.name}
                        </p>
                        <p className="text-xs text-ink-3">{[p.role, p.email, label(p.kind)].filter(Boolean).join(" · ")}</p>
                      </div>
                      {editable && (
                        <Button size="icon-sm" variant="ghost" aria-label="Remove participant" onClick={() => update.mutate({ participants: t.participants.filter((_, j) => j !== i) }, { onError: err })}>
                          <X />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <FieldGrid cols={1}>
                <FieldItem label="Client">{party(t)}</FieldItem>
                <FieldItem label="Starting point">{t.start_label ?? (t.start_lat != null ? `${t.start_lat}, ${t.start_lng}` : null)}</FieldItem>
                <FieldItem label="Notes">{t.notes}</FieldItem>
              </FieldGrid>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Activity" />
            <CardBody>
              <RecordTimeline entityType="tour" entityId={id} />
            </CardBody>
          </Card>
        </div>
      </div>

      <RecordSheet open={editing} onOpenChange={setEditing} title="Edit tour" mode="edit" fields={TOUR_FIELDS} initial={t as unknown as Record<string, unknown>} onSubmit={(b) => update.mutateAsync(b)} />
      {participant && <ParticipantDialog tour={t} open onOpenChange={setParticipant} />}
      {fbStop !== undefined && <FeedbackDialog tour={t} stop={fbStop} open onOpenChange={(o) => !o && setFbStop(undefined)} />}
    </>
  );
}

export default function TourPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <TourDetail id={params.id} />
    </Suspense>
  );
}
