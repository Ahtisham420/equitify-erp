"use client";

import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type Ref } from "react";
import { toast } from "sonner";

import { PropertyPicker } from "@/components/data/entity-picker";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

import { fromLocalInput, toLocalInput } from "@/features/tasks/api";
import { OpportunityPicker, OrganizationPicker, PersonPicker } from "@/features/tasks/record-pickers";

import {
  CHANNEL_LABELS,
  CHANNELS,
  DIRECTIONS,
  DISPOSITION_LABELS,
  DISPOSITIONS,
  isMeaningful,
  useLogInteraction,
  type ChannelStatus,
  type Interaction,
  type InteractionInput,
  type RecordLinks,
} from "./api";

type FollowMode = "next" | "close" | "none";

const DISPOSITION_CHANNELS = ["call", "sms", "email"];
const CONTACT_CHANNELS = ["call", "sms", "email"];

function quickDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

export interface ComposerContact {
  kind: string;
  label: string | null;
  value: string;
  channels: ChannelStatus[];
}

export function InteractionComposer({
  formId,
  defaults,
  showLinks,
  contacts,
  completeTaskId,
  enrollmentId,
  defaultChannel = "call",
  summaryRef,
  onLogged,
  onPendingChange,
  inlineSubmit,
}: {
  formId: string;
  defaults?: RecordLinks;
  showLinks?: boolean;
  contacts?: ComposerContact[];
  completeTaskId?: string | null;
  enrollmentId?: string | null;
  defaultChannel?: string;
  summaryRef?: Ref<HTMLTextAreaElement>;
  onLogged?: (it: Interaction) => void;
  onPendingChange?: (pending: boolean) => void;
  inlineSubmit?: boolean;
}) {
  const log = useLogInteraction();
  const [channel, setChannel] = useState(defaultChannel);
  const [direction, setDirection] = useState("outbound");
  const [disposition, setDisposition] = useState("");
  const [contactValue, setContactValue] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [subject, setSubject] = useState("");
  const [summary, setSummary] = useState("");
  const [minutes, setMinutes] = useState("");
  const [mode, setMode] = useState<FollowMode>("none");
  const [nextAction, setNextAction] = useState("");
  const [nextAt, setNextAt] = useState("");
  const [closedReason, setClosedReason] = useState("");
  const [links, setLinks] = useState<RecordLinks>(defaults ?? {});
  const [blocked, setBlocked] = useState<string[] | null>(null);

  const meaningful = isMeaningful(channel, disposition || null);
  useEffect(() => {
    if (meaningful && mode === "none") setMode("next");
  }, [meaningful, mode]);
  useEffect(() => onPendingChange?.(log.isPending), [log.isPending, onPendingChange]);
  useEffect(() => setLinks(defaults ?? {}), [defaults?.person_id, defaults?.organization_id, defaults?.property_id, defaults?.opportunity_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const contactKind = channel === "email" ? "email" : "phone";
  const contactOptions = useMemo(() => (contacts ?? []).filter((c) => c.kind === contactKind), [contacts, contactKind]);
  useEffect(() => {
    if (!CONTACT_CHANNELS.includes(channel)) return;
    if (!contactOptions.some((c) => c.value === contactValue)) setContactValue(contactOptions[0]?.value ?? "");
  }, [channel, contactOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const compChannel = channel === "call" ? "phone" : channel;
  const selectedStatus = contactOptions.find((c) => c.value === contactValue)?.channels.find((s) => s.channel === compChannel);
  const outboundChecked = direction === "outbound" && CONTACT_CHANNELS.includes(channel);

  const reset = () => {
    setDisposition("");
    setSubject("");
    setSummary("");
    setMinutes("");
    setOccurredAt("");
    setMode("none");
    setNextAction("");
    setNextAt("");
    setClosedReason("");
    setBlocked(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBlocked(null);
    if (!links.person_id && !links.organization_id && !links.property_id && !links.opportunity_id) {
      toast.error("Link the interaction to a person, organization, property or opportunity");
      return;
    }
    if (mode === "next" && (!nextAction.trim() || !nextAt)) {
      toast.error("Add the next action and its date");
      return;
    }
    if (mode === "close" && !closedReason.trim()) {
      toast.error("Give a reason for closing the loop");
      return;
    }
    const data: InteractionInput = {
      channel,
      direction,
      occurred_at: fromLocalInput(occurredAt),
      ...links,
      contact_value: CONTACT_CHANNELS.includes(channel) ? contactValue.trim() || null : null,
      disposition: DISPOSITION_CHANNELS.includes(channel) && disposition ? disposition : null,
      subject: subject.trim() || null,
      summary: summary.trim() || null,
      duration_seconds: minutes ? Math.round(Number(minutes) * 60) || null : null,
      next_action: mode === "next" ? nextAction.trim() : null,
      next_action_at: mode === "next" ? fromLocalInput(nextAt) : null,
      loop_closed: mode === "close",
      closed_reason: mode === "close" ? closedReason.trim() : null,
      sequence_enrollment_id: enrollmentId ?? null,
      complete_task_id: completeTaskId ?? null,
    };
    log.mutate(data, {
      onSuccess: (it) => {
        toast.success(it.follow_up_task_id ? "Interaction logged · follow-up task created" : "Interaction logged");
        reset();
        onLogged?.(it);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.detail && typeof err.detail === "object" && (err.detail as { code?: string }).code === "compliance_blocked") {
          setBlocked((err.detail as { reasons: string[] }).reasons ?? []);
        } else toast.error(errorMessage(err));
      },
    });
  };

  return (
    <form id={formId} onSubmit={submit} className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChannel(c)}
            className={cn(
              "h-7 rounded-md border px-2.5 text-sm font-medium transition-colors",
              channel === c ? "border-ink bg-ink text-white" : "border-line-strong/80 bg-surface text-ink-2 hover:bg-subtle hover:text-ink",
            )}
          >
            {CHANNEL_LABELS[c]}
          </button>
        ))}
      </div>

      {showLinks && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Person">
            <PersonPicker value={links.person_id} onChange={(id) => setLinks((l) => ({ ...l, person_id: id ?? undefined }))} />
          </Field>
          <Field label="Organization">
            <OrganizationPicker value={links.organization_id} onChange={(id) => setLinks((l) => ({ ...l, organization_id: id ?? undefined }))} />
          </Field>
          <Field label="Property">
            <PropertyPicker value={links.property_id} onChange={(id) => setLinks((l) => ({ ...l, property_id: id ?? undefined }))} />
          </Field>
          <Field label="Opportunity">
            <OpportunityPicker value={links.opportunity_id} onChange={(id) => setLinks((l) => ({ ...l, opportunity_id: id ?? undefined }))} />
          </Field>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Direction">
          <Select value={direction} onChange={(e) => setDirection(e.target.value)} options={DIRECTIONS.map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))} />
        </Field>
        <Field label="When" hint="Leave empty for now">
          <Input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        {CONTACT_CHANNELS.includes(channel) && (
          <Field label={channel === "email" ? "Email address" : "Phone number"} className="col-span-2">
            {contactOptions.length > 0 ? (
              <Select
                value={contactValue}
                onChange={(e) => setContactValue(e.target.value)}
                options={contactOptions.map((c) => {
                  const st = c.channels.find((s) => s.channel === compChannel);
                  return { value: c.value, label: `${c.value}${c.label ? ` · ${c.label}` : ""}${st ? (st.allowed ? " · allowed" : " · blocked") : ""}` };
                })}
              />
            ) : (
              <Input value={contactValue} onChange={(e) => setContactValue(e.target.value)} placeholder={channel === "email" ? "name@example.com" : "(555) 555-0100"} />
            )}
          </Field>
        )}
        {DISPOSITION_CHANNELS.includes(channel) && (
          <Field label="Disposition">
            <Select value={disposition} onChange={(e) => setDisposition(e.target.value)} placeholder="Select…" options={DISPOSITIONS.map((d) => ({ value: d, label: DISPOSITION_LABELS[d] }))} />
          </Field>
        )}
        {["call", "meeting", "tour"].includes(channel) && (
          <Field label="Duration (minutes)">
            <Input inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
        )}
        {["email", "letter"].includes(channel) && (
          <Field label="Subject" className="col-span-2">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
          </Field>
        )}
      </div>

      {outboundChecked && selectedStatus && (
        <div className={cn("flex gap-2 rounded-md border px-3 py-2 text-xs", selectedStatus.allowed ? "border-positive/30 bg-positive-soft text-positive" : "border-negative/30 bg-negative-soft text-negative")}>
          {selectedStatus.allowed ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <ShieldAlert className="mt-px size-3.5 shrink-0" />}
          <div>
            <p className="font-medium">{selectedStatus.allowed ? "Compliance check passed for this number/address" : "Blocked by compliance"}</p>
            {selectedStatus.reasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </div>
        </div>
      )}

      {disposition === "wrong_number" && <p className="text-xs text-caution">This number will be marked invalid on the contact and internally suppressed.</p>}
      {disposition === "not_interested" && <p className="text-xs text-caution">The contact&apos;s phones and emails will be suppressed for the configured period.</p>}

      <Field label="Summary">
        <Textarea ref={summaryRef} value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} placeholder="What was discussed, commitments made…" />
      </Field>

      <section className="space-y-3 rounded-lg border border-line bg-subtle/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-ink">Next step</h4>
          {meaningful && <span className="text-2xs font-medium text-caution">Required after a meaningful conversation</span>}
        </div>
        <div className="inline-flex rounded-md border border-line bg-surface p-0.5">
          {(["next", "close", ...(meaningful ? [] : ["none"])] as FollowMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn("h-7 rounded px-2.5 text-xs font-medium", mode === m ? "bg-ink text-white" : "text-ink-2 hover:bg-muted")}
            >
              {m === "next" ? "Schedule next action" : m === "close" ? "Close the loop" : "No follow-up"}
            </button>
          ))}
        </div>
        {mode === "next" && (
          <div className="space-y-2">
            <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="e.g. Send rent roll and call back about pricing" maxLength={300} />
            <div className="flex flex-wrap items-center gap-2">
              <Input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} className="w-56" />
              {[
                ["Tomorrow", 1],
                ["3 days", 3],
                ["1 week", 7],
                ["2 weeks", 14],
                ["1 month", 30],
              ].map(([label, days]) => (
                <Button key={label} size="xs" variant="ghost" onClick={() => setNextAt(quickDate(days as number))}>
                  {label}
                </Button>
              ))}
            </div>
            <p className="text-2xs text-ink-3">A follow-up task is created for you with this date.</p>
          </div>
        )}
        {mode === "close" && (
          <Textarea value={closedReason} onChange={(e) => setClosedReason(e.target.value)} rows={2} placeholder="Why no further action is needed (e.g. owner sold, not a fit)" />
        )}
      </section>

      {blocked && (
        <div className="flex gap-2 rounded-lg border border-negative/30 bg-negative-soft p-3 text-sm text-negative">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Blocked by communication compliance — this attempt was recorded.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
              {blocked.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {inlineSubmit && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={log.isPending}>
            Log interaction
          </Button>
        </div>
      )}
    </form>
  );
}
