"use client";

import { ChevronsUpDown, LogOut, PanelLeftClose, PanelLeftOpen, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Tooltip } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-6 items-center justify-center rounded-md bg-ink text-[11px] font-bold tracking-tight text-white">EQ</span>
      {!compact && <span className="text-[15px] font-semibold tracking-tight text-ink">EquitiFy</span>}
    </div>
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname();
  const { user, can, signOut } = useAuth();

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-screen shrink-0 flex-col border-r border-line bg-subtle/70 transition-[width] duration-200",
        collapsed ? "w-[56px]" : "w-[232px]",
      )}
    >
      <div className={cn("flex h-12 items-center border-b border-line", collapsed ? "justify-center px-0" : "justify-between px-3")}>
        <Link href="/">
          <Logo compact={collapsed} />
        </Link>
        {!collapsed && (
          <button onClick={onToggle} className="rounded p-1 text-ink-3 hover:bg-muted hover:text-ink" aria-label="Collapse sidebar">
            <PanelLeftClose className="size-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
        {collapsed && (
          <button onClick={onToggle} className="mb-2 flex h-8 w-full items-center justify-center rounded-md text-ink-3 hover:bg-muted hover:text-ink" aria-label="Expand sidebar">
            <PanelLeftOpen className="size-4" />
          </button>
        )}
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.module || can(i.module));
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="mb-4">
              {!collapsed && <p className="mb-1 px-2 text-2xs font-medium uppercase tracking-wider text-ink-3">{group.label}</p>}
              <ul className="space-y-px">
                {items.map((item) => {
                  const active = isActive(item.href);
                  const link = (
                    <Link
                      href={item.href}
                      className={cn(
                        "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
                        collapsed && "justify-center px-0",
                        active ? "bg-surface font-medium text-ink shadow-card ring-1 ring-line" : "text-ink-2 hover:bg-muted hover:text-ink",
                      )}
                    >
                      <item.icon className={cn("size-4 shrink-0", active ? "text-ink" : "text-ink-3")} />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  );
                  return <li key={item.href}>{collapsed ? <Tooltip content={item.label} side="right">{link}</Tooltip> : link}</li>;
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-line p-2">
        <Menu>
          <MenuTrigger asChild>
            <button className={cn("flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-muted", collapsed && "justify-center")}>
              <Avatar name={user?.full_name} size={26} />
              {!collapsed && (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{user?.full_name}</p>
                    <p className="truncate text-2xs text-ink-3">{user?.role.name}</p>
                  </div>
                  <ChevronsUpDown className="size-3.5 text-ink-3" />
                </>
              )}
            </button>
          </MenuTrigger>
          <MenuContent align="start" width={220}>
            <MenuLabel>{user?.email}</MenuLabel>
            <MenuItem icon={<UserRound />} disabled>
              {user?.job_title ?? user?.role.name}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
              Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </aside>
  );
}
