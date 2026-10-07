import { expect } from "@wdio/globals";
import { captureFailure, cleanRuntime, restartApp, savedSettings } from "./helpers";

let setupComplete = false;

// Mocha hooks fail the test on setup/cleanup errors; WDIO reporter hooks merely log them.
beforeEach(async () => {
  setupComplete = false;
  await restartApp(false);
  expect((await savedSettings()).automaticUpdateChecks).toBe(false);
  setupComplete = true;
});
afterEach(async function () {
  if (this.currentTest?.state === "failed")
    await captureFailure(this.currentTest.fullTitle()).catch((error) =>
      console.error("Could not capture failure", error),
    );
  try {
    await cleanRuntime();
  } catch (error) {
    if (setupComplete && this.currentTest?.state !== "failed") throw error;
    console.error("Cleanup failed after an earlier test/setup failure.");
  }
});
