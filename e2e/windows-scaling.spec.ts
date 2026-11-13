import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { ipc, runtime } from "./helpers";
import {
  focusNativeApp,
  openNativeShell,
  typeNativeCommand,
  windowsResolution,
  windowsScale,
} from "./native-input";

// OS display scaling is Windows-only. This never substitutes CSS zoom for DPI.
const windowsCase = process.platform === "win32" ? it : it.skip;
describe("Windows native display scale and window restore", function () {
  this.timeout(180000);
  let originalResolution: { width: number; height: number } | undefined;
  before(() => {
    if (process.platform !== "win32") return;
    originalResolution = windowsResolution();
    // Small VM modes hide the 150% option in Windows Display Settings.
    // This is a tested session-only mode change, without a registry update.
    if (originalResolution.width < 1920 || originalResolution.height < 1080)
      windowsResolution({ width: 1920, height: 1080 });
  });
  after(() => {
    if (originalResolution) windowsResolution(originalResolution);
  });
  for (const scale of [125, 150])
    windowsCase(
      `restores native geometry and keeps its session at ${scale}% OS scale`,
      async () => {
        await openNativeShell();
        const sessions = (await runtime()).sessionIds;
        const originalScale = windowsScale();
        try {
          windowsScale(scale);
          await focusNativeApp();
          await browser.waitUntil(
            async () =>
              Math.abs((await browser.execute(() => devicePixelRatio)) - scale / 100) < 0.01,
            { timeout: 20000, timeoutMsg: "The OS did not apply the requested display scale" },
          );
          const dimensions = () =>
            ipc<{ width: number; height: number }>("plugin:window|inner_size", { label: "main" });
          const original = await dimensions();
          await $("[aria-label='Maximize or restore window']").click();
          await browser.waitUntil(() =>
            ipc<boolean>("plugin:window|is_maximized", { label: "main" }),
          );
          await $("[aria-label='Maximize or restore window']").click();
          await browser.waitUntil(async () => {
            const restored = await dimensions();
            return (
              Math.abs(restored.width - original.width) <= 2 &&
              Math.abs(restored.height - original.height) <= 2
            );
          });
          await typeNativeCommand("echo DPI_RESTORE_OK", "DPI_RESTORE_OK");
          expect((await runtime()).sessionIds).toEqual(sessions);
        } finally {
          windowsScale(originalScale);
          await focusNativeApp();
          await browser.waitUntil(
            async () =>
              Math.abs((await browser.execute(() => devicePixelRatio)) - originalScale / 100) <
              0.01,
            { timeout: 20000, timeoutMsg: "The OS did not restore the original display scale" },
          );
        }
      },
    );
});
