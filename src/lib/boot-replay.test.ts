import { describe, expect, it } from "vitest";

import type { BootReplayEntry, BootReplayPage } from "../types";
import {
  BOOT_REPLAY_SPEEDS,
  DEFAULT_BOOT_REPLAY_WINDOW_SECONDS,
  MAX_AUTO_REPLAY_PAGES,
  MAX_REPLAY_EVENTS,
  layoutReplayMarkers,
  classifyReplayEntry,
  describeReplayCoverage,
  emptyReplayEvidence,
  formatOffsetClock,
  formatTickLabel,
  formatTPlus,
  groupReplayMarkers,
  markerGroupLabel,
  mergeReplayEvidence,
  nextNotableMarker,
  normalizeWindowSeconds,
  notableReplayMarkers,
  previousNotableMarker,
  replayAxisTicks,
  replayEventSummary,
  replayPriorityLabel,
  shouldContinueReplayPagination,
  upperBound,
  windowMicroseconds,
} from "./boot-replay";

function entry(overrides: Partial<BootReplayEntry> = {}): BootReplayEntry {
  return {
    id: "cursor-1",
    monotonicUs: 1_000_000,
    realtimeUs: 1_730_000_000_000_000,
    priority: 6,
    source: "systemd",
    unit: null,
    message: "Reached target Basic System.",
    messageTruncated: false,
    ...overrides,
  };
}

function page(overrides: Partial<BootReplayPage> = {}): BootReplayPage {
  return {
    collectedAt: new Date().toISOString(),
    bootId: "a".repeat(32),
    managerEvents: [],
    alertEvents: [],
    managerNextCursor: null,
    alertNextCursor: null,
    managerTruncated: false,
    alertTruncated: false,
    earliestMonotonicUs: 0,
    latestMonotonicUs: 90_000_000,
    permissionRequired: false,
    errors: [],
    ...overrides,
  };
}

describe("replay window options", () => {
  it("keeps windows bounded and defaults nonsense back to 2 minutes", () => {
    expect(normalizeWindowSeconds(60)).toBe(60);
    expect(normalizeWindowSeconds(1)).toBe(10);
    expect(normalizeWindowSeconds(999_999)).toBe(1800);
    expect(normalizeWindowSeconds(Number.NaN)).toBe(DEFAULT_BOOT_REPLAY_WINDOW_SECONDS);
    expect(windowMicroseconds(120)).toBe(120_000_000);
  });
});

describe("replay classification", () => {
  it("reads failure and warning severity from syslog priority first", () => {
    expect(classifyReplayEntry(entry({ priority: 3, message: "device failed" }))).toBe("error");
    expect(classifyReplayEntry(entry({ priority: 0, message: "panic" }))).toBe("error");
    expect(classifyReplayEntry(entry({ priority: 4, message: "link is down" }))).toBe("warning");
    expect(classifyReplayEntry(entry({ priority: 6, message: "Reached target X." }))).toBe(
      "milestone",
    );
  });

  it("recognizes systemd milestones and unit lifecycle without inventing stages", () => {
    expect(classifyReplayEntry(entry({ message: "Startup finished in 2s (userspace)." }))).toBe(
      "milestone",
    );
    expect(classifyReplayEntry(entry({ message: "Started NetworkManager.service." }))).toBe("unit");
    expect(classifyReplayEntry(entry({ message: "Stopping cups.service..." }))).toBe("unit");
    // A daemon's informational line is a journal record even with a unit id.
    expect(
      classifyReplayEntry(entry({ source: "nginx", unit: "nginx.service", message: "ready" })),
    ).toBe("journal");
  });

  it("keeps manager failures as errors regardless of recorded priority", () => {
    expect(
      classifyReplayEntry(
        entry({ source: "application", priority: 6, message: "Failed to start a previous job" }),
      ),
    ).toBe("journal");
    expect(
      classifyReplayEntry(entry({ priority: 6, message: "Failed to start app.service." })),
    ).toBe("error");
    expect(
      classifyReplayEntry(
        entry({ priority: 5, message: "Unit app.service entered failed state." }),
      ),
    ).toBe("error");
    expect(replayPriorityLabel(3)).toBe("error");
    expect(replayPriorityLabel(9)).toBeNull();
  });
});

