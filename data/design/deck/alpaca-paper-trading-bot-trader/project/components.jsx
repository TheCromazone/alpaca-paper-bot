/* global React */

// ---------- Design tokens ----------
const TYPE_SCALE = { display: 124, title: 64, subtitle: 42, body: 30, small: 26, micro: 24 };
const SPACING = { paddingTop: 96, paddingBottom: 120, paddingX: 112, titleGap: 48, itemGap: 24 };

const C = {
  paper:   '#f6f1e7',   // warm off-white
  paperAlt:'#efe8d9',
  card:    '#ffffff',
  cardAlt: '#fbf7ec',
  ink:     '#1a1c21',
  inkDim:  '#4a4f58',
  inkMute: '#7a8190',
  rule:    '#dcd4bf',
  ruleSoft:'#e8e1cd',
  navy:    '#1f3a5f',   // primary accent
  navyDeep:'#162a44',
  ochre:   '#b8862c',   // secondary accent
  brick:   '#9e3b2a',   // tertiary
  moss:    '#4a6b3a',   // quaternary (for positive / momentum)
};

const serif = '"Fraunces", "Source Serif 4", Georgia, "Times New Roman", serif';
const sans  = '"Inter", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
const mono  = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

// ---------- Frame ----------
function Slide({ children, bg = C.paper, padded = true, style = {} }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, background: bg, color: C.ink,
      fontFamily: sans, overflow: 'hidden',
      padding: padded ? `${SPACING.paddingTop}px ${SPACING.paddingX}px ${SPACING.paddingBottom}px` : 0,
      ...style,
    }}>
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>{children}</div>
    </div>
  );
}

function SlideChrome({ eyebrow, num, total, right, section }) {
  return (
    <div style={{
      position: 'absolute', top: -SPACING.paddingTop + 40, left: 0, right: 0,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontFamily: mono, fontSize: TYPE_SCALE.micro, color: C.inkMute,
      letterSpacing: '0.16em', textTransform: 'uppercase',
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
        <span style={{ width: 28, height: 2, background: C.navy }} />
        {eyebrow}
      </span>
      <span>{section} · {String(num).padStart(2, '0')} / {String(total).padStart(2, '0')}</span>
    </div>
  );
}

function SlideFooter({ text }) {
  return (
    <div style={{
      position: 'absolute', bottom: -SPACING.paddingBottom + 30, left: 0, right: 0,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontFamily: mono, fontSize: 24, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase',
    }}>
      <span>Alpaca paper trading bot</span>
      <span>{text}</span>
    </div>
  );
}

function H1({ children, size = TYPE_SCALE.title, style = {} }) {
  return (
    <h1 style={{
      margin: 0, fontFamily: serif, fontSize: size, lineHeight: 1.04, fontWeight: 400,
      letterSpacing: '-0.018em', color: C.ink, textWrap: 'balance', ...style,
    }}>{children}</h1>
  );
}

function Kicker({ children }) {
  return (
    <div style={{
      fontFamily: mono, fontSize: TYPE_SCALE.micro, color: C.navy,
      letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 18,
    }}>{children}</div>
  );
}

function Lede({ children, color = C.inkDim, max = 1100 }) {
  return (
    <p style={{ margin: 0, fontSize: TYPE_SCALE.body, lineHeight: 1.42, color, maxWidth: max, textWrap: 'pretty' }}>
      {children}
    </p>
  );
}

// ---------- 01 Cover ----------
function CoverSlide() {
  return (
    <Slide padded={false}>
      <div style={{ position: 'absolute', inset: 0, padding: `${SPACING.paddingTop}px ${SPACING.paddingX}px ${SPACING.paddingBottom}px`,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: mono, fontSize: TYPE_SCALE.micro, color: C.inkMute, letterSpacing: '0.22em', textTransform: 'uppercase' }}>
          <span>Technical review · v0.1</span>
          <span>April 2026</span>
        </div>
        <div>
          <div style={{ fontFamily: mono, fontSize: 28, color: C.ochre, letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: 44 }}>
            Autonomous paper‑trader
          </div>
          <h1 style={{
            margin: 0, fontFamily: serif, fontSize: TYPE_SCALE.display, lineHeight: 0.96, fontWeight: 400,
            letterSpacing: '-0.03em', maxWidth: 1600,
          }}>
            How the Alpaca<br />
            <em style={{ fontStyle: 'italic', color: C.navy }}>paper trading</em> bot<br />
            actually works.
          </h1>
          <div style={{ marginTop: 56, fontSize: TYPE_SCALE.body, color: C.inkDim, maxWidth: 1100, lineHeight: 1.45 }}>
            A plain‑English, precise walkthrough of what the bot is, how it was built,
            and every concrete thing that could make it better.
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderTop: `1px solid ${C.rule}`, paddingTop: 22, fontFamily: mono, fontSize: TYPE_SCALE.micro, color: C.inkMute, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
          <span>paper-api.alpaca.markets · DRY_RUN=true</span>
          <span>22 slides · ~15 min read</span>
        </div>
      </div>
    </Slide>
  );
}

// ---------- 02 Agenda ----------
function AgendaSlide({ num, total }) {
  const sections = [
    ['A', 'The big picture',  'What the bot is and why we built it',                              '03–05'],
    ['B', 'How it thinks',    'Four signals + one composite score + a decision tree',             '06–13'],
    ['C', 'How it was built', 'Tech stack, data model, the dashboard',                            '14–17'],
    ['D', 'Limits & roadmap', 'What it cannot do yet, and what to build next',                    '18–21'],
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="Agenda" num={num} total={total} section="00" />
      <H1 style={{ marginBottom: 64 }}>A short tour, in four parts.</H1>
      <div style={{ borderTop: `1px solid ${C.rule}` }}>
        {sections.map(([k, t, d, r]) => (
          <div key={k} style={{
            display: 'grid', gridTemplateColumns: '80px 420px 1fr 160px', gap: 32,
            padding: '30px 0', borderBottom: `1px solid ${C.rule}`, alignItems: 'baseline',
          }}>
            <span style={{ fontFamily: serif, fontSize: 56, fontStyle: 'italic', color: C.navy }}>{k}</span>
            <span style={{ fontFamily: serif, fontSize: TYPE_SCALE.subtitle, color: C.ink, letterSpacing: '-0.01em' }}>{t}</span>
            <span style={{ fontSize: TYPE_SCALE.body, color: C.inkDim }}>{d}</span>
            <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.inkMute, textAlign: 'right' }}>{r}</span>
          </div>
        ))}
      </div>
      <SlideFooter text="Agenda" />
    </Slide>
  );
}

