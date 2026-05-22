import { test, expect, Route } from "@playwright/test";

/**
 * E2E tests for the dashboard's manual buy/sell panel.
 *
 * The "happy path" test stubs `POST /trade/manual` so the test never hits real
 * Alpaca — Playwright should be safe to run unattended without leaking dummy
 * orders into the paper account. The "validation" tests don't even need to
 * stub: they verify the form rejects bad input before the network call.
 */

test.describe("Manual trade panel", () => {
  test("renders form with default state", async ({ page }) => {
    await page.goto("/");
    const panel = page.getByTestId("manual-trade-panel");
    await expect(panel).toBeVisible();

    // Default side = buy (gradient background present).
    await expect(page.getByTestId("side-buy")).toBeVisible();
    await expect(page.getByTestId("side-sell")).toBeVisible();
    await expect(page.getByTestId("symbol-input")).toBeVisible();
    await expect(page.getByTestId("notional-input")).toBeVisible();
    await expect(page.getByTestId("preview-btn")).toBeVisible();

    // Empty symbol → preview button disabled.
    await expect(page.getByTestId("preview-btn")).toBeDisabled();
  });

  test("rejects empty symbol on submit", async ({ page }) => {
    await page.goto("/");
    // Force-click the disabled button via .click({ force: true }) wouldn't
    // submit the form; instead, pre-fill then clear.
    await page.getByTestId("symbol-input").fill("AAPL");
    await page.getByTestId("symbol-input").fill("");
    await expect(page.getByTestId("preview-btn")).toBeDisabled();
  });

  test("opens preview modal then cancels back to form", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("symbol-input").fill("AAPL");
    await page.getByTestId("notional-input").fill("250");
    await page.getByTestId("preview-btn").click();

    const modal = page.getByTestId("manual-trade-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(/Confirm BUY AAPL/i);

    await page.getByTestId("cancel-btn").click();
    await expect(modal).not.toBeVisible();
    // Form values preserved.
    await expect(page.getByTestId("symbol-input")).toHaveValue("AAPL");
    await expect(page.getByTestId("notional-input")).toHaveValue("250");
  });

  test("happy-path: stubbed POST /trade/manual shows success modal", async ({ page }) => {
    // Intercept POST /trade/manual and reply with a synthetic dry-run result
    // BEFORE the page navigates, so the stub catches the real request.
    await page.route("**/trade/manual", (route: Route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          trade_id: 9999,
          order_id: "DRY-MAN-test1234",
          symbol: "AAPL",
          side: "buy",
          qty: 0.5,
          est_price: 200.0,
          notional: 100.0,
          status: "dry_run",
          dry_run: true,
          cancelled_open_opposite: 0,
          market_was_open: false,
          reason: "manual: e2e test",
        }),
      });
    });

    await page.goto("/");
    await page.getByTestId("symbol-input").fill("AAPL");
    await page.getByTestId("notional-input").fill("100");
    await page.getByTestId("note-input").fill("e2e test");
    await page.getByTestId("ah-checkbox").check();
    await page.getByTestId("preview-btn").click();

    await expect(page.getByTestId("manual-trade-modal")).toBeVisible();
    await page.getByTestId("confirm-btn").click();

    await expect(page.getByText(/Dry run recorded|Order submitted/i)).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText(/DRY-MAN-test1234/)).toBeVisible();

    await page.getByTestId("success-close").click();
    // Modal dismissed, form reset.
    await expect(page.getByTestId("manual-trade-modal")).not.toBeVisible();
    await expect(page.getByTestId("symbol-input")).toHaveValue("");
  });

  test("API rejection surfaces error modal verbatim", async ({ page }) => {
    await page.route("**/trade/manual", (route: Route) => {
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "no live quote available for ZZZZ; refusing to size order",
        }),
      });
    });

    await page.goto("/");
    await page.getByTestId("symbol-input").fill("ZZZZ");
    await page.getByTestId("notional-input").fill("100");
    await page.getByTestId("ah-checkbox").check();
    await page.getByTestId("preview-btn").click();
    await page.getByTestId("confirm-btn").click();

    const errBox = page.getByTestId("error-message");
    await expect(errBox).toBeVisible({ timeout: 5_000 });
    await expect(errBox).toContainText(/no live quote available for ZZZZ/);
  });
});
