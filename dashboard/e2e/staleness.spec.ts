import { test, expect, request } from "@playwright/test";

const API = "http://127.0.0.1:8765";

// Catch a frozen scheduler. The bot fires a research_tick every 15 min 24/7
// and a news_refresh job runs in it. If neither has happened in the last
// 30 minutes, the scheduler is dead and the dashboard would silently keep
// showing stale data.
test("scheduler is alive — recent job_runs in last 30 min", async () => {
  const ctx = await request.newContext();
  const r = await ctx.get(`${API}/jobs?limit=10`);
  expect(r.status()).toBe(200);
  const jobs = (await r.json()) as Array<{
    job_name: string;
    started_at: string;
    finished_at: string | null;
    status: string;
  }>;
  expect(jobs.length).toBeGreaterThan(0);

  const newest = jobs[0];
  const startedMs = Date.parse(newest.started_at);
  const ageMin = (Date.now() - startedMs) / 60_000;
  expect(
    ageMin,
    `most recent job ${newest.job_name} started ${ageMin.toFixed(1)} min ago`,
  ).toBeLessThan(30);
});

test("at least one news_refresh ran in last 60 min", async () => {
  const ctx = await request.newContext();
  const r = await ctx.get(`${API}/jobs?limit=30`);
  const jobs = (await r.json()) as Array<{ job_name: string; started_at: string }>;
  const news = jobs.filter((j) => /news_refresh/.test(j.job_name));
  expect(news.length).toBeGreaterThan(0);
  const newestMs = Date.parse(news[0].started_at);
  const ageMin = (Date.now() - newestMs) / 60_000;
  expect(ageMin, `newest news_refresh ${ageMin.toFixed(1)} min old`).toBeLessThan(60);
});
