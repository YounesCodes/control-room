import type { HeaderMetric, HeaderMetrics } from "../types";
import { formatKib, memoryUsage } from "./host-resources";

export const DEFAULT_HEADER_METRICS: HeaderMetric[] = ["cpu", "ram", "gpu", "disk", "uptime"];
export const HEADER_METRIC_LABELS: Record<HeaderMetric, string> = {
  cpu: "CPU",
  ram: "RAM",
  gpu: "GPU",
  disk: "Disk",
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
  return `${minutes}m`;
}
export function headerMetricValue(metric: HeaderMetric, sample: HeaderMetrics | null): string {
  switch (metric) {
    case "cpu":
      return formatPercent(sample?.cpuPercent);
    case "gpu":
      return formatPercent(sample?.gpuPercent);
    case "ram":
      return formatPercent(memoryUsage(sample)?.percent);
    case "disk": {
      if (!sample || !sample.diskTotalKib || sample.diskFreeKib === null) return "Unavailable";
      return formatPercent(
        ((sample.diskTotalKib - sample.diskFreeKib) / sample.diskTotalKib) * 100,
      );
    }
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
    return `${sample.diskLabel}: ${formatKib(sample.diskTotalKib - sample.diskFreeKib)} of ${formatKib(sample.diskTotalKib)}`;
  }
  if (metric === "gpu") return "Busiest reported GPU engine or device";
  return metric === "cpu" ? "All processors combined" : "Time since this host started";
}
