import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatUptime,
  formatReadingTime,
  headerMetricDetail,
  headerMetricValue,
  formatByteRate,
  headerMetricNumber,
  metricTrend,
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
    expect(displayedHeaderMetrics()).toEqual(["cpu", "ram", "gpu", "diskIo", "uptime"]);
    expect(displayedHeaderMetrics(["diskIo", "disk", "cpu"])).toEqual(["diskIo", "cpu"]);
    expect(displayedHeaderMetrics(["disk"])).toEqual([]);
    expect(displayedHeaderMetrics([])).toEqual([]);
  });
  it("separates read/write transfer rates from storage fullness", () => {
    expect(headerMetricValue("diskIo", sample)).toBe("Read 1.0 MiB/s · Write 512 KiB/s");
    expect(headerMetricValue("disk", sample)).toBe("50%");
    expect(headerMetricNumber("diskIo", sample)).toBe(1572864);
    expect(headerMetricDetail("diskIo", sample)).toContain("All disks");
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
  it("draws measured samples on fixed percentage scales and breaks missing points", () => {
    expect(metricTrend("cpu", [])).toBeNull();
    expect(
      metricTrend("cpu", [
        { ...sample, cpuPercent: 0 },
        { ...sample, cpuPercent: null },
        { ...sample, cpuPercent: 100 },
      ]),
    ).toBe("M29.63,13.00  M33.00,2.00");
    expect(
      metricTrend(
        "cpu",
        Array.from({ length: 30 }, () => sample),
      )!.split(" "),
    ).toHaveLength(20);
    expect(metricTrend("diskIo", [sample])).toBe("M33.00,2.00");
    expect(metricTrend("uptime", [sample])).toBeNull();
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
