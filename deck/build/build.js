// Generates ../Alpaca Bot Deck.pptx from the content of the original
// Claude Design handoff (see ../../data/design/deck/).
//
// Run with:   node build.js
//
// No build-time toolchain changes: pptxgenjs is scoped to this folder and its
// node_modules/ is gitignored.

const pptx = require("pptxgenjs");
const path = require("path");

// ---------- Palette (from components.jsx) ----------
const C = {
  paper:   "F6F1E7",
  paperAlt:"EFE8D9",
  card:    "FFFFFF",
  cardAlt: "FBF7EC",
  ink:     "1A1C21",
  inkDim:  "4A4F58",
  inkMute: "7A8190",
  rule:    "DCD4BF",
  navy:    "1F3A5F",
  ochre:   "B8862C",
  brick:   "9E3B2A",
  moss:    "4A6B3A",
};

const SERIF = "Georgia";        // proxy for Fraunces
const SANS  = "Calibri";        // proxy for Inter
const MONO  = "Consolas";       // proxy for JetBrains Mono

const TOTAL = 23;

const p = new pptx();
p.layout = "LAYOUT_WIDE";       // 13.3 × 7.5 in
p.author = "TheCromazone";
p.title  = "Alpaca paper trading bot — technical review";

const W = 13.3, H = 7.5;
const PADX = 0.6, PADT = 0.5, PADB = 0.45;
const CONTENT_TOP = PADT + 0.55;          // under eyebrow
const CONTENT_H   = H - CONTENT_TOP - PADB - 0.35;  // leave footer

// ---------- helpers ----------
function base(slide, bg = C.paper) {
  slide.background = { color: bg };
}

function eyebrow(slide, text, num, section) {
  // Left: accent rule + label
  slide.addShape(p.shapes.RECTANGLE, {
    x: PADX, y: PADT + 0.13, w: 0.22, h: 0.02,
    fill: { color: C.navy }, line: { color: C.navy },
  });
  slide.addText(text, {
    x: PADX + 0.3, y: PADT, w: 7, h: 0.35,
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 3, bold: false, margin: 0,
  });
  // Right: section · NN / TOT
  const right = `${section} · ${String(num).padStart(2, "0")} / ${String(TOTAL).padStart(2, "0")}`;
  slide.addText(right, {
    x: W - PADX - 3, y: PADT, w: 3, h: 0.35, align: "right",
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 3, margin: 0,
  });
}

function footer(slide, text) {
  slide.addText("Alpaca paper trading bot", {
    x: PADX, y: H - PADB, w: 5, h: 0.3,
    fontFace: MONO, fontSize: 9, color: C.inkMute, charSpacing: 3, margin: 0,
  });
  slide.addText(text.toUpperCase(), {
    x: W - PADX - 5, y: H - PADB, w: 5, h: 0.3, align: "right",
    fontFace: MONO, fontSize: 9, color: C.inkMute, charSpacing: 3, margin: 0,
  });
}

function h1(slide, text, y = CONTENT_TOP, fontSize = 36, w = W - 2 * PADX) {
  slide.addText(text, {
    x: PADX, y, w, h: 1.0,
    fontFace: SERIF, fontSize, color: C.ink, bold: false, italic: false, margin: 0,
    charSpacing: -1,
  });
}

function kicker(slide, text, x, y) {
  slide.addText(text.toUpperCase(), {
    x, y, w: 3, h: 0.3,
    fontFace: MONO, fontSize: 10, color: C.navy, charSpacing: 4, margin: 0,
  });
}

function body(slide, text, opts) {
  slide.addText(text, {
    fontFace: SANS, fontSize: 13, color: C.inkDim, paraSpaceAfter: 4, margin: 0, ...opts,
  });
}

function rule(slide, x, y, w, color = C.rule) {
  slide.addShape(p.shapes.LINE, {
    x, y, w, h: 0,
    line: { color, width: 0.75 },
  });
}

function card(slide, x, y, w, h, opts = {}) {
  slide.addShape(p.shapes.RECTANGLE, {
    x, y, w, h,
    fill: { color: opts.fill || C.card },
    line: { color: C.rule, width: 0.5 },
  });
}

// ================================================================
// 01 — Cover
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  s.addText("Technical review · v0.1", {
    x: PADX, y: PADT, w: 6, h: 0.3,
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 5, margin: 0,
  });
  s.addText("April 2026", {
    x: W - PADX - 3, y: PADT, w: 3, h: 0.3, align: "right",
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 5, margin: 0,
  });
  s.addText("AUTONOMOUS PAPER-TRADER", {
    x: PADX, y: 2.3, w: 10, h: 0.4,
    fontFace: MONO, fontSize: 14, color: C.ochre, charSpacing: 6, margin: 0,
  });
  s.addText([
    { text: "How the Alpaca\n", options: { fontFace: SERIF, fontSize: 66, color: C.ink } },
    { text: "paper trading", options: { fontFace: SERIF, fontSize: 66, color: C.navy, italic: true } },
    { text: " bot\nactually works.", options: { fontFace: SERIF, fontSize: 66, color: C.ink } },
  ], { x: PADX, y: 2.8, w: 12, h: 3.3, charSpacing: -2, margin: 0 });
  s.addText(
    "A plain-English, precise walkthrough of what the bot is, how it was built, and every concrete thing that could make it better.",
    { x: PADX, y: 5.6, w: 9, h: 0.9, fontFace: SANS, fontSize: 15, color: C.inkDim, margin: 0 }
  );
  rule(s, PADX, H - 0.75, W - 2 * PADX, C.rule);
  s.addText("paper-api.alpaca.markets · DRY_RUN=true", {
    x: PADX, y: H - 0.6, w: 7, h: 0.3,
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 4, margin: 0,
  });
  s.addText(`${TOTAL} slides · ~15 min read`, {
    x: W - PADX - 5, y: H - 0.6, w: 5, h: 0.3, align: "right",
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 4, margin: 0,
  });
})();

// ================================================================
// 02 — Agenda
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "AGENDA", 2, "00");
  h1(s, "A short tour, in four parts.");
  const sections = [
    ["A", "The big picture", "What the bot is and why we built it", "03–05"],
    ["B", "How it thinks", "Four signals + one composite score + a decision tree", "06–13"],
    ["C", "How it was built", "Tech stack, data model, the dashboard", "14–17"],
    ["D", "Limits & roadmap", "What it cannot do yet, and what to build next", "18–21"],
  ];
  const rowY = 2.6, rowH = 0.85;
  rule(s, PADX, rowY - 0.1, W - 2 * PADX);
  sections.forEach(([k, t, d, r], i) => {
    const y = rowY + i * rowH;
    s.addText(k, { x: PADX, y, w: 0.7, h: rowH, fontFace: SERIF, fontSize: 36, italic: true, color: C.navy, margin: 0 });
    s.addText(t, { x: PADX + 0.8, y: y + 0.1, w: 4, h: rowH, fontFace: SERIF, fontSize: 22, color: C.ink, margin: 0, charSpacing: -0.5 });
    s.addText(d, { x: PADX + 4.9, y: y + 0.15, w: 6, h: rowH, fontFace: SANS, fontSize: 13, color: C.inkDim, margin: 0 });
    s.addText(r, { x: W - PADX - 1.2, y: y + 0.15, w: 1.2, h: rowH, fontFace: MONO, fontSize: 12, color: C.inkMute, align: "right", margin: 0 });
    rule(s, PADX, y + rowH, W - 2 * PADX);
  });
  footer(s, "Agenda");
})();

