import { describe, expect, it } from "vitest";
import { buildPortOverview } from "./port-overview";
import type { ConnectionSummary, DockerContainer, ListeningSocket } from "../types";

const socket: ListeningSocket = {
  id: "v4",
  protocol: "tcp",
  port: 443,
  addressFamily: "ipv4",
  localAddress: "0.0.0.0",
  processName: "nginx",
  processId: 742,
  systemdUnit: "nginx.service",
  ownership: "known",
};
const container: DockerContainer = {
  id: "gateway",
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
};
const connection: ConnectionSummary = {
  key: "peers",
  protocol: "tcp",
  localPort: 443,
  processName: "nginx",
  processId: 742,
  systemdUnit: "nginx.service",
  established: 12,
  remoteAddressCount: 1,
  remotes: [{ address: "203.0.113.9", count: 12 }],
};
const graph = (sockets = [socket], containers = [container], connections = [connection]) =>
  buildPortOverview(sockets, containers, connections, "", "all", "all", "all");
const items = (result: ReturnType<typeof graph>) => result.flatMap((group) => group.items);

describe("consolidated port graph", () => {
  it("combines Docker, dual-stack listeners and established evidence without discarding records", () => {
    const v6: ListeningSocket = { ...socket, id: "v6", addressFamily: "ipv6", localAddress: "::" };
    const result = graph([socket, v6]);
    expect(result).toHaveLength(1);
    expect(result[0].owner.label).toBe("gateway-1");
    expect(items(result)).toHaveLength(1);
    expect(items(result)[0].sockets).toEqual([socket, v6]);
    expect(items(result)[0].bindings).toHaveLength(2);
    expect(items(result)[0].connections).toEqual([connection]);
  });
  it("never merges different protocols, services, processes or unknown owners just by port", () => {
    const sockets = [
      socket,
      { ...socket, id: "udp", protocol: "udp" as const },
      { ...socket, id: "other-service", systemdUnit: "other.service" },
      { ...socket, id: "pid1", systemdUnit: null, processId: 1 },
      { ...socket, id: "pid2", systemdUnit: null, processId: 2 },
      { ...socket, id: "unknown1", systemdUnit: null, processName: null, processId: null },
      { ...socket, id: "unknown2", systemdUnit: null, processName: null, processId: null },
    ];
    expect(items(graph(sockets, [], []))).toHaveLength(7);
  });
  it("keeps same-family bindings and raw socket IDs even when grouped", () => {
    const second = { ...socket, id: "lan", localAddress: "192.168.1.2" };
    const result = items(graph([socket, second], [], []));
    expect(result).toHaveLength(1);
    expect(result[0].sockets.map((entry) => entry.id)).toEqual(["v4", "lan"]);
  });
  it("does not assign an ambiguous Docker publication to a listener", () => {
    const result = items(
      graph([socket], [container, { ...container, id: "second", name: "second" }], []),
    );
    expect(result).toHaveLength(3);
    expect(result.find((entry) => entry.sockets.length)?.owner.kind).toBe("service");
    expect(
      result.filter((entry) => entry.bindings.length).every((entry) => !entry.sockets.length),
    ).toBe(true);
  });
  it("does not infer container ownership from a matching port with another address or protocol", () => {
    const result = items(
      graph(
        [
          { ...socket, localAddress: "127.0.0.1" },
          { ...socket, id: "udp", protocol: "udp" },
        ],
        [container],
        [],
      ),
    );
    expect(
      result.filter((entry) => entry.sockets.length).every((entry) => !entry.bindings.length),
    ).toBe(true);
  });
  it("keeps uncorrelated and ambiguous peers separate", () => {
    const result = items(
      graph(
        [socket, { ...socket, id: "second", localAddress: "127.0.0.1" }],
        [container],
        [connection, { ...connection, key: "other", systemdUnit: "other.service" }],
      ),
    );
    expect(
      result.filter((entry) => entry.connections.length).every((entry) => !entry.sockets.length),
    ).toBe(true);
  });
  it("hides connection-only endpoints by default and reveals them through the toggle", () => {
    const outbound = { ...connection, key: "outbound", localPort: 49100 };
    const build = (show = false) =>
      buildPortOverview(
        [socket],
        [container],
        [connection, outbound],
        "",
        "all",
        "all",
        "overview",
        "port-asc",
        show,
      );
    expect(items(build())).toHaveLength(1);
    expect(items(build())[0].connections).toEqual([connection]);
    expect(items(build(true))).toHaveLength(2);
  });
  it("isolates listeners, Docker publications and connections while retaining related evidence", () => {
    const sockets = [socket, { ...socket, id: "loopback", port: 53, localAddress: "127.0.0.1" }];
    const connections = [connection, { ...connection, key: "outbound", localPort: 49100 }];
    const build = (kind: "listeners" | "docker" | "connections") =>
      items(buildPortOverview(sockets, [container], connections, "", "all", "all", kind));
    expect(build("listeners")).toHaveLength(2);
    expect(build("docker")).toHaveLength(1);
    expect(build("connections")).toHaveLength(2);
    expect(build("docker")[0].sockets).toEqual([socket]);
  });
  it("filters loopback and non-loopback bindings without guessing a connection's scope", () => {
    const loopback = {
      ...socket,
      id: "local",
      localAddress: "::1",
      addressFamily: "ipv6" as const,
    };
    const build = (scope: "local-only" | "non-loopback") =>
      items(
        buildPortOverview(
          [socket, loopback],
          [],
          [{ ...connection, localPort: 49100 }],
          "",
          "all",
          scope,
          "all",
        ),
      );
    expect(build("local-only")[0].sockets).toEqual([loopback]);
    expect(build("non-loopback")[0].sockets).toEqual([socket]);
    expect(build("local-only")).toHaveLength(1);
  });
  it("searches owner, Compose, target port and endpoints; sorts endpoints consistently", () => {
    for (const query of ["proxy", "8443", "203.0.113.9"])
      expect(
        items(
          buildPortOverview([socket], [container], [connection], query, "tcp", "all", "overview"),
        ),
      ).toHaveLength(1);
    const result = buildPortOverview(
      [socket, { ...socket, id: "80", port: 80 }],
      [],
      [],
      "",
      "all",
      "all",
      "all",
      "port-desc",
    );
    expect(items(result).map((entry) => entry.port)).toEqual([443, 80]);
  });
  it("conserves source records under ambiguous and missing ownership", () => {
    const inputs = [
      socket,
      { ...socket, id: "duplicate-socket" },
      { ...socket, id: "unknown", systemdUnit: null, processId: null, processName: null },
    ];
    const publications = [container, { ...container, id: "ambiguous", name: "ambiguous" }];
    const peers = [
      connection,
      {
        ...connection,
        key: "missing-owner",
        systemdUnit: null,
        processId: null,
        processName: null,
      },
    ];
    const entries = items(graph(inputs, publications, peers));
    expect(
      entries
        .flatMap((entry) => entry.sockets)
        .map((record) => record.id)
        .sort(),
    ).toEqual(inputs.map((record) => record.id).sort());
    expect(
      entries
        .flatMap((entry) => entry.connections)
        .map((record) => record.key)
        .sort(),
    ).toEqual(peers.map((record) => record.key).sort());
    expect(entries.flatMap((entry) => entry.bindings)).toHaveLength(4);
  });
});
