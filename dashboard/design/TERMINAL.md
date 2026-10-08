# CROMAZ Terminal — design contract

The dashboard is a **trading terminal**, benchmarked against the Bloomberg
Terminal (Launchpad, GP, PORT, WEI, TOP, ASKB) — and it has to *look better*
than Bloomberg while staying at least as information-dense.

What Bloomberg gets right, and we keep: pure black canvas, amber as the
system color, white data, green/red only for direction, everything is a
panel with a function code, numbers are tabular and right-aligned, tiny
sparklines and range bars everywhere, keyboard-first command line, zero
decoration that doesn't carry data.

Where we beat it: real typographic hierarchy (one condensed sans + one
mono, deliberate sizes), consistent 1px hairline grid, calm color (status
colors are the only saturated pixels), crisp SVG micro-charts, hover
cross-hairs and legends, an intelligence layer (the brief, risk guards,
the bot's reasoning) that Bloomberg makes you dig for.

## Tokens (app/globals.css `:root`)

| token | value | use |
|---|---|---|
| `--bg` | `#000` | canvas |
| `--bg-1` | `#07090c` | panel body |
| `--bg-2` | `#0c1015` | panel header, table header, row hover |
| `--bg-3` | `#131a22` | inputs, selected row, chips |
| `--line` | `#1a212b` | hairlines, panel borders |
| `--line-2` | `#28323f` | stronger dividers, focus-less input border |
| `--ink` | `#e8edf2` | primary data |
| `--ink-2` | `#a7b1bd` | secondary text |
| `--ink-3` | `#6c7785` | labels, axis text |
| `--ink-4` | `#444e5a` | disabled, grid |
| `--amber` | `#ffa21f` | function codes, focus, active tab, the command line |
| `--amber-2` | `#ffc56b` | amber hover / highlight text |
| `--up` | `#20d47b` | positive change |
| `--down` | `#ff4f4f` | negative change |
| `--warn` | `#ffd23f` | warnings (near a stop, blackout) |
| `--alert` | `#c77dff` | states that need action: BREACHED, STALE, DISABLED, MANUAL SELL — never a direction |
| `--blue` | `#3b8cff` | links, selection, the "you own this" outline |
| `--cyan` | `#56d4ff` | the bot / AI layer |

Rules: `--up`/`--down` mean direction ONLY (price/P&L/sign of a change) — status
and alerts use `--alert` (action needed) or `--warn` (watch); never use `--up`/`--down` decoratively; amber is for *system*
affordances (codes, focus, active), not data. Backgrounds stay neutral —
no gradients except the heatmap scale and chart area fills (≤ 18% alpha).

More rules (from the gauntlet's critics):
* Watch states are `.pill.warn` chips, action states `.pill.alert` — never bare
  amber-ish text, which reads as chrome.
* Levels whose sign isn't good/bad (yields, spreads, VIX) show change in
  neutral ink with ▲/▼; only prices, P&L and FX/commodities use up/down.
* Freshness dots are neutral (a pulse means live); never green.
* Stale data (older than one trading day) renders dimmed, with its age
  said once per panel — never per tile, never "computed 0s ago".
* Panel titles never repeat the function code (`RISK Guards`, not
  `RISK Risk guards`).
* Numbers on one screen must reconcile (e.g. 2s10s = 10Y − 2Y as shown).
* One guard calculation (`_guard` in api/terminal.py) feeds PORT, RISK,
  BRIEF and DES: the binding guard is the higher of the trailing stop and
  the −7% cut; "$ below guard" = (guard − last) × qty. Who will act on a
  breach comes from `_stop_protection`: a broker stop, the 5-min synthetic
  stop (scheduler alive, not DRY_RUN — independent of the LLM routines), the
  midday routine (the cut only), or nobody → MANUAL SELL. Alert counts are
  the brief's `counts`, verbatim, everywhere.

## Type

* `--font-sans`: **IBM Plex Sans Condensed** (400/500/600/700) — labels, UI, prose.
* `--font-mono`: **IBM Plex Mono** (400/500/600) — every number, ticker, code, time.
* Base 12px. Panel header 10.5px/600 uppercase, letter-spacing .08em.
  Table body 11.5px mono. KPI value 18–22px mono 500. Hero number (equity) 26px.
* All numbers `font-variant-numeric: tabular-nums`, right-aligned in tables.
* Negative numbers use U+2212 minus (`−`), positives an explicit `+` for changes.

## Primitives (components/term/)

* `Panel` — `code` (amber mono, e.g. `GP`), `title`, optional `sub`, `actions`
  (right side), `live` (freshness dot + age). 1px `--line` border, header 26px
  on `--bg-2`, body `--bg-1`. `flush` prop removes body padding for tables.
* `Seg` — segmented range/option buttons (`1D 1W 1M 3M YTD 1Y MAX`); active =
  amber fill, black text.
* `Spark` — SVG sparkline, colored by first→last direction, optional area fill.
* `RangeBar` — 52-week low→high track with a tick at the current price.
* `Chg` / `Num` — formatted change / number with sign + color.
* `heat(pct)` — diverging color for heatmaps.

## Shell

`TopBar` (logo, command line `<GO>`, market status, NY/LDN/TKY clocks, bot
heartbeat, PAPER badge) → `FnBar` (function tabs with numbers; Alt+1..7 or the
command line) → page → `StatusBar` (scrolling tape, API latency, data as-of,
regime). The command line accepts tickers (`NVDA` → security screen), and
functions: `LP|HOME`, `PORT`, `BLTR|TRADES`, `TOP|NEWS`, `FLOW`, `BOT|ASKB`,
`RISK`, `<TICKER> GP|DES|CN`. `/` focuses it from anywhere.

## Launchpad grid (home)

Desktop 1440×900 first viewport must already read as a full terminal:
KPI strip → [GP equity vs SPY | PORT monitor] → [WEI cross-asset | HEAT
universe | BRIEF intelligence]. Below: [TOP news | FLOW insider | EVTS
earnings], [BOT routines | RISK guards | TICKET manual trade], [WIRE event
stream | BLTR blotter].

## Data endpoints

Existing: `/portfolio/*`, `/positions`, `/trades`, `/news`, `/signals`,
`/regime/today`, `/earnings/upcoming`, `/llm/runs`, `/llm/cost`,
`/routines/next`, `/bot/status`, `/market/recap`, `/company/{t}`, `/memory/{name}`.
Terminal (api/terminal.py): `/terminal/universe`, `/terminal/monitor`,
`/terminal/heatmap`, `/terminal/security/{t}`, `/terminal/risk`,
`/terminal/brief`, `/terminal/wire`.