// ---------- 03 Plain-English summary ----------
function ELI10Slide({ num, total }) {
  return (
    <Slide bg={C.paperAlt}>
      <SlideChrome eyebrow="03 · In plain English" num={num} total={total} section="A" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 96, alignItems: 'start' }}>
        <div>
          <Kicker>Explain it like I'm ten</Kicker>
          <H1 size={76} style={{ marginBottom: 36 }}>
            It's a <em style={{ fontStyle: 'italic', color: C.navy }}>robot stock‑picker</em> that plays with fake money.
          </H1>
          <Lede>
            Every five minutes during the trading day, the robot reads the news,
            peeks at what politicians and famous investors are buying, checks which
            stocks have been going up, and gives each company a score. If the score
            is high, it buys a little. If it turns bad, it sells. Nothing here is
            real money — we're practicing.
          </Lede>
        </div>
        <div>
          <Kicker>The same thing, precisely</Kicker>
          <H1 size={50} style={{ marginBottom: 24, fontStyle: 'italic' }}>
            A signal‑fused, risk‑bounded paper trader.
          </H1>
          <Lede>
            A headless Python process on a 5‑minute APScheduler loop, pointed at
            Alpaca's paper endpoint. It aggregates four independent signals — news
            sentiment, STOCK Act disclosures, 13F deltas, and price momentum — into
            a weighted composite score per ticker, then runs a decision tree gated
            by portfolio‑shape constraints. Every order is persisted with a
            human‑readable <code style={{ fontFamily: mono, background: C.card, padding: '2px 8px', border: `1px solid ${C.rule}` }}>reason</code> string.
          </Lede>
        </div>
      </div>
      <SlideFooter text="A · The big picture" />
    </Slide>
  );
}

// ---------- 04 Why this exists ----------
function WhySlide({ num, total }) {
  const reasons = [
    { t: 'To learn in public',             d: 'Trading with your own money to "find out" is expensive. Paper trading lets us test ideas against live data without the consequences.' },
    { t: 'To make the "why" visible',      d: 'Most trading bots are black boxes. This one writes a plain‑English reason next to every order — you can argue with it after the fact.' },
    { t: 'To combine slow + fast signals', d: 'News moves in minutes. 13F filings move in months. We wanted one system that respects both.' },
    { t: 'To stay small enough to read',   d: 'Around 1,500 lines of Python. A junior engineer should be able to understand the whole thing in an afternoon.' },
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="04 · Motivation" num={num} total={total} section="A" />
      <H1 style={{ marginBottom: 48 }}>Why build this at all.</H1>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
        {reasons.map((r, i) => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.rule}`, padding: '32px 34px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, marginBottom: 12 }}>
              <span style={{ fontFamily: serif, fontSize: 42, fontStyle: 'italic', color: C.ochre, lineHeight: 1 }}>{String(i + 1).padStart(2, '0')}</span>
              <span style={{ fontFamily: serif, fontSize: TYPE_SCALE.subtitle, letterSpacing: '-0.01em' }}>{r.t}</span>
            </div>
            <div style={{ fontSize: TYPE_SCALE.small, color: C.inkDim, lineHeight: 1.5 }}>{r.d}</div>
          </div>
        ))}
      </div>
      <SlideFooter text="A · The big picture" />
    </Slide>
  );
}

// ---------- 05 Problem it solves / quick facts ----------
function QuickFactsSlide({ num, total }) {
  const facts = [
    { k: '5 min', n: 'tick cadence',  sub: '09:30 – 16:00 ET' },
    { k: '83',    n: 'tickers',       sub: '75 equities + 8 bond ETFs' },
    { k: '4',     n: 'signals fused', sub: 'news · congress · 13F · price' },
    { k: '30',    n: 'max positions', sub: 'concurrent holdings' },
    { k: '5 %',   n: 'position size', sub: 'of equity at entry' },
    { k: '7 %',   n: 'trailing stop', sub: 'from peak since entry' },
    { k: '25 %',  n: 'sector cap',    sub: 'diversification guard' },
    { k: '10 %',  n: 'bond floor',    sub: 'minimum fixed‑income' },
  ];
  return (
    <Slide bg={C.paperAlt}>
      <SlideChrome eyebrow="05 · At a glance" num={num} total={total} section="A" />
      <H1 style={{ marginBottom: 16 }}>The whole thing, on one slide.</H1>
      <Lede color={C.inkDim} max={1300}>
        Eight numbers describe the system's shape. Everything else is an
        elaboration of these.
      </Lede>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginTop: 56 }}>
        {facts.map((f, i) => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.rule}`, padding: '30px 26px 26px' }}>
            <div style={{ fontFamily: serif, fontSize: 76, lineHeight: 1, color: C.navy, letterSpacing: '-0.035em' }}>{f.k}</div>
            <div style={{ fontSize: TYPE_SCALE.body, marginTop: 10, color: C.ink, fontWeight: 500 }}>{f.n}</div>
            <div style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.inkMute, marginTop: 4 }}>{f.sub}</div>
          </div>
        ))}
      </div>
      <SlideFooter text="A · The big picture" />
    </Slide>
  );
}

