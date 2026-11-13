import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Explicit only. wdio.conf.ts excludes this from ordinary desktop runs.
describe("Published installer upgrade and clean reinstall", function () {
  this.timeout(1_800_000);
  it("preserves native user data and applies migrations across installed versions", async () => {
    if (process.platform === "win32") {
      // Reuse the native driver already selected for this WebView2 runtime.
      const rows = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$rows = @(Get-CimInstance Win32_Process -Filter \"Name='tauri-driver.exe'\" | Select-Object CommandLine); ConvertTo-Json -Compress -InputObject $rows",
          ],
          { encoding: "utf8", windowsHide: true },
        ),
      );
      const candidates = rows
        .map((row: { CommandLine: string }) =>
          /--native-driver\s+(?:"([^"]+)"|(\S+))/.exec(row.CommandLine),
        )
        .filter(Boolean);
      if (candidates.length !== 1)
        throw new Error("Expected one owned desktop driver before lifecycle testing");
      process.env.CONTROL_ROOM_LIFECYCLE_NATIVE_DRIVER = candidates[0][1] || candidates[0][2];
    }
    // NSIS must not see the debug E2E app as another running Control Room instance.
    await browser.deleteSession();
    execFileSync(process.execPath, [resolve("scripts/test-install-lifecycle.mjs")], {
      env: process.env,
      stdio: "inherit",
      timeout: 1_700_000,
    });
  });
});
