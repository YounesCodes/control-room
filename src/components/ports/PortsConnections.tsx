import { useEffect, useMemo, useState } from "react";
import { FileClock, Server } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../PanelState";
import type { ConnectionSummary, EstablishedConnections, LogSourceSelection } from "../../types";

function groupLabel(group: ConnectionSummary): string {
  return group.systemdUnit ?? group.processName ?? "Unknown process";
}

export function PortsConnections({
  connections,
  loading,
  error,
  search,
  onRetry,
  onOpenSystemd,
  onViewLogs,
}: {
  connections: EstablishedConnections | null;
  loading: boolean;
  error: string | null;
  search: string;
  onRetry: () => void;
  onOpenSystemd: (unitId: string) => void;
  onViewLogs: (source: LogSourceSelection) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const groups = useMemo(() => connections?.groups ?? [], [connections]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) =>
      [
        groupLabel(group),
        group.processName ?? "",
        group.systemdUnit ?? "",
        group.localPort.toString(),
        ...group.remotes.map((remote) => remote.address),
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [groups, search]);

  useEffect(() => {
    setSelectedKey((current) =>
      current && filtered.some((group) => group.key === current)
        ? current
        : (filtered[0]?.key ?? null),
    );
  }, [filtered]);

  if (loading && !connections) return <LoadingState label="Reading established connections…" />;
  if (error && !connections) {
    return <ErrorState message={error} action={<button onClick={onRetry}>Retry</button>} />;
  }

  const selected = filtered.find((group) => group.key === selectedKey) ?? null;

  return (
    <div className="split-page ports-view">
      <div className="list-panel">
        {connections && (
          <p className="unit-scope-note connections-summary">
            {connections.totalEstablished} established connection
            {connections.totalEstablished === 1 ? "" : "s"} across {groups.length} listener
            {groups.length === 1 ? "" : "s"}
            {connections.truncated ? " · list truncated at 4000 rows" : ""}
          </p>
        )}
        <div className="dense-list">
          {filtered.map((group) => (
            <button
              type="button"
              key={group.key}
              className={group.key === selectedKey ? "dense-row selected-row" : "dense-row"}
              onClick={() => setSelectedKey(group.key)}
            >
              <span className={`protocol-mark protocol-${group.protocol}`}>
                {group.protocol.toUpperCase()}
              </span>
              <span className="row-main">
                <strong>{groupLabel(group)}</strong>
                <small>
                  {group.protocol.toUpperCase()} {group.localPort}
                </small>
              </span>
              <span className="row-state">
                {group.established} est · {group.remoteAddressCount} addr
              </span>
            </button>
          ))}
          {!filtered.length && (
            <EmptyState
              title={groups.length ? "No matching connections" : "No established connections"}
            />
          )}
        </div>
      </div>
      <aside className="detail-panel">
        {selected ? (
          <>
            <header>
              <h2>{groupLabel(selected)}</h2>
              <p>
                {selected.protocol.toUpperCase()} {selected.localPort}
              </p>
            </header>
            <dl className="detail-list">
              <div>
                <dt>Established</dt>
                <dd>{selected.established}</dd>
              </div>
              <div>
                <dt>Remote addresses</dt>
                <dd>{selected.remoteAddressCount}</dd>
              </div>
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
            <dl className="detail-list">
              {selected.remotes.map((remote) => (
                <div key={remote.address}>
                  <dt className="technical">{remote.address}</dt>
                  <dd>{remote.count}</dd>
                </div>
              ))}
            </dl>
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
        ) : (
          <EmptyState title="Select a listener" />
        )}
      </aside>
    </div>
  );
}
