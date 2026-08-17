// Playwright E2E config for the Bots app.
//
// Runs the flows against the real Vite dev server (the same bundle Tauri
// loads in `tauri dev`), with the Tauri IPC bridge and all OpenRouter
// network traffic mocked per-test (see e2e/support/mocks.ts).
//
// Invocation (no package.json scripts needed): `npx playwright test`
// from /app. See e2e/README.md for details.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Keep Playwright specs out of vitest and vice versa: vitest only picks up
  // src/**/*.test.{ts,tsx}; Playwright only picks up e2e/**/*.spec.ts.
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
