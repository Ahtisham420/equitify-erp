"use client";

import { PhoneCall, Plus, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { FieldGrid, FieldItem } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDateTime, titleCase } from "@/lib/utils";

import { useClosingMutation, useWires, wireTone, type Closing, type Wire } from "./api";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

function InstructionsDialog({ closing, open, onOpenChange, replacing }: { closing: Closing; open: boolean; onOpenChange: (v: boolean) => void; replacing: boolean }) {
  const blank = { beneficiary_name: "", bank_name: "", routing_number: "", account_number: "", amount: "", instruction_source: "", instruction_received_from: "", instruction_contact_phone: "" };
  const [f, setF] = useState(blank);
  const save = useClosingMutation(closing.id, (body: Record<string, unknown>) => api.post<Wire>(`/closings/${closing.id}/wires`, body));
  useEffect(() => {
    if (open) setF(blank);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const bind = (k: keyof typeof blank) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const valid = f.beneficiary_name && f.bank_name && f.routing_number.length >= 9 && f.account_number.length >= 4 && f.instruction_source.trim().length >= 2;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={replacing ? "Replace wire instructions" : "Record wire instructions"}
      description={replacing ? "The current instructions will be superseded and must be verified again by independent callback." : "Instructions are verified by an independent callback before funds can move."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { ...f, amount: f.amount ? Number(f.amount.replace(/,/g, "")) : null, instruction_received_from: f.instruction_received_from || null, instruction_contact_phone: f.instruction_contact_phone || null },
                { onSuccess: () => { toast.success("Wire instructions recorded — callback required"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Record instructions
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Beneficiary" required className="col-span-2"><Input {...bind("beneficiary_name")} /></Field>
        <Field label="Bank" required className="col-span-2"><Input {...bind("bank_name")} /></Field>
        <Field label="Routing number" required><Input {...bind("routing_number")} inputMode="numeric" /></Field>
        <Field label="Account number" required><Input {...bind("account_number")} inputMode="numeric" autoComplete="off" /></Field>
        <Field label="Amount ($)"><Input {...bind("amount")} inputMode="decimal" /></Field>
        <Field label="Received from"><Input {...bind("instruction_received_from")} placeholder="e.g. Title company escrow officer" /></Field>
        <Field label="How the instructions arrived" required className="col-span-2" hint="e.g. Email from escrow@title.com, secure portal, letter">
          <Input {...bind("instruction_source")} />
        </Field>
        <Field label="Phone number shown on the instructions" className="col-span-2" hint="Never used for the callback.">
          <Input {...bind("instruction_contact_phone")} />
        </Field>
      </div>
    </Dialog>
  );
}

function CallbackDialog({ closing, wire, open, onOpenChange }: { closing: Closing; wire: Wire; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [f, setF] = useState({ callback_phone: "", callback_phone_source: "", callback_contact_name: "", result: "passed", result_notes: "" });
  const save = useClosingMutation(closing.id, (body: Record<string, unknown>) => api.post<Wire>(`/closings/wires/${wire.id}/callback`, body));
  useEffect(() => {
    if (open) setF({ callback_phone: "", callback_phone_source: "", callback_contact_name: "", result: "passed", result_notes: "" });
  }, [open]);

  const sameSource = !!f.callback_phone_source && (norm(f.callback_phone_source) === norm(wire.instruction_source) || norm(wire.instruction_source).includes(norm(f.callback_phone_source)) || norm(f.callback_phone_source).includes(norm(wire.instruction_source)));
  const samePhone = !!wire.instruction_contact_phone && !!f.callback_phone && digits(f.callback_phone) === digits(wire.instruction_contact_phone);
  const valid = f.callback_phone.length >= 7 && f.callback_phone_source.trim().length >= 2 && f.callback_contact_name.trim() && !sameSource && !samePhone;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Independent callback"
      description="Call a number you sourced yourself, not one from the wire instructions or the email that delivered them."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={f.result === "failed" ? "danger" : "primary"}
            disabled={!valid}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { ...f, result_notes: f.result_notes || null },
                { onSuccess: () => { toast.success(f.result === "passed" ? "Wire verified" : "Verification failed recorded — funds blocked"); onOpenChange(false); }, onError: (e) => toast.error(errorMessage(e)) },
              )
            }
          >
            Record callback
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 rounded-md border border-line bg-subtle/60 p-2.5 text-xs text-ink-2">
          Instructions arrived via <span className="font-medium text-ink">{wire.instruction_source}</span>
          {wire.instruction_contact_phone ? <> with phone <span className="font-mono">{wire.instruction_contact_phone}</span></> : null}.
        </div>
        <Field label="Number called" required error={samePhone ? "This is the number on the wire instructions" : null}>
          <Input value={f.callback_phone} onChange={(e) => setF({ ...f, callback_phone: e.target.value })} />
        </Field>
        <Field label="Person reached" required><Input value={f.callback_contact_name} onChange={(e) => setF({ ...f, callback_contact_name: e.target.value })} /></Field>
        <Field label="Where the number came from" required className="col-span-2" error={sameSource ? "Must be independent of how the instructions arrived" : null} hint="e.g. Title company website, prior closing file, state bar directory">
          <Input value={f.callback_phone_source} onChange={(e) => setF({ ...f, callback_phone_source: e.target.value })} />
        </Field>
        <Field label="Result" className="col-span-2">
          <Select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })} options={[{ value: "passed", label: "Confirmed — instructions match" }, { value: "failed", label: "Not confirmed — do not send funds" }]} />
        </Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={2} value={f.result_notes} onChange={(e) => setF({ ...f, result_notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

export function WirePanel({ closing }: { closing: Closing }) {
  const { can } = useAuth();
  const { data: wires, isLoading } = useWires(closing.id);
  const [recording, setRecording] = useState(false);
  const [calling, setCalling] = useState(false);
  const editable = closing.status === "open" && can("closing", "edit");

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const current = wires?.find((w) => w.is_current) ?? null;
  const history = (wires ?? []).filter((w) => !w.is_current);
  const passed = current?.result === "passed";

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border p-3 text-sm",
          passed ? "border-positive/30 bg-positive-soft" : current?.result === "failed" ? "border-negative/30 bg-negative-soft" : "border-caution/30 bg-caution-soft",
        )}
      >
        {passed ? <ShieldCheck className="mt-0.5 size-4 text-positive" /> : <ShieldAlert className={cn("mt-0.5 size-4", current?.result === "failed" ? "text-negative" : "text-caution")} />}
        <div>
          <p className={cn("font-medium", passed ? "text-positive" : current?.result === "failed" ? "text-negative" : "text-caution")}>
            {passed ? "Wire verified by independent callback" : current?.result === "failed" ? "Wire verification failed — funding blocked" : current ? "Blocked — callback verification pending" : "Blocked — no wire instructions recorded"}
          </p>
          <p className="mt-0.5 text-ink-2">
            {passed
              ? `Verified by ${current?.verified_by_name ?? "—"} on ${formatDateTime(current?.verified_at)}.`
              : "The closing cannot complete until the current instructions pass a callback to a separately sourced number."}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Current instructions"
          actions={
            editable && (
              <>
                {current && current.result === "pending" && (
                  <Button size="sm" variant="primary" onClick={() => setCalling(true)}><PhoneCall /> Record callback</Button>
                )}
                <Button size="sm" onClick={() => setRecording(true)}><Plus /> {current ? "Replace instructions" : "Record instructions"}</Button>
              </>
            )
          }
        />
        <CardBody>
          {current ? (
            <FieldGrid cols={3}>
              <FieldItem label="Beneficiary">{current.beneficiary_name}</FieldItem>
              <FieldItem label="Bank">{current.bank_name}</FieldItem>
              <FieldItem label="Amount">{current.amount != null ? formatCurrency(current.amount) : null}</FieldItem>
              <FieldItem label="Routing"><span className="font-mono">{current.routing_number}</span></FieldItem>
              <FieldItem label="Account"><span className="font-mono">{current.account_number}</span></FieldItem>
              <FieldItem label="Received">{formatDateTime(current.received_at)}</FieldItem>
              <FieldItem label="Instruction source">{current.instruction_source}</FieldItem>
              <FieldItem label="Received from">{current.instruction_received_from}</FieldItem>
              <FieldItem label="Phone on instructions">{current.instruction_contact_phone}</FieldItem>
              <FieldItem label="Callback result"><Badge tone={wireTone(current.result)} dot>{titleCase(current.result)}</Badge></FieldItem>
              <FieldItem label="Number called">{current.callback_phone}</FieldItem>
              <FieldItem label="Callback number source">{current.callback_phone_source}</FieldItem>
              <FieldItem label="Person reached">{current.callback_contact_name}</FieldItem>
              <FieldItem label="Verifier">{current.verified_by_name}</FieldItem>
              <FieldItem label="Verified at">{current.verified_at ? formatDateTime(current.verified_at) : null}</FieldItem>
            </FieldGrid>
          ) : (
            <p className="text-sm text-ink-3">No wire instructions recorded.</p>
          )}
          {current?.result_notes && <p className="mt-4 border-t border-line pt-3 text-sm text-ink-2">{current.result_notes}</p>}
        </CardBody>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader title="Superseded instructions" description="Retained for the record; never edited" />
          <CardBody className="p-0">
            <ul className="divide-y divide-line text-sm">
              {history.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-ink">{w.bank_name} · <span className="font-mono">{w.account_number}</span></p>
                    <p className="text-xs text-ink-3">{w.instruction_source} · {formatDateTime(w.received_at)}</p>
                  </div>
                  <Badge tone={wireTone(w.result)}>{titleCase(w.result)}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <InstructionsDialog closing={closing} open={recording} onOpenChange={setRecording} replacing={!!current} />
      {current && <CallbackDialog closing={closing} wire={current} open={calling} onOpenChange={setCalling} />}
    </div>
  );
}
