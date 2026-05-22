# Macro catalyst calendar — 2026

Hand-maintained ledger of recurring macro events the LLM should be aware
of every premarket. The model reads this via `read_memory('catalysts')`.
When an event is < 7 days away, it should be cited in the Pre-market
research_log entry under "macro context."

This file is a **seed** — full year stamped at compile time. Verify
specific dates against the Fed/BLS calendars before any binary trade.

---

## 2026 FOMC meeting dates (rate decisions)

- **Jan 27–28** — first meeting of the year, sets tone
- **Mar 17–18** — SEP (Summary of Economic Projections) refresh
- **Apr 28–29**
- **Jun 16–17** — SEP refresh
- **Jul 28–29**
- **Sep 15–16** — SEP refresh
- **Oct 27–28**
- **Dec 15–16** — SEP refresh

**Trade implication**: announcements at 14:00 ET, presser 14:30 ET.
Short rates / banks / housing-related names move most. If the bot is
holding a rate-sensitive position the week of an FOMC, write an
explicit pre-positioning note.

## 2026 CPI / PPI release dates (BLS, 08:30 ET)

- CPI typically second Tuesday of the month, 08:30 ET.
- PPI typically the day before CPI.
- Updated monthly; check `bls.gov/schedule` for the exact day.

**Trade implication**: equity beta swings on surprise relative to
consensus. Pre-position only with a strong directional view.

## 2026 Jobs report (Nonfarm Payrolls)

- First Friday of every month, 08:30 ET.
- Big surprise = biggest single move of the month often.
- Pairs with average hourly earnings — wage inflation matters as much
  as headline NFP.

## Quarterly earnings season anchor weeks

- **Q4 2025 reporting**: mid-Jan → mid-Feb 2026 (banks lead)
- **Q1 2026 reporting**: mid-Apr → mid-May 2026
- **Q2 2026 reporting**: mid-Jul → mid-Aug 2026
- **Q3 2026 reporting**: mid-Oct → mid-Nov 2026

Use `get_upcoming_earnings` for the per-ticker calendar.

## Recurring industry data points

- **Auto sales** (monthly, GM/F/STLA/TSLA/TM) — first business day.
- **Semiconductor billings** (SIA, monthly, ~mid-month).
- **Retail same-store sales** (early in earnings season).
- **Initial jobless claims** — Thursdays 08:30 ET, weekly noise.

---

## Stock-specific catalysts (LLM-maintained)

> The LLM may add datable, position-relevant catalysts here over time.
> One-line entries grouped by date. Examples:
>
> - 2026-05-28: NVDA Q1 earnings (post-close). Held: yes.
> - 2026-06-10: AAPL WWDC keynote. Held: yes.
> - 2026-07-15: FOMC SEP refresh. Held: 4 rate-sensitive positions.

(empty for now — populate as catalysts surface in weekly review)
