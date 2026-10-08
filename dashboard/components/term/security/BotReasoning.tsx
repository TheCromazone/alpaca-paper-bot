"use client";

/**
 * BOT — what the machine did in this name and why: every fill (with the
 * move since), then every decision newest-first with its thesis split into
 * the rubric fields (Catalyst / Why mispriced / Variant view / Datable
 * catalyst / Key risk) as a definition list.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, term, type SecurityResp } from "@/lib/api";
import { fmtChg, fmtET, fmtNum, fmtPx, fmtUSD, tone } from "@/lib/format";
import { thesisHeadline, thesisParts } from "@/lib/thesis";
import { Panel, useNow } from "../ui";
import { FitList, WordClamp } from "./Fit";
import type { ThesisState } from "./thesisStatus";
import { daysUntil, etDate, fmtD } from "./util";
import s from "./security.module.css";

type Decision = SecurityResp["decisions"][number];
type Trade = SecurityResp["trades"][number];

function actionPill(action: string) {
  const a = action.toLowerCase();
  const label = a.replace(/_/g, " ");
  const cls = a.includes("buy") ? "up" : a.includes("sell") ? "down" : "";
  return <span className={`pill ${cls}`}>{label}</span>;
}

/** Move since the fill, signed so that "right" is green for buys and sells alike. */
function VsLast({ t, last }: { t: Trade; last: number | null }) {
  const vs = last != null && t.price ? last / t.price - 1 : null;
  const good = vs == null ? null : t.side === "buy" ? vs : -vs;
  return (
    <span className={`num ${tone(good)}`} style={{ fontSize: 11 }} title={`Last ${fmtPx(last)} vs fill ${fmtPx(t.price)}`}>
      {fmtChg(vs, 1)}
    </span>
  );
}