// ---------- 06 The recipe ----------
function RecipeSlide({ num, total }) {
  const steps = [
    { n: '1', t: 'Gather ingredients', k: 'Read four different kinds of information about every stock on our list.' },
    { n: '2', t: 'Turn each into a number', k: 'Each ingredient becomes a small score: +good, −bad, 0 neutral.' },
    { n: '3', t: 'Mix them with weights', k: 'News counts most (35 %), the dip bonus least (5 %). Add them up.' },
    { n: '4', t: 'Compare against thresholds', k: 'Above +1.0 → buy. Below −1.0 → sell. In between → do nothing.' },
    { n: '5', t: 'Check the rulebook', k: 'Even if the score says buy, skip it if it would break a portfolio rule.' },
    { n: '6', t: 'Write down the reason', k: 'Every decision gets a human sentence saved next to it.' },
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="06 · How it thinks" num={num} total={total} section="B" />
      <H1 style={{ marginBottom: 18 }}>The recipe, in six steps.</H1>
      <Lede color={C.inkDim}>If you understand these six lines, you understand the whole bot.</Lede>
      <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 28 }}>
        {steps.map((s) => (
          <div key={s.n} style={{
            background: C.cardAlt, border: `1px solid ${C.rule}`, padding: '30px 30px 32px',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute', top: -22, left: 28, width: 44, height: 44,
              background: C.navy, color: C.paper, fontFamily: serif, fontSize: 30,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{s.n}</div>
            <div style={{ fontFamily: serif, fontSize: 36, letterSpacing: '-0.01em', marginTop: 12, marginBottom: 12 }}>{s.t}</div>
            <div style={{ fontSize: TYPE_SCALE.small, color: C.inkDim, lineHeight: 1.5 }}>{s.k}</div>
          </div>
        ))}
      </div>
      <SlideFooter text="B · How it thinks" />
    </Slide>
  );
}

// ---------- Signal template ----------
function SignalSlide({ num, total, order, weight, accent, title, eli10, tech, source, cadence, method, code }) {
  return (
    <Slide>
      <SlideChrome eyebrow={`${String(num).padStart(2, '0')} · Signal ${order} of 4`} num={num} total={total} section="B" />
      <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 80, alignItems: 'start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 28, marginBottom: 28 }}>
            <span style={{ fontFamily: serif, fontSize: 140, lineHeight: 0.9, color: accent, letterSpacing: '-0.04em' }}>{weight}</span>
            <span style={{ fontFamily: mono, fontSize: 26, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase' }}>weight in<br />composite score</span>
          </div>
          <H1 size={60} style={{ marginBottom: 32 }}>{title}</H1>
          <div style={{ background: C.cardAlt, border: `1px solid ${C.rule}`, padding: '26px 30px', marginBottom: 24 }}>
            <div style={{ fontFamily: mono, fontSize: TYPE_SCALE.micro, color: accent, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 10 }}>
              What it is, for a kid
            </div>
            <div style={{ fontFamily: serif, fontSize: 30, color: C.ink, lineHeight: 1.35 }}>
              {eli10}
            </div>
          </div>
          <div style={{ padding: '26px 30px', border: `1px solid ${C.rule}`, background: C.card }}>
            <div style={{ fontFamily: mono, fontSize: TYPE_SCALE.micro, color: C.inkMute, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 10 }}>
              What it is, precisely
            </div>
            <div style={{ fontSize: TYPE_SCALE.small, color: C.inkDim, lineHeight: 1.5 }}>{tech}</div>
          </div>
        </div>
        <div>
          <MetaRow k="Source"   v={source} />
          <MetaRow k="Cadence"  v={cadence} />
          <MetaRow k="Method"   v={method} />
          <MetaRow k="Module"   v={code} mono />
          <div style={{ marginTop: 28, background: C.card, border: `1px solid ${C.rule}`, padding: '22px 24px' }}>
            <div style={{ fontFamily: mono, fontSize: TYPE_SCALE.micro, color: C.inkMute, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 10 }}>
              Weight bar
            </div>
            <div style={{ height: 14, background: C.paperAlt, border: `1px solid ${C.rule}`, position: 'relative' }}>
              <div style={{ width: weight, height: '100%', background: accent }} />
            </div>
          </div>
        </div>
      </div>
      <SlideFooter text="B · How it thinks" />
    </Slide>
  );
}

function MetaRow({ k, v, mono: isMono }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 24, padding: '20px 0', borderBottom: `1px solid ${C.rule}`, alignItems: 'baseline' }}>
      <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.micro, color: C.inkMute, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{k}</span>
      <span style={{ fontFamily: isMono ? mono : sans, fontSize: TYPE_SCALE.small, color: C.ink, lineHeight: 1.4 }}>{v}</span>
    </div>
  );
}

// Signal props
const SIGNAL_NEWS = {
  order: 1, weight: '35 %', accent: '#b8862c',
  title: 'News sentiment',
  eli10: "If lots of news stories today say nice things about Apple, Apple's score goes up. If they say scary things, it goes down.",
  tech:  'Every 5 min we pull RSS feeds from six financial outlets (CNBC, Reuters, Yahoo Finance, CNN Business, MarketWatch, Seeking Alpha). Each headline is scored with VADER (a lexicon‑based sentiment model). We match headlines to tickers, take a 7‑day rolling average, z‑score it. Optionally re‑score with FinBERT, a finance‑tuned transformer, for headlines that mention a universe ticker.',
  source:  'CNBC, Reuters, Yahoo Finance, CNN Business, MarketWatch, Seeking Alpha',
  cadence: 'every 5 minutes',
  method:  'VADER polarity → 7d rolling z‑score (FinBERT optional)',
  code:    'bot/news/* · bot/signals/sentiment.py',
};

const SIGNAL_POL = {
  order: 2, weight: '25 %', accent: '#1f3a5f',
  title: 'Congressional trades',
  eli10: "Members of Congress have to report their stock trades. If a bunch of them just bought Nvidia, that's interesting and nudges Nvidia's score up.",
  tech:  'The STOCK Act requires U.S. Congress members to disclose personal trades within 45 days. We pull the House Financial Disclosure XML index weekly, download the PDF reports, extract ticker and dollar values, and compute a 60‑day net‑dollar signal per ticker. Sign matters: buys are positive, sells are negative.',
  source:  'House Financial Disclosure XML + PDFs',
  cadence: 'weekly refresh',
  method:  '60‑day net $ volume of tracked congressional trades',
  code:    'bot/signals/politicians.py',
};

const SIGNAL_13F = {
  order: 3, weight: '20 %', accent: '#9e3b2a',
  title: 'Top‑investor 13F filings',
  eli10: "Very rich, very famous investors (Warren Buffett, Michael Burry, ARK, others) have to tell the SEC what they're holding every three months. If they start loading up on a stock, we take notice.",
  tech:  'We track 10 curated funds by CIK — Berkshire Hathaway, Pershing Square, Scion, Bridgewater, Renaissance, ARK, Third Point, Appaloosa, Greenlight, Baupost. Each monthly pass parses their 13F‑HR filings on SEC EDGAR and computes the dollar delta (added / trimmed / exited) per ticker. "Famous investor fully exits" is a strong close signal on its own.',
  source:  'SEC EDGAR · 10 curated fund CIKs',
  cadence: 'monthly refresh',
  method:  'latest 13F $ delta per ticker',
  code:    'bot/signals/investors.py',
};

