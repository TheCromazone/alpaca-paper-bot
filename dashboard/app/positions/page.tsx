"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, CompanyProfile, PositionRow } from "@/lib/api";
import { fmtDate, fmtPct, fmtUSD, fmtUSDShort } from "@/lib/format";
import { SectionHead } from "@/components/SectionHead";
import { PnlLabel } from "@/components/PnlLabel";

export default function PositionsPage() {
  const { data } = useQuery<PositionRow[]>({
    queryKey: ["positions"],
    queryFn: api.positions,
  });
  const rows = data ?? [];
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="pt-6">
      <SectionHead
        eyebrow="Holdings"
        title="The Book"
        right={<span>{rows.length} open positions</span>}
      />

      <div className="rule-thick">
        <table className="w-full mono text-[12px]">
          <thead>
            <tr className="smallcaps text-[10px] tracking-[0.2em] text-ink-faint rule-bot">
              <Th className="text-left">Ticker</Th>
              <Th className="text-left">Sector</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Avg Cost</Th>
              <Th className="text-right">Price</Th>
              <Th className="text-right">Mkt Value</Th>
              <Th className="text-right">P&amp;L $</Th>
              <Th className="text-right">P&amp;L %</Th>
              <Th className="text-right">Stop</Th>
              <Th className="w-[120px]">To Stop</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Fragment key={p.ticker}>
                <tr
                  className="rule-hair hover:bg-paper-deep cursor-pointer"
                  onClick={() => setOpen(open === p.ticker ? null : p.ticker)}
                >
                  <td className="py-2 display text-lg">
                    <span
                      aria-hidden="true"
                      className="inline-block mono text-ink-faint mr-2 text-[10px] align-middle"
                      style={{
                        transform: open === p.ticker ? "rotate(90deg)" : "none",
                        transition: "transform 160ms ease",
                      }}
                    >
                      ▶
                    </span>
                    {p.ticker}
                  </td>
                  <td className="py-2 text-ink-muted">{p.sector}</td>
                  <td className="py-2 text-right tabular-nums">{p.qty}</td>
                  <td className="py-2 text-right tabular-nums">{fmtUSD(p.avg_cost)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtUSD(p.market_price)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {fmtUSD(p.market_value, { compact: true })}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    <PnlLabel value={p.unrealized_pnl}>
                      {fmtUSD(p.unrealized_pnl, { sign: true })}
                    </PnlLabel>
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    <PnlLabel value={p.unrealized_pct}>
                      {fmtPct(p.unrealized_pct)}
                    </PnlLabel>
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink-muted">
                    {fmtUSD(p.stop_price)}
                  </td>
                  <td className="py-2">
                    <StopBar pct={p.distance_to_stop_pct} />
                  </td>
                </tr>
                {open === p.ticker && (
                  <tr className="rule-hair">
                    <td colSpan={10} style={{ padding: 0 }}>
                      <Dossier position={p} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={10} className="py-12 text-center text-ink-faint italic">
                  No open positions. The bot will seed a book once market hours hit.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
        className="mono smallcaps"
        style={{
          fontSize: 9.5,
          letterSpacing: "0.22em",
          color: "var(--ink-faint)",
          marginTop: 14,
          lineHeight: 1.6,
        }}
      >
        ▸ click any row for the company dossier &middot; who they are &middot;
        why we own them
      </div>
    </div>
  );
}

/** Expanded row: company profile (yfinance cache) + the bot's buy thesis. */
function Dossier({ position: p }: { position: PositionRow }) {
  const { data: profile, isLoading, isError } = useQuery<CompanyProfile>({
    queryKey: ["company", p.ticker],
    queryFn: () => api.company(p.ticker),
    staleTime: Infinity,
    refetchInterval: false,
    retry: 1,
  });

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 7fr) minmax(0, 5fr)",
        gap: 28,
        padding: "18px 22px 22px",
        background: "var(--paper-deep, rgba(255,255,255,0.02))",
        borderLeft: "2px solid var(--emerald)",
      }}
    >
      {/* ── Who they are ── */}
      <div style={{ minWidth: 0 }}>
        <div className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint">
          The Company
        </div>
        {isLoading && (
          <div className="text-ink-faint italic mt-2 text-[12px]">
            pulling the company file…
          </div>
        )}
        {isError && (
          <div className="text-ink-faint italic mt-2 text-[12px]">
            No profile available — data source unreachable.
          </div>
        )}
        {profile && (
          <>
            <div className="display text-xl mt-1">
              {profile.name ?? p.ticker}
            </div>
            <div className="mono text-[11px] text-ink-muted mt-1">
              {[profile.sector, profile.industry, profile.country]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div
              style={{
                display: "flex",
                gap: 26,
                marginTop: 12,
                flexWrap: "wrap",
              }}
            >
              {profile.market_cap != null && (
                <DossierStat label="Mkt Cap" value={fmtUSDShort(profile.market_cap)} />
              )}
              {profile.employees != null && (
                <DossierStat
                  label="Employees"
                  value={profile.employees.toLocaleString("en-US")}
                />
              )}
              {profile.exchange && (
                <DossierStat label="Exchange" value={profile.exchange} />
              )}
              {profile.website && (
                <DossierStat
                  label="Web"
                  value={
                    <a
                      href={profile.website}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ textDecoration: "underline", textUnderlineOffset: 3 }}
                    >
                      {profile.website.replace(/^https?:\/\/(www\.)?/, "")}
                    </a>
                  }
                />
              )}
            </div>
            {profile.description && (
              <p
                className="text-[12px]"
                style={{
                  color: "var(--ink-muted)",
                  lineHeight: 1.7,
                  marginTop: 12,
                  maxWidth: "68ch",
                }}
              >
                {profile.description}
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Why we own it ── */}
      <div style={{ minWidth: 0 }}>
        <div className="smallcaps mono text-[10px] tracking-[0.2em] text-ink-faint">
          Why We Own It
        </div>
        {p.thesis ? (
          <p
            className="text-[12px]"
            style={{ lineHeight: 1.7, marginTop: 8 }}
          >
            {p.thesis}
          </p>
        ) : (
          <div className="text-ink-faint italic mt-2 text-[12px]">
            No recorded thesis — position predates the decision ledger.
          </div>
        )}
        <div
          className="mono text-[11px] text-ink-muted"
          style={{ marginTop: 14, lineHeight: 2 }}
        >
          {p.opened_at && <div>Opened {fmtDate(p.opened_at)}</div>}
          {p.decision_at && p.decision_action && (
            <div>
              Call logged {fmtDate(p.decision_at)} ({p.decision_action.replace("_", " ")})
            </div>
          )}
          <div>
            Peak {fmtUSD(p.peak_price)} · trailing stop {fmtUSD(p.stop_price)}
            {p.stop_order_id ? " · broker stop live" : " · synthetic stop"}
          </div>
        </div>
      </div>
    </div>
  );
}

function DossierStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="smallcaps mono text-[9px] tracking-[0.2em] text-ink-faint">
        {label}
      </div>
      <div className="mono text-[12px] tabular-nums">{value}</div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`py-2 px-1 font-normal ${className}`}>
      {children}
    </th>
  );
}

function StopBar({ pct }: { pct: number }) {
  // pct represents distance of current price above the stop (0 = at stop, 0.07 = 7% above)
  // 0.07 is "safe". >0.07 means peak went up. <=0 means stop is hit.
  const clamped = Math.max(0, Math.min(0.15, pct));
  const width = (clamped / 0.15) * 100;
  const color =
    pct <= 0.02 ? "#7a1616" : pct <= 0.05 ? "#a26a00" : "#1f4d2e";
  return (
    <div className="relative h-[6px] bg-paper-deep border border-rule-hair">
      <div
        className="absolute top-0 left-0 h-full"
        style={{ width: `${width}%`, background: color }}
      />
      <div className="absolute -top-[1px] bottom-[-1px] w-[1px] bg-ink" style={{ left: `${(0.07 / 0.15) * 100}%` }} />
    </div>
  );
}
