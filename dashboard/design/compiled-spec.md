# Compiled spec — implementation source of truth

## Tokens (all existing, unchanged): obsidian bg scale, emerald/mint/rose/amber, chrome scale.
New: --grain-opacity: 0.025; vignette via fixed inset radial. Fonts: Cinzel (display, kept),
**Archivo** replaces Inter as body/UI (var renamed --font-inter → --font-body), JetBrains Mono (data, kept).

## Library sources
21st.dev Magic consulted for the agent-run feed pattern (component_inspiration: "agent activity feed");
adapted, not pasted — visual system stays Cromaz. Everything else: Custom, derived from the
existing brand system (justification: live-data terminal; external component shells would
break the locked brand language).

## CSS additions (globals.css)
- .film-grain: fixed overlay, SVG feTurbulence data-URI, opacity var(--grain-opacity), z 2.
- .vignette: fixed inset radial shadow, z 2.
- Entrances (class + [data-in] state toggled by Reveal):
  - .fx-clip-up   : clip-path inset(100% 0 0 0) → inset(0); 900ms cubic-bezier(.2,.7,.2,1)
  - .fx-slide-r   : translateX(48px) + fade; 700ms
  - .fx-slide-l   : translateX(-48px) + fade; 700ms
  - .fx-blur-in   : blur(14px) + fade; 800ms
  - .fx-wipe      : text wipe via clip-path inset(0 100% 0 0) → inset(0); 800ms
  - stagger via --d custom prop (transition-delay).
- .stage: hero panel, padding 0, overflow hidden; .stage-hud (top strip), .stage-rail (bottom verdict rail).
- .reel: horizontal scroll strip; .reel-frame: min-width 220px card with sprocket-hole
  top/bottom borders (repeating-linear-gradient), status edge glow by routine status.
- .ops-bar: asymmetric grid 1.4fr 1fr 1fr 1fr replacing the 4-equal stat grid.
- .scene-no: mono act numbering "ACT 01" before eyebrow.
- @media (prefers-reduced-motion: reduce): kill aurora/scanline/marquee/draw-in/fx-*/count-up.

## Components
- Reveal.tsx (new): IntersectionObserver wrapper; sets data-in on first intersect; threshold .15.
- RoutineReel.tsx (new): api.llmRuns(12) + api.llmCost(); filmstrip of runs — routine name,
  ET time, status glow (ok=emerald, failed=rose, budget_halt=amber, running=pulse), $cost,
  tool count, top-3 tool names; header shows today burn vs budget.
- SectionHead.tsx: + optional `scene` prop → "ACT 0N" marker + .fx-wipe on the title.
- BotRibbon.tsx: container becomes .ops-bar (asymmetric); card content/text unchanged (e2e locks).
- page.tsx: recomposed into ACT 01–05 per storyboard; EquityChart + PerformanceScorecard +
  BotRibbon fuse into .stage.
- layout.tsx: Archivo font, grain + vignette divs.

## External Library Decision
No new npm deps. Motion: CSS transitions + IntersectionObserver (no framer-motion — page is
data-dense and polls; JS animation lib adds weight without a needed capability). Charts: existing
hand-rolled SVG (kept — already draw-in animated). Fonts: next/font/google only.

## Do-not-break list
- BotRibbon text ("Bot status", routine age string) — e2e new-signals.spec.ts.
- Page hydrates with zero console errors — pages.spec.ts.
- Port 3001; API base http://127.0.0.1:8765; logo untouched.
