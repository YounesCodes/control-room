import type { ConnectionSummary, DockerContainer, FirewallStatus, ListeningSocket } from "../types";

export type PortSort = "port-asc" | "port-desc" | "protocol" | "address" | "process";
export type Exposure = "all-interfaces" | "local-only" | "specific";

export interface SocketContainerOwner {
  container: DockerContainer;
  composeProject: string | null;
}

interface PublishedBinding {
  address: string;
  port: number;
  protocol: "tcp" | "udp";
  targetPort: number;
}

function normalizeAddress(value: string) {
  return value.trim().replace(/^\[(.*)\]$/, "$1");
}

function publishedBindings(container: DockerContainer): PublishedBinding[] {
  return container.ports.split(",").flatMap((raw) => {
    const mapping = raw.trim();
    const arrow = mapping.indexOf("->");
    if (arrow < 0) return [];
    const host = mapping.slice(0, arrow);
    const target = mapping.slice(arrow + 2);
    const separator = host.lastIndexOf(":");
    const protocolSeparator = target.lastIndexOf("/");
    if (separator < 0 || protocolSeparator < 0) return [];
    const port = Number(host.slice(separator + 1));
    const targetPort = Number(target.slice(0, protocolSeparator));
    const protocol = target.slice(protocolSeparator + 1).toLowerCase();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) return [];
    if (protocol !== "tcp" && protocol !== "udp") return [];
    return [
      {
        address: normalizeAddress(host.slice(0, separator)),
        port,
        protocol,
        targetPort,
      },
    ];
  });
}

export interface DockerPortLink {
  key: string;
  hostAddress: string;
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
  container: DockerContainer;
}

/** Published host-port to container-port mappings, for the Docker topology view. */
export function dockerPortLinks(containers: DockerContainer[]): DockerPortLink[] {
  const links = containers.flatMap((container) =>
    publishedBindings(container).map((binding) => ({
      key: `${container.id}:${binding.protocol}:${binding.address}:${binding.port}:${binding.targetPort}`,
      hostAddress: binding.address,
      hostPort: binding.port,
      containerPort: binding.targetPort,
      protocol: binding.protocol,
      container,
    })),
  );
  return links.sort(
    (left, right) =>
      left.hostPort - right.hostPort ||
      left.container.name.localeCompare(right.container.name) ||
      left.key.localeCompare(right.key),
  );
}

export function resolveSocketContainer(
  socket: ListeningSocket,
  containers: DockerContainer[],
): SocketContainerOwner | null {
  const matches = containers.filter((container) =>
    publishedBindings(container).some(
      (binding) =>
        binding.port === socket.port &&
        binding.protocol === socket.protocol &&
        binding.address === normalizeAddress(socket.localAddress),
    ),
  );
  if (matches.length !== 1) return null;
  return { container: matches[0], composeProject: matches[0].composeProject };
}

export function socketScope(socket: ListeningSocket) {
  if (["*", "0.0.0.0", "::"].includes(socket.localAddress)) return "Wildcard";
  if (socket.localAddress === "::1" || socket.localAddress.startsWith("127.")) return "Loopback";
  return "Specific address";
}

/** Where a socket accepts connections, derived purely from its bind address. */
export function socketExposure(address: string): Exposure {
  if (["*", "0.0.0.0", "::"].includes(address)) return "all-interfaces";
  if (address === "::1" || address.startsWith("127.")) return "local-only";
  return "specific";
}

export function exposureLabel(exposure: Exposure): string {
  if (exposure === "all-interfaces") return "All interfaces";
  if (exposure === "local-only") return "Local only";
  return "Specific address";
}

/**
 * Why some listeners have no recorded owner. The two causes need different
 * answers: one is a privilege wall, the other is a fact about the host that no
 * amount of privilege changes.
 */
export interface OwnerGapNotice {
  message: string;
  /** True only when running the same read as root could actually help. */
  offerSudo: boolean;
}

/**
 * `elevated` says whether the read that produced these sockets already ran as
 * root. Without it the pane would keep blaming a privilege wall for listeners
 * that were read as root and still have no single owner.
 */
