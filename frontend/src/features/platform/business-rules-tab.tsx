import { ArrowUpRight, CalendarDays, Filter, Gauge, Map as MapIcon, Radar, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

const RULES: { title: string; description: string; href: string; icon: ReactNode }[] = [
  { title: "Roles & permissions", description: "Role profiles, module actions and approval limits.", href: "/admin/roles", icon: <Users /> },
  { title: "Territories", description: "Geographic and rule-based territories, ownership and visibility.", href: "/territories", icon: <MapIcon /> },
  { title: "Buy Boxes", description: "Versioned investment criteria and exception rules.", href: "/buy-boxes", icon: <Filter /> },
  { title: "Automation thresholds & alert rules", description: "Enable, disable and tune each automation and alert rule.", href: "/tasks?tab=automation", icon: <Gauge /> },
  { title: "Holiday calendars", description: "Business-day calendars used by the critical-date engine.", href: "/critical-dates", icon: <CalendarDays /> },
  { title: "Signal decay", description: "Signal types, half-lives, expiry and severity weighting.", href: "/signals?tab=types", icon: <Radar /> },
  { title: "Compliance rules", description: "Quiet hours, frequency and channel caps, consent and suppression settings.", href: "/compliance?tab=settings", icon: <ShieldCheck /> },
];

export function BusinessRulesTab() {
  return (
    <>
      <p className="mb-4 max-w-3xl text-sm text-ink-2">Business rules are configured without code, next to the records they govern. Every change is audited.</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {RULES.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="group flex items-start gap-3 rounded-lg border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong hover:bg-subtle/50"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-subtle text-ink-2 [&_svg]:size-4">{r.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2 text-sm font-medium text-ink">
                {r.title}
                <ArrowUpRight className="size-4 text-ink-3 transition-colors group-hover:text-ink" />
              </span>
              <span className="mt-0.5 block text-xs text-ink-3">{r.description}</span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}
