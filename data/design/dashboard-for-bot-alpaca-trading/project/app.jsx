// Main app — The Ledger dashboard

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "vibrant": true,
  "tickerPaused": false,
  "showBotRibbon": true,
  "layout": "classic"
}/*EDITMODE-END*/;

function App() {
  const data = window.LEDGER_DATA;

  const [tweaks, setTweaks] = React.useState(TWEAK_DEFAULTS);
  const [tweakOpen, setTweakOpen] = React.useState(false);
  const [editAvailable, setEditAvailable] = React.useState(false);

  // Hook tweaks → body class
  React.useEffect(() => {
    document.body.classList.toggle("vibrant", !!tweaks.vibrant);
  }, [tweaks.vibrant]);

  // Tweaks pub/sub
  React.useEffect(() => {
    function onMsg(e) {
      const d = e.data || {};
      if (d.type === "__activate_edit_mode") { setTweakOpen(true); setEditAvailable(true); }
      else if (d.type === "__deactivate_edit_mode") { setTweakOpen(false); }
    }
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    setEditAvailable(true);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  function setTweak(k, v) {
    setTweaks(t => {
      const next = { ...t, [k]: v };
      try {
        window.parent.postMessage({ type: "__edit_mode_set_keys", edits: { [k]: v } }, "*");
      } catch(e){}
      return next;
    });
  }

  // Leaders / laggards
  const leaders = [...data.positions].sort((a,b) => b.unrealized_pct - a.unrealized_pct).slice(0,4);
  const laggards = [...data.positions].sort((a,b) => a.unrealized_pct - b.unrealized_pct).slice(0,4);

  return (
    <>
      <TickerStrip tape={data.tape} paused={tweaks.tickerPaused} vibrant={tweaks.vibrant}/>
      <div className="page">
        <Masthead summary={data.summary}/>
        <Nav/>

        {/* Lede: equity + sector */}
        <section style={{ display:"grid", gridTemplateColumns:"repeat(12, 1fr)", gap:28, marginTop:24 }}>
          <article style={{ gridColumn:"span 12", minWidth:0 }} className="lede-article">
            <SectionHead
              eyebrow="Portfolio v. S&P 500 — Thirty-Day View"
              title="Where the money stands"
              right={
                <span>
                  Cash {fmtUSD(data.summary.cash, { compact:true })} · Invested{" "}
                  {fmtUSD(data.summary.invested, { compact:true })}
                </span>
              }
            />
            <p style={{ fontSize:15, lineHeight:1.55, color:"var(--ink)", maxWidth:"72ch", marginTop:0 }}>
              <span style={{ fontFamily:"Fraunces, serif", fontSize:"3.2em", lineHeight:0.85, float:"left", padding:"0.05em 0.1em 0 0", fontWeight:600 }}>T</span>
              he bot runs every five minutes during market hours, combining news sentiment,
              congressional disclosures, and 13F filings into a single composite score per
              ticker. Decisions are logged with reasoning and surfaced here — the dashed red line
              tracks the S&amp;P 500 indexed to the same starting equity so relative performance
              is visible at a glance.
            </p>
            {tweaks.showBotRibbon && <BotRibbon lastRunAgoSec={96}/>}
            <div style={{ marginTop:20 }}>
              <EquityChart history={data.history} startEquity={100000}/>
            </div>
          </article>
        </section>

        {/* Row 2: sector donut + quick stats */}
        <section style={{ display:"grid", gridTemplateColumns:"repeat(12, 1fr)", gap:28, marginTop:44 }} className="rule-top">
          <div style={{ gridColumn:"span 12", paddingTop:24, display:"grid", gridTemplateColumns:"repeat(12, 1fr)", gap:28 }}>
            <aside style={{ gridColumn:"span 4", minWidth:0 }} className="col-donut">
              <SectionHead eyebrow="Exposure" title="Sector weights"/>
              <SectorDonut breakdown={data.summary.sector_breakdown} invested={data.summary.invested}/>
            </aside>

            <div style={{ gridColumn:"span 8", minWidth:0 }} className="col-leader">
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:28 }} className="leader-grid">
                <div>
                  <SectionHead eyebrow="Gainers" title="Top of the book" right={<span>best 4</span>}/>
                  <Leaderboard rows={leaders}/>
                </div>
                <div>
                  <SectionHead eyebrow="Draggers" title="Under the stop" right={<span>worst 4</span>}/>
                  <Leaderboard rows={laggards} sign={-1}/>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Row 3: trades + news + insider */}
        <section style={{ display:"grid", gridTemplateColumns:"repeat(12, 1fr)", gap:28, marginTop:44 }} className="rule-top">
          <article style={{ gridColumn:"span 6", minWidth:0, paddingTop:24 }} className="col-trades">
            <SectionHead
              eyebrow="From the trade journal"
              title="Today's orders"
              right={<a href="#" style={{ textDecoration:"underline", textUnderlineOffset:3 }}>see all</a>}
            />
            <RecentTrades trades={data.trades}/>
            <div className="mono smallcaps" style={{ fontSize:9, letterSpacing:"0.25em", color:"var(--ink-faint)", marginTop:12 }}>
              ▸ hover any row to expand reasoning
            </div>
          </article>
          <aside style={{ gridColumn:"span 4", minWidth:0, paddingTop:24 }} className="col-news">
            <SectionHead
              eyebrow="The Market Wire"
              title="Latest headlines"
              right={<a href="#" style={{ textDecoration:"underline", textUnderlineOffset:3 }}>full feed</a>}
            />
            <Headlines news={data.news}/>
          </aside>
          <aside style={{ gridColumn:"span 2", minWidth:0, paddingTop:24 }} className="col-insider">
            <SectionHead eyebrow="Insider Desk" title="Flow"/>
            <InsiderDesk signals={data.signals}/>
          </aside>
        </section>

        <footer className="mono smallcaps rule-top" style={{ fontSize:10, letterSpacing:"0.2em", color:"var(--ink-faint)", paddingTop:16, marginTop:48 }}>
          <span>Local paper account &middot; data cached 30s &middot; no financial advice &middot; est. 2026</span>
        </footer>
      </div>

      {/* Tweak panel */}
      <div className={"tweak-panel" + (tweakOpen ? " open" : "")}>
        <h3>
          <span>Tweaks</span>
          <button onClick={() => setTweakOpen(false)} style={{ background:"none", border:"none", fontFamily:"JetBrains Mono, monospace", fontSize:14, cursor:"pointer" }}>×</button>
        </h3>
        <div className="tweak-row">
          <span>Vibrant accents</span>
          <div className="seg">
            <button className={tweaks.vibrant ? "on" : ""} onClick={() => setTweak("vibrant", true)}>on</button>
            <button className={!tweaks.vibrant ? "on" : ""} onClick={() => setTweak("vibrant", false)}>off</button>
          </div>
        </div>
        <div className="tweak-row">
          <span>Ticker tape</span>
          <div className="seg">
            <button className={!tweaks.tickerPaused ? "on" : ""} onClick={() => setTweak("tickerPaused", false)}>run</button>
            <button className={tweaks.tickerPaused ? "on" : ""} onClick={() => setTweak("tickerPaused", true)}>pause</button>
          </div>
        </div>
        <div className="tweak-row">
          <span>Bot cadence ribbon</span>
          <div className="seg">
            <button className={tweaks.showBotRibbon ? "on" : ""} onClick={() => setTweak("showBotRibbon", true)}>show</button>
            <button className={!tweaks.showBotRibbon ? "on" : ""} onClick={() => setTweak("showBotRibbon", false)}>hide</button>
          </div>
        </div>
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
