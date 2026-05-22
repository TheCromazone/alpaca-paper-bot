import { defineConfig, devices } from "@playwright/test";

// Tests run against the already-running dev server (npm run dev) on :3000
// and the FastAPI backend on :8765. We deliberately don't spawn webServer
// here so the running bot/API/dashboard stack stays up between test runs.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // single worker keeps API hits gentle on the FastAPI server
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3001",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
