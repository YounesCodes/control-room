import type { BootDiagnostics, BootSection } from "../types";

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
