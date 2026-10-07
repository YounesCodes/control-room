import { describe, expect, it } from "vitest";
import { sanitize } from "./sanitize-e2e-results.mjs";
describe("desktop diagnostic redaction", () => {
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
