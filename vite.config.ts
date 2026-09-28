// vitest/config re-exports Vite's defineConfig and adds the `test` block.
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "**/*.browser.test.tsx", "e2e/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,browser.test}.{ts,tsx}", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text-summary", "html", "lcov"],
    },
    // The jsdom suites that mount the whole app are slow enough on a loaded
    // machine to trip the 5s default while doing nothing wrong.
    testTimeout: 20_000,
  },
});
