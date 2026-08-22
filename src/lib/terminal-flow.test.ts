import { describe, expect, it } from "vitest";
import {
  BoundedByteQueue,
  isControlRoomShortcut,
  MAX_PENDING_TERMINAL_INPUT_BYTES,
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

  it.each([event("k", false), event("T", true), event("w", true), event("r", true)])(
    "keeps app shortcuts out of the remote terminal",
    (keyboardEvent) => {
      expect(isControlRoomShortcut(keyboardEvent)).toBe(true);
    },
  );

  it("leaves terminal copy, paste, and ordinary keys alone", () => {
    expect(isControlRoomShortcut(event("c", true))).toBe(false);
    expect(isControlRoomShortcut(event("v", true))).toBe(false);
    expect(isControlRoomShortcut(event("k", false, "keyup"))).toBe(false);
    expect(
      isControlRoomShortcut({ type: "keydown", key: "t", ctrlKey: false, shiftKey: true }),
    ).toBe(false);
  });
});
