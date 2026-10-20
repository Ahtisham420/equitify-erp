"use client";

import { Building2, CalendarClock, Check, CheckCircle2, Inbox, Mail, Phone, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/data/page";
import { Badge, StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Kbd, Skeleton } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatRelative, isOverdue, titleCase } from "@/lib/utils";

import { PROPERTY_TYPE_LABELS } from "@/features/properties/api";
import { relatedHref, useTaskAction } from "@/features/tasks/api";
import { taskErrorDetail } from "@/features/tasks/task-sheet";

import { usePersonContext, useQueue, type ChannelStatus, type PersonContext, type QueueItem } from "./api";
import { InteractionComposer } from "./interaction-composer";
import { InteractionList } from "./record-interactions";

const KIND_LABELS: Record<QueueItem["kind"], { label: string; tone: Tone }> = {
  task: { label: "Task", tone: "neutral" },
  follow_up: { label: "Follow-up", tone: "blue" },
  sequence_step: { label: "Sequence", tone: "sky" },
  stalled_deal: { label: "Stalled deal", tone: "amber" },
  person_due: { label: "Next action", tone: "blue" },
  relationship: { label: "Going cold", tone: "neutral" },
};

const CAPS = [20, 40, 60, 100];

function todayKey() {
  const d = new Date();
  return `queue-done:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function useLocalDone() {
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => {
    try {
      setDone(JSON.parse(window.localStorage.getItem(todayKey()) ?? "[]"));
    } catch {
      /* storage unavailable */
    }
  }, []);
  const mark = useCallback((key: string) => {
    setDone((prev) => {
      const next = prev.includes(key) ? prev : [...prev, key];
      try {
        window.localStorage.setItem(todayKey(), JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return { done, mark };
}

function ChannelPill({ s }: { s: ChannelStatus }) {
  const label = s.channel === "phone" ? "Call" : s.channel === "sms" ? "Text" : "Email";
  return (
    <div className={cn("rounded-md border px-2 py-1 text-xs", s.allowed ? "border-positive/30 bg-positive-soft text-positive" : "border-negative/30 bg-negative-soft text-negative")}>
      <p className="flex items-center gap-1 font-medium">
        {s.allowed ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
        {label} {s.allowed ? "allowed" : "blocked"}
      </p>
      {!s.allowed && (
        <ul className="mt-0.5 space-y-0.5">
          {s.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContextPanel({ ctx }: { ctx: PersonContext }) {
  const p = ctx.person;
  return (
    <div className="space-y-4">
      {p && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link href={`/people/${p.id}`} className="text-base font-semibold text-ink hover:underline">
              {p.full_name}
            </Link>
            <p className="text-sm text-ink-2">{[p.title, [p.city, p.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "—"}</p>
          </div>
          <div className="text-right text-xs text-ink-3">
            <p>Last touch: {p.last_touch_at ? formatRelative(p.last_touch_at) : "never"}</p>
            {p.next_action_at && <p className={isOverdue(p.next_action_at) ? "text-negative" : ""}>Next action: {formatDate(p.next_action_at)}</p>}
          </div>
        </div>
      )}

      {ctx.suppression_reasons.length > 0 && (
        <div className="rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-xs text-negative">
          <p className="font-medium">Suppression on file</p>
          {ctx.suppression_reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </div>
      )}

      <section>
        <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">Contact points & compliance</h4>
        {ctx.contacts.length === 0 ? (
          <p className="text-sm text-ink-3">No phone or email on file.</p>
        ) : (
          <ul className="space-y-2">
            {ctx.contacts.map((c) => (
              <li key={`${c.kind}-${c.value}`} className="rounded-md border border-line p-2">
                <p className="mb-1.5 flex items-center gap-1.5 text-sm">
                  {c.kind === "email" ? <Mail className="size-3.5 text-ink-3" /> : <Phone className="size-3.5 text-ink-3" />}
                  <span className="font-medium text-ink">{c.value}</span>
                  {c.label && <span className="text-xs text-ink-3">· {c.label}</span>}
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {c.channels.map((s) => (
                    <ChannelPill key={s.channel} s={s} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ctx.talking_points.length > 0 && (
        <section>
          <h4 className="mb-1.5 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
            <Sparkles className="size-3" /> Talking points
          </h4>
          <ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">
            {ctx.talking_points.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      )}

      {(ctx.properties.length > 0 || ctx.organizations.length > 0 || ctx.opportunities.length > 0) && (
        <section className="grid gap-3 sm:grid-cols-2">
          {ctx.organizations.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">Organizations</h4>
              <ul className="space-y-1 text-sm">
                {ctx.organizations.map((o) => (
                  <li key={o.id} className="truncate">
                    <Link href={`/organizations/${o.id}`} className="text-ink hover:underline">
                      {o.name}
                    </Link>
                    {(o.title || o.role) && <span className="text-ink-3"> · {o.title || titleCase(o.role)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ctx.properties.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">Properties</h4>
              <ul className="space-y-1 text-sm">
                {ctx.properties.map((pr) => (
                  <li key={pr.id} className="flex items-center gap-1.5 truncate">
                    <Building2 className="size-3.5 shrink-0 text-ink-3" />
                    <Link href={`/properties/${pr.id}`} className="truncate text-ink hover:underline">
                      {pr.name || pr.address_line}
                    </Link>
                    <span className="truncate text-xs text-ink-3">{PROPERTY_TYPE_LABELS[pr.property_type] ?? titleCase(pr.property_type)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ctx.opportunities.length > 0 && (
            <div className="sm:col-span-2">
              <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">Opportunities</h4>
              <ul className="space-y-1 text-sm">
                {ctx.opportunities.map((o) => (
                  <li key={o.id} className="flex items-center gap-2">
                    <Link href={relatedHref("opportunity", o.id)!} className="truncate text-ink hover:underline">
                      {o.title}
                    </Link>
                    <StatusBadge status={o.stage} />
                    {o.next_action_at && <span className={cn("text-xs", isOverdue(o.next_action_at) ? "text-negative" : "text-ink-3")}>next {formatDate(o.next_action_at)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {ctx.open_tasks.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">Open tasks</h4>
          <ul className="space-y-1 text-sm">
            {ctx.open_tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <CalendarClock className="size-3.5 text-ink-3" />
                <Link href={`/tasks?task=${t.id}`} className="truncate text-ink hover:underline">
                  {t.title}
                </Link>
                {t.due_at && <span className={cn("text-xs", isOverdue(t.due_at) ? "text-negative" : "text-ink-3")}>{formatDate(t.due_at)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {ctx.enrollments.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">Sequences</h4>
          <ul className="space-y-1 text-sm">
            {ctx.enrollments.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="text-ink">{e.sequence_name}</span>
                <span className="text-xs text-ink-3">
                  step {Math.min(e.current_step + 1, e.total_steps)} of {e.total_steps}
                  {e.next_step_channel ? ` · ${e.next_step_channel}` : ""}
                </span>
                <StatusBadge status={e.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">Recent interactions</h4>
        {ctx.interactions.length === 0 ? <p className="text-sm text-ink-3">No interactions logged yet.</p> : <InteractionList items={ctx.interactions} />}
      </section>
    </div>
  );
}

function ItemDetail({ item, onLogged, summaryRef }: { item: QueueItem; onLogged: () => void; summaryRef: RefObject<HTMLTextAreaElement> }) {
  const { can } = useAuth();
  const ctx = usePersonContext(item.person_id);
  const kind = KIND_LABELS[item.kind];
  const href = item.opportunity_id ? relatedHref("opportunity", item.opportunity_id) : item.property_id ? relatedHref("property", item.property_id) : null;
  const stepChannel = ctx.data?.enrollments.find((e) => e.id === item.enrollment_id)?.next_step_channel;

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={kind.tone}>{kind.label}</Badge>
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{item.title}</h2>
            <span className="text-xs text-ink-3 tabular" title="Priority score">
              Score {item.score}
            </span>
          </div>
          {item.subtitle && <p className="text-sm text-ink-2">{item.subtitle}</p>}
          <div className="flex flex-wrap gap-1.5">
            {item.reasons.map((r) => (
              <span key={r} className="rounded-md border border-line bg-subtle px-2 py-0.5 text-xs text-ink-2">
                {r}
              </span>
            ))}
          </div>
          {href && (
            <Link href={href} className="inline-block text-xs font-medium text-accent hover:underline">
              Open {item.opportunity_id ? "opportunity" : "property"}
            </Link>
          )}
        </CardBody>
      </Card>

      {item.person_id && (
        <Card>
          <CardHeader title="Pre-call context" />
          <CardBody>
            {ctx.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : ctx.error ? (
              <p className="text-sm text-negative">{errorMessage(ctx.error)}</p>
            ) : ctx.data ? (
              <ContextPanel ctx={ctx.data} />
            ) : null}
          </CardBody>
        </Card>
      )}

      {can("outreach", "create") && (
        <Card>
          <CardHeader title="Log interaction" description="Choose a disposition, then schedule the next step or close the loop." actions={<Kbd>L</Kbd>} />
          <CardBody>
            <InteractionComposer
              key={`${item.key}-${stepChannel ?? ""}`}
              formId={`queue-log-${item.key}`}
              defaults={{
                person_id: item.person_id ?? undefined,
                organization_id: item.organization_id ?? undefined,
                property_id: item.property_id ?? undefined,
                opportunity_id: item.opportunity_id ?? undefined,
              }}
              showLinks={!item.person_id && !item.opportunity_id && !item.property_id && !item.organization_id}
              contacts={ctx.data?.contacts}
              completeTaskId={item.task_id}
              enrollmentId={item.enrollment_id}
              defaultChannel={stepChannel ?? "call"}
              summaryRef={summaryRef}
              onLogged={onLogged}
              inlineSubmit
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export function DailyQueue() {
  const url = useUrlState();
  const limit = url.getNumber("limit", 40);
  const { data, isLoading, refetch, isFetching } = useQueue(limit);
  const { done, mark } = useLocalDone();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const taskAction = useTaskAction();

  const items = useMemo(() => data?.items ?? [], [data]);
  const remaining = items.filter((i) => !done.includes(i.key));
  const index = Math.max(0, items.findIndex((i) => i.key === selectedKey));
  const selected = items.length ? items[index] : null;

  useEffect(() => {
    if (!items.length) return;
    if (!selectedKey || !items.some((i) => i.key === selectedKey)) {
      setSelectedKey((items.find((i) => !done.includes(i.key)) ?? items[0]).key);
    }
  }, [items, selectedKey, done]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-key="${CSS.escape(selected?.key ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected?.key]);

  const move = useCallback(
    (delta: number) => {
      if (!items.length) return;
      const next = Math.min(items.length - 1, Math.max(0, index + delta));
      setSelectedKey(items[next].key);
    },
    [items, index],
  );

  const nextOpen = useCallback(
    (fromKey: string) => {
      const after = items.slice(items.findIndex((i) => i.key === fromKey) + 1).find((i) => !done.includes(i.key) && i.key !== fromKey);
      if (after) setSelectedKey(after.key);
    },
    [items, done],
  );

  const markDone = useCallback(
    (item: QueueItem) => {
      if (item.task_id && (item.kind === "task" || item.kind === "follow_up")) {
        taskAction.mutate(
          { id: item.task_id, action: "complete" },
          {
            onSuccess: () => {
              toast.success("Task completed");
              mark(item.key);
              nextOpen(item.key);
            },
            onError: (e) => toast.error(taskErrorDetail(e)),
          },
        );
      } else {
        mark(item.key);
        nextOpen(item.key);
      }
    },
    [taskAction, mark, nextOpen],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[role=dialog]")) return;
      if (e.key === "j") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "l") {
        e.preventDefault();
        summaryRef.current?.focus();
        summaryRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (e.key === "e" && selected) {
        e.preventDefault();
        markDone(selected);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [move, markDone, selected]);

  if (isLoading) {
    return (
      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <Skeleton className="h-[480px] w-full" />
        <Skeleton className="h-[480px] w-full" />
      </div>
    );
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[380px_1fr]">
      <Card className="lg:sticky lg:top-16">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Today</h3>
            <p className="text-xs text-ink-3 tabular">
              <span className="font-medium text-positive">{done.filter((k) => items.some((i) => i.key === k)).length + (data?.done_today ?? 0)} done</span> ·{" "}
              <span className="font-medium text-ink-2">{remaining.length} remaining</span>
              {data && data.total_candidates > data.cap && <> · capped at {data.cap} of {data.total_candidates}</>}
            </p>
          </div>
          <Select value={String(limit)} onChange={(e) => url.set({ limit: Number(e.target.value) })} options={CAPS.map((c) => ({ value: String(c), label: `Cap ${c}` }))} className="w-24" />
        </div>
        {items.length === 0 ? (
          <EmptyState icon={<Inbox />} title="Your queue is clear" description="No follow-ups, due tasks, stalled deals or cold relationships need you today." />
        ) : (
          <ul ref={listRef} className="max-h-[calc(100vh-220px)] divide-y divide-line overflow-y-auto scrollbar-thin">
            {items.map((i) => {
              const isDone = done.includes(i.key);
              const active = i.key === selected?.key;
              return (
                <li key={i.key} data-key={i.key}>
                  <button
                    onClick={() => setSelectedKey(i.key)}
                    className={cn("flex w-full gap-3 px-4 py-2.5 text-left transition-colors", active ? "bg-accent-soft/60" : "hover:bg-subtle", isDone && "opacity-50")}
                  >
                    <span className="mt-0.5 w-7 shrink-0 text-right text-xs font-semibold text-ink-3 tabular">{Math.round(i.score)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {isDone && <CheckCircle2 className="size-3.5 shrink-0 text-positive" />}
                        <span className={cn("truncate text-sm font-medium", isDone ? "text-ink-3 line-through" : "text-ink")}>{i.title}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <Badge tone={KIND_LABELS[i.kind].tone}>{KIND_LABELS[i.kind].label}</Badge>
                        {i.reasons.slice(0, 2).map((r) => (
                          <span key={r} className="max-w-[220px] truncate rounded border border-line bg-subtle px-1.5 text-2xs leading-5 text-ink-2" title={r}>
                            {r}
                          </span>
                        ))}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-2xs text-ink-3">
          <span className="flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
          <span className="flex items-center gap-1"><Kbd>L</Kbd> log</span>
          <span className="flex items-center gap-1"><Kbd>E</Kbd> done</span>
          <button className="ml-auto text-ink-2 hover:text-ink" onClick={() => refetch()} disabled={isFetching}>
            Refresh
          </button>
        </div>
      </Card>

      <div>
        {selected ? (
          <>
            <div className="mb-3 flex items-center justify-end gap-2">
              <Button size="sm" onClick={() => markDone(selected)} loading={taskAction.isPending} disabled={done.includes(selected.key)}>
                <Check /> Mark done
              </Button>
            </div>
            <ItemDetail
              item={selected}
              summaryRef={summaryRef}
              onLogged={() => {
                mark(selected.key);
                nextOpen(selected.key);
                refetch();
              }}
            />
          </>
        ) : (
          <Card>
            <EmptyState icon={<Inbox />} title="Nothing selected" />
          </Card>
        )}
      </div>
    </div>
  );
}
