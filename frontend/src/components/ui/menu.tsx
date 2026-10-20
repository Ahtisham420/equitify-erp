"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import * as P from "@radix-ui/react-popover";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const panel = "z-50 rounded-lg border border-line bg-surface p-1 shadow-pop animate-pop-in";

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({ children, align = "end", className, width = 200 }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string; width?: number }) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={4} style={{ minWidth: width }} className={cn(panel, className)}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({
  children,
  icon,
  onSelect,
  destructive,
  disabled,
  shortcut,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <DM.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none",
        "data-[highlighted]:bg-muted data-[disabled]:opacity-40 [&_svg]:size-4",
        destructive ? "text-negative" : "text-ink",
      )}
    >
      {icon && <span className={cn("flex", destructive ? "text-negative" : "text-ink-3")}>{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="text-xs text-ink-3">{shortcut}</span>}
    </DM.Item>
  );
}

export function MenuCheckItem({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <DM.CheckboxItem
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      onSelect={(e) => e.preventDefault()}
      className="flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm text-ink outline-none data-[highlighted]:bg-muted"
    >
      <span className={cn("flex size-4 items-center justify-center rounded border", checked ? "border-ink bg-ink text-white" : "border-line-strong")}>
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      {children}
    </DM.CheckboxItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wide text-ink-3">{children}</DM.Label>;
}

export function MenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-line" />;
}

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

export function PopoverContent({ children, align = "start", className }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={4} className={cn(panel, "p-0", className)}>
        {children}
      </P.Content>
    </P.Portal>
  );
}
