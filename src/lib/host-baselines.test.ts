import { describe, expect, it } from "vitest";
import {
  comparisonSummary,
  comparisonTargetTitle,
  comparisonToMarkdown,
  comparisonTotals,
  comparisonView,
  coverageText,
  exportFileName,
  identityWarning,
  isRoutineEntry,
  orderForComparison,
  sectionLabel,
  baselineTitle,
  sortBaselines,
  statusHint,
  statusLabel,
  SECTION_KINDS,
} from "./host-baselines";
import type {
  HostBaselineSummary,
  BaselineComparison,
  BaselineSectionDiff,
  BaselineEntryChange,
  BaselineSectionKind,
  BaselineSectionStatus,
} from "../types";

function summary(id: string, capturedAt: string, label: string | null = null): HostBaselineSummary {
  return {
    id,
    connectionId: "connection-a",
    label,
    schemaVersion: 1,
    capturedAt,
    pinned: false,
    changesSincePrevious: null,
    routineSincePrevious: null,
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

function change(
  identity: string,
  facts: { name: string; base: string | null; target: string | null; routine?: boolean }[],
): BaselineEntryChange {
  return {
    identity,
    label: identity,
    changes: facts.map((fact) => ({
      name: fact.name,
      baseValue: fact.base,
      targetValue: fact.target,
      classification: fact.routine ? ("routine" as const) : ("meaningful" as const),
      reason: fact.routine ? "Sub-states move on their own between captures." : null,
    })),
  };
}

function diff(
  kind: BaselineSectionKind,
  comparable: boolean,
  overrides: Partial<BaselineSectionDiff> = {},
): BaselineSectionDiff {
  return {
    kind,
    baseStatus: "collected" as BaselineSectionStatus,
    targetStatus: comparable
      ? ("collected" as BaselineSectionStatus)
      : ("unsupported" as BaselineSectionStatus),
    comparable,
    note: comparable ? null : "Not comparable: in the later capture the subsystem was not present.",
    added: [],
    removed: [],
    changed: comparable
      ? [change("nginx.service", [{ name: "activeState", base: "active", target: "failed" }])]
      : [],
    unchangedCount: comparable ? 5 : 0,
    routineCount: 0,
    removalsIndeterminate: false,
    ...overrides,
  };
}

function comparison(
  sections: BaselineSectionDiff[],
  overrides: Partial<BaselineComparison> = {},
): BaselineComparison {
  return {
    base: summary("earlier", "2026-09-01T10:00:00Z", "before upgrade"),
    target: summary("later", "2026-09-02T10:00:00Z", "after upgrade"),
    identityMatch: "same",
    schemaCompatible: true,
    targetIsLive: false,
    sections,
    ...overrides,
  };
}

describe("baseline comparison summaries", () => {
  it("counts meaningful differences separately from hidden routine churn", () => {
    const units = diff("systemdUnits", true, {
      changed: [
        change("nginx.service", [
          { name: "unitFileState", base: "enabled", target: "disabled" },
          { name: "subState", base: "running", target: "dead", routine: true },
        ]),
        // Only routine facts moved: this entry leaves the meaningful count.
        change("backup.service", [
          { name: "subState", base: "running", target: "dead", routine: true },
        ]),
      ],
      routineCount: 2,
      unchangedCount: 8,
    });
    const totals = comparisonTotals(comparison([units]));
    expect(totals.meaningful).toBe(1);
    expect(totals.routine).toBe(2);
    expect(totals.incomparable).toBe(0);
  });

  it("says how many sections could not be compared instead of calling them quiet", () => {
    const readable = diff("systemdUnits", true, { changed: [], added: [], unchangedCount: 3 });
    const unreadable = diff("containers", false);
    const summaryLine = comparisonSummary(comparison([readable, unreadable]));
    expect(summaryLine).toContain("0 meaningful differences");
    expect(summaryLine).toContain("1 section could not be compared");
  });

  it("separates the routine count on sections that only moved on their own", () => {
    const onlyRoutine = diff("containers", true, {
      changed: [
        change("api", [{ name: "state", base: "running", target: "exited", routine: true }]),
      ],
      routineCount: 1,
      unchangedCount: 2,
    });
    const line = comparisonSummary(comparison([onlyRoutine]));
    expect(line).toContain("0 meaningful differences");
    expect(line).toContain("1 routine change hidden");
  });
});

describe("baseline comparison filtering", () => {
  it("hides routine-only entries by default and reveals them on request", () => {
    const units = diff("systemdUnits", true, {
      changed: [
        change("nginx.service", [{ name: "unitFileState", base: "enabled", target: "disabled" }]),
        change("backup.service", [
          { name: "subState", base: "running", target: "dead", routine: true },
        ]),
      ],
      routineCount: 1,
    });
    const result = comparisonView(comparison([units]), { showRoutine: false, search: "" });
    expect(result[0].changed.map((entry) => entry.identity)).toEqual(["nginx.service"]);
    expect(result[0].routineCount).toBe(1);
    const all = comparisonView(comparison([units]), { showRoutine: true, search: "" });
    expect(all[0].changed.map((entry) => entry.identity)).toEqual([
      "nginx.service",
      "backup.service",
    ]);
  });

  it("keeps the hidden routine count consistent after filtering", () => {
    const units = diff("systemdUnits", true, {
      changed: [
        change("backup.service", [
          { name: "subState", base: "running", target: "dead", routine: true },
        ]),
      ],
      routineCount: 1,
    });
    const hidden = comparisonView(comparison([units]), { showRoutine: false, search: "" });
    expect(hidden[0].changed).toHaveLength(0);
    expect(hidden[0].routineCount).toBe(1);
    expect(hidden[0].meaningfulCount).toBe(0);
  });

  it("searches labels and fact values but never invents rows", () => {
    const units = diff("systemdUnits", true, {
      added: [{ identity: "postgresql.service", label: "postgresql.service", facts: [] }],
      removed: [{ identity: "redis.service", label: "redis.service", facts: [] }],
      changed: [
        change("nginx.service", [{ name: "activeState", base: "active", target: "failed" }]),
      ],
    });
    const result = comparisonView(comparison([units]), { showRoutine: false, search: "nginx" });
    expect(result[0].added).toHaveLength(0);
    expect(result[0].removed).toHaveLength(0);
    expect(result[0].changed.map((entry) => entry.identity)).toEqual(["nginx.service"]);
  });

  it("carries incomparable sections through the view with their note", () => {
    const unreadable = diff("packages", false);
    const result = comparisonView(comparison([unreadable]), { showRoutine: false, search: "" });
    expect(result[0].comparable).toBe(false);
    expect(result[0].note).toContain("Not comparable");
  });
});

describe("baseline helper contracts", () => {
  it("treats an entry as routine only when every fact change is routine", () => {
    expect(
      isRoutineEntry(change("a", [{ name: "state", base: "1", target: "2", routine: true }])),
    ).toBe(true);
    expect(
      isRoutineEntry(
        change("a", [
          { name: "state", base: "1", target: "2", routine: true },
          { name: "image", base: "api:1", target: "api:2" },
        ]),
      ),
    ).toBe(false);
    expect(isRoutineEntry(change("a", [{ name: "image", base: "api:1", target: "api:2" }]))).toBe(
      false,
    );
  });

  it("orders newest first and compares earlier to later", () => {
    const earlier = summary("earlier", "2026-09-01T10:00:00Z");
    const later = summary("later", "2026-09-02T10:00:00Z");
    expect(sortBaselines([earlier, later]).map((item) => item.id)).toEqual(["later", "earlier"]);
    expect(orderForComparison(later, earlier)).toEqual({
      baseId: "earlier",
      targetId: "later",
    });
    expect(orderForComparison(earlier, later)).toEqual({ baseId: "earlier", targetId: "later" });
  });

  it("labels every section the backend records", () => {
    expect(SECTION_KINDS).toHaveLength(9);
    expect(sectionLabel("configurationAccess")).toBe("Configuration & access");
    expect(sectionLabel("firewall")).toBe("Firewall");
    expect(sectionLabel("scheduledJobs")).toBe("Scheduled jobs");
    expect(sectionLabel("packages")).toBe("Packages");
    expect(statusLabel("partial")).toBe("Partial");
    expect(statusHint("unsupported").length).toBeGreaterThan(0);
  });

  it("reports coverage as readable sections, not a health verdict", () => {
    const baseline = summary("a", "2026-09-01T10:00:00Z");
    baseline.sections = [
      { kind: "host", status: "collected", entryCount: 1 },
      { kind: "systemdUnits", status: "partial", entryCount: 40 },
      { kind: "containers", status: "unsupported", entryCount: 0 },
    ];
    expect(coverageText(baseline)).toBe("2/3 read · 1 partial");
  });

  it("names the target honestly, including a live read", () => {
    const stored = comparison([]);
    expect(comparisonTargetTitle(stored)).toBe("after upgrade");
    expect(comparisonTargetTitle(comparison([], { targetIsLive: true }))).toBe("Live state");
    expect(baselineTitle(stored.base)).toBe("before upgrade");
  });

  it("warns when identity evidence is missing or contradictory", () => {
    expect(identityWarning(comparison([], { identityMatch: "same" }))).toBeNull();
    expect(identityWarning(comparison([], { identityMatch: "unknown" }))).toContain(
      "cannot confirm",
    );
    expect(identityWarning(comparison([], { identityMatch: "different" }))).toContain("two hosts");
  });

  it("exports markdown matching the requested filters, with routine reasons", () => {
    const units = diff("systemdUnits", true, {
      changed: [
        change("nginx.service", [
          { name: "unitFileState", base: "enabled", target: "disabled" },
          { name: "subState", base: "running", target: "dead", routine: true },
        ]),
      ],
      routineCount: 1,
    });
    const text = comparisonToMarkdown(comparison([units]), { showRoutine: false, search: "" });
    expect(text).toContain("1 meaningful difference");
    expect(text).toContain("1 routine change hidden");
    expect(text).toContain("unitFileState: `enabled` → `disabled`");
    expect(text).not.toContain("subState: `running`");
    const showAll = comparisonToMarkdown(comparison([units]), { showRoutine: true, search: "" });
    expect(showAll).toContain("1 routine change");
    expect(showAll).not.toContain("hidden");
    expect(showAll).toContain("subState: `running` → `dead`");
    expect(showAll).toContain("routine: Sub-states move on their own between captures.");
  });

  it("marks live reads and partial removals in the export", () => {
    const listeners = diff("listeners", true, {
      removed: [{ identity: "tcp/ipv4/0.0.0.0:22", label: "0.0.0.0:22/tcp", facts: [] }],
      removalsIndeterminate: true,
      note: "One side of this section was partial. The comparison covers only what each capture could read.",
    });
    const live = comparison([listeners], {
      target: summary("live", "2026-09-03T09:00:00Z"),
      targetIsLive: true,
    });
    const text = comparisonToMarkdown(live);
    expect(text).toContain("This read was not saved");
    expect(text).toContain("unverified rather than confirmed gone");
  });

  it("builds export file names both platforms accept", () => {
    const result = comparison([]);
    expect(exportFileName(result, "md")).toMatch(/^baseline-before-upgrade-to-after-upgrade\.md$/);
  });
});
