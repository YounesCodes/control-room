import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TauriCapabilities } from "@wdio/tauri-service";
import TauriService from "@wdio/tauri-service";
import { recordDrivers, stopOwnedDrivers } from "./e2e/driver-processes";

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
    // The service caches provider metadata by session ID. A native restart needs initialization too.
    await new TauriService({ driverProvider: "external" }, tauriCapabilities).before(
      tauriCapabilities,
      [],
      browser,
    );
  },
  onComplete: async () => {
    await stopOwnedDrivers(dataDirectory);
    const pidFile = join(dataDirectory, "app-pids.txt");
    const pids = existsSync(pidFile)
      ? readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number)
      : [];
    for (const pid of pids) {
      const deadline = Date.now() + 20_000;
      while (true) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        if (Date.now() > deadline)
          throw new Error(
            `E2E application ${pid} is still running; preserving its temporary directory`,
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (
      resolve(dataDirectory).startsWith(resolve(tmpdir()) + sep) &&
      dataDirectory.split(sep).at(-1)?.startsWith("control-room-e2e-")
    ) {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  },
};
