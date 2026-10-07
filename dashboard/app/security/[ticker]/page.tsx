"use client";

/**
 * Security screen — Bloomberg DES + GP + CN + EVTS + our position, for one
 * ticker. Reached from the command line: `NVDA` → /security/NVDA, and
 * `NVDA GP|DES|CN|EVTS|FLOW` → the same page with #gp/#des/… which scrolls
 * to and flashes the matching panel.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNow } from "@/components/term/ui";
import { thesisState } from "@/components/term/security/thesisStatus";
import { api, term, type UniverseRow } from "@/lib/api";
import { Panel, Skeleton } from "@/components/term/ui";
import { SecurityHeader, type Profile } from "@/components/term/security/SecurityHeader";
import { SecurityChart } from "@/components/term/security/SecurityChart";
import { LevelsPanel, PositionPanel } from "@/components/term/security/PositionPanel";
import { BotReasoning } from "@/components/term/security/BotReasoning";
import { SecDes, SecEvents, SecFlow, SecNews } from "@/components/term/security/SecPanels";
import { etDate, is404 } from "@/components/term/security/util";
import s from "@/components/term/security/security.module.css";

const SLOTS = ["gp", "pos", "bot", "cn", "flow", "evts", "des"] as const;
const ALIAS: Record<string, string> = { lvl: "pos", n: "cn", news: "cn", bltr: "bot", askb: "bot", ee: "evts", erns: "evts" };

/**
 * Watches location.hash (Next's router.push to the same path with a new
 * fragment doesn't fire `hashchange`, so we also poll cheaply) and returns
 * the slot to highlight, plus a nonce so repeats re-trigger the animation.
 */
function useHashFocus(ready: boolean) {
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!ready) return;
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const raw = window.location.hash.replace(/^#/, "").toLowerCase();
      if (raw === last) return;
      last = raw;
      const id = ALIAS[raw] ?? raw;
      if (!(SLOTS as readonly string[]).includes(id)) return;
      document.getElementById(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setFocus({ id, n: Date.now() });
      clearTimeout(timer);
      timer = setTimeout(() => setFocus(null), 2600);
    };
    check();
    const iv = setInterval(check, 250);
    window.addEventListener("hashchange", check);
    window.addEventListener("popstate", check);
    return () => {
      clearInterval(iv);
      clearTimeout(timer);
      window.removeEventListener("hashchange", check);
      window.removeEventListener("popstate", check);
    };
  }, [ready]);
  return focus;
}

function Slot({ id, focus, flex = "1 1 0", children }: { id: string; focus: { id: string; n: number } | null; flex?: string; children: ReactNode }) {
  const on = focus?.id === id;
  return (
    <div id={id} className={`${s.slot}${on ? ` ${s.focus}` : ""}`} style={{ flex }}>
      {children}
    </div>
  );
}

