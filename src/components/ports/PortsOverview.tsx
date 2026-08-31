import { useEffect, useState } from "react";
import { Boxes, Cpu, HelpCircle, Server } from "lucide-react";
import { EmptyState } from "../PanelState";
import { SocketDetail } from "./SocketDetail";
import {
  exposureLabel,
  firewallForSocket,
  resolveSocketContainer,
  socketExposure,
  socketOwner,
  type OwnerKind,
} from "../../lib/port-inspector";
import { reconcileSelection } from "../../lib/workspace-cache";
import type {
  DockerContainer,
  FirewallStatus,
  HostCapabilities,
  ListeningSocket,
  LogSourceSelection,
} from "../../types";

function OwnerIcon({ kind }: { kind: OwnerKind }) {
  if (kind === "container") return <Boxes size={15} />;
  if (kind === "service") return <Server size={15} />;
  if (kind === "process") return <Cpu size={15} />;
  return <HelpCircle size={15} />;
}

export function PortsOverview({
  sockets,
  containers,
  firewall,
  capabilities,
  hostLabel,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: {
  sockets: ListeningSocket[];
  containers: DockerContainer[];
  firewall: FirewallStatus | null;
  capabilities: HostCapabilities | null;
  hostLabel: string;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    reconcileSelection(sockets, null),
  );

  useEffect(() => {
    setSelectedId((current) => reconcileSelection(sockets, current));
  }, [sockets]);

  const selected = sockets.find((socket) => socket.id === selectedId) ?? null;
  const selectedContainer = selected ? resolveSocketContainer(selected, containers) : null;
  const osLabel = [capabilities?.osName, capabilities?.osVersion].filter(Boolean).join(" ");

  return (
    <div className="split-page ports-view">
      <div className="list-panel ports-graph-panel">
        <div className="ports-graph" role="tree" aria-label="Host listeners">
          <div className="graph-host-node">
            <Server size={20} strokeWidth={1.6} />
            <div>
              <strong>{hostLabel}</strong>
              {osLabel && <small>{osLabel}</small>}
            </div>
          </div>
          {sockets.length > 0 && <div className="graph-spine" aria-hidden="true" />}
          <div className="graph-branches">
            {sockets.map((socket) => {
              const container = resolveSocketContainer(socket, containers);
              const owner = socketOwner(socket, container);
              const disposition = firewallForSocket(firewall, socket);
              const isSelected = socket.id === selectedId;
              return (
                <div className="graph-branch" key={socket.id} role="group">
                  <button
                    type="button"
                    className={`graph-node port-node${isSelected ? " selected" : ""}`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedId(socket.id)}
                  >
                    <span className="node-title">
                      <span className={`protocol-mark protocol-${socket.protocol}`}>
                        {socket.protocol.toUpperCase()}
                      </span>
                      <strong>{socket.port}</strong>
                    </span>
                    <span className="node-meta">
                      {exposureLabel(socketExposure(socket.localAddress))}
                    </span>
                    {disposition.state !== "unavailable" && (
                      <span className="node-meta node-firewall">{disposition.label}</span>
                    )}
                  </button>
                  <div className="graph-link" aria-hidden="true" />
                  <button
                    type="button"
                    className={`graph-node owner-node owner-${owner.kind}${isSelected ? " selected" : ""}`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedId(socket.id)}
                  >
                    <OwnerIcon kind={owner.kind} />
                    <span>{owner.label}</span>
                  </button>
                </div>
              );
            })}
          </div>
          {!sockets.length && <EmptyState title="No listening ports match the current filters" />}
        </div>
      </div>
      <aside className="detail-panel">
        {selected ? (
          <SocketDetail
            socket={selected}
            containerOwner={selectedContainer}
            firewall={firewall}
            onOpenSystemd={onOpenSystemd}
            onOpenContainer={onOpenContainer}
            onViewLogs={onViewLogs}
          />
        ) : (
          <EmptyState title="Select a port or service" />
        )}
      </aside>
    </div>
  );
}