// ================================================================
// 03 — Plain English (ELI10)
// ================================================================
(() => {
  const s = p.addSlide();
  base(s, C.paperAlt);
  eyebrow(s, "03 · IN PLAIN ENGLISH", 3, "A");
  const colW = (W - 3 * PADX) / 2;
  // Left
  kicker(s, "Explain it like I'm ten", PADX, CONTENT_TOP);
  s.addText([
    { text: "It's a ", options: { fontFace: SERIF, fontSize: 34, color: C.ink } },
    { text: "robot stock-picker", options: { fontFace: SERIF, fontSize: 34, italic: true, color: C.navy } },
    { text: " that plays with fake money.", options: { fontFace: SERIF, fontSize: 34, color: C.ink } },
  ], { x: PADX, y: CONTENT_TOP + 0.4, w: colW, h: 2.0, charSpacing: -1, margin: 0 });
  body(s, "Every five minutes during the trading day, the robot reads the news, peeks at what politicians and famous investors are buying, checks which stocks have been going up, and gives each company a score. If the score is high, it buys a little. If it turns bad, it sells. Nothing here is real money — we're practicing.",
    { x: PADX, y: CONTENT_TOP + 2.6, w: colW, h: 2.5, fontSize: 13 });

  // Right
  const x2 = PADX + colW + PADX;
  kicker(s, "The same thing, precisely", x2, CONTENT_TOP);
  s.addText("A signal-fused, risk-bounded paper trader.", {
    x: x2, y: CONTENT_TOP + 0.4, w: colW, h: 1.4,
    fontFace: SERIF, fontSize: 26, italic: true, color: C.ink, margin: 0, charSpacing: -0.5,
  });
  body(s, "A headless Python process on a 5-minute APScheduler loop, pointed at Alpaca's paper endpoint. It aggregates four independent signals — news sentiment, STOCK Act disclosures, 13F deltas, and price momentum — into a weighted composite score per ticker, then runs a decision tree gated by portfolio-shape constraints. Every order is persisted with a human-readable reason string.",
    { x: x2, y: CONTENT_TOP + 1.9, w: colW, h: 3.2, fontSize: 13 });
  footer(s, "A · The big picture");
})();

// ================================================================
// 04 — Why
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "04 · MOTIVATION", 4, "A");
  h1(s, "Why build this at all.");
  const reasons = [
    ["To learn in public", "Trading with your own money to \"find out\" is expensive. Paper trading lets us test ideas against live data without the consequences."],
    ["To make the \"why\" visible", "Most trading bots are black boxes. This one writes a plain-English reason next to every order — you can argue with it after the fact."],
    ["To combine slow + fast signals", "News moves in minutes. 13F filings move in months. We wanted one system that respects both."],
    ["To stay small enough to read", "Around 1,500 lines of Python. A junior engineer should be able to understand the whole thing in an afternoon."],
  ];
  const colW = (W - 3 * PADX) / 2, rowH = 1.9;
  reasons.forEach(([t, d], i) => {
    const x = PADX + (i % 2) * (colW + PADX);
    const y = 2.3 + Math.floor(i / 2) * (rowH + 0.2);
    card(s, x, y, colW, rowH);
    s.addText(String(i + 1).padStart(2, "0"), {
      x: x + 0.2, y: y + 0.2, w: 0.8, h: 0.5,
      fontFace: SERIF, fontSize: 24, italic: true, color: C.ochre, margin: 0,
    });
    s.addText(t, {
      x: x + 0.9, y: y + 0.2, w: colW - 1.0, h: 0.6,
      fontFace: SERIF, fontSize: 20, color: C.ink, margin: 0, charSpacing: -0.5,
    });
    body(s, d, { x: x + 0.25, y: y + 0.85, w: colW - 0.5, h: rowH - 0.95, fontSize: 12 });
  });
  footer(s, "A · The big picture");
})();

// ================================================================
// 05 — Quick facts
// ================================================================
(() => {
  const s = p.addSlide();
  base(s, C.paperAlt);
  eyebrow(s, "05 · AT A GLANCE", 5, "A");
  h1(s, "The whole thing, on one slide.");
  body(s, "Eight numbers describe the system's shape. Everything else is an elaboration of these.",
    { x: PADX, y: CONTENT_TOP + 0.95, w: 10, h: 0.5, fontSize: 14 });
  const facts = [
    ["5 min", "tick cadence",   "09:30 – 16:00 ET"],
    ["83",    "tickers",        "75 equities + 8 bond ETFs"],
    ["4",     "signals fused",  "news · congress · 13F · price"],
    ["30",    "max positions",  "concurrent holdings"],
    ["5 %",   "position size",  "of equity at entry"],
    ["7 %",   "trailing stop",  "from peak since entry"],
    ["25 %",  "sector cap",     "diversification guard"],
    ["10 %",  "bond floor",     "minimum fixed-income"],
  ];
  const cols = 4, cardW = (W - 2 * PADX - 0.3 * (cols - 1)) / cols, cardH = 1.55;
  facts.forEach(([k, n, sub], i) => {
    const x = PADX + (i % cols) * (cardW + 0.3);
    const y = 3.1 + Math.floor(i / cols) * (cardH + 0.3);
    card(s, x, y, cardW, cardH);
    s.addText(k, { x: x + 0.2, y: y + 0.15, w: cardW - 0.4, h: 0.75, fontFace: SERIF, fontSize: 38, color: C.navy, charSpacing: -1, margin: 0 });
    s.addText(n, { x: x + 0.2, y: y + 0.9, w: cardW - 0.4, h: 0.3, fontFace: SANS, fontSize: 13, bold: true, color: C.ink, margin: 0 });
    s.addText(sub, { x: x + 0.2, y: y + 1.18, w: cardW - 0.4, h: 0.3, fontFace: MONO, fontSize: 9, color: C.inkMute, margin: 0 });
  });
  footer(s, "A · The big picture");
})();