const SIGNAL_PRICE = {
  order: 4, weight: '15 % + 5 %', accent: '#4a6b3a',
  title: 'Price momentum & dip bonus',
  eli10: "If a stock has been going up faster than the S&P 500, that's a small plus. And if a stock has fallen way below its recent high, it gets a tiny sale‑sticker bonus.",
  tech:  'Daily after close we pull historical bars from Alpaca (IEX feed) and compute each ticker\'s 20‑day return minus SPY\'s. That is the momentum term. Separately, a dip bonus adds +1 if the current price is down more than 25 % from the 52‑week high — mean‑reversion sweetener for beaten‑down names whose other signals still look positive.',
  source:  'Alpaca historical bars (IEX feed)',
  cadence: 'daily',
  method:  '(20d return − SPY 20d return); dip = +1 if drawdown > 25 %',
  code:    'bot/signals/aggregator.py',
};

// ---------- 11 Formula ----------
function FormulaSlide({ num, total }) {
  const terms = [
    { w: '0.35', k: 'news_sentiment_z',  c: C.ochre, note: '7-day rolling VADER z‑score' },
    { w: '0.25', k: 'politician_signal', c: C.navy,  note: '60‑day net congressional $' },
    { w: '0.20', k: 'investor_signal',   c: C.brick, note: '13F $ delta from tracked funds' },
    { w: '0.15', k: 'momentum',          c: C.moss,  note: '20‑day return − SPY' },
    { w: '0.05', k: 'dip_bonus',         c: C.moss,  note: '+1 if drawdown > 25 %' },
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="11 · The composite score" num={num} total={total} section="B" />
      <H1 style={{ marginBottom: 32 }}>
        Five numbers, one sum, one decision.
      </H1>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 76, alignItems: 'start' }}>
        <div style={{
          background: C.card, border: `1px solid ${C.rule}`, padding: '36px 44px',
          fontFamily: mono, fontSize: 30, lineHeight: 1.75,
        }}>
          <div style={{ color: C.inkMute, fontSize: TYPE_SCALE.micro, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 20 }}>bot/signals/aggregator.py</div>
          <div><span style={{ color: C.ink }}>composite_score</span> <span style={{ color: C.inkMute }}>=</span></div>
          {terms.map((t, i) => (
            <div key={i} style={{ paddingLeft: 28 }}>
              <span style={{ color: C.inkMute }}>{i === 0 ? '   ' : '+ '}</span>
              <span style={{ color: t.c, fontWeight: 500 }}>{t.w}</span>
              <span style={{ color: C.inkMute }}> * </span>
              <span style={{ color: C.ink }}>{t.k}</span>
            </div>
          ))}
          <div style={{ marginTop: 28, paddingTop: 22, borderTop: `1px dashed ${C.rule}`, color: C.inkDim, fontSize: TYPE_SCALE.micro }}>
            open if &gt; <span style={{ color: C.moss, fontWeight: 500 }}>+1.0</span>  ·  close if &lt; <span style={{ color: C.brick, fontWeight: 500 }}>−1.0</span>
          </div>
        </div>
        <div>
          <Kicker>In English</Kicker>
          <Lede>
            Take each of the four signals, multiply it by how much we trust it,
            and add them up. News matters most because it's the freshest.
            Politicians and fund managers each get a fifth or a quarter. Price
            momentum is a tiebreaker. The dip bonus is a small nudge that lets
            us buy quality names after they sell off.
          </Lede>
          <div style={{ marginTop: 32 }}>
            {terms.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '10px 0', borderBottom: i < terms.length - 1 ? `1px solid ${C.rule}` : 'none' }}>
                <div style={{ width: 70, fontFamily: mono, fontSize: TYPE_SCALE.body, color: t.c, fontWeight: 500 }}>{t.w}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: TYPE_SCALE.small, fontWeight: 500 }}>{t.k.replace(/_/g, ' ')}</div>
                  <div style={{ fontSize: TYPE_SCALE.micro, color: C.inkMute }}>{t.note}</div>
                </div>
                <div style={{ width: 200, height: 8, background: C.paperAlt, border: `1px solid ${C.rule}` }}>
                  <div style={{ width: `${parseFloat(t.w) / 0.35 * 100}%`, maxWidth: '100%', height: '100%', background: t.c }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <SlideFooter text="B · How it thinks" />
    </Slide>
  );
}

