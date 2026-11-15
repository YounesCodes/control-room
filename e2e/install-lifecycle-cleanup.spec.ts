import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Explicit maintenance entry point for the lab's spec-only Windows helper.
// wdio.conf.ts excludes this from ordinary desktop runs.
describe("Remove a failed owned installer fixture", function () {
  this.timeout(240000);
  it("refuses unmarked data and removes only the recorded lifecycle installation", async () => {
    await browser.deleteSession();
    execFileSync(process.execPath, [resolve("scripts/test-install-lifecycle.mjs"), "--cleanup"], {
      env: process.env,
      stdio: "inherit",
      timeout: 200000,
    });
  });
});