// ================================================================
// 06 — Recipe (6 steps)
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "06 · HOW IT THINKS", 6, "B");
  h1(s, "The recipe, in six steps.");
  body(s, "If you understand these six lines, you understand the whole bot.",
    { x: PADX, y: CONTENT_TOP + 0.95, w: 10, h: 0.4, fontSize: 14 });
  const steps = [
    ["1", "Gather ingredients", "Read four different kinds of information about every stock on our list."],
    ["2", "Turn each into a number", "Each ingredient becomes a small score: +good, −bad, 0 neutral."],
    ["3", "Mix them with weights", "News counts most (35 %), the dip bonus least (5 %). Add them up."],
    ["4", "Compare against thresholds", "Above +1.0 → buy. Below −1.0 → sell. In between → do nothing."],
    ["5", "Check the rulebook", "Even if the score says buy, skip it if it would break a portfolio rule."],
    ["6", "Write down the reason", "Every decision gets a human sentence saved next to it."],
  ];
  const cols = 3, cardW = (W - 2 * PADX - 0.3 * (cols - 1)) / cols, cardH = 1.55;
  steps.forEach(([n, t, k], i) => {
    const x = PADX + (i % cols) * (cardW + 0.3);
    const y = 3.0 + Math.floor(i / cols) * (cardH + 0.4);
    card(s, x, y, cardW, cardH, { fill: C.cardAlt });
    // number badge
    s.addShape(p.shapes.RECTANGLE, { x: x + 0.25, y: y - 0.22, w: 0.5, h: 0.5, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText(n, { x: x + 0.25, y: y - 0.22, w: 0.5, h: 0.5, fontFace: SERIF, fontSize: 20, color: C.paper, align: "center", valign: "middle", margin: 0 });
    s.addText(t, { x: x + 0.25, y: y + 0.4, w: cardW - 0.5, h: 0.5, fontFace: SERIF, fontSize: 18, color: C.ink, margin: 0, charSpacing: -0.5 });
    body(s, k, { x: x + 0.25, y: y + 0.95, w: cardW - 0.5, h: cardH - 1.0, fontSize: 11.5 });
  });
  footer(s, "B · How it thinks");
})();

// ================================================================
// 07-10 — Signal slides
// ================================================================
const SIGNALS = [
  { num: 7,  order: 1, weight: "35 %", accent: C.ochre, title: "News sentiment",
    eli10: "If lots of news stories today say nice things about Apple, Apple's score goes up. If they say scary things, it goes down.",
    tech:  "Every 5 min we pull RSS feeds from six financial outlets (CNBC, Reuters, Yahoo Finance, CNN Business, MarketWatch, Seeking Alpha). Each headline is scored with VADER. We match headlines to tickers, take a 7-day rolling average, z-score it. Optionally re-score with FinBERT for headlines that mention a universe ticker.",
    source: "CNBC, Reuters, Yahoo Finance, CNN Business, MarketWatch, Seeking Alpha",
    cadence: "every 5 minutes",
    method: "VADER polarity → 7d rolling z-score (FinBERT optional)",
    code: "bot/news/* · bot/signals/sentiment.py", weightPct: 0.35 },
  { num: 8,  order: 2, weight: "25 %", accent: C.navy,  title: "Congressional trades",
    eli10: "Members of Congress have to report their stock trades. If a bunch of them just bought Nvidia, that's interesting and nudges Nvidia's score up.",
    tech:  "The STOCK Act requires U.S. Congress members to disclose personal trades within 45 days. We pull the House Financial Disclosure XML index weekly, download the PDF reports, extract ticker and dollar values, and compute a 60-day net-dollar signal per ticker.",
    source: "House Financial Disclosure XML + PDFs",
    cadence: "weekly refresh",
    method: "60-day net $ volume of tracked congressional trades",
    code: "bot/signals/politicians.py", weightPct: 0.25 },
  { num: 9,  order: 3, weight: "20 %", accent: C.brick, title: "Top-investor 13F filings",
    eli10: "Very rich, very famous investors (Warren Buffett, Michael Burry, ARK, others) have to tell the SEC what they're holding every three months. If they start loading up on a stock, we take notice.",
    tech:  "We track 10 curated funds by CIK — Berkshire, Pershing Square, Scion, Bridgewater, Renaissance, ARK, Third Point, Appaloosa, Greenlight, Baupost. Each monthly pass parses their 13F-HR filings on SEC EDGAR and computes the dollar delta per ticker.",
    source: "SEC EDGAR · 10 curated fund CIKs",
    cadence: "monthly refresh",
    method: "latest 13F $ delta per ticker",
    code: "bot/signals/investors.py", weightPct: 0.20 },
  { num: 10, order: 4, weight: "15 % + 5 %", accent: C.moss, title: "Price momentum & dip bonus",
    eli10: "If a stock has been going up faster than the S&P 500, that's a small plus. And if a stock has fallen way below its recent high, it gets a tiny sale-sticker bonus.",
    tech:  "Daily after close we pull historical bars from Alpaca (IEX feed) and compute each ticker's 20-day return minus SPY's. Separately, a dip bonus adds +1 if the current price is down more than 25 % from the 52-week high — mean-reversion sweetener for beaten-down names whose other signals still look positive.",
    source: "Alpaca historical bars (IEX feed)",
    cadence: "daily",
    method: "(20d return − SPY 20d return); dip = +1 if drawdown > 25 %",
    code: "bot/signals/aggregator.py", weightPct: 0.20 },
];

SIGNALS.forEach(sig => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, `${String(sig.num).padStart(2, "0")} · SIGNAL ${sig.order} OF 4`, sig.num, "B");

  const leftW = 7.4, rightX = PADX + leftW + 0.4, rightW = W - rightX - PADX;

  // Big weight number + label
  s.addText(sig.weight, {
    x: PADX, y: CONTENT_TOP, w: 4, h: 1.4,
    fontFace: SERIF, fontSize: 72, color: sig.accent, charSpacing: -2, margin: 0,
  });
  s.addText("WEIGHT IN\nCOMPOSITE SCORE", {
    x: PADX + 3.6, y: CONTENT_TOP + 0.2, w: 3.0, h: 0.8,
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 3, margin: 0,
  });

  // Title
  s.addText(sig.title, {
    x: PADX, y: CONTENT_TOP + 1.5, w: leftW, h: 0.9,
    fontFace: SERIF, fontSize: 32, color: C.ink, margin: 0, charSpacing: -1,
  });

  // ELI10 card
  card(s, PADX, CONTENT_TOP + 2.45, leftW, 1.25, { fill: C.cardAlt });
  s.addText("WHAT IT IS, FOR A KID", {
    x: PADX + 0.2, y: CONTENT_TOP + 2.55, w: 7, h: 0.3,
    fontFace: MONO, fontSize: 10, color: sig.accent, charSpacing: 3, margin: 0,
  });
  s.addText(sig.eli10, {
    x: PADX + 0.2, y: CONTENT_TOP + 2.85, w: leftW - 0.4, h: 0.8,
    fontFace: SERIF, fontSize: 14, color: C.ink, margin: 0,
  });

  // Precise card
  card(s, PADX, CONTENT_TOP + 3.85, leftW, 1.8);
  s.addText("WHAT IT IS, PRECISELY", {
    x: PADX + 0.2, y: CONTENT_TOP + 3.95, w: 7, h: 0.3,
    fontFace: MONO, fontSize: 10, color: C.inkMute, charSpacing: 3, margin: 0,
  });
  body(s, sig.tech, {
    x: PADX + 0.2, y: CONTENT_TOP + 4.25, w: leftW - 0.4, h: 1.3, fontSize: 11.5,
  });

  // Meta rows on the right
  const metas = [
    ["SOURCE",   sig.source,  false],
    ["CADENCE",  sig.cadence, false],
    ["METHOD",   sig.method,  false],
    ["MODULE",   sig.code,    true],
  ];
  const metaStart = CONTENT_TOP;
  const metaRowH = 0.8;
  metas.forEach(([k, v, isMono], i) => {
    const y = metaStart + i * metaRowH;
    s.addText(k, { x: rightX, y, w: rightW, h: 0.25, fontFace: MONO, fontSize: 9, color: C.inkMute, charSpacing: 3, margin: 0 });
    s.addText(v, { x: rightX, y: y + 0.25, w: rightW, h: metaRowH - 0.3, fontFace: isMono ? MONO : SANS, fontSize: isMono ? 11 : 12, color: C.ink, margin: 0 });
    rule(s, rightX, y + metaRowH - 0.05, rightW);
  });

  // Weight bar
  const wbY = metaStart + 4 * metaRowH + 0.2;
  card(s, rightX, wbY, rightW, 0.9);
  s.addText("WEIGHT BAR", {
    x: rightX + 0.15, y: wbY + 0.1, w: rightW, h: 0.25,
    fontFace: MONO, fontSize: 9, color: C.inkMute, charSpacing: 3, margin: 0,
  });
  // Track
  s.addShape(p.shapes.RECTANGLE, {
    x: rightX + 0.15, y: wbY + 0.52, w: rightW - 0.3, h: 0.22,
    fill: { color: C.paperAlt }, line: { color: C.rule, width: 0.5 },
  });
  // Fill
  s.addShape(p.shapes.RECTANGLE, {
    x: rightX + 0.15, y: wbY + 0.52, w: (rightW - 0.3) * sig.weightPct, h: 0.22,
    fill: { color: sig.accent }, line: { color: sig.accent },
  });

  footer(s, "B · How it thinks");
});