// ---------- 12 Score → action ----------
function ScoreToActionSlide({ num, total }) {
  const zones = [
    { from: '≥ +1.0', c: C.moss,  t: 'Buy zone',    d: 'A new name enters the buy queue, ranked by score, subject to portfolio rules.' },
    { from: '+1.0 to −1.0', c: C.inkMute, t: 'Hold zone', d: 'Do nothing. Positions we already own keep sitting.' },
    { from: '≤ −1.0', c: C.brick, t: 'Sell zone',   d: 'If we own it, close the position. We log the reason and the signal breakdown.' },
  ];
  return (
    <Slide bg={C.paperAlt}>
      <SlideChrome eyebrow="12 · Score to action" num={num} total={total} section="B" />
      <H1 style={{ marginBottom: 48 }}>What the score actually triggers.</H1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 28 }}>
        {zones.map((z, i) => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.rule}`, padding: '36px 36px 40px' }}>
            <div style={{ fontFamily: mono, fontSize: TYPE_SCALE.micro, color: z.c, letterSpacing: '0.18em', textTransform: 'uppercase' }}>Score {z.from}</div>
            <div style={{ fontFamily: serif, fontSize: 54, marginTop: 14, color: z.c, letterSpacing: '-0.02em' }}>{z.t}</div>
            <div style={{ fontSize: TYPE_SCALE.small, color: C.inkDim, lineHeight: 1.5, marginTop: 20 }}>{z.d}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 56 }}>
        <div>
          <Kicker>Why the wide dead zone?</Kicker>
          <Lede>
            We deliberately leave a gap between −1 and +1 where nothing happens.
            Scores drift around a little every tick. Without the buffer, we'd
            churn trades (and commissions, and slippage) on noise.
          </Lede>
        </div>
        <div>
          <Kicker>What the decision log records</Kicker>
          <Lede>
            For every ticker, every tick: the action (<em>buy, sell, hold, add, trim, stop</em>),
            the composite score, the per‑signal components, and a sentence like
            <em> "news avg_vader +0.32 over 9 headlines (+1.8σ); 20d return +12.4 % vs SPY +3.1 %".</em>
          </Lede>
        </div>
      </div>
      <SlideFooter text="B · How it thinks" />
    </Slide>
  );
}

// ---------- 13 Decision tree ----------
function DecisionSlide({ num, total }) {
  const Col = ({ head, color, rows }) => (
    <div>
      <div style={{ fontFamily: mono, fontSize: TYPE_SCALE.micro, color, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 16 }}>
        {head}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.rule}`, padding: '16px 20px' }}>
            <div style={{ fontFamily: serif, fontSize: 26, letterSpacing: '-0.01em', marginBottom: 4 }}>{r.t}</div>
            <div style={{ fontFamily: mono, fontSize: 24, color: C.inkMute, marginBottom: 4 }}>{r.c}</div>
            <div style={{ fontSize: 24, color: C.inkDim, lineHeight: 1.35 }}>{r.e}</div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <Slide>
      <SlideChrome eyebrow="13 · Decision tree" num={num} total={total} section="B" />
      <H1 style={{ marginBottom: 12 }}>Every tick, every holding is re‑checked in this order.</H1>
      <Lede color={C.inkDim}>Earlier rows beat later rows — a stop always wins over a rebalance trim.</Lede>
      <div style={{ marginTop: 28, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24 }}>
        <Col head="On names we already own" color={C.brick} rows={[
          { t: 'Stop',    c: 'price < peak × (1 − 7 %)', e: "Emergency brake. Doesn't care about score." },
          { t: 'Exit',    c: 'composite < −1.0',          e: 'Thesis has flipped negative. Close.' },
          { t: 'Trim',    c: 'weight > 8 % → back to 5 %',e: 'Stop any one name from dominating the portfolio.' },
          { t: 'Dip add', c: '−25 % from cost & score > 0', e: 'Buy 50 % more of a winning thesis that sold off.' },
        ]} />
        <Col head="On new candidates" color={C.navy} rows={[
          { t: 'Open',         c: 'composite > +1.0, ranked desc', e: 'Highest‑conviction fresh name first.' },
          { t: 'Sector cap',   c: 'total sector ≤ 25 %',            e: "Don't become a pure‑tech fund by accident." },
          { t: 'Cash reserve', c: 'keep ≥ 8 % cash',                e: 'Dry powder for dips and stops.' },
          { t: 'Size',         c: '5 % of equity at entry',         e: 'Same bet size for everyone, every time.' },
        ]} />
        <Col head="On portfolio shape" color={C.moss} rows={[
          { t: 'FI floor',        c: 'bonds ≥ 10 % → buy AGG',  e: 'Ballast against equity drawdowns.' },
          { t: 'FI ceiling',      c: 'target ≤ 15 %',            e: 'Not a bond fund either.' },
          { t: 'Max positions',   c: '30 concurrent',            e: 'Hard cap keeps the book readable.' },
          { t: 'Rebalance day',   c: 'Friday trim pass',         e: 'Weekly walk back to target weights.' },
        ]} />
      </div>
      <SlideFooter text="B · How it thinks" />
    </Slide>
  );
}