function DecisionItem({
  d,
  trade,
  last,
  open,
  onToggle,
  isLead = false,
}: {
  d: Decision;
  trade: Trade | undefined;
  last: number | null;
  open: boolean;
  onToggle: () => void;
  isLead?: boolean;
}) {
  const parts = thesisParts(d.reason);
  const structured = parts.some((p) => p.k);
  return (
    <article className={`${s.dec}${open ? "" : ` ${s.decClosed}`}`}>
      <button type="button" className={s.decHead} onClick={onToggle} aria-expanded={open} title={`Decision #${d.id}${trade ? ` · fill #${trade.id} ${trade.status}` : ""} · ${open ? "collapse" : "expand"}`}>
        {actionPill(d.action)}
        <span className="num" style={{ fontSize: 11, color: "var(--ink)" }} title="New York time">{fmtET(d.at)}</span>
        {trade && (
          <span className="num" style={{ fontSize: 11, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
            {fmtNum(trade.qty, trade.qty % 1 ? 2 : 0)} @ {fmtPx(trade.price)} · ${fmtNum(trade.notional, 0)}
          </span>
        )}
        {d.dry_run && <span className="pill warn">Dry run</span>}
        {isLead && (
          <span className="label" style={{ fontSize: 9, color: "var(--cyan)" }} title="The decision behind the largest fill — the position's founding thesis">
            opening
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {trade && <VsLast t={trade} last={last} />}
          <span className={s.chev} aria-hidden="true">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {!open ? (
        <WordClamp text={thesisHeadline(d.reason, 400)} className={s.decLine} />
      ) : structured ? (
        <dl className={s.dl}>
          {parts.map((p, i) =>
            p.k ? (
              <div key={i} style={{ display: "contents" }}>
                <dt style={p.k === "Key risk" ? { color: "var(--warn)", opacity: 0.85 } : undefined}>{p.k}</dt>
                <dd>{p.v}</dd>
              </div>
            ) : (
              <div key={i} style={{ display: "contents" }}>
                <dt>Summary</dt>
                <dd className={s.lead}>{p.v}</dd>
              </div>
            ),
          )}
        </dl>
      ) : (
        <p className={s.lead} style={{ color: "var(--ink-2)", margin: 0 }}>
          {d.reason}
        </p>
      )}
    </article>
  );
}

/** A fill with no decision row behind it (e.g. a broker-side stop execution). */
function OrphanFill({ t, last }: { t: Trade; last: number | null }) {
  return (
    <div className={s.fillRow} title={`${t.status}${t.dry_run ? " · dry run" : ""}`}>
      <span className={`num ${t.side === "buy" ? "up" : "down"}`} style={{ fontWeight: 600 }}>
        {t.side === "buy" ? "▲ BUY" : "▼ SELL"}
      </span>
      <span className="num" style={{ color: "var(--ink)" }}>{fmtET(t.filled_at ?? t.submitted_at)}</span>
      <span className="num" style={{ color: "var(--ink-2)" }}>
        {fmtNum(t.qty, t.qty % 1 ? 2 : 0)} @ {fmtPx(t.price)} · ${fmtNum(t.notional, 0)}
      </span>
      <span className="label" style={{ fontSize: 9 }}>fill only</span>
      <VsLast t={t} last={last} />
    </div>
  );
}

// ── entry gates (shown when the bot has never touched the name) ─────────

type Gate = { ok: boolean | null; k: string; v: ReactNode };

/**
 * Mirrors the hard caps place_buy enforces in bot/llm/tools.py, evaluated
 * against today's data — "would a buy pass right now?". Informational only;
 * the tool layer remains the authority.
 */
function useEntryGates(data: SecurityResp): { gates: Gate[]; blocked: boolean } {
  const now = useNow(60_000);
  const { data: uni } = useQuery({ queryKey: ["universe"], queryFn: term.universe, refetchInterval: 300_000, staleTime: 120_000 });
  const { data: summary } = useQuery({ queryKey: ["summary"], queryFn: api.summary });
  const { data: regime } = useQuery({ queryKey: ["regime"], queryFn: api.regime, refetchInterval: 300_000, retry: false });
  const row = uni?.find((r) => r.ticker === data.ticker);
  const riskOff = regime?.regime_label === "risk_off";
  const capPct = riskOff ? 0.025 : 0.05;
  const next = data.earnings.next;
  const inDays = next && now ? daysUntil(next.report_date, now) : null;
  const lastSell = data.trades.find((t) => t.side === "sell");
  const sinceSell = lastSell && now ? (now - new Date(lastSell.filled_at ?? lastSell.submitted_at).getTime()) / 86_400_000 : null;
  const gates: Gate[] = [
    {
      ok: data.in_universe,
      k: "Universe",
      v: data.in_universe ? `in the ${uni?.length ?? "tracked"}-name tradable universe` : "outside the universe — place_buy rejects it",
    },
    {
      ok: row ? row.kind !== "bond_etf" : null,
      k: "Asset class",
      v: row ? (row.kind === "bond_etf" ? "bond ETF — avoided unless the thesis argues for it" : row.kind === "etf" ? "ETF" : "common equity") : "—",
    },
    {
      // tools.py _check_earnings_blackout: report date within today … today+2 (whole dates).
      ok: inDays == null ? null : !(inDays >= 0 && inDays <= 2),
      k: "Earnings",
      v: next
        ? inDays != null && inDays >= 0 && inDays <= 2
          ? `reports ${inDays === 0 ? "today" : `in ${inDays}d`} — inside the 2-day blackout`
          : `next report in ${inDays ?? "—"}d — clear of the blackout`
        : "no report on the calendar — re-checked at order time",
    },
    {
      ok: sinceSell == null ? true : sinceSell > 3,
      k: "Wash window",
      v: sinceSell == null ? "no sell on record" : sinceSell > 3 ? `last sell ${Math.floor(sinceSell)}d ago` : `sold ${Math.floor(sinceSell)}d ago — 3-day wash window`,
    },
    {
      ok: summary ? summary.position_count < 25 : null,
      k: "Book slots",
      v: summary ? `${summary.position_count} of 25 positions used` : "—",
    },
    {
      ok: null,
      k: "Sizing",
      v: (
        <>
          ≤{(capPct * 100).toFixed(1)}%{summary ? ` ≈ ${fmtUSD(summary.equity * capPct, { compact: true })}` : ""}
          {riskOff ? " (risk_off halves it)" : ""} · 10% trail · {riskOff ? 1 : 2} new names/day
        </>
      ),
    },
  ];
  const blocked = gates.some((g) => g.ok === false);
  return { gates, blocked };
}

function EntryGates({ gates }: { gates: Gate[] }) {
  return (
    <FitList unit="gates">
      {gates.map((g) => (
        <div key={g.k} style={{ display: "grid", gridTemplateColumns: "16px 84px 1fr", alignItems: "center", gap: 6, height: 22, padding: "0 10px", borderTop: "1px solid var(--line)", fontSize: 11.5 }}>
          <span className="num" style={{ color: g.ok == null ? "var(--ink-4)" : g.ok ? "var(--ink-2)" : "var(--alert)", fontWeight: 600 }}>
            {g.ok == null ? "·" : g.ok ? "✓" : "✕"}
          </span>
          <span className="label">{g.k}</span>
          <span style={{ color: g.ok === false ? "var(--alert)" : "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.v}</span>
        </div>
      ))}
    </FitList>
  );
}

export function BotReasoning({
  data,
  last,
  state,
  collapsed,
  onToggle,
  className = "",
  style,
}: {
  data: SecurityResp;
  last: number | null;
  /** Thesis freshness (thesisStatus.ts); null while unknown. */
  state: ThesisState | null;
  /** Show only the one-line status header (expired thesis / bot off). */
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const { decisions, trades } = data;
  const { gates, blocked } = useEntryGates(data);
  const noHistory = !decisions.length && !trades.length;
  const byId = new Map(trades.map((t) => [t.id, t]));
  const linked = new Set(decisions.map((d) => d.trade_id).filter((x): x is number => x != null));
  const orphans = trades.filter((t) => !linked.has(t.id));
  // The opening trade's thesis (largest fill) leads, expanded in full; add-ons and
  // later decisions follow as one-line headlines, expandable on click.
  const lead = (() => {
    let best: Decision | null = null;
    let bestN = -1;
    for (const d of decisions) {
      const n = d.trade_id != null ? (byId.get(d.trade_id)?.notional ?? 0) : 0;
      if (n > bestN) {
        best = d;
        bestN = n;
      }
    }
    return best;
  })();
  const ordered = lead ? [lead, ...decisions.filter((d) => d.id !== lead.id)] : decisions;
  const [open, setOpen] = useState<Set<number>>(() => new Set(lead ? [lead.id] : []));
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const buys = trades.filter((t) => t.side === "buy" && !t.dry_run);
  const fillsLine = trades.length
    ? `${trades.length} fill${trades.length === 1 ? "" : "s"}${buys.length ? ` · bought ${fmtNum(buys.reduce((a, t) => a + t.qty, 0), 2)} sh` : ""} · ${fmtD(etDate(trades[trades.length - 1].filled_at ?? trades[trades.length - 1].submitted_at), "md")}${trades.length > 1 ? ` → ${fmtD(etDate(trades[0].filled_at ?? trades[0].submitted_at), "md")}` : ""}`
    : "no fills";
  const header =
    decisions.length > 0 ? (
      <button key="hdr" type="button" className={s.thesisBar} onClick={onToggle} aria-expanded={!collapsed}>
        <span className={s.chev} aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <span className={`pill ${state?.expired ? "warn" : "cyan"}`}>{state?.expired ? "Thesis expired" : "Thesis live"}</span>
        <span className={s.thesisLine}>{state?.line ?? "—"}</span>
        <span className="num" style={{ marginLeft: "auto", color: "var(--ink-3)", fontSize: 10.5, whiteSpace: "nowrap" }}>
          {collapsed ? `show ${decisions.length} thes${decisions.length === 1 ? "is" : "es"}` : "collapse"}
        </span>
      </button>
    ) : null;
  return (
    <Panel
      code="BOT"
      title="Reasoning & fills"
      sub={
        noHistory
          ? data.position
            ? "held · no decisions on record · top-up gates today"
            : "never traded · place_buy gates today"
          : `${decisions.length} decision${decisions.length === 1 ? "" : "s"} · ${fillsLine}`
      }
      actions={
        noHistory ? (
          <span className={`pill ${blocked ? "alert" : ""}`} title="Mirrors the hard caps place_buy enforces in bot/llm/tools.py">
            {blocked ? "Blocked" : "Eligible"}
          </span>
        ) : undefined
      }
      className={className}
      style={style}
      flush
      bodyStyle={{ overflow: "hidden" }}
    >
      {noHistory ? (
        <EntryGates gates={gates} />
      ) : collapsed ? (
        header
      ) : (
        <div className={s.col}>
          {header}
          <FitList unit="entries">
            {ordered.map((d) => (
              <DecisionItem
                key={d.id}
                d={d}
                trade={d.trade_id != null ? byId.get(d.trade_id) : undefined}
                last={last}
                open={open.has(d.id)}
                onToggle={() => toggle(d.id)}
                isLead={d.id === lead?.id && decisions.length > 1}
              />
            ))}
            {orphans.map((t) => (
              <OrphanFill key={`f${t.id}`} t={t} last={last} />
            ))}
          </FitList>
        </div>
      )}
    </Panel>
  );
}
