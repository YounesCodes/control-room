// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabScroller, type WorkspaceTabOption } from "./WorkspaceTabScroller";

const TAB_WIDTH = 175;
const STRIP = { left: 0, right: 700, top: 0, bottom: 34 };

/// The strip's tabs match App's shape: a wrap with the main button (drag and
/// click surface) and a Close-style button that must never start a drag.
function Strip({
  labels,
  onReorder,
}: {
  labels: string[];
  onReorder?: (id: string, targetIndex: number) => void;
}) {
  return (
    <WorkspaceTabScroller
      items={labels.map((label, index): WorkspaceTabOption => {
        return {
          id: `id-${index + 1}`,
          label,
          active: index === 0,
          onSelect: () => {},
        };
      })}
      activeTabId="id-1"
      arrangementKey="test"
      onReorder={onReorder}
    >
      {labels.map((label, index) => (
        <div className="session-tab-wrap" key={`id-${index + 1}`}>
          <button className="session-tab-main" type="button">
            {label}
          </button>
          <button className="session-tab-close" type="button" aria-label={`Close ${label}`}>
            x
          </button>
        </div>
      ))}
    </WorkspaceTabScroller>
  );
}

function tabRect(base: Record<string, number>): DOMRect {
  return {
    x: base.left ?? 0,
    y: base.top ?? 0,
    left: base.left ?? 0,
    right: base.right ?? 0,
    top: base.top ?? 0,
    bottom: base.bottom ?? 0,
    width: base.width ?? 0,
    height: base.height ?? 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/// jsdom reports zero boxes, so each strip element gets the box the layout
/// would give it: a 700px strip of four even 175px tabs.
function stubStripGeometry(container: HTMLElement) {
  const content = container.querySelector<HTMLElement>(".session-tab-content")!;
  content.getBoundingClientRect = () =>
    tabRect({ ...STRIP, width: STRIP.right - STRIP.left, height: 34 });
  const wraps = [...content.querySelectorAll<HTMLElement>(":scope > .session-tab-wrap")];
  wraps.forEach((wrap, index) => {
    wrap.getBoundingClientRect = () =>
      tabRect({
        left: index * TAB_WIDTH,
        right: (index + 1) * TAB_WIDTH,
        width: TAB_WIDTH,
        height: 34,
        top: 0,
        bottom: 34,
      });
  });
}

/// The repo's pointer pattern: a MouseEvent carrying pointer properties, as
/// the ResizeDivider schedule tests use.
function pointer(node: Element, type: string, x: number, y = 17) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  return fireEvent(node, event);
}

function mainButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".session-tab-main")).find(
    (button) => button.textContent === label,
  )!;
}

function isShifted(container: HTMLElement, label: string) {
  const wrap = Array.from(container.querySelectorAll<HTMLElement>(".session-tab-wrap")).find(
    (wrap) => wrap.querySelector(".session-tab-main")?.textContent === label,
  )!;
  return wrap.className.includes("session-tab-shifted");
}

