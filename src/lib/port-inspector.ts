import type { DockerContainer, FirewallStatus, ListeningSocket } from "../types";

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
 * Firewall disposition for one listener. This reflects UFW policy only and is
 * deliberately separate from where the socket binds: a broad bind does not imply
 * Internet reachability, and a firewall rule does not change the binding.
 */
export function firewallForSocket(
  firewall: FirewallStatus | null,
  socket: ListeningSocket,
): FirewallDisposition {
  if (!firewall || !firewall.available) {
    return { state: "unavailable", label: "Firewall status unavailable" };
  }
  if (firewall.active === false) return { state: "inactive", label: "Firewall inactive" };
  if (firewall.active !== true) return { state: "unknown", label: "Firewall status unknown" };

  const match = firewall.rules.find(
    (rule) =>
      rule.port === socket.port &&
      (!rule.protocol || rule.protocol === socket.protocol) &&
      rule.ipv6 === (socket.addressFamily === "ipv6"),
  );
  if (!match) {
    return firewall.defaultIncoming
      ? { state: "no-rule", label: `UFW default: ${firewall.defaultIncoming} incoming` }
      : { state: "no-rule", label: "UFW: no matching rule" };
  }

  const action = match.action.toUpperCase();
  if (action === "DENY") return { state: "denied", label: "UFW: denied" };
  if (action === "REJECT") return { state: "rejected", label: "UFW: rejected" };
  if (action === "LIMIT") return { state: "limited", label: "UFW: rate-limited" };

  const from = match.from.replace(/\(v6\)/i, "").trim();
  if (!from || /^anywhere$/i.test(from)) return { state: "allowed", label: "UFW: allowed" };
  if (isPrivateSource(from)) return { state: "allowed", label: "UFW: LAN only" };
  return { state: "allowed", label: `UFW: from ${from}` };
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
