// ==== Formatters ====
const fmtUSD = (n, opts) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : opts && opts.sign ? "+" : "";
  if (opts && opts.compact && abs >= 1000) {
    return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: abs >= 1e6 ? 2 : 0 })}`;
  }
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmtUSDShort = (n) => {
  const abs = Math.abs(n); const sign = n < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs/1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs/1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs/1e3).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
};
const fmtPct = (n, d=2) => `${n >= 0 ? "+" : "−"}${(Math.abs(n)*100).toFixed(d)}%`;
const fmtTimeAgo = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime())/1000;
  if (diff < 60) return `${Math.max(1, diff|0)}s ago`;
  if (diff < 3600) return `${(diff/60)|0}m ago`;
  if (diff < 86400) return `${(diff/3600)|0}h ago`;
  return `${(diff/86400)|0}d ago`;
};

// ==== Hooks ====
function useCountUpFromZero(target, duration = 1400) {
  const t0 = React.useRef(null);
  const [, force] = React.useState(0);
  if (t0.current == null) t0.current = performance.now();
  React.useEffect(() => {
    let raf;
    const loop = () => {
      force(x => x + 1);
      const p = (performance.now() - t0.current) / duration;
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration]);
  if (!Number.isFinite(target)) return 0;
  const p = Math.min(1, (performance.now() - t0.current) / duration);
  const eased = 1 - Math.pow(1 - p, 3);
  return target * eased;
}

function useClock(tickMs = 1000) {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

// Persistent ticking clock for data-viz animations (raf)
function useRaf() {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    let raf;
    const loop = () => { force(x => x + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return performance.now();
}

// ==== UI atoms ====
function PnlText({ value, children, className = "" }) {
  const color = value > 0 ? "var(--gain)" : value < 0 ? "var(--loss)" : "var(--ink-muted)";
  const glow = value > 0 ? "0 0 12px var(--gain-glow)" : value < 0 ? "0 0 12px var(--loss-glow)" : "none";
  return <span className={className} style={{ color, textShadow: glow, fontWeight: 500 }}>{children}</span>;
}

function SentimentDot({ label }) {
  const color = label === "positive" ? "var(--gain)" : label === "negative" ? "var(--loss)" : "var(--ink-faint)";
  const glow = label === "positive" ? "var(--gain-glow)" : label === "negative" ? "var(--loss-glow)" : "transparent";
  return <span style={{ display:"inline-block", width:7, height:7, borderRadius:"50%", background: color, boxShadow:`0 0 6px ${glow}`, marginRight:6 }} />;
}

function SectionHead({ eyebrow, title, right }) {
  return (
    <div className="rule-bot" style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", gap:16, paddingBottom:10, marginBottom:18 }}>
      <div>
        {eyebrow && (
          <div className="mono smallcaps" style={{ fontSize:10, letterSpacing:"0.25em", color:"var(--cyan)", marginBottom:6 }}>
            <span className="accent-bar"/>{eyebrow}
          </div>
        )}
        <h2 className="display" style={{ margin:0, fontSize:"clamp(20px, 2vw, 28px)", fontWeight:600, lineHeight:1 }}>{title}</h2>
      </div>
      {right && <div className="mono" style={{ fontSize:11, color:"var(--ink-muted)" }}>{right}</div>}
    </div>
  );
}

// ==== Ticker strip ====
function TickerStrip({ tape, paused }) {
  const items = [...tape, ...tape];
  return (
    <div className="ticker-strip">
      <div className={"ticker-track marquee-track" + (paused ? " paused" : "")}>
        {items.map((t, i) => (
          <span className="ticker-item" key={i}>
            <span className="sym">{t.s}</span>
            <span className="tabular-nums">{t.p.toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
            <span className={t.c >= 0 ? "up" : "down"}>
              {t.c >= 0 ? "▲" : "▼"} {(Math.abs(t.c)*100).toFixed(2)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ==== Live dot ====
function LiveDot({ on, color = "var(--loss)" }) {
  return (
    <span style={{ position:"relative", display:"inline-block", width:10, height:10 }}>
      <span style={{
        position:"absolute", inset:0, borderRadius:"50%",
        background: on ? color : "var(--ink-faint)",
        boxShadow: on ? `0 0 10px ${color}` : "none",
      }} className={on ? "pulse-dot" : ""}/>
      {on && (
        <span className="pulse-ring" style={{
          position:"absolute", inset:0, borderRadius:"50%",
          border:`2px solid ${color}`,
        }}/>
      )}
    </span>
  );
}

// ==== Masthead ====
function Masthead({ summary }) {
  const equity = summary.equity;
  const pnl = summary.unrealized_pnl;
  const pct = equity > 0 ? pnl / (equity - pnl) : 0;
  const now = useClock(1000);
  const eqAnim = useCountUpFromZero(equity, 1400);
  const pnlAnim = useCountUpFromZero(pnl, 1400);

  const dateStr = new Intl.DateTimeFormat("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" }).format(now);
  const timeStr = now.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false });

  const mins = now.getHours()*60 + now.getMinutes();
  const isOpen = now.getDay() >= 1 && now.getDay() <= 5 && mins >= 9*60+30 && mins < 16*60;

  return (
    <header className="panel" style={{ padding:"22px 26px 16px", marginBottom:20 }}>
      <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", gap:24, flexWrap:"wrap" }}>
        <div style={{ display:"flex", alignItems:"baseline", gap:20 }}>
          <div className="display" style={{ fontSize:"clamp(44px, 6.5vw, 84px)", fontWeight:700, fontStyle:"italic", lineHeight:0.85, background:"linear-gradient(135deg, #ffffff 0%, var(--cyan) 60%, var(--violet) 100%)", WebkitBackgroundClip:"text", backgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            The&nbsp;Ledger
          </div>
          <div className="mono smallcaps hide-sm" style={{ fontSize:10, color:"var(--ink-muted)", paddingBottom:8 }}>
            v2.0 &middot; {dateStr}
          </div>
        </div>
        <div className="rise" style={{ textAlign:"right", animationDelay:"80ms" }}>
          <div className="mono smallcaps" style={{ fontSize:10, letterSpacing:"0.25em", color:"var(--ink-muted)" }}>
            Account Equity
          </div>
          <div className="display mono tabular-nums" style={{ fontSize:"clamp(32px, 4vw, 54px)", lineHeight:1, fontWeight:600, color:"var(--ink)", textShadow:"0 0 30px rgba(120,180,255,0.2)" }}>
            {fmtUSD(eqAnim)}
          </div>
          <div className="mono" style={{ fontSize:12, marginTop:4 }}>
            Unrealized&nbsp;
            <PnlText value={pnl}>{fmtUSD(pnlAnim, { sign:true })}</PnlText>
            <span style={{ color:"var(--ink-faint)" }}>&nbsp;·&nbsp;</span>
            <PnlText value={pnl}>{fmtPct(pct)}</PnlText>
          </div>
        </div>
      </div>

      <div className="mono smallcaps rule-top" style={{ fontSize:10, letterSpacing:"0.25em", color:"var(--ink-faint)", marginTop:14, paddingTop:10, display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, flexWrap:"wrap" }}>
        <span style={{ display:"inline-flex", alignItems:"center", gap:10 }}>
          <LiveDot on={isOpen} color={isOpen ? "var(--loss)" : "var(--ink-faint)"} />
          <span style={{ color: isOpen ? "var(--rose)" : "var(--ink-muted)", fontWeight:700 }}>{isOpen ? "Market Open" : "After Hours"}</span>
          <span>&middot;</span>
          <span className="tabular-nums" style={{ color:"var(--ink)" }}>{timeStr} ET</span>
          <span className="hide-sm">&middot;</span>
          <span className="hide-sm">Paper Account</span>
        </span>
        <span className="hide-sm">
          {summary.position_count} positions &middot; {fmtUSD(summary.cash, { compact:true })} cash &middot; {fmtUSD(summary.buying_power, { compact:true })} BP
        </span>
      </div>
    </header>
  );
}

// ==== Nav ====
function Nav() {
  const links = [
    { href: "#", label: "Overview", active: true },
    { href: "#", label: "Holdings" },
    { href: "#", label: "Trade Journal" },
    { href: "#", label: "Market Wire" },
    { href: "#", label: "Insider Desk" },
    { href: "#", label: "Bot Ops" },
  ];
  return (
    <nav className="mono smallcaps" style={{ fontSize:10, letterSpacing:"0.25em", display:"flex", gap:8, flexWrap:"wrap", marginBottom:24 }}>
      {links.map(l => (
        <a key={l.label} href={l.href} style={{
          position:"relative", padding:"7px 14px", borderRadius:5,
          color: l.active ? "var(--ink)" : "var(--ink-muted)",
          fontWeight: l.active ? 700 : 500,
          background: l.active ? "rgba(120,180,255,0.08)" : "transparent",
          border: l.active ? "1px solid rgba(120,180,255,0.25)" : "1px solid transparent",
          boxShadow: l.active ? "0 0 16px rgba(120,180,255,0.15) inset" : "none",
          transition:"all 180ms",
        }}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}

// ==== Bot Ribbon ====
function BotRibbon({ lastRunAgoSec, intervalSec = 300 }) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = (lastRunAgoSec + tick) % intervalSec;
  const pct = elapsed / intervalSec;
  const remaining = Math.max(0, intervalSec - elapsed);
  const mm = String(Math.floor(remaining/60)).padStart(2,"0");
  const ss = String(remaining%60|0).padStart(2,"0");

  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:20 }}>
      <StatCard label="Bot Status" accent="var(--lime)">
        <span style={{ display:"inline-flex", alignItems:"center", gap:10 }}>
          <LiveDot on={true} color="var(--lime)"/>
          <span style={{ fontWeight:700, color:"var(--lime)", textShadow:"0 0 8px var(--lime-glow)" }}>Running</span>
        </span>
        <div className="mono" style={{ fontSize:10, color:"var(--ink-faint)", marginTop:4 }}>every 5 minutes · market hours</div>
      </StatCard>
      <StatCard label="Next cycle in" accent="var(--cyan)">
        <span className="display tabular-nums" style={{ fontSize:22, fontWeight:600, color:"var(--cyan)", textShadow:"0 0 12px var(--cyan-glow)" }}>{mm}:{ss}</span>
        <div className="cadence-bar" style={{ marginTop:8 }}>
          <span style={{ width: `${pct*100}%`, transition:"width 900ms linear" }}/>
        </div>
      </StatCard>
      <StatCard label="Last signal" accent="var(--violet)">
        <span className="display" style={{ fontSize:18, fontWeight:600 }}>NVDA <span className="chip buy" style={{ marginLeft:6 }}>BUY</span></span>
        <div className="mono" style={{ fontSize:10, color:"var(--ink-faint)", marginTop:4 }}>composite 2.08 &middot; 18m ago</div>
      </StatCard>
    </div>
  );
}

function StatCard({ label, children, accent = "var(--cyan)" }) {
  return (
    <div className="stat-card" style={{ borderTop:`2px solid ${accent}`, boxShadow:`0 0 24px ${accent.replace(')', ' / 0.08)')}` }}>
      <div className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.25em", color:"var(--ink-faint)", marginBottom:6 }}>{label}</div>
      <div style={{ fontFamily:"Inter, sans-serif", fontSize:14 }}>{children}</div>
    </div>
  );
}

// ==== Equity chart ====
function EquityChart({ history, startEquity }) {
  const ref = React.useRef(null);
  const [hover, setHover] = React.useState(null);
  const [size, setSize] = React.useState({ w: 800, h: 340 });
  const t = useRaf();

  React.useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const cr = e.contentRect;
        setSize({ w: cr.width, h: cr.height });
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const padL = 8, padR = 60, padT = 20, padB = 28;
  const w = size.w, h = size.h;

  const xs = history.map(p => new Date(p.at).getTime());
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const startSpy = history.find(p => p.spy_close != null)?.spy_close ?? 1;
  const normalized = history.map(p => ({
    t: new Date(p.at).getTime(),
    equity: p.equity,
    spy: p.spy_close != null ? (p.spy_close / startSpy) * startEquity : null,
  }));
  const ys = normalized.flatMap(p => [p.equity, p.spy].filter(v => v != null));
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;

  const xScale = tt => padL + ((tt - xMin) / (xMax - xMin || 1)) * (w - padL - padR);
  const yScale = v => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * (h - padT - padB);

  const eqPath = normalized.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(2)},${yScale(p.equity).toFixed(2)}`).join(" ");
  const spyPath = normalized.filter(p => p.spy != null).map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(2)},${yScale(p.spy).toFixed(2)}`).join(" ");
  const eqArea = eqPath + ` L${xScale(normalized[normalized.length-1].t).toFixed(2)},${h - padB} L${xScale(normalized[0].t).toFixed(2)},${h - padB} Z`;
  const approxLen = normalized.length * 20;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => yMin + (yMax - yMin) * (i/ticks));
  const xTicks = Array.from({ length: 6 }, (_, i) => xMin + (xMax - xMin) * (i/5));

  const last = normalized[normalized.length - 1];
  const gainVsStart = last.equity - startEquity;

  // Live "now" shimmer position
  const pulseR = 10 + Math.sin(t * 0.003) * 2;

  function onMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const tt = xMin + ((mx - padL) / (w - padL - padR)) * (xMax - xMin);
    let best = normalized[0], bd = Infinity;
    normalized.forEach(p => { const d = Math.abs(p.t - tt); if (d < bd){ bd = d; best = p; } });
    setHover(best);
  }

  return (
    <div ref={ref} style={{ position:"relative", width:"100%", height:340 }}>
      <svg className="equity" width="100%" height="100%" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.28"/>
            <stop offset="50%" stopColor="var(--cyan)" stopOpacity="0.08"/>
            <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0"/>
          </linearGradient>
          <linearGradient id="eqStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--violet)"/>
            <stop offset="100%" stopColor="var(--cyan)"/>
          </linearGradient>
          <filter id="eqGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={yScale(v)} y2={yScale(v)} stroke="var(--rule-hair)" strokeDasharray="1 4"/>
            <text x={w - padR + 8} y={yScale(v) + 3} fontFamily="JetBrains Mono, monospace" fontSize="10" fill="var(--ink-muted)">{fmtUSDShort(v)}</text>
          </g>
        ))}

        {xTicks.map((tt, i) => (
          <text key={i} x={xScale(tt)} y={h - 8} fontFamily="JetBrains Mono, monospace" fontSize="10" fill="var(--ink-muted)" textAnchor="middle">
            {new Date(tt).toLocaleDateString("en-US", { month:"short", day:"numeric" })}
          </text>
        ))}

        <line x1={padL} x2={w - padR} y1={yScale(startEquity)} y2={yScale(startEquity)} stroke="var(--ink-muted)" strokeOpacity="0.5" strokeDasharray="2 5"/>
        <text x={padL + 4} y={yScale(startEquity) - 5} fontFamily="JetBrains Mono, monospace" fontSize="9" fill="var(--ink-faint)">base {fmtUSDShort(startEquity)}</text>

        {/* SPY */}
        <path d={spyPath} stroke="var(--rose)" strokeWidth="1" strokeDasharray="4 4" fill="none" opacity="0.7" className="draw-in" style={{ "--len": approxLen }}/>

        {/* Equity */}
        <path d={eqArea} fill="url(#eqFill)"/>
        <path d={eqPath} stroke="url(#eqStroke)" strokeWidth="2" fill="none" filter="url(#eqGlow)" className="draw-in" style={{ "--len": approxLen }}/>

        {/* now marker */}
        <g transform={`translate(${xScale(last.t)},${yScale(last.equity)})`}>
          <circle r={pulseR} fill={gainVsStart >= 0 ? "var(--lime)" : "var(--rose)"} opacity="0.25"/>
          <circle r="4" fill={gainVsStart >= 0 ? "var(--lime)" : "var(--rose)"} style={{ filter:`drop-shadow(0 0 8px ${gainVsStart >= 0 ? "var(--lime-glow)" : "var(--loss-glow)"})` }}/>
        </g>

        {hover && (
          <g>
            <line x1={xScale(hover.t)} x2={xScale(hover.t)} y1={padT} y2={h - padB} stroke="var(--cyan)" strokeDasharray="3 4" strokeOpacity="0.6"/>
            <circle cx={xScale(hover.t)} cy={yScale(hover.equity)} r="5" fill="var(--bg-0)" stroke="var(--cyan)" strokeWidth="2"/>
          </g>
        )}

        <g transform={`translate(${padL + 8}, ${padT + 10})`} fontFamily="JetBrains Mono, monospace" fontSize="10">
          <rect x="-4" y="-10" width="140" height="20" fill="var(--bg-1)" opacity="0.7" rx="3"/>
          <line x1="0" x2="14" y1="0" y2="0" stroke="url(#eqStroke)" strokeWidth="2"/>
          <text x="20" y="3" fill="var(--ink)">portfolio</text>
          <line x1="68" x2="80" y1="0" y2="0" stroke="var(--rose)" strokeDasharray="3 3"/>
          <text x="86" y="3" fill="var(--ink-muted)">S&amp;P500</text>
        </g>
      </svg>

      {hover && (
        <div className="mono panel" style={{
          position:"absolute",
          left: Math.min(Math.max(xScale(hover.t) - 90, 10), w - 200),
          top: 10,
          padding:"8px 12px", fontSize:11, pointerEvents:"none",
          boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 0 20px var(--cyan-glow)",
        }}>
          <div style={{ color:"var(--ink-muted)", fontSize:10 }}>
            {new Date(hover.t).toLocaleString("en-US", { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" })}
          </div>
          <div style={{ fontWeight:700, color:"var(--cyan)" }}>Equity {fmtUSDShort(hover.equity)}</div>
          {hover.spy != null && <div style={{ color:"var(--ink-muted)" }}>SPY idx {fmtUSDShort(hover.spy)}</div>}
        </div>
      )}
    </div>
  );
}

// ==== Sector Donut ====
function SectorDonut({ breakdown, invested }) {
  const R = 82, r = 54, cx = 100, cy = 100;
  const palette = [
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
  const [hover, setHover] = React.useState(null);
  const total = breakdown.reduce((s,x)=>s+x.market_value, 0);

  let angle = -Math.PI/2;
  const segs = breakdown.map((s, i) => {
    const a0 = angle;
    const a1 = angle + (s.market_value/total) * Math.PI*2;
    angle = a1;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const x0 = cx + R*Math.cos(a0), y0 = cy + R*Math.sin(a0);
    const x1 = cx + R*Math.cos(a1), y1 = cy + R*Math.sin(a1);
    const xi0 = cx + r*Math.cos(a1), yi0 = cy + r*Math.sin(a1);
    const xi1 = cx + r*Math.cos(a0), yi1 = cy + r*Math.sin(a0);
    const d = `M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${xi0} ${yi0} A${r} ${r} 0 ${large} 0 ${xi1} ${yi1} Z`;
    return { ...s, d, color: palette[i % palette.length], a0, a1 };
  });

  const activeSeg = hover != null ? segs[hover] : null;

  return (
    <div>
      <div className="donut-wrap" style={{ height: 210, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <svg viewBox="0 0 200 200" width="210" height="210" style={{ overflow:"visible" }}>
          <defs>
            <filter id="donutGlow"><feGaussianBlur stdDeviation="2"/></filter>
          </defs>
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
                cursor:"pointer",
                transformOrigin:"100px 100px",
                transform: hover === i ? "scale(1.04)" : "scale(1)",
                transition:"transform 220ms cubic-bezier(0.2,0.7,0.2,1)",
                opacity: hover != null && hover !== i ? 0.35 : 1,
                filter: hover === i ? `drop-shadow(0 0 10px ${s.color})` : "none",
              }}
            >
              <animate attributeName="opacity" from="0" to={hover != null && hover !== i ? 0.35 : 1} dur="0.6s" begin={`${i*0.08}s`} fill="freeze"/>
            </path>
          ))}
        </svg>
        <div className="donut-center">
          {activeSeg ? (
            <>
              <div className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.25em", color:"var(--ink-faint)" }}>{activeSeg.sector}</div>
              <div className="display tabular-nums" style={{ fontSize:26, fontWeight:600, lineHeight:1, marginTop:4, color: activeSeg.color }}>
                {(activeSeg.weight*100).toFixed(1)}%
              </div>
              <div className="mono" style={{ fontSize:10, color:"var(--ink-muted)", marginTop:2 }}>
                {fmtUSD(activeSeg.market_value, { compact:true })}
              </div>
            </>
          ) : (
            <>
              <div className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.25em", color:"var(--ink-faint)" }}>Invested</div>
              <div className="display tabular-nums" style={{ fontSize:24, fontWeight:600, lineHeight:1, marginTop:4, color:"var(--ink)" }}>
                {fmtUSD(invested, { compact:true })}
              </div>
              <div className="mono" style={{ fontSize:10, color:"var(--ink-muted)", marginTop:2 }}>
                {segs.length} sectors
              </div>
            </>
          )}
        </div>
      </div>

      <ul style={{ listStyle:"none", padding:0, margin:"18px 0 0", fontFamily:"JetBrains Mono, monospace", fontSize:12 }}>
        {segs.map((s, i) => (
          <li key={s.sector}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="rule-hair"
              style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, padding:"6px 0", cursor:"pointer", opacity: hover != null && hover !== i ? 0.45 : 1, transition:"opacity 160ms" }}>
            <span style={{ display:"inline-flex", alignItems:"center", gap:8 }}>
              <span style={{ width:10, height:10, background:s.color, display:"inline-block", borderRadius:2, boxShadow:`0 0 6px ${s.color}` }}/>
              <span style={{ color:"var(--ink)" }}>{s.sector}</span>
            </span>
            <span className="tabular-nums" style={{ color:"var(--ink-muted)" }}>
              {fmtUSD(s.market_value, { compact:true })} <span style={{ color:"var(--ink-faint)" }}>· {(s.weight*100).toFixed(1)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ==== Sparkline ====
function Sparkline({ points, color = "var(--cyan)", width = 90, height = 28 }) {
  const min = Math.min(...points), max = Math.max(...points);
  const sx = i => (i/(points.length-1)) * width;
  const sy = v => height - ((v - min) / (max - min || 1)) * (height - 4) - 2;
  const d = points.map((p, i) => `${i?"L":"M"}${sx(i).toFixed(1)},${sy(p).toFixed(1)}`).join(" ");
  const approxLen = points.length * 8;
  return (
    <svg width={width} height={height} style={{ display:"block" }}>
      <path d={d} stroke={color} strokeWidth="1.4" fill="none" className="draw-in" style={{ "--len": approxLen, filter:`drop-shadow(0 0 3px ${color})` }}/>
      <circle cx={sx(points.length-1)} cy={sy(points[points.length-1])} r="2.2" fill={color} style={{ filter:`drop-shadow(0 0 4px ${color})` }}/>
    </svg>
  );
}

function genSpark(endPct, volatility = 0.02) {
  let seed = Math.abs(Math.round(endPct*10000)) + 3;
  const rnd = () => (seed = (seed*9301+49297)%233280) / 233280;
  const n = 28;
  const arr = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v *= 1 + (rnd() - 0.5) * volatility;
    arr.push(v);
  }
  const target = 100 * (1 + endPct);
  const delta = (target - arr[arr.length-1]) / 6;
  for (let i = n-6; i < n; i++) arr[i] += delta * (i - (n-6) + 1);
  return arr;
}

// ==== Leaderboard ====
function Leaderboard({ rows }) {
  if (!rows.length) return <p style={{ color:"var(--ink-faint)", fontStyle:"italic", fontSize:13 }}>No positions.</p>;
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.unrealized_pct))) || 0.01;
  return (
    <ul style={{ listStyle:"none", padding:0, margin:0 }}>
      {rows.map((p, idx) => {
        const gainColor = p.unrealized_pnl >= 0 ? "var(--gain)" : "var(--loss)";
        const gainGlow = p.unrealized_pnl >= 0 ? "var(--gain-glow)" : "var(--loss-glow)";
        return (
          <li key={p.ticker} className="rule-hair rise" style={{ display:"grid", gridTemplateColumns:"1.1fr 1fr auto", alignItems:"center", gap:14, padding:"11px 0", animationDelay:`${idx*80}ms` }}>
            <div>
              <div>
                <span className="display" style={{ fontSize:22, fontWeight:600, color:"var(--ink)" }}>{p.ticker}</span>
                <span className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.2em", color:"var(--ink-faint)", marginLeft:8 }}>{p.sector}</span>
              </div>
              <div className="mono" style={{ fontSize:11, color:"var(--ink-muted)", marginTop:3 }}>
                {p.qty} sh &middot; {fmtUSD(p.avg_cost)} &rarr; {fmtUSD(p.market_price)}
              </div>
            </div>
            <div>
              <Sparkline points={genSpark(p.unrealized_pct, 0.015)} color={gainColor}/>
              <div className="bar-track" style={{ marginTop:6 }}>
                <div className={"bar-fill grow-w " + (p.unrealized_pct >= 0 ? "gain" : "loss")} style={{ "--w": `${Math.min(100, (Math.abs(p.unrealized_pct)/maxAbs)*100)}%`, width:0 }}/>
              </div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div className="display tabular-nums" style={{ fontSize:18, color: gainColor, fontWeight:600, textShadow:`0 0 10px ${gainGlow}` }}>
                {fmtUSD(p.unrealized_pnl, { sign:true })}
              </div>
              <div className="mono" style={{ fontSize:11, color: gainColor, fontWeight:500 }}>
                {fmtPct(p.unrealized_pct)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ==== Recent trades ====
function RecentTrades({ trades }) {
  if (!trades.length) return null;
  return (
    <ul style={{ listStyle:"none", padding:0, margin:0 }}>
      {trades.map((t, idx) => (
        <li key={t.id} className="trade-row rule-hair rise" style={{ padding:"12px 10px", animationDelay:`${idx*60}ms`, marginLeft:-10, marginRight:-10 }}>
          <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:10, flexWrap:"wrap" }}>
              <span className={"chip " + t.side}>{t.side.toUpperCase()}</span>
              <span className="display" style={{ fontSize:22, fontWeight:600, color:"var(--ink)" }}>{t.ticker}</span>
              <span className="mono" style={{ fontSize:12, color:"var(--ink-muted)" }}>
                {t.qty.toFixed(2)} @ {fmtUSD(t.price)} &middot; {fmtUSD(t.notional, { compact:true })}
              </span>
              {t.dry_run && (
                <span className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.2em", color:"var(--amber)", padding:"1px 6px", border:"1px solid var(--amber)", borderRadius:3 }}>dry run</span>
              )}
            </div>
            <span className="mono smallcaps" style={{ fontSize:10, letterSpacing:"0.2em", color:"var(--ink-faint)" }}>
              {fmtTimeAgo(t.submitted_at)}
            </span>
          </div>
          {t.reason && (
            <p style={{ margin:"6px 0 0", fontSize:13, color:"var(--ink-muted)", lineHeight:1.5 }}>{t.reason}</p>
          )}
          <div className="detail">
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:12, marginTop:12, paddingTop:12, borderTop:"1px solid var(--rule-hair)" }}>
              <DetailStat label="Composite" value={t.composite_score != null ? t.composite_score.toFixed(2) : "—"} sign={t.composite_score ?? 0}/>
              <DetailStat label="News sentiment" value={t.side === "buy" ? "+0.42" : "−0.38"} sign={t.side === "buy" ? 1 : -1}/>
              <DetailStat label="Insider Δ" value={t.side === "buy" ? "+$1.0M" : "−$0.4M"} sign={t.side === "buy" ? 1 : -1}/>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DetailStat({ label, value, sign }) {
  const color = sign > 0 ? "var(--gain)" : sign < 0 ? "var(--loss)" : "var(--ink)";
  const glow = sign > 0 ? "var(--gain-glow)" : sign < 0 ? "var(--loss-glow)" : "transparent";
  return (
    <div>
      <div className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.25em", color:"var(--ink-faint)" }}>{label}</div>
      <div className="display tabular-nums" style={{ fontSize:16, fontWeight:600, color, marginTop:3, textShadow:`0 0 8px ${glow}` }}>{value}</div>
    </div>
  );
}

// ==== Headlines ====
function Headlines({ news }) {
  return (
    <ul style={{ listStyle:"none", padding:0, margin:0 }}>
      {news.map((n, i) => (
        <li key={n.id} className="rule-hair rise" style={{ padding:"11px 0", animationDelay:`${i*50}ms` }}>
          <a href={n.url}>
            <div className="mono smallcaps" style={{ fontSize:10, letterSpacing:"0.2em", color:"var(--ink-faint)", display:"flex", alignItems:"center", gap:6 }}>
              <SentimentDot label={n.sentiment_label}/>
              <span>{n.source}</span>
              <span>·</span>
              <span>{fmtTimeAgo(n.published_at)}</span>
              {n.vader_score != null && (
                <span style={{ marginLeft:"auto", color: n.vader_score > 0 ? "var(--gain)" : n.vader_score < 0 ? "var(--loss)" : "var(--ink-faint)" }}>
                  {n.vader_score >= 0 ? "+" : "−"}{Math.abs(n.vader_score).toFixed(2)}
                </span>
              )}
            </div>
            <div style={{ marginTop:5, fontSize:14, fontWeight:500, lineHeight:1.4, color:"var(--ink)", fontFamily:"Inter, sans-serif" }}>
              {n.title}
            </div>
            {n.tickers.length > 0 && (
              <div style={{ marginTop:7, display:"flex", flexWrap:"wrap", gap:6 }}>
                {n.tickers.map(t => (
                  <span key={t} className="chip">{t}</span>
                ))}
              </div>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

// ==== Insider Desk ====
function InsiderDesk({ signals }) {
  return (
    <ul style={{ listStyle:"none", padding:0, margin:0 }}>
      {signals.map((s, i) => (
        <li key={s.id} className="rule-hair rise" style={{ padding:"10px 0", display:"grid", gridTemplateColumns:"auto 1fr auto", gap:12, alignItems:"center", animationDelay:`${i*60}ms` }}>
          <span className="display" style={{ fontSize:18, fontWeight:600, color:"var(--ink)" }}>{s.ticker}</span>
          <div>
            <div className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.2em", color:"var(--ink-faint)" }}>
              {s.kind} &middot; {fmtTimeAgo(s.as_of)}
            </div>
            <div style={{ fontSize:12, color:"var(--ink-muted)", fontFamily:"Inter, sans-serif", marginTop:2 }}>
              {s.source}
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <span className={"chip " + s.direction}>{s.direction.toUpperCase()}</span>
            {s.amount && <div className="mono tabular-nums" style={{ fontSize:10, color:"var(--ink-faint)", marginTop:4 }}>{fmtUSD(s.amount, { compact:true })}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

Object.assign(window, {
  fmtUSD, fmtUSDShort, fmtPct, fmtTimeAgo,
  useCountUpFromZero, useClock, useRaf,
  PnlText, SentimentDot, SectionHead,
  TickerStrip, Masthead, LiveDot, Nav, BotRibbon, StatCard,
  EquityChart, SectorDonut, Sparkline,
  Leaderboard, RecentTrades, Headlines, InsiderDesk,
});
