import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TauriCapabilities } from "@wdio/tauri-service";

if (process.platform !== "win32") {
  throw new Error("Control Room desktop E2E tests require Windows.");
}

const dataDirectory = mkdtempSync(join(tmpdir(), "control-room-e2e-"));
process.env.CONTROL_ROOM_E2E_DATA_DIR = dataDirectory;
const application = resolve("src-tauri/target/debug/control-room.exe");
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
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "external",
        appBinaryPath: application,
        autoInstallTauriDriver: true,
        autoDownloadEdgeDriver: true,
      },
    ],
  ],
  capabilities: [tauriCapabilities],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 10_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 1,
  onComplete: () => {
    if (
      resolve(dataDirectory).startsWith(resolve(tmpdir()) + sep) &&
      dataDirectory.split(sep).at(-1)?.startsWith("control-room-e2e-")
    ) {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  },
};
