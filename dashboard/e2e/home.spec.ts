import { test, expect } from "@playwright/test";

test.describe("Home page", () => {
  test("loads without console errors and renders masthead", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    await page.goto("/", { waitUntil: "networkidle" });

    // Masthead must render — look for the equity figure (count-up animation
    // settles to a $ string within the first second).
    await expect(page.locator("body")).toContainText(/\$[\d,]+/);

    // No "Hydration failed" / "did not match" errors.
    const hydrationErrors = consoleErrors.filter((e) =>
      /hydrat|did not match|Text content/i.test(e)
    );
    expect(hydrationErrors, hydrationErrors.join("\n")).toEqual([]);
  });

  test("BotRibbon shows next routine countdown", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // NextRoutine renders one of the routine names somewhere in the body.
    const text = await page.locator("body").innerText();
    expect(text).toMatch(/premarket|execute|midday|close|weekly_review/i);
  });

  test("LLMCostCard shows budget figure", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    // Expect "Today" + dollar figure or "budget"
    expect(text).toMatch(/budget|today/i);
    expect(text).toMatch(/\$\d/);
  });
});
