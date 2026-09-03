import { describe, expect, it } from "vitest";
import {
  changeCount,
  comparisonSummary,
  applyVolatileFilter,
  comparisonTargetTitle,
  comparisonToMarkdown,
  exportFileName,
  hasVolatileChanges,
  statusHint,
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
      changes: [{ name: "activeState", baseValue: "active", targetValue: "failed" }],
    })),
    unchangedCount: counts.unchanged ?? 0,
  };
}

function comparison(
  sections: SnapshotSectionDiff[],
  identityMatch: SnapshotComparison["identityMatch"] = "same",
  targetIsLive = false,
): SnapshotComparison {
  return {
    base: summary("base", "2026-09-01T10:00:00Z"),
    target: summary("target", "2026-09-02T10:00:00Z"),
    identityMatch,
    schemaCompatible: true,
    targetIsLive,
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

  it("says the live host answered as a different machine, not that two captures differ", () => {
    const warning = identityWarning(comparison([], "different", true));
    expect(warning).toContain("This connection is answering as a different machine");
    expect(warning).not.toContain("These captures");
  });
});

describe("live comparison naming", () => {
  it("names the live side rather than showing it as a capture", () => {
    expect(comparisonTargetTitle(comparison([], "same", true))).toBe("Live state");
  });

  it("keeps the snapshot title when both sides are saved captures", () => {
    expect(comparisonTargetTitle(comparison([]))).toBe(
      snapshotTitle(summary("target", "2026-09-02T10:00:00Z")),
    );
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

describe("noisy facts", () => {
  function churn(): SnapshotComparison {
    const base = comparison([diff("systemdUnits", true, { unchanged: 3 })]);
    base.sections[0].changed = [
      {
        identity: "logrotate.service",
        label: "logrotate.service",
        changes: [{ name: "subState", baseValue: "running", targetValue: "dead" }],
      },
      {
        identity: "ssh.service",
        label: "ssh.service",
        changes: [
          { name: "subState", baseValue: "running", targetValue: "dead" },
          { name: "activeState", baseValue: "active", targetValue: "failed" },
        ],
      },
    ];
    return base;
  }

  it("notices when a comparison contains values that move on their own", () => {
    expect(hasVolatileChanges(churn())).toBe(true);
    expect(hasVolatileChanges(comparison([diff("filesystems", true)]))).toBe(false);
  });

  it("drops an entry whose only change was a noisy fact, and counts it unchanged", () => {
    const filtered = applyVolatileFilter(churn(), true);
    const section = filtered.sections[0];

    expect(section.changed).toHaveLength(1);
    expect(section.changed[0].identity).toBe("ssh.service");
    expect(section.changed[0].changes.map((change) => change.name)).toEqual(["activeState"]);
    expect(section.unchangedCount).toBe(4);
  });

  it("leaves the comparison alone when the filter is off", () => {
    expect(applyVolatileFilter(churn(), false).sections[0].changed).toHaveLength(2);
  });
});

describe("comparison export", () => {
  it("writes the same facts the panel shows", () => {
    const markdown = comparisonToMarkdown(
      comparison([diff("systemdUnits", true, { added: 1, changed: 1, unchanged: 2 })]),
    );

    expect(markdown).toContain("## Systemd units");
    expect(markdown).toContain("- Added `systemdUnits-0`");
    expect(markdown).toContain("activeState: `active` → `failed`");
  });

  it("says a section could not be compared instead of leaving it blank", () => {
    const markdown = comparisonToMarkdown(comparison([diff("containers", false)]));
    expect(markdown).toContain("Not comparable");
  });

  it("builds a file name no filesystem will reject", () => {
    const name = exportFileName(comparison([], "same", true), "md");
    expect(name.endsWith(".md")).toBe(true);
    expect(name).not.toMatch(/[^a-zA-Z0-9.-]/);
  });
});

describe("status hints", () => {
  it("separates a missing subsystem from one this account cannot read", () => {
    expect(statusHint("unsupported")).toContain("not installed");
    expect(statusHint("unavailable")).toContain("could not read");
    expect(statusHint("skipped")).toContain("never asked");
  });
});
