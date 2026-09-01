import type {
  ConnectionState,
  LogSourceSelection,
  TimelineEvent,
  TimelineEventInput,
  TimelineEventKind,
  TimelineTarget,
} from "../types";

// The timeline is an allowlist, not a record of everything the user touched.
// View switches, scrolling, filter typing, and the selection that reconciles
// itself after a refresh are deliberately absent. They are noise, and recording
// them would turn an investigation record into UI analytics.
//
// Ordering follows arrival, not the reported clock. A host clock adjustment can
// move a command timestamp backwards, and sorting on that would rewrite what
// the user actually did.
export const MAX_TIMELINE_EVENTS = 300;

export function appendTimelineEvent(
  timeline: TimelineEvent[],
  input: TimelineEventInput,
): TimelineEvent[] {
  const last = timeline[timeline.length - 1];
  if (last && coalesceKey(last) === coalesceKey(input)) {
    const merged: TimelineEvent = { ...last, at: input.at, repeatCount: last.repeatCount + 1 };
    return [...timeline.slice(0, -1), merged];
  }
  const event: TimelineEvent = {
    id: input.id,
    at: input.at,
    kind: input.kind,
    label: input.label,
    detail: input.detail ?? null,
    target: input.target ?? null,
    repeatCount: 1,
  };
  const next = [...timeline, event];
  return next.length > MAX_TIMELINE_EVENTS ? next.slice(next.length - MAX_TIMELINE_EVENTS) : next;
}

// Consecutive identical events collapse instead of repeating. Running the same
// command four times in a row gives one row that says so.
function coalesceKey(event: TimelineEvent | TimelineEventInput): string {
  return [event.kind, event.label, event.detail ?? "", targetKey(event.target)].join(" ");
}

function targetKey(target: TimelineTarget | null | undefined): string {
  return target ? `${target.type}:${target.id}` : "";
}

function newEvent(
  kind: TimelineEventKind,
  label: string,
  extra: { detail?: string | null; target?: TimelineTarget | null } = {},
): TimelineEventInput {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind,
    label,
    detail: extra.detail ?? null,
    target: extra.target ?? null,
  };
}

// A Workspace that has connected before reports the next connection as a
// reconnect, so a drop and a recovery read as one story rather than two starts.
export function connectionEvent(
  timeline: TimelineEvent[],
  state: ConnectionState,
  reason: string | null,
): TimelineEventInput | null {
  if (state === "connected") {
    const connectedBefore = timeline.some(
      (event) => event.kind === "connected" || event.kind === "reconnected",
    );
    return connectedBefore
      ? newEvent("reconnected", "Reconnected")
      : newEvent("connected", "Connected");
  }
  if (state === "error") {
    return newEvent("connectionFailed", "Connection failed", { detail: reason });
  }
  if (state === "disconnected") {
    return newEvent("disconnected", "Disconnected", { detail: reason });
  }
  return null;
}

export function commandEvent(command: string, exitCode: number | null): TimelineEventInput {
  return newEvent("command", command, { detail: describeExitCode(exitCode) });
}

export function objectEvent(target: TimelineTarget): TimelineEventInput {
  const noun = target.type === "systemdUnit" ? "unit" : "container";
  return newEvent("openedObject", `Opened ${noun} ${target.id}`, { target });
}

export function logStreamEvent(source: LogSourceSelection, started: boolean): TimelineEventInput {
  const noun = source.type === "systemd" ? "journal" : "container log";
  const verb = started ? "Started" : "Stopped";
  return newEvent(
    started ? "logStreamStarted" : "logStreamStopped",
    `${verb} ${noun} stream for ${source.id}`,
    { target: { type: "logSource", id: source.id, sourceType: source.type } },
  );
}

export function isDisconnectBoundary(event: TimelineEvent): boolean {
  return event.kind === "disconnected" || event.kind === "connectionFailed";
}

export function formatTimelineTime(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleTimeString();
}

export function describeExitCode(exitCode: number | null): string | null {
  if (exitCode === null) return null;
  return exitCode === 0 ? "exit 0" : `exit ${exitCode}`;
}
