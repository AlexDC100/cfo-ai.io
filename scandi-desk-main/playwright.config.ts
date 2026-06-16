// Playwright config — Step 5 of FIX-NOW. Default chromium project hits the
// Vite dev server which we expect to already be running on :5173 (the
// harness has it up). To launch automatically when running locally,
// uncomment the `webServer` block below.
//
// CUR-FIX-G — added the "prod" project that hits https://cfo-ai.io. It's
// read-only (currency toggling is per-session, never writes server state)
// so safe to run against the live deploy. Invoke with:
//     npx playwright test --project=prod
// Override URL via E2E_BASE_URL if pointing at a staging origin.

import { defineConfig, devices } from "@playwright/test";

const PROD_BASE_URL = process.env.E2E_PROD_BASE_URL ?? "https://cfo-ai.io";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "prod",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
        baseURL: PROD_BASE_URL,
        // Prod responses (Caddy + cold container) can be slower than dev.
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
      },
    },
  ],
  // Auto-launch dev server in CI / clean envs. Locally we assume it's up.
  // webServer: {
  //   command: "npm run dev",
  //   url: "http://localhost:5173",
  //   reuseExistingServer: !process.env.CI,
  //   timeout: 120_000,
  // },
});