export function ownerGapNotice(
  sockets: Pick<ListeningSocket, "ownership">[],
  elevated: boolean,
): OwnerGapNotice | null {
  const unattributed = sockets.some((socket) => socket.ownership === "unavailable");
  // Several processes hold one listening socket, the prefork and worker pattern.
  // The owning PID is genuinely ambiguous, so root sees exactly what you see.
  const ambiguous = sockets.some((socket) => socket.ownership === "ambiguous");

  if (!unattributed && !ambiguous) return null;

  if (unattributed && !elevated) {
    return {
      message: ambiguous
        ? "Some listeners could not be attributed to a process without elevation, and some are held by several processes at once."
        : "Some listeners could not be attributed to a process without elevation.",
      offerSudo: true,
    };
  }

  if (unattributed) {
    return {
      message: ambiguous
        ? "This read ran as root. Some listeners still have no owning process, and some are held by several processes at once."
        : "This read ran as root. Some listeners still have no owning process, which is normal for kernel-side sockets.",
      offerSudo: false,
    };
  }

  return {
    message:
      "Some listeners are held by several processes at once, so no single owner is recorded. Elevation does not change this.",
    offerSudo: false,
  };
}

export type OwnerKind = "container" | "service" | "process" | "unknown";

export interface SocketOwner {
  kind: OwnerKind;
  label: string;
}

/** The primary owner node label for a socket: container, then service, then process. */
export function socketOwner(
  socket: ListeningSocket,
  container: SocketContainerOwner | null,
): SocketOwner {
  if (container) return { kind: "container", label: container.container.name };
  if (socket.systemdUnit) return { kind: "service", label: socket.systemdUnit };
  if (socket.processName) return { kind: "process", label: socket.processName };
  return { kind: "unknown", label: "Unknown process" };
}

export interface OwnerGroup {
  key: string;
  owner: SocketOwner;
  container: SocketContainerOwner | null;
  sockets: ListeningSocket[];
}

const OWNER_KIND_ORDER: Record<OwnerKind, number> = {
  container: 0,
  service: 1,
  process: 2,
  unknown: 3,
};

/**
 * Group listeners by their owning container, service, or process so the
 * architecture view shows one boundary per owner (like a service box in an
 * AWS-style diagram) instead of one scattered node per port.
 */
export function groupSocketsByOwner(
  sockets: ListeningSocket[],
  containers: DockerContainer[],
): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>();
  for (const socket of sockets) {
    const container = resolveSocketContainer(socket, containers);
    const owner = socketOwner(socket, container);
    const key =
      owner.kind === "container"
        ? `container:${container?.container.id ?? owner.label}`
        : owner.kind === "unknown"
          ? "unknown"
          : `${owner.kind}:${owner.label}`;
    const existing = groups.get(key);
    if (existing) existing.sockets.push(socket);
    else groups.set(key, { key, owner, container, sockets: [socket] });
  }
  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.sockets.sort((left, right) => left.port - right.port || left.id.localeCompare(right.id));
  }
  return ordered.sort(
    (left, right) =>
      OWNER_KIND_ORDER[left.owner.kind] - OWNER_KIND_ORDER[right.owner.kind] ||
      left.owner.label.localeCompare(right.owner.label),
  );
}

export type FirewallState =
  | "unavailable"
  | "inactive"
  | "unknown"
  | "allowed"
  | "denied"
  | "limited"
  | "rejected"
  | "no-rule";

export interface FirewallDisposition {
  state: FirewallState;
  label: string;
}

function isPrivateSource(value: string): boolean {
  const source = value.toLowerCase();
  return (
    source.startsWith("10.") ||
    source.startsWith("192.168.") ||
    source.startsWith("169.254.") ||
    source.startsWith("fd") ||
    source.startsWith("fe80") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(source)
  );
}

/**
 * Firewall disposition for one listener. This is deliberately separate from where the socket binds: a broad bind does not imply
 * Internet reachability, and a firewall rule does not change the binding.
 */
