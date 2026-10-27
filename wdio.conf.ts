import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TauriCapabilities } from "@wdio/tauri-service";
import TauriService from "@wdio/tauri-service";
import AsyncScriptService, { installAsyncScriptCommand } from "./e2e/async-script-service";
import { recordDrivers, stopOwnedDrivers } from "./e2e/driver-processes";
import { waitForRecordedApplications } from "./e2e/app-processes";
import { sanitize } from "./scripts/sanitize-e2e-results.mjs";

if (process.platform !== "win32") {
  throw new Error("Control Room desktop E2E tests require Windows.");
}

const dataDirectory =
  process.env.CONTROL_ROOM_E2E_DATA_DIR || mkdtempSync(join(tmpdir(), "control-room-e2e-"));
process.env.CONTROL_ROOM_E2E_DATA_DIR = dataDirectory;
process.env.CONTROL_ROOM_E2E_RUNNER_PID ||= String(process.pid);
const application = resolve(
  process.env.CARGO_TARGET_DIR ?? "src-tauri/target",
  "debug/control-room.exe",
);
const tauriCapabilities: TauriCapabilities = {
  browserName: "tauri",
  "tauri:options": { application },
};

export const config: WebdriverIO.Config = {
  runner: "local",
  specs:
    process.env.CONTROL_ROOM_LIVE_DESKTOP === "1"
      ? ["./e2e/live-ssh.spec.ts"]
      : ["./e2e/**/*.spec.ts"],
  exclude: process.env.CONTROL_ROOM_LIVE_DESKTOP === "1" ? [] : ["./e2e/live-ssh.spec.ts"],
  maxInstances: 1,
  outputDir: resolve("test-results/desktop/driver"),
  services: [
    [AsyncScriptService, {}],
    [
      "@wdio/tauri-service",
      {
        driverProvider: "external",
        appBinaryPath: application,
        autoInstallTauriDriver: true,
        autoDownloadEdgeDriver: true,
        captureBackendLogs: true,
        captureFrontendLogs: true,
      },
    ],
  ],
  capabilities: [tauriCapabilities],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 90_000 },
  specFileRetries: 0,
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 10_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 1,
  onWorkerStart: () => recordDrivers(dataDirectory, process.pid),
  before: () => recordDrivers(dataDirectory, Number(process.env.CONTROL_ROOM_E2E_RUNNER_PID)),
  onReload: async () => {
    const { browser } = await import("@wdio/globals");
    installAsyncScriptCommand(browser);
    // The service caches provider metadata by session ID. A native restart needs initialization too.
    await new TauriService({ driverProvider: "external" }, tauriCapabilities).before(
      tauriCapabilities,
      [],
      browser,
    );
  },
  onComplete: async () => {
    try {
      await stopOwnedDrivers(dataDirectory);
      await waitForRecordedApplications(dataDirectory);
      if (
        resolve(dataDirectory).startsWith(resolve(tmpdir()) + sep) &&
        dataDirectory.split(sep).at(-1)?.startsWith("control-room-e2e-")
      ) {
        rmSync(dataDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      const message = sanitize(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      mkdirSync("test-results/desktop", { recursive: true });
      writeFileSync("test-results/desktop/cleanup-error.txt", message);
      process.stderr.write(`Desktop cleanup failed: ${message}\n`);
      throw error;
    }
  },
};
