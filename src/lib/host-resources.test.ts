import { describe, expect, it } from "vitest";

import {
  compactUptime,
  formatKib,
  memoryUsage,
  sparklineAreaPath,
  sparklinePath,
  swapUsage,
} from "./host-resources";
import type { HostResources } from "../types";

function resources(overrides: Partial<HostResources> = {}): HostResources {
  return {
    sampledAt: "2026-09-03T12:00:00Z",
    cpuPercent: 12.5,
    coreCount: 4,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    memoryTotalKib: 3_884_504,
    memoryAvailableKib: 3_134_880,
    swapTotalKib: 1_003_516,
    swapFreeKib: 1_002_736,
    ...overrides,
  };
}

describe("formatKib", () => {
  it("climbs binary units and keeps the reading short", () => {
    expect(formatKib(512)).toBe("512 KiB");
    expect(formatKib(2048)).toBe("2.0 MiB");
    expect(formatKib(3_884_504)).toBe("3.7 GiB");
  });

  it("reports a missing reading as missing", () => {
    expect(formatKib(null)).toBeNull();
    expect(formatKib(-1)).toBeNull();
  });
});

describe("memoryUsage", () => {
  // Available already discounts cache, so a caching host is not shown as full.
  it("measures used against available rather than free", () => {
    const usage = memoryUsage(resources())!;
    expect(usage.usedKib).toBe(749_624);
    expect(usage.percent).toBeCloseTo(19.3, 1);
  });

  it("returns nothing when the host reported no total", () => {
    expect(memoryUsage(resources({ memoryTotalKib: null }))).toBeNull();
    expect(memoryUsage(resources({ memoryTotalKib: 0 }))).toBeNull();
    expect(memoryUsage(null)).toBeNull();
  });

  it("handles a host with swap switched off without dividing by zero", () => {
    expect(swapUsage(resources({ swapTotalKib: 0, swapFreeKib: 0 }))).toBeNull();
  });
});

describe("compactUptime", () => {
  it("shortens the prose uptime to its two largest units", () => {
    expect(compactUptime("up 1 week, 2 days, 2 hours, 55 minutes")).toBe("1w 2d");
    expect(compactUptime("up 3 hours, 12 minutes")).toBe("3h 12m");
    expect(compactUptime("up 41 minutes")).toBe("41m");
  });

  it("keeps an unfamiliar shape verbatim instead of dropping it", () => {
    expect(compactUptime("who knows")).toBe("who knows");
    expect(compactUptime(null)).toBeNull();
  });
});

describe("sparklinePath", () => {
  it("plots against a fixed ceiling so an idle line stays flat at the bottom", () => {
    const idle = sparklinePath([0, 0, 0], 30, 10);
    expect(idle).toBe("M0.00,10.00 L15.00,10.00 L30.00,10.00");
    expect(sparklinePath([100, 100], 10, 10)).toBe("M0.00,0.00 L10.00,0.00");
  });

  it("clamps a value above the ceiling rather than drawing outside the box", () => {
    expect(sparklinePath([0, 250], 10, 10)).toBe("M0.00,10.00 L10.00,0.00");
  });

  it("draws nothing from a single sample", () => {
    expect(sparklinePath([42], 10, 10)).toBe("");
    expect(sparklineAreaPath([42], 10, 10)).toBe("");
  });

  it("closes the area path back to the baseline", () => {
    const area = sparklineAreaPath([0, 100], 10, 10);
    expect(area.startsWith("M0,10")).toBe(true);
    expect(area.endsWith("Z")).toBe(true);
  });
});
