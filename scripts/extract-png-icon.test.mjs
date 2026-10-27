import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPngIcon } from "./extract-png-icon.mjs";

describe("Linux build icon", () => {
  it("extracts the existing RGBA PNG without an image-conversion package", () => {
    const png = extractPngIcon(readFileSync("src-tauri/icons/icon.ico"));
    expect(png.subarray(12, 16).toString()).toBe("IHDR");
    expect(png[25]).toBe(6); // PNG RGBA, as required by Tauri.
    expect(png.readUInt32BE(16)).toBeGreaterThan(0);
    expect(png.readUInt32BE(20)).toBeGreaterThan(0);
  });
  it("rejects truncated directories and out-of-bounds entries", () => {
    const icon = readFileSync("src-tauri/icons/icon.ico");
    expect(() => extractPngIcon(icon.subarray(0, 5))).toThrow(/header/);
    expect(() => extractPngIcon(icon.subarray(0, 7))).toThrow(/directory/);
    icon.writeUInt32LE(icon.length + 1, 18);
    expect(() => extractPngIcon(icon)).toThrow(/bounds/);
  });
});
