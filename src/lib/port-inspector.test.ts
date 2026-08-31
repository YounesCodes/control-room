import { describe, expect, it } from "vitest";
import type { DockerContainer, ListeningSocket } from "../types";
import { filterAndSortSockets, resolveSocketContainer, socketScope } from "./port-inspector";

function socket(overrides: Partial<ListeningSocket> = {}): ListeningSocket {
  return {
    id: "tcp:0.0.0.0:443:0",
    protocol: "tcp",
    addressFamily: "ipv4",
    localAddress: "0.0.0.0",
    port: 443,
    processName: "nginx",
    processId: 742,
    systemdUnit: "nginx.service",
    ownership: "known",
    ...overrides,
  };
}

function container(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "container-id",
    name: "gateway-1",
    image: "gateway:latest",
    state: "running",
    status: "Up",
    ports: "0.0.0.0:443->8443/tcp, [::]:443->8443/tcp",
    createdAt: "today",
    composeProject: "proxy",
    composeService: "gateway",
    composeContainerNumber: 1,
    composeOneoff: false,
    ...overrides,
  };
}

describe("port inspector", () => {
  it("correlates only one exact Docker address, port, and protocol match", () => {
    expect(resolveSocketContainer(socket(), [container()])?.container.name).toBe("gateway-1");
    expect(resolveSocketContainer(socket({ protocol: "udp" }), [container()])).toBeNull();
    expect(resolveSocketContainer(socket(), [container(), container({ id: "second" })])).toBeNull();
  });

  it("filters by service, container, address, process, and port", () => {
    const sockets = [socket(), socket({ id: "udp:127.0.0.1:53:1", protocol: "udp", port: 53 })];
    expect(filterAndSortSockets(sockets, [container()], "proxy", "all", "port-asc")).toHaveLength(
      1,
    );
    expect(filterAndSortSockets(sockets, [], "nginx.service", "tcp", "port-asc")).toHaveLength(1);
    expect(filterAndSortSockets(sockets, [], "53", "udp", "port-asc")[0].port).toBe(53);
  });

  it("labels wildcard, loopback, and specific bind scopes", () => {
    expect(socketScope(socket())).toBe("Wildcard");
    expect(socketScope(socket({ localAddress: "::1" }))).toBe("Loopback");
    expect(socketScope(socket({ localAddress: "192.0.2.10" }))).toBe("Specific address");
  });
});