// ================================================================
// 11 — Formula
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "11 · THE COMPOSITE SCORE", 11, "B");
  h1(s, "Five numbers, one sum, one decision.");

  const terms = [
    { w: "0.35", k: "news_sentiment_z",  c: C.ochre, n: "7-day rolling VADER z-score" },
    { w: "0.25", k: "politician_signal", c: C.navy,  n: "60-day net congressional $" },
    { w: "0.20", k: "investor_signal",   c: C.brick, n: "13F $ delta from tracked funds" },
    { w: "0.15", k: "momentum",          c: C.moss,  n: "20-day return − SPY" },
    { w: "0.05", k: "dip_bonus",         c: C.moss,  n: "+1 if drawdown > 25 %" },
  ];

  const codeW = 6.5, codeX = PADX, codeY = 2.3, codeH = 4.0;
  card(s, codeX, codeY, codeW, codeH);
  s.addText("bot/signals/aggregator.py", {
    x: codeX + 0.25, y: codeY + 0.2, w: codeW - 0.5, h: 0.3,
    fontFace: MONO, fontSize: 9, color: C.inkMute, charSpacing: 3, margin: 0,
  });
  s.addText([
    { text: "composite_score ", options: { color: C.ink } },
    { text: "=", options: { color: C.inkMute } },
  ], { x: codeX + 0.25, y: codeY + 0.55, w: codeW - 0.5, h: 0.4, fontFace: MONO, fontSize: 15, margin: 0 });

  terms.forEach((t, i) => {
    s.addText([
      { text: i === 0 ? "     " : "   + ", options: { color: C.inkMute } },
      { text: t.w, options: { color: t.c, bold: true } },
      { text: " * ", options: { color: C.inkMute } },
      { text: t.k, options: { color: C.ink } },
    ], {
      x: codeX + 0.25, y: codeY + 1.0 + i * 0.45, w: codeW - 0.5, h: 0.35,
      fontFace: MONO, fontSize: 14, margin: 0,
    });
  });
  rule(s, codeX + 0.25, codeY + codeH - 0.6, codeW - 0.5);
  s.addText([
    { text: "open if > ", options: { color: C.inkDim } },
    { text: "+1.0", options: { color: C.moss, bold: true } },
    { text: "   ·   close if < ", options: { color: C.inkDim } },
    { text: "−1.0", options: { color: C.brick, bold: true } },
  ], {
    x: codeX + 0.25, y: codeY + codeH - 0.45, w: codeW - 0.5, h: 0.35,
    fontFace: MONO, fontSize: 11, margin: 0,
  });

  // Right side
  const rx = codeX + codeW + 0.4, rw = W - rx - PADX;
  kicker(s, "In English", rx, codeY);
  body(s,
    "Take each of the four signals, multiply it by how much we trust it, and add them up. News matters most because it's the freshest. Politicians and fund managers each get a fifth or a quarter. Price momentum is a tiebreaker. The dip bonus is a small nudge that lets us buy quality names after they sell off.",
    { x: rx, y: codeY + 0.4, w: rw, h: 2.0, fontSize: 12 });

  terms.forEach((t, i) => {
    const y = codeY + 2.55 + i * 0.32;
    s.addText(t.w, { x: rx, y, w: 0.6, h: 0.3, fontFace: MONO, fontSize: 12, color: t.c, bold: true, margin: 0 });
    s.addText(t.k.replace(/_/g, " "), { x: rx + 0.7, y, w: 2.2, h: 0.3, fontFace: SANS, fontSize: 11, color: C.ink, margin: 0 });
    // bar
    const barX = rx + 2.95, barW = rw - 2.95;
    s.addShape(p.shapes.RECTANGLE, { x: barX, y: y + 0.09, w: barW, h: 0.14, fill: { color: C.paperAlt }, line: { color: C.rule, width: 0.5 } });
    s.addShape(p.shapes.RECTANGLE, { x: barX, y: y + 0.09, w: barW * (parseFloat(t.w) / 0.35), h: 0.14, fill: { color: t.c }, line: { color: t.c } });
  });

  footer(s, "B · How it thinks");
})();

// ================================================================
// 12 — Score → action
// ================================================================
(() => {
  const s = p.addSlide();
  base(s, C.paperAlt);
  eyebrow(s, "12 · SCORE TO ACTION", 12, "B");
  h1(s, "What the score actually triggers.");

  const zones = [
    { from: "≥ +1.0",     c: C.moss,    t: "Buy zone",  d: "A new name enters the buy queue, ranked by score, subject to portfolio rules." },
    { from: "+1.0 to −1.0", c: C.inkMute, t: "Hold zone", d: "Do nothing. Positions we already own keep sitting." },
    { from: "≤ −1.0",     c: C.brick,   t: "Sell zone", d: "If we own it, close the position. We log the reason and the signal breakdown." },
  ];
  const colW = (W - 2 * PADX - 0.3 * 2) / 3, cardH = 1.9;
  zones.forEach((z, i) => {
    const x = PADX + i * (colW + 0.3);
    const y = 2.5;
    card(s, x, y, colW, cardH);
    s.addText(`SCORE ${z.from.toUpperCase()}`, { x: x + 0.3, y: y + 0.25, w: colW - 0.6, h: 0.3, fontFace: MONO, fontSize: 10, color: z.c, charSpacing: 3, margin: 0 });
    s.addText(z.t, { x: x + 0.3, y: y + 0.55, w: colW - 0.6, h: 0.6, fontFace: SERIF, fontSize: 30, color: z.c, margin: 0, charSpacing: -1 });
    body(s, z.d, { x: x + 0.3, y: y + 1.2, w: colW - 0.6, h: 0.7, fontSize: 11.5 });
  });

  // Bottom two explainers
  const bY = 4.9, bColW = (W - 2 * PADX - 0.4) / 2;
  kicker(s, "Why the wide dead zone?", PADX, bY);
  body(s, "We deliberately leave a gap between −1 and +1 where nothing happens. Scores drift around a little every tick. Without the buffer, we'd churn trades (and commissions, and slippage) on noise.",
    { x: PADX, y: bY + 0.4, w: bColW, h: 1.8, fontSize: 12 });

  kicker(s, "What the decision log records", PADX + bColW + 0.4, bY);
  body(s, "For every ticker, every tick: the action (buy, sell, hold, add, trim, stop), the composite score, the per-signal components, and a sentence like \"news avg_vader +0.32 over 9 headlines (+1.8σ); 20d return +12.4 % vs SPY +3.1 %\".",
    { x: PADX + bColW + 0.4, y: bY + 0.4, w: bColW, h: 1.8, fontSize: 12 });

  footer(s, "B · How it thinks");
})();

