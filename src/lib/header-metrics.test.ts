import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatUptime,
  formatReadingTime,
  headerMetricDetail,
  headerMetricValue,
  formatByteRate,
  headerMetricNumber,
  displayedHeaderMetrics,
} from "./header-metrics";
import type { HeaderMetrics } from "../types";
const sample: HeaderMetrics = {
  sampledAt: "",
  cpuPercent: 0,
  memoryTotalKib: 1024,
  memoryAvailableKib: 256,
  gpuPercent: null,
  diskTotalKib: 2048,
  diskFreeKib: 1024,
  diskLabel: "/",
  diskReadBytesPerSecond: 1048576,
  diskWriteBytesPerSecond: 524288,
  uptimeSeconds: 90000,
};
describe("header metric values", () => {
  it("excludes retired storage selections without changing other choices", () => {
    expect(displayedHeaderMetrics()).toEqual(["cpu", "ram", "gpu", "diskIo"]);
    expect(displayedHeaderMetrics(["diskIo", "disk", "cpu"])).toEqual(["cpu", "diskIo"]);
    expect(displayedHeaderMetrics(["disk"])).toEqual([]);
    expect(displayedHeaderMetrics(["uptime", "cpu"])).toEqual(["cpu"]);
    expect(displayedHeaderMetrics([])).toEqual([]);
  });
  it("separates read/write transfer rates from storage fullness", () => {
    expect(headerMetricValue("diskIo", sample)).toBe("Read 1.0 MiB/s · Write 512 KiB/s");
    expect(headerMetricValue("disk", sample)).toBe("50%");
    expect(headerMetricNumber("diskIo", sample)).toBe(1572864);
    expect(headerMetricDetail("diskIo", sample)).toBeNull();
    expect(headerMetricDetail("cpu", sample)).toBeNull();
    expect(headerMetricDetail("gpu", sample)).toBeNull();
    expect(headerMetricDetail("ram", null)).toBeNull();
    expect(
      headerMetricValue("diskIo", {
        ...sample,
        diskReadBytesPerSecond: 0,
        diskWriteBytesPerSecond: 0,
      }),
    ).toBe("Read 0 B/s · Write 0 B/s");
  });
  it("keeps missing and invalid transfer rates distinct from idle disks", () => {
    for (const value of [null, -1, NaN, Infinity]) {
      expect(headerMetricValue("diskIo", { ...sample, diskReadBytesPerSecond: value })).toBe(
        "Unavailable",
      );
      expect(formatByteRate(value)).toBe("Unavailable");
    }
    expect(formatByteRate(0)).toBe("0 B/s");
    expect(formatByteRate(1024)).toBe("1.0 KiB/s");
    expect(formatByteRate(12 * 1024 * 1024)).toBe("12 MiB/s");
    for (const invalid of [{ diskFreeKib: -1 }, { diskFreeKib: 4096 }, { diskTotalKib: NaN }])
      expect(headerMetricValue("disk", { ...sample, ...invalid })).toBe("Unavailable");
  });
  it("keeps zero usage distinct from unsupported or malformed readings", () => {
    expect(headerMetricValue("cpu", sample)).toBe("0%");
    expect(headerMetricValue("gpu", sample)).toBe("Unavailable");
    expect(formatPercent(NaN)).toBe("Unavailable");
    expect(formatPercent(101)).toBe("Unavailable");
  });
  it("shows available-memory and filesystem usage with capacity details", () => {
    expect(headerMetricValue("ram", sample)).toBe("75%");
    expect(headerMetricValue("disk", sample)).toBe("50%");
    expect(headerMetricDetail("disk", sample)).toBe("/: 1.0 MiB of 2.0 MiB");
    expect(headerMetricDetail("disk", { ...sample, diskLabel: "C:" })).toBe(
      "C: 1.0 MiB of 2.0 MiB",
    );
    expect(headerMetricValue("disk", { ...sample, diskTotalKib: 0 })).toBe("Unavailable");
  });
  it("does not expose an invalid timestamp as a valid reading time", () => {
    expect(formatReadingTime("broken")).toBe("Unavailable");
    expect(formatReadingTime("2026-10-09T12:00:00Z")).not.toBe("Unavailable");
  });
  it("compacts uptime without inventing a missing value", () => {
    expect(formatUptime(90000)).toBe("1d 1h");
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(59)).toBe("59s");
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(null)).toBe("Unavailable");
  });
});
