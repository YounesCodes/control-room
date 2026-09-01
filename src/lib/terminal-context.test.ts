import { describe, expect, it } from "vitest";
import {
  contextKindLabel,
  resolveDockerContainer,
  resolveSystemdUnit,
  unresolvedMessage,
} from "./terminal-context";
import type { DockerContainer, SystemdUnit, TerminalContextReference } from "../types";

function unit(id: string): SystemdUnit {
  return {
    id,
    unitType: "service",
    description: id,
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    unitFileState: "enabled",
  };
}

function container(id: string, name: string): DockerContainer {
  return {
    id,
    name,
    image: "image:latest",
    state: "running",
    status: "Up",
    ports: "",
    createdAt: "",
    composeProject: null,
    composeService: null,
    composeContainerNumber: null,
    composeOneoff: null,
  };
}

const unitReference: TerminalContextReference = {
  kind: "systemdUnit",
  id: "nginx.service",
  sourceCommand: "systemctl status nginx",
};
const containerReference: TerminalContextReference = {
  kind: "dockerContainer",
  id: "api",
  sourceCommand: "docker logs api",
};

describe("systemd context resolution", () => {
  it("resolves an exact unit id from the fresh list", () => {
    const resolution = resolveSystemdUnit(
      [unit("ssh.service"), unit("nginx.service")],
      "nginx.service",
    );
    expect(resolution).toEqual({ status: "resolved", match: unit("nginx.service") });
  });

  it("reports a removed or renamed unit as missing", () => {
    expect(resolveSystemdUnit([unit("ssh.service")], "nginx.service")).toEqual({
      status: "missing",
    });
    expect(unresolvedMessage(unitReference, { status: "missing" })).toBe(
      "No systemd unit named nginx.service is in the current list.",
    );
  });
});

describe("container context resolution", () => {
  const web = container("a".repeat(64), "web");
  const worker = container(`ab${"c".repeat(62)}`, "worker");

  it("prefers an exact name over an id prefix", () => {
    expect(resolveDockerContainer([web, worker], "web")).toEqual({
      status: "resolved",
      match: web,
    });
  });

  it("resolves a unique short id prefix", () => {
    expect(resolveDockerContainer([web, worker], "abc")).toEqual({
      status: "resolved",
      match: worker,
    });
  });

  it("reports an ambiguous prefix instead of guessing", () => {
    const sibling = container(`ab${"d".repeat(62)}`, "sidecar");
    const resolution = resolveDockerContainer([worker, sibling], "ab");
    expect(resolution).toEqual({ status: "ambiguous", count: 2 });
    expect(unresolvedMessage(containerReference, resolution)).toBe(
      "api matches 2 containers. Use the full name or id.",
    );
  });

  it("does not treat a non-hex reference as an id prefix", () => {
    expect(resolveDockerContainer([web], "we")).toEqual({ status: "missing" });
  });
});

describe("context labels", () => {
  it("names the object type without inventing a confidence level", () => {
    expect(contextKindLabel(unitReference)).toBe("Systemd unit");
    expect(contextKindLabel(containerReference)).toBe("Container");
    expect(unresolvedMessage(unitReference, { status: "resolved", match: null })).toBeNull();
  });
});
