import type { BootReplayEntry, BootReplayPage } from "../types";

/** Microseconds per second; journald reports all offsets in microseconds. */
export const US_PER_SECOND = 1_000_000;

export const BOOT_REPLAY_WINDOW_OPTIONS = [30, 60, 120, 300, 600] as const;
export const MIN_BOOT_REPLAY_WINDOW_SECONDS = 10;
export const MAX_BOOT_REPLAY_WINDOW_SECONDS = 30 * 60;
export const DEFAULT_BOOT_REPLAY_WINDOW_SECONDS = 120;

/** Auto-paged reads allowed per selection before the user has to ask for the
 * rest. Keeps one boot selection from walking a chatty journal forever. */
export const MAX_AUTO_REPLAY_PAGES = 4;
export const MAX_REPLAY_EVENTS = 5000;

/** A page whose streams both stop at the cap stays resumable through the
 * journal cursors; nothing pretends the loaded slice was the whole story. */
export const BOOT_REPLAY_SPEEDS = [0.5, 1, 2, 5, 10] as const;

export function normalizeWindowSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BOOT_REPLAY_WINDOW_SECONDS;
  const seconds = Math.round(value);
  return Math.min(
    MAX_BOOT_REPLAY_WINDOW_SECONDS,
    Math.max(MIN_BOOT_REPLAY_WINDOW_SECONDS, seconds),
  );
}

export function windowMicroseconds(seconds: number): number {
  return normalizeWindowSeconds(seconds) * US_PER_SECOND;
}

export type ReplayEventCategory = "milestone" | "unit" | "warning" | "error" | "journal";

/** A retained journal record, classified conservatively: `observed` means the
 * message exists in this boot's journal, not that the system state is proved. */
export interface ReplayEvent {
  id: string;
  /** Boot-relative offset in microseconds, or `null` when journald recorded
   * no monotonic time. Untimed events stay off the timeline axis and are only
   * listed in the journal lane. */
  offsetUs: number | null;
  realtimeUs: number | null;
  priority: number | null;
  source: string | null;
  unit: string | null;
  message: string;
  messageTruncated: boolean;
  category: ReplayEventCategory;
  provenance: "journal";
  classification: "observed";
}

// Conservative, evidence-first classification rules. Priorities are syslog:
// 0-3 are failures in some form, 4 is a warning, anything above is
// informational. systemd's own lifecycle prose gets its lane, and everything
// else stays a plain journal record instead of a stage transition.
const MILESTONE_MESSAGES = [/^Reached target /, /^Startup finished in /];
const UNIT_LIFECYCLE_MESSAGES = [
  /^Starting /,
  /^Started /,
  /^Stopping /,
  /^Stopped /,
  /^Deactivated /,
  /^Mounted /,
  /^Mounting /,
  /^Reloading /,
  /^Triggering /,
  /^Scheduled restart /,
  /^Finished /,
];
const FAILING_MESSAGES = [
  /^Failed to start /,
  /^Failed with result /,
  /^Unit .* entered failed state/,
];

function isSystemdSource(source: string | null): boolean {
  return source === "systemd";
}

export function classifyReplayEntry(entry: BootReplayEntry): ReplayEventCategory {
  const message = entry.message.trimStart();
  if (entry.priority !== null && entry.priority <= 3) return "error";
  if (entry.priority === 4) return "warning";
  if (isSystemdSource(entry.source)) {
    if (FAILING_MESSAGES.some((pattern) => pattern.test(message))) return "error";
    if (MILESTONE_MESSAGES.some((pattern) => pattern.test(message))) return "milestone";
    if (UNIT_LIFECYCLE_MESSAGES.some((pattern) => pattern.test(message))) return "unit";
  }
  return "journal";
}

export function toReplayEvent(entry: BootReplayEntry): ReplayEvent {
  return {
    id: entry.id,
    offsetUs: entry.monotonicUs,
    realtimeUs: entry.realtimeUs,
    priority: entry.priority,
    source: entry.source,
    unit: entry.unit,
    message: entry.message,
    messageTruncated: entry.messageTruncated,
    category: classifyReplayEntry(entry),
    provenance: "journal",
    classification: "observed",
  };
}

