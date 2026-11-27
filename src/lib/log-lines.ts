export type LogLevel = "error" | "warning";
export type LogSegmentRole =
  "date" | "separator" | "time" | "fraction" | "zone" | "source" | "repeated-time" | "message";
export type LogLevelFilter = "all" | LogLevel;

export interface LogSegment {
  role: LogSegmentRole;
  text: string;
}

export interface ParsedLogLine {
  text: string;
  segments: LogSegment[];
  level: LogLevel | null;
  marker: boolean;
}

// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const ISO_PREFIX =
  /^(\d{4}-\d{2}-\d{2})([T ])(\d{2}:\d{2}:\d{2})([.,]\d+)?(Z| ?UTC|[+-]\d{2}:?\d{2})?(?=\s)/;
const INNER_TIME = String.raw`(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?: ?(Z|UTC|GMT|[+-]\d{2}:?\d{2}))?(?![\d:])`;
const INNER_STAMP = new RegExp(
  String.raw`^(\s*(?:[[(]|(?:time|ts|t|timestamp)="?|\{[^{}]{0,60}?"(?:time|timestamp|ts|@timestamp)"\s*:\s*")?)` +
    INNER_TIME,
);
const REPEATED_TIME_WINDOW_MS = 2_000;
const JOURNAL_SOURCE = /^(\s+)(\S+ (?:[^\s:[\]]+\[\d+\]|kernel):)(?=\s|$)/;
const STREAM_MARKER = /^\[(?:systemd|docker) .+\] stream started$/;
const JOURNAL_MARKER = /^-- .+ --$/;
const ERROR_TERMS =
  /\b(?:emerg(?:ency)?|alert|crit(?:ical)?|fatal|panic(?:ked)?|err(?:or|ors)?|fail(?:ed|ure|s)?|exception|traceback|segfault)\b/i;
const WARNING_TERMS = /\b(?:warn(?:ing|ings)?|deprecated)\b/i;

export function cleanLogText(line: string): string {
  return line.replace(TERMINAL_ESCAPES, "").replace(/\r+$/, "");
}