// ---------- 14 Risk guardrails ----------
function RiskSlide({ num, total }) {
  const dials = [
    { k: 'MAX_POSITION_PCT',    v: '5 %',  n: 'hard cap at entry',    e: 'No single name is ever more than 1/20 of the book on day one.' },
    { k: 'REBALANCE_TRIM_PCT',  v: '8 %',  n: 'trim threshold',       e: 'If a winner grows past 8 %, we sell down to 5 %.' },
    { k: 'MAX_SECTOR_PCT',      v: '25 %', n: 'per‑sector ceiling',   e: 'Tech, consumer, financials — none can dominate.' },
    { k: 'CASH_RESERVE_PCT',    v: '8 %',  n: 'cash floor',           e: 'Always leave ammunition for dip‑buys and stops.' },
    { k: 'TRAILING_STOP_PCT',   v: '7 %',  n: 'trailing stop',        e: 'If a holding falls 7 % from its peak, we sell it.' },
    { k: 'DIP_ADD_DRAWDOWN',    v: '25 %', n: 'dip add trigger',      e: 'Only add more if the thesis is still positive.' },
    { k: 'FIXED_INCOME_FLOOR',  v: '10 %', n: 'minimum bonds',        e: 'Boring, steady ballast.' },
    { k: 'MAX_POSITIONS',       v: '30',   n: 'concurrent holdings',  e: 'More than 30 is too many to reason about.' },
  ];
  return (
    <Slide bg={C.paperAlt}>
      <SlideChrome eyebrow="14 · Risk guardrails" num={num} total={total} section="B" />
      <H1 style={{ marginBottom: 18 }}>The rules that override the robot.</H1>
      <Lede color={C.inkDim}>These aren't scored — they're hard constraints in <code style={{ fontFamily: mono }}>bot/config.py</code> and <code style={{ fontFamily: mono }}>bot/risk.py</code>.</Lede>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18, marginTop: 48 }}>
        {dials.map((d, i) => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.rule}`, padding: '24px 22px 22px' }}>
            <div style={{ fontFamily: mono, fontSize: 20, color: C.inkMute, letterSpacing: '0.1em' }}>{d.k}</div>
            <div style={{ fontFamily: serif, fontSize: 62, color: C.navy, lineHeight: 1, letterSpacing: '-0.03em', marginTop: 8 }}>{d.v}</div>
            <div style={{ fontSize: 22, color: C.ink, marginTop: 8, fontWeight: 500 }}>{d.n}</div>
            <div style={{ fontSize: 20, color: C.inkDim, marginTop: 6, lineHeight: 1.4 }}>{d.e}</div>
          </div>
        ))}
      </div>
      <SlideFooter text="B · How it thinks" />
    </Slide>
  );
}

// ---------- 15 Typical tick ----------
function TickSlide({ num, total }) {
  const steps = [
    { t: 'T + 0s',  h: 'Pull news',        b: 'RSS scrape → VADER polarity → upsert new headlines to the news table.' },
    { t: 'T + 20s', h: 'Refresh signals',  b: 'Aggregate news + politician + 13F + momentum + dip into a per‑ticker score.' },
    { t: 'T + 40s', h: 'Read account',     b: 'Query Alpaca for equity, cash, buying power, and current positions.' },
    { t: 'T + 50s', h: 'Plan orders',      b: 'strategy.plan() emits PlannedOrder[] and writes Decision rows (even for "hold").' },
    { t: 'T + 60s', h: 'Execute',          b: 'alpaca-py submits market orders — or in DRY_RUN, we log what we would have done.' },
    { t: 'T + 65s', h: 'Persist',          b: 'Positions + trades + decisions flush to SQLite so the dashboard can read them.' },
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="15 · A typical 5‑min tick" num={num} total={total} section="B" />
      <H1 style={{ marginBottom: 12 }}>One tick, second by second.</H1>
      <Lede color={C.inkDim}>APScheduler fires every 5 minutes between 09:30 and 16:00 ET. Each cycle takes well under a minute, leaving plenty of slack.</Lede>
      <div style={{ position: 'relative', marginTop: 28 }}>
        <div style={{ position: 'absolute', left: 146, top: 18, bottom: 18, width: 2, background: C.rule }} />
        {steps.map((s, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '132px 28px 1fr', gap: 24, alignItems: 'start', padding: '14px 0' }}>
            <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.ochre, paddingTop: 6 }}>{s.t}</span>
            <span style={{ width: 18, height: 18, background: C.navy, borderRadius: '50%', marginTop: 10, justifySelf: 'center', border: `3px solid ${C.paper}`, boxShadow: `0 0 0 1px ${C.navy}` }} />
            <span>
              <div style={{ fontFamily: serif, fontSize: 36, letterSpacing: '-0.01em' }}>{s.h}</div>
              <div style={{ fontSize: TYPE_SCALE.small, color: C.inkDim, marginTop: 2, lineHeight: 1.4 }}>{s.b}</div>
            </span>
          </div>
        ))}
      </div>
      <SlideFooter text="B · How it thinks" />
    </Slide>
  );
}

// ---------- 16 Stack ----------
function StackSlide({ num, total }) {
  const layers = [
    { k: 'Bot (headless)',         tech: 'Python 3.12 · APScheduler · SQLAlchemy · Pydantic · loguru', role: "The trader. Runs every 5 min, makes the decisions." },
    { k: 'Signals',                tech: 'vaderSentiment · BeautifulSoup · feedparser · (optional) PyTorch + FinBERT', role: 'Turn words and filings into numbers.' },
    { k: 'Market data / orders',   tech: 'alpaca-py (IEX feed, paper endpoint)', role: 'The bridge to the outside world.' },
    { k: 'Storage',                tech: 'SQLite via SQLAlchemy — a single trading.db file', role: 'One file, zero server, trivially backup‑able.' },
    { k: 'Read API',               tech: 'FastAPI · uvicorn', role: 'Exposes what the bot did, without exposing keys.' },
    { k: 'Dashboard',              tech: 'Next.js 16 · TypeScript · Tailwind (hand‑built components)', role: 'The human‑facing window into the bot.' },
    { k: 'Scheduling',             tech: 'Windows Task Scheduler (scripts/register_task.bat)', role: 'Starts the bot at 09:25 on weekdays; NYSE calendar gates the rest.' },
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="16 · How it was built" num={num} total={total} section="C" />
      <H1 style={{ marginBottom: 48 }}>Seven small, boring pieces.</H1>
      <div style={{ borderTop: `1px solid ${C.rule}` }}>
        {layers.map((l, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '320px 1fr 520px', gap: 40,
            padding: '24px 0', borderBottom: `1px solid ${C.rule}`, alignItems: 'baseline',
          }}>
            <span style={{ fontFamily: serif, fontSize: 34, letterSpacing: '-0.01em' }}>{l.k}</span>
            <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.navy }}>{l.tech}</span>
            <span style={{ fontSize: TYPE_SCALE.small, color: C.inkDim }}>{l.role}</span>
          </div>
        ))}
      </div>
      <SlideFooter text="C · How it was built" />
    </Slide>
  );
}

// ---------- 17 Data model ----------
function DataModelSlide({ num, total }) {
  const tables = [
    { t: 'positions',  cols: 'ticker · qty · avg_cost · market_price · market_value · peak_price',
      purpose: 'Current book. Mutated after every fill.' },
    { t: 'trades',     cols: 'id · ts · ticker · side · qty · price · reason',
      purpose: "Immutable history of everything the bot did." },
    { t: 'decisions',  cols: 'id · ts · ticker · action · composite_score · score_breakdown (json) · reason',
      purpose: 'One row per ticker per tick, including hold decisions — the "why".' },
    { t: 'news',       cols: 'id · ts · source · headline · url · tickers · vader · finbert_label',
      purpose: 'Raw headlines with sentiment scores. Deduped by URL.' },
    { t: 'signals',    cols: 'id · ts · ticker · kind · value · components (json)',
      purpose: 'Point‑in‑time signal values for replay and debugging.' },
  ];
  return (
    <Slide bg={C.paperAlt}>
      <SlideChrome eyebrow="17 · Data model" num={num} total={total} section="C" />
      <H1 style={{ marginBottom: 18 }}>Five tables, one SQLite file.</H1>
      <Lede color={C.inkDim}>No ORM cleverness, no migrations yet. The whole schema fits on one slide on purpose.</Lede>
      <div style={{ marginTop: 40 }}>
        {tables.map((t, i) => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.rule}`, padding: '24px 30px', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 380px', gap: 32, alignItems: 'baseline' }}>
              <span style={{ fontFamily: mono, fontSize: 36, color: C.navy }}>{t.t}</span>
              <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.ink }}>{t.cols}</span>
              <span style={{ fontSize: TYPE_SCALE.small, color: C.inkDim }}>{t.purpose}</span>
            </div>
          </div>
        ))}
      </div>
      <SlideFooter text="C · How it was built" />
    </Slide>
  );
}

