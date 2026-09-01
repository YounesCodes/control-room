import { describe, expect, it } from "vitest";
import {
  diffSummary,
  formatCollectedAt,
  formatDuration,
  rowDestination,
  rowStateLabel,
  sectionLabel,
  skewWarning,
  statusLabel,
  visibleRows,
} from "./host-diff";
import type {
  HostDiff,
  HostDiffRow,
  HostDiffSection,
  HostDiffSectionKind,
  HostStateStatus,
} from "../types";

function row(identity: string, state: HostDiffRow["state"]): HostDiffRow {
  return {
    identity,
    label: identity,
    state,
    facts: [
      { name: "activeState", leftValue: "active", rightValue: "failed", equal: state !== "equal" },
      { name: "loadState", leftValue: "loaded", rightValue: "loaded", equal: true },
    ],
  };
}

function section(
  kind: HostDiffSectionKind,
  overrides: Partial<HostDiffSection> = {},
): HostDiffSection {
  return {
    kind,
    leftStatus: "collected",
    rightStatus: "collected",
    comparable: true,
    note: null,
    rows: [],
    equalCount: 0,
    differentCount: 0,
    ...overrides,
  };
}

function diff(sections: HostDiffSection[], skew: number | null = 3): HostDiff {
  return {
    left: {
      connectionId: "a",
      connectionName: "web-01",
      collectedAt: "2026-09-01T10:00:00Z",
    },
    right: {
      connectionId: "b",
      connectionName: "web-02",
      collectedAt: "2026-09-01T10:00:03Z",
    },
    collectionSkewSeconds: skew,
    sections,
  };
}

describe("labels", () => {
  it("names sections, statuses, and row states in plain words", () => {
    expect(sectionLabel("systemdUnits")).toBe("Systemd units");
    expect(sectionLabel("listeners")).toBe("Listening sockets");
    expect(statusLabel("notCollected")).toBe("Not collected");
    expect(statusLabel("unsupported")).toBe("Not present");
    expect(statusLabel("unavailable")).toBe("Not readable");
    expect(rowStateLabel("leftOnly")).toBe("Left only");
    expect(rowStateLabel("equal")).toBe("Same");
  });
});

describe("difference filter", () => {
  it("hides equal rows only when asked", () => {
    const filled = section("systemdUnits", {
      rows: [row("ssh.service", "equal"), row("nginx.service", "different")],
    });
    expect(visibleRows(filled, true).map((item) => item.identity)).toEqual(["nginx.service"]);
    expect(visibleRows(filled, false)).toHaveLength(2);
  });
});

describe("summary", () => {
  it("counts differences across comparable sections", () => {
    expect(diffSummary(diff([section("systemdUnits", { differentCount: 1, equalCount: 9 })]))).toBe(
      "1 difference",
    );
    expect(
      diffSummary(
        diff([
          section("systemdUnits", { differentCount: 2 }),
          section("listeners", { differentCount: 1 }),
        ]),
      ),
    ).toBe("3 differences");
  });

  it("never counts a section it could not compare as agreement", () => {
    const result = diffSummary(
      diff([
        section("containers", { comparable: false, rightStatus: "unsupported" }),
        section("systemdUnits", { equalCount: 40 }),
      ]),
    );
    expect(result).toBe("0 differences, 1 section could not be compared");
  });

  it("pluralizes skipped sections", () => {
    expect(
      diffSummary(
        diff([
          section("containers", { comparable: false }),
          section("filesystems", { comparable: false }),
        ]),
      ),
    ).toBe("0 differences, 2 sections could not be compared");
  });
});

describe("collection window", () => {
  it("stays quiet when both hosts were read close together", () => {
    expect(skewWarning(diff([], 3))).toBeNull();
    expect(skewWarning(diff([], 120))).toBeNull();
  });

  it("warns when the two sides describe moments far apart", () => {
    expect(skewWarning(diff([], 900))).toContain("15 minutes apart");
  });

  it("warns when a side never reported a collection time", () => {
    expect(skewWarning(diff([], null))).toContain("different moments");
  });

  it("formats a duration in the largest honest unit", () => {
    expect(formatDuration(1)).toBe("1 second");
    expect(formatDuration(45)).toBe("45 seconds");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(3600)).toBe("60 minutes");
  });

  it("says not collected rather than inventing a time", () => {
    expect(formatCollectedAt(null)).toBe("not collected");
  });
});

describe("drill-down", () => {
  it("offers navigation only where the row carries an id the view accepts", () => {
    expect(rowDestination("systemdUnits", row("nginx.service", "different"))).toEqual({
      view: "services",
      selectionId: "nginx.service",
    });
    expect(rowDestination("listeners", row("tcp/ipv4/443", "leftOnly"))).toEqual({
      view: "ports",
      selectionId: null,
    });
    expect(rowDestination("containers", row("name:api", "different"))).toBeNull();
    expect(rowDestination("filesystems", row("/", "different"))).toBeNull();
    expect(rowDestination("host", row("host", "different"))).toBeNull();
  });
});

describe("status coverage", () => {
  it("labels every status the backend can send", () => {
    const statuses: HostStateStatus[] = [
      "collected",
      "partial",
      "unsupported",
      "unavailable",
      "notCollected",
    ];
    for (const status of statuses) {
      expect(statusLabel(status)).not.toBe(status);
    }
  });
});