const LEVEL_WORDS: Record<string, LogLevel | null> = {
  emerg: "error",
  emergency: "error",
  alert: "error",
  crit: "error",
  critical: "error",
  fatal: "error",
  panic: "error",
  severe: "error",
  err: "error",
  error: "error",
  warn: "warning",
  warning: "warning",
  notice: null,
  info: null,
  information: null,
  log: null,
  debug: null,
  trace: null,
  verbose: null,
};
const FIELD_LEVEL =
  /(?:^|[\s{,;(])["']?(?:log\.)?(?:level|lvl|loglevel|severity)["']?\s*[=:]\s*["']?([A-Za-z]+)/;

function statedLogLevel(message: string): LogLevel | null | undefined {
  const field = FIELD_LEVEL.exec(message)?.[1].toLowerCase();
  if (field && field in LEVEL_WORDS) return LEVEL_WORDS[field];
  for (const token of message.trimStart().split(/\s+/, 5)) {
    const match = /^[[(<]?([A-Za-z]+)([\])>:]*)$/.exec(token);
    if (!match) continue;
    const [, word, close] = match;
    const lower = word.toLowerCase();
    if (!(lower in LEVEL_WORDS)) continue;
    const marked = token !== word && (close || /^[[(<]/.test(token));
    if (word === word.toUpperCase() || marked) return LEVEL_WORDS[lower];
  }
  return undefined;
}

export function logLevel(message: string): LogLevel | null {
  const stated = statedLogLevel(message);
  if (stated !== undefined) return stated;
  if (ERROR_TERMS.test(message)) return "error";
  if (WARNING_TERMS.test(message)) return "warning";
  return null;
}

interface WallClock {
  ms: number;
  offsetMinutes: number | null;
}

function wallClock(
  date: string,
  time: string,
  fraction: string | undefined,
  zone: string | undefined,
): WallClock {
  const [year, month, day] = date.split(/[-/]/).map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const millis = fraction ? Number(`0.${fraction.replace(/^[.,]/, "")}`) * 1000 : 0;
  return {
    ms: Date.UTC(year, month - 1, day, hour, minute, second, millis),
    offsetMinutes: zoneOffsetMinutes(zone),
  };
}

function zoneOffsetMinutes(zone: string | undefined): number | null {
  const value = zone?.trim();
  if (!value) return null;
  if (value === "Z" || value === "UTC" || value === "GMT") return 0;
  const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (!offset) return null;
  return (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
}

function repeatsOuterTime(outer: WallClock, inner: WallClock) {
  const outerOffset = outer.offsetMinutes ?? 0;
  const instant = outer.ms - outerOffset * 60_000;
  const candidates =
    inner.offsetMinutes === null
      ? [inner.ms, inner.ms - outerOffset * 60_000]
      : [inner.ms - inner.offsetMinutes * 60_000];
  return candidates.some((candidate) => Math.abs(candidate - instant) <= REPEATED_TIME_WINDOW_MS);
}

function messageSegments(message: string, outer: WallClock | null): LogSegment[] {
  const inner = outer && INNER_STAMP.exec(message);
  if (
    !inner ||
    !repeatsOuterTime(
      outer,
      wallClock(
        `${inner[2]}-${inner[3]}-${inner[4]}`,
        `${inner[5]}:${inner[6]}:${inner[7]}`,
        inner[8],
        inner[9],
      ),
    )
  )
    return [{ role: "message", text: message }];
  const start = inner[1].length;
  const end = inner[0].length;
  return [
    { role: "message" as const, text: message.slice(0, start) },
    { role: "repeated-time" as const, text: message.slice(start, end) },
    { role: "message" as const, text: message.slice(end) },
  ].filter((segment) => segment.text);
}

export function parseLogLine(raw: string): ParsedLogLine {
  const text = cleanLogText(raw);
  if (STREAM_MARKER.test(text) || JOURNAL_MARKER.test(text))
    return { text, segments: [{ role: "message", text }], level: null, marker: true };

  const segments: LogSegment[] = [];
  let rest = text;
  let outer: WallClock | null = null;
  const stamp = ISO_PREFIX.exec(rest);
  if (stamp) {
    outer = wallClock(stamp[1], stamp[3], stamp[4], stamp[5]);
    segments.push(
      { role: "date", text: stamp[1] },
      { role: "separator", text: stamp[2] },
      { role: "time", text: stamp[3] },
    );
    if (stamp[4]) segments.push({ role: "fraction", text: stamp[4] });
    if (stamp[5]) segments.push({ role: "zone", text: stamp[5] });
    rest = rest.slice(stamp[0].length);
    const source = JOURNAL_SOURCE.exec(rest);
    if (source) {
      segments.push({ role: "source", text: source[1] + source[2] });
      rest = rest.slice(source[0].length);
    }
  }
  if (rest) segments.push(...messageSegments(rest, outer));
  return { text, segments, level: logLevel(rest), marker: false };
}

export class LogLineCache {
  private entries = new Map<string, ParsedLogLine>();

  constructor(private readonly limit = 30_000) {}

  get(raw: string): ParsedLogLine {
    let parsed = this.entries.get(raw);
    if (!parsed) {
      if (this.entries.size >= this.limit) this.entries.clear();
      parsed = parseLogLine(raw);
      this.entries.set(raw, parsed);
    }
    return parsed;
  }
}

export interface LogPart {
  text: string;
  match: boolean;
}

export function highlightSegments(segments: LogSegment[], query: string): LogPart[][] {
  const needle = query.toLowerCase();
  const ranges: [number, number][] = [];
  const line = segments.map((segment) => segment.text).join("");
  const haystack = line.toLowerCase();
  // Lowercasing changes the length of some scripts.
  if (needle && haystack.length === line.length) {
    for (
      let at = haystack.indexOf(needle);
      at >= 0;
      at = haystack.indexOf(needle, at + needle.length)
    )
      ranges.push([at, at + needle.length]);
  }
  let offset = 0;
  return segments.map(({ text }) => {
    const start = offset;
    const end = start + text.length;
    offset = end;
    const parts: LogPart[] = [];
    let cursor = start;
    for (const [from, to] of ranges) {
      if (to <= cursor || from >= end) continue;
      const matchStart = Math.max(from, cursor);
      const matchEnd = Math.min(to, end);
      if (matchStart > cursor)
        parts.push({ text: text.slice(cursor - start, matchStart - start), match: false });
      parts.push({ text: text.slice(matchStart - start, matchEnd - start), match: true });
      cursor = matchEnd;
    }
    if (cursor < end || !parts.length)
      parts.push({ text: text.slice(cursor - start), match: false });
    return parts;
  });
}

export function lineMatches(line: ParsedLogLine, query: string, level: LogLevelFilter): boolean {
  if (level !== "all" && line.level !== level) return false;
  return !query || line.text.toLowerCase().includes(query.toLowerCase());
}
