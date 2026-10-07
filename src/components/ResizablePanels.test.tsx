// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeDivider } from "./ResizablePanels";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("divider pointer scheduling", () => {
  it("renders at most once per animation frame and flushes the last move on release", () => {
    let frame!: FrameRequestCallback;
    const request = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onChange = vi.fn();
    const view = render(
      <ResizeDivider
        label="Resize test"
        value={300}
        min={200}
        max={480}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );
    const node = screen.getByRole("separator");
    node.setPointerCapture = vi.fn();
    node.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
      fireEvent(node, event);
    };
    pointer("pointerdown", 10);
    pointer("pointermove", 20);
    pointer("pointermove", 30);
    pointer("pointermove", 40);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    act(() => frame(0));
    expect(onChange).toHaveBeenLastCalledWith(330);
    view.rerender(
      <ResizeDivider
        label="Resize test"
        value={330}
        min={200}
        max={335}
        onChange={onChange}
        onReset={vi.fn()}
      />,
    );
    pointer("pointermove", 100);
    pointer("pointerup", 100);
    expect(onChange).toHaveBeenLastCalledWith(335);
  });
});