export function firewallForSocket(
  firewall: FirewallStatus | null,
  socket: ListeningSocket,
): FirewallDisposition {
  if (!firewall || !firewall.available) {
    return { state: "unavailable", label: "Firewall status unavailable" };
  }
  if (firewall.backend === "windows") {
    return { state: "unknown", label: "Windows Firewall: profile policies only" };
  }
  if (firewall.active === false) return { state: "inactive", label: "Firewall inactive" };
  if (firewall.active !== true) return { state: "unknown", label: "Firewall status unknown" };

  const backend =
    firewall.backend === "firewalld"
      ? "firewalld"
      : firewall.backend === "ufw"
        ? "UFW"
        : "Firewall";

  const match = firewall.rules.find(
    (rule) =>
      rule.port === socket.port &&
      (!rule.protocol || rule.protocol === socket.protocol) &&
      rule.ipv6 === (socket.addressFamily === "ipv6"),
  );
  if (!match) {
    return firewall.defaultIncoming
      ? { state: "no-rule", label: `${backend} default: ${firewall.defaultIncoming} incoming` }
      : { state: "no-rule", label: `${backend}: no matching numeric port rule` };
  }

  // A firewalld rule belongs to a zone, not directly to a bind address. Ports
  // does not collect interface membership, so keep the rule as policy evidence
  // without claiming that it governs this listener.
  if (firewall.backend === "firewalld") {
    return {
      state: "unknown",
      label: `firewalld: open in ${match.from}`,
    };
  }

  const action = match.action.toUpperCase();
  if (action === "DENY") return { state: "denied", label: `${backend}: denied` };
  if (action === "REJECT") return { state: "rejected", label: `${backend}: rejected` };
  if (action === "LIMIT") return { state: "limited", label: `${backend}: rate-limited` };

  const from = match.from.replace(/\(v6\)/i, "").trim();
  if (!from || /^anywhere$/i.test(from)) return { state: "allowed", label: `${backend}: allowed` };
  if (isPrivateSource(from)) return { state: "allowed", label: `${backend}: LAN only` };
  return { state: "allowed", label: `${backend}: ${from}` };
}

export function filterAndSortSockets(
  sockets: ListeningSocket[],
  containers: DockerContainer[],
  search: string,
  protocol: string,
  sort: PortSort,
  exposure: Exposure | "all" = "all",
) {
  const query = search.trim().toLowerCase();
  const filtered = sockets.filter((socket) => {
    if (protocol !== "all" && socket.protocol !== protocol) return false;
    if (exposure !== "all" && socketExposure(socket.localAddress) !== exposure) return false;
    if (!query) return true;
    const owner = resolveSocketContainer(socket, containers);
    return [
      socket.port.toString(),
      socket.protocol,
      socket.localAddress,
      socket.addressFamily,
      socket.processName,
      socket.systemdUnit,
      owner?.container.id,
      owner?.container.name,
      owner?.container.composeProject,
      owner?.container.composeService,
    ].some((value) => value?.toLowerCase().includes(query));
  });

  return filtered.sort((left, right) => {
    if (sort === "port-desc") return right.port - left.port || left.id.localeCompare(right.id);
    if (sort === "protocol")
      return left.protocol.localeCompare(right.protocol) || left.port - right.port;
    if (sort === "address")
      return left.localAddress.localeCompare(right.localAddress) || left.port - right.port;
    if (sort === "process")
      return (
        (left.processName ?? "").localeCompare(right.processName ?? "") || left.port - right.port
      );
    return left.port - right.port || left.id.localeCompare(right.id);
  });
}

export type PortGraphKind = "all" | "listeners" | "connections" | "docker";

export type PortGraphItem =
  | { id: string; kind: "listeners"; socket: ListeningSocket }
  | { id: string; kind: "connections"; connection: ConnectionSummary }
  | { id: string; kind: "docker"; binding: DockerPortLink };

export interface PortGraphGroup {
  key: string;
  owner: SocketOwner;
  items: PortGraphItem[];
}

