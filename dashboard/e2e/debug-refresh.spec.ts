import { test, expect } from "@playwright/test";

/**
 * Headed live-debug spec: opens the dashboard, watches it for 90 seconds,
 * logs every fetch to 127.0.0.1:8765, every console message, and snapshots
 * key on-screen values. Goal: see *which* widgets aren't refreshing.
 *
 * Run with:  npx playwright test debug-refresh --headed
 */

const SCREENSHOT_DIR = "test-results/debug";

test("dashboard refresh behavior — 90s headed observation", async ({ page }) => {
  test.setTimeout(120_000);

  type FetchEvt = { t: number; url: string; status: number };
  const fetches: FetchEvt[] = [];
  const consoleErrors: string[] = [];
  const start = Date.now();

  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("127.0.0.1:8765") || url.includes("/api/")) {
      // Recorded on response so we capture status; just note start here.
    }
  });
  page.on("response", async (resp) => {
    const url = resp.url();
    if (url.includes("127.0.0.1:8765") || url.includes("/api/")) {
      fetches.push({
        t: Math.round((Date.now() - start) / 1000),
        url: url.replace("http://127.0.0.1:8765", ""),
        status: resp.status(),
      });
    }
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  console.log("\n=== T+0s: navigating to /");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  // Helper: pull the current visible value of a labeled stat card by its eyebrow.
  async function readStat(label: RegExp): Promise<string> {
    const card = page.locator(".stat-card", { has: page.getByText(label) });
    if ((await card.count()) === 0) return "<missing>";
    return (await card.first().innerText()).replace(/\s+/g, " ").trim();
  }

  async function snapshot(tag: string) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    const status = await readStat(/Bot status/i);
    const next = await readStat(/Next routine|next routine/i);
    const regime = await readStat(/Market regime/i);
    const cost = await readStat(/LLM spend|llm spend/i);
    console.log(`\n--- T+${elapsed}s [${tag}] ---`);
    console.log(`  bot:    ${status}`);
    console.log(`  next:   ${next}`);
    console.log(`  regime: ${regime}`);
    console.log(`  cost:   ${cost}`);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/snap-${String(elapsed).padStart(3, "0")}-${tag}.png`,
      fullPage: true,
    });
  }

  await snapshot("initial");

  // Wait 30s: most useQuery refetchIntervals are 15s/30s/60s. We expect to
  // see at least one re-fetch of /llm/cost (30s), /bot/status (15s), and
  // possibly /portfolio/summary in this window.
  console.log("\n=== Waiting 30s to observe first refetch wave ===");
  await page.waitForTimeout(30_000);
  await snapshot("after-30s");

  console.log("\n=== Waiting another 30s ===");
  await page.waitForTimeout(30_000);
  await snapshot("after-60s");

  console.log("\n=== Waiting final 30s (90s total) ===");
  await page.waitForTimeout(30_000);
  await snapshot("after-90s");

  // ========== Report ==========
  console.log("\n\n========== FETCH LOG (all API hits over 90s) ==========");
  // Bucket by endpoint to see which ones polled and which didn't.
  const byPath: Record<string, number[]> = {};
  for (const f of fetches) {
    const path = f.url.split("?")[0];
    if (!byPath[path]) byPath[path] = [];
    byPath[path].push(f.t);
  }
  const endpoints = Object.keys(byPath).sort();
  for (const p of endpoints) {
    const times = byPath[p];
    const intervals = times
      .slice(1)
      .map((t, i) => t - times[i])
      .map((d) => `${d}s`);
    console.log(
      `  ${p.padEnd(34)}  hits=${times.length}  at=[${times
        .map((t) => `${t}s`)
        .join(",")}]  intervals=[${intervals.join(",")}]`,
    );
  }

  // List endpoints that the dashboard *should* poll but didn't in the window
  const expectedPolling = [
    "/portfolio/summary",
    "/positions",
    "/bot/status",
    "/llm/cost",
    "/routines/next",
    "/regime/today",
    "/earnings/upcoming",
  ];
  console.log("\n========== POLLING AUDIT ==========");
  for (const ep of expectedPolling) {
    const hits = byPath[ep]?.length ?? 0;
    const flag = hits >= 2 ? "OK" : hits === 1 ? "ONLY-INITIAL" : "MISSING";
    console.log(`  [${flag.padEnd(13)}] ${ep}  (${hits} hits)`);
  }

  console.log("\n========== CONSOLE ERRORS / WARNINGS ==========");
  if (consoleErrors.length === 0) console.log("  (none)");
  for (const e of consoleErrors.slice(0, 30)) console.log(`  ${e}`);

  // Soft assertion only — we just want the data, not a strict pass/fail here.
  expect(fetches.length, "API was never hit at all").toBeGreaterThan(0);
});
