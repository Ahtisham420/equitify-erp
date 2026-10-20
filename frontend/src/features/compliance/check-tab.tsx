"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { cn, formatDate, titleCase } from "@/lib/utils";

import { fromLocalInput } from "@/features/tasks/api";

import { CHANNEL_LABELS, CHANNELS, useCheck } from "./api";

/** Send-time eligibility test. Nothing is sent or logged. */
export function CheckTab() {
  const [channel, setChannel] = useState("phone");
  const [value, setValue] = useState("");
  const [at, setAt] = useState("");
  const check = useCheck();
  const r = check.data;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    check.mutate({ channel, value: value.trim(), at: fromLocalInput(at) }, { onError: (err) => toast.error(errorMessage(err)) });
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[380px_1fr]">
      <Card>
        <CardHeader title="Test a value" description="Evaluates DNC scrub, suppression, consent, quiet hours and caps exactly as enforced at send time." />
        <CardBody>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Channel">
              <Select value={channel} onChange={(e) => setChannel(e.target.value)} options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
            </Field>
            <Field label={channel === "email" ? "Email address" : "Phone number"} required>
              <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={channel === "email" ? "name@example.com" : "(555) 555-0100"} />
            </Field>
            <Field label="At" hint="Leave empty to check right now">
              <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" loading={check.isPending} disabled={value.trim().length < 3}>
              Check
            </Button>
          </form>
        </CardBody>
      </Card>

      {r && (
        <Card>
          <CardBody className="space-y-4">
            <div className={cn("flex items-start gap-3 rounded-lg border p-4", r.allowed ? "border-positive/30 bg-positive-soft text-positive" : "border-negative/30 bg-negative-soft text-negative")}>
              {r.allowed ? <ShieldCheck className="size-5 shrink-0" /> : <ShieldAlert className="size-5 shrink-0" />}
              <div>
                <p className="text-base font-semibold">{r.allowed ? "Allowed" : "Blocked"}</p>
                <p className="text-sm">
                  {CHANNEL_LABELS[r.channel]} · {r.value}
                  {r.normalized_value && r.normalized_value !== r.value ? ` (${r.normalized_value})` : ""}
                </p>
                {r.reasons.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
                    {r.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            {r.record ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-ink-3">DNC</dt><dd>{titleCase(r.record.dnc_status)}</dd></div>
                <div><dt className="text-xs text-ink-3">Scrub expires</dt><dd>{formatDate(r.record.scrub_expires_on)}</dd></div>
                <div><dt className="text-xs text-ink-3">Consent</dt><dd>{titleCase(r.record.consent_state)}</dd></div>
                <div><dt className="text-xs text-ink-3">Suppressed</dt><dd>{r.record.internal_suppression ? "Yes" : "No"}</dd></div>
                <div><dt className="text-xs text-ink-3">Phone type</dt><dd>{titleCase(r.record.phone_type)}</dd></div>
                <div><dt className="text-xs text-ink-3">Jurisdiction</dt><dd>{r.record.jurisdiction_state ?? "Default timezone"}</dd></div>
              </dl>
            ) : (
              <p className="text-sm text-ink-3">No compliance record exists for this value yet.</p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
