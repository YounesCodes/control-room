import type { OverviewDiagnostics } from "../types";

export function memoryPercent(memory: OverviewDiagnostics["memory"] | undefined): number | null {
  const total = memory?.totalKib,
    available = memory?.availableKib;
  return total != null && available != null && total > 0 && available >= 0 && available <= total
    ? ((total - available) * 100) / total
    : null;
}

/** Missing devices or counters must break the line rather than inventing zero. */
export function sumRates(values: (number | null)[] | undefined): number | null {
  return values?.length &&
    values.every((value) => value != null && Number.isFinite(value) && value >= 0)
    ? values.reduce<number>((sum, value) => sum + value!, 0)
    : null;
}

export function chartPath(
  points: { time: number; value: number | null }[],
  start: number,
  end: number,
  max: number,
): string {
  let drawing = false;
  return points
    .map((point) => {
      if (
        point.value == null ||
        !Number.isFinite(point.value) ||
        point.value < 0 ||
        !Number.isFinite(point.time)
      ) {
        drawing = false;
        return "";
      }
      const x = 2 + Math.max(0, Math.min(1, (point.time - start) / Math.max(1, end - start))) * 396;
      const y = 76 - Math.min(1, point.value / Math.max(1, max)) * 72;
      const segment = `${drawing ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      drawing = true;
      return segment;
    })
    .join(" ");
}