/** Keep each read's evidence separate, including mappings with no reported listener. */
export function buildPortGraph(
  sockets: ListeningSocket[],
  containers: DockerContainer[],
  connections: ConnectionSummary[],
  search: string,
  protocol: string,
  exposure: Exposure | "all",
  kind: PortGraphKind,
  sort: PortSort = "port-asc",
): PortGraphGroup[] {
  const groups = new Map<string, PortGraphGroup>();
  const query = search.trim().toLowerCase();
  const matches = (...values: (string | number | null)[]) =>
    !query ||
    values.some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(query),
    );
  const add = (key: string, owner: SocketOwner, item: PortGraphItem) => {
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { key, owner, items: [item] });
  };
  if (kind === "all" || kind === "listeners") {
    for (const group of groupSocketsByOwner(
      filterAndSortSockets(sockets, containers, search, protocol, sort, exposure),
      containers,
    )) {
      for (const socket of group.sockets) {
        add(group.key, group.owner, { id: `listener:${socket.id}`, kind: "listeners", socket });
      }
    }
  }
  if (kind === "all" || kind === "connections") {
    for (const connection of connections) {
      // The connection summary has no bind address, so it cannot satisfy an exposure filter.
      if (exposure !== "all") continue;
      if (protocol !== "all" && connection.protocol !== protocol) continue;
      if (
        !matches(
          connection.localPort,
          connection.protocol,
          connection.processName,
          connection.processId,
          connection.systemdUnit,
          ...connection.remotes.map((remote) => remote.address),
        )
      )
        continue;
      const owner: SocketOwner = connection.systemdUnit
        ? { kind: "service", label: connection.systemdUnit }
        : connection.processName
          ? { kind: "process", label: connection.processName }
          : { kind: "unknown", label: "Unknown process" };
      add(owner.kind === "unknown" ? "unknown" : `${owner.kind}:${owner.label}`, owner, {
        id: `connection:${connection.key}`,
        kind: "connections",
        connection,
      });
    }
  }
  if (kind === "all" || kind === "docker") {
    for (const binding of dockerPortLinks(containers)) {
      if (protocol !== "all" && binding.protocol !== protocol) continue;
      if (exposure !== "all" && socketExposure(binding.hostAddress) !== exposure) continue;
      if (
        !matches(
          binding.hostPort,
          binding.containerPort,
          binding.protocol,
          binding.hostAddress,
          binding.container.id,
          binding.container.name,
          binding.container.image,
          binding.container.composeProject,
          binding.container.composeService,
        )
      )
        continue;
      add(
        `container:${binding.container.id}`,
        { kind: "container", label: binding.container.name },
        { id: `docker:${binding.key}`, kind: "docker", binding },
      );
    }
  }
  const fields = (item: PortGraphItem) =>
    item.kind === "listeners"
      ? {
          port: item.socket.port,
          protocol: item.socket.protocol,
          address: item.socket.localAddress,
          process: item.socket.processName ?? "",
        }
      : item.kind === "connections"
        ? {
            port: item.connection.localPort,
            protocol: item.connection.protocol,
            address: "",
            process: item.connection.processName ?? "",
          }
        : {
            port: item.binding.hostPort,
            protocol: item.binding.protocol,
            address: item.binding.hostAddress,
            process: item.binding.container.name,
          };
  for (const group of groups.values()) {
    group.items.sort((left, right) => {
      const a = fields(left),
        b = fields(right);
      if (sort === "port-desc") return b.port - a.port || left.id.localeCompare(right.id);
      if (sort === "protocol") return a.protocol.localeCompare(b.protocol) || a.port - b.port;
      if (sort === "address") return a.address.localeCompare(b.address) || a.port - b.port;
      if (sort === "process") return a.process.localeCompare(b.process) || a.port - b.port;
      return a.port - b.port || left.id.localeCompare(right.id);
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      OWNER_KIND_ORDER[left.owner.kind] - OWNER_KIND_ORDER[right.owner.kind] ||
      left.owner.label.localeCompare(right.owner.label),
  );
}
