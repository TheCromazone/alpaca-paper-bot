"use client";

/**
 * The terminal chrome: TopBar (brand · command line · session · clocks ·
 * bot heartbeat), FnBar (function tabs, Alt+1..7) and the fixed StatusBar
 * (scrolling universe tape · API latency · data as-of · regime).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, api, term, type UniverseRow } from "@/lib/api";
import { fmtAge, fmtChg, fmtClock, fmtPx, tone } from "@/lib/format";
import { BOT_STALE_MS, marketSession, useNow } from "./ui";

export const FUNCTIONS = [
  { key: "1", code: "LP", label: "Launchpad", href: "/", alias: ["HOME", "LP", "LAUNCHPAD"] },
  { key: "2", code: "PORT", label: "Portfolio", href: "/positions", alias: ["PORT", "POS", "POSITIONS", "HOLDINGS"] },
  { key: "3", code: "BLTR", label: "Blotter", href: "/trades", alias: ["BLTR", "TRADES", "ORDERS", "BLOTTER"] },
  { key: "4", code: "TOP", label: "News", href: "/news", alias: ["TOP", "NEWS", "CN", "N"] },
  { key: "5", code: "FLOW", label: "Insider flow", href: "/signals", alias: ["FLOW", "SIGNALS", "INSIDER", "PTR", "13F"] },
  { key: "6", code: "BOT", label: "The machine", href: "/bot", alias: ["BOT", "ASKB", "LLM", "ROUTINES", "MACHINE"] },
  { key: "7", code: "RISK", label: "Risk", href: "/risk", alias: ["RISK", "MARS", "VAR", "GUARDS"] },
] as const;

const SEC_FUNCS = ["GP", "DES", "CN", "EVTS", "FLOW"] as const;

type Suggestion = { kind: "fn" | "sec"; code: string; label: string; meta: string; href: string };

function resolve(raw: string, universe: UniverseRow[] | undefined): Suggestion[] {
  const q = raw.trim().toUpperCase();
  if (!q) return [];
  const [head, tail] = q.split(/\s+/, 2);
  const out: Suggestion[] = [];
  const rows = universe ?? [];
  const exact = rows.find((r) => r.ticker === head);
  // Rank: an exact function mnemonic, then an exact ticker ("V GP" is Visa's
  // chart, not the VAR alias), then prefix matches. Single letters only
  // prefix-match tickers — "V" must not pull up every alias starting with V.
  const fnExact = FUNCTIONS.filter((f) => f.alias.some((a) => a === head));
  const fnPrefix = FUNCTIONS.filter(
    (f) =>
      !fnExact.includes(f) &&
      ((head.length >= 2 && f.alias.some((a) => a.startsWith(head))) || (q.length >= 3 && f.label.toUpperCase().includes(q))),
  );
  const fnRow = (f: (typeof FUNCTIONS)[number]): Suggestion => ({ kind: "fn", code: f.code, label: f.label, meta: `function · ${f.key}`, href: f.href });
  const secFn = tail && SEC_FUNCS.find((s) => s.startsWith(tail));
  const hash = secFn ? `#${secFn.toLowerCase()}` : "";
  if (!tail || !exact) out.push(...fnExact.map(fnRow));
  const starts = rows.filter((r) => r.ticker !== head && r.ticker.startsWith(head));
  const named = head.length >= 2 ? rows.filter((r) => !r.ticker.startsWith(head) && r.name.toUpperCase().includes(q)) : [];
  for (const r of [...(exact ? [exact] : []), ...starts, ...named].slice(0, 8)) {
    out.push({
      kind: "sec",
      code: r.ticker,
      label: r.name,
      meta: `${r.held ? "HELD · " : ""}${r.sector}${secFn ? ` · ${secFn}` : ""}`,
      href: `/security/${encodeURIComponent(r.ticker)}${hash}`,
    });
  }
  // Any ticker-shaped input is still a valid security lookup.
  if (!exact && !fnExact.length && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(head)) {
    out.push({ kind: "sec", code: head, label: "Look up security", meta: "outside tracked universe", href: `/security/${encodeURIComponent(head)}${hash}` });
  }
  if (!tail) out.push(...fnPrefix.map(fnRow));
  return out.slice(0, 10);
}

function CommandLine() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const { data: universe } = useQuery({ queryKey: ["universe"], queryFn: term.universe, refetchInterval: 300_000, staleTime: 120_000 });
  const items = useMemo(() => resolve(value, universe), [value, universe]);

  const go = useCallback(
    (s?: Suggestion) => {
      const target = s ?? items[sel] ?? items[0];
      if (!target) return;
      router.push(target.href);
      setValue("");
      setOpen(false);
      inputRef.current?.blur();
    },
    [items, sel, router],
  );

  // Global hotkeys: "/" focuses the command line; Alt+1..7 jump to functions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      // Match the physical key (e.code): on macOS Option+2 yields e.key "™".
      const digit = /^Digit([1-7])$/.exec(e.code)?.[1];
      if (e.altKey && digit) {
        const f = FUNCTIONS.find((x) => x.key === digit);
        if (f) {
          e.preventDefault();
          router.push(f.href);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div className="cmd">
      <span className="cmd-prompt">&gt;</span>
      <input
        ref={inputRef}
        className="cmd-input"
        value={value}
        placeholder="Ticker or function — NVDA GP · PORT · TOP · RISK"
        aria-label="Command line"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value);
          setSel(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go();
          } else if (e.key === "Escape") {
            setValue("");
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      <span className="cmd-kbd hide-sm">/</span>
      <button type="button" className="cmd-go" onMouseDown={(e) => e.preventDefault()} onClick={() => go()}>
        GO
      </button>
      {open && items.length > 0 && (
        <div className="cmd-pop" role="listbox">
          {items.map((s, i) => (
            <div
              key={`${s.kind}-${s.code}-${i}`}
              role="option"
              aria-selected={i === sel}
              className="cmd-item"
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                go(s);
              }}
            >
              <span className="num" style={{ color: s.kind === "fn" ? "var(--amber)" : "var(--ink)", fontWeight: 600 }}>
                {s.code}
              </span>
              <span style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
              <span className="label" style={{ color: "var(--ink-4)" }}>{s.meta}</span>
            </div>
          ))}
          <div className="label" style={{ padding: "5px 10px", color: "var(--ink-4)" }}>
            ↑↓ select · enter go · esc clear · alt+1–7 functions
          </div>
        </div>
      )}
    </div>
  );
}

function Clocks() {
  const now = useNow(1000);
  const d = new Date(now || 0);
  const zones = [
    ["NY", "America/New_York"],
    ["LDN", "Europe/London"],
    ["TKY", "Asia/Tokyo"],
  ] as const;
  return (
    <div className="top-cell hide-md" suppressHydrationWarning>
      {zones.map(([k, tz], i) => (
        <span key={k} style={{ display: "inline-flex", gap: 5, alignItems: "baseline" }}>
          <span className="label" style={{ color: i === 0 ? "var(--amber)" : "var(--ink-3)" }}>{k}</span>
          <span className="num" style={{ color: i === 0 ? "var(--ink)" : "var(--ink-2)", fontSize: i === 0 ? 12.5 : 11.5 }}>
            {now ? fmtClock(d, tz, i === 0) : "--:--"}
          </span>
        </span>
      ))}
    </div>
  );
}

function Session() {
  const now = useNow(15_000);
  const s = marketSession(now);
  return (
    <div className="top-cell hide-sm">
      <span className={`pill ${s.tone === "up" ? "up" : s.tone === "warn" ? "warn" : ""}`}>
        <span className={`dot${s.tone === "up" ? " live" : ""}`} />
        NYSE {s.label}
      </span>
      <span className="num dim" style={{ fontSize: 10.5 }}>{s.detail}</span>
    </div>
  );
}


function Heartbeat() {
  const now = useNow(10_000);
  const { data } = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });
  const run = data?.last_llm_run;
  const stale = !!run && !!now && now - new Date(run.started_at).getTime() > BOT_STALE_MS;
  const failed = !!run && run.status !== "ok";
  const color = stale || failed ? "var(--down)" : "var(--up)";
  return (
    <Link
      href="/bot"
      className="top-cell hide-md"
      title={run ? `Last routine: ${run.routine} (${run.status})${stale ? " — bot looks stopped" : ""}` : "No routine has run"}
    >
      <span className="label cyan">BOT</span>
      {run ? (
        <span className="num" style={{ fontSize: 11, color: "var(--ink-2)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className={`dot${stale || failed ? "" : " live"}`} style={{ color: stale || failed ? "var(--alert)" : color }} />
          {run.routine} {now ? `${fmtAge(run.started_at, now)} ago` : ""}
          {stale && <span className="pill alert">Stale</span>}
          {failed && !stale && <span className="pill alert">{run.status}</span>}
        </span>
      ) : (
        <span className="num dim">—</span>
      )}
    </Link>
  );
}

export function TopBar() {
  return (
    <header className="topbar">
      <Link href="/" className="brand" aria-label="Cromaz Terminal home">
        <span className="brand-mark">C</span>
        <span className="brand-name">CROMAZ</span>
        <span className="brand-sub hide-sm">TERMINAL</span>
      </Link>
      <CommandLine />
      <Session />
      <Clocks />
      <Heartbeat />
      <div className="top-cell">
        <span className="pill amber">Paper</span>
      </div>
    </header>
  );
}

export function FnBar() {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="fnbar" aria-label="Functions">
      {FUNCTIONS.map((f) => (
        <Link key={f.code} href={f.href} className="fn" aria-current={active(f.href) ? "page" : undefined}>
          <span className="fn-key">{f.key}</span>
          <span className="fn-code">{f.code}</span>
          <span>{f.label}</span>
        </Link>
      ))}
      {path.startsWith("/security/") && (
        <span className="fn" aria-current="page">
          <span className="fn-code">DES</span>
          <span>{decodeURIComponent(path.split("/")[2] ?? "")}</span>
        </span>
      )}
      <span className="fn-spacer" />
    </nav>
  );
}

function useApiLatency() {
  const [ms, setMs] = useState<number | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const t0 = performance.now();
      try {
        const r = await fetch(`${API_BASE}/health`, { cache: "no-store" });
        if (!alive) return;
        setOk(r.ok);
        setMs(Math.round(performance.now() - t0));
      } catch {
        if (!alive) return;
        setOk(false);
        setMs(null);
      }
    };
    ping();
    const id = setInterval(ping, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return { ms, ok };
}

type TapeItem = { ticker: string; last: number | null; chg_1d: number | null; held: boolean };

/**
 * The universe tape, paged instead of scrolled: a flex row that wraps into a
 * fixed one-line box shows only symbols that fit whole (no clipped
 * fragments at the edges), and every few seconds it pages to the next set.
 * Held names lead. Hover pauses paging.
 */
