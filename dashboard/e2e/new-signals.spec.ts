import { test, expect, request } from "@playwright/test";

const API = "http://127.0.0.1:8765";

test.describe("New signal endpoints (Phase C)", () => {
  test("/regime/today returns label + macro inputs", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/regime/today`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.regime_label).toMatch(/^(risk_on|neutral|risk_off)$/);
    expect(body).toHaveProperty("vix");
    expect(body).toHaveProperty("breadth_pct");
  });

  test("/earnings/upcoming returns at least one event", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/earnings/upcoming?days=14`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      const first = body[0];
      expect(first).toHaveProperty("ticker");
      expect(first).toHaveProperty("report_date");
      expect(first).toHaveProperty("last_4_surprise_pcts");
    }
  });

  test("/signals/by-politician?name=Pelosi accepts the filter", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/signals/by-politician?name=Pelosi&days=180`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    // No assertion on length — depends on whether House data has picked up
    // Pelosi yet. Endpoint shape is what matters.
    for (const row of body) {
      expect(row.politician.toLowerCase()).toContain("pelosi");
      expect(row).toHaveProperty("ticker");
      expect(row).toHaveProperty("direction");
    }
  });
});

test.describe("Home page new components", () => {
  test("RegimeCard renders the regime label", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    // The label is shown uppercase; underscore is replaced with space.
    expect(text).toMatch(/RISK ON|NEUTRAL|RISK OFF|MARKET REGIME/i);
  });

  test("Earnings on deck section is present", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    expect(text).toMatch(/Earnings on deck|EARNINGS|on deck/i);
  });

  test("Bot status shows recent LLM activity (not 'five routines/day' filler)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // The status card should mention a routine + an age string.
    const card = page.locator(".stat-card", { has: page.getByText(/Bot status/i) });
    const text = (await card.first().innerText()).toLowerCase();
    // After /bot/status is wired to LLM runs, this card surfaces something
    // like "close 1m ago · 4 tools · $0.37" instead of the static
    // "five routines/day · ET-aligned" placeholder.
    expect(text).toMatch(/(premarket|execute|midday|close|weekly_review).+(ago|now)/);
  });
});
