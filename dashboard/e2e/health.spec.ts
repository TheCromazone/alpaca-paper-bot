import { test, expect, request } from "@playwright/test";

const API = "http://127.0.0.1:8765";

test.describe("API health", () => {
  test("/health returns ok", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/health`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(typeof body.now).toBe("string");
  });

  test("/portfolio/summary has equity + cash + sector_breakdown", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/portfolio/summary`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("equity");
    expect(body).toHaveProperty("cash");
    expect(body).toHaveProperty("sector_breakdown");
    expect(typeof body.equity).toBe("number");
    expect(body.equity).toBeGreaterThan(0);
  });

  test("/routines/next has next + countdown", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/routines/next`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("routines_enabled");
    expect(body.routines_enabled).toBe(true);
    expect(body.next).toBeTruthy();
    expect(body.next.name).toMatch(/^(premarket|execute|midday|close|weekly_review)$/);
    expect(body.next.seconds_until).toBeGreaterThanOrEqual(0);
  });

  test("/llm/cost reports today + budget", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/llm/cost`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("today_usd");
    expect(body).toHaveProperty("budget_usd");
    expect(body.budget_usd).toBeGreaterThan(0);
    expect(body.today_usd).toBeGreaterThanOrEqual(0);
  });

  test("/bot/status reports recent tick", async () => {
    const ctx = await request.newContext();
    const r = await ctx.get(`${API}/bot/status`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty("last_tick_at");
  });
});
