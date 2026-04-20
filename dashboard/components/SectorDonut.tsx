"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, PortfolioSummary } from "@/lib/api";
import { fmtUSD } from "@/lib/format";

const PALETTE = [
  "oklch(70% 0.17 210)", // cyan
  "oklch(68% 0.19 290)", // violet
  "oklch(75% 0.19 145)", // lime
  "oklch(72% 0.19 60)",  // amber
  "oklch(65% 0.20 340)", // magenta
  "oklch(68% 0.17 180)", // teal
  "oklch(70% 0.16 100)", // yellow-green
  "oklch(65% 0.18 30)",  // coral
  "oklch(65% 0.14 250)", // blue
  "oklch(70% 0.15 320)", // pink
];

export function SectorDonut() {
  const { data } = useQuery<PortfolioSummary>({
    queryKey: ["summary"],
    queryFn: api.summary,
  });
  const breakdown = data?.sector_breakdown ?? [];
  const invested = data?.invested ?? 0;
  const [hover, setHover] = useState<number | null>(null);

  if (!breakdown.length) {
    return (
      <div style={{ color: "var(--ink-faint)", fontStyle: "italic", fontSize: 13 }}>
        No allocation yet.
      </div>
    );
  }

  const R = 82,
    r = 54,
    cx = 100,
    cy = 100;
  const total = breakdown.reduce((s, x) => s + x.market_value, 0) || 1;
  let angle = -Math.PI / 2;

  const segs = breakdown.map((s, i) => {
    const a0 = angle;
    const a1 = angle + (s.market_value / total) * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + R * Math.cos(a0);
    const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1);
    const y1 = cy + R * Math.sin(a1);
    const xi0 = cx + r * Math.cos(a1);
    const yi0 = cy + r * Math.sin(a1);
    const xi1 = cx + r * Math.cos(a0);
    const yi1 = cy + r * Math.sin(a0);
    const d = `M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${xi0} ${yi0} A${r} ${r} 0 ${large} 0 ${xi1} ${yi1} Z`;
    return { ...s, d, color: PALETTE[i % PALETTE.length] };
  });

  const activeSeg = hover != null ? segs[hover] : null;

  return (
    <div>
      <div
        style={{
          position: "relative",
          height: 210,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg viewBox="0 0 200 200" width="210" height="210" style={{ overflow: "visible" }}>
          {segs.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill={s.color}
              stroke="var(--bg-1)"
              strokeWidth="2"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{
                cursor: "pointer",
                transformOrigin: "100px 100px",
                transform: hover === i ? "scale(1.04)" : "scale(1)",
                transition: "transform 220ms cubic-bezier(0.2,0.7,0.2,1)",
                opacity: hover != null && hover !== i ? 0.35 : 1,
                filter: hover === i ? `drop-shadow(0 0 10px ${s.color})` : "none",
              }}
            >
              <animate
                attributeName="opacity"
                from="0"
                to={hover != null && hover !== i ? 0.35 : 1}
                dur="0.6s"
                begin={`${i * 0.08}s`}
                fill="freeze"
              />
            </path>
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            pointerEvents: "none",
            textAlign: "center",
          }}
        >
          {activeSeg ? (
            <>
              <div
                className="mono smallcaps"
                style={{
                  fontSize: 9,
                  letterSpacing: "0.25em",
                  color: "var(--ink-faint)",
                }}
              >
                {activeSeg.sector}
              </div>
              <div
                className="display tabular-nums"
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  lineHeight: 1,
                  marginTop: 4,
                  color: activeSeg.color,
                }}
              >
                {(activeSeg.weight * 100).toFixed(1)}%
              </div>
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}
              >
                {fmtUSD(activeSeg.market_value, { compact: true })}
              </div>
            </>
          ) : (
            <>
              <div
                className="mono smallcaps"
                style={{
                  fontSize: 9,
                  letterSpacing: "0.25em",
                  color: "var(--ink-faint)",
                }}
              >
                Invested
              </div>
              <div
                className="display tabular-nums"
                style={{
                  fontSize: 24,
                  fontWeight: 600,
                  lineHeight: 1,
                  marginTop: 4,
                  color: "var(--ink)",
                }}
              >
                {fmtUSD(invested, { compact: true })}
              </div>
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}
              >
                {segs.length} sectors
              </div>
            </>
          )}
        </div>
      </div>

      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "18px 0 0",
          fontFamily: "var(--font-jetbrains), JetBrains Mono, monospace",
          fontSize: 12,
        }}
      >
        {segs.map((s, i) => (
          <li
            key={s.sector}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className="rule-hair"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "6px 0",
              cursor: "pointer",
              opacity: hover != null && hover !== i ? 0.45 : 1,
              transition: "opacity 160ms",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: s.color,
                  display: "inline-block",
                  borderRadius: 2,
                  boxShadow: `0 0 6px ${s.color}`,
                }}
              />
              <span style={{ color: "var(--ink)" }}>{s.sector}</span>
            </span>
            <span className="tabular-nums" style={{ color: "var(--ink-muted)" }}>
              {fmtUSD(s.market_value, { compact: true })}{" "}
              <span style={{ color: "var(--ink-faint)" }}>
                &middot; {(s.weight * 100).toFixed(1)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
