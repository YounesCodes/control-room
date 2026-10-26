import type { HeaderMetric, HeaderMetrics } from "../types";
import { formatKib, memoryUsage } from "./host-resources";

export const DEFAULT_HEADER_METRICS: HeaderMetric[] = ["cpu", "ram", "gpu", "diskIo", "uptime"];
/** Older settings can still contain the retired filesystem-capacity metric. */
export function displayedHeaderMetrics(metrics: HeaderMetric[] = DEFAULT_HEADER_METRICS) {
  return metrics.filter((metric) => metric !== "disk");
}
export const HEADER_METRIC_LABELS: Record<HeaderMetric, string> = {
  cpu: "CPU",
  ram: "RAM",
  gpu: "GPU",
  disk: "Storage",
  diskIo: "Disk I/O",
  uptime: "Uptime",
};
export function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) || value < 0 || value > 100
    ? "Unavailable"
    : `${Math.round(value)}%`;
}
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : `${Math.floor(seconds)}s`;
}
export function formatByteRate(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${bytes.toFixed(unit > 0 && bytes < 10 ? 1 : 0)} ${units[unit]}`;
}

export function headerMetricNumber(
  metric: HeaderMetric,
  sample: HeaderMetrics | null,
): number | null {
  if (!sample) return null;
  if (metric === "diskIo") {
    const read = sample.diskReadBytesPerSecond,
      write = sample.diskWriteBytesPerSecond;
    return read != null &&
      write != null &&
      Number.isFinite(read) &&
      Number.isFinite(write) &&
      read >= 0 &&
      write >= 0 &&
      Number.isFinite(read + write)
      ? read + write
      : null;
  }
  if (metric === "disk") {
    const total = sample.diskTotalKib,
      free = sample.diskFreeKib;
    return total != null &&
      free != null &&
      Number.isFinite(total) &&
      Number.isFinite(free) &&
      total > 0 &&
      free >= 0 &&
      free <= total
      ? ((total - free) / total) * 100
      : null;
  }
  if (metric === "uptime") return null;
  if (metric === "ram") {
    if (
      sample.memoryTotalKib == null ||
      sample.memoryAvailableKib == null ||
      !Number.isFinite(sample.memoryTotalKib) ||
      !Number.isFinite(sample.memoryAvailableKib) ||
      sample.memoryTotalKib <= 0 ||
      sample.memoryAvailableKib < 0 ||
      sample.memoryAvailableKib > sample.memoryTotalKib
    )
      return null;
    return memoryUsage(sample)?.percent ?? null;
  }
  const number = metric === "cpu" ? sample.cpuPercent : sample.gpuPercent;
  return number != null && Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

/** Only measured CPU, RAM, and GPU points are drawn, on a fixed 0–100 scale. */
export function metricTrend(metric: HeaderMetric, samples: HeaderMetrics[]): string | null {
  if (metric !== "cpu" && metric !== "ram" && metric !== "gpu") return null;
  const values = samples.slice(-20).map((sample) => headerMetricNumber(metric, sample));
  if (!values.some((value) => value !== null)) return null;
  let drawing = false;
  return values
    .map((value, index) => {
      if (value === null) {
        drawing = false;
        return "";
      }
      const x = 1 + ((20 - values.length + index) * 32) / 19;
      const y = 13 - Math.min(1, value / 100) * 11;
      const point = `${drawing ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
      drawing = true;
      return point;
    })
    .join(" ");
}
export function headerMetricValue(metric: HeaderMetric, sample: HeaderMetrics | null): string {
  switch (metric) {
    case "cpu":
      return formatPercent(headerMetricNumber(metric, sample));
    case "gpu":
      return formatPercent(headerMetricNumber(metric, sample));
    case "ram":
      return formatPercent(headerMetricNumber(metric, sample));
    case "disk":
      return formatPercent(headerMetricNumber(metric, sample));
    case "diskIo":
      return headerMetricNumber(metric, sample) === null
        ? "Unavailable"
        : `Read ${formatByteRate(sample!.diskReadBytesPerSecond)} · Write ${formatByteRate(sample!.diskWriteBytesPerSecond)}`;
    case "uptime":
      return formatUptime(sample?.uptimeSeconds);
  }
}
export function headerMetricDetail(metric: HeaderMetric, sample: HeaderMetrics | null): string {
  if (!sample) return "Waiting for a reading";
  const value = headerMetricValue(metric, sample);
  if (value === "Unavailable") return "This host did not report a reading";
  if (metric === "ram" && sample.memoryTotalKib !== null && sample.memoryAvailableKib !== null) {
    return `${formatKib(sample.memoryTotalKib - sample.memoryAvailableKib)} of ${formatKib(sample.memoryTotalKib)}`;
  }
  if (metric === "disk" && sample.diskTotalKib !== null && sample.diskFreeKib !== null) {
    const label = sample.diskLabel?.replace(/:+$/, "") || "Filesystem";
    return `${label}: ${formatKib(sample.diskTotalKib - sample.diskFreeKib)} of ${formatKib(sample.diskTotalKib)}`;
  }
  if (metric === "gpu") return "Busiest reported GPU engine or device";
  if (metric === "diskIo") return "All disks · Read and write transfer rates";
  return metric === "cpu" ? "All processors combined" : "Time since this host started";
}

export function formatReadingTime(sampledAt: string): string {
  const time = Date.parse(sampledAt);
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString() : "Unavailable";
}
