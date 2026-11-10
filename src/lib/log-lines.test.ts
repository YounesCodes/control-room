import { describe, expect, it } from "vitest";
import {
  cleanLogText,
  highlightSegments,
  LogLineCache,
  lineMatches,
  logLevel,
  parseLogLine,
} from "./log-lines";

const joined = (line: ReturnType<typeof parseLogLine>) =>
  line.segments.map((segment) => segment.text).join("");

describe("parseLogLine", () => {
  it("splits a journalctl short-iso-precise line without changing its text", () => {
    const text = "2026-11-01T09:58:12.104233+00:00 example-host worker[1234]: error: job 7 failed";
    const line = parseLogLine(text);
    expect(line.segments.map((segment) => [segment.role, segment.text])).toEqual([
      ["date", "2026-11-01T"],
      ["time", "09:58:12.104233"],
      ["zone", "+00:00"],
      ["source", " example-host worker[1234]:"],
      ["message", " error: job 7 failed"],
    ]);
    expect(joined(line)).toBe(text);
    expect(line.level).toBe("error");
    expect(line.marker).toBe(false);
  });

  it("recognizes PID-less kernel lines and older zone offsets", () => {
    const line = parseLogLine("2026-11-01T09:58:12+0000 host kernel: usb 1-1: new device");
    expect(line.segments.find((segment) => segment.role === "source")?.text).toBe(" host kernel:");
    expect(line.segments.find((segment) => segment.role === "zone")?.text).toBe("+0000");
  });

  it("keeps container lines without a journal source as message text", () => {
    const stamped = parseLogLine("2026-11-01 09:58:12,120 INFO server: listening on :8080");
    expect(stamped.segments.map((segment) => segment.role)).toEqual(["date", "time", "message"]);
    expect(joined(stamped)).toBe("2026-11-01 09:58:12,120 INFO server: listening on :8080");
    const plain = parseLogLine("GET /health 200");
    expect(plain.segments).toEqual([{ role: "message", text: "GET /health 200" }]);
  });

  it("classifies only the message, so host names cannot raise a level", () => {
    expect(parseLogLine("2026-11-01T09:58:12+00:00 error-box app[1]: ready").level).toBeNull();
    expect(logLevel("WARNING: disk almost full")).toBe("warning");
    expect(logLevel("Deprecated option ignored")).toBe("warning");
    expect(logLevel("connection failed, warning sent")).toBe("error");
    expect(logLevel("terror and errand are words")).toBeNull();
  });

  it("marks Control Room stream starts and journalctl separators", () => {
    expect(parseLogLine("[systemd worker.service] stream started").marker).toBe(true);
    expect(parseLogLine("[docker api] stream started").marker).toBe(true);
    expect(parseLogLine("-- Boot 1f2e3d4c --").marker).toBe(true);
    expect(parseLogLine("-- No entries --").level).toBeNull();
    expect(parseLogLine("[systemd worker.service] stream started late").marker).toBe(false);
  });

  it("drops terminal escapes and carriage returns from display text", () => {
    expect(cleanLogText("\x1b[32mINFO\x1b[0m ready\r")).toBe("INFO ready");
    expect(cleanLogText("\x1b]0;title\x07done")).toBe("done");
    expect(parseLogLine("\x1b[31mERROR\x1b[0m boom\r").text).toBe("ERROR boom");
  });
});

describe("log search", () => {
  it("marks matches case-insensitively, including across segment boundaries", () => {
    const line = parseLogLine("2026-11-01T09:58:12+00:00 host app[1]: Batch 4813 done");
    const parts = highlightSegments(line.segments, "batch 4813");
    const marked = parts.flat().filter((part) => part.match);
    expect(marked.map((part) => part.text)).toEqual(["Batch 4813"]);
    const spanning = highlightSegments(line.segments, "+00:00 host");
    expect(
      spanning
        .flat()
        .filter((part) => part.match)
        .map((part) => part.text),
    ).toEqual(["+00:00", " host"]);
    expect(parts.map((segment) => segment.map((part) => part.text).join(""))).toEqual(
      line.segments.map((segment) => segment.text),
    );
  });

  it("filters by level and query together", () => {
    const error = parseLogLine("job 7 failed");
    const info = parseLogLine("job 8 done");
    expect(lineMatches(error, "", "error")).toBe(true);
    expect(lineMatches(info, "", "error")).toBe(false);
    expect(lineMatches(error, "JOB 7", "all")).toBe(true);
    expect(lineMatches(error, "job 8", "error")).toBe(false);
  });

  it("reuses parsed lines and stays bounded", () => {
    const cache = new LogLineCache(2);
    const first = cache.get("one");
    expect(cache.get("one")).toBe(first);
    cache.get("two");
    cache.get("three");
    expect(cache.get("one")).not.toBe(first);
  });
});
