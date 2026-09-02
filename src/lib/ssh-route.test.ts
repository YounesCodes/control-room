import { describe, expect, it } from "vitest";
import {
  LOCAL_ONLY_NOTICE,
  copyableValues,
  resolvedHostNote,
  routeHeadline,
  segmentStatusLabel,
  segmentTarget,
  segmentTitle,
  unknownFields,
} from "./ssh-route";
import type { RouteSegment, SshRoute } from "../types";

function segment(overrides: Partial<RouteSegment> = {}): RouteSegment {
  return {
    kind: "destination",
    status: "resolved",
    alias: "web-01",
    hostname: "web-01.internal",
    user: "deploy",
    port: 2222,
    identityFiles: ["C:\\Users\\me\\.ssh\\id_ed25519"],
    proxyProgram: null,
    note: null,
    ...overrides,
  };
}

function route(segments: RouteSegment[], overrides: Partial<SshRoute> = {}): SshRoute {
  return {
    connectionId: "connection-a",
    resolvedAt: "2026-09-02T10:00:00Z",
    status: "resolved",
    segments,
    truncated: false,
    note: null,
    ...overrides,
  };
}

const origin = segment({
  kind: "origin",
  alias: "This PC",
  hostname: null,
  user: null,
  port: null,
  identityFiles: [],
});

describe("segment facts", () => {
  it("shows the alias first and the resolved target under it", () => {
    const web = segment();
    expect(segmentTitle(web)).toBe("web-01");
    expect(segmentTarget(web)).toBe("deploy@web-01.internal:2222");
    expect(resolvedHostNote(web)).toBe("alias for web-01.internal");
  });

  it("says nothing extra when the alias is already the hostname", () => {
    expect(resolvedHostNote(segment({ alias: "web-01", hostname: "web-01" }))).toBeNull();
  });

  it("says the hostname is missing rather than reusing the alias as one", () => {
    const unresolved = segment({ hostname: null });
    expect(resolvedHostNote(unresolved)).toBe("OpenSSH reported no hostname for this alias");
    expect(unknownFields(unresolved)).toContain("hostname");
  });

  it("names every field the client reported nothing for", () => {
    expect(unknownFields(segment({ user: null, port: null, hostname: null }))).toEqual([
      "user",
      "port",
      "hostname",
    ]);
    expect(unknownFields(segment())).toEqual([]);
  });

  it("treats this PC as a segment with no ssh facts of its own", () => {
    expect(segmentTarget(origin)).toBe("the local OpenSSH client");
    expect(resolvedHostNote(origin)).toBeNull();
    expect(unknownFields(origin)).toEqual([]);
    expect(copyableValues(origin)).toEqual([]);
  });

  it("builds a target from only the values that are present", () => {
    expect(segmentTarget(segment({ user: null, port: null }))).toBe("web-01.internal");
    expect(segmentTarget(segment({ hostname: null, user: null }))).toBe("web-01:2222");
  });
});

describe("segment status wording", () => {
  it("uses plain words for each state", () => {
    expect(segmentStatusLabel(segment())).toBe("resolved");
    expect(segmentStatusLabel(segment({ status: "opaqueProxy" }))).toBe("not interpretable");
    expect(segmentStatusLabel(segment({ status: "loop" }))).toBe("loop");
    expect(segmentStatusLabel(segment({ status: "limit" }))).toBe("limit reached");
    expect(segmentStatusLabel(segment({ status: "unresolved" }))).toBe("unresolved");
  });
});

describe("route headline", () => {
  it("counts jump hosts", () => {
    expect(routeHeadline(route([origin, segment()]))).toBe("Direct, with no jump host");
    expect(
      routeHeadline(route([origin, segment({ kind: "jump", alias: "bastion" }), segment()])),
    ).toBe("1 jump host between this PC and the destination");
    expect(
      routeHeadline(
        route([
          origin,
          segment({ kind: "jump", alias: "b1" }),
          segment({ kind: "jump", alias: "b2" }),
          segment(),
        ]),
      ),
    ).toBe("2 jump hosts between this PC and the destination");
  });

  it("says a partial route is partial", () => {
    const partial = route([origin, segment({ status: "opaqueProxy" })], { status: "partial" });
    expect(routeHeadline(partial)).toBe(
      "Direct, with no jump host. Part of this route could not be interpreted",
    );
  });
});

describe("copyable values", () => {
  it("lists identity files by path and nothing else about them", () => {
    const values = copyableValues(segment({ identityFiles: ["C:\\keys\\a", "C:\\keys\\b"] }));
    expect(values).toEqual([
      { label: "Hostname", value: "web-01.internal" },
      { label: "User", value: "deploy" },
      { label: "Port", value: "2222" },
      { label: "Identity file", value: "C:\\keys\\a" },
      { label: "Identity file", value: "C:\\keys\\b" },
    ]);
  });

  it("omits a value the client did not report", () => {
    expect(copyableValues(segment({ user: null, port: null, identityFiles: [] }))).toEqual([
      { label: "Hostname", value: "web-01.internal" },
    ]);
  });

  it("states the local-only rule in plain words", () => {
    expect(LOCAL_ONLY_NOTICE).toBe(
      "Read from the installed OpenSSH client. No host is contacted and no key is read.",
    );
  });
});
