import type { DockerContainer, ListeningSocket } from "../types";

export type PortSort = "port-asc" | "port-desc" | "protocol" | "address" | "process";

export interface SocketContainerOwner {
  container: DockerContainer;
  composeProject: string | null;
}

interface PublishedBinding {
  address: string;
  port: number;
  protocol: string;
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
    const protocol = target.slice(protocolSeparator + 1).toLowerCase();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
    if (protocol !== "tcp" && protocol !== "udp") return [];
    return [
      {
        address: normalizeAddress(host.slice(0, separator)),
        port,
        protocol,
      },
    ];
  });
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

export function filterAndSortSockets(
  sockets: ListeningSocket[],
  containers: DockerContainer[],
  search: string,
  protocol: string,
  sort: PortSort,
) {
  const query = search.trim().toLowerCase();
  const filtered = sockets.filter((socket) => {
    if (protocol !== "all" && socket.protocol !== protocol) return false;
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
