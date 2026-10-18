import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir:
    process.env.PRW_PLAYWRIGHT_OUTPUT ??
    ".test-artifacts/web-review/playwright-output",
  use: {
    baseURL: "http://127.0.0.1:4179",
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.env.PRW_BROWSER_EXECUTABLE
        ? { executablePath: process.env.PRW_BROWSER_EXECUTABLE }
        : {}),
      args: ["--no-sandbox", "--disable-crash-reporter", "--disable-breakpad"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "node --import tsx test/fixtures/web-server.mjs",
    url: "http://127.0.0.1:4179/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
