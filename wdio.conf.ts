import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Options } from "@wdio/types";

if (process.platform !== "win32") {
  throw new Error("Control Room desktop E2E tests require Windows.");
}

const dataDirectory = mkdtempSync(join(tmpdir(), "control-room-e2e-"));
process.env.CONTROL_ROOM_E2E_DATA_DIR = dataDirectory;
const application = resolve("src-tauri/target/debug/control-room.exe");
const driverIds = () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-Process -Name tauri-driver,msedgedriver -ErrorAction SilentlyContinue | ForEach-Object Id",
    ],
    { encoding: "utf8" },
  );
  return new Set(
    result.stdout
      .split(/\s+/)
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  );
};
const existingDrivers = driverIds();

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./e2e/**/*.spec.ts"],
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
  capabilities: [{ browserName: "tauri", "tauri:options": { application } }],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 10_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 1,
  onComplete: () => {
    for (const id of driverIds()) {
      if (!existingDrivers.has(id)) {
        spawnSync("taskkill.exe", ["/PID", String(id), "/T", "/F"], { stdio: "ignore" });
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
