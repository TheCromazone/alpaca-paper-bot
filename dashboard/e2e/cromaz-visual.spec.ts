import { test } from "@playwright/test";

/**
 * One-shot visual snapshot for the Cromaz rebrand.
 * Just captures a full-page screenshot at 1440×900 so we can eyeball it
 * against the design reference. Not a regression check — the snapshot is
 * the artifact, not an assertion.
 */
test("cromaz visual snapshot", async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "networkidle" });
  // Let aurora & rise animations settle.
  await page.waitForTimeout(2_000);
  await page.screenshot({
    path: "test-results/cromaz-snapshot-full.png",
    fullPage: true,
  });
  await page.screenshot({
    path: "test-results/cromaz-snapshot-fold.png",
    fullPage: false,
  });
});