function Tape({ items }: { items: TapeItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(0);
  const [paused, setPaused] = useState(false);
  const n = items.length;
  const page = useMemo(() => (n ? [...items.slice(start % n), ...items.slice(0, start % n)] : []), [items, start, n]);

  useEffect(() => {
    if (!n || paused) return;
    const id = setInterval(() => {
      const el = ref.current;
      if (!el || !el.children.length) return;
      const top = (el.children[0] as HTMLElement).offsetTop;
      let visible = 0;
      for (const c of Array.from(el.children)) {
        if ((c as HTMLElement).offsetTop !== top) break;
        visible += 1;
      }
      setStart((s) => (s + Math.max(1, visible)) % n);
    }, 6000);
    return () => clearInterval(id);
  }, [n, paused]);

  return (
    <div className="tape" aria-label="Universe tape" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="tape-page" ref={ref} key={start}>
        {page.map((c) => (
          <Link key={c.ticker} href={`/security/${encodeURIComponent(c.ticker)}`} className="num tape-item">
            <span style={{ color: c.held ? "var(--blue)" : "var(--ink)", fontWeight: 600 }}>{c.ticker}</span>
            <span style={{ color: "var(--ink-2)" }}>{fmtPx(c.last)}</span>
            <span className={tone(c.chg_1d)}>{fmtChg(c.chg_1d)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function StatusBar() {
  const { data: heat } = useQuery({ queryKey: ["heatmap"], queryFn: term.heatmap, refetchInterval: 60_000 });
  const { data: regime } = useQuery({ queryKey: ["regime"], queryFn: api.regime, refetchInterval: 300_000, retry: false });
  const { ms, ok } = useApiLatency();
  const cells = (heat?.cells ?? []).filter((c) => c.chg_1d != null);
  const ordered = [...cells.filter((c) => c.held), ...cells.filter((c) => !c.held)];
  const label = regime?.regime_label?.replace("_", " ").toUpperCase();
  const rTone = regime?.regime_label === "risk_on" ? "up" : regime?.regime_label === "risk_off" ? "down" : "";
  return (
    <footer className="statusbar">
      <div className="seg" style={{ borderLeft: 0 }}>
        <span className="label amber">TAPE</span>
        {heat && (
          <span className="num" style={{ fontSize: 10.5 }}>
            <span className="up">▲{heat.advancers}</span> <span className="down">▼{heat.decliners}</span>
            {heat.unchanged != null && <span className="dim"> ={heat.unchanged}</span>}
          </span>
        )}
      </div>
      <Tape items={ordered} />
      <div className="seg hide-sm">
        <span className="label">API</span>
        <span className="dot" style={{ color: ok == null ? "var(--ink-4)" : ok ? "var(--up)" : "var(--down)" }} />
        <span className="num">{ms != null ? `${ms}ms` : ok === false ? "down" : "…"}</span>
      </div>
      <div className="seg hide-sm">
        <span className="label">Close</span>
        <span className="num">{heat?.as_of ?? "—"}</span>
      </div>
      {label && (
        <div className="seg">
          <span className="label">Regime</span>
          <span className={`num ${rTone}`} style={{ fontWeight: 600 }}>{label}</span>
        </div>
      )}
    </footer>
  );
}
