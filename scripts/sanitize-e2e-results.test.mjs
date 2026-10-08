import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitize, sanitizeDirectory } from "./sanitize-e2e-results.mjs";
describe("desktop diagnostic redaction", () => {
  it("redacts case variants, JSON-escaped paths, API keys, bearer tokens and private key blocks", () => {
    const path = "C:\\Users\\a.b";
    const result = sanitize(
      "c:\\users\\A.B " +
        JSON.stringify({ path }) +
        " api_key=one passwd=two AWS_SECRET_ACCESS_KEY=three Bearer abc.def -----BEGIN PRIVATE KEY-----\nprivate-data\n-----END PRIVATE KEY-----",
      { USERPROFILE: path },
    );
    for (const secret of ["a.b", "A.B", "one", "two", "three", "abc.def", "private-data"])
      expect(result).not.toContain(secret);
  });
  it("copies sanitized text only and blocks incomplete sanitization", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-room-redaction-"));
    const source = join(directory, "raw");
    const output = join(directory, "safe");
    mkdirSync(source);
    try {
      writeFileSync(join(source, "state.txt"), "password=example");
      writeFileSync(join(source, "failure.png"), "private pixels");
      sanitizeDirectory(source, output);
      expect(readFileSync(join(output, "state.txt"), "utf8")).toBe("password=[redacted]");
      expect(existsSync(join(output, "failure.png"))).toBe(false);
      writeFileSync(join(source, "binary.log"), Buffer.from([0, 255]));
      expect(() => sanitizeDirectory(source, output)).toThrow(/could not all be sanitized/);
      expect(existsSync(join(output, "binary.log"))).toBe(false);
      writeFileSync(join(source, "large.txt"), "x".repeat(1024 * 1024 + 1));
      expect(() => sanitizeDirectory(source, output)).toThrow();
      expect(existsSync(join(output, "large.txt"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("identifies rejected diagnostics without exposing credentials or user paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "control-room-redaction-"));
    const source = join(directory, "raw");
    const output = join(directory, "safe");
    mkdirSync(source);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(source, "driver.log"), Buffer.from([0, 255]));
      expect(() => sanitizeDirectory(source, output)).toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("driver.log: Binary diagnostic"));
      expect(error.mock.calls.flat().join(" ")).not.toContain(directory);
    } finally {
      error.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("redacts configured identities literally, even when they contain regex characters", () => {
    expect(
      sanitize("C:\\Users\\a.b fixture.local user-name", {
        USERPROFILE: "C:\\Users\\a.b",
        CONTROL_ROOM_TEST_HOST: "fixture.local",
        CONTROL_ROOM_TEST_USER: "user-name",
      }),
    ).toBe("[redacted] [redacted] [redacted]");
  });
  it("masks credential assignments and keeps useful errors", () => {
    expect(sanitize("password=example token:abc; disk full", {})).toBe(
      "password=[redacted] token:[redacted]; disk full",
    );
  });
  it("redacts quoted driver arguments including spaces and escaped quotes while preserving JSON", () => {
    const input = JSON.stringify({ password: 'a secret with "quotes"', status: "disk full" });
    expect(JSON.parse(sanitize(input, {}))).toEqual({
      password: "[redacted]",
      status: "disk full",
    });
  });
});
