import { describe, expect, it } from "vitest";
import {
  changeCount,
  comparisonSummary,
  identityWarning,
  orderForComparison,
  sectionLabel,
  snapshotTitle,
  sortSnapshots,
  statusLabel,
} from "./host-snapshots";
import type {
  HostSnapshotSummary,
  SnapshotComparison,
  SnapshotSectionDiff,
  SnapshotSectionKind,
  SnapshotSectionStatus,
} from "../types";

function summary(id: string, capturedAt: string, label: string | null = null): HostSnapshotSummary {
  return {
    id,
    connectionId: "connection-a",
    label,
    schemaVersion: 1,
    capturedAt,
    identity: {
      hostname: "host-a",
      machineFingerprint: "0123456789abcdef",
      osId: "debian",
      osVersion: "13",
      kernel: "6.1.0",
      architecture: "x86_64",
    },
    sections: [],
  };
}

function diff(
  kind: SnapshotSectionKind,
  comparable: boolean,
  counts: { added?: number; removed?: number; changed?: number; unchanged?: number } = {},
): SnapshotSectionDiff {
  const entry = (index: number) => ({
    identity: `${kind}-${index}`,
    label: `${kind}-${index}`,
    facts: [],
  });
  return {
    kind,
    baseStatus: "collected" as SnapshotSectionStatus,
    targetStatus: comparable ? "collected" : "unsupported",
    comparable,
    note: null,
    added: Array.from({ length: counts.added ?? 0 }, (_, index) => entry(index)),
    removed: Array.from({ length: counts.removed ?? 0 }, (_, index) => entry(100 + index)),
    changed: Array.from({ length: counts.changed ?? 0 }, (_, index) => ({
      identity: `${kind}-c${index}`,
      label: `${kind}-c${index}`,
      changes: [],
    })),
    unchangedCount: counts.unchanged ?? 0,
  };
}

function comparison(
  sections: SnapshotSectionDiff[],
  identityMatch: SnapshotComparison["identityMatch"] = "same",
): SnapshotComparison {
  return {
    base: summary("base", "2026-09-01T10:00:00Z"),
    target: summary("target", "2026-09-02T10:00:00Z"),
    identityMatch,
    schemaCompatible: true,
    sections,
  };
}

describe("snapshot labels", () => {
  it("names sections and statuses in plain words", () => {
    expect(sectionLabel("systemdUnits")).toBe("Systemd units");
    expect(sectionLabel("filesystems")).toBe("Filesystems");
    expect(statusLabel("unsupported")).toBe("Not present");
    expect(statusLabel("unavailable")).toBe("Not readable");
    expect(statusLabel("partial")).toBe("Partial");
  });

  it("falls back to the capture time when a snapshot has no label", () => {
    expect(snapshotTitle(summary("a", "2026-09-01T10:00:00Z", "before upgrade"))).toBe(
      "before upgrade",
    );
    expect(snapshotTitle(summary("a", "2026-09-01T10:00:00Z"))).not.toBe("");
  });
});

describe("comparison summary", () => {
  it("counts additions, removals, and modifications together", () => {
    expect(changeCount(diff("containers", true, { added: 1, removed: 2, changed: 3 }))).toBe(6);
    expect(
      comparisonSummary(comparison([diff("containers", true, { added: 1, unchanged: 4 })])),
    ).toBe("1 change");
  });

  it("never counts an incomparable section as unchanged", () => {
    const result = comparisonSummary(
      comparison([diff("containers", false), diff("systemdUnits", true, { unchanged: 12 })]),
    );
    expect(result).toBe("0 changes, 1 section could not be compared");
  });

  it("pluralizes skipped sections", () => {
    expect(
      comparisonSummary(comparison([diff("containers", false), diff("listeners", false)])),
    ).toBe("0 changes, 2 sections could not be compared");
  });
});

describe("host identity evidence", () => {
  it("warns when the two captures came from different machines", () => {
    expect(identityWarning(comparison([], "different"))).toContain("different machine identities");
  });

  it("warns when identity could not be read at all", () => {
    expect(identityWarning(comparison([], "unknown"))).toContain("cannot confirm");
  });

  it("stays quiet when the fingerprints match", () => {
    expect(identityWarning(comparison([], "same"))).toBeNull();
  });
});

describe("snapshot ordering", () => {
  it("lists the newest capture first and breaks ties by id", () => {
    const ordered = sortSnapshots([
      summary("a", "2026-09-01T10:00:00Z"),
      summary("c", "2026-09-03T10:00:00Z"),
      summary("b", "2026-09-01T10:00:00Z"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("always compares earlier to later whichever row is selected", () => {
    const earlier = summary("early", "2026-09-01T10:00:00Z");
    const later = summary("late", "2026-09-05T10:00:00Z");
    expect(orderForComparison(later, earlier)).toEqual({ baseId: "early", targetId: "late" });
    expect(orderForComparison(earlier, later)).toEqual({ baseId: "early", targetId: "late" });
  });
});
