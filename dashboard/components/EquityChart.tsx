"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, HistoryPoint } from "@/lib/api";
import { fmtUSDShort } from "@/lib/format";

type Normalized = { t: number; equity: number; spy: number | null };

export function EquityChart({ startEquity = 100_000 }: { startEquity?: number }) {
  const { data: history } = useQuery<HistoryPoint[]>({
    queryKey: ["history", 30],
    queryFn: () => api.history(30),
  });

  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 340 });
  const [hover, setHover] = useState<Normalized | null>(null);
  const [now, setNow] = useState(() => performance.now());

  // Drive the "now" pulse animation.
  useEffect(() => {
    let raf: number;
    const loop = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = e.contentRect;
        setSize({ w: r.width, h: r.height });
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const pts = history ?? [];
  if (pts.length < 2) {
    return (
      <div
        ref={ref}
        style={{
          position: "relative",
          width: "100%",
          height: 340,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span className="mono smallcaps" style={{ fontSize: 10, color: "var(--ink-faint)" }}>
          gathering equity history…
        </span>
      </div>
    );
  }

  const padL = 8,
    padR = 60,
    padT = 20,
    padB = 28;
  const { w, h } = size;

  const startSpy = pts.find((p) => p.spy_close != null)?.spy_close ?? 1;
  const normalized: Normalized[] = pts.map((p) => ({
    t: new Date(p.at).getTime(),
    equity: p.equity,
    spy: p.spy_close != null ? (p.spy_close / startSpy) * pts[0].equity : null,
  }));

  const xs = normalized.map((p) => p.t);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const ys = normalized.flatMap((p) =>
    [p.equity, p.spy].filter((v): v is number => v != null)
  );
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin -= pad;
  yMax += pad;

  const xScale = (t: number) =>
    padL + ((t - xMin) / (xMax - xMin || 1)) * (w - padL - padR);
  const yScale = (v: number) =>
    padT + (1 - (v - yMin) / (yMax - yMin || 1)) * (h - padT - padB);

  const eqPath = normalized
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(2)},${yScale(p.equity).toFixed(2)}`
    )
    .join(" ");
  const spyPath = normalized
    .filter((p) => p.spy != null)
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(2)},${yScale(p.spy as number).toFixed(2)}`
    )
    .join(" ");
  const eqArea =
    eqPath +
    ` L${xScale(normalized[normalized.length - 1].t).toFixed(2)},${h - padB} ` +
    `L${xScale(normalized[0].t).toFixed(2)},${h - padB} Z`;
  const approxLen = normalized.length * 20;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / ticks);
  const xTicks = Array.from({ length: 6 }, (_, i) => xMin + ((xMax - xMin) * i) / 5);

  const last = normalized[normalized.length - 1];
  const base = pts[0].equity;
  const gainVsStart = last.equity - base;
  const pulseR = 10 + Math.sin(now * 0.003) * 2;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const tt = xMin + ((mx - padL) / (w - padL - padR)) * (xMax - xMin);
    let best = normalized[0];
    let bd = Infinity;
    normalized.forEach((p) => {
      const d = Math.abs(p.t - tt);
      if (d < bd) {
        bd = d;
        best = p;
      }
    });
    setHover(best);
  }

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", height: 340 }}>
      <svg
        width="100%"
        height="100%"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ cursor: "crosshair" }}
      >
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.28" />
            <stop offset="50%" stopColor="var(--cyan)" stopOpacity="0.08" />
            <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="eqStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--violet)" />
            <stop offset="100%" stopColor="var(--cyan)" />
          </linearGradient>
          <filter id="eqGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {yTicks.map((v, i) => (
          <g key={`yt-${i}`}>
            <line
              x1={padL}
              x2={w - padR}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="var(--rule-hair)"
              strokeDasharray="1 4"
            />
            <text
              x={w - padR + 8}
              y={yScale(v) + 3}
              fontFamily="var(--font-jetbrains), monospace"
              fontSize="10"
              fill="var(--ink-muted)"
            >
              {fmtUSDShort(v)}
            </text>
          </g>
        ))}

        {xTicks.map((tt, i) => (
          <text
            key={`xt-${i}`}
            x={xScale(tt)}
            y={h - 8}
            fontFamily="var(--font-jetbrains), monospace"
            fontSize="10"
            fill="var(--ink-muted)"
            textAnchor="middle"
          >
            {new Date(tt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </text>
        ))}

        {/* baseline */}
        <line
          x1={padL}
          x2={w - padR}
          y1={yScale(base)}
          y2={yScale(base)}
          stroke="var(--ink-muted)"
          strokeOpacity="0.5"
          strokeDasharray="2 5"
        />
        <text
          x={padL + 4}
          y={yScale(base) - 5}
          fontFamily="var(--font-jetbrains), monospace"
          fontSize="9"
          fill="var(--ink-faint)"
        >
          base {fmtUSDShort(base)}
        </text>

        {/* SPY comparator */}
        <path
          d={spyPath}
          stroke="var(--rose)"
          strokeWidth="1"
          strokeDasharray="4 4"
          fill="none"
          opacity="0.7"
          className="draw-in"
          style={{ ["--len" as never]: approxLen } as React.CSSProperties}
        />

        {/* Equity area + line */}
        <path d={eqArea} fill="url(#eqFill)" />
        <path
          d={eqPath}
          stroke="url(#eqStroke)"
          strokeWidth="2"
          fill="none"
          filter="url(#eqGlow)"
          className="draw-in"
          style={{ ["--len" as never]: approxLen } as React.CSSProperties}
        />

        {/* now marker */}
        <g transform={`translate(${xScale(last.t)},${yScale(last.equity)})`}>
          <circle
            r={pulseR}
            fill={gainVsStart >= 0 ? "var(--lime)" : "var(--rose)"}
            opacity="0.25"
          />
          <circle
            r="4"
            fill={gainVsStart >= 0 ? "var(--lime)" : "var(--rose)"}
            style={{
              filter: `drop-shadow(0 0 8px ${
                gainVsStart >= 0 ? "var(--lime-glow)" : "var(--loss-glow)"
              })`,
            }}
          />
        </g>

        {hover && (
          <g>
            <line
              x1={xScale(hover.t)}
              x2={xScale(hover.t)}
              y1={padT}
              y2={h - padB}
              stroke="var(--cyan)"
              strokeDasharray="3 4"
              strokeOpacity="0.6"
            />
            <circle
              cx={xScale(hover.t)}
              cy={yScale(hover.equity)}
              r="5"
              fill="var(--bg-0)"
              stroke="var(--cyan)"
              strokeWidth="2"
            />
          </g>
        )}

        <g
          transform={`translate(${padL + 8}, ${padT + 10})`}
          fontFamily="var(--font-jetbrains), monospace"
          fontSize="10"
        >
          <rect x="-4" y="-10" width="140" height="20" fill="var(--bg-1)" opacity="0.7" rx="3" />
          <line x1="0" x2="14" y1="0" y2="0" stroke="url(#eqStroke)" strokeWidth="2" />
          <text x="20" y="3" fill="var(--ink)">
            portfolio
          </text>
          <line x1="68" x2="80" y1="0" y2="0" stroke="var(--rose)" strokeDasharray="3 3" />
          <text x="86" y="3" fill="var(--ink-muted)">
            S&amp;P 500
          </text>
        </g>
      </svg>

      {hover && (
        <div
          className="mono panel"
          style={{
            position: "absolute",
            left: Math.min(Math.max(xScale(hover.t) - 90, 10), w - 200),
            top: 10,
            padding: "8px 12px",
            fontSize: 11,
            pointerEvents: "none",
            boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 0 20px var(--cyan-glow)",
          }}
        >
          <div style={{ color: "var(--ink-muted)", fontSize: 10 }}>
            {new Date(hover.t).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </div>
          <div style={{ fontWeight: 700, color: "var(--cyan)" }}>
            Equity {fmtUSDShort(hover.equity)}
          </div>
          {hover.spy != null && (
            <div style={{ color: "var(--ink-muted)" }}>
              SPY idx {fmtUSDShort(hover.spy)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