describe("evidence merging", () => {
  it("dedupes across streams and pages while staying offset-sorted", () => {
    const shared = entry({ id: "shared", monotonicUs: 5_000_000 });
    const first = mergeReplayEvidence(null, page({ managerEvents: [shared] }));
    const second = mergeReplayEvidence(first, {
      ...page(),
      alertEvents: [
        shared,
        entry({
          id: "early",
          monotonicUs: 1_000_000,
          priority: 4,
          message: "wlan0: link is not ready",
        }),
        entry({ id: "late", monotonicUs: 80_000_000, priority: 3, message: "bind() failed" }),
      ],
    });
    expect(second.timedEvents.map((event) => event.id)).toEqual(["early", "shared", "late"]);
    expect(second.timedEvents.map((event) => event.category)).toEqual([
      "warning",
      "milestone",
      "error",
    ]);
    expect(second.loadedCount).toBe(3);
    expect(second.lastLoadedOffsetUs).toBe(80_000_000);
  });

  it("keeps records without a boot-relative offset out of the timed axis", () => {
    const evidence = mergeReplayEvidence(null, {
      ...page(),
      alertEvents: [entry({ id: "untimed", monotonicUs: null })],
    });
    expect(evidence.timedEvents).toHaveLength(0);
    expect(evidence.untimedEvents.map((event) => event.id)).toEqual(["untimed"]);
    expect(evidence.lastLoadedOffsetUs).toBeNull();
  });

  it("carries the current page cursors and truncation forward for Load more", () => {
    const first = mergeReplayEvidence(null, {
      ...page(),
      managerTruncated: true,
      managerNextCursor: "s=first",
      alertTruncated: true,
      alertNextCursor: "s=alert",
    });
    expect(first.managerTruncated).toBe(true);
    // The next page is authoritative for both streams: the manager can be
    // exhausted while the alert stream still has retained entries.
    const last = mergeReplayEvidence(
      first,
      page({ managerNextCursor: null, alertTruncated: true, alertNextCursor: "s=alert-2" }),
    );
    expect(last.managerCursor).toBeNull();
    expect(last.managerTruncated).toBe(false);
    expect(last.alertCursor).toBe("s=alert-2");
    expect(last.alertTruncated).toBe(true);
  });
});

describe("playhead math", () => {
  const events = mergeReplayEvidence(
    null,
    page({
      alertEvents: [
        entry({ id: "e1", monotonicUs: 1_000_000, priority: 3 }),
        entry({ id: "e2", monotonicUs: 2_000_000, priority: 4, message: "degraded" }),
        entry({ id: "e3", monotonicUs: 3_000_000, message: "Started app.service." }),
      ],
      managerEvents: [entry({ id: "m1", monotonicUs: 500_000 })],
    }),
  ).timedEvents;

  it("counts loaded events at the playhead with a binary search", () => {
    expect(upperBound(events, 0)).toBe(0);
    expect(upperBound(events, 1_000_000)).toBe(2);
    expect(upperBound(events, 999_999_999)).toBe(4);
  });

  it("skips between meaningful markers and treats a repeat burst as one stop", () => {
    const evidence = mergeReplayEvidence(
      null,
      page({
        managerEvents: [entry({ id: "m1", monotonicUs: 500_000 })],
        alertEvents: [
          entry({ id: "e1", monotonicUs: 1_000_000, priority: 3, message: "bind() failed" }),
          entry({ id: "w1", monotonicUs: 2_000_000, priority: 4, message: "link is not ready" }),
          entry({
            id: "w2",
            monotonicUs: 2_200_000,
            priority: 4,
            message: "link is not ready",
          }),
        ],
      }),
    );
    const markers = groupReplayMarkers(evidence.timedEvents, 120_000_000);
    // Failures and warnings lead; the two identical warnings are one stop.
    expect(notableReplayMarkers(markers).map((marker) => marker.count)).toEqual([1, 2]);
    expect(nextNotableMarker(markers, 0)?.offsetUs).toBe(1_000_000);
    expect(nextNotableMarker(markers, 1_000_000)?.offsetUs).toBe(2_000_000);
    // Inside the cluster there is nothing further until it ends.
    expect(nextNotableMarker(markers, 2_100_000)).toBeNull();
    expect(previousNotableMarker(markers, 2_200_000)?.offsetUs).toBe(1_000_000);
    expect(previousNotableMarker(markers, 1_000_000)).toBeNull();
    // A quiet boot falls back to milestone stops.
    const quietBoot = groupReplayMarkers(
      mergeReplayEvidence(
        null,
        page({ managerEvents: [entry({ id: "only", monotonicUs: 10_000_000 })] }),
      ).timedEvents,
      120_000_000,
    );
    expect(notableReplayMarkers(quietBoot).map((marker) => marker.category)).toEqual(["milestone"]);
  });
});

