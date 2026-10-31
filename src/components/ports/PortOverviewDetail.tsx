import { Container, FileClock, Server } from "lucide-react";
import { exposureLabel, firewallForSocket, socketExposure } from "../../lib/port-inspector";
import type { PortOverviewItem } from "../../lib/port-overview";
import type { FirewallStatus, LogSourceSelection } from "../../types";

export function PortOverviewDetail({
  item,
  firewall,
  onOpenSystemd,
  onOpenContainer,
  onViewLogs,
}: {
  item: PortOverviewItem;
  firewall: FirewallStatus | null;
  onOpenSystemd: (id: string) => void;
  onOpenContainer: (id: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const containers = [
    ...new Map(item.bindings.map((binding) => [binding.container.id, binding.container])).values(),
  ];
  const units = [
    ...new Set(
      [
        ...item.sockets.map((socket) => socket.systemdUnit),
        ...item.connections.map((connection) => connection.systemdUnit),
      ].filter((unit): unit is string => !!unit),
    ),
  ];
  const count = item.connections.reduce((total, connection) => total + connection.established, 0);
  return (
    <>
      <header>
        <h2>
          {item.port} / {item.protocol.toUpperCase()}
        </h2>
        <p>{item.owner.label}</p>
        {item.relatedTo && <p>Related to {item.relatedTo}</p>}
      </header>
      <div className="port-inspector-body" tabIndex={0} role="region" aria-label="Port information">
        <dl className="detail-list">
          <div>
            <dt>Listening</dt>
            <dd>
              {item.sockets.length
                ? item.sockets.length + " socket" + (item.sockets.length === 1 ? "" : "s")
                : "Not observed"}
            </dd>
          </div>
          {!!item.connections.length && (
            <div>
              <dt>Established</dt>
              <dd>{count}</dd>
            </div>
          )}
          <div>
            <dt>Reachability</dt>
            <dd>Not tested</dd>
          </div>
        </dl>
        {!!item.sockets.length && (
          <>
            <h3 className="detail-section-heading">Listening bindings</h3>
            <ul className="port-binding-list">
              {item.sockets.map((socket) => (
                <li key={socket.id}>
                  <span>
                    <strong>{socket.addressFamily.toUpperCase()}</strong>{" "}
                    <code>{socket.localAddress}</code>
                  </span>
                  <span>{exposureLabel(socketExposure(socket.localAddress))}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {!!item.bindings.length && (
          <>
            <h3 className="detail-section-heading">Docker-published bindings</h3>
            <ul className="port-binding-list">
              {item.bindings.map((binding) => (
                <li key={binding.key}>
                  <code>
                    {binding.hostAddress.includes(":")
                      ? "[" + binding.hostAddress + "]"
                      : binding.hostAddress}
                    :{binding.hostPort} → {binding.containerPort}/{binding.protocol}
                  </code>
                  <span>{exposureLabel(socketExposure(binding.hostAddress))}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {!!item.connections.length && (
          <details className="port-disclosure" open={!item.sockets.length && !item.bindings.length}>
            <summary>{count} established · Remote endpoints</summary>
            {item.connections.map((connection) => (
              <section key={connection.key}>
                <dl className="detail-list">
                  {connection.processName && (
                    <div>
                      <dt>Process</dt>
                      <dd>{connection.processName}</dd>
                    </div>
                  )}
                  {connection.processId !== null && (
                    <div>
                      <dt>PID</dt>
                      <dd>{connection.processId}</dd>
                    </div>
                  )}
                  {connection.systemdUnit && (
                    <div>
                      <dt>Systemd unit</dt>
                      <dd>{connection.systemdUnit}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Remote addresses</dt>
                    <dd>{connection.remoteAddressCount}</dd>
                  </div>
                </dl>
                <dl className="detail-list port-endpoints">
                  {connection.remotes.map((remote) => (
                    <div key={remote.address}>
                      <dt className="technical">{remote.address}</dt>
                      <dd>{remote.count}</dd>
                    </div>
                  ))}
                </dl>
                {connection.remoteAddressCount > connection.remotes.length && (
                  <p className="unit-scope-note">
                    Showing {connection.remotes.length} of {connection.remoteAddressCount} remote
                    addresses.
                  </p>
                )}
              </section>
            ))}
          </details>
        )}
        <details className="port-disclosure">
          <summary>Host firewall policy</summary>
          <dl className="detail-list">
            <div>
              <dt>Backend</dt>
              <dd>{firewall?.backend?.toUpperCase() ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Incoming default</dt>
              <dd>{firewall?.defaultIncoming ?? "Not reported"}</dd>
            </div>
            {item.sockets.map((socket) => (
              <div key={socket.id}>
                <dt>
                  {socket.addressFamily.toUpperCase()} {socket.localAddress}
                </dt>
                <dd>{firewallForSocket(firewall, socket).label}</dd>
              </div>
            ))}
          </dl>
          <p className="unit-scope-note">
            Host policy is not a reachability test. Docker forwarding, routing and upstream
            firewalls can apply separately. A missing port rule does not prove that traffic is
            blocked.
          </p>
        </details>
        {!!item.sockets.length && (
          <details className="port-disclosure">
            <summary>Socket diagnostics</summary>
            {item.sockets.map((socket) => (
              <dl className="detail-list" key={socket.id}>
                <div className="inspector-wide-field">
                  <dt>Socket</dt>
                  <dd className="technical">{socket.id}</dd>
                </div>
                {socket.processName && (
                  <div>
                    <dt>Process</dt>
                    <dd>{socket.processName}</dd>
                  </div>
                )}
                {socket.processId !== null && (
                  <div>
                    <dt>PID</dt>
                    <dd>{socket.processId}</dd>
                  </div>
                )}
                {socket.systemdUnit && (
                  <div>
                    <dt>Systemd unit</dt>
                    <dd>{socket.systemdUnit}</dd>
                  </div>
                )}
                {socket.ownership !== "known" && (
                  <div>
                    <dt>Ownership</dt>
                    <dd>
                      {socket.ownership === "ambiguous"
                        ? "Held by multiple processes"
                        : "Owner not reported by this read"}
                    </dd>
                  </div>
                )}
              </dl>
            ))}
          </details>
        )}
      </div>
      <div className="detail-actions">
        {units.map((unit) => (
          <span className="port-owner-actions" key={unit}>
            <button
              type="button"
              className="secondary-button"
              title={unit}
              onClick={() => onOpenSystemd(unit)}
            >
              <Server size={14} /> Open unit
            </button>
            <button
              type="button"
              className="secondary-button"
              title={unit}
              onClick={() => onViewLogs({ type: "systemd", id: unit })}
            >
              <FileClock size={14} /> View journal
            </button>
          </span>
        ))}
        {containers.map((container) => (
          <span className="port-owner-actions" key={container.id}>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onOpenContainer(container.id)}
            >
              <Container size={14} /> Open container
            </button>
          </span>
        ))}
      </div>
    </>
  );
}
