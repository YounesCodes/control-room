import type { BootDiagnostics, BootReplayEntry, BootReplayPage, BootSection } from "../types";

export function bootDiagnostics(overrides: Partial<BootDiagnostics> = {}): BootDiagnostics {
  const collectedAt = new Date().toISOString();
  function section<T>(data: T): BootSection<T> {
    return { collectedAt, data, error: null, permissionRequired: false };
  }
  return {
    id: "boot-diagnostics",
    collectedAt,
    selectedBootId: "a".repeat(32),
    boots: section([
      { index: 0, id: "a".repeat(32), range: "Current boot", current: true },
      { index: -1, id: "b".repeat(32), range: "Previous boot", current: false },
    ]),
    timing: section({
      total: "1s",
      kernel: null,
      userspace: "1s",
      original: "Startup finished in 1s",
    }),
    slowUnits: section([]),
    failedUnits: section([]),
    journal: section([]),
    ...overrides,
  };
}

export function replayEntry(overrides: Partial<BootReplayEntry> = {}): BootReplayEntry {
  return {
    id: "cursor-1",
    monotonicUs: 1_000_000,
    realtimeUs: 1_730_000_000_000_000,
    priority: null,
    source: null,
    unit: null,
    message: "journal record",
    ...overrides,
  };
}

export function bootReplayPage(overrides: Partial<BootReplayPage> = {}): BootReplayPage {
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
