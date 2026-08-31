import { Boxes, FileClock, Server } from "lucide-react";
import type { FirewallStatus, ListeningSocket, LogSourceSelection } from "../../types";
import {
  exposureLabel,
  firewallForSocket,
  socketExposure,
  socketScope,
  type SocketContainerOwner,
} from "../../lib/port-inspector";

export function SocketDetail({
  socket,
  containerOwner,
  firewall,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: {
  socket: ListeningSocket;
  containerOwner: SocketContainerOwner | null;
  firewall: FirewallStatus | null;
  onOpenSystemd: (unitId: string) => void;
  onOpenContainer: (containerId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const disposition = firewallForSocket(firewall, socket);
  return (
    <>
      <header>
        <h2>
          {socket.port} / {socket.protocol.toUpperCase()}
        </h2>
        <p>{socket.localAddress}</p>
      </header>
      <h3 className="detail-section-heading">Listening</h3>
      <dl className="detail-list">
        <div>
          <dt>Protocol</dt>
          <dd>{socket.protocol.toUpperCase()}</dd>
        </div>
        <div>
          <dt>Address family</dt>
          <dd>{socket.addressFamily.toUpperCase()}</dd>
        </div>
        <div>
          <dt>Bind address</dt>
          <dd className="technical">{socket.localAddress}</dd>
        </div>
        <div>
          <dt>Exposure</dt>
          <dd>{exposureLabel(socketExposure(socket.localAddress))}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{socketScope(socket)}</dd>
        </div>
      </dl>
      <h3 className="detail-section-heading">Firewall</h3>
      <dl className="detail-list">
        <div>
          <dt>UFW</dt>
          <dd>{disposition.label}</dd>
        </div>
      </dl>
      <p className="unit-scope-note">
        Binding and firewall policy are independent of Internet reachability.
      </p>
      <h3 className="detail-section-heading">Ownership evidence</h3>
      <dl className="detail-list">
        <div>
          <dt>Process</dt>
          <dd>
            {socket.processName ?? (socket.ownership === "ambiguous" ? "Ambiguous" : "Unavailable")}
          </dd>
        </div>
        <div>
          <dt>PID</dt>
          <dd>{socket.processId ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Systemd unit</dt>
          <dd>{socket.systemdUnit ?? "Not established"}</dd>
        </div>
        <div>
          <dt>Container</dt>
          <dd>{containerOwner?.container.name ?? "Not established"}</dd>
        </div>
        {containerOwner?.composeProject && (
          <div>
            <dt>Compose project</dt>
            <dd>{containerOwner.composeProject}</dd>
          </div>
        )}
      </dl>
      <div className="detail-actions">
        {socket.systemdUnit && (
          <>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onOpenSystemd(socket.systemdUnit!)}
            >
              <Server size={15} /> Open unit
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onViewLogs({ type: "systemd", id: socket.systemdUnit! })}
            >
              <FileClock size={15} /> View journal
            </button>
          </>
        )}
        {containerOwner && (
          <>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onOpenContainer(containerOwner.container.id)}
            >
              <Boxes size={15} /> Open container
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onViewLogs({ type: "docker", id: containerOwner.container.id })}
            >
              <FileClock size={15} /> View logs
            </button>
          </>
        )}
      </div>
    </>
  );
}
