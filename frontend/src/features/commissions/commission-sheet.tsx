"use client";

import { AlertTriangle, Ban, Check, CheckCircle2, FileText, Pencil, Receipt, ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FieldGrid, FieldItem } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, titleCase, toNumber } from "@/lib/utils";

import { STATUS_TONES, useCommission, useCommissionAction, useCommissionEvents, useVoidInvoice, type Commission, type Invoice } from "./api";
import { CommissionFormSheet } from "./commission-form";

export function CStatus({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? "neutral"} dot>
      {titleCase(status)}
    </Badge>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

const STEPS = ["forecast", "earned", "invoiced", "paid"];

function Steps({ c }: { c: Commission }) {
  const idx = STEPS.indexOf(c.status);
  return (
    <div className="flex items-center gap-1 text-xs">
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-1">
          {i > 0 && <span className={cn("h-px w-6", i <= idx ? "bg-ink" : "bg-line-strong")} />}
          <span className={cn("rounded px-1.5 py-0.5", i < idx ? "text-ink-2" : i === idx ? "bg-ink font-medium text-white" : "text-ink-3")}>{titleCase(s)}</span>
        </div>
      ))}
      {c.status === "cancelled" && <Badge className="ml-2">Cancelled</Badge>}
    </div>
  );
}

type DialogKind = "earn" | "invoice" | "payment" | "release" | "cancel" | "approve" | null;

