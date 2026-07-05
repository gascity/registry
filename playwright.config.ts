import { defineConfig } from "@playwright/test";

const port = process.env.PORT ?? "48177";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // Only Playwright specs. e2e/*.test.ts (e.g. the real-gc CLI test) run under `bun test`
  // via `test:cli`, not Playwright.
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    // Boot the e2e harness (hermetic fakes: no gc, no network, no GitHub App) instead of
    // the plain server, so the full publish -> validate -> approve -> merge flow can run
    // offline. Omitting REGISTRY_DATA_PATH makes the harness mkdtemp a fresh store per run.
    command: `bun run generate && bun run build && REGISTRY_HARNESS=1 REGISTRY_DEV_AUTH=1 APP_URL=${baseURL} PORT=${port} bun server/index.harness.ts`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
