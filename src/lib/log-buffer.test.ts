import { describe, expect, it } from "vitest";
import { BoundedLogBuffer, logRenderDelay } from "./log-buffer";

describe("BoundedLogBuffer", () => {
  it("keeps the newest lines", () => {
    const buffer = new BoundedLogBuffer(3, 1_000);
    buffer.append("one\ntwo\nthree\nfour\n");
    expect(buffer.snapshot()).toBe("two\nthree\nfour\n");
    expect(buffer.lineCount).toBe(3);
  });

  it("keeps partial lines across chunks", () => {
    const buffer = new BoundedLogBuffer(10, 1_000);
    buffer.append("partial");
    buffer.append(" line\nnext");
    expect(buffer.snapshot()).toBe("partial line\nnext");
  });

  it("caps utf8 data by bytes", () => {
    const buffer = new BoundedLogBuffer(100, 12);
    buffer.append("éééééééééé");
    expect(buffer.byteCount).toBeLessThanOrEqual(12);
    expect(buffer.snapshot()).toBe("éééééé");
  });

  it("stays bounded during a fifteen mibibyte stream", () => {
    const maxBytes = 5 * 1024 * 1024;
    const buffer = new BoundedLogBuffer(10_000, maxBytes);
    const chunk = `${"x".repeat(16 * 1024 - 2)}\n`;
    for (let bytes = 0; bytes < 15 * 1024 * 1024; bytes += chunk.length) buffer.append(chunk);
    expect(buffer.byteCount).toBeLessThanOrEqual(maxBytes);
    expect(buffer.lineCount).toBeLessThanOrEqual(10_000);
    expect(buffer.snapshot().endsWith(chunk)).toBe(true);
  });

  it("trims a large Unicode line without splitting a surrogate pair", () => {
    const buffer = new BoundedLogBuffer(100, 5 * 1024 * 1024);
    buffer.append("😀".repeat(2 * 1024 * 1024));
    expect(buffer.snapshot()).toBe("😀".repeat((5 * 1024 * 1024) / 4));
    expect(buffer.byteCount).toBe(5 * 1024 * 1024);
  });

  it("drops a code point that cannot fit instead of retaining half of it", () => {
    const buffer = new BoundedLogBuffer(100, 3);
    buffer.append("abcd😀");
    expect(buffer.snapshot()).toBe("");
    expect(buffer.byteCount).toBe(0);
  });

  it("clears all retained data", () => {
    const buffer = new BoundedLogBuffer();
    buffer.append("old logs");
    buffer.clear();
    expect(buffer.snapshot()).toBe("");
    expect(buffer.byteCount).toBe(0);
  });
});

describe("logRenderDelay", () => {
  it("updates large log views less often", () => {
    expect(logRenderDelay(10_000)).toBe(80);
    expect(logRenderDelay(1024 * 1024)).toBe(250);
    expect(logRenderDelay(4 * 1024 * 1024)).toBe(500);
  });
});
