import type { HeaderMetrics } from "../types";

export const METRIC_RANGES = [
  { seconds: 60, label: "1m" },
  { seconds: 120, label: "2m" },
  { seconds: 600, label: "10m" },
] as const;
export type MetricRangeSeconds = (typeof METRIC_RANGES)[number]["seconds"];
export const DEFAULT_METRIC_RANGE: MetricRangeSeconds = 120;
export const METRIC_HISTORY_SECONDS = 600;
export const CHART_WIDTH = 286;
export const CHART_HEIGHT = 46;

export function formatCoverage(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${rest}s`;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export interface TimedReading {
  at: number;
  sample: HeaderMetrics;
}

export type ReadingValue = (sample: HeaderMetrics) => number | null;

export interface TracePoint {
  at: number;
  value: number;
}

export function readingTime(sample: HeaderMetrics): number {
  return Date.parse(sample.sampledAt);
}

export function appendReading(history: TimedReading[], sample: HeaderMetrics): TimedReading[] {
  const at = readingTime(sample);
  if (!Number.isFinite(at)) return history;
  const oldest = at - METRIC_HISTORY_SECONDS * 1000;
  return [...history.filter((reading) => reading.at < at && reading.at >= oldest), { at, sample }];
}

export function missingReadingGap(intervalSeconds: number): number {
  return (intervalSeconds * 2 + 2) * 1000;
}

export function readingsInRange(
  history: TimedReading[],
  end: number,
  rangeSeconds: number,
): TimedReading[] {
  const start = end - rangeSeconds * 1000;
  return history.filter((reading) => reading.at >= start && reading.at <= end);
}

export function traceSegments(
  readings: TimedReading[],
  value: ReadingValue,
  gap: number,
): TracePoint[][] {
  const segments: TracePoint[][] = [];
  let current: TracePoint[] = [];
  let previousAt: number | null = null;
  for (const reading of readings) {
    const reported = value(reading.sample);
    const continues = previousAt !== null && reading.at - previousAt <= gap;
    if (current.length && (reported === null || !continues)) {
      segments.push(current);
      current = [];
    }
    if (reported !== null) current.push({ at: reading.at, value: reported });
    previousAt = reading.at;
  }
  if (current.length) segments.push(current);
  return segments;
}

export function peakReading(readings: TimedReading[], ...values: ReadingValue[]): number | null {
  let peak: number | null = null;
  for (const reading of readings)
    for (const value of values) {
      const reported = value(reading.sample);
      if (reported !== null && (peak === null || reported > peak)) peak = reported;
    }
  return peak;
}

export function coveredSeconds(history: TimedReading[], end: number, rangeSeconds: number): number {
  const first = history[0]?.at;
  if (first === undefined || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.min(rangeSeconds, Math.floor((end - first) / 1000)));
}

export interface ChartFrame {
  start: number;
  rangeSeconds: number;
  max: number;
  width: number;
  height: number;
}

export function chartPoint(point: TracePoint, frame: ChartFrame): { x: number; y: number } {
  const x = ((point.at - frame.start) / (frame.rangeSeconds * 1000)) * frame.width;
  const share = frame.max > 0 ? Math.min(1, Math.max(0, point.value / frame.max)) : 0;
  return { x, y: frame.height - share * (frame.height - 2) - 1 };
}

export function tracePath(segment: TracePoint[], frame: ChartFrame): string {
  const points = segment.map((point) => chartPoint(point, frame));
  if (points.length === 1) points.push({ ...points[0], x: points[0].x + 0.01 });
  return points
    .map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
}

export function areaPath(segment: TracePoint[], frame: ChartFrame): string {
  if (segment.length < 2) return "";
  const first = chartPoint(segment[0], frame);
  const last = chartPoint(segment.at(-1)!, frame);
  return `${tracePath(segment, frame)} L${last.x.toFixed(2)},${frame.height} L${first.x.toFixed(2)},${frame.height} Z`;
}

export function rateScale(peak: number | null): number {
  if (peak === null || peak <= 0) return 1024;
  return 2 ** Math.ceil(Math.log2(peak));
}
