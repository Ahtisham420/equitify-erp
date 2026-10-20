"use client";

import { Copy, RefreshCw, Send, Webhook } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DataTable, type Column } from "@/components/data/data-table";
import { FacetFilter, FilterChips, SearchInput, Toolbar } from "@/components/data/filters";
import { EmptyState, ListCard } from "@/components/data/page";
import { TableFooter } from "@/components/data/table-footer";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useListQuery } from "@/hooks/use-list-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatRelative } from "@/lib/utils";

import { useSubscriptions, usePlatformMutation, useWebhookEvents, type WebhookDelivery, type WebhookSubscription } from "./api";

const DELIVERY_STATUSES = ["pending", "sending", "delivered", "failed", "dead"];
const DELIVERY_LABEL: Record<string, string> = { pending: "Pending", sending: "Sending", delivered: "Delivered", failed: "Retrying", dead: "Dead letter" };

function DeliveryStatus({ status }: { status: WebhookDelivery["status"] }) {
  if (status === "dead") return <Badge tone="red" dot>Dead letter</Badge>;
  if (status === "failed") return <Badge tone="amber" dot>Retrying</Badge>;
  if (status === "sending") return <Badge tone="sky" dot>Sending</Badge>;
  return <StatusBadge status={status === "delivered" ? "success" : "pending"} label={DELIVERY_LABEL[status]} />;
}

