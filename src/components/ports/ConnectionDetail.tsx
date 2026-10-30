import { FileClock, Server } from "lucide-react";
import type { ConnectionSummary, LogSourceSelection } from "../../types";

export function ConnectionDetail({
  selected,
  onOpenSystemd,
  onViewLogs,
}: {
  selected: ConnectionSummary;
  onOpenSystemd: (unitId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  return (
    <>
      <header>
        <h2>{selected.systemdUnit ?? selected.processName ?? "Unknown process"}</h2>
        <p>
          {selected.protocol.toUpperCase()} {selected.localPort}
        </p>
      </header>
      <div
        className="port-inspector-body"
        tabIndex={0}
        role="region"
        aria-label="Connection information"
      >
        <h3 className="detail-section-heading">Connections</h3>
        <dl className="detail-list">
          <div>
            <dt>Established</dt>
            <dd>{selected.established}</dd>
          </div>
          <div>
            <dt>Remote addresses</dt>
            <dd>{selected.remoteAddressCount}</dd>
          </div>
        </dl>
        <h3 className="detail-section-heading">Ownership</h3>
        <dl className="detail-list">
          <div>
            <dt>Process</dt>
            <dd>{selected.processName ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd>{selected.processId ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Systemd unit</dt>
            <dd>{selected.systemdUnit ?? "Not established"}</dd>
          </div>
        </dl>
        <h3 className="detail-section-heading">
          Top remote endpoints
          {selected.remoteAddressCount > selected.remotes.length
            ? ` (showing ${selected.remotes.length} of ${selected.remoteAddressCount})`
            : ""}
        </h3>
        <dl className="detail-list port-endpoints">
          {selected.remotes.map((remote) => (
            <div key={remote.address}>
              <dt className="technical">{remote.address}</dt>
              <dd>{remote.count}</dd>
            </div>
          ))}
        </dl>
      </div>
      {selected.systemdUnit && (
        <div className="detail-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => onOpenSystemd(selected.systemdUnit!)}
          >
            <Server size={15} /> Open unit
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onViewLogs({ type: "systemd", id: selected.systemdUnit! })}
          >
            <FileClock size={15} /> View journal
          </button>
        </div>
      )}
    </>
  );
}
