import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("Owned updater lifecycle cleanup", () => {
  it("removes only the marked fixture and its installed application", async () => {
    await browser.deleteSession();
    execFileSync(process.execPath, [resolve("scripts/test-updater-lifecycle.mjs"), "--cleanup"], {
      env: process.env,
      stdio: "inherit",
      timeout: 180000,
    });
  });
});
