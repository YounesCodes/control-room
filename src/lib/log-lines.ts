export type LogLevel = "error" | "warning";
export type LogSegmentRole = "date" | "time" | "zone" | "source" | "message";
export type LogLevelFilter = "all" | LogLevel;

export interface LogSegment {
  role: LogSegmentRole;
  text: string;
}

export interface ParsedLogLine {
  /** Display text: the host line without terminal escapes or a trailing CR. */
  text: string;
  segments: LogSegment[];
  level: LogLevel | null;
  /** Separators written by Control Room or journalctl rather than the source. */
  marker: boolean;
}

// CSI and OSC sequences from colored container output. Rendering them as text
// adds noise; the log view does not interpret terminal colors.
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
// ISO 8601 at the start of a line: journalctl short-iso(-precise) and most
// application loggers. The date and zone read as context; the time stays scannable.
const ISO_PREFIX =
  /^(\d{4}-\d{2}-\d{2}[T ])(\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)(Z| ?UTC|[+-]\d{2}:?\d{2})?(?=\s)/;
// journalctl's "host identifier[pid]:" (kernel lines carry no PID).
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
// level=error, "level":"warn", "log.level": "INFO", severity=ERROR, ...
const FIELD_LEVEL =
  /(?:^|[\s{,;(])["']?(?:log\.)?(?:level|lvl|loglevel|severity)["']?\s*[=:]\s*["']?([A-Za-z]+)/;

/**
 * The level a line states itself: a level field, or an upper-case, bracketed,
 * or colon-terminated level among the first few words (`WARNING`, `[error]`,
 * `FATAL:`, `info:`). Returns undefined when the line states none.
 */
export function statedLogLevel(message: string): LogLevel | null | undefined {
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

export function parseLogLine(raw: string): ParsedLogLine {
  const text = cleanLogText(raw);
  if (STREAM_MARKER.test(text) || JOURNAL_MARKER.test(text))
    return { text, segments: [{ role: "message", text }], level: null, marker: true };

  const segments: LogSegment[] = [];
  let rest = text;
  const stamp = ISO_PREFIX.exec(rest);
  if (stamp) {
    segments.push({ role: "date", text: stamp[1] }, { role: "time", text: stamp[2] });
    if (stamp[3]) segments.push({ role: "zone", text: stamp[3] });
    rest = rest.slice(stamp[0].length);
    const source = JOURNAL_SOURCE.exec(rest);
    if (source) {
      segments.push({ role: "source", text: source[1] + source[2] });
      rest = rest.slice(source[0].length);
    }
  }
  if (rest) segments.push({ role: "message", text: rest });
  return { text, segments, level: logLevel(rest), marker: false };
}

/** Parses each distinct line once; streams re-render the same lines many times. */
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

/**
 * Splits each segment into plain and matching parts. Matches are found in the
 * whole line, case-insensitively, so a match may span a timestamp and message.
 */
export function highlightSegments(segments: LogSegment[], query: string): LogPart[][] {
  const needle = query.toLowerCase();
  const ranges: [number, number][] = [];
  const line = segments.map((segment) => segment.text).join("");
  const haystack = line.toLowerCase();
  // Lowercasing can change the length of a few scripts; skip marks rather than misplace them.
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
