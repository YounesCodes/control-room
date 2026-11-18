import { describe, expect, it } from "vitest";
import {
  METRIC_HISTORY_SECONDS,
  appendReading,
  areaPath,
  chartPoint,
  coveredSeconds,
  formatCoverage,
  missingReadingGap,
  peakReading,
  rateScale,
  readingsInRange,
  tracePath,
  traceSegments,
  type TimedReading,
} from "./metric-history";
import type { HeaderMetrics } from "../types";

const start = Date.parse("2026-11-01T10:00:00Z");

function sample(secondsAfterStart: number, cpuPercent: number | null): HeaderMetrics {
  return {
    sampledAt: new Date(start + secondsAfterStart * 1000).toISOString(),
    cpuPercent,
    memoryTotalKib: null,
    memoryAvailableKib: null,
    gpuPercent: null,
    diskTotalKib: null,
    diskFreeKib: null,
    diskLabel: null,
    diskReadBytesPerSecond: null,
    diskWriteBytesPerSecond: null,
    uptimeSeconds: null,
  };
}

function history(...readings: [number, number | null][]): TimedReading[] {
  return readings.reduce<TimedReading[]>(
    (current, [seconds, cpu]) => appendReading(current, sample(seconds, cpu)),
    [],
  );
}

const cpu = (reading: HeaderMetrics) => reading.cpuPercent;
const at = (seconds: number) => start + seconds * 1000;

describe("metric history", () => {
  it("keeps the longest range at any refresh interval and drops older readings", () => {
    for (const interval of [2, 5, 10, 30]) {
      let readings: TimedReading[] = [];
      for (let seconds = 0; seconds <= 900; seconds += interval)
        readings = appendReading(readings, sample(seconds, 10));
      const span = (readings.at(-1)!.at - readings[0].at) / 1000;
      expect(span, `${interval}s interval`).toBeLessThanOrEqual(METRIC_HISTORY_SECONDS);
      expect(span, `${interval}s interval`).toBeGreaterThan(METRIC_HISTORY_SECONDS - interval);
    }
  });

  it("ignores a reading without a valid time or one that goes back in time", () => {
    const readings = history([0, 10], [5, 20]);
    expect(appendReading(readings, { ...sample(10, 30), sampledAt: "broken" })).toBe(readings);
    expect(appendReading(readings, sample(3, 30)).map((reading) => reading.at)).toEqual([
      at(0),
      at(3),
    ]);
  });

  it("selects the readings inside the visible range", () => {
    const readings = history([0, 1], [50, 2], [100, 3], [120, 4]);
    expect(
      readingsInRange(readings, at(120), 60).map((reading) => reading.sample.cpuPercent),
    ).toEqual([3, 4]);
  });

  it("finds the peak inside the visible range only", () => {
    const readings = history([0, 95], [70, 40], [100, null], [120, 30]);
    expect(peakReading(readingsInRange(readings, at(120), 60), cpu)).toBe(40);
    expect(peakReading(readingsInRange(readings, at(120), 600), cpu)).toBe(95);
    expect(peakReading(history([0, null]), cpu)).toBeNull();
  });

  it("takes the larger of several traces as the peak", () => {
    const reading = sample(0, null);
    reading.diskReadBytesPerSecond = 300;
    reading.diskWriteBytesPerSecond = 900;
    expect(
      peakReading(
        [{ at: at(0), sample: reading }],
        (value) => value.diskReadBytesPerSecond,
        (value) => value.diskWriteBytesPerSecond,
      ),
    ).toBe(900);
  });

  it("breaks the trace at a missing value instead of drawing it as zero", () => {
    const segments = traceSegments(history([0, 10], [5, null], [10, 30], [15, 40]), cpu, 12_000);
    expect(segments.map((segment) => segment.map((point) => point.value))).toEqual([
      [10],
      [30, 40],
    ]);
    expect(segments.flat().some((point) => point.value === 0)).toBe(false);
  });

  it("breaks the trace where readings stopped arriving", () => {
    const gap = missingReadingGap(5);
    const segments = traceSegments(history([0, 10], [5, 20], [60, 30], [65, 40]), cpu, gap);
    expect(segments.map((segment) => segment.map((point) => point.value))).toEqual([
      [10, 20],
      [30, 40],
    ]);
    expect(traceSegments(history([0, 10], [gap / 1000, 20]), cpu, gap)).toHaveLength(1);
  });

  it("reports how much of the range the history covers", () => {
    expect(coveredSeconds([], at(0), 120)).toBe(0);
    expect(coveredSeconds(history([0, 1], [40, 1]), at(40), 120)).toBe(40);
    expect(coveredSeconds(history([0, 1], [300, 1]), at(300), 120)).toBe(120);
    expect(formatCoverage(40)).toBe("40s");
    expect(formatCoverage(60)).toBe("1m");
    expect(formatCoverage(90)).toBe("1m 30s");
  });

  it("places readings on the chart by time with a fixed scale", () => {
    const frame = { start: at(0), rangeSeconds: 120, max: 100, width: 286, height: 46 };
    expect(chartPoint({ at: at(60), value: 50 }, frame)).toEqual({ x: 143, y: 23 });
    expect(chartPoint({ at: at(120), value: 0 }, frame)).toEqual({ x: 286, y: 45 });
    expect(chartPoint({ at: at(0), value: 250 }, frame).y).toBe(1);
    expect(tracePath([{ at: at(60), value: 50 }], frame)).toBe("M143.00,23.00 L143.01,23.00");
    expect(areaPath([{ at: at(60), value: 50 }], frame)).toBe("");
    expect(
      areaPath(
        [
          { at: at(0), value: 0 },
          { at: at(120), value: 100 },
        ],
        frame,
      ),
    ).toBe("M0.00,45.00 L286.00,1.00 L286.00,46 L0.00,46 Z");
  });

  it("scales rates to the next power of two above the peak", () => {
    expect(rateScale(null)).toBe(1024);
    expect(rateScale(0)).toBe(1024);
    expect(rateScale(13 * 1024 * 1024)).toBe(16 * 1024 * 1024);
    expect(rateScale(2048)).toBe(2048);
  });
});
