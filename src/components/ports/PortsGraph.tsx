import type { PublishedPortSelection } from "../../lib/port-inspector";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Container, Cpu, HelpCircle, Server } from "lucide-react";
import { InspectionGraph } from "../InspectionGraph";
import { PortOverviewDetail } from "./PortOverviewDetail";
import {
  exposureLabel,
  socketExposure,
  type Exposure,
  type OwnerKind,
  type PortGraphKind,
  type PortSort,
} from "../../lib/port-inspector";
import { buildPortOverview, type PortOverviewItem } from "../../lib/port-overview";
import type {
  DockerContainer,
  EstablishedConnections,
  FirewallStatus,
  HostCapabilities,
  ListeningSocket,
  LogSourceSelection,
} from "../../types";

function OwnerIcon({ kind }: { kind: OwnerKind }) {
  if (kind === "container") return <Container size={14} />;
  if (kind === "service") return <Server size={14} />;
  if (kind === "process") return <Cpu size={14} />;
  return <HelpCircle size={14} />;
}

function GraphItem({ item }: { item: PortOverviewItem }) {
  const scopes = [
    ...new Set([
      ...item.sockets.map((socket) => exposureLabel(socketExposure(socket.localAddress))),
      ...item.bindings.map((binding) => exposureLabel(socketExposure(binding.hostAddress))),
    ]),
  ];
  const families = [...new Set(item.sockets.map((socket) => socket.addressFamily.toUpperCase()))];
  const established = item.connections.reduce(
    (total, connection) => total + connection.established,
    0,
  );
  return (
    <>
      <span className="arch-chip-title">
        <strong>{item.port}</strong>
        <span className="protocol-mark">{item.protocol.toUpperCase()}</span>
        <span className="arch-chip-kind">
          {item.sockets.length ? "Listening" : item.bindings.length ? "Published" : "Established"}
        </span>
      </span>
      {item.relatedTo && (
        <span className="arch-chip-meta">Related process · {item.owner.label}</span>
      )}
      {!!scopes.length && (
        <span className="arch-chip-meta">
          {scopes.join(" / ")}
          {families.length ? " · " + families.join(" + ") : ""}
        </span>
      )}
      {(item.bindings.length > 0 || established > 0) && (
        <span className="arch-chip-meta">
          {item.bindings.length > 0
            ? "Docker → " +
              [...new Set(item.bindings.map((binding) => binding.containerPort))].join(", ")
            : ""}
          {item.bindings.length > 0 && established > 0 ? " · " : ""}
          {established > 0 ? established + " established" : ""}
        </span>
      )}
    </>
  );
}

export function PortsGraph({
  sockets,
  containers,
  firewall,
  capabilities,
  hostLabel,
  connections,
  search,
  protocol,
  exposure,
  kind,
  sort,
  showConnections = false,
  emptyMessage,
  toolbar,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
  focusEndpoint,
  loading = false,
  loadingLabel,
}: {
  focusEndpoint?: PublishedPortSelection;
  loading?: boolean;
  loadingLabel?: string;
  sockets: ListeningSocket[];
  containers: DockerContainer[];
  firewall: FirewallStatus | null;
  capabilities: HostCapabilities | null;
  hostLabel: string;
  connections: EstablishedConnections | null;
  search: string;
  protocol: string;
  exposure: Exposure | "all";
  kind: PortGraphKind;
  sort: PortSort;
  showConnections?: boolean;
  emptyMessage: string;
  toolbar: ReactNode;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const handledFocus = useRef<PublishedPortSelection | undefined>(undefined);
  const groups = useMemo(
    () =>
      buildPortOverview(
        sockets,
        containers,
        connections?.groups ?? [],
        search,
        protocol,
        exposure,
        kind,
        sort,
        showConnections,
      ),
    [sockets, containers, connections, search, protocol, exposure, kind, sort, showConnections],
  );
  const selected = groups.flatMap((group) => group.items).find((item) => item.id === selectedId);

  const focused = groups
    .flatMap((group) => group.items)
    .find((item) =>
      item.bindings.some(
        (binding) =>
          binding.container.id === focusEndpoint?.containerId &&
          binding.hostAddress === focusEndpoint.hostAddress &&
          binding.hostPort === focusEndpoint.hostPort &&
          binding.containerPort + "/" + binding.protocol === focusEndpoint.containerPort,
      ),
    );
  useEffect(() => {
    if (focused && focusEndpoint !== handledFocus.current) {
      handledFocus.current = focusEndpoint;
      setSelectedId(focused.id);
    }
  }, [focused?.id, focusEndpoint]);

  const graphGroups = useMemo(
    () =>
      groups.map((group) => ({
        id: group.key,
        label: group.owner.label,
        icon: <OwnerIcon kind={group.owner.kind} />,
        className: `owner-${group.owner.kind}`,
        items: group.items.map((item) => ({
          id: item.id,
          secondary: !item.sockets.length && !item.bindings.length,
          content: <GraphItem item={item} />,
        })),
      })),
    [groups],
  );

  return (
    <InspectionGraph
      groups={graphGroups}
      hostLabel={hostLabel}
      hostDescription={[capabilities?.osName, capabilities?.osVersion].filter(Boolean).join(" ")}
      graphLabel="Ports graph"
      emptyMessage={emptyMessage}
      loadingLabel={loadingLabel}
      toolbar={
        <>
          {toolbar}
          {focusEndpoint && focusEndpoint !== handledFocus.current && !focused && !loading && (
            <p className="inline-warning" role="status">
              Published endpoint was not found in this Ports snapshot.
            </p>
          )}
        </>
      }
      selectedId={selectedId}
      onSelectionChange={setSelectedId}
      inspectorId="port-inspector"
      inspectorLabel="Port details"
      inspector={
        selected && (
          <PortOverviewDetail
            item={selected}
            firewall={firewall}
            onOpenSystemd={onOpenSystemd}
            onOpenContainer={onOpenContainer}
            onViewLogs={onViewLogs}
          />
        )
      }
    />
  );
}
