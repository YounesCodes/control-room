import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatUptime,
  headerMetricDetail,
  headerMetricValue,
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
  uptimeSeconds: 90000,
};
describe("header metric values", () => {
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
    expect(headerMetricValue("disk", { ...sample, diskTotalKib: 0 })).toBe("Unavailable");
  });
  it("compacts uptime without inventing a missing value", () => {
    expect(formatUptime(90000)).toBe("1d 1h");
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(null)).toBe("Unavailable");
  });
});