// ---------- 18 Dashboard ----------
function DashboardSlide({ num, total }) {
  const pages = [
    { k: '/',          t: 'Overview',     d: 'Portfolio value, bot status, next‑tick countdown.' },
    { k: '/positions', t: 'Positions',    d: 'Weights, P&L, a sector donut.' },
    { k: '/trades',    t: 'Trade journal',d: 'Every order with the why‑string attached.' },
    { k: '/news',      t: 'News',         d: 'Scored headlines grouped by ticker.' },
    { k: '/signals',   t: 'Signals',      d: 'Politician and 13F activity driving the score.' },
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="18 · The dashboard" num={num} total={total} section="C" />
      <H1 style={{ marginBottom: 16 }}>A read‑only window into the bot's reasoning.</H1>
      <Lede color={C.inkDim}>Runs locally at :3000. Never touches Alpaca directly — it asks FastAPI, which asks SQLite.</Lede>
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 64, alignItems: 'start', marginTop: 40 }}>
        <div style={{ background: C.card, border: `1px solid ${C.rule}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: `1px solid ${C.rule}`, background: C.cardAlt }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#e07a6a' }} />
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#e0b86a' }} />
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#8fb06a' }} />
            <span style={{ marginLeft: 16, fontFamily: mono, fontSize: 24, color: C.inkMute }}>localhost:3000 / positions</span>
          </div>
          <div style={{ padding: '32px 36px 36px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontFamily: serif, fontSize: 38 }}>Portfolio</div>
              <div style={{ fontFamily: mono, fontSize: 24, color: C.inkMute }}>next cycle · 02:41</div>
            </div>
            <div style={{ fontFamily: serif, fontSize: 72, color: C.navy, marginTop: 6, letterSpacing: '-0.03em' }}>$104,217.83</div>
            <div style={{ fontFamily: mono, fontSize: 26, color: C.moss, marginTop: 2 }}>+ $4,217.83 &nbsp;·&nbsp; + 4.22 %</div>
            <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
              {[['NVDA', '+2.1 %', C.moss], ['UNH', '−0.8 %', C.brick], ['AGG', '+0.3 %', C.moss]].map(([t, p, c]) => (
                <div key={t} style={{ border: `1px solid ${C.rule}`, padding: '14px 16px', background: C.cardAlt }}>
                  <div style={{ fontFamily: mono, fontSize: 20, color: C.inkMute, letterSpacing: '0.14em' }}>POSITION</div>
                  <div style={{ fontFamily: serif, fontSize: 32, marginTop: 2 }}>{t}</div>
                  <div style={{ fontFamily: mono, fontSize: 24, color: c, marginTop: 2 }}>{p}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 20, padding: '16px 18px', background: C.cardAlt, border: `1px solid ${C.rule}`, fontFamily: mono, fontSize: 22, color: C.inkDim, lineHeight: 1.5 }}>
              <span style={{ color: C.navy, fontWeight: 500 }}>buy NVDA</span> · news avg_vader +0.32 over 9 headlines (+1.8σ); 20d return +12.4 % vs SPY +3.1 % | composite=+1.42
            </div>
          </div>
        </div>
        <div>
          <Kicker>Pages</Kicker>
          {pages.map((p, i) => (
            <div key={p.k} style={{
              display: 'grid', gridTemplateColumns: '160px 220px 1fr', gap: 18,
              padding: '18px 0', borderBottom: `1px solid ${C.rule}`, alignItems: 'baseline',
            }}>
              <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.navy }}>{p.k}</span>
              <span style={{ fontFamily: serif, fontSize: 30 }}>{p.t}</span>
              <span style={{ fontSize: TYPE_SCALE.small, color: C.inkDim }}>{p.d}</span>
            </div>
          ))}
        </div>
      </div>
      <SlideFooter text="C · How it was built" />
    </Slide>
  );
}

// ---------- 19 Limits ----------
function LimitsSlide({ num, total }) {
  const limits = [
    { t: 'IEX feed only',
      e: "We're on Alpaca's free tier, which sees about 3 % of total market volume. Thinly traded small‑caps can have gaps in their price history.",
      p: 'Affects momentum + dip signals most; core large‑caps are fine.' },
    { t: 'Disclosure data is slow',
      e: 'Members of Congress get 45 days to report trades. Hedge funds get 45 days to report holdings. By the time we see either, everyone else has too.',
      p: "This is an information‑arbitrage signal, not day‑trading alpha." },
    { t: 'Headlines only, no article bodies',
      e: "We only read RSS, not the articles behind them. A careful headline can miss crucial context in paragraph four.",
      p: 'Unavoidable without paid licenses; VADER on headlines still has signal.' },
    { t: 'No backtest, no attribution',
      e: "We've never replayed history through the strategy. We can't say which signal is pulling its weight or whether the weights are correct.",
      p: 'This is the single most important gap. See roadmap.' },
    { t: 'Only the trailing stop watches mid‑tick',
      e: 'Between 5‑minute ticks, a catastrophic news event could move a position 15 % before we notice.',
      p: 'Mitigated by max position size (5 %); still a real exposure.' },
    { t: 'Single process, single box',
      e: 'One Python process on one Windows machine. No failover, no alerting, no model versioning, no disaster recovery.',
      p: "Fine for a paper experiment; unacceptable if real money ever gets near it." },
  ];
  return (
    <Slide>
      <SlideChrome eyebrow="19 · What it doesn't do (yet)" num={num} total={total} section="D" />
      <H1 style={{ marginBottom: 48 }}>Six honest limits.</H1>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        {limits.map((l, i) => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.rule}`, padding: '24px 28px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 10 }}>
              <span style={{ fontFamily: serif, fontSize: 34, color: C.ochre, fontStyle: 'italic', lineHeight: 1 }}>{String(i + 1).padStart(2, '0')}</span>
              <span style={{ fontFamily: serif, fontSize: 32, letterSpacing: '-0.01em' }}>{l.t}</span>
            </div>
            <div style={{ fontSize: 22, color: C.inkDim, lineHeight: 1.45, marginBottom: 10 }}>{l.e}</div>
            <div style={{ fontFamily: mono, fontSize: 20, color: C.navy, letterSpacing: '0.04em' }}>→ {l.p}</div>
          </div>
        ))}
      </div>
      <SlideFooter text="D · Limits & roadmap" />
    </Slide>
  );
}

