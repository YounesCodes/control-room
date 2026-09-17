import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.pw.ts",
  outputDir: "./node_modules/.cache/docs-ui-results",
  use: {
    baseURL: "http://127.0.0.1:4322/control-room/",
    browserName: "chromium",
    // Set PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome; the default
    // needs `npx playwright install chromium` once.
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4322",
    url: "http://127.0.0.1:4322/control-room/",
    reuseExistingServer: !process.env.CI,
  },
});
