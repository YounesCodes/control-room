import { describe, expect, it } from "vitest";
import {
  MAX_LINES_PER_SOURCE,
  SourceLineBuffer,
  droppedNotice,
  formatLineTime,
  mergeSources,
  parseLogLine,
  skewNotice,
  sourceLabel,
  timeQualifier,
} from "./log-correlation";
import type { CorrelationSource } from "../types";

// A shared arrival counter, exactly as the pane uses one, so the fixtures model
// real interleaving rather than a tidy per-source order.
function arrivals() {
  let order = 0;
  return () => ++order;
}

function source(id: string, state: CorrelationSource["state"] = "running"): CorrelationSource {
  return {
    id,
    type: "systemd",
    target: `${id}.service`,
    label: `${id}.service`,
    streamId: `stream-${id}`,
    state,
    error: null,
  };
}

describe("timestamp parsing", () => {
  it("reads the journald short-iso-precise prefix and keeps the rest verbatim", () => {
    const parsed = parseLogLine("2026-09-01T10:00:00.123456+02:00 web-01 nginx[812]: GET / 200");
    expect(parsed.at).toBe(Date.parse("2026-09-01T10:00:00.123456+02:00"));
    expect(parsed.originalTimestamp).toBe("2026-09-01T10:00:00.123456+02:00");
    expect(parsed.message).toBe("web-01 nginx[812]: GET / 200");
  });

  it("reads the Docker RFC 3339 prefix", () => {
    const parsed = parseLogLine("2026-09-01T08:00:00.000000001Z listening on 8080");
    expect(parsed.at).toBe(Date.parse("2026-09-01T08:00:00.000Z"));
    expect(parsed.message).toBe("listening on 8080");
  });

  it("treats a line without a timestamp as having none rather than guessing", () => {
    for (const text of [
      "-- Logs begin at Mon 2026-09-01 --",
      "    at Server.handle (/app/server.js:14:9)",
      "plain docker line with no timestamps flag",
      "",
    ]) {
      const parsed = parseLogLine(text);
      expect(parsed.at).toBeNull();
      expect(parsed.originalTimestamp).toBeNull();
      expect(parsed.message).toBe(text);
    }
  });

  it("rejects a prefix that looks like a date but is not a time", () => {
    const parsed = parseLogLine("2026-13-45T99:99:99Z broken");
    expect(parsed.at).toBeNull();
  });
});

describe("bounded per-source buffers", () => {
  it("splits on newlines and holds a partial line until it completes", () => {
    const next = arrivals();
    const buffer = new SourceLineBuffer("a");
    buffer.append("2026-09-01T10:00:00Z one\n2026-09-01T10:00:01Z tw", next);
    expect(buffer.snapshot()).toHaveLength(1);
    buffer.append("o\n", next);
    expect(buffer.snapshot()).toHaveLength(2);
    expect(buffer.snapshot()[1].parsed.message).toBe("two");
  });

  it("drops the oldest lines at the bound and counts what it let go", () => {
    const next = arrivals();
    const buffer = new SourceLineBuffer("a", 3);
    for (let index = 0; index < 6; index += 1) {
      buffer.append(`2026-09-01T10:00:0${index}Z line-${index}\n`, next);
    }
    expect(buffer.snapshot()).toHaveLength(3);
    expect(buffer.droppedLines).toBe(3);
    expect(buffer.snapshot()[0].parsed.message).toBe("line-3");
    expect(droppedNotice([buffer])).toBe(
      "3 older lines dropped from 1 source to stay within the memory bound.",
    );
  });

  it("reports nothing dropped when the bound was never reached", () => {
    const buffer = new SourceLineBuffer("a", MAX_LINES_PER_SOURCE);
    buffer.append("2026-09-01T10:00:00Z fine\n", arrivals());
    expect(droppedNotice([buffer])).toBeNull();
  });

  it("clears its own lines without touching another source", () => {
    const next = arrivals();
    const first = new SourceLineBuffer("a");
    const second = new SourceLineBuffer("b");
    first.append("2026-09-01T10:00:00Z one\n", next);
    second.append("2026-09-01T10:00:01Z two\n", next);
    first.clear();
    expect(first.snapshot()).toHaveLength(0);
    expect(second.snapshot()).toHaveLength(1);
  });
});

