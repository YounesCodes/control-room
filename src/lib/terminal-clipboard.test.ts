import { describe, expect, it, vi } from "vitest";
import { readTerminalPaste } from "./terminal-clipboard";

function blob(bytes: number[]) {
  return {
    arrayBuffer: vi.fn(async () => new Uint8Array(bytes).buffer),
  };
}

function item(types: string[], data: Map<string, number[]>) {
  return {
    types,
    getType: vi.fn(async (type: string) => {
      if (!data.has(type)) throw new Error("representation is missing");
      return blob(data.get(type)!);
    }),
  };
}

describe("readTerminalPaste", () => {
  it("prefers text whenever the clipboard has any", async () => {
    const clipboard = {
      readText: vi.fn(async () => "echo hello"),
      read: vi.fn(async () => []),
    };
    const stage = vi.fn();
    await expect(readTerminalPaste(clipboard, stage)).resolves.toEqual({
      kind: "text",
      text: "echo hello",
    });
    expect(stage).not.toHaveBeenCalled();
  });

  it("ignores NUL-only text and moves on to images", async () => {
    const clipboard = {
      readText: vi.fn(async () => "\0\0"),
      read: vi.fn(async () => [item(["image/png"], new Map([["image/png", [1, 2, 3]]]))]),
    };
    const stage = vi.fn(async () => "/tmp/control-room-paste/paste-1.png");
    await expect(readTerminalPaste(clipboard, stage)).resolves.toEqual({
      kind: "image",
      path: "/tmp/control-room-paste/paste-1.png",
    });
    expect(stage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "png");
  });

  it("stages the preferred image type and maps its extension", async () => {
    const clipboard = {
      readText: vi.fn(async () => ""),
      read: vi.fn(async () => [
        item(["image/webp", "image/jpeg"], new Map([["image/jpeg", [9, 9]]])),
      ]),
    };
    const stage = vi.fn(async () => "/tmp/control-room-paste/paste-2.jpg");
    await expect(readTerminalPaste(clipboard, stage)).resolves.toEqual({
      kind: "image",
      path: "/tmp/control-room-paste/paste-2.jpg",
    });
    expect(stage).toHaveBeenCalledWith(new Uint8Array([9, 9]), "jpg");
  });

  it("tries the next representation when one fails to produce bytes", async () => {
    const clipboard = {
      readText: vi.fn(async () => ""),
      read: vi.fn(async () => [
        item(["image/png"], new Map()),
        item(["image/gif"], new Map([["image/gif", [7, 7, 7]]])),
      ]),
    };
    const stage = vi.fn(async () => "/tmp/control-room-paste/paste-3.gif");
    await expect(readTerminalPaste(clipboard, stage)).resolves.toEqual({
      kind: "image",
      path: "/tmp/control-room-paste/paste-3.gif",
    });
    expect(stage).toHaveBeenCalledWith(new Uint8Array([7, 7, 7]), "gif");
  });

  it("reports an empty clipboard when nothing is available", async () => {
    const clipboard = {
      readText: vi.fn(async () => ""),
      read: vi.fn(async () => [item(["text/plain"], new Map([["text/plain", [1]]]))]),
    };
    await expect(readTerminalPaste(clipboard, vi.fn())).resolves.toEqual({ kind: "empty" });
  });

  it("reports an empty clipboard when reading images is unavailable", async () => {
    const clipboard = { readText: vi.fn(async () => "") };
    await expect(readTerminalPaste(clipboard, vi.fn())).resolves.toEqual({ kind: "empty" });
  });

  it("skips a type that is not an image", async () => {
    const clipboard = {
      readText: vi.fn(async () => ""),
      read: vi.fn(async () => [
        item(["text/html"], new Map([["text/html", [1]]])),
        item(["image/svg+xml"], new Map([["image/svg+xml", [2]]])),
        item(["image/png"], new Map([["image/png", [3]]])),
      ]),
    };
    const stage = vi.fn(async () => "C:/staged.png");
    await expect(readTerminalPaste(clipboard, stage)).resolves.toEqual({
      kind: "image",
      path: "C:/staged.png",
    });
    expect(stage).toHaveBeenCalledWith(new Uint8Array([3]), "png");
  });

  it("does not stage an image whose bytes are empty", async () => {
    const clipboard = {
      readText: vi.fn(async () => ""),
      read: vi.fn(async () => [item(["image/png"], new Map([["image/png", []]]))]),
    };
    await expect(readTerminalPaste(clipboard, vi.fn())).resolves.toEqual({ kind: "empty" });
  });
});
