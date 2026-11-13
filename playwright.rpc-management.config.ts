import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PRW_RPC_PORT);
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /rpc-management(?:-safety)?\.spec\.ts/,
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: process.env.PRW_RPC_OUTPUT,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
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
    command: "node test/fixtures/rpc-management-server.mjs",
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
