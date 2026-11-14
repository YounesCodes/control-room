import { localShellLabel } from "./platform";
import "./isolation";
import { $, browser, expect } from "@wdio/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { openSplitMenu, openLocal, runtime, terminalCommand } from "./helpers";

describe("Focus Mode live layout in the native WebView", () => {
  it("interpolates both directions and keeps split sessions alive through rapid toggles", async () => {
    await openLocal();
    await terminalCommand("echo FOCUS_LIVE", "FOCUS_LIVE");
    const sessions = (await runtime()).sessionIds;
    const scale = await browser.execute(() => devicePixelRatio);
    const evidence = [];
    for (const direction of ["enter", "exit"]) {
      // A raw script avoids the test transpiler's injected function-name helper.
      const frames = (await browser.execute(String.raw`
        return new Promise(done => {
          const workspace = document.querySelector(".workspace-shell");
          const terminal = document.querySelector(".xterm-screen");
          const read = () => {
            const box = workspace.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, time: performance.now(), animation: workspace.getAnimations().map(a => ({time:a.currentTime, duration:a.effect.getTiming().duration, state:a.playState})), visible: document.visibilityState };
          };
          const points = [read()];
          document.querySelector(".app-focus-toggle").click();
          const start = performance.now();
          let sampledMidpoint = false;
          function frame() {
            // Slow runners can paint less often than the 180ms slide lasts, so
            // also measure the live box at the slide's midpoint directly.
            const slide = workspace.getAnimations()[0];
            if (!sampledMidpoint && slide) {
              sampledMidpoint = true;
              slide.pause();
              slide.currentTime = slide.effect.getTiming().duration / 2;
              points.push(read());
              slide.play();
            }
            points.push(read());
            if (document.documentElement.dataset.focusTransition && performance.now() - start < 1500) requestAnimationFrame(frame);
            else done({ points, sameTerminal: terminal === document.querySelector(".xterm-screen"), transform: getComputedStyle(workspace).transform });
          }
          requestAnimationFrame(frame);
        });
      `)) as {
        points: { x: number; y: number; width: number; height: number }[];
        sameTerminal: boolean;
        transform: string;
      };
      const first = frames.points[0];
      const last = frames.points.at(-1)!;
      mkdirSync("test-results/desktop", { recursive: true });
      writeFileSync(
        `test-results/desktop/focus-${direction}.json`,
        JSON.stringify(frames, null, 2),
      );
      expect(frames.sameTerminal).toBe(true);
      expect(frames.transform).toBe("none");
      expect(Math.abs(first.width - last.width)).toBeGreaterThan(100);
      expect(
        frames.points.some(
          (box) =>
            box.width > Math.min(first.width, last.width) + 1 &&
            box.width < Math.max(first.width, last.width) - 1,
        ),
      ).toBe(true);
      expect(
        frames.points.some(
          (box) =>
            box.height > Math.min(first.height, last.height) + 1 &&
            box.height < Math.max(first.height, last.height) - 1,
        ),
      ).toBe(true);
      evidence.push({ direction, ...frames });
    }
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>(".app-focus-toggle")!.click();
      for (const animation of document.querySelector(".workspace-shell")!.getAnimations()) {
        animation.pause();
        animation.currentTime = 90;
      }
    });
    mkdirSync("test-results/desktop", { recursive: true });
    await browser.saveScreenshot("test-results/desktop/focus-midpoint.png");
    await browser.execute(() =>
      document
        .querySelector(".workspace-shell")!
        .getAnimations()
        .forEach((animation) => animation.finish()),
    );
    await browser.waitUntil(() =>
      browser.execute(() => !document.documentElement.dataset.focusTransition),
    );
    await openSplitMenu();
    await $(".new-terminal-menu").$(`aria/New local terminal: ${localShellLabel}`).click();
    await browser.waitUntil(async () => (await runtime()).sessionIds.length === 2);
    const splitSessions = (await runtime()).sessionIds;
    await browser.execute(() => {
      for (let i = 0; i < 8; i++)
        document.querySelector<HTMLButtonElement>(".app-focus-toggle")!.click();
    });
    // Hosted Mac runners paint only a few frames a second, and the last slide
    // once outlasted the wait below. Finish it as the earlier step does; the
    // cleanup that follows a finished slide still runs and is checked.
    await browser.execute(() =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .forEach((animation) => animation.finish()),
    );
    await browser.waitUntil(() =>
      browser.execute(() => !document.documentElement.dataset.focusTransition),
    );
    expect((await runtime()).sessionIds).toEqual(splitSessions);
    expect(splitSessions).toEqual(expect.arrayContaining(sessions));
    expect(
      await browser.execute(() => document.querySelectorAll(".focus-departing-sidebar").length),
    ).toBe(0);
    await terminalCommand("echo SPLIT_STILL_LIVE", "SPLIT_STILL_LIVE");
    writeFileSync(
      "test-results/desktop/focus-motion.json",
      JSON.stringify({ scale, evidence }, null, 2),
    );
  });
});