export default function SecurityPage() {
  const params = useParams<{ ticker: string }>();
  const T = decodeURIComponent(params?.ticker ?? "").trim().toUpperCase();

  const q = useQuery({
    queryKey: ["security", T],
    queryFn: () => term.security(T),
    enabled: !!T,
    refetchInterval: 60_000,
    retry: (n, err) => !is404(err) && n < 1,
  });
  const data = q.data;
  const needProfile = !!data && !data.profile;
  const pq = useQuery({
    queryKey: ["company", T],
    queryFn: () => api.company(T),
    enabled: needProfile,
    retry: false,
    staleTime: 6 * 3600_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const profile: Profile | null = data?.profile ?? (pq.data ? { ...pq.data } : null);

  // CN's primary source: Yahoo's per-ticker feed (cached 15 min server-side).
  const newsQ = useQuery({
    queryKey: ["sec-news", T],
    queryFn: () => term.securityNews(T),
    enabled: !!data,
    retry: false,
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    refetchOnWindowFocus: false,
  });
  const focus = useHashFocus(!!data);

  // Is the bot's thesis still live? Expired (catalyst passed / bot off) → BOT
  // collapses to one line and its space goes to live news.
  const now = useNow(60_000);
  const { data: bot } = useQuery({ queryKey: ["bot-status"], queryFn: api.botStatus, refetchInterval: 30_000 });
  const tState = useMemo(() => (data ? thesisState(data, bot, now) : null), [data, bot, now]);
  const [botPick, setBotPick] = useState<boolean | null>(null);
  const botOpen = botPick ?? !(tState?.expired ?? false);

  useEffect(() => {
    if (T) document.title = `${T} US Equity · Cromaz Terminal`;
  }, [T]);

  if (q.isError && is404(q.error)) return <NotFound ticker={T} />;
  if (q.isError && !data) {
    return (
      <Panel code="DES" title={T} style={{ minHeight: 320 }}>
        <div className="panel-empty">
          <div className="down" style={{ marginBottom: 8 }}>Couldn’t load {T}: {(q.error as Error).message}</div>
          <button type="button" className="btn" onClick={() => q.refetch()}>
            Retry
          </button>
        </div>
      </Panel>
    );
  }
  if (!data) return <Loading ticker={T} />;

  const last = data.quote?.last ?? data.position?.market_price ?? null;
  const pos = data.position;
  // Position levels are drawn from the day it opened (or its first buy fill).
  const firstBuy = [...data.trades].reverse().find((t) => t.side === "buy");
  const openedOn = pos?.opened_at ? etDate(pos.opened_at) : firstBuy ? etDate(firstBuy.filled_at ?? firstBuy.submitted_at) : null;
  // Held or ever traded → the side column (POS + BOT) runs full height and the
  // deck sits under the chart; otherwise the deck spans the page.
  const tall = !!pos || data.decisions.length > 0 || data.trades.length > 0;
  const hasThesis = data.decisions.length > 0;
  // Collapsed reasoning hands the side column's spare height to the news.
  const newsInSide = tall && hasThesis && !botOpen;
  const nNews = (newsQ.data?.items.length ?? 0) + data.news.length;
  const hasEps = data.earnings.history.length > 0;
  const deckCols = [
    ...(newsInSide ? [] : [nNews || newsQ.isLoading ? 1.25 : 0.7]),
    data.signals.length ? 1 : 0.7,
    1.05,
  ]
    .map((f) => `minmax(0, ${f}fr)`)
    .join(" ");

  const news = <SecNews data={data} yahoo={newsQ.data} profileName={profile?.name ?? null} loading={newsQ.isLoading} />;

  return (
    <div key={data.ticker} className={`${s.page}${tall ? "" : ` ${s.wide}`}`} data-testid="security-page">
      <SecurityHeader data={data} profile={profile} />
      <div className={s.gpArea} style={{ display: "flex", minHeight: 0, minWidth: 0 }}>
        <Slot id="gp" focus={focus}>
          <SecurityChart
            ticker={data.ticker}
            series={data.series}
            spy={data.spy_series}
            trades={data.trades}
            levels={pos ? { avg: pos.avg_cost, stop: pos.stop_price, cut: pos.midday_cut_price, peak: pos.peak_price, from: openedOn } : null}
            api={{
              ret: { "1M": data.quote?.chg_1m, "3M": data.quote?.chg_3m, YTD: data.quote?.chg_ytd, "1Y": data.quote?.chg_1y },
              mdd1y: data.stats.max_dd_1y,
              rel3m: data.stats.rel_spy_3m,
            }}
          />
        </Slot>
      </div>
      <div className={s.side} style={{ display: "flex", flexDirection: "column" }}>
        <Slot id="pos" focus={focus} flex="0 0 auto">
          {pos ? <PositionPanel pos={pos} last={last} trades={data.trades} /> : <LevelsPanel data={data} />}
        </Slot>
        <Slot id="bot" focus={focus} flex={newsInSide ? "0 0 auto" : "1 1 0"}>
          <BotReasoning data={data} last={last} state={tState} collapsed={hasThesis && !botOpen} onToggle={() => setBotPick(!botOpen)} />
        </Slot>
        {newsInSide && (
          <Slot id="cn" focus={focus}>
            {news}
          </Slot>
        )}
      </div>
      <div className={s.deck} style={{ gridTemplateColumns: deckCols }}>
        {!newsInSide && (
          <Slot id="cn" focus={focus}>
            {news}
          </Slot>
        )}
        <Slot id="flow" focus={focus}>
          <SecFlow data={data} />
        </Slot>
        {/* EVTS + DES share a column: earnings rows first, description clamped below. */}
        <div className={s.stack}>
          <Slot id="evts" focus={focus} flex={hasEps ? "1 1 0" : "0 0 auto"}>
            <SecEvents data={data} />
          </Slot>
          <Slot id="des" focus={focus} flex={hasEps ? "0 0 auto" : "1 1 0"}>
            <SecDes data={data} profile={profile} loading={needProfile && pq.isLoading} lines={hasEps ? 3 : "fit"} />
          </Slot>
        </div>
      </div>
    </div>
  );
}

// ── loading / not found ─────────────────────────────────────────────────

function Loading({ ticker }: { ticker: string }) {
  return (
    <div className={s.page} aria-busy="true">
      <div className={s.hdr} style={{ height: 78, padding: 10, gap: 10 }}>
        <div className="skel" style={{ width: 250 }} />
        <div className="skel" style={{ width: 180 }} />
        <div className="skel" style={{ width: 190 }} />
        <div className="skel" style={{ flex: 1 }} />
      </div>
      <div className={s.gpArea} style={{ display: "flex", minHeight: 0 }}>
        <div className={s.slot} style={{ flex: 1 }}>
          <Panel code="GP" title={`${ticker} US Equity`}>
            <div className="skel" style={{ height: "100%", opacity: 0.45 }} />
          </Panel>
        </div>
      </div>
      <div className={s.side}>
        <div className={s.slot}>
          <Panel code="POS" title="Position">
            <Skeleton rows={6} />
          </Panel>
        </div>
        <div className={s.slot}>
          <Panel code="BOT" title="Reasoning & fills">
            <Skeleton rows={8} />
          </Panel>
        </div>
      </div>
      <div className={s.deck} style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {[
          ["CN", "Company news"],
          ["FLOW", "Insider flow"],
          ["EVTS", "Earnings"],
          ["DES", "Description"],
        ].map(([c, t]) => (
          <div key={c} className={s.slot}>
            <Panel code={c} title={t}>
              <Skeleton rows={5} />
            </Panel>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Edit distance, capped — good enough to suggest "did you mean". */
function dist(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function NotFound({ ticker }: { ticker: string }) {
  const { data: universe } = useQuery({ queryKey: ["universe"], queryFn: term.universe, refetchInterval: 300_000, staleTime: 120_000 });
  const near = useMemo(() => {
    const u = universe ?? [];
    return u
      .map((r) => ({ r, d: dist(ticker, r.ticker) - (r.ticker[0] === ticker[0] ? 0.5 : 0) }))
      .filter((x) => x.d <= 2)
      .sort((a, b) => a.d - b.d)
      .slice(0, 8)
      .map((x) => x.r);
  }, [universe, ticker]);
  const held = (universe ?? []).filter((r) => r.held);
  const Chip = ({ r }: { r: UniverseRow }) => (
    <Link
      href={`/security/${encodeURIComponent(r.ticker)}`}
      style={{ display: "inline-flex", gap: 8, alignItems: "baseline", padding: "4px 8px", border: "1px solid var(--line-2)", background: "var(--bg-2)" }}
    >
      <span className={`tkr${r.held ? " held" : ""}`}>{r.ticker}</span>
      <span style={{ color: "var(--ink-3)", fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
    </Link>
  );
  return (
    <div className={s.nf} data-testid="security-not-found">
      <Panel code="DES" title={`${ticker || "—"} · no data`} className={s.nfCard}>
        <div style={{ padding: "10px 6px 4px", display: "grid", gap: 14 }}>
          <div>
            <div className="num" style={{ fontSize: 26, color: "var(--ink)", fontWeight: 600 }}>
              {ticker} <span style={{ fontSize: 11, color: "var(--amber)", letterSpacing: "0.06em" }}>US EQUITY</span>
            </div>
            <p style={{ color: "var(--ink-2)", fontSize: 12.5, lineHeight: 1.5, margin: "6px 0 0" }}>
              The terminal has no price history, position, decisions or news for <span className="tkr">{ticker}</span>, and it isn’t in the
              bot’s tracked universe. Press <span className="cmd-kbd">/</span> and type a ticker — e.g.{" "}
              <span className="num amber">NVDA GP</span>, <span className="num amber">AAPL DES</span>, <span className="num amber">V CN</span>.
            </p>
          </div>
          {near.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Did you mean</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {near.map((r) => (
                  <Chip key={r.ticker} r={r} />
                ))}
              </div>
            </div>
          )}
          {held.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Held positions</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {held.map((r) => (
                  <Chip key={r.ticker} r={r} />
                ))}
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
