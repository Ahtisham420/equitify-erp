"use client";

import { KeyRound, Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import { useIntegrations, usePlatformMutation, type Integration, type IntegrationCategory, type TestResult } from "./api";

const STATUS_TONE: Record<Integration["status"], Tone> = {
  not_configured: "neutral",
  manual: "outline",
  active: "green",
  error: "red",
  disabled: "neutral",
};

export function IntegrationStatus({ status }: { status: Integration["status"] }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {status === "not_configured" ? "Not configured" : titleCase(status)}
    </Badge>
  );
}

export function IntegrationsTab() {
  const { can } = useAuth();
  const { data, isLoading } = useIntegrations();
  const [editing, setEditing] = useState<{ category: IntegrationCategory; integration: Integration | null } | null>(null);
  const canAdmin = can("platform", "approve");

  if (isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  return (
    <>
      <p className="mb-4 max-w-3xl text-sm text-ink-2">
        Every external system sits behind an internal provider interface, so a vendor can be replaced without changing business logic. Credentials are encrypted at rest and only ever shown masked.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((cat) => (
          <Card key={cat.key} className="flex flex-col">
            <CardHeader
              title={cat.label}
              description={`${cat.providers.length} provider${cat.providers.length === 1 ? "" : "s"} configured`}
              actions={
                canAdmin ? (
                  <Button size="xs" variant="ghost" onClick={() => setEditing({ category: cat, integration: null })}>
                    <Plus /> Add
                  </Button>
                ) : undefined
              }
            />
            <div className="flex-1 divide-y divide-line">
              {cat.providers.length === 0 && <p className="px-4 py-3 text-sm text-ink-3">No provider configured.</p>}
              {cat.providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setEditing({ category: cat, integration: p })}
                  className="flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-subtle/70"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                      {p.label ?? p.provider}
                      {p.is_primary && <Badge tone="blue">Primary</Badge>}
                    </p>
                    <p className="truncate text-xs text-ink-3">
                      {p.last_error ? (
                        <span className="text-negative">{p.last_error}</span>
                      ) : p.last_success_at ? (
                        `Last success ${formatRelative(p.last_success_at)}`
                      ) : (
                        "Never tested"
                      )}
                    </p>
                  </div>
                  <IntegrationStatus status={p.status} />
                </button>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {editing && (
        <IntegrationSheet
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          category={editing.category}
          integration={editing.integration}
          readOnly={!canAdmin}
        />
      )}
    </>
  );
}

interface CredRow {
  key: string;
  value: string;
  stored: boolean;
}

function IntegrationSheet({
  open,
  onOpenChange,
  category,
  integration,
  readOnly,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  category: IntegrationCategory;
  integration: Integration | null;
  readOnly: boolean;
}) {
  const [provider, setProvider] = useState(integration?.provider ?? category.options[0]?.name ?? "manual");
  const option = useMemo(() => category.options.find((o) => o.name === provider), [category.options, provider]);
  const [label, setLabel] = useState(integration?.label ?? "");
  const [config, setConfig] = useState("{}");
  const [restrictions, setRestrictions] = useState(integration?.usage_restrictions ?? "");
  const [primary, setPrimary] = useState(integration?.is_primary ?? category.providers.length === 0);
  const [status, setStatus] = useState<string>(integration?.status ?? "not_configured");
  const [creds, setCreds] = useState<CredRow[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    const baseConfig: Record<string, unknown> = { ...(integration?.config ?? {}) };
    for (const k of option?.required_config ?? []) if (!(k in baseConfig)) baseConfig[k] = "";
    setConfig(JSON.stringify(baseConfig, null, 2));
    const stored = Object.keys(integration?.credentials ?? {});
    const keys = Array.from(new Set([...stored, ...(option?.required_credentials ?? [])]));
    setCreds(keys.map((k) => ({ key: k, value: "", stored: stored.includes(k) })));
    setRemoved([]);
    setTest(null);
  }, [integration, option]);

  const save = usePlatformMutation(async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config || "{}");
    } catch {
      throw new Error("Configuration must be valid JSON");
    }
    const entered = Object.fromEntries(creds.filter((c) => c.key.trim() && c.value).map((c) => [c.key.trim(), c.value]));
    if (!integration) {
      return api.post<Integration>("/platform/integrations", {
        category: category.key,
        provider,
        label: label || null,
        config: parsed,
        credentials: entered,
        usage_restrictions: restrictions || null,
        is_primary: primary,
      });
    }
    const updated = await api.patch<Integration>(`/platform/integrations/${integration.id}`, {
      label: label || null,
      config: parsed,
      usage_restrictions: restrictions || null,
      is_primary: primary,
      ...(status !== integration.status ? { status } : {}),
    });
    if (Object.keys(entered).length || removed.length) {
      return api.put<Integration>(`/platform/integrations/${integration.id}/credentials`, { credentials: entered, remove_keys: removed });
    }
    return updated;
  });

  const runTest = usePlatformMutation((id: string) => api.post<TestResult>(`/platform/integrations/${id}/test`));
  const archive = usePlatformMutation((id: string) => api.delete(`/platform/integrations/${id}`));

  const onSave = () =>
    save.mutate(undefined, {
      onSuccess: () => {
        toast.success(integration ? "Integration updated" : "Integration added");
        onOpenChange(false);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={integration ? integration.label ?? integration.provider : `Add ${category.label.toLowerCase()} provider`}
      description={category.label}
      footer={
        readOnly ? undefined : (
          <>
            {integration && integration.provider !== "manual" && (
              <Button
                variant="ghost"
                className="mr-auto text-negative"
                loading={archive.isPending}
                onClick={() =>
                  archive.mutate(integration.id, {
                    onSuccess: () => {
                      toast.success("Integration archived");
                      onOpenChange(false);
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  })
                }
              >
                <Trash2 /> Archive
              </Button>
            )}
            {integration && (
              <Button
                loading={runTest.isPending}
                onClick={() =>
                  runTest.mutate(integration.id, {
                    onSuccess: (r) => {
                      setTest(r);
                      if (r.ok) toast.success("Connection test passed");
                      else toast.error("Connection test failed");
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  })
                }
              >
                <Plug /> Test connection
              </Button>
            )}
            <Button variant="primary" loading={save.isPending} onClick={onSave}>
              Save
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {test && (
          <div className={test.ok ? "rounded-md border border-positive/30 bg-positive-soft px-3 py-2 text-sm text-positive" : "rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-sm text-negative"}>
            {test.message}
          </div>
        )}

        {integration ? (
          <div className="grid grid-cols-2 gap-3 rounded-md border border-line bg-subtle/60 p-3 text-xs">
            <div>
              <p className="text-ink-3">Provider</p>
              <p className="font-medium text-ink">{integration.provider}</p>
            </div>
            <div>
              <p className="text-ink-3">Status</p>
              <IntegrationStatus status={integration.status} />
            </div>
            <div>
              <p className="text-ink-3">Last success</p>
              <p className="text-ink">{formatDateTime(integration.last_success_at)}</p>
            </div>
            <div>
              <p className="text-ink-3">Last tested</p>
              <p className="text-ink">{formatDateTime(integration.last_tested_at)}</p>
            </div>
            {integration.last_error && (
              <div className="col-span-2">
                <p className="text-ink-3">Last error ({formatDateTime(integration.last_error_at)})</p>
                <p className="text-negative">{integration.last_error}</p>
              </div>
            )}
          </div>
        ) : (
          <Field label="Provider" required hint={option?.description ?? "A vendor adapter must be registered for live calls."}>
            <Select value={provider} onChange={(e) => setProvider(e.target.value)} options={category.options.map((o) => ({ value: o.name, label: o.label }))} disabled={readOnly} />
          </Field>
        )}

        <Field label="Display name">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={option?.label} disabled={readOnly} />
        </Field>

        {integration && (
          <Field label="Status">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              disabled={readOnly}
              options={[
                { value: "not_configured", label: "Not configured" },
                { value: "manual", label: "Manual" },
                { value: "active", label: "Active" },
                { value: "disabled", label: "Disabled" },
                ...(integration.status === "error" ? [{ value: "error", label: "Error" }] : []),
              ]}
            />
          </Field>
        )}

        <Field label="Configuration (JSON)" hint={option?.required_config.length ? `Required: ${option.required_config.join(", ")}` : "Non-secret settings only."}>
          <Textarea rows={6} value={config} onChange={(e) => setConfig(e.target.value)} className="font-mono text-xs" disabled={readOnly} />
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
              <KeyRound className="size-3.5" /> Credentials
              {integration && integration.credentials_version > 0 && (
                <span className="font-normal text-ink-3">
                  · version {integration.credentials_version}
                  {integration.credentials_rotated_at ? `, rotated ${formatRelative(integration.credentials_rotated_at)}` : ""}
                </span>
              )}
            </span>
            {!readOnly && (
              <Button size="xs" variant="ghost" onClick={() => setCreds((c) => [...c, { key: "", value: "", stored: false }])}>
                <Plus /> Key
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {creds.length === 0 && <p className="text-sm text-ink-3">No credentials required.</p>}
            {creds.map((c, i) => {
              const isRemoved = removed.includes(c.key);
              return (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={c.key}
                    disabled={c.stored || readOnly}
                    onChange={(e) => setCreds((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    placeholder="key"
                    className="w-40 font-mono text-xs"
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={c.value}
                    disabled={readOnly || isRemoved}
                    onChange={(e) => setCreds((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    placeholder={c.stored ? `${integration?.credentials[c.key] ?? "stored"} (leave blank to keep)` : "value"}
                    className="flex-1"
                  />
                  {c.stored && !readOnly && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={isRemoved ? "Keep credential" : "Remove credential"}
                      onClick={() => setRemoved((r) => (isRemoved ? r.filter((k) => k !== c.key) : [...r, c.key]))}
                      className={isRemoved ? "text-negative" : undefined}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-ink-3">Values are encrypted at rest, never displayed again and every rotation is audited.</p>
        </div>

        <Field label="Usage restrictions" hint="License terms, permitted use, redistribution limits.">
          <Textarea rows={3} value={restrictions} onChange={(e) => setRestrictions(e.target.value)} disabled={readOnly} />
        </Field>

        <label className="flex items-center gap-2 text-sm text-ink">
          <Checkbox checked={primary} onChange={setPrimary} label="Primary provider" />
          Primary provider for {category.label.toLowerCase()}
        </label>
      </div>
    </Sheet>
  );
}
