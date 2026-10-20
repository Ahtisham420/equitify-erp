"use client";

import Link from "next/link";
import { useState } from "react";

import { StatCard } from "@/components/data/page";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/utils";

import { relatedHref } from "@/features/tasks/api";

import { CHANNEL_LABELS, CHANNELS, useTeamActivity } from "./api";

function isoDay(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Manager view: activity metrics, overdue follow-ups and stale / untouched records per user. */
export function TeamActivity() {
  const [from, setFrom] = useState(isoDay(-7));
  const [to, setTo] = useState(isoDay(0));
  const { data, isLoading, error } = useTeamActivity({ date_from: from, date_to: to }, true);
  const rows = data?.rows ?? [];
  const sum = (k: "total" | "meaningful" | "overdue_follow_ups" | "stale_records" | "untouched_records") => rows.reduce((a, r) => a + r[k], 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        <span className="text-ink-3">–</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
      </div>
      {error ? (
        <p className="text-sm text-negative">{errorMessage(error)}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Interactions" value={formatNumber(sum("total"))} />
            <StatCard label="Meaningful conversations" value={formatNumber(sum("meaningful"))} />
            <StatCard label="Overdue follow-ups" value={formatNumber(sum("overdue_follow_ups"))} tone={sum("overdue_follow_ups") ? "negative" : "default"} />
            <StatCard label="Stale records (90+ days)" value={formatNumber(sum("stale_records"))} tone={sum("stale_records") ? "caution" : "default"} />
            <StatCard label="Never touched" value={formatNumber(sum("untouched_records"))} />
          </div>
          <Card>
            <CardHeader title="Activity by user" />
            {isLoading ? (
              <div className="p-4">
                <Skeleton className="h-32 w-full" />
              </div>
            ) : rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">No activity in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-subtle text-left text-xs text-ink-3">
                      <th className="px-4 py-2 font-medium">User</th>
                      <th className="px-3 py-2 text-right font-medium">Total</th>
                      <th className="px-3 py-2 text-right font-medium">Meaningful</th>
                      {CHANNELS.map((c) => (
                        <th key={c} className="px-3 py-2 text-right font-medium">{CHANNEL_LABELS[c]}</th>
                      ))}
                      <th className="px-3 py-2 text-right font-medium">Connect rate</th>
                      <th className="px-3 py-2 text-right font-medium">Overdue</th>
                      <th className="px-3 py-2 text-right font-medium">Stale</th>
                      <th className="px-3 py-2 text-right font-medium">Untouched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const calls = r.by_channel.call ?? 0;
                      const connected = r.by_disposition.connected ?? 0;
                      return (
                        <tr key={r.user_id} className="border-b border-line last:border-0">
                          <td className="px-4 py-2 font-medium text-ink">{r.user_name}</td>
                          <td className="px-3 py-2 text-right tabular">{formatNumber(r.total)}</td>
                          <td className="px-3 py-2 text-right tabular">{formatNumber(r.meaningful)}</td>
                          {CHANNELS.map((c) => (
                            <td key={c} className="px-3 py-2 text-right tabular text-ink-2">{formatNumber(r.by_channel[c] ?? 0)}</td>
                          ))}
                          <td className="px-3 py-2 text-right tabular">{calls ? `${Math.round((connected / calls) * 100)}%` : "—"}</td>
                          <td className={`px-3 py-2 text-right tabular ${r.overdue_follow_ups ? "font-medium text-negative" : ""}`}>{formatNumber(r.overdue_follow_ups)}</td>
                          <td className="px-3 py-2 text-right tabular">{formatNumber(r.stale_records)}</td>
                          <td className="px-3 py-2 text-right tabular">{formatNumber(r.untouched_records)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="Overdue follow-ups" description="Oldest first" />
            {!data?.overdue.length ? (
              <p className="px-4 py-6 text-center text-sm text-ink-3">No overdue follow-ups.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.overdue.map((t) => {
                  const href = relatedHref(t.related_type, t.related_id);
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <Link href={`/tasks?task=${t.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
                        {t.title}
                      </Link>
                      {t.related_label && (href ? <Link href={href} className="truncate text-xs text-accent hover:underline">{t.related_label}</Link> : <span className="text-xs text-ink-3">{t.related_label}</span>)}
                      <span className="text-xs text-ink-2">{t.assignee_name ?? "Unassigned"}</span>
                      <span className="text-xs text-negative">{formatDate(t.due_at)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
