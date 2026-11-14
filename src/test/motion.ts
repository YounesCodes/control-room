import { expect, vi } from "vitest";

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/// Waits until nothing under `root` animates across several frames. Slow WebKit
/// runners can start a transition a frame or two after the change that causes
/// it, so one empty check can pass before the motion begins.
export async function settleMotion(root: Document | Element = document, timeout = 5000) {
  const running = () =>
    root
      .getAnimations(root instanceof Document ? undefined : { subtree: true })
      .filter((animation) => animation.playState === "running");
  await vi.waitFor(
    async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        expect(running()).toHaveLength(0);
        await nextFrame();
      }
      expect(running()).toHaveLength(0);
    },
    { timeout },
  );
}