// ================================================================
// 13 — Decision tree
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "13 · DECISION TREE", 13, "B");
  h1(s, "Every tick, every holding is re-checked in this order.", CONTENT_TOP, 26);
  body(s, "Earlier rows beat later rows — a stop always wins over a rebalance trim.",
    { x: PADX, y: CONTENT_TOP + 0.65, w: 10, h: 0.4, fontSize: 12 });

  const cols = [
    { head: "ON NAMES WE ALREADY OWN", color: C.brick, rows: [
      { t: "Stop",    c: "price < peak × (1 − 7 %)",  e: "Emergency brake. Doesn't care about score." },
      { t: "Exit",    c: "composite < −1.0",            e: "Thesis has flipped negative. Close." },
      { t: "Trim",    c: "weight > 8 % → back to 5 %",  e: "Stop any one name from dominating the portfolio." },
      { t: "Dip add", c: "−25 % from cost & score > 0", e: "Buy 50 % more of a winning thesis that sold off." },
    ] },
    { head: "ON NEW CANDIDATES", color: C.navy, rows: [
      { t: "Open",         c: "composite > +1.0, ranked",  e: "Highest-conviction fresh name first." },
      { t: "Sector cap",   c: "total sector ≤ 25 %",       e: "Don't become a pure-tech fund by accident." },
      { t: "Cash reserve", c: "keep ≥ 8 % cash",           e: "Dry powder for dips and stops." },
      { t: "Size",         c: "5 % of equity at entry",     e: "Same bet size for everyone, every time." },
    ] },
    { head: "ON PORTFOLIO SHAPE", color: C.moss, rows: [
      { t: "FI floor",      c: "bonds ≥ 10 % → buy AGG",  e: "Ballast against equity drawdowns." },
      { t: "FI ceiling",    c: "target ≤ 15 %",           e: "Not a bond fund either." },
      { t: "Max positions", c: "30 concurrent",           e: "Hard cap keeps the book readable." },
      { t: "Rebalance day", c: "Friday trim pass",        e: "Weekly walk back to target weights." },
    ] },
  ];

  const top = 2.2, colW = (W - 2 * PADX - 0.3 * 2) / 3, rowH = 0.95;
  cols.forEach((col, ci) => {
    const x = PADX + ci * (colW + 0.3);
    s.addText(col.head, { x, y: top, w: colW, h: 0.3, fontFace: MONO, fontSize: 10, color: col.color, charSpacing: 3, margin: 0 });
    col.rows.forEach((r, ri) => {
      const y = top + 0.4 + ri * (rowH + 0.15);
      card(s, x, y, colW, rowH);
      s.addText(r.t, { x: x + 0.15, y: y + 0.08, w: colW - 0.3, h: 0.3, fontFace: SERIF, fontSize: 16, color: C.ink, margin: 0, charSpacing: -0.5 });
      s.addText(r.c, { x: x + 0.15, y: y + 0.35, w: colW - 0.3, h: 0.3, fontFace: MONO, fontSize: 10, color: C.inkMute, margin: 0 });
      body(s, r.e, { x: x + 0.15, y: y + 0.6, w: colW - 0.3, h: 0.4, fontSize: 10.5 });
    });
  });

  footer(s, "B · How it thinks");
})();

// ================================================================
// 14 — Risk guardrails
// ================================================================
(() => {
  const s = p.addSlide();
  base(s, C.paperAlt);
  eyebrow(s, "14 · RISK GUARDRAILS", 14, "B");
  h1(s, "The rules that override the robot.");
  body(s, "These aren't scored — they're hard constraints in bot/config.py and bot/risk.py.",
    { x: PADX, y: CONTENT_TOP + 0.95, w: 10, h: 0.4, fontSize: 12 });

  const dials = [
    ["MAX_POSITION_PCT",   "5 %",  "hard cap at entry",  "No single name is ever more than 1/20 of the book on day one."],
    ["REBALANCE_TRIM_PCT", "8 %",  "trim threshold",     "If a winner grows past 8 %, we sell down to 5 %."],
    ["MAX_SECTOR_PCT",     "25 %", "per-sector ceiling", "Tech, consumer, financials — none can dominate."],
    ["CASH_RESERVE_PCT",   "8 %",  "cash floor",         "Always leave ammunition for dip-buys and stops."],
    ["TRAILING_STOP_PCT",  "7 %",  "trailing stop",      "If a holding falls 7 % from its peak, we sell it."],
    ["DIP_ADD_DRAWDOWN",   "25 %", "dip add trigger",    "Only add more if the thesis is still positive."],
    ["FIXED_INCOME_FLOOR", "10 %", "minimum bonds",      "Boring, steady ballast."],
    ["MAX_POSITIONS",      "30",   "concurrent holdings","More than 30 is too many to reason about."],
  ];
  const cols = 4, cardW = (W - 2 * PADX - 0.2 * (cols - 1)) / cols, cardH = 1.65;
  dials.forEach(([k, v, n, e], i) => {
    const x = PADX + (i % cols) * (cardW + 0.2);
    const y = 3.1 + Math.floor(i / cols) * (cardH + 0.25);
    card(s, x, y, cardW, cardH);
    s.addText(k, { x: x + 0.2, y: y + 0.15, w: cardW - 0.4, h: 0.3, fontFace: MONO, fontSize: 9, color: C.inkMute, charSpacing: 2, margin: 0 });
    s.addText(v, { x: x + 0.2, y: y + 0.4, w: cardW - 0.4, h: 0.65, fontFace: SERIF, fontSize: 32, color: C.navy, margin: 0, charSpacing: -1 });
    s.addText(n, { x: x + 0.2, y: y + 1.0, w: cardW - 0.4, h: 0.25, fontFace: SANS, fontSize: 11, bold: true, color: C.ink, margin: 0 });
    body(s, e, { x: x + 0.2, y: y + 1.22, w: cardW - 0.4, h: 0.4, fontSize: 10 });
  });

  footer(s, "B · How it thinks");
})();

