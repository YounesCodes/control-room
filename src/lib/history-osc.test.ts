import { describe, expect, it } from "vitest";
import { isControlRoomConnectedOsc, parseHistoryOsc } from "./history-osc";

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

  it("reads an exit status as the decimal number bash reports and nothing else", () => {
    const finish = (status: string) =>
      parseHistoryOsc(`ControlRoom;finish;1704067201000;${status};`);

    for (const [status, expected] of [
      ["0", 0],
      ["1", 1],
      ["2", 2],
      ["126", 126],
      ["127", 127],
      ["130", 130],
      ["255", 255],
      ["2147483647", 2_147_483_647],
    ] as const) {
      expect(finish(status), status).toMatchObject({ kind: "finish", exitCode: expected });
    }

    for (const rejected of [
      "",
      " ",
      "0x10",
      "0b11",
      "0o17",
      "1e3",
      " 1",
      "1 ",
      "+1",
      "-1",
      "1.0",
      "NaN",
      "Infinity",
      "1_000",
      "١",
      "2147483648",
      "99999999999",
    ]) {
      expect(finish(rejected), `${rejected} is not an exit status`).toBeNull();
    }
  });

  it("drops a finish whose other fields are malformed", () => {
    expect(parseHistoryOsc("ControlRoom;finish;1704067201000;0;L3RtcA==")).toMatchObject({
      kind: "finish",
    });

    for (const malformed of [
      "ControlRoom;finish;;0;L3RtcA==",
      "ControlRoom;finish;-1704067201000;0;L3RtcA==",
      "ControlRoom;finish;1704067201000.5;0;L3RtcA==",
      "ControlRoom;finish;99999999999999999999;0;L3RtcA==",
      "ControlRoom;finish;1704067201000;0",
      "ControlRoom;finish;1704067201000;0;L3RtcA==;extra",
      "finish;1704067201000;0;L3RtcA==",
    ]) {
      expect(parseHistoryOsc(malformed), malformed).toBeNull();
    }
  });

  it("holds a start to its own bounds", () => {
    const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    const start = (cwd: string, command: string) =>
      parseHistoryOsc(`ControlRoom;start;1704067200000;${encode(cwd)};${encode(command)}`);

    expect(start("/srv", "ls -la")).toMatchObject({ command: "ls -la", cwd: "/srv" });
    expect(start("", "ls")).toMatchObject({ cwd: null });
    for (const blank of ["", " ", "\t", "\n", "   \n  "]) {
      expect(start("/srv", blank), JSON.stringify(blank)).toBeNull();
    }

    expect(start("/srv/données", "echo 'héllo → 🙂'")).toMatchObject({
      cwd: "/srv/données",
      command: "echo 'héllo → 🙂'",
    });

    expect(start("é".repeat(16_383), "ls")).toMatchObject({ command: "ls" });
    expect(start("é".repeat(16_384), "ls")).toBeNull();

    expect(parseHistoryOsc("ControlRoom;start;1704067200000;;!!!not-base64!!!")).toBeNull();
  });

  it("ignores sequences that only look like Control Room's", () => {
    for (const foreign of [
      "vscode;start;1704067200000;;bHM=",
      "ControlRoomX;start;1704067200000;;bHM=",
      "controlroom;start;1704067200000;;bHM=",
      " ControlRoom;start;1704067200000;;bHM=",
      "ControlRoom;started;1704067200000;;bHM=",
      "ControlRoom;connected",
      "ControlRoom",
      "",
    ]) {
      expect(parseHistoryOsc(foreign), foreign).toBeNull();
    }
  });
});

describe("isControlRoomConnectedOsc", () => {
  it("recognizes only the fixed authenticated-session marker", () => {
    expect(isControlRoomConnectedOsc("ControlRoom;connected")).toBe(true);
    expect(isControlRoomConnectedOsc("ControlRoom;connected;extra")).toBe(false);
  });
});
