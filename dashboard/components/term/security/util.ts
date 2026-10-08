/**
 * Small, dependency-free helpers for the security screen: timezone-safe
 * handling of date-only strings, ET trade dates, nice axis ticks.
 */

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "2026-10-07" → [2026, 10, 7] without ever touching a timezone. */
export function ymd(s: string): [number, number, number] {
  const [y, m, d] = s.slice(0, 10).split("-").map((p) => parseInt(p, 10));
  return [y, m, d];
}

/** Day number (UTC epoch days) for a date-only string — safe arithmetic. */
export function dayNum(s: string): number {
  const [y, m, d] = ymd(s);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Shift a date-only string by whole months, clamping the day (Mar 31 − 1M → Feb 28). */
export function addMonths(s: string, months: number): string {
  const [y, m, d] = ymd(s);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

export function weekday(s: string): number {
  const [y, m, d] = ymd(s);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

let curYear: number | null = null;
/** This year in New York (computed on first use; these components only render client-side with data). */
function thisYear(): number {
  if (curYear == null) curYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date()));
  return curYear;
}

/**
 * The screen's ONE date format: "Oct 07", with " '25" appended for any other
 * year. `long` prefixes the weekday ("Thu Sep 03"). Legacy style names map here.
 */
export function fmtD(s: string | null | undefined, style: "dmy" | "md" | "long" | "my" | "dm" = "md"): string {
  if (!s) return "—";
  const [y, m, d] = ymd(s);
  const yy = y === thisYear() ? "" : ` ’${String(y).slice(2)}`;
  const base = `${MONTHS[m - 1]} ${String(d).padStart(2, "0")}`;
  if (style === "my") return `${MONTHS[m - 1]} ’${String(y).slice(2)}`;
  if (style === "long") return `${WEEKDAYS[weekday(s)]} ${base}${yy}`;
  return `${base}${yy}`;
}

const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ISO timestamp → its trading date in New York, "YYYY-MM-DD". */
export function etDate(iso: string): string {
  return ET_DATE.format(new Date(iso));
}

/** Round step for ~`count` ticks across `span` (1/2/2.5/5 × 10^k). */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const k = n < 1.5 ? 1 : n < 2.25 ? 2 : n < 3.5 ? 2.5 : n < 7.5 ? 5 : 10;
  return k * mag;
}

export function niceTicks(min: number, max: number, count: number): { ticks: number[]; step: number } {
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return { ticks: out, step };
}

/** Decimal places that make a tick step readable (2.5 → 1, 0.25 → 2). */
export function stepDigits(step: number): number {
  for (let d = 0; d <= 4; d++) {
    const s = step * Math.pow(10, d);
    if (Math.abs(Math.round(s) - s) < 1e-6) return d;
  }
  return 4;
}

/** Exchange codes from yfinance → what a trader calls them. */
export function exchangeName(code: string | null | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    NYQ: "NYSE",
    NYS: "NYSE",
    NMS: "NASDAQ GS",
    NGM: "NASDAQ GM",
    NCM: "NASDAQ CM",
    NAS: "NASDAQ",
    ASE: "NYSE American",
    PCX: "NYSE Arca",
    BTS: "Cboe BZX",
    PNK: "OTC",
  };
  return map[code.toUpperCase()] ?? code;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** True when a react-query error came from a 404 (api.get throws "API … → 404"). */
export function is404(err: unknown): boolean {
  return err instanceof Error && /→ 404$/.test(err.message);
}

/**
 * Whole calendar days from today (New York) to a report date. The API stores
 * report dates as 00:00 UTC of the report day, so the date part is read as-is
 * (never shifted into ET, which would land on the previous evening).
 */
export function daysUntil(reportIso: string, now: number): number {
  return dayNum(reportIso.slice(0, 10)) - dayNum(etDate(new Date(now).toISOString()));
}
