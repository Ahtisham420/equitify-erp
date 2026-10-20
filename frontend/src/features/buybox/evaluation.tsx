"use client";

import { Check, CircleHelp, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime, titleCase } from "@/lib/utils";

import { EXCEPTION_LABELS, REQUIREMENT_LABELS, RESULT_LABELS, useDecideException, useRequestException, type Evaluation, type EvaluationDetail } from "./api";

export function ResultBadge({ result }: { result: string }) {
  return <StatusBadge status={result} label={RESULT_LABELS[result] ?? titleCase(result)} />;
}

export function ExceptionBadge({ status }: { status: string }) {
  if (status === "none") return null;
  const tone = status === "approved" ? "green" : status === "rejected" ? "red" : "amber";
  return <Badge tone={tone}>Exception {EXCEPTION_LABELS[status]?.toLowerCase() ?? status}</Badge>;
}

function OutcomeIcon({ d }: { d: EvaluationDetail }) {
  const cls = "mt-0.5 size-4 shrink-0";
  if (d.outcome === "missing") return <CircleHelp className={cn(cls, "text-caution")} />;
  if (d.outcome === "pass") return <Check className={cn(cls, "text-positive")} />;
  return <X className={cn(cls, d.requirement === "preferred" ? "text-caution" : "text-negative")} />;
}

/** Per-criterion explanation: what passed, what failed, and which fields prevent evaluation. */
export function EvaluationDetails({ evaluation }: { evaluation: Evaluation }) {
  const e = evaluation;
  return (
    <div className="space-y-3">
      {e.result === "insufficient_data" && e.missing_fields.length > 0 && (
        <div className="rounded-md border border-caution/30 bg-caution-soft px-3 py-2 text-sm">
          <p className="font-medium text-caution">Missing data prevents evaluation</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {e.missing_fields.map((f) => (
              <Badge key={f} tone="outline">
                {titleCase(f)}
              </Badge>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-ink-2">A research task has been created for the buy box owner.</p>
        </div>
      )}
      {e.details.length === 0 ? (
        <p className="text-sm text-ink-3">This buy box has no criteria, so every property passes.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {e.details.map((d) => (
            <li key={d.criterion_id} className="flex items-start gap-2.5 px-3 py-2">
              <OutcomeIcon d={d} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{d.explanation}</p>
                {d.outcome === "missing" && d.missing_fields.length > 0 && (
                  <p className="text-xs text-ink-3">Needs: {d.missing_fields.map(titleCase).join(", ")}</p>
                )}
              </div>
              <Badge tone={d.requirement === "disqualifying" ? "red" : d.requirement === "preferred" ? "outline" : "neutral"}>
                {REQUIREMENT_LABELS[d.requirement]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {e.preferred_misses.length > 0 && (
        <p className="text-xs text-ink-3">
          {e.preferred_misses.length} preferred criteria not met — reported only, they do not fail the property.
        </p>
      )}
      {e.exception_status !== "none" && (
        <div className="space-y-1 rounded-md border border-line bg-subtle/60 px-3 py-2 text-xs">
          {e.exception_requested_at && (
            <p className="text-ink-2">
              <span className="font-medium text-ink">{e.exception_requested_by_name ?? "Someone"}</span> requested an exception on{" "}
              {formatDateTime(e.exception_requested_at)}: {e.exception_request_reason}
            </p>
          )}
          {e.exception_decided_at && (
            <p className="text-ink-2">
              <span className="font-medium text-ink">{e.exception_approver_name ?? "Approver"}</span> {e.exception_status} it on{" "}
              {formatDateTime(e.exception_decided_at)}: {e.exception_decision_reason}
            </p>
          )}
        </div>
      )}
      <p className="text-xs text-ink-3">
        Evaluated {formatDateTime(e.evaluated_at)} against version {e.buy_box_version} · trigger {titleCase(e.trigger).toLowerCase()}
      </p>
    </div>
  );
}

/** Request / approve / reject an exception for a failed evaluation (approval needs buybox:approve). */
export function ExceptionActions({ evaluation, size = "xs" }: { evaluation: Evaluation; size?: "xs" | "sm" }) {
  const { can } = useAuth();
  const [mode, setMode] = useState<null | "request" | "approve" | "reject">(null);
  const [reason, setReason] = useState("");
  const request = useRequestException();
  const decide = useDecideException();
  const e = evaluation;

  if (!e.is_current) return null;
  const canRequest = e.raw_result === "fail" && ["none", "rejected"].includes(e.exception_status) && can("buybox", "edit");
  const canDecide = e.exception_status === "requested" && can("buybox", "approve");
  if (!canRequest && !canDecide) return null;

  const close = () => {
    setMode(null);
    setReason("");
  };
  const submit = () => {
    const opts = {
      onSuccess: () => {
        toast.success(mode === "request" ? "Exception requested" : mode === "approve" ? "Exception approved" : "Exception rejected");
        close();
      },
      onError: (err: unknown) => toast.error(errorMessage(err)),
    };
    if (mode === "request") request.mutate({ id: e.id, reason }, opts);
    else decide.mutate({ id: e.id, approve: mode === "approve", reason }, opts);
  };

  return (
    <>
      <div className="flex gap-1.5">
        {canRequest && (
          <Button size={size} onClick={() => setMode("request")}>
            <ShieldQuestion className="!size-3.5" /> Request exception
          </Button>
        )}
        {canDecide && (
          <>
            <Button size={size} onClick={() => setMode("approve")}>
              <ShieldCheck className="!size-3.5" /> Approve
            </Button>
            <Button size={size} variant="ghost" onClick={() => setMode("reject")}>
              Reject
            </Button>
          </>
        )}
      </div>
      <Dialog
        open={mode !== null}
        onOpenChange={(o) => !o && close()}
        title={mode === "request" ? "Request buy box exception" : mode === "approve" ? "Approve exception" : "Reject exception"}
        description={
          mode === "request"
            ? `${e.property_label ?? "This property"} failed “${e.buy_box_name}”. An approver must accept the exception before it counts as Pass with exception.`
            : `You are recorded as the approver for ${e.property_label ?? "this property"} on “${e.buy_box_name}”.`
        }
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant={mode === "reject" ? "danger" : "primary"}
              disabled={reason.trim().length < 3}
              loading={request.isPending || decide.isPending}
              onClick={submit}
            >
              {mode === "request" ? "Submit request" : mode === "approve" ? "Approve exception" : "Reject exception"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {mode !== "request" && e.exception_request_reason && (
            <div className="rounded-md border border-line bg-subtle/60 px-3 py-2 text-sm">
              <p className="text-xs text-ink-3">Requested by {e.exception_requested_by_name ?? "—"}</p>
              <p className="text-ink">{e.exception_request_reason}</p>
            </div>
          )}
          <Field label="Reason" required>
            <Textarea autoFocus value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Why should this property be pursued despite failing?" />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
