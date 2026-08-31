import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../PanelState";
import { SocketDetail } from "./SocketDetail";
import {
  filterAndSortSockets,
  resolveSocketContainer,
  socketScope,
  type Exposure,
  type PortSort,
} from "../../lib/port-inspector";
import { reconcileSelection } from "../../lib/workspace-cache";
import type {
  DockerContainer,
  FirewallStatus,
  ListeningSocket,
  LogSourceSelection,
} from "../../types";

export function PortsTable({
  sockets,
  containers,
  firewall,
  search,
  protocol,
  exposure,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: {
  sockets: ListeningSocket[];
  containers: DockerContainer[];
  firewall: FirewallStatus | null;
  search: string;
  protocol: string;
  exposure: Exposure | "all";
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    reconcileSelection(sockets, null),
  );
  const [sort, setSort] = useState<PortSort>("port-asc");

  const filtered = useMemo(
    () => filterAndSortSockets(sockets, containers, search, protocol, sort, exposure),
    [sockets, containers, search, protocol, sort, exposure],
  );

  useEffect(() => {
    setSelectedId((current) => reconcileSelection(sockets, current));
  }, [sockets]);

  const selected = sockets.find((socket) => socket.id === selectedId) ?? null;
  const selectedContainer = selected ? resolveSocketContainer(selected, containers) : null;

  return (
    <div className="split-page ports-view">
      <div className="list-panel">
        <div className="port-list-controls">
          <select
            aria-label="Sort ports"
            value={sort}
            onChange={(event) => setSort(event.target.value as PortSort)}
          >
            <option value="port-asc">Port ↑</option>
            <option value="port-desc">Port ↓</option>
            <option value="protocol">Protocol</option>
            <option value="address">Address</option>
            <option value="process">Process</option>
          </select>
        </div>
        <div className="dense-list">
          {filtered.map((socket) => {
            const container = resolveSocketContainer(socket, containers);
            const owner = container?.container.name ?? socket.systemdUnit ?? socket.processName;
            return (
              <button
                className={socket.id === selectedId ? "dense-row selected-row" : "dense-row"}
                type="button"
                key={socket.id}
                onClick={() => setSelectedId(socket.id)}
              >
                <span className={`protocol-mark protocol-${socket.protocol}`}>
                  {socket.protocol.toUpperCase()}
                </span>
                <span className="row-main">
                  <strong>{socket.port}</strong>
                  <small>
                    {socket.localAddress} · {socketScope(socket)}
                  </small>
                </span>
                <span className="row-state port-owner-label">
                  {owner ??
                    (socket.ownership === "ambiguous" ? "Ambiguous owner" : "Owner unavailable")}
                </span>
              </button>
            );
          })}
          {!filtered.length && (
            <EmptyState
              title={sockets.length ? "No matching listeners" : "No listening ports found"}
            />
          )}
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
          <EmptyState title="Select a listening port" />
        )}
      </aside>
    </div>
  );
}
