import { describe, expect, it } from "vitest";
import type { DockerContainer, FirewallStatus, ListeningSocket } from "../types";
import {
  dockerPortLinks,
  exposureLabel,
  filterAndSortSockets,
  firewallForSocket,
  groupSocketsByOwner,
  resolveSocketContainer,
  socketExposure,
  socketOwner,
  socketScope,
} from "./port-inspector";

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

  it("derives exposure purely from the bind address", () => {
    expect(socketExposure("0.0.0.0")).toBe("all-interfaces");
    expect(socketExposure("::")).toBe("all-interfaces");
    expect(socketExposure("127.0.0.1")).toBe("local-only");
    expect(socketExposure("::1")).toBe("local-only");
    expect(socketExposure("192.0.2.10")).toBe("specific");
    expect(exposureLabel(socketExposure("0.0.0.0"))).toBe("All interfaces");
  });

  it("prefers container, then service, then process for the owner node", () => {
    expect(socketOwner(socket(), resolveSocketContainer(socket(), [container()])).kind).toBe(
      "container",
    );
    expect(socketOwner(socket(), null)).toEqual({ kind: "service", label: "nginx.service" });
    expect(socketOwner(socket({ systemdUnit: null }), null)).toEqual({
      kind: "process",
      label: "nginx",
    });
    expect(socketOwner(socket({ systemdUnit: null, processName: null }), null)).toEqual({
      kind: "unknown",
      label: "Unknown process",
    });
  });

  it("maps firewall policy separately from binding and never assumes reachability", () => {
    const firewall = (overrides: Partial<FirewallStatus> = {}): FirewallStatus => ({
      available: true,
      active: true,
      defaultIncoming: "deny",
      rules: [],
      collectedAt: "",
      ...overrides,
    });
    const allowAnywhere = firewall({
      rules: [
        {
          to: "443/tcp",
          action: "ALLOW",
          from: "Anywhere",
          port: 443,
          protocol: "tcp",
          ipv6: false,
        },
      ],
    });
    expect(firewallForSocket(allowAnywhere, socket())).toEqual({
      state: "allowed",
      label: "UFW: allowed",
    });
    const allowLan = firewall({
      rules: [
        {
          to: "443/tcp",
          action: "ALLOW",
          from: "192.168.0.0/16",
          port: 443,
          protocol: "tcp",
          ipv6: false,
        },
      ],
    });
    expect(firewallForSocket(allowLan, socket()).label).toBe("UFW: LAN only");
    const denied = firewall({
      rules: [
        { to: "443", action: "DENY", from: "Anywhere", port: 443, protocol: null, ipv6: false },
      ],
    });
    expect(firewallForSocket(denied, socket()).state).toBe("denied");
    // No matching rule falls back to the default policy.
    expect(firewallForSocket(firewall(), socket()).label).toBe("UFW default: deny incoming");
    expect(firewallForSocket(firewall({ active: false }), socket()).state).toBe("inactive");
    expect(firewallForSocket(firewall({ available: false }), socket()).state).toBe("unavailable");
    expect(firewallForSocket(null, socket()).state).toBe("unavailable");
    // An IPv6 socket is not matched by an IPv4 rule.
    expect(
      firewallForSocket(allowAnywhere, socket({ addressFamily: "ipv6", localAddress: "::" })).state,
    ).toBe("no-rule");
  });

  it("groups listeners by owner and orders containers, services, then unknowns", () => {
    const web80 = socket({ id: "tcp:0.0.0.0:80:0", port: 80, systemdUnit: "nginx.service" });
    const web443 = socket({ id: "tcp:0.0.0.0:443:1", port: 443, systemdUnit: "nginx.service" });
    const unknown = socket({
      id: "udp:127.0.0.1:53:2",
      protocol: "udp",
      port: 53,
      localAddress: "127.0.0.1",
      processName: null,
      processId: null,
      systemdUnit: null,
      ownership: "unavailable",
    });
    // Docker-owned socket (443 tcp on 0.0.0.0 matches the container) sorts first.
    const groups = groupSocketsByOwner([web443, unknown, web80], [container()]);
    expect(groups.map((group) => group.owner.kind)).toEqual(["container", "service", "unknown"]);
    const service = groups.find((group) => group.owner.kind === "service");
    // Both nginx ports collapse into one service group, sorted by port.
    expect(service?.sockets.map((entry) => entry.port)).toEqual([80]);
    expect(groups[2].owner.label).toBe("Unknown process");
  });

  it("builds Docker host-to-container port links with target ports", () => {
    const links = dockerPortLinks([container()]);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ hostPort: 443, containerPort: 8443, protocol: "tcp" });
    expect(links[0].container.name).toBe("gateway-1");
  });
});