/** syslog severity names, for labels that walk numbers back to words. */
export function replayPriorityLabel(priority: number | null): string | null {
  const labels = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"];
  return priority === null || priority < 0 || priority > 7 ? null : labels[priority];
}

export interface ReplayEvidence {
  /** Timed events sorted by offset; the playhead reveals these in order. */
  timedEvents: ReplayEvent[];
  /** Records without a boot-relative offset; listed, never plotted. */
  untimedEvents: ReplayEvent[];
  managerCursor: string | null;
  alertCursor: string | null;
  managerTruncated: boolean;
  alertTruncated: boolean;
  earliestMonotonicUs: number | null;
  latestMonotonicUs: number | null;
  permissionRequired: boolean;
  errors: string[];
  /** Highest offset loaded so far, or `null` before any timed evidence. */
  lastLoadedOffsetUs: number | null;
  managerLastOffsetUs: number | null;
  alertLastOffsetUs: number | null;
  limitReached: boolean;
  loadedCount: number;
}

export function emptyReplayEvidence(): ReplayEvidence {
  return {
    timedEvents: [],
    untimedEvents: [],
    managerCursor: null,
    alertCursor: null,
    managerTruncated: false,
    alertTruncated: false,
    earliestMonotonicUs: null,
    latestMonotonicUs: null,
    permissionRequired: false,
    errors: [],
    lastLoadedOffsetUs: null,
    managerLastOffsetUs: null,
    alertLastOffsetUs: null,
    limitReached: false,
    loadedCount: 0,
  };
}

function compareTimedEvents(left: ReplayEvent, right: ReplayEvent): number {
  // Both lists only hold timed events, but the compiler cannot know that.
  const leftOffset = left.offsetUs ?? Number.MAX_SAFE_INTEGER;
  const rightOffset = right.offsetUs ?? Number.MAX_SAFE_INTEGER;
  if (leftOffset !== rightOffset) return leftOffset - rightOffset;
  const leftRealtime = left.realtimeUs ?? Number.MAX_SAFE_INTEGER;
  const rightRealtime = right.realtimeUs ?? Number.MAX_SAFE_INTEGER;
  if (leftRealtime !== rightRealtime) return leftRealtime - rightRealtime;
  return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
}

/** Merges one page into the accumulated evidence. Entries are identified by
 * their journal cursor, so a page fetched twice or a record that appears in
 * both streams stays a single event. The result is always sorted, so seeking
 * backward and re-deriving the reveal state is deterministic. */
export function mergeReplayEvidence(
  previous: ReplayEvidence | null,
  page: BootReplayPage,
): ReplayEvidence {
  const merged: ReplayEvidence = previous
    ? {
        ...previous,
        timedEvents: [...previous.timedEvents],
        untimedEvents: [...previous.untimedEvents],
      }
    : emptyReplayEvidence();
  merged.errors = [...new Set([...(previous?.errors ?? []), ...page.errors])].slice(0, 20);
  const ids = new Set([...merged.timedEvents, ...merged.untimedEvents].map((event) => event.id));
  for (const entry of [...page.managerEvents, ...page.alertEvents]) {
    if (ids.has(entry.id)) continue;
    if (ids.size >= MAX_REPLAY_EVENTS) {
      merged.limitReached = true;
      break;
    }
    ids.add(entry.id);
    const event = toReplayEvent(entry);
    if (event.offsetUs === null) {
      merged.untimedEvents.push(event);
    } else {
      merged.timedEvents.push(event);
    }
  }
  merged.timedEvents.sort(compareTimedEvents);
  merged.untimedEvents.sort(compareTimedEvents);
  merged.managerCursor = page.managerNextCursor;
  merged.alertCursor = page.alertNextCursor;
  merged.managerTruncated = page.managerTruncated;
  merged.alertTruncated = page.alertTruncated;
  merged.earliestMonotonicUs = previous?.earliestMonotonicUs ?? page.earliestMonotonicUs ?? null;
  merged.latestMonotonicUs = previous?.latestMonotonicUs ?? page.latestMonotonicUs ?? null;
  merged.permissionRequired = page.permissionRequired;
  merged.loadedCount = merged.timedEvents.length + merged.untimedEvents.length;
  merged.limitReached ||= merged.loadedCount >= MAX_REPLAY_EVENTS;
  const lastOffset = (events: BootReplayEntry[]) =>
    events.reduce<number | null>(
      (last, event) => (event.monotonicUs === null ? last : Math.max(last ?? 0, event.monotonicUs)),
      null,
    );
  merged.managerLastOffsetUs =
    lastOffset(page.managerEvents) ?? previous?.managerLastOffsetUs ?? null;
  merged.alertLastOffsetUs = lastOffset(page.alertEvents) ?? previous?.alertLastOffsetUs ?? null;
  merged.lastLoadedOffsetUs = merged.timedEvents.length
    ? merged.timedEvents[merged.timedEvents.length - 1].offsetUs
    : null;
  return merged;
}

