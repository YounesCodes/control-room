import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["@tauri-apps/api/event", "@xterm/addon-fit", "@xterm/addon-search", "@xterm/xterm"],
  },
  test: {
    include: ["src/**/*.browser.test.tsx"],
    testTimeout: 20_000,
    browser: {
      enabled: true,
      provider: playwright({ contextOptions: { reducedMotion: "reduce" } }),
      instances: [{ browser: "chromium" }],
      headless: true,
    },
  },
});