describe("merging", () => {
  function fixture() {
    const next = arrivals();
    const proxy = new SourceLineBuffer("proxy");
    const app = new SourceLineBuffer("app");
    proxy.append("2026-09-01T10:00:00.000Z proxy received\n", next);
    app.append("2026-09-01T10:00:01.000Z app handling\n", next);
    proxy.append("2026-09-01T10:00:02.000Z proxy replied\n", next);
    return { proxy, app };
  }

  it("orders mixed sources by normalized time and keeps source identity", () => {
    const { proxy, app } = fixture();
    const merged = mergeSources([proxy, app], ["proxy", "app"]);
    expect(merged.map((line) => [line.sourceId, line.message])).toEqual([
      ["proxy", "proxy received"],
      ["app", "app handling"],
      ["proxy", "proxy replied"],
    ]);
    expect(merged.every((line) => line.timeSource === "parsed")).toBe(true);
  });

  it("is deterministic for identical timestamps", () => {
    const next = arrivals();
    const first = new SourceLineBuffer("bbb");
    const second = new SourceLineBuffer("aaa");
    first.append("2026-09-01T10:00:00.000Z from-bbb\n", next);
    second.append("2026-09-01T10:00:00.000Z from-aaa\n", next);
    const once = mergeSources([first, second], ["bbb", "aaa"]);
    const twice = mergeSources([second, first], ["aaa", "bbb"]);
    expect(once.map((line) => line.message)).toEqual(["from-aaa", "from-bbb"]);
    expect(twice.map((line) => line.message)).toEqual(once.map((line) => line.message));
  });

  it("hides a source without disturbing the others", () => {
    const { proxy, app } = fixture();
    const merged = mergeSources([proxy, app], ["app"]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceId).toBe("app");
  });

  it("keeps an untimestamped continuation with the line above it", () => {
    const next = arrivals();
    const app = new SourceLineBuffer("app");
    app.append("2026-09-01T10:00:05.000Z Error: boom\n", next);
    app.append("    at Server.handle (/app/server.js:14:9)\n", next);
    const other = new SourceLineBuffer("proxy");
    other.append("2026-09-01T10:00:06.000Z proxy replied\n", next);
    const merged = mergeSources([app, other], ["app", "proxy"]);
    expect(merged.map((line) => line.message)).toEqual([
      "Error: boom",
      "    at Server.handle (/app/server.js:14:9)",
      "proxy replied",
    ]);
    expect(merged[1].timeSource).toBe("inherited");
    expect(timeQualifier(merged[1])).toBe("continues the previous line");
  });

  it("falls back to arrival time when a source has printed nothing dated", () => {
    const next = arrivals();
    const buffer = new SourceLineBuffer("app");
    buffer.append("no timestamp at all\n", next, 1_759_000_000_000);
    const merged = mergeSources([buffer], ["app"]);
    expect(merged[0].timeSource).toBe("arrival");
    expect(merged[0].at).toBe(1_759_000_000_000);
    expect(timeQualifier(merged[0])).toBe("no timestamp, ordered by arrival");
  });

  it("marks a line that arrived after later lines were already shown", () => {
    const next = arrivals();
    const app = new SourceLineBuffer("app");
    const proxy = new SourceLineBuffer("proxy");
    proxy.append("2026-09-01T10:00:05.000Z proxy replied\n", next);
    // This line belongs before the proxy line but reached Control Room after it.
    app.append("2026-09-01T10:00:01.000Z app handling\n", next);
    const merged = mergeSources([app, proxy], ["app", "proxy"]);
    expect(merged.map((line) => line.message)).toEqual(["app handling", "proxy replied"]);
    expect(merged[0].late).toBe(true);
    expect(merged[1].late).toBe(false);
  });

  it("marks nothing late when arrival already matched time order", () => {
    const { proxy, app } = fixture();
    const merged = mergeSources([proxy, app], ["proxy", "app"]);
    expect(merged.some((line) => line.late)).toBe(false);
  });

  it("keeps the newest lines at the merged bound", () => {
    const next = arrivals();
    const buffer = new SourceLineBuffer("app", 100);
    for (let index = 0; index < 100; index += 1) {
      buffer.append(`2026-09-01T10:00:00.${String(index).padStart(3, "0")}Z line-${index}\n`, next);
    }
    const merged = mergeSources([buffer], ["app"], 10);
    expect(merged).toHaveLength(10);
    expect(merged[0].message).toBe("line-90");
    expect(merged[9].message).toBe("line-99");
  });

  it("merges nothing when every source is hidden", () => {
    const { proxy, app } = fixture();
    expect(mergeSources([proxy, app], [])).toHaveLength(0);
  });
});

describe("honesty about ordering", () => {
  it("warns about clock skew once two sources are running", () => {
    expect(skewNotice([source("a")])).toBeNull();
    expect(skewNotice([source("a"), source("b", "error")])).toBeNull();
    expect(skewNotice([source("a"), source("b")])).toContain("does not adjust for skew");
  });

  it("labels a source by its own name", () => {
    expect(sourceLabel(source("nginx"))).toBe("nginx.service");
    expect(sourceLabel({ ...source("nginx"), label: "" })).toBe("nginx.service");
  });

  it("formats a line time with milliseconds", () => {
    const next = arrivals();
    const buffer = new SourceLineBuffer("app");
    buffer.append("2026-09-01T10:00:00.250Z one\n", next);
    expect(formatLineTime(mergeSources([buffer], ["app"])[0])).toMatch(/^\d{2}:\d{2}:\d{2}\.250$/);
  });
});