/** Number of loaded events at or before `positionUs`. The list stays sorted,
 * so this is a binary search, not a scan, and the playhead can call it every
 * frame without re-reading the whole boot. */
export function upperBound(events: ReplayEvent[], positionUs: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const offset = events[middle].offsetUs;
    if (offset !== null && offset <= positionUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Markers worth skipping to: failures and warnings first; with none of
 * those, milestones; with none of those, unit lifecycle events. A clustered
 * repeat burst counts as one stop, not one per message. */
export function notableReplayMarkers(markers: ReplayMarker[]): ReplayMarker[] {
  const failures = markers.filter(
    (marker) => marker.category === "error" || marker.category === "warning",
  );
  if (failures.length) return failures;
  const milestones = markers.filter((marker) => marker.category === "milestone");
  if (milestones.length) return milestones;
  return markers.filter((marker) => marker.category === "unit");
}

/** The next marker that starts after the playhead, or `null` at the end. */
export function nextNotableMarker(
  markers: ReplayMarker[],
  positionUs: number,
): ReplayMarker | null {
  return notableReplayMarkers(markers).find((marker) => marker.offsetUs > positionUs) ?? null;
}

/** The last marker that fully precedes the playhead, or `null` at the start. */
export function previousNotableMarker(
  markers: ReplayMarker[],
  positionUs: number,
): ReplayMarker | null {
  const notable = notableReplayMarkers(markers);
  for (let index = notable.length - 1; index >= 0; index -= 1) {
    const marker = notable[index];
    if (marker.spanUs[1] < positionUs) return marker;
  }
  return null;
}

/** Markers =============================== */

export interface ReplayMarker {
  key: string;
  category: ReplayEventCategory;
  label: string;
  count: number;
  offsetUs: number;
  /** Offsets of every clustered event, first to last. */
  spanUs: [number, number];
  events: ReplayEvent[];
  similar?: boolean;
}

/** Repetitive records collapse into one marker: same lane, near-identical
 * message, and within a short gap. Chatty journals stay readable without
 * hiding that there were more of them. */
function clusterFingerprint(event: ReplayEvent): string {
  return `${event.category}:${event.message
    .toLowerCase()
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()}`;
}

export function groupReplayMarkers(events: ReplayEvent[], windowUs: number): ReplayMarker[] {
  const gapUs = Math.min(US_PER_SECOND, Math.round(windowUs * 0.02));
  const markers: ReplayMarker[] = [];
  let cluster: ReplayEvent[] = [];
  let fingerprint = "";
  const flush = () => {
    if (!cluster.length) return;
    const offsets = cluster.map((event) => event.offsetUs ?? 0);
    markers.push({
      key: `${cluster[0].category}:${offsets[0]}:${cluster[0].id}`,
      category: cluster[0].category,
      label: cluster[0].message,
      count: cluster.length,
      offsetUs: offsets[0],
      spanUs: [offsets[0], offsets[offsets.length - 1]],
      events: [...cluster],
      similar: true,
    });
    cluster = [];
  };
  for (const event of events) {
    const eventFingerprint = clusterFingerprint(event);
    const previous = cluster[cluster.length - 1];
    const withinGap =
      previous !== undefined &&
      event.offsetUs !== null &&
      previous.offsetUs !== null &&
      event.offsetUs - previous.offsetUs <= gapUs;
    if (previous !== undefined && (eventFingerprint !== fingerprint || !withinGap)) {
      flush();
      fingerprint = "";
    }
    if (!cluster.length) fingerprint = eventFingerprint;
    cluster.push(event);
  }
  flush();
  return markers;
}

export function markerGroupLabel(marker: ReplayMarker): string {
  if (marker.count === 1) return marker.label;
  return `${marker.count}${marker.similar === false ? "" : " similar"} events`;
}

/** Combine markers whose glyphs would overlap at this actual track width. */
export function layoutReplayMarkers(
  markers: ReplayMarker[],
  windowUs: number,
  width: number,
): ReplayMarker[] {
  const groups: ReplayMarker[] = [];
  for (const marker of markers) {
    const previous = groups.at(-1);
    if (!previous || ((marker.offsetUs - previous.offsetUs) / windowUs) * width >= 18) {
      groups.push({ ...marker, spanUs: [...marker.spanUs], events: [...marker.events] });
      continue;
    }
    previous.events.push(...marker.events);
    previous.count += marker.count;
    previous.spanUs[1] = Math.max(previous.spanUs[1], marker.spanUs[1]);
    previous.similar = false;
    if (marker.category === "error") previous.category = "error";
    previous.key = `cluster:${previous.events[0].id}`;
  }
  return groups;
}

/** Coverage =============================== */

export interface ReplayCoverage {
  /** One-word state for the summary tile. */
  label: string;
  /** A short, evidence-sourced sentence for the inline status. */
  explanation: string;
  kind: "loading" | "permission" | "unavailable" | "empty" | "partial" | "complete";
}

/** Distinguishes what was loaded from what merely exists: truncation, journal
 * retention gaps, and permission walls are different facts, and none of them
 * means "no failures". */
export function describeReplayCoverage(
  evidence: ReplayEvidence | null,
  windowUs: number,
  fetchError: string | null,
): ReplayCoverage {
  if (fetchError) {
    return {
      kind: evidence?.loadedCount ? "partial" : "unavailable",
      label: evidence?.loadedCount ? "Partial" : "Unavailable",
      explanation: `The boot journal could not be read: ${fetchError}`,
    };
  }
  if (!evidence) {
    return { kind: "loading", label: "Loading", explanation: "Reading retained journal evidence…" };
  }
  if (evidence.permissionRequired) {
    return {
      kind: "permission",
      label: "Needs permission",
      explanation: "The connecting account cannot read this boot's journal. Retry with sudo.",
    };
  }
  if (evidence.errors.length) {
    return { kind: "partial", label: "Partial", explanation: evidence.errors.join(" ") };
  }
  if (evidence.limitReached) {
    return {
      kind: "partial",
      label: "Limit reached",
      explanation: `Loaded the session limit of ${MAX_REPLAY_EVENTS.toLocaleString()} records; more may exist. Refresh to start again.`,
    };
  }
  if (hasPendingReplayStreams(evidence, windowUs)) {
    return {
      kind: "partial",
      label: "Partial",
      explanation: "More events are retained in this window than were loaded; use Load more.",
    };
  }
  if (evidence.earliestMonotonicUs !== null && evidence.earliestMonotonicUs > 0) {
    return {
      kind: "partial",
      label: "Partial",
      explanation: `The first retained event is at ${formatTPlus(evidence.earliestMonotonicUs)}; no earlier journal evidence is available.`,
    };
  }
  if (!evidence.loadedCount) {
    return {
      kind: "empty",
      label: evidence.latestMonotonicUs === null ? "No records" : "No matches",
      explanation:
        evidence.latestMonotonicUs === null
          ? "The journal returned no entries for this boot."
          : "No retained systemd or warning records matched the replay filters.",
    };
  }
  const windowExhausted =
    evidence.lastLoadedOffsetUs !== null && evidence.lastLoadedOffsetUs >= windowUs;
  if (
    evidence.earliestMonotonicUs === null ||
    evidence.latestMonotonicUs === null ||
    evidence.untimedEvents.length
  ) {
    return {
      kind: "partial",
      label: "Partial",
      explanation:
        "Some journal coverage or boot-relative timestamps are unavailable. Untimed records are available in Show loaded events.",
    };
  }
  if (
    !windowExhausted &&
    evidence.latestMonotonicUs !== null &&
    evidence.latestMonotonicUs < windowUs
  ) {
    return {
      kind: "complete",
      label: "Sized to journal",
      explanation: `Retained evidence ends at ${formatTPlus(evidence.latestMonotonicUs)}, before the replay window.`,
    };
  }
  return {
    kind: "complete",
    label: "Loaded window",
    explanation: "Retained systemd and warning records in the replay window are loaded.",
  };
}

/** Decide whether another auto-page is worth fetching: only when a stream
 * stopped at its cap and the loaded slice has not reached the window end. */
export function shouldContinueReplayPagination(
  evidence: ReplayEvidence,
  windowUs: number,
  pagesFetched: number,
): boolean {
  if (pagesFetched >= MAX_AUTO_REPLAY_PAGES) return false;
  if (evidence.limitReached || evidence.permissionRequired || evidence.errors.length) return false;
  return hasPendingReplayStreams(evidence, windowUs);
}

function hasPendingReplayStreams(evidence: ReplayEvidence, windowUs: number): boolean {
  return (
    (evidence.managerTruncated &&
      evidence.managerCursor !== null &&
      (evidence.managerLastOffsetUs === null || evidence.managerLastOffsetUs < windowUs)) ||
    (evidence.alertTruncated &&
      evidence.alertCursor !== null &&
      (evidence.alertLastOffsetUs === null || evidence.alertLastOffsetUs < windowUs))
  );
}

/** One sentence, sourced only from the record's own fields, that explains
 * what the evidence shows without inventing a cause. */
export function replayEventSummary(event: ReplayEvent, windowUs: number): string {
  const where = event.offsetUs !== null ? ` at ${formatTPlus(event.offsetUs)}` : "";
  const withinWindow =
    event.offsetUs !== null && event.offsetUs <= windowUs ? " inside this replay window" : "";
  if (event.category === "error" || event.category === "warning") {
    const source = event.unit ?? event.source ?? "the journal";
    const severity = event.category === "error" ? "an error" : "a warning";
    return `Observed journal record${where}: ${source} reported ${severity}${withinWindow}.`;
  }
  if (event.category === "milestone") {
    return `Observed systemd milestone${where}: the journal shows this stage was reached${withinWindow}.`;
  }
  if (event.category === "unit") {
    return `Observed unit event${where}: the journal shows a unit lifecycle change${withinWindow}.`;
  }
  const source = event.source ?? "the journal";
  return `Observed journal record${where}: ${source} logged this entry${withinWindow}.`;
}

/** Time formatting =============================== */

/** `1:23.4` from microseconds: minutes are kept because replay windows run to
 * thirty minutes, and tenths are enough to compare against the marker list. */
export function formatOffsetClock(us: number): string {
  const totalTenths = Math.floor(us / (US_PER_SECOND / 10));
  const tenths = totalTenths % 10;
  const wholeSeconds = Math.floor(totalTenths / 10) % 60;
  const minutes = Math.floor(totalTenths / 600);
  return `${minutes}:${`${wholeSeconds}`.padStart(2, "0")}.${tenths}`;
}

export function formatTPlus(us: number): string {
  return `T+${formatOffsetClock(us)}`;
}

/** Axis tick offsets for a window, at readable step sizes that always
 * include zero and the window end (0s, 30s, 60s, … rather than awkward
 * sixths of whatever window was chosen). */
export function replayAxisTicks(windowUs: number): number[] {
  const windowSeconds = Math.ceil(windowUs / US_PER_SECOND);
  const stepSeconds = [5, 10, 15, 30, 60, 120, 300, 600, 1800].find(
    (candidate) => windowSeconds / candidate <= 6,
  );
  const ticks: number[] = [];
  if (!stepSeconds) return [0, windowUs];
  for (let second = 0; second <= windowSeconds; second += stepSeconds) {
    ticks.push(second * US_PER_SECOND);
  }
  if (ticks[ticks.length - 1] < windowUs) ticks.push(windowUs);
  return ticks;
}

export function formatTickLabel(us: number): string {
  const seconds = us / US_PER_SECOND;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}
