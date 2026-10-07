import { expect } from "@wdio/globals";
import { captureFailure, cleanRuntime, restartApp, savedSettings } from "./helpers";

// Mocha hooks fail the test on setup/cleanup errors; WDIO reporter hooks merely log them.
beforeEach(async () => {
  await restartApp(false);
  expect((await savedSettings()).automaticUpdateChecks).toBe(false);
});
afterEach(async function () {
  if (this.currentTest?.state === "failed")
    await captureFailure(this.currentTest.fullTitle()).catch((error) =>
      console.error("Could not capture failure", error),
    );
  await cleanRuntime();
});
