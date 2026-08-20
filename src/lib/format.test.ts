import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionTarget, decodeBase64Utf8, relativeTime, timestampFromEpoch } from "./format";

describe("connectionTarget", () => {
  it("formats OpenSSH defaults without inventing overrides", () => {
    expect(connectionTarget({ destination: "debian-laptop", username: null, port: null })).toBe(
      "debian-laptop",
    );
  });

  it("includes explicit user and port overrides", () => {
    expect(connectionTarget({ destination: "192.168.100.100", username: "younes", port: 22 })).toBe(
      "younes@192.168.100.100:22",
    );
  });
});

describe("history metadata formatting", () => {
  afterEach(() => vi.useRealTimers());

  it("decodes UTF-8 OSC payloads", () => {
    expect(decodeBase64Utf8("cHJpbnRmICfYp9mE2LPZhNin2YUg2LnZhNmK2YPZhSc=")).toBe(
      "printf 'السلام عليكم'",
    );
  });

  it("turns epoch milliseconds into an ISO timestamp", () => {
    expect(timestampFromEpoch("1704067200000")).toBe("2024-01-01T00:00:00.000Z");
  });

  it("falls back safely when shell metadata has an invalid timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    expect(timestampFromEpoch("not-a-number")).toBe("2026-08-20T12:00:00.000Z");
  });
});

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  it("formats recent timestamps and handles an absent value", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    expect(relativeTime(null)).toBe("Never");
    expect(relativeTime("2026-08-20T11:55:00.000Z")).toBe("5 minutes ago");
  });
});