describe("marker clustering", () => {
  it("collapses a dense retry burst into one counted marker", () => {
    const burst = mergeReplayEvidence(
      null,
      page({
        alertEvents: [
          entry({
            id: "w1",
            monotonicUs: 10_000_000,
            priority: 4,
            message: "dhclient: retry 1 failed",
          }),
          entry({
            id: "w2",
            monotonicUs: 10_200_000,
            priority: 4,
            message: "dhclient: retry 2 failed",
          }),
          entry({
            id: "w3",
            monotonicUs: 10_400_000,
            priority: 4,
            message: "dhclient: retry 3 failed",
          }),
        ],
        managerEvents: [entry({ id: "m1", monotonicUs: 9_000_000 })],
      }),
    );
    const markers = groupReplayMarkers(burst.timedEvents, 120_000_000);
    // Digits are normalized, so numbered retries are one similar-message group;
    // the milestone stays its own marker.
    expect(markers).toHaveLength(2);
    expect(markers[0].category).toBe("milestone");
    expect(markers[1].count).toBe(3);
    expect(markerGroupLabel(markers[1])).toBe("3 similar events");
  });

  it("labels clusters with a count and keeps separate facts separate", () => {
    const evidence = mergeReplayEvidence(
      null,
      page({
        alertEvents: [
          entry({ id: "w1", monotonicUs: 10_000_000, priority: 4, message: "link is not ready" }),
          entry({ id: "w2", monotonicUs: 10_200_000, priority: 4, message: "link is not ready" }),
          entry({ id: "w3", monotonicUs: 10_400_000, priority: 4, message: "link: retry 1" }),
          entry({ id: "w4", monotonicUs: 40_000_000, priority: 4, message: "link is not ready" }),
        ],
      }),
    );
    const markers = groupReplayMarkers(evidence.timedEvents, 120_000_000);
    expect(markers).toHaveLength(3);
    expect(markerGroupLabel(markers[0])).toBe("2 similar events");
    expect(markerGroupLabel(markers[1])).toBe("link: retry 1");
    expect(markers[2].spanUs).toEqual([40_000_000, 40_000_000]);
  });
});

function toEvent(raw: BootReplayEntry) {
  return {
    id: raw.id,
    offsetUs: raw.monotonicUs,
    realtimeUs: raw.realtimeUs,
    priority: raw.priority,
    source: raw.source,
    unit: raw.unit,
    message: raw.message,
    messageTruncated: raw.messageTruncated,
    category: classifyReplayEntry(raw),
    provenance: "journal" as const,
    classification: "observed" as const,
  };
}

