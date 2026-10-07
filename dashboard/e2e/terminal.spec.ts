import { test, expect, request } from "@playwright/test";

const API = "http://127.0.0.1:8765";

/**
 * Terminal shell + read models. These lock the Bloomberg-style behaviors:
 * the command line resolves tickers and functions, Alt+N jumps between
 * functions, every function route hydrates cleanly, and the /terminal/*
 * endpoints keep their shapes.
 */

test.describe("Terminal API", () => {
  test("/terminal/monitor returns quote rows with sparklines", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/terminal/monitor`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    const row = body.rows[0];
    for (const k of ["ticker", "last", "chg_1d", "chg_ytd", "hi_52w", "lo_52w", "spark"]) {
      expect(row).toHaveProperty(k);
    }
  });

  test("/terminal/heatmap covers the universe by sector", async () => {
    const ctx = await request.newContext();
    const body = await (await ctx.get(`${API}/terminal/heatmap`)).json();
    expect(body.cells.length).toBeGreaterThan(50);
    expect(body.sectors.length).toBeGreaterThan(5);
  });

  test("/terminal/security/SPY has a price series and stats", async () => {
    const ctx = await request.newContext();
    const body = await (await ctx.get(`${API}/terminal/security/SPY`)).json();
    expect(body.ticker).toBe("SPY");
    expect(body.series.length).toBeGreaterThan(100);
    expect(body.stats).toHaveProperty("vol_20d");
  });

  test("/terminal/security rejects junk tickers", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/terminal/security/${encodeURIComponent("<script>")}`);
    expect([400, 404]).toContain(r.status());
  });

  test("/terminal/risk, /terminal/brief and /terminal/wire respond", async () => {
    const ctx = await request.newContext();
    const risk = await (await ctx.get(`${API}/terminal/risk`)).json();
    expect(risk).toHaveProperty("guards");
    expect(risk).toHaveProperty("curve");
    const brief = await (await ctx.get(`${API}/terminal/brief`)).json();
    expect(Array.isArray(brief.items)).toBe(true);
    const wire = await (await ctx.get(`${API}/terminal/wire?limit=20`)).json();
    expect(Array.isArray(wire)).toBe(true);
  });
});

test.describe("Terminal shell", () => {
  test("command line resolves a ticker to its security screen", async ({ page }) => {
    await page.goto("/");
    const cmd = page.getByLabel("Command line");
    await cmd.click();
    await cmd.fill("spy");
    await cmd.press("Enter");
    await expect(page).toHaveURL(/\/security\/SPY/);
  });

  test("command line resolves a function mnemonic", async ({ page }) => {
    await page.goto("/");
    const cmd = page.getByLabel("Command line");
    await cmd.click();
    await cmd.fill("BLTR");
    await cmd.press("Enter");
    await expect(page).toHaveURL(/\/trades$/);
  });

  test("slash focuses the command line and Alt+2 opens PORT", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("/");
    await expect(page.getByLabel("Command line")).toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator("main").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Alt+2");
    await expect(page).toHaveURL(/\/positions$/);
  });

  for (const route of ["/bot", "/risk", "/security/SPY"]) {
    test(`${route} hydrates without console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(route, { waitUntil: "networkidle" });
      const text = (await page.locator("body").innerText()).toLowerCase();
      expect(text).not.toContain("could not be found");
      const hydration = errors.filter((e) => /hydrat|did not match|Text content/i.test(e));
      expect(hydration, hydration.join("\n")).toEqual([]);
    });
  }
});