// ================================================================
// 15 — Typical tick
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "15 · A TYPICAL 5-MIN TICK", 15, "B");
  h1(s, "One tick, second by second.", CONTENT_TOP, 28);
  body(s, "APScheduler fires every 5 minutes between 09:30 and 16:00 ET. Each cycle takes well under a minute, leaving plenty of slack.",
    { x: PADX, y: CONTENT_TOP + 0.7, w: 11, h: 0.4, fontSize: 12 });

  const steps = [
    ["T + 0s",  "Pull news",       "RSS scrape → VADER polarity → upsert new headlines to the news table."],
    ["T + 20s", "Refresh signals", "Aggregate news + politician + 13F + momentum + dip into a per-ticker score."],
    ["T + 40s", "Read account",    "Query Alpaca for equity, cash, buying power, and current positions."],
    ["T + 50s", "Plan orders",     "strategy.plan() emits PlannedOrder[] and writes Decision rows (even for \"hold\")."],
    ["T + 60s", "Execute",         "alpaca-py submits limit orders — or in DRY_RUN, we log what we would have done."],
    ["T + 65s", "Persist",         "Positions + trades + decisions flush to SQLite so the dashboard can read them."],
  ];
  const startY = 2.45, rowH = 0.65, timelineX = PADX + 1.15;
  // vertical rail
  s.addShape(p.shapes.LINE, {
    x: timelineX, y: startY + 0.15, w: 0, h: steps.length * rowH - 0.2,
    line: { color: C.rule, width: 1 },
  });
  steps.forEach(([t, h, b], i) => {
    const y = startY + i * rowH;
    s.addText(t, { x: PADX, y: y + 0.05, w: 1.0, h: 0.4, fontFace: MONO, fontSize: 12, color: C.ochre, margin: 0 });
    s.addShape(p.shapes.OVAL, { x: timelineX - 0.09, y: y + 0.14, w: 0.18, h: 0.18, fill: { color: C.navy }, line: { color: C.navy } });
    s.addText(h, { x: timelineX + 0.25, y, w: 11 - timelineX - 0.25, h: 0.35, fontFace: SERIF, fontSize: 18, color: C.ink, margin: 0, charSpacing: -0.5 });
    body(s, b, { x: timelineX + 0.25, y: y + 0.32, w: W - timelineX - 0.25 - PADX, h: 0.35, fontSize: 11 });
  });
  footer(s, "B · How it thinks");
})();

// ================================================================
// 16 — Stack
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "16 · HOW IT WAS BUILT", 16, "C");
  h1(s, "Seven small, boring pieces.");

  const layers = [
    ["Bot (headless)",       "Python 3.12 · APScheduler · SQLAlchemy · Pydantic · loguru",       "The trader. Runs every 5 min, makes the decisions."],
    ["Signals",              "vaderSentiment · BeautifulSoup · feedparser · (optional) PyTorch + FinBERT", "Turn words and filings into numbers."],
    ["Market data / orders", "alpaca-py (IEX feed, paper endpoint)",                             "The bridge to the outside world."],
    ["Storage",              "SQLite via SQLAlchemy — a single trading.db file",                 "One file, zero server, trivially backup-able."],
    ["Read API",             "FastAPI · uvicorn",                                                "Exposes what the bot did, without exposing keys."],
    ["Dashboard",            "Next.js 16 · TypeScript · Tailwind (hand-built components)",       "The human-facing window into the bot."],
    ["Scheduling",           "Windows Task Scheduler (scripts/register_task.bat)",               "Starts the bot weekdays; NYSE calendar gates the rest."],
  ];
  const top = 2.4, rowH = 0.55;
  rule(s, PADX, top - 0.1, W - 2 * PADX);
  layers.forEach(([k, tech, role], i) => {
    const y = top + i * rowH;
    s.addText(k,    { x: PADX,     y: y + 0.05, w: 2.9, h: rowH, fontFace: SERIF, fontSize: 17, color: C.ink, margin: 0, charSpacing: -0.5 });
    s.addText(tech, { x: PADX + 2.9, y: y + 0.1,  w: 5.4, h: rowH, fontFace: MONO, fontSize: 10.5, color: C.navy, margin: 0 });
    s.addText(role, { x: PADX + 8.3, y: y + 0.1,  w: W - PADX - (PADX + 8.3), h: rowH, fontFace: SANS, fontSize: 11.5, color: C.inkDim, margin: 0 });
    rule(s, PADX, y + rowH, W - 2 * PADX);
  });
  footer(s, "C · How it was built");
})();

// ================================================================
// 17 — Data model
// ================================================================
(() => {
  const s = p.addSlide();
  base(s, C.paperAlt);
  eyebrow(s, "17 · DATA MODEL", 17, "C");
  h1(s, "Five tables, one SQLite file.");
  body(s, "No ORM cleverness, no migrations yet. The whole schema fits on one slide on purpose.",
    { x: PADX, y: CONTENT_TOP + 0.95, w: 11, h: 0.4, fontSize: 12 });

  const tables = [
    ["positions",  "ticker · qty · avg_cost · market_price · market_value · peak_price",           "Current book. Mutated after every fill."],
    ["trades",     "id · ts · ticker · side · qty · price · reason",                               "Immutable history of everything the bot did."],
    ["decisions",  "id · ts · ticker · action · composite_score · score_breakdown(json) · reason", "One row per ticker per tick, including hold — the \"why\"."],
    ["news",       "id · ts · source · headline · url · tickers · vader · finbert_label",          "Raw headlines with sentiment scores. Deduped by URL."],
    ["signals",    "id · ts · ticker · kind · value · components(json)",                           "Point-in-time signal values for replay and debugging."],
  ];
  const top = 3.0, rowH = 0.7;
  tables.forEach(([t, cols, purpose], i) => {
    const y = top + i * (rowH + 0.1);
    card(s, PADX, y, W - 2 * PADX, rowH);
    s.addText(t,      { x: PADX + 0.3, y: y + 0.15, w: 2.0, h: rowH - 0.2, fontFace: MONO, fontSize: 18, color: C.navy, margin: 0 });
    s.addText(cols,   { x: PADX + 2.4, y: y + 0.2,  w: 6.8, h: rowH - 0.2, fontFace: MONO, fontSize: 10.5, color: C.ink, margin: 0 });
    body(s, purpose,  { x: PADX + 9.3, y: y + 0.22, w: W - PADX - 9.3 - PADX, h: rowH - 0.2, fontSize: 11 });
  });
  footer(s, "C · How it was built");
})();

