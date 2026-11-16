import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("Published installer upgrade and clean reinstall", function () {
  this.timeout(1_800_000);
  it("preserves native user data and applies migrations across installed versions", async () => {
    // NSIS must not see the debug E2E app as another running Control Room instance.
    await browser.deleteSession();
    execFileSync(process.execPath, [resolve("scripts/test-install-lifecycle.mjs")], {
      env: process.env,
      stdio: "inherit",
      timeout: 1_700_000,
    });
  });
});
