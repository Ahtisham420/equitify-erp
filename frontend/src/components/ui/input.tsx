import { ChevronDown } from "lucide-react";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const field =
  "w-full rounded-md border border-line-strong/80 bg-surface text-sm text-ink placeholder:text-ink-3 shadow-card " +
  "transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none focus:ring-[3px] focus:ring-accent/15 " +
  "disabled:cursor-not-allowed disabled:bg-subtle disabled:text-ink-3 aria-[invalid=true]:border-negative/60";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, leading, trailing, ...props }, ref) => {
  if (!leading && !trailing) {
    return <input ref={ref} className={cn(field, "h-8 px-2.5", className)} {...props} />;
  }
  return (
    <div className={cn("relative flex items-center", className)}>
      {leading && <span className="pointer-events-none absolute left-2.5 flex text-ink-3 [&_svg]:size-4">{leading}</span>}
      <input ref={ref} className={cn(field, "h-8", leading ? "pl-8" : "pl-2.5", trailing ? "pr-9" : "pr-2.5")} {...props} />
      {trailing && <span className="absolute right-2 flex text-ink-3">{trailing}</span>}
    </div>
  );
});
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, rows = 3, ...props }, ref) => (
    <textarea ref={ref} rows={rows} className={cn(field, "min-h-[64px] resize-y px-2.5 py-1.5", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(({ className, options, placeholder, ...props }, ref) => (
  <div className={cn("relative", className)}>
    <select ref={ref} className={cn(field, "h-8 appearance-none pl-2.5 pr-8")} {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
  </div>
));
Select.displayName = "Select";

export function Label({ children, htmlFor, required, className }: { children: ReactNode; htmlFor?: string; required?: boolean; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("mb-1.5 block text-xs font-medium text-ink-2", className)}>
      {children}
      {required && <span className="ml-0.5 text-negative">*</span>}
    </label>
  );
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {error ? <p className="mt-1 text-xs text-negative">{error}</p> : hint ? <p className="mt-1 text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}