// ================================================================
// 18 — Dashboard
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "18 · THE DASHBOARD", 18, "C");
  h1(s, "A read-only window into the bot's reasoning.");
  body(s, "Runs locally at :3000. Never touches Alpaca directly — it asks FastAPI, which asks SQLite.",
    { x: PADX, y: CONTENT_TOP + 0.95, w: 11, h: 0.4, fontSize: 12 });

  // Browser mock on left
  const mockX = PADX, mockY = 3.1, mockW = 7.3, mockH = 3.6;
  card(s, mockX, mockY, mockW, mockH);
  // title bar
  s.addShape(p.shapes.RECTANGLE, { x: mockX, y: mockY, w: mockW, h: 0.45, fill: { color: C.cardAlt }, line: { color: C.rule, width: 0.5 } });
  ["E07A6A","E0B86A","8FB06A"].forEach((col, i) => {
    s.addShape(p.shapes.OVAL, { x: mockX + 0.15 + i * 0.25, y: mockY + 0.14, w: 0.18, h: 0.18, fill: { color: col }, line: { color: col } });
  });
  s.addText("localhost:3000 / positions", {
    x: mockX + 1.1, y: mockY + 0.1, w: mockW - 1.2, h: 0.3,
    fontFace: MONO, fontSize: 10, color: C.inkMute, margin: 0,
  });
  // content
  s.addText("Portfolio", { x: mockX + 0.4, y: mockY + 0.6, w: 3, h: 0.4, fontFace: SERIF, fontSize: 20, color: C.ink, margin: 0 });
  s.addText("next cycle · 02:41", { x: mockX + mockW - 2.5, y: mockY + 0.68, w: 2.3, h: 0.3, fontFace: MONO, fontSize: 10, color: C.inkMute, align: "right", margin: 0 });
  s.addText("$104,217.83", { x: mockX + 0.4, y: mockY + 1.0, w: 6, h: 0.7, fontFace: SERIF, fontSize: 38, color: C.navy, charSpacing: -1, margin: 0 });
  s.addText("+ $4,217.83   ·   + 4.22 %", { x: mockX + 0.4, y: mockY + 1.65, w: 6, h: 0.3, fontFace: MONO, fontSize: 12, color: C.moss, margin: 0 });

  const miniCards = [["NVDA", "+2.1 %", C.moss], ["UNH", "−0.8 %", C.brick], ["AGG", "+0.3 %", C.moss]];
  const miW = (mockW - 0.8 - 0.2 * 2) / 3, miH = 0.75;
  miniCards.forEach(([t, pc, c], i) => {
    const x = mockX + 0.4 + i * (miW + 0.2);
    const y = mockY + 2.1;
    s.addShape(p.shapes.RECTANGLE, { x, y, w: miW, h: miH, fill: { color: C.cardAlt }, line: { color: C.rule, width: 0.5 } });
    s.addText("POSITION", { x: x + 0.12, y: y + 0.08, w: miW - 0.2, h: 0.2, fontFace: MONO, fontSize: 8, color: C.inkMute, charSpacing: 2, margin: 0 });
    s.addText(t, { x: x + 0.12, y: y + 0.24, w: miW - 0.2, h: 0.3, fontFace: SERIF, fontSize: 16, color: C.ink, margin: 0 });
    s.addText(pc, { x: x + 0.12, y: y + 0.48, w: miW - 0.2, h: 0.25, fontFace: MONO, fontSize: 11, color: c, margin: 0 });
  });

  // reason strip
  s.addShape(p.shapes.RECTANGLE, { x: mockX + 0.4, y: mockY + 3.0, w: mockW - 0.8, h: 0.5, fill: { color: C.cardAlt }, line: { color: C.rule, width: 0.5 } });
  s.addText([
    { text: "buy NVDA", options: { color: C.navy, bold: true } },
    { text: " · news avg_vader +0.32 over 9 headlines (+1.8σ); 20d return +12.4 % vs SPY +3.1 % | composite=+1.42", options: { color: C.inkDim } },
  ], { x: mockX + 0.55, y: mockY + 3.1, w: mockW - 1.1, h: 0.35, fontFace: MONO, fontSize: 9.5, margin: 0 });

  // Right column: pages
  const px = mockX + mockW + 0.4, pw = W - px - PADX;
  kicker(s, "Pages", px, mockY);
  const pages = [
    ["/",          "Overview",     "Portfolio value, bot status, next-tick countdown."],
    ["/positions", "Positions",    "Weights, P&L, a sector donut."],
    ["/trades",    "Trade journal","Every order with the why-string attached."],
    ["/news",      "News",         "Scored headlines grouped by ticker."],
    ["/signals",   "Signals",      "Politician and 13F activity driving the score."],
  ];
  const pt = mockY + 0.5, prh = 0.62;
  pages.forEach(([k, t, d], i) => {
    const y = pt + i * prh;
    s.addText(k, { x: px, y: y + 0.05, w: 1.2, h: prh, fontFace: MONO, fontSize: 11, color: C.navy, margin: 0 });
    s.addText(t, { x: px + 1.25, y: y + 0.05, w: 1.8, h: prh, fontFace: SERIF, fontSize: 16, color: C.ink, margin: 0 });
    body(s, d, { x: px + 3.1, y: y + 0.1, w: pw - 3.1, h: prh, fontSize: 10.5 });
    rule(s, px, y + prh - 0.05, pw);
  });
  footer(s, "C · How it was built");
})();

// ================================================================
// 19 — Limits
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "19 · WHAT IT DOESN'T DO (YET)", 19, "D");
  h1(s, "Six honest limits.");
  const limits = [
    ["IEX feed only", "We're on Alpaca's free tier, which sees about 3 % of total market volume. Thinly traded small-caps can have gaps in their price history.", "Affects momentum + dip signals most; core large-caps are fine."],
    ["Disclosure data is slow", "Members of Congress get 45 days to report trades. Hedge funds get 45 days to report holdings. By the time we see either, everyone else has too.", "This is an information-arbitrage signal, not day-trading alpha."],
    ["Headlines only, no article bodies", "We only read RSS, not the articles behind them. A careful headline can miss crucial context in paragraph four.", "Unavoidable without paid licenses; VADER on headlines still has signal."],
    ["No backtest, no attribution", "We've never replayed history through the strategy. We can't say which signal is pulling its weight or whether the weights are correct.", "This is the single most important gap. See roadmap."],
    ["Only the trailing stop watches mid-tick", "Between 5-minute ticks, a catastrophic news event could move a position 15 % before we notice.", "Mitigated by max position size (5 %); still a real exposure."],
    ["Single process, single box", "One Python process on one Windows machine. No failover, no alerting, no model versioning, no disaster recovery.", "Fine for a paper experiment; unacceptable if real money ever gets near it."],
  ];
  const cols = 2, cardW = (W - 2 * PADX - 0.3) / cols, cardH = 1.4;
  limits.forEach(([t, e, p2], i) => {
    const x = PADX + (i % cols) * (cardW + 0.3);
    const y = 2.25 + Math.floor(i / cols) * (cardH + 0.25);
    card(s, x, y, cardW, cardH);
    s.addText(String(i + 1).padStart(2, "0"), {
      x: x + 0.2, y: y + 0.15, w: 0.65, h: 0.4, fontFace: SERIF, fontSize: 20, italic: true, color: C.ochre, margin: 0,
    });
    s.addText(t, {
      x: x + 0.85, y: y + 0.15, w: cardW - 0.95, h: 0.4,
      fontFace: SERIF, fontSize: 18, color: C.ink, margin: 0, charSpacing: -0.5,
    });
    body(s, e, { x: x + 0.2, y: y + 0.6, w: cardW - 0.4, h: 0.5, fontSize: 10.5 });
    s.addText(`→ ${p2}`, {
      x: x + 0.2, y: y + cardH - 0.35, w: cardW - 0.4, h: 0.3,
      fontFace: MONO, fontSize: 9.5, color: C.navy, margin: 0,
    });
  });
  footer(s, "D · Limits & roadmap");
})();