export function WebhooksTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const canAdmin = can("platform", "approve");
  const subs = useSubscriptions();
  const [editing, setEditing] = useState<WebhookSubscription | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);

  const deliver = usePlatformMutation(() => api.post<{ attempted: number; delivered: number; failed: number; dead: number }>("/platform/webhooks/deliver-pending"));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Subscriptions"
          description="Domain events are written to an outbox inside the business transaction and delivered afterwards with an HMAC-SHA256 signature (X-EquitiFy-Signature: t=timestamp,v1=hex of HMAC(secret, timestamp.body))."
        />
        {subs.data && subs.data.length === 0 ? (
          <EmptyState
            icon={<Webhook />}
            title="No webhook subscriptions"
            description="Subscribe an external system to property, pipeline, transaction, lease, debt, compliance and signal events."
            action={canAdmin ? <Button variant="primary" onClick={() => onCreatingChange(true)}>New subscription</Button> : undefined}
          />
        ) : (
          <div className="divide-y divide-line">
            {subs.data?.map((s) => (
              <div key={s.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">
                    {s.name}
                    {!s.active && <Badge>Paused</Badge>}
                    {s.consecutive_failures > 0 && <Badge tone="amber">{s.consecutive_failures} consecutive failures</Badge>}
                  </p>
                  <p className="truncate font-mono text-xs text-ink-3">{s.url}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-3">{s.events.includes("*") ? "All events" : s.events.join(", ")}</p>
                </div>
                <span className="hidden whitespace-nowrap text-xs text-ink-3 md:block">{s.last_delivery_at ? `Last delivery ${formatRelative(s.last_delivery_at)}` : "No deliveries yet"}</span>
                {canAdmin && (
                  <div className="flex shrink-0 gap-1">
                    <TestButton sub={s} />
                    <Button size="sm" onClick={() => setEditing(s)}>Edit</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <DeliveriesList
        actions={
          canAdmin ? (
            <Button
              loading={deliver.isPending}
              onClick={() =>
                deliver.mutate(undefined, {
                  onSuccess: (r) => toast.success(`${r.attempted} attempted · ${r.delivered} delivered · ${r.failed} retrying · ${r.dead} dead`),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              <Send /> Deliver pending now
            </Button>
          ) : undefined
        }
      />

      <SubscriptionSheet open={creating} onOpenChange={onCreatingChange} onSecret={setSecret} />
      <SubscriptionSheet open={!!editing} onOpenChange={(o) => !o && setEditing(null)} sub={editing} onSecret={setSecret} />
      <Dialog
        open={!!secret}
        onOpenChange={(o) => !o && setSecret(null)}
        title="Signing secret"
        description={`Copy the secret for ${secret?.name ?? "this subscription"} now. It will not be shown again.`}
        footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}
      >
        <div className="flex items-center gap-2">
          <Input readOnly value={secret?.secret ?? ""} className="font-mono text-xs" />
          <Button
            size="icon"
            aria-label="Copy secret"
            onClick={() => {
              if (secret) void navigator.clipboard?.writeText(secret.secret);
              toast.success("Copied");
            }}
          >
            <Copy />
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function TestButton({ sub }: { sub: WebhookSubscription }) {
  const test = usePlatformMutation(() => api.post<{ queued: number }>(`/platform/webhooks/subscriptions/${sub.id}/test`));
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={test.isPending}
      disabled={!sub.active}
      onClick={() =>
        test.mutate(undefined, {
          onSuccess: () => toast.success("Test event queued. Run delivery to send it."),
          onError: (e) => toast.error(errorMessage(e)),
        })
      }
    >
      Send test
    </Button>
  );
}

function DeliveriesList({ actions }: { actions?: ReactNode }) {
  const { can } = useAuth();
  const list = useListQuery<WebhookDelivery>("platform", "/platform/webhooks/deliveries");
  const { url } = list;
  const statuses = url.getAll("status");
  const retry = usePlatformMutation((id: string) => api.post<WebhookDelivery>(`/platform/webhooks/deliveries/${id}/retry`));
  const [open, setOpen] = useState<WebhookDelivery | null>(null);

  const columns: Column<WebhookDelivery>[] = [
    { id: "event", header: "Event", cell: (d) => <span className="font-mono text-xs text-ink">{d.event}</span> },
    { id: "subscription", header: "Subscription", cell: (d) => <span className="text-ink-2">{d.subscription_name ?? "—"}</span> },
    { id: "status", header: "Status", cell: (d) => <DeliveryStatus status={d.status} /> },
    { id: "attempts", header: "Attempts", align: "right", cell: (d) => d.attempts },
    { id: "code", header: "Response", align: "right", cell: (d) => (d.last_status_code ?? "—") },
    {
      id: "when",
      header: "Created",
      cell: (d) => <span className="whitespace-nowrap text-ink-3">{formatDateTime(d.created_at)}</span>,
    },
    {
      id: "next",
      header: "Next attempt",
      cell: (d) => <span className="whitespace-nowrap text-ink-3">{d.status === "failed" || d.status === "pending" ? formatRelative(d.next_attempt_at) : "—"}</span>,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (d) =>
        can("platform", "approve") && (d.status === "dead" || d.status === "failed") ? (
          <Button
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              retry.mutate(d.id, {
                onSuccess: () => toast.success("Delivery re-queued"),
                onError: (err) => toast.error(errorMessage(err)),
              });
            }}
          >
            <RefreshCw /> Retry
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <ListCard
        toolbar={
          <div className="space-y-2">
            <Toolbar right={actions}>
              <SearchInput value={(url.params.q as string) ?? ""} onChange={(v) => url.set({ q: v })} placeholder="Search event or error" shortcut={false} />
              <FacetFilter label="Status" options={DELIVERY_STATUSES.map((s) => ({ value: s, label: DELIVERY_LABEL[s] }))} selected={statuses} onChange={(v) => url.set({ status: v })} />
            </Toolbar>
            <FilterChips
              chips={statuses.map((s) => ({ key: `status:${s}`, label: "Status", value: DELIVERY_LABEL[s] ?? s, onRemove: () => url.set({ status: statuses.filter((x) => x !== s) }) }))}
              onClear={() => url.set({ status: null, q: null })}
            />
          </div>
        }
        footer={<TableFooter page={list.page} pageSize={list.pageSize} total={list.data?.total ?? 0} onPage={(p) => url.set({ page: p }, { resetPage: false })} onPageSize={(s) => url.set({ page_size: s })} />}
      >
        <DataTable
          columns={columns}
          data={list.data?.items}
          loading={list.isLoading}
          fetching={list.isFetching}
          onRowClick={(d) => setOpen(d)}
          dense
          empty={<EmptyState icon={<Send />} title="No deliveries" description="Deliveries appear here when subscribed events occur." />}
        />
      </ListCard>
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.event ?? "Delivery"} description={open?.subscription_name ?? undefined}>
        {open && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <DeliveryStatus status={open.status} />
              <span className="text-ink-3">{open.attempts} attempt(s)</span>
            </div>
            {open.last_error && <p className="rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-negative">{open.last_error}</p>}
            <pre className="max-h-[50vh] overflow-auto rounded-md border border-line bg-subtle p-3 font-mono text-xs text-ink scrollbar-thin">{JSON.stringify(open.payload, null, 2)}</pre>
          </div>
        )}
      </Sheet>
    </>
  );
}

function SubscriptionSheet({
  open,
  onOpenChange,
  sub,
  onSecret,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sub?: WebhookSubscription | null;
  onSecret: (s: { name: string; secret: string }) => void;
}) {
  const events = useWebhookEvents();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(sub?.name ?? "");
    setTarget(sub?.url ?? "");
    setSelected(sub?.events ?? []);
    setActive(sub?.active ?? true);
  }, [open, sub]);

  const save = usePlatformMutation(() =>
    sub
      ? api.patch<WebhookSubscription>(`/platform/webhooks/subscriptions/${sub.id}`, { name, url: target, events: selected, active })
      : api.post<WebhookSubscription>("/platform/webhooks/subscriptions", { name, url: target, events: selected, active }),
  );
  const rotate = usePlatformMutation((id: string) => api.post<WebhookSubscription>(`/platform/webhooks/subscriptions/${id}/rotate-secret`));
  const archive = usePlatformMutation((id: string) => api.delete(`/platform/webhooks/subscriptions/${id}`));

  const all = selected.includes("*");
  const toggle = (e: string) => setSelected((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur.filter((x) => x !== "*"), e]));

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={sub ? sub.name : "New webhook subscription"}
        footer={
          <>
            {sub && (
              <>
                <Button variant="ghost" className="mr-auto text-negative" onClick={() => setConfirmArchive(true)}>
                  Archive
                </Button>
                <Button
                  loading={rotate.isPending}
                  onClick={() =>
                    rotate.mutate(sub.id, {
                      onSuccess: (r) => r.secret && onSecret({ name: r.name, secret: r.secret }),
                      onError: (e) => toast.error(errorMessage(e)),
                    })
                  }
                >
                  Rotate secret
                </Button>
              </>
            )}
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!name.trim() || !/^https?:\/\//.test(target) || selected.length === 0}
              onClick={() =>
                save.mutate(undefined, {
                  onSuccess: (r) => {
                    toast.success(sub ? "Subscription updated" : "Subscription created");
                    onOpenChange(false);
                    if (r.secret) onSecret({ name: r.name, secret: r.secret });
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Endpoint URL" required hint="HTTPS is strongly recommended outside development.">
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://example.com/hooks/equitify" className="font-mono text-xs" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            <Checkbox checked={active} onChange={setActive} label="Active" /> Active
          </label>
          <Field label="Events" required>
            <div className="space-y-1.5 rounded-md border border-line p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <Checkbox checked={all} onChange={(c) => setSelected(c ? ["*"] : [])} label="All events" /> All events
              </label>
              {(events.data ?? []).map((e) => (
                <label key={e} className="flex items-center gap-2 font-mono text-xs text-ink-2">
                  <Checkbox checked={all || selected.includes(e)} onChange={() => !all && toggle(e)} label={e} />
                  {e}
                </label>
              ))}
            </div>
          </Field>
        </div>
      </Sheet>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive subscription"
        description="Pending deliveries for this subscription will be dead-lettered."
        destructive
        confirmLabel="Archive"
        loading={archive.isPending}
        onConfirm={() =>
          sub &&
          archive.mutate(sub.id, {
            onSuccess: () => {
              toast.success("Subscription archived");
              setConfirmArchive(false);
              onOpenChange(false);
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}
