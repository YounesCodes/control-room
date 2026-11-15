import { browser } from "@wdio/globals";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// Explicit only: builds and replaces an isolated, signed native installation.
describe("Installed application's local signed updater", function () {
  this.timeout(1_800_000);
  it("rejects modified bytes, then installs and restarts the correctly signed update", async () => {
    await browser.deleteSession();
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, [resolve("scripts/test-updater-lifecycle.mjs")], {
        env: process.env,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? done() : reject(new Error(`Updater lifecycle exited ${code}`)),
      );
    });
  });
});
