import type { ConnectionSummary, DockerContainer, ListeningSocket } from "../types";
import {
  dockerPortLinks,
  socketOwner,
  socketExposure,
  type DockerPortLink,
  type Exposure,
  type PortGraphKind,
  type PortSort,
  type SocketOwner,
} from "./port-inspector";

export interface PortOverviewItem {
  id: string;
  owner: SocketOwner;
  port: number;
  protocol: string;
  sockets: ListeningSocket[];
  bindings: DockerPortLink[];
  connections: ConnectionSummary[];
  /** Presentation relationship only; does not establish service/container ownership. */
  relatedTo?: string;
}

export function matchesPortScope(address: string, exposure: Exposure | "all") {
  return (
    exposure === "all" ||
    (exposure === "non-loopback"
      ? socketExposure(address) !== "local-only"
      : socketExposure(address) === exposure)
  );
}

function ownerKey(
  socket: Pick<ListeningSocket, "systemdUnit" | "processId" | "processName">,
  fallback: string,
) {
  if (socket.systemdUnit) return "service:" + socket.systemdUnit;
  if (socket.processId !== null) return "process:" + socket.processId;
  return "unknown:" + fallback;
}

/** Consolidate presentation only. Every socket, mapping and peer summary is retained. */
export function buildPortOverview(
  sockets: ListeningSocket[],
  containers: DockerContainer[],
  connections: ConnectionSummary[],
  search: string,
  protocol: string,
  exposure: Exposure | "all",
  kind: PortGraphKind,
  sort: PortSort = "port-asc",
  showConnections = false,
) {
  const entries = new Map<string, PortOverviewItem>();
  const publishedEndpoints = new Map<string, Set<PortOverviewItem>>();
  const listeningEndpoints = new Map<string, Set<PortOverviewItem>>();
  const index = (table: Map<string, Set<PortOverviewItem>>, entry: PortOverviewItem) => {
    const key = entry.protocol + ":" + entry.port;
    const candidates = table.get(key) ?? new Set<PortOverviewItem>();
    candidates.add(entry);
    table.set(key, candidates);
  };
  const add = (id: string, owner: SocketOwner, port: number, protocol: string) => {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, owner, port, protocol, sockets: [], bindings: [], connections: [] };
      entries.set(id, entry);
    }
    return entry;
  };
  for (const binding of dockerPortLinks(containers)) {
    const entry = add(
      "container:" +
        binding.container.id +
        ":" +
        binding.protocol +
        ":" +
        binding.hostPort +
        ":" +
        binding.containerPort,
      { kind: "container", label: binding.container.name },
      binding.hostPort,
      binding.protocol,
    );
    entry.bindings.push(binding);
    index(publishedEndpoints, entry);
  }
  for (const socket of sockets) {
    const candidates = [
      ...(publishedEndpoints.get(socket.protocol + ":" + socket.port) ?? []),
    ].filter((entry) =>
      entry.bindings.some(
        (binding) =>
          binding.hostPort === socket.port &&
          binding.protocol === socket.protocol &&
          binding.hostAddress === socket.localAddress.replace(/^\[|\]$/g, ""),
      ),
    );
    // An ambiguous mapping never becomes ownership evidence.
    const entry =
      candidates.length === 1
        ? candidates[0]
        : add(
            ownerKey(socket, socket.id) + ":" + socket.protocol + ":" + socket.port,
            socketOwner(socket, null),
            socket.port,
            socket.protocol,
          );
    entry.sockets.push(socket);
    index(listeningEndpoints, entry);
  }
  for (const connection of connections) {
    const candidates = [
      ...(listeningEndpoints.get(connection.protocol + ":" + connection.localPort) ?? []),
    ].filter(
      (entry) =>
        entry.port === connection.localPort &&
        entry.protocol === connection.protocol &&
        entry.sockets.some((socket) =>
          connection.systemdUnit && socket.systemdUnit
            ? connection.systemdUnit === socket.systemdUnit
            : connection.processId !== null && socket.processId === connection.processId,
        ),
    );
    const owner: SocketOwner = connection.systemdUnit
      ? { kind: "service", label: connection.systemdUnit }
      : connection.processName
        ? { kind: "process", label: connection.processName }
        : { kind: "unknown", label: "Unknown process" };
    const entry =
      candidates.length === 1
        ? candidates[0]
        : add(
            "peers:" +
              ownerKey(connection, connection.key) +
              ":" +
              connection.protocol +
              ":" +
              connection.localPort,
            owner,
            connection.localPort,
            connection.protocol,
          );
    entry.connections.push(connection);
  }
  const query = search.trim().toLowerCase();
  const groups = new Map<string, { key: string; owner: SocketOwner; items: PortOverviewItem[] }>();
  for (const entry of entries.values()) {
    if (protocol !== "all" && entry.protocol !== protocol) continue;
    const boundSockets = entry.sockets.filter((socket) =>
      matchesPortScope(socket.localAddress, exposure),
    );
    const published = entry.bindings.filter((binding) =>
      matchesPortScope(binding.hostAddress, exposure),
    );
    if (exposure !== "all" && !boundSockets.length && !published.length) continue;
    if (kind === "listeners" && !boundSockets.length) continue;
    if (kind === "docker" && !published.length) continue;
    if (kind === "connections" && !entry.connections.length) continue;
    if (kind === "overview" && !showConnections && !boundSockets.length && !published.length)
      continue;
    const values = [
      entry.port,
      entry.protocol,
      entry.owner.label,
      ...boundSockets.flatMap((socket) => [
        socket.localAddress,
        socket.addressFamily,
        socket.processName,
        socket.processId,
        socket.systemdUnit,
      ]),
      ...published.flatMap((binding) => [
        binding.hostAddress,
        binding.containerPort,
        binding.container.id,
        binding.container.name,
        binding.container.image,
        binding.container.composeProject,
        binding.container.composeService,
      ]),
      ...entry.connections.flatMap((connection) => [
        connection.systemdUnit,
        connection.processName,
        connection.processId,
        ...connection.remotes.map((remote) => remote.address),
      ]),
    ];
    if (
      query &&
      !values.some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(query),
      )
    )
      continue;
    const visible = { ...entry, sockets: boundSockets, bindings: published };
    // Service identity is explicit; process identity includes PID; unknown owners stay separate.
    const key =
      entry.owner.kind === "container"
        ? "container:" + entry.bindings[0].container.id
        : entry.owner.kind === "service"
          ? "service:" + entry.owner.label
          : entry.owner.kind === "process"
            ? "process:" +
              (entry.sockets[0]?.processId ?? entry.connections[0]?.processId ?? entry.id)
            : entry.id;
    const group = groups.get(key);
    if (group) group.items.push(visible);
    else groups.set(key, { key, owner: entry.owner, items: [visible] });
  }
  // Keep worker/peer records close to a unique related listener without merging evidence.
  const listeningGroups = [...groups.values()].filter((group) =>
    group.items.some((item) => item.sockets.length),
  );
  for (const group of [...groups.values()]) {
    group.items = group.items.filter((item) => {
      if (
        item.sockets.length ||
        item.bindings.length ||
        !item.connections.length ||
        item.connections.some((connection) => connection.systemdUnit)
      )
        return true;
      const byPid = listeningGroups.filter((parent) =>
        item.connections.every(
          (connection) =>
            connection.processId !== null &&
            parent.items.some((endpoint) =>
              endpoint.sockets.some((socket) => socket.processId === connection.processId),
            ),
        ),
      );
      const candidates = byPid.length
        ? byPid
        : listeningGroups.filter((parent) =>
            item.connections.every(
              (connection) =>
                connection.processName &&
                parent.items.some(
                  (endpoint) =>
                    endpoint.port === connection.localPort &&
                    endpoint.protocol === connection.protocol &&
                    endpoint.sockets.some(
                      (socket) => socket.processName === connection.processName,
                    ),
                ),
            ),
          );
      if (candidates.length !== 1 || candidates[0] === group) return true;
      const parent = candidates[0];
      parent.items.push({ ...item, relatedTo: parent.owner.label });
      return false;
    });
    if (!group.items.length) groups.delete(group.key);
  }
  for (const group of groups.values())
    group.items.sort((a, b) => {
      const secondary =
        Number(!a.sockets.length && !a.bindings.length) -
        Number(!b.sockets.length && !b.bindings.length);
      if (secondary) return secondary;
      if (sort === "port-desc") return b.port - a.port || a.id.localeCompare(b.id);
      if (sort === "protocol") return a.protocol.localeCompare(b.protocol) || a.port - b.port;
      if (sort === "process")
        return (
          (
            a.sockets[0]?.processName ??
            a.connections[0]?.processName ??
            a.owner.label
          ).localeCompare(
            b.sockets[0]?.processName ?? b.connections[0]?.processName ?? b.owner.label,
          ) || a.port - b.port
        );
      if (sort === "address")
        return (
          (a.sockets[0]?.localAddress ?? a.bindings[0]?.hostAddress ?? "").localeCompare(
            b.sockets[0]?.localAddress ?? b.bindings[0]?.hostAddress ?? "",
          ) || a.port - b.port
        );
      return a.port - b.port || a.id.localeCompare(b.id);
    });
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.items.every((item) => !item.sockets.length && !item.bindings.length)) -
        Number(b.items.every((item) => !item.sockets.length && !item.bindings.length)) ||
      a.owner.label.localeCompare(b.owner.label),
  );
}
