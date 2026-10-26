// @vitest-environment jsdom

import { act, render, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POPOVER_EXIT_MS, usePopoverExit } from "./use-popover-exit";

function Probe({ open, onState }: { open: boolean; onState: (state: string) => void }) {
  const { present, closing } = usePopoverExit(open);
  useEffect(() => {
    onState(`${present ? "present" : "gone"}${closing ? " closing" : ""}`);
  });
  return null;
}

describe("usePopoverExit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
  });

  it("stays present while open and reports no closing state", () => {
    const states: string[] = [];
    render(<Probe open onState={(state) => states.push(state)} />);
    expect(states.at(-1)).toBe("present");
  });

  it("keeps the popover mounted for the exit animation, then unmounts", () => {
    const states: string[] = [];
    const view = render(<Probe open onState={(state) => states.push(state)} />);
    view.rerender(<Probe open={false} onState={(state) => states.push(state)} />);
    // The exit beat: still mounted, flagged closing so the stylesheet can
    // play popover-out and drop pointer events.
    expect(states.at(-1)).toBe("present closing");
    act(() => {
      vi.advanceTimersByTime(POPOVER_EXIT_MS - 1);
    });
    expect(states.at(-1)).toBe("present closing");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(states.at(-1)).toBe("gone");
  });

  it("reopens immediately without dropping the element or lingering closing", () => {
    const states: string[] = [];
    const view = render(<Probe open onState={(state) => states.push(state)} />);
    view.rerender(<Probe open={false} onState={(state) => states.push(state)} />);
    expect(states.at(-1)).toBe("present closing");
    view.rerender(<Probe open onState={(state) => states.push(state)} />);
    expect(states.at(-1)).toBe("present");
    act(() => {
      vi.advanceTimersByTime(POPOVER_EXIT_MS * 2);
    });
    expect(states.at(-1)).toBe("present");
  });

  it("exposes the exit length as a plain hook value", () => {
    const { result } = renderHook(() => usePopoverExit(true));
    expect(result.current.closing).toBe(false);
    expect(POPOVER_EXIT_MS).toBeGreaterThan(0);
  });

  it("removes the closing frame immediately when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    try {
      const { result, rerender } = renderHook(({ open }) => usePopoverExit(open), {
        initialProps: { open: true },
      });
      rerender({ open: false });
      act(() => vi.advanceTimersByTime(0));
      expect(result.current.present).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
