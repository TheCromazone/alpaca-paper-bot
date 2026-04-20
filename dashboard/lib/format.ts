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