export function CommissionSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const { data: c, isLoading } = useCommission(id);
  const events = useCommissionEvents(id);
  const action = useCommissionAction(id ?? "");
  const voidInv = useVoidInvoice();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [editing, setEditing] = useState(false);
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [accept, setAccept] = useState(false);

  const open = (kind: DialogKind, defaults: Record<string, string> = {}) => {
    setF(defaults);
    setAccept(false);
    setDialog(kind);
  };
  const v = (k: string) => f[k] ?? "";
  const setV = (k: string, val: string) => setF((x) => ({ ...x, [k]: val }));

  const run = (name: "earn" | "approve" | "cancel" | "invoices" | "payments" | "release", body: unknown, msg: string) =>
    action.mutate(
      { action: name, body },
      {
        onSuccess: () => {
          toast.success(msg);
          setDialog(null);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const confirm = () => {
    if (!c) return;
    if (dialog === "earn") run("earn", { earned_on: v("date") || null, note: v("note") || null }, "Commission marked earned");
    if (dialog === "approve") run("approve", { note: v("note") || null }, "Commission approved");
    if (dialog === "cancel") run("cancel", { reason: v("note") }, "Commission cancelled");
    if (dialog === "invoice")
      run("invoices", { bill_to: v("bill_to"), issued_on: v("issued") || null, due_on: v("due") || null, amount: toNumber(v("amount")), memo: v("note") || null }, "Invoice issued");
    if (dialog === "payment")
      run("payments", { amount: toNumber(v("amount")), received_on: v("date") || today(), reference: v("reference") || null, method: v("method") || null, note: v("note") || null }, "Payment recorded");
    if (dialog === "release") run("release", { accept_discrepancy: accept, note: v("note") || null }, "Commission released as paid");
  };

  const canEdit = can("commissions", "edit");
  const canApprove = can("commissions", "approve");

  return (
    <Sheet
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      className="max-w-3xl"
      title={c?.title ?? "Commission"}
      description={c ? [c.agent_name, c.side ? titleCase(c.side) : null, c.deal?.label].filter(Boolean).join(" · ") : undefined}
      footer={
        c && (
          <>
            {["forecast", "earned"].includes(c.status) && canEdit && !c.restricted && (
              <Button variant="ghost" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {["forecast", "earned"].includes(c.status) && canEdit && (
              <Button variant="ghost" onClick={() => open("cancel")}>
                <Ban /> Cancel
              </Button>
            )}
            {c.status === "forecast" && canEdit && (
              <Button variant="primary" onClick={() => open("earn", { date: today() })}>
                <Check /> Mark earned
              </Button>
            )}
            {["earned", "invoiced"].includes(c.status) && !c.approved_at && canApprove && (
              <Button onClick={() => open("approve")}>
                <ShieldCheck /> Approve
              </Button>
            )}
            {c.status === "earned" && canEdit && (
              <Button variant="primary" onClick={() => open("invoice", { issued: today(), due: c.expected_on ?? "", amount: String(c.gross) })}>
                <Receipt /> Issue invoice
              </Button>
            )}
            {c.status === "invoiced" && canEdit && (
              <Button onClick={() => open("payment", { date: today(), amount: String(Math.max(0, c.gross - c.paid_total)) })}>
                <Wallet /> Record payment
              </Button>
            )}
            {c.status === "invoiced" && canApprove && (
              <Button variant="primary" onClick={() => open("release")}>
                <CheckCircle2 /> Release as paid
              </Button>
            )}
          </>
        )
      }
    >
      {isLoading || !c ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Steps c={c} />
            <div className="text-right">
              <p className="text-xs text-ink-3">{c.restricted ? "Your net" : "Gross commission"}</p>
              <p className="text-xl font-semibold tabular">{formatCurrency(c.restricted ? c.my_net : c.gross)}</p>
            </div>
          </div>

          <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", c.compliance.complete ? "border-positive/30 bg-positive-soft text-positive" : "border-caution/30 bg-caution-soft text-caution")}>
            {c.compliance.complete ? <ShieldCheck className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
            <div>
              <p className="font-medium">{c.compliance.complete ? "Transaction file complete — release allowed" : "Release blocked until the transaction file is complete"}</p>
              {!c.compliance.complete && c.compliance.reasons.length > 0 && <p className="text-xs">{c.compliance.reasons.join("; ")}</p>}
            </div>
          </div>

          <Card>
            <CardBody>
              <FieldGrid cols={3}>
                <FieldItem label="Transaction value">{c.deal_volume != null ? formatCurrency(c.deal_volume) : null}</FieldItem>
                <FieldItem label="Gross commission">{formatCurrency(c.gross)}</FieldItem>
                <FieldItem label="Probability">{c.probability != null ? `${formatNumber(c.probability, 0)}%` : null}</FieldItem>
                <FieldItem label="Expected close">{c.expected_close_on ? formatDate(c.expected_close_on) : null}</FieldItem>
                <FieldItem label="Expected payment">{c.expected_on ? formatDate(c.expected_on) : null}</FieldItem>
                <FieldItem label="Earned">{c.earned_on ? formatDate(c.earned_on) : null}</FieldItem>
                <FieldItem label="Paid">{c.paid_on ? formatDate(c.paid_on) : null}</FieldItem>
                <FieldItem label="Approved">{c.approved_at ? formatDateTime(c.approved_at) : "Not approved"}</FieldItem>
                <FieldItem label="Transaction stage">{c.deal?.stage ? titleCase(c.deal.stage) : null}</FieldItem>
                <FieldItem label="Property type">{c.property_type ? titleCase(c.property_type) : null}</FieldItem>
                <FieldItem label="Source">{c.source}</FieldItem>
                {!c.restricted && <FieldItem label="Referral">{c.referral_party ? `${c.referral_party} · ${formatCurrency(c.calc.referral ?? 0)}` : null}</FieldItem>}
              </FieldGrid>
            </CardBody>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title={c.restricted ? "Your split" : "Split structure"} description={c.restricted ? undefined : `Net GCI after referral ${formatCurrency(c.calc.net_gci ?? 0)} · house ${formatCurrency(c.house_amount ?? 0)}`} />
            <table className="w-full text-sm">
              <thead className="bg-subtle text-xs text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Party</th>
                  <th className="px-3 py-2 text-right font-medium">Share</th>
                  <th className="px-3 py-2 text-right font-medium">GCI</th>
                  <th className="px-3 py-2 text-right font-medium">Agent %</th>
                  <th className="px-3 py-2 text-right font-medium">Split</th>
                  <th className="px-3 py-2 text-right font-medium">Deductions</th>
                  <th className="px-3 py-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {c.splits.map((s) => (
                  <tr key={s.id} className="border-t border-line">
                    <td className="px-3 py-1.5">
                      <span className="font-medium">{s.agent_name ?? s.label ?? titleCase(s.role)}</span>{" "}
                      <span className="text-xs text-ink-3">{titleCase(s.role)}{s.detail?.plan ? ` · ${s.detail.plan}` : ""}</span>
                      {s.capped && <Badge tone="green" className="ml-1">Capped</Badge>}
                      {s.detail?.bands?.some((b) => b.override) && <Badge tone="amber" className="ml-1">Override</Badge>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular">{s.share_pct != null ? `${formatNumber(s.share_pct, 2)}%` : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular">{s.gci_amount ? formatCurrency(s.gci_amount) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular">{s.agent_pct != null ? `${formatNumber(s.agent_pct, 2)}%` : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular">{formatCurrency(s.amount)}</td>
                    <td className="px-3 py-1.5 text-right tabular">{s.deductions ? formatCurrency(-s.deductions) : "—"}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular">{formatCurrency(s.net_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Invoices & payments"
              description={`Paid ${formatCurrency(c.paid_total)} of ${formatCurrency(c.gross)}`}
              actions={<CStatus status={c.reconciliation_status} />}
            />
            <div className="divide-y divide-line">
              {c.invoices.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <div>
                    <p className="font-medium">{inv.invoice_number} <span className="font-normal text-ink-3">· {inv.bill_to}</span></p>
                    <p className="text-xs text-ink-3">Issued {formatDate(inv.issued_on)} · due {formatDate(inv.due_on)}{inv.void_reason ? ` · void: ${inv.void_reason}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular">{formatCurrency(inv.amount)}</span>
                    <CStatus status={inv.status} />
                    <Button size="xs" variant="ghost" onClick={() => setViewInvoice(inv)}>
                      <FileText className="!size-3.5" /> View
                    </Button>
                    {inv.status === "issued" && canApprove && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          const reason = window.prompt("Reason for voiding this invoice");
                          if (reason && reason.trim().length >= 3)
                            voidInv.mutate({ id: inv.id, reason: reason.trim() }, { onSuccess: () => toast.success("Invoice voided"), onError: (e) => toast.error(errorMessage(e)) });
                        }}
                      >
                        Void
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {c.payments.map((p) => (
                <div key={p.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <div>
                    <p>Payment received {formatDate(p.received_on)}</p>
                    <p className="text-xs text-ink-3">{[p.method, p.reference, p.note].filter(Boolean).join(" · ") || "—"}</p>
                  </div>
                  <span className="font-medium tabular">{formatCurrency(p.amount)}</span>
                </div>
              ))}
              {!c.invoices.length && !c.payments.length && <p className="px-4 py-3 text-sm text-ink-3">No invoice yet. A commission must be earned before it can be invoiced.</p>}
            </div>
            {c.reconciliation_status !== "unpaid" && c.reconciliation_status !== "matched" && (
              <p className="border-t border-line bg-negative-soft px-4 py-2 text-sm text-negative">
                Discrepancy {formatCurrency(c.discrepancy)} between paid and expected — release requires acceptance with a note.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="History" />
            <CardBody className="space-y-2">
              {(events.data ?? []).map((e) => (
                <div key={e.id} className="flex items-start justify-between gap-3 text-sm">
                  <div>
                    <p className="text-ink">
                      {titleCase(e.action)}
                      {e.to_status && e.from_status !== e.to_status ? <span className="text-ink-3"> → {titleCase(e.to_status)}</span> : null}
                    </p>
                    {e.note && <p className="text-xs text-ink-3">{e.note}</p>}
                  </div>
                  <span className="whitespace-nowrap text-xs text-ink-3">{e.actor_name ?? "System"} · {formatDateTime(e.at)}</span>
                </div>
              ))}
              {!events.data?.length && <p className="text-sm text-ink-3">No history yet.</p>}
            </CardBody>
          </Card>
        </div>
      )}

      <Dialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          { earn: "Mark commission earned", approve: "Approve commission", cancel: "Cancel commission", invoice: "Issue invoice", payment: "Record payment", release: "Release as paid" }[dialog ?? "earn"]
        }
        description={
          dialog === "earn"
            ? "Splits are recalculated with the agent's YTD GCI at the time it is earned."
            : dialog === "release"
              ? "Requires an approved, invoiced commission with payment received and a complete transaction file."
              : dialog === "cancel"
                ? "The record is retained with your reason."
                : undefined
        }
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Back</Button>
            <Button
              variant={dialog === "cancel" ? "danger" : "primary"}
              loading={action.isPending}
              disabled={(dialog === "cancel" && v("note").trim().length < 3) || (dialog === "invoice" && !v("bill_to").trim()) || (dialog === "payment" && !toNumber(v("amount")))}
              onClick={confirm}
            >
              Confirm
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          {dialog === "earn" && (
            <Field label="Earned on (closing date)">
              <Input type="date" value={v("date")} onChange={(e) => setV("date", e.target.value)} />
            </Field>
          )}
          {dialog === "invoice" && (
            <>
              <Field label="Bill to" required className="col-span-2">
                <Textarea rows={2} value={v("bill_to")} onChange={(e) => setV("bill_to", e.target.value)} placeholder="Paying party and address" />
              </Field>
              <Field label="Issued">
                <Input type="date" value={v("issued")} onChange={(e) => setV("issued", e.target.value)} />
              </Field>
              <Field label="Due">
                <Input type="date" value={v("due")} onChange={(e) => setV("due", e.target.value)} />
              </Field>
              <Field label="Amount">
                <Input inputMode="decimal" value={v("amount")} onChange={(e) => setV("amount", e.target.value)} />
              </Field>
            </>
          )}
          {dialog === "payment" && (
            <>
              <Field label="Amount">
                <Input inputMode="decimal" value={v("amount")} onChange={(e) => setV("amount", e.target.value)} />
              </Field>
              <Field label="Received on">
                <Input type="date" value={v("date")} onChange={(e) => setV("date", e.target.value)} />
              </Field>
              <Field label="Method">
                <Input value={v("method")} onChange={(e) => setV("method", e.target.value)} placeholder="Wire, check…" />
              </Field>
              <Field label="Reference">
                <Input value={v("reference")} onChange={(e) => setV("reference", e.target.value)} />
              </Field>
            </>
          )}
          {dialog === "release" && c && (
            <div className="col-span-2 space-y-2 text-sm">
              <p className="flex justify-between"><span className="text-ink-3">Expected</span><span className="tabular">{formatCurrency(c.gross)}</span></p>
              <p className="flex justify-between"><span className="text-ink-3">Received</span><span className="tabular">{formatCurrency(c.paid_total)}</span></p>
              <p className="flex justify-between"><span className="text-ink-3">Reconciliation</span><CStatus status={c.reconciliation_status} /></p>
              {c.reconciliation_status !== "matched" && (
                <label className="flex items-center gap-2 text-ink-2">
                  <Checkbox checked={accept} onChange={setAccept} /> Accept the {formatCurrency(c.discrepancy)} discrepancy (note required)
                </label>
              )}
            </div>
          )}
          <Field label={dialog === "cancel" ? "Reason" : "Note"} required={dialog === "cancel"} className="col-span-2">
            <Textarea rows={2} value={v("note")} onChange={(e) => setV("note", e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog open={!!viewInvoice} onOpenChange={(o) => !o && setViewInvoice(null)} title={viewInvoice?.invoice_number ?? "Invoice"} className="max-w-2xl">
        <pre className="whitespace-pre-wrap rounded-md border border-line bg-subtle p-3 font-mono text-xs text-ink">{viewInvoice?.rendered_text}</pre>
      </Dialog>

      {c && <CommissionFormSheet open={editing} onOpenChange={setEditing} commission={c} />}
    </Sheet>
  );
}
