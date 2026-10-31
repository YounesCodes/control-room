// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { transitionFocusMode } from "./focus-mode-transition";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "startViewTransition");
  delete document.documentElement.dataset.focusTransition;
});

it("applies changes immediately without snapshotting for reduced motion or unsupported browsers", () => {
  const start = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  const update = vi.fn();
  transitionFocusMode("enter", update);
  expect(update).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: undefined });
  transitionFocusMode("exit", update);
  expect(update).toHaveBeenCalledTimes(2);
});

it("skips superseded callbacks and cleans up only after the newest transition", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  const callbacks: (() => void)[] = [];
  const completions: (() => void)[] = [];
  const transitions: { skipTransition: ReturnType<typeof vi.fn> }[] = [];
  const start = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    const transition = {
      skipTransition: vi.fn(),
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      finished: new Promise<void>((resolve) => completions.push(resolve)),
    };
    transitions.push(transition);
    return transition;
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  const enter = vi.fn();
  const exit = vi.fn();
  transitionFocusMode("enter", enter);
  transitionFocusMode("exit", exit);
  expect(transitions[0].skipTransition).toHaveBeenCalledOnce();
  callbacks[0]();
  callbacks[1]();
  expect(enter).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledOnce();
  completions[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.documentElement.dataset.focusTransition).toBe("exit");
  completions[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.documentElement.dataset.focusTransition).toBeUndefined();
});
