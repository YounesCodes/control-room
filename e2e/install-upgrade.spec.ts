import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Explicit only. wdio.conf.ts excludes this from ordinary desktop runs.
describe("Published installer upgrade and clean reinstall", function () {
  this.timeout(1_800_000);
  it("preserves native user data and applies migrations across installed versions", async () => {
    // tauri-driver discovers the same native driver from the PATH prepared by
    // the WDIO service; standalone runs may provide an explicit override.
    // NSIS must not see the debug E2E app as another running Control Room instance.
    await browser.deleteSession();
    execFileSync(process.execPath, [resolve("scripts/test-install-lifecycle.mjs")], {
      env: process.env,
      stdio: "inherit",
      timeout: 1_700_000,
    });
  });
});
