import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "xs" | "sm" | "md" | "icon" | "icon-sm";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-ink/90 border border-ink shadow-card",
  accent: "bg-accent text-white hover:bg-accent/90 border border-accent shadow-card",
  secondary: "bg-surface text-ink border border-line-strong/80 hover:bg-subtle shadow-card",
  ghost: "text-ink-2 hover:bg-muted hover:text-ink border border-transparent",
  danger: "bg-negative text-white hover:bg-negative/90 border border-negative shadow-card",
};

const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-xs gap-1 rounded",
  sm: "h-7 px-2.5 text-sm gap-1.5 rounded-md",
  md: "h-8 px-3 text-sm gap-1.5 rounded-md",
  icon: "h-8 w-8 rounded-md",
  "icon-sm": "h-7 w-7 rounded-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", loading, disabled, children, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
