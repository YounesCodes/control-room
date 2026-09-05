import { describe, expect, it } from "vitest";
import {
  BoundedByteQueue,
  isControlRoomShortcut,
  isWorkspaceShortcutBlocked,
  MAX_PENDING_TERMINAL_INPUT_BYTES,
  terminalRightClickAction,
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

describe("isControlRoomShortcut", () => {
  const event = (key: string, shiftKey: boolean, type = "keydown") => ({
    type,
    key,
    ctrlKey: true,
    shiftKey,
  });

  it.each([event("T", true), event("w", true), event("r", true), event("P", true)])(
    "keeps app shortcuts out of the remote terminal",
    (keyboardEvent) => {
      expect(isControlRoomShortcut(keyboardEvent)).toBe(true);
    },
  );

  it("leaves terminal copy, paste, F11, new-terminal, and ordinary keys alone", () => {
    expect(isControlRoomShortcut(event("c", true))).toBe(false);
    expect(isControlRoomShortcut(event("v", true))).toBe(false);
    expect(isControlRoomShortcut(event("n", true))).toBe(false);
    expect(isControlRoomShortcut(event("k", false))).toBe(false);
    expect(isControlRoomShortcut(event("k", false, "keyup"))).toBe(false);
    expect(
      isControlRoomShortcut({ type: "keydown", key: "F11", ctrlKey: false, shiftKey: false }),
    ).toBe(false);
    expect(
      isControlRoomShortcut({ type: "keydown", key: "t", ctrlKey: false, shiftKey: true }),
    ).toBe(false);
  });
});

describe("isWorkspaceShortcutBlocked", () => {
  function target(matches: string[]) {
    return {
      closest: (selector: string) => matches.some((value) => selector.includes(value)),
    } as unknown as EventTarget;
  }

  it("blocks shortcuts in application forms and dialogs", () => {
    expect(isWorkspaceShortcutBlocked(target(["input"]), false)).toBe(true);
    expect(isWorkspaceShortcutBlocked(target(["[role='dialog']"]), false)).toBe(true);
    expect(isWorkspaceShortcutBlocked(null, true)).toBe(true);
  });

  it("keeps shortcuts available inside xterm and ordinary application controls", () => {
    expect(isWorkspaceShortcutBlocked(target([".xterm", "textarea"]), false)).toBe(false);
    expect(isWorkspaceShortcutBlocked(target([]), false)).toBe(false);
  });
});

describe("terminalRightClickAction", () => {
  const click = (overrides: Partial<Parameters<typeof terminalRightClickAction>[0]> = {}) => ({
    button: 2,
    hasSelection: false,
    mouseTrackingMode: "none",
    ...overrides,
  });

  it("copies whenever there is a selection", () => {
    expect(terminalRightClickAction(click({ hasSelection: true }))).toBe("copy");
  });

  it("pastes at an ordinary prompt", () => {
    expect(terminalRightClickAction(click())).toBe("paste");
  });

  it("hands the click to a program that reads the mouse", () => {
    for (const mode of ["x10", "vt200", "drag", "any"]) {
      expect(terminalRightClickAction(click({ mouseTrackingMode: mode }))).toBe("terminal");
    }
  });

  it("keeps a selection even while a program reads the mouse", () => {
    // The user has already said which text they mean, and a program reading the
    // mouse never asked for that selection to be dropped.
    expect(terminalRightClickAction(click({ hasSelection: true, mouseTrackingMode: "any" }))).toBe(
      "copy",
    );
  });

  it("ignores anything that is not a right button", () => {
    // The context-menu key raises the same event with no button behind it.
    // Claiming it would take away a keyboard route to the menu.
    expect(terminalRightClickAction(click({ button: 0 }))).toBe("ignore");
    expect(terminalRightClickAction(click({ button: 1 }))).toBe("ignore");
    expect(terminalRightClickAction(click({ button: 0, hasSelection: true }))).toBe("ignore");
  });

  it("says nothing about the webview menu", () => {
    // Suppressing that menu is decided at the event, for every pointer right
    // click. Deriving it from this result is what let the menu appear whenever
    // Control Room declined the gesture.
    const results = [
      terminalRightClickAction(click({ hasSelection: true })),
      terminalRightClickAction(click()),
      terminalRightClickAction(click({ mouseTrackingMode: "any" })),
    ];
    expect(results).toEqual(["copy", "paste", "terminal"]);
  });
});
