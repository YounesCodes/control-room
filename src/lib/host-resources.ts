import type { HostResources } from "../types";

/** How much of a total is in use, with the total kept so the UI can say "of". */
export interface ResourceUsage {
  usedKib: number;
  totalKib: number;
  percent: number;
}

const BINARY_UNITS = ["KiB", "MiB", "GiB", "TiB"];

// meminfo counts in KiB. Sizes are rendered in binary units because that is
// what the kernel reported; converting to decimal GB would quietly restate the
// number as something the host never said.
export function formatKib(kib: number | null): string | null {
  if (kib === null || !Number.isFinite(kib) || kib < 0) return null;
  let value = kib;
  let unit = 0;
  while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BINARY_UNITS[unit]}`;
}

// Used is total minus available, not total minus free. MemAvailable already
// discounts page cache and reclaimable slab, so this does not report a healthy
// host that is caching aggressively as being out of memory.
export function memoryUsage(resources: HostResources | null): ResourceUsage | null {
  if (!resources) return null;
  return usageFrom(resources.memoryTotalKib, resources.memoryAvailableKib);
}

export function swapUsage(resources: HostResources | null): ResourceUsage | null {
  if (!resources) return null;
  return usageFrom(resources.swapTotalKib, resources.swapFreeKib);
}

function usageFrom(total: number | null, free: number | null): ResourceUsage | null {
  if (total === null || free === null || total <= 0) return null;
  const usedKib = Math.min(Math.max(total - free, 0), total);
  return { usedKib, totalKib: total, percent: (usedKib / total) * 100 };
}

// `uptime -p` writes prose: "up 1 week, 2 days, 2 hours, 55 minutes". At the
// size a stat value renders that wraps to two lines and buries the number, so
// only the two largest units survive.
const UPTIME_UNITS: [RegExp, string][] = [
  [/^years?$/, "y"],
  [/^months?$/, "mo"],
  [/^weeks?$/, "w"],
  [/^days?$/, "d"],
  [/^hours?$/, "h"],
  [/^minutes?$/, "m"],
  [/^seconds?$/, "s"],
];

export function compactUptime(value: string | null, maxParts = 2): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith("up ") ? trimmed.slice(3) : trimmed;
  const parts: string[] = [];
  for (const segment of withoutPrefix.split(",")) {
    const words = segment.trim().split(/\s+/);
    if (words.length < 2) continue;
    const amount = Number(words[0]);
    if (!Number.isFinite(amount)) continue;
    const unit = UPTIME_UNITS.find(([pattern]) => pattern.test(words[1]));
    if (!unit) continue;
    parts.push(`${amount}${unit[1]}`);
    if (parts.length === maxParts) break;
  }
  // An unfamiliar shape is shown verbatim rather than dropped.
  return parts.length ? parts.join(" ") : trimmed;
}

/**
 * Builds the stroke for a sparkline. Samples are plotted against a fixed
 * ceiling rather than the window's own maximum, so a flat idle line stays at
 * the bottom instead of being rescaled to look busy.
 */
export function sparklinePath(
  values: number[],
  width: number,
  height: number,
  ceiling = 100,
): string {
  const points = pointsFor(values, width, height, ceiling);
  if (!points.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point}`).join(" ");
}

/** The same shape closed to the baseline, for a fill under the stroke. */
export function sparklineAreaPath(
  values: number[],
  width: number,
  height: number,
  ceiling = 100,
): string {
  const points = pointsFor(values, width, height, ceiling);
  if (!points.length) return "";
  const last = (values.length - 1) * (width / Math.max(values.length - 1, 1));
  return `M0,${height} L${points.join(" L")} L${last.toFixed(2)},${height} Z`;
}

function pointsFor(values: number[], width: number, height: number, ceiling: number): string[] {
  if (values.length < 2 || ceiling <= 0) return [];
  const step = width / (values.length - 1);
  return values.map((value, index) => {
    const clamped = Math.min(Math.max(value, 0), ceiling);
    const x = index * step;
    const y = height - (clamped / ceiling) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
}
