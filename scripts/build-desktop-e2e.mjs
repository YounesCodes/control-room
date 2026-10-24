import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!["win32", "darwin"].includes(process.platform)) {
  throw new Error("Desktop tests require Windows or macOS.");
}
const configuration = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.e2e.conf.json", import.meta.url), "utf8"),
);
// Tauri config overlays replace the windows array. Keep test isolation while
// preserving production window chrome for each platform.
configuration.app.windows[0].decorations = process.platform === "darwin";
if (process.platform === "darwin") {
  configuration.app.windows[0].create = true;
  // Automation relaunches the app outside Launch Services. Keep WKWebView's
  // rendering callbacks running while the OS changes native window activation.
  configuration.app.windows[0].backgroundThrottling = "disabled";
}
const cli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    cli,
    "build",
    "--debug",
    "--no-bundle",
    "--features",
    "desktop-e2e",
    "--config",
    JSON.stringify(configuration),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
