export const fmtUSD = (n: number, opts?: { compact?: boolean; sign?: boolean }) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : opts?.sign ? "+" : "";
  if (opts?.compact && abs >= 1000) {
    return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: abs >= 1e6 ? 2 : 0 })}`;
  }
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export const fmtUSDShort = (n: number) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
};

export const fmtPct = (n: number, digits = 2) => {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(n * 100).toFixed(digits)}%`;
};

export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
};

export const fmtDatetime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export const fmtTimeAgo = (iso: string) => {
  const d = new Date(iso).getTime();
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

// ------ Terminal formatters ------

const MINUS = "−";

/** Plain number with fixed decimals; null → em dash. */
export const fmtNum = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : `${n < 0 ? MINUS : ""}${Math.abs(n).toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}`;

/** Price: 2 decimals (4 under $1). */
export const fmtPx = (n: number | null | undefined) =>
  n == null ? "—" : fmtNum(n, Math.abs(n) < 1 ? 4 : 2);

/** Signed fractional change as percent: 0.0123 → "+1.23%". */
export const fmtChg = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n * 100).toFixed(digits)}%`;

/** Signed dollars: +$1,234 / −$56.20. */
export const fmtSignedUSD = (n: number | null | undefined, digits = 0) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : `${n > 0 ? "+" : n < 0 ? MINUS : ""}$${Math.abs(n).toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}`;

/** Compact big numbers: 1.2T / 345.6B / 12.3M / 4.5K. */
export const fmtBig = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? MINUS : "";
  if (a >= 1e12) return `${s}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}K`;
  return `${s}${a.toFixed(0)}`;
};

/** "up" | "down" | "flat" class for a signed value. */
export const tone = (n: number | null | undefined, eps = 0) =>
  n == null || !Number.isFinite(n) || Math.abs(n) <= eps ? "flat" : n > 0 ? "up" : "down";

/** Compact relative age: 42s / 7m / 3h / 2d. */
export const fmtAge = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return "—";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/** HH:MM in a given IANA zone. */
export const fmtClock = (d: Date, tz: string, seconds = false) =>
  d.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hour12: false,
  });

/** "Oct 07 14:32" in ET. */
export const fmtET = (iso: string | null | undefined, withDate = true) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  if (!withDate) return t;
  const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });
  return `${day} ${t}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Short date: "Oct 07". Timestamps are shown in ET; bare trading dates
 * ("2026-10-07") are shown as-is — parsing them with `new Date()` would read
 * midnight UTC and display the previous day in New York.
 */
export const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const m = DATE_ONLY.exec(iso);
  if (m) return `${MONTHS[+m[2] - 1]} ${m[3]}`;
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });
};