describe("coverage descriptions", () => {
  it("bounds retained evidence across repeated explicit loads", () => {
    let evidence = emptyReplayEvidence();
    for (let start = 0; start <= MAX_REPLAY_EVENTS; start += 250) {
      evidence = mergeReplayEvidence(
        evidence,
        page({
          managerEvents: Array.from({ length: 250 }, (_, index) =>
            entry({ id: `m${start + index}`, monotonicUs: start + index }),
          ),
          managerTruncated: true,
          managerNextCursor: `s=${start}`,
        }),
      );
    }
    expect(evidence.loadedCount).toBe(MAX_REPLAY_EVENTS);
    expect(evidence.limitReached).toBe(true);
    expect(shouldContinueReplayPagination(evidence, 120_000_000, 0)).toBe(false);
    expect(describeReplayCoverage(evidence, 120_000_000, null).label).toBe("Limit reached");
  });

  it("groups by actual track width without changing the source markers", () => {
    const markers = groupReplayMarkers(
      [
        toEvent(entry({ id: "one", monotonicUs: 1_000_000, message: "first" })),
        toEvent(entry({ id: "two", monotonicUs: 2_000_000, message: "second" })),
      ],
      120_000_000,
    );
    expect(layoutReplayMarkers(markers, 120_000_000, 600)).toHaveLength(1);
    expect(layoutReplayMarkers(markers, 120_000_000, 2400)).toHaveLength(2);
    expect(markers[0].count).toBe(1);
    expect(markers[0].spanUs).toEqual([1_000_000, 1_000_000]);
  });
  it("continues each stream independently when the other passes the window", () => {
    const evidence = mergeReplayEvidence(
      null,
      page({
        managerEvents: [entry({ id: "m", monotonicUs: 200_000_000 })],
        alertEvents: [entry({ id: "a", monotonicUs: 5_000_000, priority: 4 })],
        alertTruncated: true,
        alertNextCursor: "s=next",
      }),
    );
    expect(shouldContinueReplayPagination(evidence, 120_000_000, 1)).toBe(true);
    expect(describeReplayCoverage(evidence, 120_000_000, null).kind).toBe("partial");
  });

  it("reports incomplete reads before empty or complete evidence", () => {
    const loaded = mergeReplayEvidence(null, page({ managerEvents: [entry()] }));
    expect(
      describeReplayCoverage(loaded, 120_000_000, "Connection lost on the next page").kind,
    ).toBe("partial");
    for (const managerEvents of [[], [entry()]]) {
      const evidence = mergeReplayEvidence(
        null,
        page({
          managerEvents,
          errors: ["Warning events were not returned by the host"],
          latestMonotonicUs: 200_000_000,
        }),
      );
      expect(describeReplayCoverage(evidence, 120_000_000, null).kind).toBe("partial");
      expect(describeReplayCoverage(evidence, 120_000_000, null).explanation).toContain(
        "Warning events",
      );
    }
  });
  it("separates permission, failure, emptiness, and partial truth", () => {
    expect(describeReplayCoverage(null, 120_000_000, null).kind).toBe("loading");
    expect(describeReplayCoverage(emptyReplayEvidence(), 120_000_000, "ssh failed").kind).toBe(
      "unavailable",
    );
    const permission = emptyReplayEvidence();
    permission.permissionRequired = true;
    expect(describeReplayCoverage(permission, 120_000_000, null).kind).toBe("permission");
    expect(describeReplayCoverage(emptyReplayEvidence(), 120_000_000, null).kind).toBe("empty");
  });

  it("names a retention gap and load-again state instead of silence", () => {
    const gapped = emptyReplayEvidence();
    gapped.earliestMonotonicUs = 30_000_000;
    const gappedCoverage = describeReplayCoverage(gapped, 120_000_000, null);
    expect(gappedCoverage.kind).toBe("partial");
    expect(gappedCoverage.explanation).toContain("T+0:30.0");

    const truncated = mergeReplayEvidence(
      null,
      page({
        managerEvents: [entry({ id: "m1", monotonicUs: 5_000_000 })],
        managerTruncated: true,
        managerNextCursor: "s=more",
        alertTruncated: true,
        alertNextCursor: "s=alerts",
      }),
    );
    const truncatedCoverage = describeReplayCoverage(truncated, 120_000_000, null);
    expect(truncatedCoverage.kind).toBe("partial");
    expect(shouldContinueReplayPagination(truncated, 120_000_000, 1)).toBe(true);
    expect(shouldContinueReplayPagination(truncated, 120_000_000, MAX_AUTO_REPLAY_PAGES)).toBe(
      false,
    );
    // Once loaded evidence reaches the window end, more pages add nothing.
    const exhausted = mergeReplayEvidence(truncated, {
      ...page({ managerEvents: [entry({ id: "m2", monotonicUs: 200_000_000 })] }),
    });
    expect(shouldContinueReplayPagination(exhausted, 120_000_000, 2)).toBe(false);
    expect(describeReplayCoverage(exhausted, 120_000_000, null).kind).toBe("complete");
  });

  it("says when the journal ends before the window does", () => {
    const shortBoot = mergeReplayEvidence(
      null,
      page({
        managerEvents: [entry({ id: "m1", monotonicUs: 5_000_000 })],
        latestMonotonicUs: 18_000_000,
      }),
    );
    const coverage = describeReplayCoverage(shortBoot, 120_000_000, null);
    expect(coverage.kind).toBe("complete");
    expect(coverage.label).toBe("Sized to journal");
    expect(coverage.explanation).toContain("T+0:18.0");
  });
});

describe("event summaries and formats", () => {
  it("explains evidence without inventing causes", () => {
    const error = {
      ...toEvent(entry({ priority: 3, unit: "nginx.service", message: "bind() failed" })),
      offsetUs: 42_000_000,
    };
    const summary = replayEventSummary(error, 120_000_000);
    expect(summary).toContain("nginx.service");
    expect(summary).toContain("T+0:42.0");
    expect(summary).toContain("reported an error");
  });

  it("formats replay clock offsets and axis ticks at readable steps", () => {
    expect(formatOffsetClock(0)).toBe("0:00.0");
    expect(formatOffsetClock(23_400_000)).toBe("0:23.4");
    expect(formatOffsetClock(84_000_000)).toBe("1:24.0");
    expect(formatTPlus(2_500_000)).toBe("T+0:02.5");
    expect(replayAxisTicks(120_000_000)).toEqual([
      0, 30_000_000, 60_000_000, 90_000_000, 120_000_000,
    ]);
    expect(replayAxisTicks(30_000_000)).toEqual([
      0, 5_000_000, 10_000_000, 15_000_000, 20_000_000, 25_000_000, 30_000_000,
    ]);
    expect(formatTickLabel(5_000_000)).toBe("5s");
    expect(formatTickLabel(2_500_000)).toBe("2.5s");
    expect(BOOT_REPLAY_SPEEDS).toContain(1);
  });
});
