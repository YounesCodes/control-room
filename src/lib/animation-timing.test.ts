// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { finiteAnimationsSettled, nextFrameOrTimeout } from "./animation-timing";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function animation(endTime: number, finished: Promise<unknown>) {
  return { effect: { getComputedTiming: () => ({ endTime }) }, finished } as unknown as Animation;
}

describe("nextFrameOrTimeout", () => {
  it("resolves on the next frame and cancels the timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 7;
    });
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    await nextFrameOrTimeout(100);
    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves after the timeout and cancels the frame when frames are suspended", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cancelAnimationFrame = vi.spyOn(window, "cancelAnimationFrame");
    let resolved = false;
    const waiting = nextFrameOrTimeout(100).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(7);
  });
});

describe("finiteAnimationsSettled", () => {
  it("resolves at once when the element cannot report animations", async () => {
    await expect(finiteAnimationsSettled(document.createElement("div"))).resolves.toBeUndefined();
  });

  it("waits for finite animations, ignores infinite ones and tolerates cancellation", async () => {
    const element = document.createElement("div");
    let finish!: () => void;
    const getAnimations = vi.fn(() => [
      animation(
        160,
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      ),
      animation(90, Promise.reject(new DOMException("cancelled", "AbortError"))),
      animation(Number.POSITIVE_INFINITY, new Promise(() => undefined)),
    ]);
    Object.defineProperty(element, "getAnimations", { value: getAnimations });
    let settled = false;
    const waiting = finiteAnimationsSettled(element).then(() => (settled = true));
    await Promise.resolve();
    expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(settled).toBe(false);
    finish();
    await waiting;
    expect(settled).toBe(true);
  });
});
