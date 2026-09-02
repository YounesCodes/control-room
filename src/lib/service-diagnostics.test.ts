import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_SECTIONS,
  EVIDENCE_NOTICE,
  applicableSections,
  dependencySummary,
  exitDetails,
  formatCollectedAt,
  isPermissionDenied,
  listenerHeadline,
  oneShotNotice,
  sectionTitle,
  stateHeadline,
  statusLabel,
} from "./service-diagnostics";
import type {
  ListenerEvidence,
  ListeningSocket,
  ServiceDiagnosticSection,
  UnitStateFacts,
} from "../types";

function facts(overrides: Partial<UnitStateFacts> = {}): UnitStateFacts {
  return {
    id: "nginx.service",
    known: true,
    description: "A high performance web server",
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    unitFileState: "enabled",
    unitType: "forking",
    remainAfterExit: false,
    result: "success",
    mainPid: 812,
    execMainPid: 812,
    execMainStatus: 0,
    execMainCode: null,
    restartCount: 0,
    conditionResult: true,
    assertResult: true,
    loadError: null,
    fragmentPath: "/lib/systemd/system/nginx.service",
    stateChangeTimestamp: "Mon 2026-09-01 10:00:00 UTC",
    activeEnterTimestamp: "Mon 2026-09-01 09:00:00 UTC",
    inactiveEnterTimestamp: null,
    ...overrides,
  };
}

function socket(port: number): ListeningSocket {
  return {
    id: `tcp-ipv4-0.0.0.0-${port}`,
    protocol: "tcp",
    addressFamily: "ipv4",
    localAddress: "0.0.0.0",
    port,
    processName: "nginx",
    processId: 812,
    systemdUnit: "nginx.service",
    ownership: "known",
  };
}

function evidence(overrides: Partial<ListenerEvidence> = {}): ListenerEvidence {
  return { sockets: [], totalListeners: 12, ownershipComplete: true, ...overrides };
}

function section(overrides: Partial<ServiceDiagnosticSection> = {}): ServiceDiagnosticSection {
  return {
    unit: "nginx.service",
    kind: "state",
    status: "collected",
    source: "systemd unit properties",
    collectedAt: "2026-09-01T10:00:00Z",
    note: null,
    state: null,
    journal: null,
    dependencies: null,
    listeners: null,
    ...overrides,
  };
}

describe("section applicability", () => {
  it("offers listeners only for units that can own one", () => {
    expect(applicableSections("nginx.service")).toEqual(DIAGNOSTIC_SECTIONS);
    expect(applicableSections("sshd.socket")).toEqual(DIAGNOSTIC_SECTIONS);
    expect(applicableSections("logrotate.timer")).toEqual(["state", "journal", "dependencies"]);
    expect(applicableSections("srv-data.mount")).toEqual(["state", "journal", "dependencies"]);
  });

  it("names every section", () => {
    for (const kind of DIAGNOSTIC_SECTIONS) {
      expect(sectionTitle(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("state wording", () => {
  it("reads the failed state and its exit facts without naming a cause", () => {
    const state = facts({
      activeState: "failed",
      subState: "failed",
      result: "exit-code",
      mainPid: null,
      execMainStatus: 1,
      execMainCode: "exited",
      restartCount: 3,
    });
    expect(stateHeadline(state)).toBe("failed (failed)");
    const details = exitDetails(state);
    expect(details).toContain("Result reported by systemd: exit-code");
    expect(details).toContain("Last main process exited with status 1");
    expect(details).toContain("No running main process. The last one was PID 812");
    expect(details).toContain("systemd has restarted this unit 3 times");
    for (const detail of details) {
      expect(detail.toLowerCase()).not.toContain("because");
      expect(detail.toLowerCase()).not.toContain("caused");
    }
  });

  it("does not read a signal number as an exit status", () => {
    const details = exitDetails(
      facts({ execMainCode: "killed by signal", execMainStatus: 9, result: "signal" }),
    );
    expect(details).toContain("Last main process was killed by signal 9");
    expect(details).not.toContain("Last main process exited with status 9");
  });

  it("says a unit is not loaded rather than inventing a state", () => {
    expect(stateHeadline(facts({ known: false }))).toBe("Not loaded by systemd");
  });

  it("keeps a state readable when the host reported nothing for it", () => {
    expect(stateHeadline(facts({ activeState: null, subState: null }))).toBe("unknown");
    expect(exitDetails(facts({ result: null, execMainCode: null, restartCount: null }))).toEqual(
      [],
    );
  });

  it("reports a start condition or assertion that was not met", () => {
    const details = exitDetails(facts({ conditionResult: false, assertResult: false }));
    expect(details).toContain("A start condition was not met");
    expect(details).toContain("A start assertion failed");
  });

  it("protects a healthy one-shot unit from reading as a failure", () => {
    expect(
      oneShotNotice(facts({ unitType: "oneshot", activeState: "inactive", result: "success" })),
    ).toContain("That is not a failure");
    expect(
      oneShotNotice(facts({ unitType: "oneshot", activeState: "inactive", result: "exit-code" })),
    ).toBeNull();
    expect(oneShotNotice(facts({ unitType: "forking", activeState: "inactive" }))).toBeNull();
  });
});

describe("listener wording", () => {
  it("uses the spec wording when ownership was complete and nothing matched", () => {
    expect(listenerHeadline(evidence(), "nginx.service")).toBe(
      "No listening socket associated with nginx.service was detected",
    );
  });

  it("refuses to claim absence when owners were incomplete", () => {
    const headline = listenerHeadline(evidence({ ownershipComplete: false }), "nginx.service");
    expect(headline).toContain("owners were incomplete");
    expect(headline).not.toContain("was detected");
  });

  it("counts what it did attribute", () => {
    expect(listenerHeadline(evidence({ sockets: [socket(80)] }), "nginx.service")).toBe(
      "1 listener attributed to nginx.service",
    );
    expect(
      listenerHeadline(evidence({ sockets: [socket(80), socket(443)] }), "nginx.service"),
    ).toBe("2 listeners attributed to nginx.service");
  });
});

describe("dependency wording", () => {
  it("says how many names were read and how many states came back", () => {
    const summary = dependencySummary(
      section({
        kind: "dependencies",
        dependencies: {
          relations: [],
          namedUnits: 61,
          resolvedUnits: 40,
          truncated: true,
          statesResolved: true,
        },
      }),
    );
    expect(summary).toBe("61 directly named units, states read for 40");
  });

  it("reports an empty dependency list plainly", () => {
    expect(
      dependencySummary(
        section({
          kind: "dependencies",
          dependencies: {
            relations: [],
            namedUnits: 0,
            resolvedUnits: 0,
            truncated: false,
            statesResolved: false,
          },
        }),
      ),
    ).toBe("systemd reported no direct dependencies for this unit");
  });
});

describe("presentation helpers", () => {
  it("recognizes only a permission failure as sudo-retryable", () => {
    expect(isPermissionDenied("Permission denied: bad")).toBe(true);
    expect(isPermissionDenied("Feature is not installed on this host")).toBe(false);
  });

  it("labels a partial section as partial", () => {
    expect(statusLabel(section({ status: "partial" }))).toBe("partial");
    expect(statusLabel(section({ status: "notApplicable" }))).toBe("not applicable");
  });

  it("does not present an unparsable timestamp as a real time", () => {
    expect(formatCollectedAt("not a date")).toBe("unknown time");
  });

  it("states the evidence rule once, in plain words", () => {
    expect(EVIDENCE_NOTICE).toBe(
      "Facts as the host reported them. Control Room does not infer a cause.",
    );
  });
});
