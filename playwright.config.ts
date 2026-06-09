import { defineConfig } from "@playwright/test";

const port = process.env.PORT ?? "48177";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `REGISTRY_DEV_AUTH=1 REGISTRY_DATA_PATH=.registry-data/playwright.json APP_URL=${baseURL} PORT=${port} bun run dev:static`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