describe("WorkspaceTabScroller reordering", () => {
  let frame!: FrameRequestCallback;
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drags a tab onto an earlier slot and lifts and displaces it", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    pointer(third, "pointerdown", 360);
    // Two pixels of settle are still a click, not a drag.
    pointer(third, "pointermove", 358);
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    pointer(third, "pointermove", 40);
    const dragged = container.querySelector<HTMLElement>(".session-tab-dragged");
    expect(dragged).toBeTruthy();
    expect(dragged!.querySelector(".session-tab-main")!.textContent).toBe("C");
    // A and B slide one slot right toward the first slot.
    expect(isShifted(container, "A")).toBe(true);
    expect(isShifted(container, "B")).toBe(true);
    expect(isShifted(container, "D")).toBe(false);

    pointer(third, "pointerup", 40);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("id-3", 0);
    expect(container.querySelector(".session-tab-dragged")).toBeNull();
  });

  it("drags a tab onto a later slot", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const first = mainButton(container, "A");

    pointer(first, "pointerdown", 60);
    pointer(first, "pointermove", 640);
    // One more rAF-scheduled move so the rendered position follows the pointer.
    pointer(first, "pointermove", 641);
    act(() => frame(0));
    expect(container.querySelector<HTMLElement>(".session-tab-dragged")!).toBeTruthy();
    pointer(first, "pointerup", 641);
    // The tab center at 641 lands on the last of the four slots.
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("id-1", 3);
  });

  it("pages an overflowing strip open at the drag edge and reveals the next tab", () => {
    vi.useFakeTimers();
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rectSpy.mockImplementation(function (this: HTMLElement) {
      const index = this.parentElement ? Array.from(this.parentElement.children).indexOf(this) : -1;
      if (this.classList.contains("session-tab-scroll-region"))
        return tabRect({ left: 0, right: 384, width: 384, top: 0, bottom: 34, height: 34 });
      if (this.classList.contains("session-tab-content"))
        return tabRect({ left: 0, right: 300, width: 300, top: 0, bottom: 34, height: 34 });
      if (this.classList.contains("session-tab-wrap") && index >= 0)
        return tabRect({
          left: index * 196,
          right: (index + 1) * 196,
          width: 196,
          top: 0,
          bottom: 34,
          height: 34,
        });
      return tabRect({});
    });
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    const wrapsMounted = () =>
      container.querySelectorAll(".session-tab-wrap .session-tab-main").length;
    // The window holds a single complete tab.
    expect(wrapsMounted()).toBe(1);

    const first = mainButton(container, "A");
    pointer(first, "pointerdown", 60);
    pointer(first, "pointermove", 280);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(wrapsMounted()).toBe(2);
    pointer(first, "pointerup", 280);
    expect(onReorder).toHaveBeenCalledWith("id-1", 1);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it("treats a below-threshold press as a plain click, without reordering", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 362, 18);
    pointer(third, "pointerup", 362, 18);
    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".session-tab-dragged")).toBeNull();
  });

  it("leaves the order unchanged when the tab drops outside the strip", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 40);
    pointer(third, "pointerup", 40, 200);
    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".session-tab-dragged")).toBeNull();
  });

  it("cancels the drag on Escape and keeps the strip as it was", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 40);
    expect(container.querySelector(".session-tab-dragged")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    pointer(third, "pointerup", 40);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("moves a focused tab with Ctrl+Shift+arrow keys and clamps at the ends", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    const second = mainButton(container, "B");

    fireEvent.keyDown(second, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenCalledWith("id-2", 0);
    fireEvent.keyDown(second, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenCalledWith("id-2", 2);

    const first = mainButton(container, "A");
    fireEvent.keyDown(first, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    const last = mainButton(container, "D");
    fireEvent.keyDown(last, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
    // Both ends refuse to reorder past the strip.
    expect(onReorder).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(first, { key: "ArrowRight" });
    fireEvent.keyDown(first, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(first, { key: "ArrowRight", shiftKey: true });
    expect(onReorder).toHaveBeenCalledTimes(2);
  });

  it("starts drags only on the main tab button of a reorderable strip", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const closeButtons = container.querySelectorAll<HTMLButtonElement>(".session-tab-close");
    act(() => closeButtons[2]!.focus());
    pointer(closeButtons[2]!, "pointerdown", 360);
    pointer(closeButtons[2]!, "pointermove", 40);
    pointer(closeButtons[2]!, "pointerup", 40);
    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    // Without a handler the strip stays a plain windowed list.
    const plain = render(<Strip labels={["A", "B", "C", "D"]} />);
    expect(
      plain.container
        .querySelector(".session-tab-scroll-region")!
        .classList.contains("can-reorder"),
    ).toBe(false);
    const plainTab = mainButton(plain.container, "C");
    pointer(plainTab, "pointerdown", 360);
    pointer(plainTab, "pointermove", 40);
    pointer(plainTab, "pointerup", 40);
    expect(plain.container.querySelector(".session-tab-dragged")).toBeNull();
  });
});
