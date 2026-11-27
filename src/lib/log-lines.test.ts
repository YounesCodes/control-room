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
      ["date", "2026-11-01"],
      ["separator", "T"],
      ["time", "09:58:12"],
      ["fraction", ".104233"],
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
    expect(stamped.segments.map((segment) => segment.role)).toEqual([
      "date",
      "separator",
      "time",
      "fraction",
      "message",
    ]);
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

  it("prefers the level a line states over words in its message", () => {
    expect(
      logLevel(
        '{"@timestamp":"2026-11-01T09:58:12Z", "log.level": "INFO", "message":"retry failed"}',
      ),
    ).toBeNull();
    expect(logLevel('{"log.level": "WARN", "message":"disk watermark exceeded"}')).toBe("warning");
    expect(logLevel('time="2026-11-01" level=info msg="previous attempt failed"')).toBeNull();
    expect(logLevel('{"level":"error","msg":"request done"}')).toBe("error");
    expect(logLevel(" UTC [36] FATAL:  terminating connection")).toBe("error");
    expect(logLevel(" UTC [26] LOG:  could not receive data: connection failed")).toBeNull();
    expect(logLevel("[11/09/26 14:02:43] WARNING  WARNING:app:User exists")).toBe("warning");
    expect(logLevel("2026/11/01 09:58:12 [error] 12#0: upstream timed out")).toBe("error");
    expect(logLevel(" sshd: info: retrying after failure")).toBeNull();
    expect(logLevel(" worker: error: job 7 failed")).toBe("error");
    expect(logLevel("Information about the failed job")).toBe("error");
    expect(logLevel("anonymous usage and error information")).toBe("error");
  });

  it("dims a trailing UTC zone in database timestamps", () => {
    const line = parseLogLine("2026-10-13 11:52:54.568 UTC [36] FATAL:  terminating connection");
    expect(line.segments.slice(0, 5).map((segment) => [segment.role, segment.text])).toEqual([
      ["date", "2026-10-13"],
      ["separator", " "],
      ["time", "11:52:54"],
      ["fraction", ".568"],
      ["zone", " UTC"],
    ]);
    expect(joined(line)).toBe("2026-10-13 11:52:54.568 UTC [36] FATAL:  terminating connection");
    expect(line.level).toBe("error");
  });

  const repeated = (text: string) =>
    parseLogLine(text).segments.find((segment) => segment.role === "repeated-time")?.text;

  it("dims a message timestamp that repeats the journal or Docker time", () => {
    const journal =
      '2026-11-26T22:52:20.663410+00:00 debian-docker dockerd[766]: time="2026-11-26T22:52:20.663123456Z" level=warning msg="slow"';
    const line = parseLogLine(journal);
    expect(line.segments.slice(-3)).toEqual([
      { role: "message", text: ' time="' },
      { role: "repeated-time", text: "2026-11-26T22:52:20.663123456Z" },
      { role: "message", text: '" level=warning msg="slow"' },
    ]);
    expect(joined(line)).toBe(journal);
    expect(line.level).toBe("warning");
    expect(
      repeated(
        "2026-11-26T22:52:21.002000000Z 2026-11-26 22:52:20.663 UTC [36] LOG:  checkpoint starting",
      ),
    ).toBe("2026-11-26 22:52:20.663 UTC");
    expect(
      repeated('2026-11-26T22:52:20.700000000Z {"level":"info","time":"2026-11-26T22:52:20Z"}'),
    ).toBe("2026-11-26T22:52:20Z");
    expect(
      repeated(
        "2026-11-26T22:52:20.700000000Z 2026/11/26 22:52:20 [error] 29#29: connect() failed",
      ),
    ).toBe("2026/11/26 22:52:20");
    expect(repeated("2026-11-26T22:52:20.700000000Z [2026-11-26 22:52:20,120] INFO ready")).toBe(
      "2026-11-26 22:52:20,120",
    );
  });

  it("recognizes Redis, Python Rich, syslog and colon-terminated message times", () => {
    expect(
      repeated(
        "2026-11-26T22:57:27.096424703Z 1:M 26 Nov 2026 22:57:27.096 * Background saving started",
      ),
    ).toBe("26 Nov 2026 22:57:27.096");
    expect(
      repeated(
        "2026-11-26T15:57:58.817741394Z [11/26/26 15:57:58] INFO     INFO:rq.worker:Cleaning",
      ),
    ).toBe("11/26/26 15:57:58");
    expect(repeated("2026-11-26T15:57:58.817741394Z [26/11/2026 15:57:58] ready")).toBe(
      "26/11/2026 15:57:58",
    );
    expect(repeated("2026-11-26T22:52:20.100000+00:00 host cron[9]: Nov 26 22:52:20 run")).toBe(
      "Nov 26 22:52:20",
    );
    expect(
      repeated(
        "2026-11-23T14:18:42.792903+00:00 host runsvc.sh[49541]: 2026-11-23 14:18:42Z: Listening for Jobs",
      ),
    ).toBe("2026-11-23 14:18:42Z");
  });

  it("compares a zoneless message time with UTC and the host offset", () => {
    expect(
      repeated("2026-11-26T23:52:20.100000+01:00 host app[1]: 2026-11-26 23:52:20 started"),
    ).toBe("2026-11-26 23:52:20");
    expect(
      repeated("2026-11-26T23:52:20.100000+01:00 host app[1]: 2026-11-26 22:52:20 started"),
    ).toBe("2026-11-26 22:52:20");
    expect(
      repeated("2026-11-26T23:52:20.100000+01:00 host app[1]: 2026-11-26T22:52:20+01:00 started"),
    ).toBeUndefined();
  });

  it("keeps a message timestamp that records a different moment", () => {
    expect(
      repeated("2026-11-26T22:52:25.000000000Z 2026-11-26 22:52:20 queued job 7"),
    ).toBeUndefined();
    expect(repeated("2026-11-26 22:52:20 2026-11-26 22:52:20 no source")).toBe(
      "2026-11-26 22:52:20",
    );
    expect(repeated("GET /health 2026-11-26 22:52:20")).toBeUndefined();
    expect(
      repeated("2026-11-26T22:52:20.000000000Z request 2026-11-26 22:52:20 finished"),
    ).toBeUndefined();
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
