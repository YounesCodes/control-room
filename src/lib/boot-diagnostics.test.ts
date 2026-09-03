import { describe, expect, it } from "vitest";

import { bootLabel, durationToMillis, sampleHint, splitJournalLine } from "./boot-diagnostics";
import type { BootRecord } from "../types";

function boot(overrides: Partial<BootRecord> = {}): BootRecord {
  return { index: 0, id: "a".repeat(32), range: "Sun 2026-08-31", current: true, ...overrides };
}

describe("durationToMillis", () => {
  it("reads the duration shapes systemd-analyze actually prints", () => {
    expect(durationToMillis("4.523s")).toBeCloseTo(4523);
    expect(durationToMillis("532ms")).toBe(532);
    expect(durationToMillis("1min 2.345s")).toBeCloseTo(62345);
    expect(durationToMillis("1h 2min 3.456s")).toBeCloseTo(3_723_456);
  });

  it("does not read min as ms", () => {
    expect(durationToMillis("2min")).toBe(120_000);
    expect(durationToMillis("2ms")).toBe(2);
  });

  it("returns null rather than a guess when nothing parses", () => {
    expect(durationToMillis("")).toBeNull();
    expect(durationToMillis("n/a")).toBeNull();
  });

  // Sorted as text, "532ms" beats "1min 2s" and the longest unit draws the
  // shortest bar. The bars only mean anything if the magnitudes are compared.
  it("ranks by magnitude rather than by string order", () => {
    const rows = ["532ms", "1min 2s", "4.523s"];
    const byText = [...rows].sort();
    const byLength = [...rows].sort(
      (left, right) => durationToMillis(left)! - durationToMillis(right)!,
    );
    expect(byLength).toEqual(["532ms", "4.523s", "1min 2s"]);
    expect(byText).not.toEqual(byLength);
  });
});

describe("bootLabel", () => {
  it("names the running boot and counts backwards from it", () => {
    expect(bootLabel(boot())).toBe("Current boot");
    expect(bootLabel(boot({ index: -1, current: false }))).toBe("1 boot ago");
    expect(bootLabel(boot({ index: -3, current: false }))).toBe("3 boots ago");
  });
});

describe("splitJournalLine", () => {
  it("lifts the iso timestamp out and keeps the message", () => {
    const line = splitJournalLine(
      "2026-08-31T12:00:00.123456+0200 host unit[12]: something went wrong",
    );
    expect(line.time).toBe("12:00:00");
    expect(line.message).toBe("host unit[12]: something went wrong");
  });

  it("keeps a line without a timestamp whole", () => {
    const line = splitJournalLine("warning: bounded evidence");
    expect(line.time).toBeNull();
    expect(line.message).toBe("warning: bounded evidence");
  });
});

describe("sampleHint", () => {
  it("separates a sample that hit its cap from one that ran out", () => {
    expect(sampleHint(30, 30)).toContain("cap");
    expect(sampleHint(4, 30)).not.toContain("cap");
    expect(sampleHint(0, 30)).toBe("none returned");
  });
});
