import { describe, expect, it } from "vitest";
import {
  BoundedByteQueue,
  MAX_PENDING_TERMINAL_INPUT_BYTES,
  pasteRunsLines,
  terminalRightClickAction,
  trimTrailingLineBreaks,
} from "./terminal-flow";

describe("BoundedByteQueue", () => {
  it("keeps connecting input within its byte limit", () => {
    const queue = new BoundedByteQueue(5);
    expect(queue.enqueue(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(queue.enqueue(new Uint8Array([4, 5]))).toBe(true);
    expect(queue.enqueue(new Uint8Array([6]))).toBe(false);
    expect(queue.byteCount).toBe(5);
  });

  it("drains input in order and resets the retained byte count", () => {
    const queue = new BoundedByteQueue();
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2, 3]);
    queue.enqueue(first);
    queue.enqueue(second);
    expect(queue.drain()).toEqual([first, second]);
    expect(queue.byteCount).toBe(0);
  });

  it("uses a bounded default", () => {
    const queue = new BoundedByteQueue();
    expect(queue.enqueue(new Uint8Array(MAX_PENDING_TERMINAL_INPUT_BYTES))).toBe(true);
    expect(queue.enqueue(new Uint8Array([1]))).toBe(false);
    queue.clear();
    expect(queue.byteCount).toBe(0);
  });
});

describe("terminalRightClickAction", () => {
  const click = (overrides: Partial<Parameters<typeof terminalRightClickAction>[0]> = {}) => ({
    button: 2,
    hasSelection: false,
    mouseTrackingMode: "none",
    isCodex: false,
    ...overrides,
  });

  it("copies whenever there is a selection", () => {
    expect(terminalRightClickAction(click({ hasSelection: true }))).toBe("copy");
  });

  it("pastes at an ordinary prompt", () => {
    expect(terminalRightClickAction(click())).toBe("paste");
  });

  it("pastes in Codex with no selection and copies when there is one", () => {
    const codex = { isCodex: true, mouseTrackingMode: "any" };
    expect(terminalRightClickAction(click(codex))).toBe("paste");
    expect(terminalRightClickAction(click({ ...codex, hasSelection: true }))).toBe("copy");
  });

  it("hands the click to a program that reads the mouse", () => {
    for (const mode of ["x10", "vt200", "drag", "any"]) {
      expect(terminalRightClickAction(click({ mouseTrackingMode: mode }))).toBe("terminal");
    }
  });

  it("keeps a selection even while a program reads the mouse", () => {
    expect(terminalRightClickAction(click({ hasSelection: true, mouseTrackingMode: "any" }))).toBe(
      "copy",
    );
  });

  it("ignores anything that is not a right button", () => {
    expect(terminalRightClickAction(click({ button: 0 }))).toBe("ignore");
    expect(terminalRightClickAction(click({ button: 1 }))).toBe("ignore");
    expect(terminalRightClickAction(click({ button: 0, hasSelection: true }))).toBe("ignore");
  });

  it("says nothing about the webview menu", () => {
    const results = [
      terminalRightClickAction(click({ hasSelection: true })),
      terminalRightClickAction(click()),
      terminalRightClickAction(click({ mouseTrackingMode: "any" })),
    ];
    expect(results).toEqual(["copy", "paste", "terminal"]);
  });
});

describe("pasted text", () => {
  it("drops trailing line breaks so a paste never ends with Enter", () => {
    expect(trimTrailingLineBreaks("ls -la\r\n\n")).toBe("ls -la");
    expect(trimTrailingLineBreaks("one\ntwo")).toBe("one\ntwo");
  });

  it("runs lines only when the shell has not enabled bracketed paste", () => {
    expect(pasteRunsLines("one\ntwo", false)).toBe(true);
    expect(pasteRunsLines("one\rtwo", false)).toBe(true);
    expect(pasteRunsLines("one\ntwo", true)).toBe(false);
    expect(pasteRunsLines("one", false)).toBe(false);
  });
});