// ================================================================
// 20-22 — Roadmap
// ================================================================
const ROADMAPS = [
  { num: 20, horizon: "next",           tag: "0–2 months", bg: C.paperAlt,
    intro: "Cheap, high-leverage things to ship before touching the model.",
    items: [
      ["Bundle a backtest harness",            "Replay ~2 years of news + bars through strategy.plan(). Report Sharpe, max drawdown, turnover. Without this, every other change is a guess.", "med"],
      ["Per-signal kill switches",             "A config flag to disable any one of the four signals at runtime, so we can A/B which signal is actually helping.", "low"],
      ["Alerting",                             "Webhook or email on stop-outs, stale RSS feeds, API auth failures, or unusually large planned orders.", "low"],
      ["Nightly equity snapshots",             "Freeze equity + weights at 16:05 ET every day so the dashboard can plot a real history curve.", "low"],
      ["Dry-run → live toggle UI",             "A confirm-phrase gate in the dashboard to flip DRY_RUN off, with a visible banner when live.", "low"],
    ]},
  { num: 21, horizon: "in the mid term", tag: "2–6 months", bg: C.paper,
    intro: "Touch the model itself, once the backtester exists to measure changes.",
    items: [
      ["Replace VADER with FinBERT by default","VADER is general-domain; FinBERT is finance-tuned. Move VADER to the fast-path fallback.", "med"],
      ["Learned signal weights",                "Grid-search or Bayesian-optimize the five weights against the backtester. No more hand-tuned numbers.", "med"],
      ["Broaden the universe",                  "Lift the 83-ticker cap; admit S&P 1500 + liquid ETFs, gated by a liquidity filter.", "med"],
      ["Intraday catastrophe exits",            "Sub-tick stop on detected catastrophic news (CEO resigns, fraud, etc.) rather than waiting for the 5-min cycle.", "med"],
      ["LLM reasoning layer",                   "Summarize the reason string + recent headlines into a plain-English thesis per holding.", "med"],
    ]},
  { num: 22, horizon: "in the long term", tag: "6 months +", bg: C.paperAlt,
    intro: "Bigger structural changes, and the path to real money.",
    items: [
      ["Earnings & filings ingestion",  "10-K / 10-Q / 8-K parsing → guidance deltas as a 6th signal.", "high"],
      ["Walk-forward model training",   "Re-fit weights weekly on rolling windows instead of locking them in code.", "high"],
      ["Multi-strategy orchestrator",   "Run several strategies side-by-side with a risk allocator. The dashboard grows a \"strategies\" tab.", "high"],
      ["Live trading with governance",  "Only after 6+ months of paper stability: a live risk budget, kill switch, and pre-trade compliance checks.", "high"],
    ]},
];

ROADMAPS.forEach(rm => {
  const s = p.addSlide();
  base(s, rm.bg);
  eyebrow(s, `${rm.num} · ROADMAP · ${rm.horizon.toUpperCase()}`, rm.num, "D");
  h1(s, `What to build ${rm.horizon}.`);
  body(s, rm.intro, { x: PADX, y: CONTENT_TOP + 0.95, w: 11, h: 0.4, fontSize: 12 });
  const top = 2.7, rowH = 0.7;
  rule(s, PADX, top - 0.1, W - 2 * PADX);
  rm.items.forEach((it, i) => {
    const [t, d, cost] = it;
    const y = top + i * rowH;
    s.addText(String(i + 1).padStart(2, "0"), {
      x: PADX, y: y + 0.15, w: 0.6, h: 0.3, fontFace: MONO, fontSize: 11, color: C.ochre, margin: 0,
    });
    s.addText(t, {
      x: PADX + 0.7, y: y + 0.1, w: 3.9, h: 0.5, fontFace: SERIF, fontSize: 16, color: C.ink, margin: 0, charSpacing: -0.5,
    });
    body(s, d, { x: PADX + 4.7, y: y + 0.12, w: W - PADX - 4.7 - 1.5, h: rowH - 0.1, fontSize: 11 });
    const cColor = cost === "high" ? C.brick : cost === "med" ? C.ochre : C.moss;
    s.addText(`${cost.toUpperCase()} EFFORT`, {
      x: W - PADX - 1.5, y: y + 0.15, w: 1.5, h: 0.3, fontFace: MONO, fontSize: 10, color: cColor, charSpacing: 3, align: "right", margin: 0,
    });
    rule(s, PADX, y + rowH, W - 2 * PADX);
  });
  footer(s, "D · Limits & roadmap");
});

// ================================================================
// 23 — Summary
// ================================================================
(() => {
  const s = p.addSlide();
  base(s);
  eyebrow(s, "SUMMARY", 23, "–");
  const colW = (W - 3 * PADX) / 2;
  s.addText([
    { text: "Small, transparent,\n", options: { color: C.ink } },
    { text: "honest about its limits.", options: { color: C.navy, italic: true } },
  ], { x: PADX, y: CONTENT_TOP, w: colW, h: 2.3, fontFace: SERIF, fontSize: 46, charSpacing: -1.5, margin: 0 });
  body(s, "The bot is small enough to read in an afternoon and transparent enough to argue with. The next unlock isn't more signals — it's measurement. A backtester and per-signal attribution come first; everything else is a guess until those exist.",
    { x: PADX, y: CONTENT_TOP + 2.8, w: colW, h: 2.2, fontSize: 13 });

  const rx = PADX + colW + PADX;
  const rows = [
    ["TODAY",      "Headless bot + FastAPI + Next.js dashboard. Paper only. ~1,500 LOC Python, single SQLite file."],
    ["NEXT",       "Backtest harness, per-signal kill switches, alerting, nightly snapshots."],
    ["THEN",       "FinBERT-by-default, learned weights, broader universe, intraday catastrophe exits."],
    ["EVENTUALLY", "Multi-strategy, LLM reasoning, filings ingestion, governed live trading."],
  ];
  const rt = CONTENT_TOP, rh = 0.85;
  rows.forEach(([k, v], i) => {
    const y = rt + i * rh;
    s.addText(k, { x: rx, y: y + 0.1, w: 1.8, h: rh, fontFace: MONO, fontSize: 11, color: C.ochre, charSpacing: 3, margin: 0 });
    body(s, v, { x: rx + 1.8, y: y + 0.12, w: colW - 1.8, h: rh, fontSize: 11.5 });
    rule(s, rx, y + rh, colW);
  });
  s.addText("THANK YOU — QUESTIONS?", {
    x: rx, y: rt + 4 * rh + 0.3, w: colW, h: 0.4,
    fontFace: MONO, fontSize: 12, color: C.navy, charSpacing: 4, margin: 0,
  });
  footer(s, "Summary");
})();

// ---------- Write ----------
const out = path.resolve(__dirname, "..", "Alpaca Bot Deck.pptx");
p.writeFile({ fileName: out }).then(f => {
  console.log("Wrote", f);
});
