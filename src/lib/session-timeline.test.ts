import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TIMELINE_EVENTS,
  appendTimelineEvent,
  commandEvent,
  connectionEvent,
  describeExitCode,
  isDisconnectBoundary,
  logStreamEvent,
  objectEvent,
} from "./session-timeline";
import type { TimelineEvent, TimelineEventInput } from "../types";

let counter = 0;

beforeEach(() => {
  counter = 0;
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    randomUUID: () => `event-${++counter}`,
  });
});

function build(inputs: TimelineEventInput[]): TimelineEvent[] {
  return inputs.reduce<TimelineEvent[]>(
    (timeline, input) => appendTimelineEvent(timeline, input),
    [],
  );
}

describe("timeline recording", () => {
  it("records the documented events in the order they arrived", () => {
    const timeline = build([
      connectionEvent([], "connected", null)!,
      commandEvent("uptime", 0),
      objectEvent({ type: "systemdUnit", id: "nginx.service" }),
      logStreamEvent({ type: "systemd", id: "nginx.service" }, true),
    ]);
    expect(timeline.map((event) => event.kind)).toEqual([
      "connected",
      "command",
      "openedObject",
      "logStreamStarted",
    ]);
    expect(timeline[1].label).toBe("uptime");
    expect(timeline[1].detail).toBe("exit 0");
    expect(timeline[2].label).toBe("Opened unit nginx.service");
    expect(timeline[3].label).toBe("Started journal stream for nginx.service");
  });

  it("collapses consecutive identical events instead of repeating them", () => {
    const timeline = build([
      commandEvent("uptime", 0),
      commandEvent("uptime", 0),
      commandEvent("uptime", 0),
      commandEvent("uptime", 1),
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].repeatCount).toBe(3);
    expect(timeline[1].repeatCount).toBe(1);
    expect(timeline[1].detail).toBe("exit 1");
  });

  it("does not collapse the same command run around a different event", () => {
    const timeline = build([
      commandEvent("uptime", 0),
      objectEvent({ type: "dockerContainer", id: "api" }),
      commandEvent("uptime", 0),
    ]);
    expect(timeline).toHaveLength(3);
    expect(timeline.every((event) => event.repeatCount === 1)).toBe(true);
  });

  it("keeps the newest events when the buffer is full", () => {
    const inputs = Array.from({ length: MAX_TIMELINE_EVENTS + 5 }, (_, index) =>
      commandEvent(`command-${index}`, 0),
    );
    const timeline = build(inputs);
    expect(timeline).toHaveLength(MAX_TIMELINE_EVENTS);
    expect(timeline[0].label).toBe("command-5");
    expect(timeline[timeline.length - 1].label).toBe(`command-${MAX_TIMELINE_EVENTS + 4}`);
  });
});

describe("connection boundaries", () => {
  it("calls the first connection connected and later ones reconnected", () => {
    const first = connectionEvent([], "connected", null)!;
    const timeline = build([first]);
    expect(first.kind).toBe("connected");
    const disconnect = connectionEvent(timeline, "disconnected", "Connection closed")!;
    const withDisconnect = appendTimelineEvent(timeline, disconnect);
    const second = connectionEvent(withDisconnect, "connected", null)!;
    expect(second.kind).toBe("reconnected");
  });

  it("marks disconnects and failures as boundaries and carries the reason", () => {
    const failure = connectionEvent([], "error", "Authentication failed")!;
    const event = build([failure])[0];
    expect(event.detail).toBe("Authentication failed");
    expect(isDisconnectBoundary(event)).toBe(true);
    expect(isDisconnectBoundary(build([commandEvent("ls", 0)])[0])).toBe(false);
  });

  it("records nothing for the connecting state", () => {
    expect(connectionEvent([], "connecting", null)).toBeNull();
  });
});

describe("exit codes", () => {
  it("labels a missing exit code as absent rather than success", () => {
    expect(describeExitCode(null)).toBeNull();
    expect(describeExitCode(0)).toBe("exit 0");
    expect(describeExitCode(137)).toBe("exit 137");
  });
});

describe("log stream events", () => {
  it("names the source type and direction", () => {
    const started = build([logStreamEvent({ type: "docker", id: "api" }, true)])[0];
    const stopped = build([logStreamEvent({ type: "docker", id: "api" }, false)])[0];
    expect(started.label).toBe("Started container log stream for api");
    expect(stopped.label).toBe("Stopped container log stream for api");
    expect(started.target).toEqual({ type: "logSource", id: "api", sourceType: "docker" });
  });
});
