import { describe, expect, it } from "vitest";
import { buildPortGraph } from "./port-inspector";
import type { ConnectionSummary, DockerContainer, ListeningSocket } from "../types";

const socket: ListeningSocket = {
  id: "listener",
  protocol: "tcp",
  addressFamily: "ipv4",
  localAddress: "0.0.0.0",
  port: 443,
  processName: "nginx",
  processId: 42,
  systemdUnit: "nginx.service",
  ownership: "known",
};
const container: DockerContainer = {
  id: "gateway",
  name: "gateway-1",
  image: "gateway:latest",
  state: "running",
  status: "Up",
  ports: "0.0.0.0:443->8443/tcp, 127.0.0.1:8080->80/tcp",
  createdAt: "",
  composeProject: "proxy",
  composeService: "gateway",
  composeContainerNumber: 1,
  composeOneoff: false,
};
const connection: ConnectionSummary = {
  key: "peer",
  protocol: "tcp",
  localPort: 52000,
  processName: "curl",
  processId: 43,
  systemdUnit: null,
  established: 3,
  remoteAddressCount: 2,
  remotes: [
    { address: "203.0.113.7", count: 2 },
    { address: "203.0.113.9", count: 1 },
  ],
};

function graph(search = "", protocol = "all", exposure: "all" | "local-only" = "all") {
  return buildPortGraph([socket], [container], [connection], search, protocol, exposure, "all");
}

describe("Ports graph inventory", () => {
  it("includes outbound connection summaries and Docker mappings without a listening socket", () => {
    const groups = graph();
    expect(
      groups
        .flatMap((group) => group.items)
        .map((item) => item.kind)
        .sort(),
    ).toEqual(["connections", "docker", "docker", "listeners"]);
    const containerGroup = groups.find((group) => group.key === "container:gateway")!;
    expect(containerGroup.items.map((item) => item.kind)).toContain("listeners");
    expect(groups.find((group) => group.key === "process:curl")?.items[0]).toMatchObject({
      connection,
    });
    // Same port across different evidence types must remain independently selectable.
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("searches remote endpoints, container targets, image names, and Compose services", () => {
    expect(graph("203.0.113.9").flatMap((group) => group.items)).toMatchObject([
      { kind: "connections" },
    ]);
    expect(graph("8443").flatMap((group) => group.items)).toMatchObject([{ kind: "docker" }]);
    expect(graph("gateway:latest").flatMap((group) => group.items)).toHaveLength(2);
    expect(graph("proxy").flatMap((group) => group.items)).toHaveLength(3);
  });

  it("filters every evidence type by protocol and only known bind addresses by exposure", () => {
    expect(graph("", "udp")).toEqual([]);
    const local = graph("", "tcp", "local-only").flatMap((group) => group.items);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ kind: "docker", binding: { hostPort: 8080 } });
  });

  it("sorts ports within owners in both directions without changing the input", () => {
    const sockets = [socket, { ...socket, id: "second", port: 80 }];
    const asc = buildPortGraph(sockets, [], [], "", "all", "all", "listeners", "port-asc");
    const desc = buildPortGraph(sockets, [], [], "", "all", "all", "listeners", "port-desc");
    expect(asc[0].items.map((item) => item.id)).toEqual(["listener:second", "listener:listener"]);
    expect(desc[0].items.map((item) => item.id)).toEqual(["listener:listener", "listener:second"]);
    expect(sockets[0].port).toBe(443);
  });
});
