import { describe, expect, it } from "vitest";
import { parseHistoryOsc } from "./history-osc";

describe("parseHistoryOsc", () => {
  it("parses exact start and finish metadata", () => {
    expect(
      parseHistoryOsc("ControlRoom;start;1704067200000;L2hvbWUvdGVzdC11c2Vy;cHJpbnRmIG9r"),
    ).toEqual({
      kind: "start",
      startedAt: "2024-01-01T00:00:00.000Z",
      cwd: "/home/test-user",
      command: "printf ok",
    });
    expect(parseHistoryOsc("ControlRoom;finish;1704067201000;1;L3RtcA==")).toEqual({
      kind: "finish",
      finishedAt: "2024-01-01T00:00:01.000Z",
      exitCode: 1,
      cwd: "/tmp",
    });
  });

  it("rejects malformed, oversized, and non-finite metadata", () => {
    expect(parseHistoryOsc("ControlRoom;start;bad;;cHdk")).toBeNull();
    expect(parseHistoryOsc("ControlRoom;finish;1704067201000;NaN;L3RtcA==")).toBeNull();
    expect(parseHistoryOsc(`ControlRoom;start;1704067200000;;${"A".repeat(1_500_001)}`)).toBeNull();
  });
});
