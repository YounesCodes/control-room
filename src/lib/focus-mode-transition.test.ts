// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { transitionFocusMode } from "./focus-mode-transition";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "startViewTransition");
  document.body.replaceChildren();
  delete document.documentElement.dataset.focusTransition;
});

it.each([true, false])(
  "updates controls synchronously without capturing frames, reduced motion: %s",
  (reduced) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reduced })),
    );
    const start = vi.fn();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    const update = vi.fn();
    transitionFocusMode("exit", update);
    expect(update).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  },
);

it("cancels superseded live motion without delaying the next state or leaving overlays", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  document.body.innerHTML =
    '<div class="app-shell"><aside class="sidebar"></aside><main class="workspace-shell"></main></div>';
  const motions: { cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
  const animate = vi.fn(() => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const motion = { cancel: vi.fn(() => finish()), finish, finished };
    motions.push(motion);
    return motion;
  });
  vi.stubGlobal("HTMLElement", HTMLElement);
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  try {
    const enter = vi.fn();
    const exit = vi.fn();
    transitionFocusMode("enter", enter);
    const old = motions.slice();
    expect(document.querySelector(".focus-departing-sidebar")).toHaveProperty("inert", true);
    transitionFocusMode("exit", exit);
    expect(enter).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(old.every((motion) => motion.cancel.mock.calls.length === 1)).toBe(true);
    expect(document.querySelector(".focus-departing-sidebar")).toBeNull();
    motions.forEach((motion) => motion.finish());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.documentElement.dataset.focusTransition).toBeUndefined();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});
