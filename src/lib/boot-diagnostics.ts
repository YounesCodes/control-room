import type { BootRecord } from "../types";

// systemd writes durations as a compact human string rather than a number:
// "1min 2.345s", "4.523s", "532ms". Drawing one row against another needs a
// magnitude, so this reads the string back into milliseconds. Anything it does
// not recognise returns null, and the row then renders without a bar instead of
// guessing a width from a value nobody parsed.
const UNIT_MILLIS: Record<string, number> = {
  h: 3_600_000,
  min: 60_000,
  s: 1000,
  ms: 1,
  us: 0.001,
};

// "min" and "ms" both start with "m", so the longer units come first.
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(min|ms|us|h|s)\b/g;

export function durationToMillis(value: string): number | null {
  let total = 0;
  let matched = false;
  for (const part of value.matchAll(DURATION_PART)) {
    const amount = Number(part[1]);
    const unit = UNIT_MILLIS[part[2]];
    if (!Number.isFinite(amount) || unit === undefined) continue;
    total += amount * unit;
    matched = true;
  }
  return matched ? total : null;
}

// journalctl indexes boots as 0 for the running one and negative numbers going
// back. "Previous boot -2" is how that reads if the raw index reaches the UI.
export function bootLabel(boot: BootRecord): string {
  if (boot.current) return "Current boot";
  const distance = Math.abs(boot.index);
  return distance === 1 ? "1 boot ago" : `${distance} boots ago`;
}

// `-o short-iso-precise` prefixes every entry with an ISO timestamp. Splitting
// it off lets the time sit in its own column instead of pushing every message
// out of alignment. A line that does not carry one is kept whole.
const ISO_PREFIX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.+)$/;

export interface JournalLine {
  /** Wall-clock time only. Every entry shares the boot's date. */
  time: string | null;
  /** The full timestamp, kept for the row's tooltip. */
  timestamp: string | null;
  message: string;
}

export function splitJournalLine(line: string): JournalLine {
  const match = ISO_PREFIX.exec(line);
  if (!match) return { time: null, timestamp: null, message: line };
  const [, timestamp, message] = match;
  const clock = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
  return { time: clock ? clock[1] : timestamp, timestamp, message };
}

// A sample that stopped at its cap is not the same as one that ran out of
// entries, and the difference decides whether the user should widen the read.
export function sampleHint(count: number, cap: number): string {
  if (!count) return "none returned";
  return count >= cap ? `at the ${cap}-entry cap` : `priority warning and above`;
}
