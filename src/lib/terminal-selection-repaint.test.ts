import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { deferHiddenSelectionRepaint } from "./terminal-selection-repaint";

function terminalWith(renderService: unknown) {
  return { _core: { _renderService: renderService } } as unknown as Terminal;
}

describe("deferHiddenSelectionRepaint", () => {
  it("passes a visible terminal's repaints straight through", () => {
    const repaint = vi.fn();
    const service = { handleSelectionChanged: repaint };
    deferHiddenSelectionRepaint(terminalWith(service), () => true);

    service.handleSelectionChanged([0, 1], [4, 1], false);

    expect(repaint).toHaveBeenCalledExactlyOnceWith([0, 1], [4, 1], false);
    expect(repaint.mock.contexts[0]).toBe(service);
  });

  it("holds repaints while hidden and applies only the newest once shown", () => {
    const repaint = vi.fn();
    const service = { handleSelectionChanged: repaint };
    let visible = false;
    const held = deferHiddenSelectionRepaint(terminalWith(service), () => visible);

    service.handleSelectionChanged(undefined, undefined, false);
    service.handleSelectionChanged([0, 2], [8, 2], true);
    expect(repaint).not.toHaveBeenCalled();

    visible = true;
    held.flush();
    expect(repaint).toHaveBeenCalledExactlyOnceWith([0, 2], [8, 2], true);

    held.flush();
    expect(repaint).toHaveBeenCalledOnce();
  });

  it("drops a held repaint that a visible one has replaced", () => {
    const repaint = vi.fn();
    const service = { handleSelectionChanged: repaint };
    let visible = false;
    const held = deferHiddenSelectionRepaint(terminalWith(service), () => visible);

    service.handleSelectionChanged([0, 0], [2, 0], false);
    visible = true;
    service.handleSelectionChanged(undefined, undefined, false);
    held.flush();

    expect(repaint).toHaveBeenCalledExactlyOnceWith(undefined, undefined, false);
  });

  it.each([{}, { _core: {} }, { _core: { _renderService: {} } }])(
    "leaves a terminal without the expected render service alone",
    (terminal) => {
      expect(() =>
        deferHiddenSelectionRepaint(terminal as unknown as Terminal, () => false).flush(),
      ).not.toThrow();
    },
  );
});
