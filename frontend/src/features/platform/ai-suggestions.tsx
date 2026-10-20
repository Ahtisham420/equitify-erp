"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ListChecks, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton, Tooltip } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDate, formatRelative } from "@/lib/utils";

import { aiKeys, useAIStatus, useInteractionSuggestions, type AISuggestion, type SummarizeResult } from "./api";

const KIND_LABEL: Record<AISuggestion["kind"], string> = { summary: "Summary", commitment: "Commitments", next_action: "Suggested next actions" };

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function SuggestionRow({ s, canEdit, onDecided }: { s: AISuggestion; canEdit: boolean; onDecided: () => void }) {
  const [due, setDue] = useState(typeof s.details.due_in_days === "number" ? addDays(s.details.due_in_days) : "");
  const [title, setTitle] = useState(s.content);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const pending = s.status === "pending";

  const decide = async (action: "accept" | "reject") => {
    setBusy(action);
    try {
      if (action === "accept") {
        await api.post(`/platform/ai/suggestions/${s.id}/accept`, {
          title: s.kind === "next_action" && title.trim() !== s.content ? title.trim() : null,
          due_at: s.kind === "next_action" && due ? new Date(`${due}T17:00:00`).toISOString() : null,
        });
        toast.success(s.kind === "next_action" ? "Task created from suggestion" : "Suggestion accepted");
      } else {
        await api.post(`/platform/ai/suggestions/${s.id}/reject`);
        toast.success("Suggestion rejected");
      }
      onDecided();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn("rounded-md border px-3 py-2", pending ? "border-line bg-surface" : "border-transparent bg-subtle/60")}>
      {s.kind === "next_action" && pending && canEdit ? (
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mb-1.5" />
      ) : (
        <p className={cn("whitespace-pre-wrap text-sm", s.status === "rejected" ? "text-ink-3 line-through" : "text-ink")}>{s.content}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
        {s.kind === "commitment" && s.details.party && <span>By: {s.details.party === "us" ? "our team" : s.details.party === "them" ? "contact" : s.details.party}</span>}
        {s.kind === "commitment" && s.details.due_hint && <span>· {s.details.due_hint}</span>}
        {s.kind === "next_action" && s.details.rationale && <span className="min-w-0 flex-1 truncate">{s.details.rationale}</span>}
        {s.status === "accepted" && <Badge tone="green">{s.task_id ? "Task created" : "Accepted"} {s.decided_at ? formatDate(s.decided_at) : ""}</Badge>}
        {s.status === "rejected" && <Badge>Rejected</Badge>}
      </div>
      {pending && canEdit && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
          {s.kind === "next_action" && (
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mr-auto w-40" aria-label="Due date" />
          )}
          <Button size="xs" variant="ghost" loading={busy === "reject"} disabled={!!busy} onClick={() => decide("reject")}>
            <X /> Reject
          </Button>
          <Button size="xs" variant="primary" loading={busy === "accept"} disabled={!!busy || (s.kind === "next_action" && !title.trim())} onClick={() => decide("accept")}>
            {s.kind === "next_action" ? <ListChecks /> : <Check />}
            {s.kind === "next_action" ? "Create task" : "Accept"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** AI summary, commitments and suggested next actions for a logged interaction. Nothing is applied until a user accepts it. */
export function InteractionAISuggestions({ interactionId }: { interactionId: string }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canEdit = can("outreach", "edit");
  const status = useAIStatus();
  const { data, isLoading } = useInteractionSuggestions(interactionId);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: aiKeys.suggestions(interactionId) });

  const summarize = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const r = await api.post<SummarizeResult>(`/platform/ai/interactions/${interactionId}/summarize`);
      if (!r.ai_used) setMessage(r.message);
      qc.setQueryData(aiKeys.suggestions(interactionId), r.suggestions);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const available = status.data?.available ?? false;
  const items = data ?? [];
  const groups = (["summary", "commitment", "next_action"] as const).map((k) => ({ kind: k, items: items.filter((s) => s.kind === k) })).filter((g) => g.items.length > 0);
  const latest = items[0]?.created_at;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-ink-3" />
          <span className="text-sm font-medium text-ink">AI assist</span>
          <Badge tone="amber">Requires confirmation</Badge>
        </div>
        {canEdit && (
          <Tooltip content={available ? undefined : "AI is not configured on this workspace"}>
            <span>
              <Button size="sm" onClick={summarize} loading={running} disabled={!available}>
                {items.length ? "Regenerate" : "Summarize"}
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
      {message && <p className="text-xs text-ink-3">{message}</p>}
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : groups.length === 0 ? (
        <p className="text-sm text-ink-3">{available ? "No AI suggestions yet for this interaction." : "AI suggestions are unavailable; log commitments and next actions manually."}</p>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.kind} className="space-y-1.5">
              <p className="text-xs font-medium text-ink-3">{KIND_LABEL[g.kind]}</p>
              {g.items.map((s) => (
                <SuggestionRow key={s.id} s={s} canEdit={canEdit} onDecided={refresh} />
              ))}
            </div>
          ))}
          {latest && (
            <p className="text-2xs text-ink-3">
              Generated {formatRelative(latest)}
              {items[0]?.model ? ` by ${items[0].model}` : ""}. AI output is a suggestion and never changes records on its own.
            </p>
          )}
        </>
      )}
    </div>
  );
}
