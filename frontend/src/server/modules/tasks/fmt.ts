/** Minimal strftime for UTC dates (`%b %d, %Y %H:%M`, ...), matching the Python f-string formats used in messages. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

export function strftime(value: Date | string, fmt: string): string {
  const d = typeof value === "string" ? new Date(value.length === 10 ? `${value}T00:00:00Z` : value) : value;
  return fmt.replace(/%([bdYmHMS])/g, (_m, c: string) => {
    switch (c) {
      case "b": return MONTHS[d.getUTCMonth()];
      case "d": return p2(d.getUTCDate());
      case "Y": return String(d.getUTCFullYear());
      case "m": return p2(d.getUTCMonth() + 1);
      case "H": return p2(d.getUTCHours());
      case "M": return p2(d.getUTCMinutes());
      default: return p2(d.getUTCSeconds());
    }
  });
}

/** Python `date.today()` as YYYY-MM-DD. */
export const today = () => new Date().toISOString().slice(0, 10);
