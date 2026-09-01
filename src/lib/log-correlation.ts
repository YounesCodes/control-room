import type { CorrelatedLine, CorrelationSource, ParsedLogLine } from "../types";

// Every source Control Room can merge prints an RFC 3339 timestamp first:
// journald through `-o short-iso-precise`, Docker through `--timestamps`. One
// parser covers both, and anything else is treated as having no timestamp
// rather than guessed at.
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s(.*)$/;

export const MAX_LINES_PER_SOURCE = 500;
export const MAX_MERGED_LINES = 2000;

// Parses one line without touching its text. The message keeps whatever the
// source printed after the timestamp, including the journald host and unit
// prefix, so the merged view never rewrites a log line.
export function parseLogLine(text: string): ParsedLogLine {
  const match = TIMESTAMP.exec(text);
  if (!match) return { at: null, originalTimestamp: null, message: text };
  const at = Date.parse(match[1].replace(",", ".").replace(" ", "T"));
  if (!Number.isFinite(at)) return { at: null, originalTimestamp: null, message: text };
  return { at, originalTimestamp: match[1], message: match[2] };
}

interface RawLine {
  sourceId: string;
  sequence: number;
  arrivalOrder: number;
  arrivalAt: number;
  parsed: ParsedLogLine;
}

// One source's lines, bounded by count. Dropping is counted so the view can say
// how much history it let go rather than quietly shortening the record.
export class SourceLineBuffer {
  private lines: RawLine[] = [];
  private partial = "";
  private dropped = 0;

  constructor(
    readonly sourceId: string,
    private readonly maxLines = MAX_LINES_PER_SOURCE,
  ) {}

  append(chunk: string, arrivalOrder: () => number, now = Date.now()): void {
    if (!chunk) return;
    const parts = `${this.partial}${chunk}`.split("\n");
    this.partial = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.length) continue;
      this.lines.push({
        sourceId: this.sourceId,
        sequence: this.lines.length + this.dropped,
        arrivalOrder: arrivalOrder(),
        arrivalAt: now,
        parsed: parseLogLine(part.replace(/\r$/, "")),
      });
    }
    while (this.lines.length > this.maxLines) {
      this.lines.shift();
      this.dropped += 1;
    }
  }

  clear(): void {
    this.lines = [];
    this.partial = "";
    this.dropped = 0;
  }

  snapshot(): RawLine[] {
    return this.lines;
  }

  get droppedLines(): number {
    return this.dropped;
  }
}

// Merges the bounded per-source buffers into one chronological view.
//
// Ordering uses the parsed timestamp when there is one. A line without one
// falls back to the timestamp of the previous line from the same source, which
// keeps a stack trace attached to the line that produced it, and to its arrival
// time when the source has printed nothing dated yet. Both fallbacks are
// labelled in the result instead of being passed off as the source's own time.
//
// Ties break on source id then sequence, so the same input always renders in
// the same order.
export function mergeSources(
  buffers: SourceLineBuffer[],
  visibleSourceIds: string[],
  maxLines = MAX_MERGED_LINES,
): CorrelatedLine[] {
  const merged: CorrelatedLine[] = [];
  for (const buffer of buffers) {
    if (!visibleSourceIds.includes(buffer.sourceId)) continue;
    let lastKnown: number | null = null;
    for (const line of buffer.snapshot()) {
      const parsedAt = line.parsed.at;
      if (parsedAt !== null) lastKnown = parsedAt;
      const timeSource =
        parsedAt !== null ? "parsed" : lastKnown !== null ? "inherited" : "arrival";
      merged.push({
        key: `${line.sourceId}:${line.sequence}`,
        sourceId: line.sourceId,
        sequence: line.sequence,
        arrivalOrder: line.arrivalOrder,
        at: parsedAt ?? lastKnown ?? line.arrivalAt,
        timeSource,
        originalTimestamp: line.parsed.originalTimestamp,
        message: line.parsed.message,
        late: false,
      });
    }
  }
  merged.sort(
    (left, right) =>
      left.at - right.at ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.sequence - right.sequence,
  );
  markLateLines(merged);
  return merged.length > maxLines ? merged.slice(merged.length - maxLines) : merged;
}

// A line is late when something that reached Control Room earlier sorts below
// it: its arrival changed the order of lines already on screen. One reverse
// pass finds every such line.
function markLateLines(merged: CorrelatedLine[]): void {
  let minArrivalAfter = Number.POSITIVE_INFINITY;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const line = merged[index];
    line.late = line.arrivalOrder > minArrivalAfter;
    minArrivalAfter = Math.min(minArrivalAfter, line.arrivalOrder);
  }
}

export function sourceLabel(source: CorrelationSource): string {
  return source.label || source.target;
}

export function timeQualifier(line: CorrelatedLine): string | null {
  if (line.timeSource === "inherited") return "continues the previous line";
  if (line.timeSource === "arrival") return "no timestamp, ordered by arrival";
  return null;
}

export function formatLineTime(line: CorrelatedLine): string {
  const at = new Date(line.at);
  if (Number.isNaN(at.getTime())) return "unknown";
  const time = at.toLocaleTimeString(undefined, { hour12: false });
  const milliseconds = String(at.getMilliseconds()).padStart(3, "0");
  return `${time}.${milliseconds}`;
}

// Clock skew between hosts is real and Control Room cannot correct it. The view
// says so whenever more than one source is merged rather than implying the
// order is exact.
export function skewNotice(sources: CorrelationSource[]): string | null {
  const running = sources.filter((source) => source.state === "running");
  if (running.length < 2) return null;
  return "Ordering uses each source's own clock. Control Room does not adjust for skew between hosts.";
}

export function droppedNotice(buffers: SourceLineBuffer[]): string | null {
  const dropped = buffers.reduce((total, buffer) => total + buffer.droppedLines, 0);
  if (!dropped) return null;
  const sourceCount = buffers.filter((buffer) => buffer.droppedLines > 0).length;
  return `${dropped} older lines dropped from ${sourceCount} source${sourceCount === 1 ? "" : "s"} to stay within the memory bound.`;
}