// ---------- 20–21 Roadmap ----------
function RoadmapSlide({ num, total, horizon, tag, intro, items }) {
  return (
    <Slide bg={num % 2 === 0 ? C.paperAlt : C.paper}>
      <SlideChrome eyebrow={`${num} · Roadmap · ${horizon}`} num={num} total={total} section="D" />
      <H1 style={{ marginBottom: 16 }}>{`What to build ${horizon}.`}</H1>
      <Lede color={C.inkDim}>{intro}</Lede>
      <div style={{ marginTop: 40, borderTop: `1px solid ${C.rule}` }}>
        {items.map((it, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '64px 380px 1fr 160px', gap: 28,
            padding: '22px 0', borderBottom: `1px solid ${C.rule}`, alignItems: 'start',
          }}>
            <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.ochre, paddingTop: 4 }}>{String(i + 1).padStart(2, '0')}</span>
            <span style={{ fontFamily: serif, fontSize: 34, letterSpacing: '-0.01em' }}>{it.t}</span>
            <span style={{ fontSize: TYPE_SCALE.small, color: C.inkDim, lineHeight: 1.45 }}>{it.d}</span>
            <span style={{ fontFamily: mono, fontSize: 22, color: it.cost === 'high' ? C.brick : it.cost === 'med' ? C.ochre : C.moss, letterSpacing: '0.14em', textTransform: 'uppercase', textAlign: 'right', paddingTop: 6 }}>{it.cost} effort</span>
          </div>
        ))}
      </div>
      <SlideFooter text="D · Limits & roadmap" />
    </Slide>
  );
}

const NEAR = [
  { t: 'Bundle a backtest harness',   d: 'Replay ~2 years of news + bars through strategy.plan(). Report Sharpe, max drawdown, turnover. Without this, every other change is a guess.', cost: 'med' },
  { t: 'Per‑signal kill switches',    d: 'A config flag to disable any one of the four signals at runtime, so we can A/B which signal is actually helping.', cost: 'low' },
  { t: 'Alerting',                    d: 'Webhook or email on stop‑outs, stale RSS feeds, API auth failures, or unusually large planned orders.', cost: 'low' },
  { t: 'Nightly equity snapshots',    d: 'Freeze equity + weights at 16:05 ET every day so the dashboard can plot a real history curve instead of the current only‑now view.', cost: 'low' },
  { t: 'Dry‑run → live toggle UI',    d: 'A confirm‑phrase gate in the dashboard to flip DRY_RUN off, with a visible banner when live.', cost: 'low' },
];

const MID = [
  { t: 'Replace VADER with FinBERT by default', d: "VADER is general‑domain; FinBERT is finance‑tuned. Move VADER to the fast‑path fallback.", cost: 'med' },
  { t: 'Learned signal weights',                d: 'Grid‑search or Bayesian‑optimize the five weights against the backtester. No more hand‑tuned numbers.', cost: 'med' },
  { t: 'Broaden the universe',                  d: 'Lift the 83‑ticker cap; admit S&P 1500 + liquid ETFs, gated by a liquidity filter so IEX sparseness stays tolerable.', cost: 'med' },
  { t: 'Intraday catastrophe exits',            d: 'Sub‑tick stop on detected catastrophic news (CEO resigns, fraud, etc.) rather than waiting for the 5‑min cycle.', cost: 'med' },
  { t: 'LLM reasoning layer',                   d: 'Summarize the reason string + recent headlines into a plain‑English thesis per holding, shown on the dashboard.', cost: 'med' },
];

const LONG = [
  { t: 'Earnings & filings ingestion',  d: '10‑K / 10‑Q / 8‑K parsing → guidance deltas as a 6th signal.', cost: 'high' },
  { t: 'Walk‑forward model training',   d: 'Re‑fit weights weekly on rolling windows instead of locking them in code.', cost: 'high' },
  { t: 'Multi‑strategy orchestrator',   d: 'Run several strategies side‑by‑side with a risk allocator. The dashboard grows a "strategies" tab.', cost: 'high' },
  { t: 'Live trading with governance',  d: 'Only after 6+ months of paper stability: a live risk budget, kill switch, and pre‑trade compliance checks.', cost: 'high' },
];

// ---------- 22 Summary ----------
function SummarySlide({ num, total }) {
  return (
    <Slide>
      <SlideChrome eyebrow="Summary" num={num} total={total} section="–" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 88, alignItems: 'start', marginTop: 10 }}>
        <div>
          <H1 size={80} style={{ marginBottom: 40 }}>
            Small, transparent,<br />
            <em style={{ fontStyle: 'italic', color: C.navy }}>honest about its limits.</em>
          </H1>
          <Lede>
            The bot is small enough to read in an afternoon and transparent
            enough to argue with. The next unlock isn't more signals — it's
            <em> measurement</em>. A backtester and per‑signal attribution come
            first; everything else is a guess until those exist.
          </Lede>
        </div>
        <div>
          {[
            ['Today',      'Headless bot + FastAPI + Next.js dashboard. Paper only. ~1,500 LOC Python, single SQLite file.'],
            ['Next',       'Backtest harness, per‑signal kill switches, alerting, nightly snapshots.'],
            ['Then',       'FinBERT‑by‑default, learned weights, broader universe, intraday catastrophe exits.'],
            ['Eventually', 'Multi‑strategy, LLM reasoning, filings ingestion, governed live trading.'],
          ].map(([k, v]) => (
            <div key={k} style={{
              display: 'grid', gridTemplateColumns: '200px 1fr', gap: 24,
              padding: '20px 0', borderBottom: `1px solid ${C.rule}`, alignItems: 'baseline',
            }}>
              <span style={{ fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.ochre, letterSpacing: '0.14em', textTransform: 'uppercase' }}>{k}</span>
              <span style={{ fontSize: TYPE_SCALE.small, color: C.ink, lineHeight: 1.45 }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop: 44, fontFamily: mono, fontSize: TYPE_SCALE.small, color: C.navy, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            Thank you — questions?
          </div>
        </div>
      </div>
      <SlideFooter text="Summary" />
    </Slide>
  );
}

Object.assign(window, {
  CoverSlide, AgendaSlide, ELI10Slide, WhySlide, QuickFactsSlide,
  RecipeSlide, SignalSlide, FormulaSlide, ScoreToActionSlide, DecisionSlide,
  RiskSlide, TickSlide, StackSlide, DataModelSlide, DashboardSlide,
  LimitsSlide, RoadmapSlide, SummarySlide,
  SIGNAL_NEWS, SIGNAL_POL, SIGNAL_13F, SIGNAL_PRICE,
  NEAR, MID, LONG, C,
});
