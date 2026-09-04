import { describe, expect, it } from "vitest";
import {
  BoundedByteQueue,
  isControlRoomShortcut,
  isWorkspaceShortcutBlocked,
  MAX_PENDING_TERMINAL_INPUT_BYTES,
  shouldPasteOnRightClick,
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

describe("shouldPasteOnRightClick", () => {
  const menu = (overrides: Partial<Parameters<typeof shouldPasteOnRightClick>[0]> = {}) => ({
    enabled: true,
    button: 2,
    mouseTrackingMode: "none",
    ...overrides,
  });

  it("pastes on a right click once the setting is on", () => {
    expect(shouldPasteOnRightClick(menu())).toBe(true);
  });

  it("stays off until the user turns it on", () => {
    expect(shouldPasteOnRightClick(menu({ enabled: false }))).toBe(false);
  });

  it("ignores a context menu that no right button opened", () => {
    // The menu key raises contextmenu with no button behind it, and reading that
    // as a paste would fire the gesture from the keyboard.
    expect(shouldPasteOnRightClick(menu({ button: 0 }))).toBe(false);
    expect(shouldPasteOnRightClick(menu({ button: 1 }))).toBe(false);
  });

  it("leaves the click to a remote program that reads the mouse", () => {
    expect(shouldPasteOnRightClick(menu({ mouseTrackingMode: "x10" }))).toBe(false);
    expect(shouldPasteOnRightClick(menu({ mouseTrackingMode: "vt200" }))).toBe(false);
    expect(shouldPasteOnRightClick(menu({ mouseTrackingMode: "drag" }))).toBe(false);
    expect(shouldPasteOnRightClick(menu({ mouseTrackingMode: "any" }))).toBe(false);
  });
});
