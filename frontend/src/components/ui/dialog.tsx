"use client";

import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, className }: BaseProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink/25 animate-fade-in" />
        <D.Content
          className={cn(
            "fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 rounded-xl border border-line bg-surface shadow-pop animate-pop-in focus:outline-none",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
            <div>
              <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1 text-sm text-ink-2">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
              )}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </D.Close>
          </div>
          {children && <div className="max-h-[65vh] overflow-y-auto px-5 pb-4 scrollbar-thin">{children}</div>}
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-subtle/60 px-5 py-3 rounded-b-xl">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Sheet({ open, onOpenChange, title, description, children, footer, className }: BaseProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink/20 animate-fade-in" />
        <D.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-sheet animate-slide-in focus:outline-none",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <D.Title className="truncate text-base font-semibold text-ink">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-sm text-ink-2">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === "string" ? title : "Panel"}</D.Description>
              )}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-subtle/60 px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      className="max-w-md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? "danger" : "primary"} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
