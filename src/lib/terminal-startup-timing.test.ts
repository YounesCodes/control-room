import { describe, expect, it } from "vitest";
import {
  formatTerminalStartup,
  isPromptStartMarker,
  TERMINAL_PROMPT_QUIET_MS,
  TerminalStartupTiming,
  type TerminalStartupClock,
  type TerminalStartupReport,
} from "./terminal-startup-timing";

function fakeClock() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: TerminalStartupClock = {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      if (id !== undefined) timers.delete(id);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return { clock, advance, pending: () => timers.size };
}

function timing() {
  const fake = fakeClock();
  const reports: TerminalStartupReport[] = [];
  const timeline = new TerminalStartupTiming(
    "local:pwsh",
    (report) => reports.push(report),
    fake.clock,
  );
  return { ...fake, reports, timeline };
}

describe("TerminalStartupTiming", () => {
  it("reports each stage once, relative to the request, when the prompt goes quiet", () => {
    const { advance, reports, timeline } = timing();
    advance(12);
    timeline.mark("layout");
    advance(43);
    timeline.mark("started");
    timeline.mark("started");
    advance(100);
    timeline.mark("firstOutput");
    advance(5);
    timeline.rendered("PS C:\\Users\\dev> ");
    advance(TERMINAL_PROMPT_QUIET_MS);

    expect(reports).toEqual([
      {
        target: "local:pwsh",
        requestedAt: 1_000,
        stages: {
          layout: 12,
          started: 55,
          firstOutput: 155,
          firstRender: 160,
          prompt: 160,
        },
        prompt: "quiet",
      },
    ]);
  });

  it("dates a quiet prompt from the last render, not the first", () => {
    const { advance, reports, timeline } = timing();
    timeline.mark("firstOutput");
    timeline.rendered("Last login: today");
    advance(100);
    timeline.rendered("dev@host:~$ ");
    advance(TERMINAL_PROMPT_QUIET_MS);

    expect(reports[0].stages).toMatchObject({ firstRender: 0, prompt: 100 });
  });

  it("does not take a blank cursor line for a prompt", () => {
    const { advance, reports, timeline, pending } = timing();
    timeline.mark("firstOutput");
    timeline.rendered("");
    advance(TERMINAL_PROMPT_QUIET_MS * 3);
    expect(reports).toEqual([]);
    expect(pending()).toBe(0);

    timeline.rendered("C:\\Users\\dev>");
    advance(TERMINAL_PROMPT_QUIET_MS);
    expect(reports[0].stages.prompt).toBe(TERMINAL_PROMPT_QUIET_MS * 3);
  });

  it("prefers a shell prompt marker and stops listening after it", () => {
    const { advance, reports, timeline, pending } = timing();
    timeline.mark("firstOutput");
    timeline.rendered("banner");
    advance(20);
    timeline.shellMarker("A");
    advance(TERMINAL_PROMPT_QUIET_MS);
    timeline.rendered("$ ");
    timeline.shellMarker("A");

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ prompt: "marker", stages: { prompt: 20 } });
    expect(pending()).toBe(0);
  });

  it("ignores prompt markers before any output arrived", () => {
    const { reports, timeline } = timing();
    timeline.shellMarker("A");
    expect(reports).toEqual([]);
  });

  it("reports nothing once cancelled", () => {
    const { advance, reports, timeline, pending } = timing();
    timeline.mark("firstOutput");
    timeline.rendered("$ ");
    timeline.cancel();
    advance(TERMINAL_PROMPT_QUIET_MS);
    expect(reports).toEqual([]);
    expect(pending()).toBe(0);
  });
});

it.each([
  ["A", true],
  ["A;cl=m", true],
  ["B", false],
  ["D;0", false],
  ["AB", false],
])("treats %j as a prompt start marker: %s", (data, expected) => {
  expect(isPromptStartMarker(data)).toBe(expected);
});

it("formats a report as one log line with every stage", () => {
  expect(
    formatTerminalStartup({
      target: "ssh",
      requestedAt: 0,
      stages: {
        drained: 2,
        fontLoaded: 6,
        layout: 10,
        started: 30,
        firstOutput: 400,
        firstRender: 402,
        prompt: 650,
      },
      prompt: "quiet",
    }),
  ).toBe(
    "[control-room] terminal_startup target=ssh drained_ms=2 font_ms=6 layout_ms=10 started_ms=30 first_output_ms=400 first_render_ms=402 prompt_ms=650 prompt=quiet",
  );
  expect(
    formatTerminalStartup({
      target: "local:cmd",
      requestedAt: 0,
      stages: { layout: 1 },
      prompt: "marker",
    }),
  ).toContain("started_ms=none");
});
