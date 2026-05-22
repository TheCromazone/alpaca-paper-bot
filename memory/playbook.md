# Research playbook

Distilled from Anthropic's *claude-for-financial-services* equity-research
plugin (idea-generation, earnings-preview, catalyst-calendar skills). Read
this in `premarket` and `weekly_review` when generating ideas or doing a
post-mortem. Strategy.md is the LAW; this file is the METHOD.

---

## 1. Idea generation — how to surface a candidate

**Step 1 — define the search frame.** Before any web_search, decide:
- Direction: long bias only (paper account, no shorts).
- Sector: any catalyst-rich sector this week, or a held position needing
  defense.
- Style: catalyst-driven event, value-with-trigger, quality-on-dip,
  special situation. NOT pure technicals; NOT pure macro narrative.

**Step 2 — candidate filters (judgement calls, not handler-enforced).**
A candidate is worth a thesis only if:
- ADV ≥ $50M notional (skip illiquid).
- Market cap ≥ $5B (US large-cap focus).
- A *named, datable* catalyst exists (earnings date, FDA PDUFA, product
  launch, regulator decision, index rebalance, conference). "AI is hot"
  and "rate cuts coming" are NOT catalysts.
- The market hasn't fully priced it in — check 5d/30d return, options
  IV, analyst revisions if web_search surfaces them.

**Step 3 — present the idea.** Every research_log Pre-market entry must
follow this template (forces the LLM to do the work, not just name-drop):

```
- **TICKER** (~$NOTIONAL): one-line catalyst statement.
  - Why mispriced: <one sentence — what consensus has wrong>
  - What market is missing: <one sentence — the variant view>
  - Datable catalyst: <event + date in the next 1-8 weeks>
  - Key risk (what makes this wrong): <one sentence>
  - Sources: <2-3 URLs from web_search>
```

If you can't fill all five fields, the idea isn't ready. Move on.

**Step 4 — avoid crowded trades.** Before placing, check:
- Are 3+ existing positions already in the same sector? Need a notably
  stronger thesis to add a fourth (strategy.md sector concentration rule).
- Is this a name the prior week's research_log already discussed and
  passed on? If so, what changed?

---

## 2. Earnings preview — what to do with a held position about to report

When `get_upcoming_earnings` shows a held position reports within 5
trading days, do this BEFORE the print, not after:

**Bull / Base / Bear scenarios.** In the Pre-market entry:
```
EARNINGS PREP — TICKER reports {date} {pre/post}
- Bull:  rev $X (+Y%), EPS $Z, key driver: {metric}, expected move: +N%
- Base:  rev $X (+Y%), EPS $Z, key driver: {metric}, expected move:  0%
- Bear:  rev $X (+Y%), EPS $Z, key driver: {metric}, expected move: -N%
- Action: hold through / trim N% / exit before
```

**Sector-specific operational metrics to watch.** Don't only watch EPS:
- Tech / SaaS: ARR, net retention, RPO, customer count, capex guide.
- Retail / consumer: same-store sales, traffic, basket size, inventory.
- Industrials: backlog, book-to-bill, price/volume mix, capex cycle.
- Financials: NIM, credit quality, loan growth, fee income.
- Healthcare: scripts, patient volumes, pipeline updates, PDUFAs.
- Semis: data-center vs. PC mix, gross margin, foundry utilization.

**Decision rule.** If implied move (from options, when surfaceable via
web_search) > 8%, treat the print as binary: either trim the position to
half size before earnings, or write an explicit "hold full size through
binary event" note in research_log explaining why.

---

## 3. Catalyst taxonomy — beyond earnings

`get_upcoming_earnings` is one channel. Augment with web_search for:

**Corporate**
- Product launches / announcements (Apple events, NVIDIA GTC).
- FDA approvals, PDUFA decisions, Phase 3 readouts.
- Contract renewals, new wins.
- M&A milestones (close dates, regulatory rulings).
- Lockup expirations on recent IPOs/SPACs.
- Index rebalances (S&P, Russell — they move flows).

**Industry**
- Major conferences (CES, JPM Healthcare, Money 20/20). Which names
  are presenting and which are conspicuously absent?
- Trade-show data (auto sales, semiconductor billings, chip shipments).
- Regulatory rulings (DOJ antitrust, FCC, FTC).

**Macro** (read `catalysts.md` for our hardcoded calendar)
- FOMC meetings — front-end of curve reprices, banks/REITs move most.
- CPI / PPI — risk-on vs. risk-off swing.
- Jobs report — labor proxy, often biggest first-Friday move.
- GDP / retail sales / industrial production.

For each catalyst within 2 weeks, note in research_log:
- Date, time (US ET), event name.
- Which held positions or candidates it most affects.
- Pre-positioning recommendation (long / trim / hedge / sit out).

---

## 4. Weekly review playbook

When running `weekly_review`, the rubric is:

1. **Hit-rate inventory.** Of last week's Pre-market ideas:
   - How many became actual buys? Why did the rest get skipped?
   - Of those bought, how many are up vs. down vs. flat?
2. **Thesis-vs-reality.** For each closed position:
   - Did the catalyst actually fire?
   - Did the move match the thesis (right reason) or fight it (wrong
     reason)?
3. **Process gaps.** Identify ONE process change to propose for
   strategy.md. Examples: tighter sector cap, narrower catalyst
   definition, different pre-positioning rule. Write it as a concrete
   diff against current strategy.md text.
4. **Idea pipeline.** List 3-5 names worth watching next week with
   their expected catalysts. This seeds Monday's premarket.

---

## 5. Anti-patterns — things the audit caught us doing wrong before

These are the failure modes baked into the bot's history. Don't repeat.

- **Three-ticker churn** (week 1 quant: 98 AGG + 34 RTX = 95% of trades).
  If a single name has >5 round-trip cycles in a week, something is
  contradicting itself. Stop and read strategy.md.
- **Thesis-as-string-fill.** Reasons like "rebalance trim: 10.0%" or
  "fixed-income floor" are not theses; they're auto-strings. Every
  buy/sell decision must carry a *human-readable, catalyst-grounded*
  reason ≥120 chars (handler-enforced).
- **Skipping the bear case.** A thesis without a "what makes this
  wrong" sentence is a hope, not a thesis.
- **Concentration luck framing.** If one position carries the book,
  alpha is luck not skill. Flag it in weekly_review honestly.
