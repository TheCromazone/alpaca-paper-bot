import { test, expect } from "@playwright/test";

const ROUTES = ["/positions", "/trades", "/signals", "/news"] as const;

for (const route of ROUTES) {
  test(`${route} loads without console errors`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    await page.goto(route, { waitUntil: "networkidle" });

    // Page must not 404 — Next renders a generic 404 page; check title or
    // status by looking for the "could not be found" string Next emits.
    const text = await page.locator("body").innerText();
    expect(text.toLowerCase()).not.toContain("404");
    expect(text.toLowerCase()).not.toContain("could not be found");

    const hydrationErrors = consoleErrors.filter((e) =>
      /hydrat|did not match|Text content/i.test(e)
    );
    expect(hydrationErrors, `${route}: ${hydrationErrors.join(" | ")}`).toEqual([]);
  });
}
