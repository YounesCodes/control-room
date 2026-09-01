import { describe, expect, it } from "vitest";
import {
  canRun,
  factValue,
  isReadable,
  mergeResult,
  resultColumns,
  stateLabel,
  summarizeRun,
  validateParameter,
} from "./cross-host";
import type { CrossHostOperation, CrossHostResult, CrossHostState } from "../types";

const hostFacts: CrossHostOperation = {
  id: "hostFacts",
  label: "Host facts",
  description: "Operating system, version, kernel, and architecture.",
  parameter: null,
  facts: ["hostname", "kernel"],
};

const unitState: CrossHostOperation = {
  id: "unitState",
  label: "Systemd unit state",
  description: "Load, active, sub, and unit-file state of one unit.",
  parameter: { kind: "systemdUnit", label: "Unit", placeholder: "nginx.service" },
  facts: ["loadState", "activeState"],
};

const portListeners: CrossHostOperation = {
  id: "portListeners",
  label: "Listeners on a port",
  description: "TCP and UDP listeners bound to one port.",
  parameter: { kind: "port", label: "Port", placeholder: "443" },
  facts: ["listeners"],
};

function result(
  connectionId: string,
  state: CrossHostState,
  facts: { name: string; value: string }[] = [],
): CrossHostResult {
  return {
    runId: "run-1",
    connectionId,
    connectionName: `Host ${connectionId}`,
    state,
    message: null,
    collectedAt: state === "running" ? null : "2026-09-01T10:00:00Z",
    facts,
  };
}

describe("parameter validation", () => {
  it("accepts a unit id with a supported type and rejects shell syntax", () => {
    expect(validateParameter(unitState, "nginx.service")).toBeNull();
    expect(validateParameter(unitState, "  backup.timer  ")).toBeNull();
    expect(validateParameter(unitState, "nginx; reboot")).toBe("Enter one systemd unit id");
    expect(validateParameter(unitState, "$(id)")).toBe("Enter one systemd unit id");
    expect(validateParameter(unitState, "nginx")).toBe(
      "Include the unit type, such as nginx.service",
    );
    expect(validateParameter(unitState, "")).toBe("Unit is required");
  });

  it("bounds a port to the real range", () => {
    expect(validateParameter(portListeners, "443")).toBeNull();
    expect(validateParameter(portListeners, "0")).toBe("Enter a port between 1 and 65535");
    expect(validateParameter(portListeners, "70000")).toBe("Enter a port between 1 and 65535");
    expect(validateParameter(portListeners, "80x")).toBe("Enter a port between 1 and 65535");
  });

  it("needs no parameter for an operation that takes none", () => {
    expect(validateParameter(hostFacts, "")).toBeNull();
    expect(validateParameter(null, "")).toBeNull();
  });
});

describe("run gating", () => {
  it("needs an operation, a valid parameter, and at least one confirmed target", () => {
    expect(canRun(hostFacts, "", [])).toBe(false);
    expect(canRun(hostFacts, "", ["a"])).toBe(true);
    expect(canRun(unitState, "nginx", ["a"])).toBe(false);
    expect(canRun(unitState, "nginx.service", ["a"])).toBe(true);
    expect(canRun(null, "", ["a"])).toBe(false);
  });
});

describe("result table", () => {
  it("takes columns from the operation, not from whichever host answered", () => {
    expect(resultColumns(unitState)).toEqual(["loadState", "activeState"]);
    expect(resultColumns(null)).toEqual([]);
  });

  it("treats only a completed row as carrying values", () => {
    expect(isReadable("completed")).toBe(true);
    for (const state of [
      "running",
      "failed",
      "unsupported",
      "unreachable",
      "authenticationRequired",
      "permissionRequired",
      "cancelled",
    ] as CrossHostState[]) {
      expect(isReadable(state)).toBe(false);
    }
  });

  it("names every state distinctly", () => {
    expect(stateLabel("unreachable")).toBe("Unreachable");
    expect(stateLabel("authenticationRequired")).toBe("Authentication required");
    expect(stateLabel("permissionRequired")).toBe("Permission required");
    expect(stateLabel("unsupported")).toBe("Not supported");
  });

  it("reads a fact by name and reports a missing one as absent", () => {
    const row = result("a", "completed", [{ name: "kernel", value: "6.1.0" }]);
    expect(factValue(row, "kernel")).toBe("6.1.0");
    expect(factValue(row, "hostname")).toBeNull();
  });
});

describe("streamed rows", () => {
  it("replaces a running row with its final state instead of appending", () => {
    let rows = mergeResult([], result("a", "running"));
    rows = mergeResult(rows, result("b", "running"));
    rows = mergeResult(rows, result("a", "completed", [{ name: "kernel", value: "6.1.0" }]));
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("completed");
    expect(rows[1].state).toBe("running");
  });

  it("counts read, running, and unavailable hosts separately", () => {
    const rows = [
      result("a", "completed"),
      result("b", "running"),
      result("c", "unreachable"),
      result("d", "unsupported"),
    ];
    expect(summarizeRun(rows)).toBe("1 read, 1 running, 2 unavailable");
    expect(summarizeRun([result("a", "completed")])).toBe("1 read");
  });
});
