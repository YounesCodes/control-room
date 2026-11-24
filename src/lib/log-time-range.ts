const HOUR = 60 * 60 * 1000;

export const LOG_TIME_PRESETS = [
  { id: "15m", label: "Last 15 min", duration: HOUR / 4 },
  { id: "1h", label: "Last hour", duration: HOUR },
  { id: "24h", label: "Last 24 hours", duration: 24 * HOUR },
] as const;

export interface LogTimeBounds {
  start: number;
  end: number;
}

export type LogTimeRange =
  { mode: (typeof LOG_TIME_PRESETS)[number]["id"] } | { mode: "custom"; bounds: LogTimeBounds };

export function logTimeBounds(range: LogTimeRange, now = Date.now()): LogTimeBounds {
  if (range.mode === "custom") return range.bounds;
  const preset = LOG_TIME_PRESETS.find(({ id }) => id === range.mode)!;
  const end = Math.ceil(now / 1000);
  return { start: end - preset.duration / 1000, end };
}

export function localTimeInput(seconds: number): string {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function parseLocalTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const seconds = new Date(value).getTime() / 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || localTimeInput(seconds) !== value) return null;
  return seconds;
}

export function logTimeLabel(range: LogTimeRange | null): string {
  if (!range) return "Time range";
  if (range.mode === "custom") return "Custom range";
  return LOG_TIME_PRESETS.find(({ id }) => id === range.mode)!.label;
}
